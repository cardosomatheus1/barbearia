/**
 * O resto da barbearia: o que a simulação de agenda não produz sozinha.
 *
 * `semear-fundo.mjs` monta o **movimento** — agenda, venda, comissão, caixa,
 * fidelidade acumulada, avaliação. Sobra tudo o que uma casa em operação tem e
 * que não nasce de um atendimento: prateleira com produto, plano de assinatura,
 * pacote vendido, conta a pagar, campanha disparada, número de WhatsApp,
 * cadastro fiscal, chave de integração.
 *
 * ## Por que isto importa mais do que parece
 *
 * Área vazia não é área neutra: ela **mente**. O DRE com "Produtos R$ 0,00" e
 * "Custo dos produtos vendidos R$ 0,00" ao lado de uma agenda cheia diz que a
 * barbearia não vende nada na prateleira — e quem olha conclui que o relatório
 * não funciona, não que a casa não vende. O mesmo vale para o mapa de retenção
 * sem assinante, para a lista de espera sem ninguém e para a caixa de recados
 * vazia.
 *
 * ## E cada coisa aponta para as outras
 *
 * O consumo de insumo sai de um atendimento que existe; a unidade do pacote é
 * queimada numa comanda que existe; a fatura do clube pertence a um assinante
 * que aparece na agenda; a campanha tem público congelado com gente da base e
 * receita atribuída a venda de verdade. Semear cada tabela isolada encheria as
 * telas e faria todas discordarem entre si — que é pior do que deixá-las
 * vazias, porque tem número.
 */

import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Ferramentas
// ---------------------------------------------------------------------------

function sorteador(semente) {
  let a = semente >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = sorteador(760214);
const entre = (min, max) => min + Math.floor(rnd() * (max - min + 1));
const escolher = (lista) => lista[Math.floor(rnd() * lista.length)];
const chance = (p) => rnd() < p;

let contador = 1_000_000;
const id = () => {
  contador += 1;
  return `de310000-0000-4000-8000-${contador.toString(16).padStart(12, '0')}`;
};

const lit = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(Math.round(v));
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  return `'${String(v).replaceAll("'", "''")}'`;
};

function inserir(tabela, colunas, linhas) {
  if (linhas.length === 0) return '';
  const LOTE = 500;
  const partes = [];
  for (let i = 0; i < linhas.length; i += LOTE) {
    const valores = linhas
      .slice(i, i + LOTE)
      .map((l) => `(${colunas.map((c) => lit(l[c])).join(', ')})`)
      .join(',\n');
    partes.push(`INSERT INTO ${tabela} (${colunas.join(', ')}) VALUES ${valores};`);
  }
  return `${partes.join('\n')}\n`;
}

function consultar(url, sql) {
  return execFileSync('psql', [url, '-tA', '-F', '', '-c', sql], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 128,
  })
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split(''));
}

function executar(url, sql) {
  execFileSync('psql', [url, '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
    input: sql,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 128,
  });
}

const diaDe = (data) => data.toISOString().slice(0, 10);
const somarDias = (data, n) => new Date(data.getTime() + n * 86_400_000);

// ---------------------------------------------------------------------------
// A prateleira
// ---------------------------------------------------------------------------

/**
 * Revenda e consumo interno são tipos diferentes, e sem a distinção não existe
 * margem real: o shampoo do serviço viraria receita zero e custo nenhum, e o
 * corte pareceria render mais do que rende.
 */
const PRODUTOS = [
  { nome: 'Pomada modeladora efeito matte 120g', cat: 'Finalizador', tipo: 'resale', custo: 1800, preco: 3900, min: 6, un: 'un' },
  { nome: 'Pomada modeladora brilho 120g', cat: 'Finalizador', tipo: 'resale', custo: 1800, preco: 3900, min: 6, un: 'un' },
  { nome: 'Minoxidil para barba 60ml', cat: 'Tratamento', tipo: 'resale', custo: 3400, preco: 7900, min: 4, un: 'un' },
  { nome: 'Óleo para barba com madeira de cedro', cat: 'Tratamento', tipo: 'resale', custo: 2200, preco: 4900, min: 4, un: 'un' },
  { nome: 'Shampoo antiqueda 250ml', cat: 'Cabelo', tipo: 'resale', custo: 2600, preco: 5500, min: 5, un: 'un' },
  { nome: 'Bálsamo pós-barba sem álcool', cat: 'Barba', tipo: 'resale', custo: 1900, preco: 4200, min: 4, un: 'un' },
  { nome: 'Boné da casa', cat: 'Vestuário', tipo: 'resale', custo: 2500, preco: 5900, min: 3, un: 'un' },
  // Consumo interno: entra no custo do serviço, nunca na receita.
  /**
   * O insumo é cadastrado **na unidade em que ele é gasto**, não na embalagem.
   *
   * Um frasco de 5 litros rende umas quarenta lavagens; cadastrá-lo como "1 un
   * a R$ 89" e baixar uma por corte fez o CMV do mês dar R$ 18 mil sobre
   * R$ 13,5 mil de serviço — a barbearia aparecia perdendo dinheiro. O produto
   * está certo: ele congela o custo do movimento e soma. Quem estava errado era
   * a ficha técnica, e é o mesmo erro que uma barbearia comete ao cadastrar.
   */
  { nome: 'Shampoo de lavatório (dose)', cat: 'Insumo', tipo: 'internal', custo: 220, preco: null, min: 80, un: 'dose' },
  { nome: 'Toalha descartável', cat: 'Insumo', tipo: 'internal', custo: 25, preco: null, min: 200, un: 'un' },
  { nome: 'Lâmina de barbear descartável', cat: 'Insumo', tipo: 'internal', custo: 90, preco: null, min: 100, un: 'un' },
  { nome: 'Talco antisséptico (aplicação)', cat: 'Insumo', tipo: 'internal', custo: 25, preco: null, min: 60, un: 'aplicação' },
  { nome: 'Tinta para pigmentação de barba', cat: 'Insumo', tipo: 'internal', custo: 4200, preco: null, min: 2, un: 'un' },
  { nome: 'Pó descolorante 300g', cat: 'Insumo', tipo: 'internal', custo: 3800, preco: null, min: 2, un: 'un' },
];

/** A ficha técnica: quanto de cada insumo sai por serviço. */
const FICHA = {
  'Corte masculino': [['Shampoo de lavatório (dose)', 1], ['Toalha descartável', 1]],
  'Corte + barba': [['Shampoo de lavatório (dose)', 1], ['Toalha descartável', 2], ['Lâmina de barbear descartável', 1], ['Talco antisséptico (aplicação)', 1]],
  'Barba terapêutica com toalha quente': [['Toalha descartável', 2], ['Lâmina de barbear descartável', 1], ['Talco antisséptico (aplicação)', 1]],
  'Degradê navalhado': [['Shampoo de lavatório (dose)', 1], ['Toalha descartável', 1], ['Lâmina de barbear descartável', 1]],
  'Corte infantil': [['Shampoo de lavatório (dose)', 1], ['Toalha descartável', 1]],
  'Pigmentação de barba': [['Tinta para pigmentação de barba', 1], ['Toalha descartável', 1]],
  'Platinado global': [['Pó descolorante 300g', 1], ['Shampoo de lavatório (dose)', 1], ['Toalha descartável', 2]],
};

// ---------------------------------------------------------------------------

export function semearDetalhes({ url, slug }) {
  const [casa] = consultar(
    url,
    `SELECT t.id, l.id, l.timezone FROM tenant_slugs s
       JOIN tenants t ON t.id = s.tenant_id
       JOIN locations l ON l.tenant_id = t.id
      WHERE s.slug = ${lit(slug)} LIMIT 1`,
  );
  if (!casa) throw new Error(`barbearia "${slug}" não encontrada`);
  const [tenant, local] = casa;

  const servicos = consultar(url, `SELECT name, id, price_cents FROM services WHERE tenant_id = ${lit(tenant)} AND active`)
    .map(([name, sid, preco]) => ({ name, id: sid, preco: Number(preco) }));
  const doNome = new Map(servicos.map((s) => [s.name, s]));

  const cadeiras = consultar(
    url,
    `SELECT id, name FROM professionals WHERE tenant_id = ${lit(tenant)} AND kind = 'professional' ORDER BY created_at`,
  ).map(([pid, nome]) => ({ id: pid, nome }));

  const [operador] = consultar(
    url,
    `SELECT id, name FROM staff_users WHERE tenant_id = ${lit(tenant)} AND active
      ORDER BY (role = 'receptionist') DESC, created_at LIMIT 1`,
  );
  const balcao = { id: operador?.[0] ?? null, nome: operador?.[1] ?? 'Balcão' };

  /** Os clientes que mais voltaram: são eles que assinam, compram pacote e fiam. */
  const fieis = consultar(
    url,
    `SELECT c.id, c.name, count(*) AS visitas
       FROM customers c JOIN appointments a ON a.customer_id = c.id AND a.status = 'completed'
      WHERE c.tenant_id = ${lit(tenant)}
      GROUP BY c.id, c.name ORDER BY 3 DESC LIMIT 90`,
  ).map(([cid, nome, visitas]) => ({ id: cid, nome, visitas: Number(visitas) }));

  const hoje = new Date();
  const sql = ['BEGIN;'];

  /**
   * Os produtos nascem em JavaScript e são **passados adiante**.
   *
   * A venda de produto precisa deles, e reler do banco não funciona: as seções
   * montam uma transação só, executada no fim, e `consultar` abre outra
   * conexão — que não enxerga o que ainda não foi commitado. O sintoma foi
   * silencioso e caro de ler: "Produtos R$ 0,00" no DRE ao lado de um CMV de
   * cinco dígitos.
   */
  const produtos = PRODUTOS.map((p) => ({ ...p, id: id() }));
  const vendasPagas = consultar(
    url,
    `SELECT o.id, o.business_day FROM orders o
      WHERE o.tenant_id = ${lit(tenant)} AND o.status = 'paid'`,
  );

  /**
   * A venda de balcão é sorteada **antes** da compra, e não depois.
   *
   * O gatilho do banco recusa saldo negativo — e está certo. A primeira versão
   * dimensionava o pedido mensal só pelo consumo da ficha técnica e dava à
   * revenda um valor fixo: bastou a variância do sorteio passar dele para a
   * transação inteira morrer. Uma barbearia compra o que vai vender; a semente
   * precisa saber quanto vai vender antes de comprar.
   */
  const prateleira = sortearVendaDeProduto({ tenant, local, produtos, vendas: vendasPagas });
  sql.push(estoque(url, { tenant, local, doNome, hoje, produtos, demanda: prateleira.demanda }));
  sql.push(prateleira.sql);
  sql.push(pacotes(url, { tenant, local, doNome, fieis, hoje }));
  sql.push(clube(url, { tenant, local, doNome, fieis, hoje }));
  sql.push(resgateDeFidelidade(url, { tenant, local, hoje }));
  sql.push(financeiro({ tenant, local, hoje, balcao }));
  sql.push(vales({ tenant, local, cadeiras, hoje, balcao }));
  sql.push(moderacaoDeAvaliacoes(url, { tenant, balcao }));
  sql.push(recados({ tenant, local, fieis, hoje }));
  sql.push(listaDeEspera({ tenant, local, doNome, cadeiras, fieis, hoje }));
  sql.push(marketing({ tenant, local, fieis, hoje, balcao }));
  sql.push(precos({ tenant, local, balcao }));
  sql.push(vitrineEPerfil({ tenant, local, cadeiras, slug }));
  sql.push(integracoes(url, { tenant, local, balcao }));
  sql.push(privacidade(url, { tenant, fieis, cadeiras, hoje, balcao }));

  sql.push('COMMIT;');
  executar(url, sql.filter(Boolean).join('\n'));

  return { produtos: PRODUTOS.length, fieis: fieis.length };
}

// ---------------------------------------------------------------------------
// 1 — prateleira, ficha técnica e consumo
// ---------------------------------------------------------------------------

function estoque(url, { tenant, local, doNome, hoje, produtos, demanda }) {
  const porNome = new Map(produtos.map((p) => [p.nome, p]));

  const linhas = [];
  const consumiveis = [];
  const movimentos = [];

  for (const [i, p] of produtos.entries()) {
    linhas.push({
      id: p.id, tenant_id: tenant, name: p.nome, category: p.cat, kind: p.tipo,
      cost_cents: p.custo, price_cents: p.preco, min_stock: p.min, unit: p.un,
      // O SKU é único por barbearia: derivá-lo do nome fazia as duas pomadas
      // colidirem, que é o mesmo que o cadastro real faria.
      sku: `SKU-${String(i + 1).padStart(3, '0')}`,
      supplier: escolher(['Distribuidora Bahia Cosméticos', 'Barber Supply BR', 'Atacadão do Salão']),
    });
  }

  for (const [servico, itens] of Object.entries(FICHA)) {
    const s = doNome.get(servico);
    if (!s) continue;
    for (const [produto, quantidade] of itens) {
      const p = porNome.get(produto);
      if (p) consumiveis.push({ service_id: s.id, product_id: p.id, tenant_id: tenant, quantity: quantidade });
    }
  }

  /**
   * O consumo sai dos atendimentos que **existem**, um movimento por
   * atendimento.
   *
   * `stock_movements` é append-only e o saldo é a soma dos movimentos: um
   * contador diria "quantos tem" e a pergunta do balcão é "por que só tem 12 se
   * eu comprei 20?". E o custo vai **congelado** na linha — ler o cadastro na
   * hora do relatório faria subir o preço do shampoo em março mudar a margem de
   * janeiro.
   */
  const atendimentos = consultar(
    url,
    `SELECT a.id, s.name, a.completed_at::date, o.id
       FROM appointments a
       JOIN appointment_services x ON x.appointment_id = a.id
       JOIN services s ON s.id = x.service_id
       LEFT JOIN orders o ON o.appointment_id = a.id AND o.status = 'paid'
      WHERE a.tenant_id = ${lit(tenant)} AND a.status = 'completed'
      ORDER BY a.completed_at`,
  );

  const precisa = new Map();
  const saidas = [];
  for (const [aptId, servico, dia, orderId] of atendimentos) {
    for (const [produto, quantidade] of FICHA[servico] ?? []) {
      const p = porNome.get(produto);
      if (!p) continue;
      saidas.push({
        id: id(), tenant_id: tenant, product_id: p.id, location_id: local, kind: 'consumo',
        quantity: -quantidade, unit_cost_cents: p.custo, appointment_id: aptId,
        order_id: orderId || null, business_day: dia,
        created_at: new Date(`${dia}T18:00:00Z`),
      });
      const mes = dia.slice(0, 7);
      const chave = `${p.id}|${mes}`;
      precisa.set(chave, (precisa.get(chave) ?? 0) + quantidade);
    }
  }

  /**
   * A compra vem **antes** do consumo, e é o gatilho do banco que cobra isso.
   *
   * Uma entrada por produto e por mês, dimensionada pelo que aquele mês vai
   * gastar com folga. É como a casa compra de verdade — pedido mensal ao
   * distribuidor —, e é o que faz a tela de estoque ter entrada, saída e saldo
   * em vez de um número que apareceu do nada.
   */
  // O que o balcão vai vender entra na mesma conta do que a cadeira vai gastar.
  for (const [chave, quantidade] of demanda ?? []) {
    precisa.set(chave, (precisa.get(chave) ?? 0) + quantidade);
  }

  const meses = [...new Set([...precisa.keys()].map((k) => k.split('|')[1]))].sort();
  for (const p of produtos) {
    for (const mes of meses) {
      const gasto = precisa.get(`${p.id}|${mes}`) ?? 0;
      const compra = Math.max(p.min * 2, Math.ceil(gasto * 1.25) + p.min);
      movimentos.push({
        id: id(), tenant_id: tenant, product_id: p.id, location_id: local, kind: 'entrada',
        quantity: compra, unit_cost_cents: p.custo, business_day: `${mes}-01`,
        reason: 'Pedido mensal ao distribuidor',
        created_by: null, created_by_name: null,
        created_at: new Date(`${mes}-01T09:00:00Z`),
      });
    }
  }

  // Uma perda e um ajuste: corrigir contagem é lançar ao lado, nunca reescrever.
  const doAjuste = produtos[1];
  const daPerda = produtos[4];
  const mesPassado = diaDe(somarDias(hoje, -20)).slice(0, 7);
  movimentos.push({
    id: id(), tenant_id: tenant, product_id: daPerda.id, location_id: local, kind: 'perda',
    quantity: -1, unit_cost_cents: daPerda.custo, business_day: `${mesPassado}-14`,
    reason: 'Frasco quebrado na prateleira',
    created_at: new Date(`${mesPassado}-14T15:00:00Z`),
  });
  movimentos.push({
    id: id(), tenant_id: tenant, product_id: doAjuste.id, location_id: local, kind: 'ajuste',
    quantity: -2, unit_cost_cents: doAjuste.custo, business_day: `${mesPassado}-28`,
    reason: 'Contagem do inventário: faltavam duas',
    created_at: new Date(`${mesPassado}-28T20:00:00Z`),
  });

  /**
   * A ordem importa e é por isso que os movimentos saem numa lista só,
   * ordenada por dia: o gatilho recusa saldo negativo, e uma entrada gravada
   * depois do consumo que ela paga derruba a transação inteira.
   */
  const todos = [...movimentos, ...saidas].sort(
    (a, b) => String(a.business_day).localeCompare(String(b.business_day)),
  );

  return [
    inserir('products',
      ['id', 'tenant_id', 'name', 'category', 'kind', 'cost_cents', 'price_cents', 'min_stock', 'unit', 'sku', 'supplier'],
      linhas),
    inserir('service_consumables', ['service_id', 'product_id', 'tenant_id', 'quantity'], consumiveis),
    inserir('stock_movements',
      ['id', 'tenant_id', 'product_id', 'location_id', 'kind', 'quantity', 'unit_cost_cents',
        'appointment_id', 'order_id', 'business_day', 'reason', 'created_at'],
      todos.map((m) => ({ appointment_id: null, order_id: null, reason: null, ...m }))),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 2 — a pomada que sai junto com o corte
// ---------------------------------------------------------------------------

/**
 * Venda de produto entra **na comanda que já existe**, e o total é refeito.
 *
 * Criar uma comanda só de produto seria mais fácil e mentiria: quem compra
 * pomada compra na hora de pagar o corte. E o total precisa ser refeito junto
 * com o pagamento — uma comanda cujo `total_cents` não bate com a soma dos
 * itens é a incoerência que a tela de fechamento existe para acusar.
 */
function sortearVendaDeProduto({ tenant, local, produtos, vendas }) {
  const revenda = produtos
    .filter((p) => p.tipo === 'resale' && p.preco !== null)
    .map((p) => ({ id: p.id, preco: p.preco, custo: p.custo }));
  const demanda = new Map();
  if (revenda.length === 0 || vendas.length === 0) return { sql: '', demanda };

  const itens = [];
  const movimentos = [];
  const ajustes = [];
  for (const [orderId, dia] of vendas) {
    if (!chance(0.09)) continue;
    const p = escolher(revenda);
    itens.push({
      id: id(), tenant_id: tenant, order_id: orderId, kind: 'product', product_id: p.id,
      description: 'Produto vendido no balcao', quantity: 1, unit_price_cents: p.preco,
      position: 1, created_at: new Date(`${dia}T18:00:00Z`),
    });
    movimentos.push({
      id: id(), tenant_id: tenant, product_id: p.id, location_id: local, kind: 'venda',
      quantity: -1, unit_cost_cents: p.custo, order_id: orderId, business_day: dia,
      created_at: new Date(`${dia}T18:00:00Z`),
    });
    ajustes.push({ orderId, delta: p.preco });
    const chave = `${p.id}|${String(dia).slice(0, 7)}`;
    demanda.set(chave, (demanda.get(chave) ?? 0) + 1);
  }

  const descricao = `
    UPDATE order_items i SET description = p.name FROM products p
     WHERE p.id = i.product_id AND i.kind = 'product' AND i.tenant_id = ${lit(tenant)};`;

  /** O total e o pagamento acompanham o item — os três são o mesmo fato. */
  const refazer = `
    UPDATE orders o SET
      subtotal_cents = t.soma,
      total_cents = t.soma - o.discount_cents + o.tip_cents
     FROM (SELECT order_id, sum(quantity * unit_price_cents) AS soma
             FROM order_items WHERE tenant_id = ${lit(tenant)} GROUP BY order_id) t
    WHERE t.order_id = o.id AND o.tenant_id = ${lit(tenant)} AND o.status = 'paid';

    UPDATE order_payments p SET amount_cents = o.total_cents
      FROM orders o
     WHERE o.id = p.order_id AND p.tenant_id = ${lit(tenant)}
       AND o.status = 'paid'
       AND 1 = (SELECT count(*) FROM order_payments q WHERE q.order_id = o.id);`;

  return {
    demanda,
    sql: [
      inserir('order_items',
        ['id', 'tenant_id', 'order_id', 'kind', 'product_id', 'description', 'quantity',
          'unit_price_cents', 'position', 'created_at'],
        itens),
      descricao,
      inserir('stock_movements',
        ['id', 'tenant_id', 'product_id', 'location_id', 'kind', 'quantity', 'unit_cost_cents',
          'order_id', 'business_day', 'created_at'],
        movimentos),
      refazer,
    ].join('\n'),
  };
}

// ---------------------------------------------------------------------------
// 3 — pacotes
// ---------------------------------------------------------------------------

function pacotes(url, { tenant, local, doNome, fieis, hoje }) {
  const corte = doNome.get('Corte masculino');
  const barba = doNome.get('Barba terapêutica com toalha quente');
  const combo = doNome.get('Corte + barba');
  if (!corte) return '';

  const catalogo = [
    { id: id(), servico: corte, nome: 'Leve 5 cortes, pague 4', qtd: 5, preco: 18000, validade: 180, transf: true },
    { id: id(), servico: barba ?? corte, nome: 'Barba do mês — 4 sessões', qtd: 4, preco: 12000, validade: 60, transf: false },
    { id: id(), servico: combo ?? corte, nome: 'Combo trimestral — 6 combos', qtd: 6, preco: 39000, validade: 120, transf: true },
  ];

  const compras = [];
  const usos = [];
  const compradores = fieis.slice(0, 14);
  for (const [i, cliente] of compradores.entries()) {
    const pacote = catalogo[i % catalogo.length];
    const compradoEm = somarDias(hoje, -entre(20, 150));
    const unitario = Math.round(pacote.preco / pacote.qtd);
    const compraId = id();
    compras.push({
      id: compraId, tenant_id: tenant, customer_id: cliente.id, package_id: pacote.id,
      service_id: pacote.servico.id, quantity: pacote.qtd, price_cents: pacote.preco,
      unit_value_cents: unitario, transferable: pacote.transf,
      purchased_at: compradoEm, expires_at: somarDias(compradoEm, pacote.validade),
      created_at: compradoEm,
    });

    /**
     * A unidade consumida aponta para **a comanda que a consumiu**.
     *
     * Não é enfeite de coerência: o DRE reconhece a receita do pacote no
     * consumo e chega nela por `JOIN orders` — é dali que sai a unidade da
     * venda. Um `package_uses` sem comanda some do relatório sem erro, e foi
     * exatamente o que a conferência de números pegou: R$ 65 de receita
     * reconhecida que o DRE não via.
     */
    const comandas = consultar(
      url,
      `SELECT id, business_day FROM orders
        WHERE tenant_id = ${lit(tenant)} AND customer_id = ${lit(cliente.id)}
          AND status = 'paid' AND business_day >= ${lit(diaDe(compradoEm))}
        ORDER BY business_day LIMIT ${pacote.qtd - 1}`,
    );
    for (const [orderId, dia] of comandas) {
      usos.push({
        id: id(), tenant_id: tenant, customer_package_id: compraId, order_id: orderId,
        value_cents: unitario, business_day: dia, created_at: new Date(`${dia}T18:00:00Z`),
      });
    }
  }

  return [
    inserir('packages',
      ['id', 'tenant_id', 'service_id', 'name', 'quantity', 'price_cents', 'validity_days', 'transferable'],
      catalogo.map((p) => ({
        id: p.id, tenant_id: tenant, service_id: p.servico.id, name: p.nome,
        quantity: p.qtd, price_cents: p.preco, validity_days: p.validade, transferable: p.transf,
      }))),
    inserir('customer_packages',
      ['id', 'tenant_id', 'customer_id', 'package_id', 'service_id', 'quantity', 'price_cents',
        'unit_value_cents', 'transferable', 'purchased_at', 'expires_at', 'created_at'],
      compras),
    inserir('package_uses',
      ['id', 'tenant_id', 'customer_package_id', 'order_id', 'value_cents', 'business_day', 'created_at'],
      usos),
    // `location_id` fica de fora: a compra é da casa, e a unidade sai da venda.
    `-- ${usos.length} unidades ja consumidas`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 4 — o clube
// ---------------------------------------------------------------------------

function clube(url, { tenant, local, doNome, fieis, hoje }) {
  const corte = doNome.get('Corte masculino');
  const barba = doNome.get('Barba terapêutica com toalha quente');
  if (!corte) return '';

  const planos = [
    { id: id(), nome: 'Clube Essencial', desc: 'Dois cortes por mês e 10% nos produtos.', preco: 8900, produtos: 1000, pos: 0 },
    { id: id(), nome: 'Clube Barba & Cabelo', desc: 'Dois cortes, duas barbas e 15% nos produtos.', preco: 14900, produtos: 1500, pos: 1 },
    { id: id(), nome: 'Clube Ilimitado', desc: 'Corte quando quiser, respeitando sete dias entre um e outro.', preco: 24900, produtos: 2000, pos: 2 },
  ];

  const beneficios = [
    { plan_id: planos[0].id, service_id: corte.id, tenant_id: tenant, quantity: 2, cooldown_days: 10 },
    { plan_id: planos[1].id, service_id: corte.id, tenant_id: tenant, quantity: 2, cooldown_days: 10 },
    ...(barba ? [{ plan_id: planos[1].id, service_id: barba.id, tenant_id: tenant, quantity: 2, cooldown_days: 10 }] : []),
    // Ilimitado é `null`, nunca um número grande: 9999 é cota disfarçada.
    { plan_id: planos[2].id, service_id: corte.id, tenant_id: tenant, quantity: null, cooldown_days: 7 },
  ];

  const assinaturas = [];
  const faturas = [];
  const usos = [];
  const assinantes = fieis.slice(2, 26);

  for (const [i, cliente] of assinantes.entries()) {
    const plano = planos[i % planos.length];
    const desde = somarDias(hoje, -entre(35, 200));
    /**
     * Um de cada estado, e o estado importa: em atraso **continua usando** o
     * benefício (SPEC §4.6), porque cortar no primeiro erro de cartão gera
     * cancelamento por raiva e não por preço.
     */
    const estado = i === 3 ? 'inadimplente' : i === 7 ? 'cancelada' : i === 11 ? 'suspensa' : 'ativa';
    const assinaturaId = id();
    assinaturas.push({
      id: assinaturaId, tenant_id: tenant, customer_id: cliente.id, plan_id: plano.id,
      price_cents: plano.preco, status: estado, started_at: desde,
      location_id: local, created_at: desde,
      cancelled_at: estado === 'cancelada' ? somarDias(hoje, -12) : null,
      cancel_reason: estado === 'cancelada' ? 'Mudou de bairro' : null,
      suspended_at: estado === 'suspensa' ? somarDias(hoje, -20) : null,
      // Assinatura cancelada não guarda cartão: credencial some com a pessoa.
      card_brand: estado === 'cancelada' ? null : escolher(['visa', 'mastercard', 'elo']),
      card_last4: estado === 'cancelada' ? null : String(1000 + entre(100, 999)).slice(0, 4),
      payment_token: estado === 'cancelada' ? null : `pm_demo_${i}`,
    });

    // Uma fatura por ciclo, com o valor congelado na emissão.
    let ciclo = new Date(desde);
    while (ciclo < hoje) {
      const fim = new Date(ciclo);
      fim.setUTCMonth(fim.getUTCMonth() + 1);
      const venceEm = somarDias(ciclo, 3);
      const paga = estado !== 'inadimplente' || fim < somarDias(hoje, -30);
      faturas.push({
        id: id(), tenant_id: tenant, subscription_id: assinaturaId,
        period_start: ciclo, period_end: fim, amount_cents: plano.preco,
        status: paga ? 'paga' : 'aberta', due_at: venceEm,
        paid_at: paga ? venceEm : null,
        paid_method: paga ? 'credit' : null,
        attempts: paga ? 1 : 3,
        last_error: paga ? null : 'cartao_recusado',
      });
      ciclo = fim;
    }

    // Uso do benefício, que é o que faz o rateio da comissão existir.
    for (let n = 0; n < entre(1, 5); n += 1) {
      const quando = somarDias(hoje, -entre(1, 60));
      usos.push({
        id: id(), tenant_id: tenant, subscription_id: assinaturaId, service_id: corte.id,
        customer_id: cliente.id, value_cents: corte.preco,
        business_day: diaDe(quando), used_at: quando,
      });
    }
  }

  return [
    inserir('club_plans',
      ['id', 'tenant_id', 'name', 'description', 'price_cents', 'product_discount_bps', 'position'],
      planos.map((p) => ({
        id: p.id, tenant_id: tenant, name: p.nome, description: p.desc,
        price_cents: p.preco, product_discount_bps: p.produtos, position: p.pos,
      }))),
    inserir('club_plan_benefits', ['plan_id', 'service_id', 'tenant_id', 'quantity', 'cooldown_days'], beneficios),
    inserir('club_subscriptions',
      ['id', 'tenant_id', 'customer_id', 'plan_id', 'price_cents', 'status', 'started_at',
        'location_id', 'created_at', 'cancelled_at', 'cancel_reason', 'suspended_at',
        'card_brand', 'card_last4', 'payment_token'],
      assinaturas),
    inserir('club_invoices',
      ['id', 'tenant_id', 'subscription_id', 'period_start', 'period_end', 'amount_cents',
        'status', 'due_at', 'paid_at', 'paid_method', 'attempts', 'last_error'],
      faturas),
    inserir('club_uses',
      ['id', 'tenant_id', 'subscription_id', 'service_id', 'customer_id', 'value_cents',
        'business_day', 'used_at'],
      usos),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 5 — resgate de fidelidade
// ---------------------------------------------------------------------------

/**
 * Resgate é **forma de pagamento**, nunca desconto.
 *
 * Desconto é a casa abrindo mão de receita, com permissão e teto próprios;
 * resgate é o cliente gastando crédito que já é dele. E é ele que faz a linha
 * "Programa de fidelidade" do DRE deixar de ser R$ 0,00 — sem resgate, o
 * programa aparece como um saldo que ninguém nunca usou.
 */
function resgateDeFidelidade(url, { tenant, local, hoje }) {
  const comSaldo = consultar(
    url,
    `SELECT l.customer_id, sum(l.amount)::int
       FROM loyalty_entries l WHERE l.tenant_id = ${lit(tenant)}
      GROUP BY 1 HAVING sum(l.amount) > 600 ORDER BY 2 DESC LIMIT 18`,
  ).map(([cid, saldo]) => ({ id: cid, saldo: Number(saldo) }));

  const lancamentos = [];
  const pagamentos = [];
  for (const cliente of comSaldo) {
    const venda = consultar(
      url,
      `SELECT o.id, o.business_day, o.total_cents FROM orders o
        WHERE o.tenant_id = ${lit(tenant)} AND o.customer_id = ${lit(cliente.id)}
          AND o.status = 'paid' ORDER BY o.business_day DESC LIMIT 1`,
    )[0];
    if (!venda) continue;
    const [orderId, dia, total] = venda;

    // Um ponto vale cinco centavos, que é o programa semeado. O resgate nunca
    // passa do que a conta consome.
    const pontos = Math.min(cliente.saldo, entre(200, 600));
    /**
     * O resgate cobre parte da conta, nunca ela inteira.
     *
     * `order_payments` tem `CHECK` de valor positivo, e abater o total todo
     * deixaria a linha do outro meio em zero — a constraint recusa, e com
     * razão: pagamento de valor nenhum é linha que não diz nada no extrato.
     * Resgate integral é caso legítimo do produto; ele só não é o que esta
     * semente precisa mostrar.
     */
    const valor = Math.min(Math.floor(Number(total) * 0.8), pontos * 5);
    if (valor <= 0) continue;

    lancamentos.push({
      id: id(), tenant_id: tenant, customer_id: cliente.id, order_id: orderId,
      kind: 'resgate', mode: 'pontos', amount: -Math.round(valor / 5),
      location_id: local, scope: 'empresa', created_at: new Date(`${dia}T18:30:00Z`),
    });
    pagamentos.push({
      id: id(), tenant_id: tenant, order_id: orderId, method: 'fidelidade',
      amount_cents: valor, created_at: new Date(`${dia}T18:30:00Z`),
    });
  }

  /**
   * O pagamento em crédito **substitui** parte do que foi pago em dinheiro.
   *
   * Somar por cima faria a comanda ter mais pagamento que total, e o
   * fechamento do dia acusaria sobra que ninguém explica.
   */
  const abater = pagamentos
    .map(
      (p) => `UPDATE order_payments SET amount_cents = amount_cents - ${p.amount_cents}
                WHERE order_id = ${lit(p.order_id)} AND method <> 'fidelidade'
                  AND tenant_id = ${lit(tenant)};`,
    )
    .join('\n');

  return [
    inserir('loyalty_entries',
      ['id', 'tenant_id', 'customer_id', 'order_id', 'kind', 'mode', 'amount', 'location_id', 'scope', 'created_at'],
      lancamentos),
    abater,
    inserir('order_payments', ['id', 'tenant_id', 'order_id', 'method', 'amount_cents', 'created_at'], pagamentos),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 6 — contas a pagar e a receber
// ---------------------------------------------------------------------------

function financeiro({ tenant, local, hoje, balcao }) {
  const contas = [
    { id: id(), nome: 'Caixa da loja', caixa: true },
    { id: id(), nome: 'Banco do Brasil — conta corrente', caixa: false },
    { id: id(), nome: 'Conta digital do Pix', caixa: false },
  ];
  const categorias = [
    { id: id(), nome: 'Aluguel', dir: 'pagar' },
    { id: id(), nome: 'Energia e água', dir: 'pagar' },
    { id: id(), nome: 'Produtos e insumos', dir: 'pagar' },
    { id: id(), nome: 'Internet e telefone', dir: 'pagar' },
    { id: id(), nome: 'Contador', dir: 'pagar' },
    { id: id(), nome: 'Marketing', dir: 'pagar' },
    { id: id(), nome: 'Aluguel de cadeira', dir: 'receber' },
  ];

  const contasAPagar = [];
  const recorrentes = [
    ['Aluguel', 'Aluguel da loja', 380000],
    ['Energia e água', 'Coelba', 62000],
    ['Internet e telefone', 'Internet fibra 300MB', 14990],
    ['Contador', 'Honorários do contador', 45000],
    ['Produtos e insumos', 'Pedido mensal ao distribuidor', 118000],
  ];

  for (let mesAtras = 7; mesAtras >= 0; mesAtras -= 1) {
    const base = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - mesAtras, 10));
    for (const [categoria, descricao, valor] of recorrentes) {
      const cat = categorias.find((c) => c.nome === categoria);
      const paga = mesAtras > 0;
      contasAPagar.push({
        id: id(), tenant_id: tenant, location_id: local, direction: 'pagar',
        description: descricao, category_id: cat?.id ?? null,
        account_id: contas[1].id,
        amount_cents: valor + entre(-2000, 3000),
        due_on: diaDe(base), status: paga ? 'paga' : 'aberta',
        paid_on: paga ? diaDe(base) : null, paid_cents: paga ? valor : null,
        created_by: balcao.id, created_by_name: balcao.nome,
      });
    }
  }

  // Uma vencida, para a tela ter o vermelho que ela existe para mostrar.
  contasAPagar.push({
    id: id(), tenant_id: tenant, location_id: local, direction: 'pagar',
    description: 'Manutenção do ar-condicionado', category_id: categorias[1].id,
    account_id: contas[1].id, amount_cents: 48000,
    due_on: diaDe(somarDias(hoje, -9)), status: 'aberta',
    paid_on: null, paid_cents: null,
    created_by: balcao.id, created_by_name: balcao.nome,
    note: 'Técnico cobrou a visita e o gás. Combinado pagar na próxima semana.',
  });
  // E uma a receber: a cadeira alugada para a manicure das quintas.
  contasAPagar.push({
    id: id(), tenant_id: tenant, location_id: local, direction: 'receber',
    description: 'Aluguel da cadeira — manicure das quintas',
    category_id: categorias[6].id, account_id: contas[1].id, amount_cents: 60000,
    due_on: diaDe(somarDias(hoje, 6)), status: 'aberta',
    paid_on: null, paid_cents: null,
    created_by: balcao.id, created_by_name: balcao.nome,
  });

  return [
    inserir('financial_accounts', ['id', 'tenant_id', 'location_id', 'name', 'is_cash'],
      contas.map((c) => ({ id: c.id, tenant_id: tenant, location_id: local, name: c.nome, is_cash: c.caixa }))),
    inserir('financial_categories', ['id', 'tenant_id', 'name', 'direction'],
      categorias.map((c) => ({ id: c.id, tenant_id: tenant, name: c.nome, direction: c.dir }))),
    inserir('bills',
      ['id', 'tenant_id', 'location_id', 'direction', 'description', 'category_id', 'account_id',
        'amount_cents', 'due_on', 'status', 'paid_on', 'paid_cents', 'created_by', 'created_by_name', 'note'],
      contasAPagar.map((b) => ({ note: null, ...b }))),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 7 — vale ao profissional
// ---------------------------------------------------------------------------

function vales({ tenant, local, cadeiras, hoje, balcao }) {
  if (cadeiras.length === 0) return '';
  return inserir('professional_advances',
    ['id', 'tenant_id', 'location_id', 'professional_id', 'amount_cents', 'granted_on',
      'reason', 'status', 'created_by', 'created_by_name'],
    [
      {
        id: id(), tenant_id: tenant, location_id: local, professional_id: cadeiras[0].id,
        amount_cents: 30000, granted_on: diaDe(somarDias(hoje, -6)),
        reason: 'Adiantamento pedido para consulta médica da filha',
        status: 'aberto', created_by: balcao.id, created_by_name: balcao.nome,
      },
      {
        id: id(), tenant_id: tenant, location_id: local,
        professional_id: cadeiras[1]?.id ?? cadeiras[0].id,
        amount_cents: 15000, granted_on: diaDe(somarDias(hoje, -3)),
        reason: 'Vale combinado para material de trabalho',
        status: 'aberto', created_by: balcao.id, created_by_name: balcao.nome,
      },
    ]);
}

// ---------------------------------------------------------------------------
// 8 — moderação de avaliações
// ---------------------------------------------------------------------------

/**
 * Uma contestada e algumas resolvidas.
 *
 * Contestar é **suspender da vitrine**, nunca apagar: a nota e o texto ficam
 * imutáveis e a média do gestor continua contando. É a distância entre as duas
 * médias que diz "o Bruno está com 4,8 na rua e 3,9 de verdade".
 */
function moderacaoDeAvaliacoes(url, { tenant, balcao }) {
  const ruins = consultar(
    url,
    `SELECT id FROM reviews WHERE tenant_id = ${lit(tenant)} AND rating <= 2
      ORDER BY created_at DESC LIMIT 4`,
  ).map(([r]) => r);
  if (ruins.length === 0) return '';

  const partes = [];
  if (ruins[0]) {
    partes.push(`UPDATE reviews SET contested_at = now(), contest_reason = 'nunca_foi_cliente',
        contested_by = ${lit(balcao.id)},
        contest_note = 'Nao consta atendimento com este nome na data citada; o telefone tambem nao esta na base.'
      WHERE id = ${lit(ruins[0])};`);
  }
  for (const [i, review] of ruins.slice(1).entries()) {
    const desfecho = ['contato', 'retrabalho', 'credito'][i % 3];
    partes.push(`UPDATE reviews SET resolved_at = now() - interval '${i + 1} days',
        resolved_by = ${lit(balcao.id)}, outcome = '${desfecho}',
        resolution_note = 'Cliente contatado no mesmo dia; combinado retorno sem custo.'
      WHERE id = ${lit(review)};`);
  }
  return partes.join('\n');
}

// ---------------------------------------------------------------------------
// 9 — recados do cliente
// ---------------------------------------------------------------------------

function recados({ tenant, local, fieis, hoje }) {
  const textos = [
    ['reclamacao', 'Esperei quarenta minutos mesmo com horario marcado e ninguem da recepcao veio avisar que o barbeiro estava atrasado. Sai sem cortar.', 'aberto'],
    ['reclamacao', 'Cobraram a barba que eu nao pedi. Resolveram na hora, mas da trabalho conferir a conta toda vez.', 'respondido'],
    ['sugestao', 'Voces deviam abrir aos domingos de manha, nem que fosse so com um barbeiro de plantao.', 'em_analise'],
    ['sugestao', 'Seria bom poder pagar pelo site antes de chegar, principalmente no sabado que fica cheio.', 'aberto'],
    ['elogio', 'O Ruan cortou muito bem, foi a melhor barba que ja fiz aqui. Ambiente otimo e cafe bom.', 'encerrado'],
    ['elogio', 'Peguei horario pelo link em dois minutos, sem precisar ligar. Isso vale muito.', 'encerrado'],
  ];

  return inserir('feedbacks',
    ['id', 'tenant_id', 'location_id', 'customer_id', 'kind', 'status', 'body', 'answer',
      'answered_at', 'closed_at', 'created_at'],
    textos.map(([tipo, corpo, estado], i) => ({
      id: id(), tenant_id: tenant, location_id: local,
      // O recado mais valioso é o de quem desistiu e foi embora, e essa pessoa
      // não tem cadastro. Anônimo é resultado legítimo, não caso degradado.
      customer_id: i % 3 === 0 ? null : fieis[i]?.id ?? null,
      kind: tipo, status: estado, body: corpo,
      answer: estado === 'respondido' ? 'Falamos com o cliente e devolvemos o valor da barba.' : null,
      answered_at: estado === 'respondido' ? somarDias(hoje, -4) : null,
      closed_at: estado === 'encerrado' ? somarDias(hoje, -6) : null,
      created_at: somarDias(hoje, -entre(1, 25)),
    })));
}

// ---------------------------------------------------------------------------
// 10 — lista de espera
// ---------------------------------------------------------------------------

/**
 * `waitlist_entries` é quem foi embora **sem conseguir marcar** — não é a fila
 * da porta. Os nomes se parecem e as duas não compartilham nada.
 */
function listaDeEspera({ tenant, local, doNome, cadeiras, fieis, hoje }) {
  const corte = doNome.get('Corte masculino');
  if (!corte) return '';

  const entradas = [];
  const servicos = [];
  for (let i = 0; i < 6; i += 1) {
    const cliente = fieis[20 + i];
    if (!cliente) break;
    const entradaId = id();
    entradas.push({
      id: entradaId, tenant_id: tenant, location_id: local, customer_id: cliente.id,
      professional_id: i % 2 === 0 ? cadeiras[i % cadeiras.length]?.id ?? null : null,
      wanted_from: diaDe(somarDias(hoje, 1)),
      wanted_to: diaDe(somarDias(hoje, entre(3, 12))),
      window_start_minute: entre(8, 12) * 60,
      window_end_minute: entre(17, 20) * 60,
      duration_minutes: corte.preco > 0 ? 40 : 40,
      status: i === 5 ? 'left' : 'waiting',
      joined_at: somarDias(hoje, -entre(1, 6)),
      closed_at: i === 5 ? somarDias(hoje, -1) : null,
    });
    servicos.push({ entry_id: entradaId, service_id: corte.id, tenant_id: tenant, position: 0 });
  }

  return [
    inserir('waitlist_entries',
      ['id', 'tenant_id', 'location_id', 'customer_id', 'professional_id', 'wanted_from',
        'wanted_to', 'window_start_minute', 'window_end_minute', 'duration_minutes',
        'status', 'joined_at', 'closed_at'],
      entradas),
    inserir('waitlist_entry_services', ['entry_id', 'service_id', 'tenant_id', 'position'], servicos),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 11 — automações e campanha
// ---------------------------------------------------------------------------

/**
 * Automação sem objetivo não existe: toda regra declara o que promete produzir
 * e em quanto tempo, e o disparo guarda se produziu. Sem isso ela é uma
 * mensagem que ninguém consegue defender nem matar (SPEC §4.11).
 */
function marketing({ tenant, local, fieis, hoje, balcao }) {
  /**
   * `kind` é o **tipo de aviso**, não o canal.
   *
   * Os botões da mensagem são derivados dele e é o que a Meta aprova: o
   * lembrete de 2h não oferece remarcar, porque não há grade para remanejar no
   * mesmo dia. Escolher o canal aqui seria escolher a coisa errada.
   */
  const automacoes = [
    { nome: 'Boas-vindas depois do primeiro corte', gatilho: 'primeiro_atendimento', atraso: 120, tipo: 'retorno', objetivo: 'agendamento', janela: 45, ativa: true },
    { nome: 'Aniversário — 20% no mês', gatilho: 'aniversario', atraso: 0, tipo: 'retorno', objetivo: 'agendamento', janela: 30, ativa: true },
    { nome: 'Sumiu há 60 dias', gatilho: 'sem_retorno', limiar: 60, atraso: 0, tipo: 'retorno', objetivo: 'agendamento', janela: 30, ativa: true },
    { nome: 'Pedido de avaliação depois do atendimento', gatilho: 'servico_realizado', atraso: 180, tipo: 'pedido_de_avaliacao', objetivo: 'avaliacao', janela: 7, ativa: true },
    { nome: 'Pacote acabando', gatilho: 'pacote_acabando', limiar: 1, atraso: 0, tipo: 'retorno', objetivo: 'venda', janela: 30, ativa: false },
  ].map((a) => ({ ...a, id: id() }));

  const campanhaId = id();
  const publico = fieis.slice(30, 78);
  const disparos = publico.map((c, i) => ({
    id: id(), tenant_id: tenant, campaign_id: campanhaId, customer_id: c.id,
    sent_at: i < 44 ? somarDias(hoje, -9) : null,
    skipped_reason: i < 44 ? null : 'sem_consentimento',
    // Janela de atribuição com as duas pontas: sem a de baixo, um agendamento
    // feito antes da mensagem seria creditado a ela.
    goal_met_at: i < 12 ? somarDias(hoje, -entre(2, 7)) : null,
    goal_amount_cents: i < 12 ? entre(45, 120) * 100 : null,
  }));

  const envios = [];
  for (const [i, cliente] of fieis.slice(0, 20).entries()) {
    const automacao = automacoes[i % 4];
    const quando = somarDias(hoje, -entre(1, 30));
    // Objetivo cumprido exige mensagem enviada — há `CHECK` no banco, e ele
    // está certo: creditar resultado a um disparo que não saiu é atribuição
    // frouxa, que é pior que nenhuma porque tem número.
    const saiu = i % 5 !== 0;
    envios.push({
      id: id(), tenant_id: tenant, automation_id: automacao.id, customer_id: cliente.id,
      trigger_key: `${automacao.gatilho}:${cliente.id}`,
      triggered_at: quando, scheduled_for: quando,
      sent_at: saiu ? quando : null,
      skipped_reason: saiu ? null : 'janela_de_silencio',
      goal_met_at: saiu && i % 3 === 0 ? somarDias(quando, 3) : null,
    });
  }

  return [
    inserir('automations',
      ['id', 'tenant_id', 'name', 'trigger', 'threshold', 'delay_minutes', 'kind', 'goal',
        'goal_window_days', 'active', 'created_by'],
      automacoes.map((a) => ({
        id: a.id, tenant_id: tenant, name: a.nome, trigger: a.gatilho,
        threshold: a.limiar ?? null, delay_minutes: a.atraso, kind: a.tipo,
        goal: a.objetivo, goal_window_days: a.janela, active: a.ativa, created_by: balcao.id,
      }))),
    inserir('automation_sends',
      ['id', 'tenant_id', 'automation_id', 'customer_id', 'trigger_key', 'triggered_at',
        'scheduled_for', 'sent_at', 'skipped_reason', 'goal_met_at'],
      envios),
    inserir('campaigns',
      ['id', 'tenant_id', 'name', 'filter', 'filter_value', 'kind', 'status', 'goal_window_days',
        'created_at', 'sent_at', 'created_by'],
      [{
        id: campanhaId, tenant_id: tenant, name: 'Terça e quarta com 20% — quem sumiu',
        filter: 'inativos', filter_value: 60, kind: 'retorno', status: 'enviada',
        goal_window_days: 30, created_at: somarDias(hoje, -10),
        sent_at: somarDias(hoje, -9), created_by: balcao.id,
      }]),
    inserir('campaign_targets',
      ['id', 'tenant_id', 'campaign_id', 'customer_id', 'sent_at', 'skipped_reason',
        'goal_met_at', 'goal_amount_cents'],
      disparos),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 12 — preço por horário
// ---------------------------------------------------------------------------

/**
 * Faixa que não se sobrepõe — quem garante é a constraint de exclusão. Duas
 * regras valendo às 14h de terça exigiriam precedência entre regras de preço, e
 * regra de desempate sobre preço é como o cliente vê um valor na tela e outro na
 * hora de pagar.
 */
function precos({ tenant, local, balcao }) {
  const faixas = [
    // Terça e quarta de manhã são as horas mortas: desconto para encher.
    { weekday: 2, de: 9, ate: 12, bps: -1500 },
    { weekday: 3, de: 9, ate: 12, bps: -1500 },
    // Sábado de manhã é o pico: acréscimo.
    { weekday: 6, de: 8, ate: 13, bps: 1000 },
    // Sexta à noite também, e exagerado de propósito: a tela mostra o valor
    // aparado ao lado do cadastrado.
    { weekday: 5, de: 18, ate: 21, bps: 3000 },
  ];

  return [
    `UPDATE locations SET dynamic_pricing_enabled = true WHERE id = ${lit(local)};`,
    `UPDATE tenants SET max_price_variation_bps = 2000 WHERE id = ${lit(tenant)};`,
    inserir('pricing_rules',
      ['id', 'tenant_id', 'location_id', 'weekday', 'start_minute', 'end_minute', 'delta_bps', 'created_by'],
      faixas.map((f) => ({
        id: id(), tenant_id: tenant, location_id: local, weekday: f.weekday,
        start_minute: f.de * 60, end_minute: f.ate * 60, delta_bps: f.bps, created_by: balcao.id,
      }))),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 13 — perfil público do barbeiro e vitrine
// ---------------------------------------------------------------------------

function vitrineEPerfil({ tenant, local, cadeiras, slug }) {
  const apelidos = ['ruan', 'gleidson', 'italo'];
  const especialidades = [
    ['degrade', 'navalha', 'barba'],
    ['barba', 'toalha quente', 'pigmentacao'],
    ['infantil', 'social', 'sobrancelha'],
  ];

  const perfis = cadeiras.map((c, i) => {
    const apelido = (apelidos[i] ?? `barbeiro-${i + 1}`);
    return `UPDATE professionals SET
        public_profile = true,
        public_slug = COALESCE(public_slug, ${lit(apelido)}),
        specialties = ARRAY[${(especialidades[i] ?? especialidades[0]).map(lit).join(', ')}]
      WHERE id = ${lit(c.id)};`;
  });

  /**
   * A vitrine é cópia derivada, com carimbo de quando foi feita.
   *
   * Preço e nota mudam por caminhos que não conhecem a vitrine; o `refreshed_at`
   * é o que torna a defasagem verificável em vez de suposta.
   */
  const listagem = `
    INSERT INTO marketplace_listings
      (location_id, tenant_id, slug, name, city, state, latitude, longitude, cover_url,
       price_from_cents, price_from_service_id, rating_bps, rating_count, amenities, has_club, refreshed_at)
    SELECT l.id, l.tenant_id, ${lit(slug)}, t.name, l.city, l.state,
           COALESCE(l.latitude, -12.9899), COALESCE(l.longitude, -38.4767), l.cover_url,
           (SELECT min(s.price_cents) FROM services s
             WHERE s.tenant_id = t.id AND s.active AND s.bookable_online),
           (SELECT s.id FROM services s
             WHERE s.tenant_id = t.id AND s.active AND s.bookable_online
             ORDER BY s.price_cents LIMIT 1),
           -- O **mesmo predicado** do que é público: nota contestada sai da
           -- vitrine, e nota baixa espera as 48h da janela de recuperação.
           -- Copiar "a média de tudo" faria o card anunciar um número que a
           -- pagina da barbearia nao mostra. A varredura do produto, que e
           -- quem manda, usa exatamente estas condicoes.
           -- Uma casa decimal, como a funcao de resumo publico do produto: a
           -- nota daqui tem uma casa desde o bloco 43, e guardar duas faria o
           -- card dizer 4,69 onde a pagina da barbearia diz 4,7.
           (SELECT round(avg(r.rating) * 10)::int * 10 FROM reviews r
             WHERE r.tenant_id = t.id AND r.contested_at IS NULL
               AND (r.rating >= 4 OR r.created_at <= now() - interval '48 hours')),
           (SELECT count(*)::int FROM reviews r
             WHERE r.tenant_id = t.id AND r.contested_at IS NULL
               AND (r.rating >= 4 OR r.created_at <= now() - interval '48 hours')),
           l.amenities,
           EXISTS (SELECT 1 FROM club_plans p WHERE p.tenant_id = t.id AND p.active),
           now()
      FROM locations l JOIN tenants t ON t.id = l.tenant_id
     WHERE l.id = ${lit(local)}
    ON CONFLICT (location_id) DO UPDATE SET refreshed_at = now();

    UPDATE locations SET listed_in_marketplace = true WHERE id = ${lit(local)};`;

  return [...perfis, listagem].join('\n');
}

// ---------------------------------------------------------------------------
// 14 — WhatsApp, fiscal, chave de API e webhook
// ---------------------------------------------------------------------------

function integracoes(url, { tenant, local, balcao }) {
  /**
   * O número é **da barbearia**, verificado na Meta, nunca o da plataforma.
   * A mensagem que chega de número desconhecido é a que o cliente bloqueia.
   *
   * Aqui ele entra como `pendente`: o produto opera sem, e o estado explícito é
   * o que a tela mostra em vez de fingir que está tudo ligado.
   */
  const whats = `
    INSERT INTO whatsapp_settings (location_id, tenant_id, status, display_phone, status_reason)
    VALUES (${lit(local)}, ${lit(tenant)}, 'aguardando_verificacao', '+55 71 3333-4444',
            'Verificacao de empresa em analise na Meta')
    ON CONFLICT (location_id) DO NOTHING;`;

  const modelos = [
    // O nome e o **identificador na Meta**, e ela so aceita minusculas, digito
    // e sublinhado — ha `CHECK` que cobra isso. Nao e rotulo de tela.
    ['lembrete_24h', 'lembrete_24h_barbearia', 'Ola {{1}}! Seu horario na {{2}} e amanha as {{3}}. Ate la!', 'aprovado'],
    ['lembrete_2h', 'lembrete_2h_barbearia', 'Ola {{1}}! Seu horario e daqui a pouco, as {{2}}.', 'aprovado'],
    ['confirmacao', 'confirmacao_agendamento', 'Prontinho {{1}}, seu horario esta marcado para {{2}} as {{3}}.', 'aprovado'],
    // `retorno` e o tipo do aviso; o nome e o rotulo que a Meta aprovou. Este
    // esta **pausado** de proposito: a Meta pausa o que ja tinha aprovado
    // quando o indice de qualidade cai, e a tela precisa mostrar esse estado.
    ['retorno', 'convite_para_voltar', 'Oi {{1}}, faz um tempo que voce nao aparece. Bora marcar?', 'pausado'],
  ];

  const fiscal = `
    INSERT INTO fiscal_settings (location_id, tenant_id, cnpj, regime, service_code,
                                 iss_bps, municipality_ibge, municipal_registration, auto_issue)
    VALUES (${lit(local)}, ${lit(tenant)}, '12345678000190', 'simples', '1401',
            200, '2927408', '123456-7', false)
    ON CONFLICT (location_id) DO NOTHING;`;

  /**
   * A chave guarda **prefixo em claro e HMAC do segredo** — nunca o segredo.
   * O valor abaixo é decorativo e não autentica nada: o segredo de verdade só
   * existe uma vez, na resposta da criação.
   */
  const chave = inserir('api_keys',
    ['id', 'tenant_id', 'name', 'prefix', 'secret_hmac', 'scopes', 'created_by', 'created_at', 'last_used_at'],
    [{
      id: id(), tenant_id: tenant, name: 'ERP do contador',
      prefix: 'bk_demo0001', secret_hmac: 'semente-sem-valor-de-autenticacao',
      scopes: '{appointments.view,customers.view}', created_by: balcao.id,
      created_at: new Date(Date.now() - 40 * 86_400_000),
      last_used_at: new Date(Date.now() - 2 * 3600_000),
    }]);

  const endpointId = id();
  const webhook = [
    inserir('webhook_endpoints',
      ['id', 'tenant_id', 'name', 'url', 'secret_cipher', 'events', 'created_by'],
      [{
        id: endpointId, tenant_id: tenant, name: 'ERP do contador',
        url: 'https://erp.exemplo.com.br/barber-dock',
        secret_cipher: 'semente-sem-valor', events: '{appointment.created,order.paid}',
        created_by: balcao.id,
      }]),
    inserir('webhook_deliveries',
      ['id', 'tenant_id', 'endpoint_id', 'event', 'payload', 'status', 'attempts',
        'response_status', 'last_error', 'delivered_at', 'created_at'],
      [
        {
          id: id(), tenant_id: tenant, endpoint_id: endpointId, event: 'order.paid',
          payload: '{"tipo":"order.paid","id":"demo"}', status: 'entregue', attempts: 1,
          response_status: 200, last_error: null,
          delivered_at: new Date(Date.now() - 3600_000), created_at: new Date(Date.now() - 3660_000),
        },
        {
          id: id(), tenant_id: tenant, endpoint_id: endpointId, event: 'appointment.created',
          payload: '{"tipo":"appointment.created","id":"demo"}', status: 'falhou', attempts: 6,
          response_status: 500, last_error: 'HTTP 500',
          delivered_at: null, created_at: new Date(Date.now() - 7200_000),
        },
      ]),
  ].join('\n');

  /**
   * Notas emitidas, em três estados.
   *
   * A nota **nunca** bloqueia a venda: ela nasce `pendente` dentro da transação
   * que fecha a comanda, a fila fala com a prefeitura, e o balcão vê o estado.
   * Sem a rejeitada, a tela não mostra o caminho que mais importa — corrigir o
   * cadastro e emitir de novo sobre a mesma comanda.
   */
  const notas = consultar(
    url,
    `SELECT o.id, o.total_cents, o.business_day FROM orders o
      WHERE o.tenant_id = ${lit(tenant)} AND o.status = 'paid'
      ORDER BY o.business_day DESC LIMIT 24`,
  ).map(([orderId, total, dia], i) => {
    const estado = i === 0 ? 'pendente' : i === 1 ? 'rejeitada' : 'autorizada';
    return {
      id: id(), tenant_id: tenant, location_id: local, order_id: orderId,
      status: estado, regime: 'simples', service_cents: Number(total),
      iss_bps: 200, service_code: '1401', municipality_ibge: '2927408',
      number: estado === 'autorizada' ? String(1000 + i) : null,
      provider_invoice_id: estado === 'pendente' ? null : `nf_demo_${i}`,
      rejection_reason: estado === 'rejeitada'
        ? 'Inscricao municipal invalida para o codigo de servico informado'
        : null,
      requested_at: new Date(`${dia}T19:00:00Z`),
      authorized_at: estado === 'autorizada' ? new Date(`${dia}T19:02:00Z`) : null,
      created_by: balcao.id, created_by_name: balcao.nome,
    };
  });

  return [whats,
    inserir('fiscal_invoices',
      ['id', 'tenant_id', 'location_id', 'order_id', 'status', 'regime', 'service_cents',
        'iss_bps', 'service_code', 'municipality_ibge', 'number', 'provider_invoice_id',
        'rejection_reason', 'requested_at', 'authorized_at', 'created_by', 'created_by_name'],
      notas),
    inserir('whatsapp_templates',
      ['id', 'tenant_id', 'location_id', 'kind', 'name', 'body', 'status'],
      modelos.map(([tipo, nome, corpo, estado]) => ({
        id: id(), tenant_id: tenant, location_id: local, kind: tipo, name: nome,
        body: corpo, status: estado,
      }))),
    fiscal, chave, webhook].join('\n');
}

// ---------------------------------------------------------------------------
// 15 — consentimento, foto, pedido do titular e perguntas sem resposta
// ---------------------------------------------------------------------------

function privacidade(url, { tenant, fieis, cadeiras, hoje, balcao }) {
  const consentimentos = [];
  for (const [i, cliente] of fieis.slice(0, 60).entries()) {
    const quando = somarDias(hoje, -entre(10, 200));
    consentimentos.push({
      id: id(), tenant_id: tenant, customer_id: cliente.id, purpose: 'service',
      granted: true, text_version: 'servico-v1', ip: '187.19.44.10',
      decided_at: quando, recorded_by: balcao.id,
    });
    if (i % 3 !== 0) {
      consentimentos.push({
        id: id(), tenant_id: tenant, customer_id: cliente.id, purpose: 'marketing',
        granted: i % 7 !== 0, text_version: 'marketing-v2', ip: '187.19.44.10',
        decided_at: quando, recorded_by: balcao.id,
      });
    }
    if (i % 5 === 0) {
      /**
       * Duas autorizações para o mesmo dado, e as duas no banco.
       *
       * Guardar a foto na ficha e publicá-la no portfólio são decisões
       * diferentes do titular: há gatilho que recusa `in_portfolio` sem o
       * segundo consentimento, e ele pegou esta semente na primeira execução.
       */
      consentimentos.push({
        id: id(), tenant_id: tenant, customer_id: cliente.id, purpose: 'photos',
        granted: true, text_version: 'fotos-v1', ip: '187.19.44.10',
        decided_at: quando, recorded_by: balcao.id,
      });
      consentimentos.push({
        id: id(), tenant_id: tenant, customer_id: cliente.id, purpose: 'photos_public',
        granted: true, text_version: 'fotos-publicas-v1', ip: '187.19.44.10',
        decided_at: quando, recorded_by: balcao.id,
      });
    }
  }

  const fotos = [];
  for (const [i, cliente] of fieis.slice(0, 12).entries()) {
    if (i % 5 !== 0) continue;
    for (const [k, tipo] of ['antes', 'depois'].entries()) {
      fotos.push({
        id: id(), tenant_id: tenant, customer_id: cliente.id,
        professional_id: cadeiras[i % cadeiras.length]?.id ?? null,
        kind: tipo, url: `https://images.unsplash.com/photo-16216058159${71 + k}-fbc98d665033?w=600&q=70`,
        in_portfolio: k === 1, caption: k === 1 ? 'Degradê navalhado com barba desenhada' : null,
        created_at: somarDias(hoje, -entre(5, 90)), created_by: balcao.id,
      });
    }
  }

  const pedidos = [
    { cliente: fieis[3], tipo: 'export', estado: 'open' },
    { cliente: fieis[8], tipo: 'deletion', estado: 'open' },
    { cliente: fieis[15], tipo: 'export', estado: 'done' },
  ].filter((p) => p.cliente);

  /**
   * As perguntas que ninguém soube responder são **dado**, não caso degradado.
   * "Dezoito pessoas perguntaram se você abre no domingo" é tarefa; "não sei" é
   * um problema que some no log.
   */
  const lacunas = [
    ['abre domingo', 'Vocês abrem no domingo?', 18],
    ['aceita cartao credito parcelado', 'Aceita cartão parcelado?', 7],
    ['tem estacionamento', 'Tem estacionamento?', 11],
    ['atende crianca', 'Vocês atendem criança?', 5],
    ['quanto custa progressiva', 'Quanto custa a progressiva?', 4],
  ];

  return [
    inserir('customer_consents',
      ['id', 'tenant_id', 'customer_id', 'purpose', 'granted', 'text_version', 'ip', 'decided_at', 'recorded_by'],
      consentimentos),
    inserir('customer_photos',
      ['id', 'tenant_id', 'customer_id', 'professional_id', 'kind', 'url', 'in_portfolio',
        'caption', 'created_at', 'created_by'],
      fotos),
    inserir('data_requests',
      ['id', 'tenant_id', 'customer_id', 'kind', 'status', 'due_at', 'requested_at', 'settled_at'],
      pedidos.map((p, i) => {
        const pedido = somarDias(hoje, -entre(1, 12));
        return {
          id: id(), tenant_id: tenant, customer_id: p.cliente.id, kind: p.tipo,
          status: p.estado, due_at: somarDias(pedido, 15), requested_at: pedido,
          settled_at: p.estado === 'done' ? somarDias(pedido, 2) : null,
        };
      })),
    inserir('reception_gaps',
      ['id', 'tenant_id', 'pergunta_chave', 'pergunta_texto', 'vezes', 'primeira_vez', 'ultima_vez'],
      lacunas.map(([chave, texto, vezes]) => ({
        id: id(), tenant_id: tenant, pergunta_chave: chave, pergunta_texto: texto,
        vezes, primeira_vez: somarDias(hoje, -60), ultima_vez: somarDias(hoje, -entre(1, 5)),
      }))),
  ].join('\n');
}
