/**
 * Oito meses de barbearia, simulados dia a dia.
 *
 *   node scripts/semear-fundo.mjs        (chamado por semear-demo.mjs)
 *
 * ## Por que isto existe separado do `semear-demo.mjs`
 *
 * Aquele script semeia **pela API**, de propósito: a mesma sessão, a mesma
 * validação de borda, a mesma RLS e a mesma máquina de estados que a recepção
 * atravessa. É a decisão certa e ela tem um limite intransponível — **não
 * existe rota para ter atendido alguém em março**. O passado não é um estado
 * que a API aceite produzir, e nem deveria.
 *
 * Então este arquivo escreve no banco, e a contrapartida é escrita: cada linha
 * sai com os números que o domínio produziria. Total é a soma dos itens, a
 * comissão sai da regra copiada no lançamento, o saldo de fidelidade vem do
 * razão, o caixa fecha com o que as vendas do dia somam. Um fundo incoerente
 * seria pior que fundo nenhum: a tela mostraria contas que não batem, e é
 * exatamente disso que a §6 do `CLAUDE.md` trata.
 *
 * ## Por que simular, e não sortear
 *
 * Um seed que espalha atendimentos ao acaso enche as tabelas e não mostra nada.
 * O produto vende três leituras que **só existem se houver forma no tempo**:
 *
 * - o **mapa de ocupação** (SPEC §5.9) precisa de hora cheia e hora morta, ou
 *   toda célula fica igual e a tela não sugere ação nenhuma;
 * - a **retenção e o churn** precisam de gente que voltava e parou, com ciclo
 *   próprio — o segmento "em risco" sai do ritmo individual, não de um número
 *   fixo;
 * - o **DRE e o comparativo** precisam de meses diferentes entre si, senão a
 *   variação é sempre zero e a seta nunca aponta para lado nenhum.
 *
 * Por isso aqui há jornada por dia da semana, peso por hora, crescimento ao
 * longo dos meses, sazonalidade, e uma base de clientes com ciclos, hábitos e
 * uma minoria que falta.
 *
 * ## Determinístico
 *
 * `Math.random()` não aparece. A semente é fixa, então duas execuções produzem
 * a mesma barbearia — o que importa para demonstrar duas vezes a mesma coisa e
 * para investigar um número estranho na tela sem que ele mude no meio.
 */

import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Sorteio determinístico
// ---------------------------------------------------------------------------

/** mulberry32: um gerador pequeno, estável e sem dependência. */
function sorteador(semente) {
  let a = semente >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = sorteador(20260814);
/** Inteiro em [min, max]. */
const entre = (min, max) => min + Math.floor(rnd() * (max - min + 1));
/** Escolhe um item, com peso opcional. */
const escolher = (lista) => lista[Math.floor(rnd() * lista.length)];
const chance = (p) => rnd() < p;

// ---------------------------------------------------------------------------
// A casa: quando abre, e quando enche
// ---------------------------------------------------------------------------

/**
 * A semana de uma barbearia de bairro, e não uma grade uniforme.
 *
 * Segunda abrindo só à tarde e sábado sendo o dia mais cheio não são detalhe
 * de sabor: é o que faz o mapa de ocupação ter o que mostrar. Numa grade
 * uniforme toda célula fica da mesma cor e a tela que existe para apontar a
 * hora vazia não aponta nada.
 */
const SEMANA = [
  { weekday: 0, abre: 9 * 60, fecha: 14 * 60, peso: 0.5 }, // domingo curto
  { weekday: 1, abre: 12 * 60, fecha: 20 * 60, peso: 0.45 }, // segunda só à tarde
  { weekday: 2, abre: 9 * 60, fecha: 20 * 60, peso: 0.7 },
  { weekday: 3, abre: 9 * 60, fecha: 20 * 60, peso: 0.78 },
  { weekday: 4, abre: 9 * 60, fecha: 20 * 60, peso: 0.86 },
  { weekday: 5, abre: 9 * 60, fecha: 21 * 60, peso: 1.0 }, // sexta
  { weekday: 6, abre: 8 * 60, fecha: 18 * 60, peso: 1.15 }, // sábado, o pico
];

/**
 * O peso de cada hora, que é o que desenha o mapa.
 *
 * Duas formas diferentes de propósito: no dia de semana o movimento é depois do
 * expediente das pessoas; no sábado ele é de manhã. Um mapa com um pico só, na
 * mesma hora de todo dia, é o que um sorteio uniforme com um "horário nobre"
 * fixo produziria — e não se parece com barbearia nenhuma.
 */
function pesoDaHora(weekday, minuto) {
  const hora = Math.floor(minuto / 60);
  if (weekday === 6) {
    if (hora < 9) return 0.55;
    if (hora < 13) return 1.0; // sábado de manhã lota
    if (hora < 15) return 0.5; // almoço
    return 0.75;
  }
  if (weekday === 0) return hora < 11 ? 0.75 : 0.55;
  if (hora < 10) return 0.3;
  if (hora < 12) return 0.55;
  if (hora < 14) return 0.35; // almoço
  if (hora < 17) return 0.6;
  if (hora < 20) return 1.0; // depois do trabalho
  return 0.55;
}

/**
 * O mês do ano, no calendário brasileiro de barbearia.
 *
 * Dezembro é o mês em que todo mundo corta o cabelo; janeiro é o mês em que
 * ninguém tem dinheiro. Sem isso o DRE compara meses idênticos e a seta de
 * variação fica sempre em zero — que é o mesmo que não ter comparativo.
 */
const SAZONALIDADE = [0.86, 0.92, 1.0, 0.98, 1.02, 0.95, 1.0, 1.06, 0.98, 1.0, 1.04, 1.25];

/** A casa cresceu: oito meses atrás ela atendia pouco mais da metade de hoje. */
function crescimento(diasAtras, horizonte) {
  const avanco = 1 - diasAtras / horizonte;
  return 0.58 + 0.42 * avanco;
}

// ---------------------------------------------------------------------------
// O cardápio
// ---------------------------------------------------------------------------

/**
 * Preço e duração de barbearia de bairro em Salvador, não números redondos.
 *
 * Conteúdo real desde o primeiro protótipo (CLAUDE.md §5): é nome comprido e
 * preço de três dígitos que quebram layout, e eles só aparecem assim.
 */
export const CARDAPIO = [
  { chave: 'corte', nome: 'Corte masculino', categoria: 'Cabelo', min: 40, buffer: 5, preco: 4500, peso: 34 },
  { chave: 'corte-barba', nome: 'Corte + barba', categoria: 'Combo', min: 70, buffer: 10, preco: 7500, peso: 26 },
  { chave: 'barba', nome: 'Barba terapêutica com toalha quente', categoria: 'Barba', min: 30, buffer: 5, preco: 3500, peso: 12 },
  { chave: 'degrade', nome: 'Degradê navalhado', categoria: 'Cabelo', min: 50, buffer: 5, preco: 5500, peso: 12 },
  { chave: 'infantil', nome: 'Corte infantil', categoria: 'Cabelo', min: 30, buffer: 5, preco: 3500, peso: 7 },
  { chave: 'sobrancelha', nome: 'Sobrancelha na navalha', categoria: 'Estética', min: 15, buffer: 0, preco: 2000, peso: 5 },
  { chave: 'pigmentacao', nome: 'Pigmentação de barba', categoria: 'Barba', min: 45, buffer: 10, preco: 6000, peso: 3 },
  { chave: 'platinado', nome: 'Platinado global', categoria: 'Coloração', min: 120, buffer: 15, preco: 18000, peso: 1 },
];

/**
 * A jornada cadastrada, derivada da **mesma** semana que a simulação usa.
 *
 * Precisa ser uma coisa só, e não duas parecidas: a ocupação e o mapa de calor
 * têm no denominador a jornada cadastrada, com pausa descontada. Um cadastro
 * dizendo 9h–20h todo dia com movimento simulado a partir das 8h no sábado
 * produziria célula acima de cem por cento — número impossível numa tela que o
 * dono usa para decidir contratação.
 */
export const JORNADA_DA_SEMANA = SEMANA.map((d) => ({
  weekday: d.weekday,
  startMinute: d.abre,
  endMinute: d.fecha,
}));

/** Um serviço, sorteado pela frequência com que ele sai de verdade. */
function servicoSorteado() {
  const total = CARDAPIO.reduce((s, x) => s + x.peso, 0);
  let alvo = rnd() * total;
  for (const item of CARDAPIO) {
    alvo -= item.peso;
    if (alvo <= 0) return item;
  }
  return CARDAPIO[0];
}

// ---------------------------------------------------------------------------
// A clientela
// ---------------------------------------------------------------------------

/**
 * Nomes de gente da Bahia, combinados — e não uma lista de "Cliente 1".
 *
 * Quatrocentos cadastros é o tamanho real da base de uma casa de três cadeiras
 * com oito meses de rodagem, e é ele que faz a busca, a paginação e a lista de
 * campanha terem o que mostrar. Nome composto e sobrenome longo entram de
 * propósito: são eles que quebram layout, e só aparecem com conteúdo de
 * verdade (CLAUDE.md §5).
 */
const PRIMEIROS = [
  'Adriano', 'Alan', 'Alexandre', 'Anderson', 'André', 'Antônio Carlos', 'Breno', 'Bruno',
  'Caio', 'Carlos Eduardo', 'César', 'Cláudio', 'Daniel', 'Danilo', 'Davi', 'Diego',
  'Edmilson', 'Eduardo', 'Elias', 'Emerson', 'Fábio', 'Felipe', 'Fernando', 'Flávio',
  'Gabriel', 'Geraldo', 'Guilherme', 'Gustavo', 'Heitor', 'Hélio', 'Henrique', 'Igor',
  'Ivan', 'Jailson', 'Jean Carlos', 'João Pedro', 'Jonas', 'Jorge', 'José Raimundo',
  'Kaique', 'Kléber', 'Leandro', 'Lourival', 'Lucas', 'Luiz Otávio', 'Marcelo', 'Márcio',
  'Marcos Vinícius', 'Mateus', 'Maurício', 'Murilo', 'Nelson', 'Otávio', 'Paulo Sérgio',
  'Pedro Henrique', 'Rafael', 'Raul', 'Renan', 'Ricardo', 'Roberto', 'Rodrigo', 'Rogério',
  'Samuel', 'Sérgio', 'Thiago', 'Tiago', 'Ubiratan', 'Valter', 'Vinícius', 'Wagner',
  'Wesley', 'Yuri',
];
const SOBRENOMES = [
  'Menezes', 'Ribeiro da Paz', 'Lopes', 'Vasconcelos', 'Sacramento', 'Villas-Bôas',
  'Nogueira', 'Peixoto', 'Argolo', 'Prates', 'Andrade', 'Barbosa', 'Tanajura',
  'Cerqueira', 'Muniz', 'Dourado', 'Guimarães', 'Boaventura', 'Simões', 'Requião',
  'Passos', 'do Nascimento', 'Fontes', 'Correia', 'Teixeira', 'de Jesus', 'Almeida',
  'Santana', 'Marinho', 'Bittencourt', 'Meira', 'Cardim', 'Wanderley', 'Pita', 'Calmon',
  'Bandeira', 'Sepúlveda', 'Carvalho', 'Bulcão', 'Trindade', 'Falcão', 'Quadros',
  'Portugal', 'Berbert', 'Freire Júnior', 'Sampaio', 'Aragão', 'Mascarenhas', 'Brandão',
  'Melo', 'Pinheiro', 'Coutinho', 'Estrela', 'Bomfim', 'Lordelo', 'Athayde', 'Sodré',
];

/** Cada índice dá um nome, e a combinação não repete dentro do tamanho da base. */
function nomeDoIndice(i) {
  const primeiro = PRIMEIROS[i % PRIMEIROS.length];
  const sobrenome = SOBRENOMES[Math.floor(i / PRIMEIROS.length) % SOBRENOMES.length];
  return `${primeiro} ${sobrenome}`;
}

/**
 * Os cinco perfis de quem frequenta, e por que eles não são enfeite.
 *
 * O segmento do cliente é derivado do **ciclo individual** (bloco 60): quem
 * corta a cada 45 dias não está atrasado no dia 30, e quem corta a cada 15 já
 * está. Uma base em que todo mundo volta no mesmo intervalo faria a leitura
 * inteira responder a mesma coisa para todo mundo, e o produto pareceria dizer
 * uma obviedade.
 *
 * O `perdido` e o `sumindo` existem para o churn e a retenção terem massa; o
 * `faltoso` existe para o score de confiabilidade e o sinal terem de quem
 * falar. Sem essa minoria, a régua de sinal nunca dispara e a tela que a
 * explica fica vazia.
 */
const PERFIS = [
  { tipo: 'fiel', fatia: 0.2, ciclo: [14, 24], falta: 0.02, cancela: 0.03, ate: 0 },
  { tipo: 'regular', fatia: 0.34, ciclo: [26, 45], falta: 0.05, cancela: 0.06, ate: 0 },
  { tipo: 'ocasional', fatia: 0.22, ciclo: [55, 95], falta: 0.08, cancela: 0.08, ate: 0 },
  // Parou de vir: alimenta "perdido" e "em risco", que é metade da tela de retenção.
  { tipo: 'sumindo', fatia: 0.14, ciclo: [25, 40], falta: 0.06, cancela: 0.05, ate: 95 },
  // Falta de verdade: é de quem o score fala, e sem ele o sinal nunca é exigido.
  { tipo: 'faltoso', fatia: 0.1, ciclo: [20, 40], falta: 0.3, cancela: 0.16, ate: 0 },
];

/**
 * O tamanho da base sai do **volume**, não de um número escolhido.
 *
 * Três cadeiras cheias em oito meses são alguns milhares de atendimentos; com
 * ciclo médio de um mês, cada pessoa volta umas oito vezes. Uma base pequena
 * demais faria quase todo atendimento ser de gente sem cadastro — e aí a ficha,
 * o segmento, a fidelidade e o churn ficariam vazios em cima de uma agenda
 * cheia, que é a incoerência que a §6 descreve.
 */
const TAMANHO_DA_BASE = 620;

const APELIDO_DA_ORIGEM = ['website', 'reception', 'whatsapp', 'instagram', 'walk_in', 'marketplace'];

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const lit = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(Math.round(v));
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  return `'${String(v).replaceAll("'", "''")}'`;
};

/**
 * `psql`, e não o cliente do Prisma.
 *
 * `@prisma/client` não resolve da raiz do repositório — o pnpm o instala dentro
 * de `packages/db` —, e alcançá-lo por caminho relativo amarraria este script à
 * disposição de pastas de hoje. `psql` é o que a migração do `docker compose`
 * já usa, então ele existe onde este script roda, e é como o resto dos scripts
 * daqui fala com o banco.
 */
function executar(url, sql) {
  execFileSync('psql', [url, '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
    input: sql,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
  });
}

function consultar(url, sql) {
  const saida = execFileSync('psql', [url, '-tA', '-F', '', '-c', sql], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
  });
  return saida
    .split('\n')
    .filter(Boolean)
    .map((linha) => linha.split(''));
}

/** Uma instrução por lote de quinhentas linhas, nunca uma por linha. */
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

let contador = 0;
/**
 * UUID determinístico, com prefixo reconhecível.
 *
 * Sem `Math.random()`: a mesma semente produz a mesma barbearia, e um número
 * estranho na tela continua lá quando alguém for investigá-lo. O prefixo
 * `de30` marca de longe o que é semente — id de demonstração não deve passar
 * por dado de gente de verdade em nenhuma leitura. E é **hexadecimal**: a
 * primeira versão dizia `dem0`, que parece a palavra e o Postgres recusa.
 */
function id() {
  contador += 1;
  return `de300000-0000-4000-8000-${contador.toString(16).padStart(12, '0')}`;
}

// ---------------------------------------------------------------------------
// Datas, no fuso da unidade
// ---------------------------------------------------------------------------

/**
 * O instante de um minuto local, no fuso da barbearia.
 *
 * Somar horas a um `Date` em UTC e cortar o ISO dá o dia errado para quem está
 * a oeste — é a cicatriz do e2e do agente, que passava vinte e uma horas por
 * dia. Aqui a conta é feita ao contrário: monta-se o horário local e desconta-se
 * o deslocamento que aquele fuso tinha **naquele dia**.
 */
const deslocamentoPorDia = new Map();

function deslocamentoDoDia(base, fuso) {
  const chave = `${fuso}:${base.getTime()}`;
  const guardado = deslocamentoPorDia.get(chave);
  if (guardado !== undefined) return guardado;

  const marca = new Intl.DateTimeFormat('en-US', { timeZone: fuso, timeZoneName: 'longOffset' })
    .formatToParts(base)
    .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-03:00';
  const casa = /GMT([+-])(\d{2}):(\d{2})/.exec(marca);
  const sinal = casa?.[1] === '-' ? -1 : 1;
  const minutos = sinal * (Number(casa?.[2] ?? 3) * 60 + Number(casa?.[3] ?? 0));
  deslocamentoPorDia.set(chave, minutos);
  return minutos;
}

function instante(dia, minuto, fuso) {
  const base = new Date(Date.UTC(dia.getUTCFullYear(), dia.getUTCMonth(), dia.getUTCDate(), 0, 0, 0));
  return new Date(base.getTime() + (minuto - deslocamentoDoDia(base, fuso)) * 60_000);
}

/** O dia da unidade, em ISO, para `business_day` e `earned_on`. */
const diaDaUnidade = (data) => data.toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// A simulação
// ---------------------------------------------------------------------------

const HORIZONTE = 245;

export function semearFundo({ url, slug, horizonte = HORIZONTE } = {}) {
  return simular(url, slug, horizonte);
}

function simular(url, slug, horizonte) {
  const [casa] = consultar(
    url,
    `SELECT t.id, l.id, l.timezone
       FROM tenant_slugs s JOIN tenants t ON t.id = s.tenant_id
       JOIN locations l ON l.tenant_id = t.id
      WHERE s.slug = ${lit(slug)} LIMIT 1`,
  );
  if (!casa) throw new Error(`barbearia "${slug}" não encontrada`);
  const [tenant, local, fuso] = casa;

  const servicos = consultar(
    url,
    `SELECT name, id FROM services WHERE tenant_id = ${lit(tenant)} AND active`,
  ).map(([name, id]) => ({ name, id }));

  /**
   * A equipe sai do banco, com **id de conta** junto.
   *
   * Não é detalhe de implementação: o caixa que a simulação fecha diz quem o
   * abriu, e esse nome precisa ser o de alguém que consegue entrar no painel.
   * Um `created_by_name` escrito à mão faria a trilha de auditoria e o extrato
   * do caixa nomearem uma pessoa que não existe — e a primeira pergunta de quem
   * abre a tela é justamente "quem fez isso?".
   */
  const equipe = consultar(
    url,
    `SELECT id, name FROM professionals WHERE tenant_id = ${lit(tenant)} AND kind = 'professional' ORDER BY created_at`,
  );
  if (equipe.length === 0) throw new Error('a barbearia não tem cadeira nenhuma');

  const doCardapio = new Map();
  for (const item of CARDAPIO) {
    const achado = servicos.find((s) => s.name === item.nome);
    if (achado) doCardapio.set(item.chave, { ...item, id: achado.id });
  }
  const menu = [...doCardapio.values()];
  if (menu.length === 0) throw new Error('o catálogo da barbearia não é o do semeador');

  /**
   * A equipe, com demanda diferente — e o terceiro chegou depois.
   *
   * Uma equipe em que todos atendem igual esconde o indicador que o produto
   * entrega ao dono: quem está com a cadeira cheia e quem está com buraco. E
   * uma contratação no meio do período é o que faz a série de ocupação por
   * pessoa ter começo, em vez de nascer pronta.
   */
  const cadeiras = equipe.map(([idDaCadeira, nome], i) => ({
    id: idDaCadeira,
    nome,
    procura: [1.0, 0.88, 0.62][i] ?? 0.6,
    // O terceiro entrou há quatro meses: é o que faz a série de ocupação dele
    // ter começo, em vez de nascer pronta como a dos outros dois.
    desde: i === 2 ? 118 : horizonte,
    comissaoBps: [4000, 4000, 3500][i] ?? 3500,
  }));

  /**
   * Quem opera o caixa é uma conta de verdade, lida do banco.
   *
   * A recepção é quem abre e fecha a gaveta, e o extrato do caixa e a trilha de
   * auditoria mostram o nome. Escrevê-lo à mão aqui faria as duas telas
   * nomearem uma pessoa que ninguém encontra na tela de equipe — e "quem fez
   * isso?" é a primeira pergunta de quem abre um fechamento com diferença.
   */
  const [balcao] = consultar(
    url,
    `SELECT id, name FROM staff_users
      WHERE tenant_id = ${lit(tenant)} AND active
      ORDER BY (role = 'receptionist') DESC, created_at LIMIT 1`,
  );
  const operador = { id: balcao?.[0] ?? null, nome: balcao?.[1] ?? 'Balcão' };

  const hoje = new Date();
  const clientes = montarClientela(horizonte);

  const linhas = {
    customers: [],
    appointments: [],
    appointment_services: [],
    orders: [],
    order_items: [],
    order_payments: [],
    commission_entries: [],
    loyalty_entries: [],
    reviews: [],
    cash_sessions: [],
    cash_movements: [],
    customer_ledger: [],
  };

  for (const c of clientes) {
    linhas.customers.push({
      id: c.id,
      tenant_id: tenant,
      name: c.nome,
      phone_e164: c.telefone,
      birth_date: c.nascimento,
      created_at: instante(diasAtras(hoje, c.entrou), 10 * 60, fuso),
      // `acquired_via` é do mesmo enum da origem do agendamento: por onde a
      // pessoa chegou é a mesma pergunta nos dois lugares, e é ela que decide
      // se o marketplace cobra comissão por este cliente.
      acquired_via: c.origem,
      acquired_at: instante(diasAtras(hoje, c.entrou), 10 * 60, fuso),
    });
  }

  // -- o calendário, dia a dia ----------------------------------------------

  const regras = cadeiras.map((p) => ({ id: id(), professional_id: p.id, bps: p.comissaoBps }));
  const agendaPorCadeira = new Map(cadeiras.map((p) => [p.id, []]));
  let vendasDoDia = [];

  /**
   * Até ontem, nunca hoje.
   *
   * O dia de hoje é do `semear-demo.mjs`, que o monta **pela API** — com a
   * grade de verdade, a antecedência mínima e a constraint anti-overbooking
   * decidindo. Escrever hoje aqui além de duplicar a agenda tiraria do
   * demonstrador justamente a parte que o produto sabe fazer sozinho.
   */
  for (let atras = horizonte; atras >= 1; atras -= 1) {
    const dia = diasAtras(hoje, atras);
    const weekday = dia.getUTCDay();
    const jornada = SEMANA[weekday];
    if (!jornada) continue;

    const fator =
      jornada.peso * crescimento(atras, horizonte) * SAZONALIDADE[dia.getUTCMonth()];
    const negocio = diaDaUnidade(dia);
    vendasDoDia = [];
    // O dia anda para toda a base, uma vez por dia — não a cada atendimento.
    for (const c of clientes) c.proxima -= 1;

    const sessao = {
      id: id(),
      tenant_id: tenant,
      location_id: local,
      status: 'closed',
      opened_by: operador.id,
      opened_by_name: operador.nome,
      opened_at: instante(dia, jornada.abre - 15, fuso),
      opening_cents: 20000,
    };

    for (const cadeira of cadeiras) {
      if (atras > cadeira.desde) continue;
      let minuto = jornada.abre;
      while (minuto < jornada.fecha) {
        const servico = servicoSorteado();
        const doMenu = doCardapio.get(servico.chave) ?? menu[0];
        const duracao = doMenu.min;
        if (minuto + duracao > jornada.fecha) break;

        const probabilidade = Math.min(0.97, fator * cadeira.procura * pesoDaHora(weekday, minuto));
        if (!chance(probabilidade)) {
          // Buraco na agenda. É ele que faz a célula fria existir no mapa —
          // sem buraco, a tela que aponta hora vazia não tem o que apontar.
          minuto += 15;
          continue;
        }

        const cliente = clienteQueVolta(clientes, atras, cadeira);
        const marcado = marcar({
          tenant, local, fuso, dia, minuto, doMenu, cadeira, cliente, sessao, negocio, operador,
          regra: regras.find((r) => r.professional_id === cadeira.id),
        });
        empilhar(linhas, marcado, vendasDoDia, agendaPorCadeira, cadeira);
        minuto += duracao + doMenu.buffer;
      }
    }

    quitarFiado(linhas, clientes, sessao, dia, jornada, fuso, local, tenant, vendasDoDia);
    fecharCaixa(linhas, sessao, vendasDoDia, dia, jornada, fuso);
  }

  gravar(url, tenant, regras, linhas);

  /**
   * Quem a demonstração deve mostrar, escolhido **pelo dado**.
   *
   * O cliente da vitrine é o que mais voltou, e a meta de cada cadeira sai do
   * que aquela cadeira faturou nos últimos trinta dias. Escolher a dedo — "o
   * João", "R$ 15 mil para todo mundo" — produziria uma ficha vazia ao lado de
   * um painel cheio e uma meta que não conversa com a pessoa que a recebeu, que
   * é a discordância entre telas que a §6 pergunta 6 proíbe.
   */
  const visitas = new Map();
  for (const a of linhas.appointments) {
    if (a.status !== 'completed' || !a.customer_id) continue;
    visitas.set(a.customer_id, (visitas.get(a.customer_id) ?? 0) + 1);
  }
  const campeao = [...visitas.entries()].sort((a, b) => b[1] - a[1])[0];
  const vitrine = clientes.find((c) => c.id === campeao?.[0]);

  const corte = new Date(hoje.getTime() - 30 * 86_400_000);
  const porCadeira = new Map(cadeiras.map((c) => [c.id, 0]));
  for (const item of linhas.order_items) {
    const venda = linhas.orders.find((o) => o.id === item.order_id);
    if (!venda || venda.closed_at < corte) continue;
    porCadeira.set(item.professional_id, (porCadeira.get(item.professional_id) ?? 0) + item.unit_price_cents);
  }

  return {
    clientes: linhas.customers.length,
    atendimentos: linhas.appointments.length,
    vendas: linhas.orders.length,
    avaliacoes: linhas.reviews.length,
    dias: horizonte,
    vitrine: vitrine
      ? { id: vitrine.id, nome: vitrine.nome, telefone: vitrine.telefone, visitas: campeao?.[1] ?? 0 }
      : null,
    cadeiras: cadeiras.map((c) => ({
      id: c.id,
      nome: c.nome,
      ultimoMesCents: porCadeira.get(c.id) ?? 0,
    })),
  };
}

function diasAtras(hoje, n) {
  const d = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

function montarClientela(horizonte) {
  const clientes = [];
  let i = 0;
  for (const perfil of PERFIS) {
    const quantos = Math.round(TAMANHO_DA_BASE * perfil.fatia);
    for (let n = 0; n < quantos; n += 1) {
      i += 1;
      const ciclo = entre(perfil.ciclo[0], perfil.ciclo[1]);
      clientes.push({
        id: id(),
        nome: nomeDoIndice(i),
        tipo: perfil.tipo,
        telefone: `+55719${String(10000000 + i * 137)}`,
        nascimento: `19${entre(70, 99)}-${String(entre(1, 12)).padStart(2, '0')}-${String(entre(1, 28)).padStart(2, '0')}`,
        ciclo,
        falta: perfil.falta,
        cancela: perfil.cancela,
        // Quem some, some numa data própria: um corte em bloco faria a curva de
        // retenção cair de penhasco no mesmo dia para todo mundo.
        ate: perfil.ate > 0 ? entre(perfil.ate - 25, perfil.ate + 30) : 0,
        // Quem é fiel já era cliente antes da janela; o resto chegou ao longo
        // dela, que é o que faz a curva de cadastros novos ter inclinação.
        entrou: perfil.tipo === 'fiel' ? horizonte : entre(10, horizonte),
        origem: escolher(APELIDO_DA_ORIGEM),
        // A cadeira de sempre. Hábito é o que separa um sinal de uma
        // coincidência (bloco 60), e sem ele nenhum cliente "tem barbeiro".
        preferida: null,
        proxima: entre(0, ciclo),
      });
    }
  }
  return clientes;
}

/**
 * Quem senta nesta cadeira agora.
 *
 * A escolha é pelo **ciclo de cada um**, não por sorteio uniforme: é isso que
 * faz a base ter gente que aparece a cada quinze dias e gente que aparece a
 * cada dois meses, que é a matéria-prima do segmento e do churn. Setenta e
 * cinco por cento das vezes a pessoa procura o barbeiro de sempre — o hábito
 * que a ficha exibe.
 */
function clienteQueVolta(clientes, atras, cadeira) {
  const disponiveis = clientes.filter(
    (c) => c.entrou >= atras && (c.ate === 0 || atras > c.ate) && c.proxima <= 0,
  );
  const doBarbeiro = disponiveis.filter((c) => c.preferida === cadeira.id);
  const cliente =
    doBarbeiro.length > 0 && chance(0.75)
      ? escolher(doBarbeiro)
      : disponiveis.length > 0
        ? escolher(disponiveis)
        : null;

  if (cliente) {
    cliente.proxima = cliente.ciclo + entre(-4, 6);
    if (!cliente.preferida) cliente.preferida = cadeira.id;
  }
  // Sem cliente vencido é atendimento de quem passou na porta: `customer_id`
  // nulo é caso legítimo aqui, e é o que a fila de espera e o balcão produzem.
  return cliente;
}

function marcar({ tenant, local, fuso, dia, minuto, doMenu, cadeira, cliente, sessao, negocio, operador, regra }) {
  const inicio = instante(dia, minuto, fuso);
  const fim = instante(dia, minuto + doMenu.min, fuso);
  const ocupadoAte = instante(dia, minuto + doMenu.min + doMenu.buffer, fuso);

  const faltou = cliente ? chance(cliente.falta) : false;
  const cancelou = !faltou && cliente ? chance(cliente.cancela) : false;
  const status = faltou
    ? 'no_show'
    : cancelou
      ? 'cancelled_customer'
      : 'completed';

  return {
    apt: {
      id: id(),
      tenant_id: tenant,
      location_id: local,
      customer_id: cliente?.id ?? null,
      professional_id: cadeira.id,
      starts_at: inicio,
      ends_at: ocupadoAte,
      service_starts_at: inicio,
      service_ends_at: fim,
      status,
      source: cliente?.origem ?? 'walk_in',
      price_cents: doMenu.preco,
      discount_cents: 0,
      deposit_required_cents: 0,
      deposit_paid_cents: 0,
      created_at: new Date(inicio.getTime() - entre(1, 20) * 86_400_000),
      updated_at: inicio,
      completed_at: status === 'completed' ? fim : null,
      started_at: status === 'completed' ? inicio : null,
      cancelled_at: status === 'cancelled_customer' ? new Date(inicio.getTime() - 3 * 3600_000) : null,
    },
    doMenu,
    cadeira,
    cliente,
    status,
    negocio,
    sessao,
    regra,
    operador,
    fim,
  };
}

function empilhar(linhas, m, vendasDoDia, agendaPorCadeira, cadeira) {
  linhas.appointments.push(m.apt);
  linhas.appointment_services.push({
    appointment_id: m.apt.id,
    service_id: m.doMenu.id,
    tenant_id: m.apt.tenant_id,
    position: 0,
    price_cents: m.doMenu.preco,
    duration_minutes: m.doMenu.min,
  });
  agendaPorCadeira.get(cadeira.id)?.push(m.apt.id);

  if (m.status !== 'completed') return;

  // -- a venda --------------------------------------------------------------
  const pedido = id();
  const itemId = id();
  const gorjeta = chance(0.12) ? entre(2, 10) * 100 : 0;
  const total = m.doMenu.preco + gorjeta;
  /**
   * Quem não tem cadastro não leva fiado.
   *
   * Fiado é dívida de uma pessoa, e o razão tem `customer_id NOT NULL`. Deixar
   * uma venda de balcão sair como fiado produziria a incoerência exata que o
   * bloco 51 fecha: o extrato do fiado somando menos que as vendas a prazo, sem
   * nada explicando a diferença.
   */
  const sorteado = meioDePagamento();
  const meio = sorteado === 'fiado' && !m.apt.customer_id ? 'cash' : sorteado;

  linhas.orders.push({
    id: pedido,
    tenant_id: m.apt.tenant_id,
    location_id: m.apt.location_id,
    customer_id: m.apt.customer_id,
    appointment_id: m.apt.id,
    session_id: m.sessao.id,
    status: 'paid',
    opened_by: m.operador.id,
    opened_at: m.fim,
    closed_at: new Date(m.fim.getTime() + entre(1, 9) * 60_000),
    subtotal_cents: m.doMenu.preco,
    discount_cents: 0,
    tip_cents: gorjeta,
    total_cents: total,
    change_cents: 0,
    business_day: m.negocio,
    fee_cents: taxaDoMeio(meio, total),
  });
  linhas.order_items.push({
    id: itemId,
    tenant_id: m.apt.tenant_id,
    order_id: pedido,
    kind: 'service',
    service_id: m.doMenu.id,
    description: m.doMenu.nome,
    quantity: 1,
    unit_price_cents: m.doMenu.preco,
    professional_id: m.cadeira.id,
    position: 0,
    created_at: m.fim,
  });
  linhas.order_payments.push({
    id: id(),
    tenant_id: m.apt.tenant_id,
    order_id: pedido,
    method: meio,
    amount_cents: total,
    created_at: m.fim,
  });
  linhas.commission_entries.push({
    id: id(),
    tenant_id: m.apt.tenant_id,
    professional_id: m.cadeira.id,
    order_id: pedido,
    order_item_id: itemId,
    earned_on: m.negocio,
    rule_id: m.regra?.id ?? null,
    mode: 'percent',
    value: m.regra?.bps ?? 4000,
    tiers: '[]',
    base_cents: m.doMenu.preco,
    sign: 1,
    created_at: m.fim,
  });
  if (m.apt.customer_id) {
    linhas.loyalty_entries.push({
      id: id(),
      tenant_id: m.apt.tenant_id,
      customer_id: m.apt.customer_id,
      order_id: pedido,
      kind: 'acumulo',
      mode: 'pontos',
      // Um ponto por real pago, que é o padrão do programa semeado.
      amount: Math.floor(m.doMenu.preco / 100),
      base_cents: m.doMenu.preco,
      location_id: m.apt.location_id,
      scope: 'empresa',
      created_at: m.fim,
    });
  }
  if (meio === 'cash') {
    linhas.cash_movements.push({
      id: id(),
      tenant_id: m.apt.tenant_id,
      session_id: m.sessao.id,
      kind: 'sale',
      amount_cents: total,
      order_id: pedido,
      created_by: m.operador.id,
      created_by_name: m.operador.nome,
      created_at: m.fim,
    });
  }
  /**
   * Levou fiado: a dívida entra no razão, e o saldo anda com ela.
   *
   * `balance_after_cents` é gravado em cada linha porque o extrato é o
   * documento que precisa explicar cada centavo quando o cliente discorda — um
   * saldo só no cadastro responde "quanto deve" e não responde "por quê".
   */
  if (meio === 'fiado' && m.cliente) {
    m.cliente.deve = (m.cliente.deve ?? 0) + total;
    linhas.customer_ledger.push({
      id: id(),
      tenant_id: m.apt.tenant_id,
      customer_id: m.cliente.id,
      kind: 'fiado',
      amount_cents: total,
      balance_after_cents: m.cliente.deve,
      order_id: pedido,
      session_id: m.sessao.id,
      location_id: m.apt.location_id,
      created_by: m.operador.id,
      created_by_name: m.operador.nome,
      created_at: m.fim,
    });
  }
  vendasDoDia.push({ total, meio });

  // -- a avaliação ----------------------------------------------------------
  /**
   * Um quarto avalia, e a nota pende para cima — como pende na vida.
   *
   * Uma base com nota uniforme faria a média da casa, a do barbeiro e o filtro
   * de nota do marketplace responderem todos a mesma coisa. As poucas notas
   * baixas são o que dá o que fazer à janela de recuperação de 48h.
   */
  if (m.apt.customer_id && chance(0.26)) {
    const nota = chance(0.82) ? 5 : chance(0.6) ? 4 : chance(0.5) ? 3 : chance(0.5) ? 2 : 1;
    linhas.reviews.push({
      id: id(),
      tenant_id: m.apt.tenant_id,
      appointment_id: m.apt.id,
      customer_id: m.apt.customer_id,
      professional_id: m.cadeira.id,
      rating: nota,
      comment: comentario(nota),
      created_at: new Date(m.fim.getTime() + entre(1, 40) * 3600_000),
    });
  }
}

/** Pix cresceu, dinheiro encolheu. É o que o gráfico por meio existe para mostrar. */
function meioDePagamento() {
  const r = rnd();
  if (r < 0.42) return 'pix';
  if (r < 0.68) return 'credit';
  if (r < 0.82) return 'debit';
  if (r < 0.97) return 'cash';
  return 'fiado';
}

/** Alíquota por meio, em pontos-base, como o adquirente cobra de verdade. */
function taxaDoMeio(meio, total) {
  const bps = { credit: 319, debit: 199, pix: 99, cash: 0, fiado: 0 }[meio] ?? 0;
  return Math.round((total * bps) / 10000);
}

const ELOGIOS = [
  'Melhor degradê que já fiz, saí de lá me sentindo outro.',
  'Atendimento no horário e sem enrolação. Voltarei.',
  'O acabamento na navalha é outro nível.',
  'Ambiente ótimo, café bom e conversa boa.',
  'Peguei o horário pelo site em dois minutos, sem ligar para ninguém.',
  null,
  null,
];
const RECLAMACOES = [
  'Marquei 15h e só fui atendido 15h40, sem ninguém avisar nada.',
  'O corte ficou desigual atrás, tive que voltar no dia seguinte.',
  'Cobraram a barba que eu não pedi. Resolveram, mas dá trabalho.',
];

function comentario(nota) {
  if (nota >= 4) return escolher(ELOGIOS);
  return escolher(RECLAMACOES);
}

/**
 * Quem deve volta e paga — e é isso que faz o fiado ser um razão, não um número.
 *
 * Sem a quitação, a dívida só cresce: em oito meses a base inteira estaria
 * devendo, o que não é barbearia, é inadimplência. E o pagamento entra na
 * gaveta como `debt_payment`, porque o dinheiro entra de verdade — sem esse
 * movimento o fechamento do dia acusaria falta que ninguém explica.
 */
function quitarFiado(linhas, clientes, sessao, dia, jornada, fuso, local, tenant, vendasDoDia) {
  for (const c of clientes) {
    if (!c.deve || c.deve <= 0) continue;
    if (!chance(0.06)) continue;

    // Paga tudo, ou uma parte redonda: é assim que se paga no balcão.
    const paga = chance(0.7) ? c.deve : Math.min(c.deve, entre(2, 8) * 2500);
    c.deve -= paga;
    const quando = instante(dia, entre(jornada.abre, jornada.fecha - 30), fuso);

    linhas.customer_ledger.push({
      id: id(),
      tenant_id: tenant,
      customer_id: c.id,
      kind: 'payment',
      amount_cents: -paga,
      balance_after_cents: c.deve,
      session_id: sessao.id,
      location_id: local,
      created_by: sessao.opened_by,
      created_by_name: sessao.opened_by_name,
      created_at: quando,
    });
    linhas.cash_movements.push({
      id: id(),
      tenant_id: tenant,
      session_id: sessao.id,
      kind: 'debt_payment',
      amount_cents: paga,
      created_by: sessao.opened_by,
      created_by_name: sessao.opened_by_name,
      created_at: quando,
    });
    vendasDoDia.push({ total: paga, meio: 'cash' });
  }
}

/**
 * O caixa do dia fecha com o que as vendas em dinheiro somam.
 *
 * Com diferença de vez em quando, e pequena: um caixa que bate ao centavo todo
 * santo dia é o retrato de um dado inventado, e a tela de fechamento existe
 * justamente para a divergência ter dono.
 */
function fecharCaixa(linhas, sessao, vendasDoDia, dia, jornada, fuso) {
  const emDinheiro = vendasDoDia
    .filter((v) => v.meio === 'cash')
    .reduce((s, v) => s + v.total, 0);
  const esperado = sessao.opening_cents + emDinheiro;

  linhas.cash_movements.push({
    id: id(),
    tenant_id: sessao.tenant_id,
    session_id: sessao.id,
    kind: 'opening',
    amount_cents: sessao.opening_cents,
    created_by: sessao.opened_by,
    created_by_name: sessao.opened_by_name,
    created_at: sessao.opened_at,
  });

  const diferenca = chance(0.14) ? entre(-8, 8) * 100 : 0;
  linhas.cash_sessions.push({
    ...sessao,
    closed_by: sessao.opened_by,
    closed_by_name: sessao.opened_by_name,
    closed_at: instante(dia, jornada.fecha + 20, fuso),
    counted_cents: esperado + diferenca,
    expected_cents: esperado,
    difference_cents: diferenca,
    ...(diferenca !== 0 ? { notes: 'Conferido duas vezes. Diferença anotada no caderno.' } : {}),
  });
}

// ---------------------------------------------------------------------------
// Gravação
// ---------------------------------------------------------------------------

function gravar(url, tenant, regras, linhas) {
  const sql = [
    // A transação é uma só: um fundo escrito pela metade é pior que fundo
    // nenhum, porque a tela mostra conta que não fecha em vez de tela vazia.
    'BEGIN;',
    inserir('commission_rules', ['id', 'tenant_id', 'professional_id', 'mode', 'value', 'tiers'],
      regras.map((r) => ({
        id: r.id,
        tenant_id: tenant,
        professional_id: r.professional_id,
        mode: 'percent',
        // A alíquota em pontos-base, como em todo o produto: 4000 = 40%.
        value: r.bps,
        tiers: '[]',
      }))),

    inserir('customers',
      ['id', 'tenant_id', 'name', 'phone_e164', 'birth_date', 'created_at', 'acquired_via', 'acquired_at'],
      linhas.customers),

    inserir('cash_sessions',
      ['id', 'tenant_id', 'location_id', 'status', 'opened_by', 'opened_by_name', 'opened_at',
        'opening_cents', 'closed_by', 'closed_by_name', 'closed_at', 'counted_cents',
        'expected_cents', 'difference_cents', 'notes'],
      linhas.cash_sessions.map((x) => ({
        closed_by: null, closed_by_name: null, closed_at: null, counted_cents: null,
        difference_cents: null, notes: null, ...x,
      }))),

    inserir('appointments',
      ['id', 'tenant_id', 'location_id', 'customer_id', 'professional_id', 'starts_at', 'ends_at',
        'service_starts_at', 'service_ends_at', 'status', 'source', 'price_cents', 'discount_cents',
        'deposit_required_cents', 'deposit_paid_cents', 'created_at', 'updated_at',
        'completed_at', 'started_at', 'cancelled_at'],
      linhas.appointments),

    inserir('appointment_services',
      ['appointment_id', 'service_id', 'tenant_id', 'position', 'price_cents', 'duration_minutes'],
      linhas.appointment_services),

    inserir('orders',
      ['id', 'tenant_id', 'location_id', 'customer_id', 'appointment_id', 'session_id', 'status',
        'opened_by', 'opened_at', 'closed_at', 'subtotal_cents', 'discount_cents',
        'tip_cents', 'total_cents', 'change_cents', 'business_day', 'fee_cents'],
      linhas.orders),

    inserir('order_items',
      ['id', 'tenant_id', 'order_id', 'kind', 'service_id', 'description', 'quantity',
        'unit_price_cents', 'professional_id', 'position', 'created_at'],
      linhas.order_items),

    inserir('order_payments',
      ['id', 'tenant_id', 'order_id', 'method', 'amount_cents', 'created_at'], linhas.order_payments),

    inserir('commission_entries',
      ['id', 'tenant_id', 'professional_id', 'order_id', 'order_item_id', 'earned_on', 'rule_id',
        'mode', 'value', 'tiers', 'base_cents', 'sign', 'created_at'],
      linhas.commission_entries),

    inserir('loyalty_entries',
      ['id', 'tenant_id', 'customer_id', 'order_id', 'kind', 'mode', 'amount', 'base_cents',
        'location_id', 'scope', 'created_at'],
      linhas.loyalty_entries),

    inserir('cash_movements',
      ['id', 'tenant_id', 'session_id', 'kind', 'amount_cents', 'order_id', 'created_by',
        'created_by_name', 'created_at'],
      linhas.cash_movements.map((m) => ({ order_id: null, ...m }))),

    inserir('reviews',
      ['id', 'tenant_id', 'appointment_id', 'customer_id', 'professional_id', 'rating', 'comment', 'created_at'],
      linhas.reviews),

    inserir('customer_ledger',
      ['id', 'tenant_id', 'customer_id', 'kind', 'amount_cents', 'balance_after_cents',
        'order_id', 'session_id', 'location_id', 'created_by', 'created_by_name', 'created_at'],
      linhas.customer_ledger.map((l) => ({ order_id: null, ...l }))),

    /**
     * O programa de fidelidade, sem o qual os lançamentos não querem dizer nada.
     *
     * A simulação acumula ponto em toda venda, e ponto sem programa é número
     * num razão que nenhuma tela sabe ler — saldo aparecendo na ficha do
     * cliente com a tela de fidelidade dizendo "nenhum programa configurado".
     * Um ponto por real é o que a acumulação escreveu; os dois têm que ser a
     * mesma regra.
     */
    inserir('loyalty_programs',
      ['tenant_id', 'mode', 'points_per_real', 'point_value_cents', 'expires_days'],
      [{ tenant_id: tenant, mode: 'pontos', points_per_real: 1, point_value_cents: 5, expires_days: 365 }]),

    /**
     * A alíquota do adquirente por meio de pagamento.
     *
     * Ela entra **depois** das vendas de propósito: o que vale para a comissão
     * é o `fee_cents` congelado em cada venda, e esta tabela é só o cadastro de
     * hoje. Renegociar a maquininha em maio não muda comissão paga em abril.
     */
    inserir('acquirer_fees', ['tenant_id', 'method', 'bps'], [
      { tenant_id: tenant, method: 'credit', bps: 319 },
      { tenant_id: tenant, method: 'debit', bps: 199 },
      { tenant_id: tenant, method: 'pix', bps: 99 },
    ]),
    /**
     * O saldo do cadastro é o **fim do razão**, nunca um número à parte.
     *
     * Ele é espelho: quem responde "quanto o Anderson deve" é a soma dos
     * lançamentos, e gravar um valor solto aqui criaria a segunda fonte de
     * verdade que o extrato existe para não ter. O limite entra só para quem
     * de fato usa fiado — dar limite a quem nunca pediu enche a tela de crédito
     * que ninguém concedeu.
     */
    `UPDATE customers c SET
        balance_cents = COALESCE(r.saldo, 0),
        credit_limit_cents = CASE WHEN r.saldo IS NULL THEN 0 ELSE 30000 END
       FROM (SELECT customer_id, sum(amount_cents) AS saldo
               FROM customer_ledger WHERE tenant_id = ${lit(tenant)}
              GROUP BY customer_id) r
      WHERE r.customer_id = c.id;`,
    'COMMIT;',
  ].join('\n');

  executar(url, sql);
}
