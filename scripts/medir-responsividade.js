/**
 * Mede todas as telas nas larguras de conferência (CLAUDE.md §5).
 *
 * O teste de `globals.css` pega o que dá para ver no arquivo — media query
 * invertida, largura fixa, conteúdo escondido no celular. O que ele **não** pega
 * é o layout montado: uma grade de três colunas com conteúdo real estoura sem
 * nenhuma largura fixa no CSS.
 *
 * Por isso este script abre cada tela em 360, 390, 768 e 1280 e mede elemento a
 * elemento. Fica fora do `pnpm verify` porque precisa dos dois servidores de pé;
 * entra na esteira no bloco 23, junto com o resto do e2e.
 *
 *   node scripts/medir-responsividade.js
 */

/**
 * O Playwright entra por resolução normal, com o caminho da instalação global
 * como plano B.
 *
 * Ele era pedido **só** pelo caminho absoluto de uma instalação global desta
 * máquina, o que fazia a medição funcionar aqui e em lugar nenhum. Na esteira o
 * `require` falharia com "Cannot find module" sobre uma pasta que nunca
 * existiu, e a etapa apareceria quebrada por um motivo que não é dela.
 *
 * A ordem importa: primeiro o do repositório (é o que a esteira instala e o que
 * o `pnpm-lock` fixa), depois o global (é o que já está aqui e evita baixar
 * navegador de novo no ambiente de desenvolvimento).
 */
function carregarPlaywright() {
  for (const origem of ['playwright', '/opt/node22/lib/node_modules/playwright']) {
    try {
      return require(origem);
    } catch (erro) {
      if (erro.code !== 'MODULE_NOT_FOUND') throw erro;
    }
  }
  throw new Error(
    'Playwright não encontrado. Rode `pnpm install` na raiz — ele é devDependency do repositório.',
  );
}

const { chromium } = carregarPlaywright();
const { execFileSync } = require('node:child_process');

const WEB = process.env.WEB_URL ?? 'http://127.0.0.1:3001';
const API = process.env.API_URL ?? 'http://127.0.0.1:3000';
const DB = process.env.DEMO_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/demo';

const LARGURAS = [360, 390, 768, 1280];

/**
 * Fotos usadas na medição.
 *
 * O Chromium do ambiente não sai para a internet, mas o Node sai. As imagens
 * são baixadas aqui e servidas por interceptação: a página continua pedindo a
 * URL https real, e o layout é medido com o peso e a proporção verdadeiros.
 * Se o download falhar, a rota é abortada e a medição vira a da página sem
 * foto — que continua sendo um estado que precisa passar.
 */
const FOTOS = {
  capa: 'https://images.unsplash.com/photo-1585747860715-2ba37e788b70?w=1600&q=70',
  rostos: [
    'https://images.unsplash.com/photo-1503443207922-dff7d543fd0e?w=800&q=70',
    'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=800&q=70',
  ],
  cortes: [
    'https://images.unsplash.com/photo-1621605815971-fbc98d665033?w=600&q=70',
    'https://images.unsplash.com/photo-1599351431202-1e0f0137899a?w=600&q=70',
    'https://images.unsplash.com/photo-1621607512214-68297480165e?w=600&q=70',
  ],
};

/** Baixa uma vez e guarda em memória, para não repetir a cada largura. */
const cacheDeFoto = new Map();
async function baixarFoto(url) {
  if (cacheDeFoto.has(url)) return cacheDeFoto.get(url);
  try {
    const resposta = await fetch(url);
    const bytes = resposta.ok ? Buffer.from(await resposta.arrayBuffer()) : null;
    cacheDeFoto.set(url, bytes);
    return bytes;
  } catch {
    cacheDeFoto.set(url, null);
    return null;
  }
}

const psql = (sql) => execFileSync('psql', [DB, '-tAc', sql], { encoding: 'utf8' }).trim();

/**
 * Prepara a conta da plataforma e uma barbearia bloqueada.
 *
 * A conta nasce pelo mesmo comando que a produção usa — não há rota HTTP para
 * criá-la, de propósito. E uma das barbearias entra bloqueada porque o cartão
 * bloqueado é o mais largo da lista: ele tem o selo, o motivo e a data, e é
 * onde a linha estoura em 360px se estourar.
 */
async function prepararPlataforma() {
  const email = `super${Date.now()}@plataforma.teste`;
  const senha = 'senha-da-plataforma-medida';

  try {
    execFileSync('node', ['scripts/criar-super-admin.mjs', 'Super', email], {
      env: { ...process.env, SUPER_ADMIN_PASSWORD: senha, DATABASE_URL: process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL },
      stdio: 'pipe',
    });
  } catch (erro) {
    console.warn(`  aviso: conta da plataforma não criada (${erro.message.split('\n')[0]})`);
    return null;
  }

  const entrada = await fetch(`${API}/v1/plataforma/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, senha }),
  });
  if (!entrada.ok) {
    console.warn('  aviso: login da plataforma falhou; telas da plataforma fora da medição');
    return null;
  }
  const { token } = await entrada.json();

  // Uma barbearia bloqueada de verdade, e não a `slug` que as outras telas
  // usam: bloquear aquela derrubaria metade da medição.
  const alvo = psql(
    `INSERT INTO tenants (name) VALUES ('Barbearia com nome bem comprido de teste') RETURNING id`,
  );
  await fetch(`${API}/v1/plataforma/barbearias/${alvo}/bloqueio`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ motivo: 'inadimplente há 60 dias, sem retorno no telefone do cadastro' }),
  });

  // Métricas com a tabela cheia. Medir a tela vazia mediria o estado vazio —
  // que também precisa passar, mas não é onde oito colunas estouram os 360px.
  // Nome comprido e receita de sete dígitos de propósito: são eles que quebram
  // layout, e só aparecem com conteúdo de verdade.
  const ontem = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  psql(
    `INSERT INTO tenant_metrics_daily (tenant_id, business_day, appointments_total,` +
      ` appointments_online, no_shows, minutes_sold, minutes_available, revenue_cents)` +
      ` SELECT tenant_id, '${ontem}'::date, 412, 268, 31, 18400, 26400, 1284900` +
      ` FROM tenant_platform ON CONFLICT DO NOTHING`,
  );

  return token;
}

/** Prepara uma barbearia publicada e uma sessão de gestor. */
async function preparar() {
  const conta = {
    name: 'Medida',
    email: `medida${Date.now()}@teste.com`,
    password: 'senha-bem-comprida',
    phone: '(71) 99999-0000',
    businessName: `Medida ${Date.now() % 10000}`,
  };
  const json = (r) => r.json();
  const post = (rota, corpo, token) =>
    fetch(`${API}${rota}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(corpo),
    });
  const put = (rota, corpo, token) =>
    fetch(`${API}${rota}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(corpo),
    });

  await post('/v1/admin/signup', conta);
  const sessao = await json(await post('/v1/admin/login', { email: conta.email, password: conta.password }));
  const t = sessao.token;

  await put('/v1/admin/business', { name: conta.businessName, city: 'Salvador', timezone: 'America/Bahia' }, t);
  const { templates } = await json(await fetch(`${API}/v1/admin/templates`, { headers: { authorization: `Bearer ${t}` } }));
  await put('/v1/admin/services', { services: templates }, t);
  await put(
    '/v1/admin/professionals',
    {
      professionals: [
        { name: 'Ruan', schedule: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1320 })) },
        { name: 'Gleidson', schedule: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMinute: 540, endMinute: 1320 })) },
      ],
    },
    t,
  );
  await put('/v1/admin/payments', { methods: ['pix', 'cash'] }, t);
  await post('/v1/admin/publish', {}, t);

  // Fotos de verdade, não caixas vazias: imagem é o que mais estoura layout, e
  // medir a página sem elas mediria a versão que não existe mais.
  const alvos = await json(await fetch(`${API}/v1/admin/photos`, { headers: { authorization: `Bearer ${t}` } }));
  await put(
    '/v1/admin/photos',
    {
      coverUrl: FOTOS.capa,
      professionals: alvos.professionals.map((p, i) => ({
        id: p.id,
        photoUrl: FOTOS.rostos[i % FOTOS.rostos.length],
      })),
      services: alvos.services.map((sv, i) => ({
        // Metade sem foto de propósito: é a mistura que desalinha a coluna de
        // preço, não a lista toda ilustrada.
        id: sv.id,
        photoUrl: i % 2 === 0 ? FOTOS.cortes[i % FOTOS.cortes.length] : '',
      })),
    },
    t,
  );

  // Uma conta além da do dono: a lista de equipe com uma linha só não mostra o
  // que acontece quando cabem selo, papel e botões na mesma altura.
  await post(
    '/v1/admin/team',
    { name: 'Maria Aparecida do Nascimento', email: `recep${Date.now()}@teste.com`, role: 'receptionist' },
    t,
  );

  return { token: t, slug: sessao.slug };
}

/** Agenda um horário e devolve uma sessão de cliente, para as telas logadas. */
async function prepararCliente(slug) {
  const local = psql('select id from locations order by created_at desc limit 1');
  const servico = psql(
    `select id from services where active and tenant_id = (select tenant_id from tenant_slugs where slug = '${slug}') order by price_cents limit 1`,
  );
  const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  const grade = await (
    await fetch(`${API}/v1/b/${slug}/availability?locationId=${local}&serviceIds=${servico}&dateFrom=${amanha}&anyProfessional=true`)
  ).json();
  const slot = grade.days[0]?.slots?.[0];
  if (!slot) throw new Error('sem horário livre amanhã para preparar o cliente');

  const telefone = '(71) 98888-7777';
  await fetch(`${API}/v1/b/${slug}/appointments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Carlos Souza', phone: telefone, locationId: local,
      professionalId: slot.professionalId, serviceIds: [servico], date: amanha, start: slot.start,
    }),
  });

  // O provedor de mensagem nunca escreve o código em log — é regra do projeto.
  // Para medir a tela, o código entra pelo banco.
  const { createHash } = require('node:crypto');
  psql('DELETE FROM otp_challenges');
  await fetch(`${API}/v1/b/${slug}/auth/otp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: telefone }),
  });
  psql(`UPDATE otp_challenges SET code_hash = '${createHash('sha256').update('123456').digest('hex')}', attempts = 0`);

  const sessao = await (
    await fetch(`${API}/v1/b/${slug}/auth/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: telefone, code: '123456' }),
    })
  ).json();

  return sessao.token;
}

/**
 * Enche o dia de hoje pelo balcão, com conteúdo real.
 *
 * Nome composto, serviço longo e dois profissionais: é o que quebra layout, e
 * só aparece com conteúdo verdadeiro (CLAUDE.md §5).
 */
async function prepararBalcao(token) {
  const cabecalho = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const catalogo = await (await fetch(`${API}/v1/admin/catalog`, { headers: cabecalho })).json();
  const hoje = await (await fetch(`${API}/v1/admin/day`, { headers: cabecalho })).json();

  const servico = catalogo.services.reduce((maior, s) => (s.name.length > maior.name.length ? s : maior));
  const pessoas = [
    { name: 'Maria Aparecida do Nascimento', phone: '(71) 98111-2233' },
    { name: 'Zé', phone: '(71) 98111-2244' },
  ];

  // O dia medido é **amanhã**, não hoje: rodar a medição às onze da noite
  // deixaria o painel vazio, e medir a tela vazia não prova nada sobre a cheia.
  const amanha = new Date(`${hoje.today}T12:00:00Z`);
  amanha.setUTCDate(amanha.getUTCDate() + 1);
  const dataLivre = amanha.toISOString().slice(0, 10);

  for (const [i, pessoa] of pessoas.entries()) {
    const profissional = catalogo.professionals[i % catalogo.professionals.length];
    const grade = await (
      await fetch(
        `${API}/v1/admin/availability?serviceIds=${servico.id}&professionalId=${profissional.id}&dateFrom=${dataLivre}&dateTo=${dataLivre}`,
        { headers: cabecalho },
      )
    ).json();
    const slot = grade.days[0]?.slots?.[i];
    if (!slot) throw new Error(`sem horário livre em ${dataLivre} para preparar o balcão`);

    const criado = await (
      await fetch(`${API}/v1/admin/appointments`, {
        method: 'POST',
        headers: cabecalho,
        body: JSON.stringify({
          ...pessoa,
          professionalId: profissional.id,
          serviceIds: [servico.id],
          date: dataLivre,
          start: slot.start,
        }),
      })
    ).json();

    // Um deles já chegou: a linha com "esperando há X min" e a com o relógio da
    // falta têm alturas diferentes, e é a mistura que estoura layout.
    if (i === 0 && criado.id) {
      await fetch(`${API}/v1/admin/appointments/${criado.id}/attendance`, {
        method: 'POST',
        headers: cabecalho,
        body: JSON.stringify({ action: 'check_in' }),
      });
    }
  }

  // O que a medição precisa para abrir os passos seguintes da marcação sem
  // depender de clique.
  const grade = await (
    await fetch(
      `${API}/v1/admin/availability?serviceIds=${servico.id}&dateFrom=${dataLivre}&dateTo=${dataLivre}`,
      { headers: cabecalho },
    )
  ).json();

  // A ficha precisa de um cliente com histórico: anotação preenchida e
  // atendimento concluído. Ficha em branco mede o estado vazio, que também
  // importa — mas é a cheia que estoura layout.
  const clienteId = psql(
    `select id from customers order by created_at desc limit 1`,
  ) || null;
  if (clienteId) {
    await fetch(`${API}/v1/admin/customers/${clienteId}/preferences`, {
      method: 'PUT',
      headers: cabecalho,
      body: JSON.stringify({
        produtosEvitar: 'Pós-barba com álcool e qualquer produto com mentol',
        maquinaLaterais: 'Máquina 1 com pente de meio',
        tipoDegrade: 'Degradê médio, começando na altura da orelha',
        topo: 'Tesoura, deixando comprimento',
        barbaEstilo: 'Aparar sem navalha, manter o desenho do queixo',
        conversa: 'silencioso',
        observacoes:
          'Redemoinho do lado direito abre para cima. Não gosta de espelho na frente durante o corte.',
      }),
    });
  }

  return {
    dia: dataLivre,
    servicoId: servico.id,
    dataLivre,
    clienteId,
    horaLivre: grade.days[0]?.slots?.[0]?.start,
    profissionalLivre: grade.days[0]?.slots?.[0]?.professionalId,
  };
}

/**
 * Cadastra recursos com nome comprido.
 *
 * "sala de barba" e "lavatório" são o vocabulário real da barbearia, e são
 * nomes que estouram célula de tabela em 360px — medir a tela vazia não prova
 * nada sobre a cheia.
 */
async function prepararRecursos(token) {
  const cabecalho = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  await fetch(`${API}/v1/admin/catalog/resources`, {
    method: 'PUT',
    headers: cabecalho,
    body: JSON.stringify({
      pools: [
        { resourceType: 'cadeira', capacity: 3 },
        { resourceType: 'lavatório', capacity: 1 },
        { resourceType: 'sala de barba', capacity: 2 },
      ],
    }),
  });
}

/**
 * Põe gente na fila, com nome comprido e um pedido de profissional.
 *
 * Medir a fila vazia não prova nada sobre a cheia: o que estoura layout é o
 * cartão com nome composto, serviço longo e três botões de ação.
 */
async function prepararFila(token) {
  const cabecalho = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const catalogo = await (await fetch(`${API}/v1/admin/catalog`, { headers: cabecalho })).json();
  const servico = catalogo.services.reduce((maior, s) => (s.name.length > maior.name.length ? s : maior));

  const gente = [
    { name: 'Maria Aparecida do Nascimento', phone: '(71) 98111-3311' },
    { name: 'Zé', phone: '(71) 98111-3322', professionalId: catalogo.professionals[0]?.id },
  ];

  let link = null;
  for (const pessoa of gente) {
    const criada = await (
      await fetch(`${API}/v1/admin/queue`, {
        method: 'POST',
        headers: cabecalho,
        body: JSON.stringify({ ...pessoa, serviceIds: [servico.id] }),
      })
    ).json();
    if (criada.token) link = link ?? criada.token;
  }

  // Um chamado: a linha do chamado tem selo e botão diferentes das outras.
  const fila = await (await fetch(`${API}/v1/admin/queue`, { headers: cabecalho })).json();
  const primeira = fila.entries?.[0];
  if (primeira) {
    await fetch(`${API}/v1/admin/queue/${primeira.id}/move`, {
      method: 'POST',
      headers: cabecalho,
      body: JSON.stringify({ para: 'called' }),
    });
  }

  return { link };
}

/**
 * Bloqueia uma hora e fecha um dia, para medir a agenda com conteúdo.
 *
 * Agenda vazia não prova nada sobre agenda cheia: o que estoura layout é a
 * coluna com nome composto, cartão com buffer e bloqueio hachurado ao lado.
 */
async function prepararAgenda(token, dia) {
  const cabecalho = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const catalogo = await (await fetch(`${API}/v1/admin/catalog`, { headers: cabecalho })).json();

  await fetch(`${API}/v1/admin/agenda/blocks`, {
    method: 'POST',
    headers: cabecalho,
    body: JSON.stringify({
      kind: 'block',
      date: dia,
      startMinute: 780,
      endMinute: 840,
      professionalId: catalogo.professionals[0]?.id,
      reason: 'Consulta no dentista da Maria Aparecida',
      confirmarConflitos: true,
    }),
  });

  await fetch(`${API}/v1/admin/agenda/exceptions`, {
    method: 'POST',
    headers: cabecalho,
    body: JSON.stringify({
      kind: 'day_off',
      date: dia,
      professionalId: catalogo.professionals[1]?.id,
      reason: 'Folga combinada',
      confirmarConflitos: true,
    }),
  });
}


/**
 * O balcão com dinheiro dentro: caixa aberto, comanda com itens e um fiado.
 *
 * Sem isso as três telas novas seriam medidas vazias — e estado vazio é
 * justamente o layout que **não** quebra. Nome composto de barbeiro, serviço de
 * nome longo e preço de quatro dígitos são o que estoura grade, e só aparecem
 * com conteúdo de verdade (CLAUDE.md §5).
 */
async function prepararCaixa(token, catalogo) {
  const cabecalho = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const { codigoDoPasso, passoAgora } = require('../packages/identity/dist/mfa.js');

  const inicio = await fetch(`${API}/v1/admin/mfa/setup`, { method: 'POST', headers: cabecalho });
  if (!inicio.ok) return { ok: false, motivo: `mfa/setup: ${inicio.status}` };
  const { segredoBase32 } = await inicio.json();

  // O passo confirmado é queimado, então a verificação usa o **seguinte**.
  // Dormir 31 segundos até ele chegar seria meio minuto por execução sem ganho
  // nenhum: o código do passo+1 já é aceito agora, dentro da tolerância de ±1.
  const passo = passoAgora(new Date());
  await fetch(`${API}/v1/admin/mfa/confirm`, {
    method: 'POST',
    headers: cabecalho,
    body: JSON.stringify({ codigo: codigoDoPasso(segredoBase32, passo) }),
  });
  await fetch(`${API}/v1/admin/mfa/verify`, {
    method: 'POST',
    headers: cabecalho,
    body: JSON.stringify({ codigo: codigoDoPasso(segredoBase32, passo + 1) }),
  });

  await fetch(`${API}/v1/admin/cash/open`, {
    method: 'POST',
    headers: cabecalho,
    body: JSON.stringify({ openingCents: 20000 }),
  });

  await fetch(`${API}/v1/admin/cash/movements`, {
    method: 'POST',
    headers: cabecalho,
    body: JSON.stringify({
      kind: 'withdrawal',
      amountCents: 15000,
      reason: 'Depósito no Banco do Brasil da avenida',
    }),
  });

  const comanda = await fetch(`${API}/v1/admin/orders`, {
    method: 'POST',
    headers: cabecalho,
    body: JSON.stringify({}),
  });
  if (!comanda.ok) return { ok: false, motivo: `orders: ${comanda.status}` };
  const { id: orderId } = await comanda.json();

  const proNome = catalogo.professionals[0];
  for (const item of [
    { descricao: 'Corte degradê com máquina e tesoura', precoUnitarioCents: 129000 },
    { descricao: 'Barba terapêutica com toalha quente', precoUnitarioCents: 4900 },
  ]) {
    await fetch(`${API}/v1/admin/orders/${orderId}/items`, {
      method: 'POST',
      headers: cabecalho,
      body: JSON.stringify({
        tipo: 'service',
        quantidade: 1,
        professionalId: proNome?.id,
        ...item,
      }),
    });
  }

  // Comissão com conteúdo: regra geral, uma por profissional, e faixas — mais
  // uma venda fechada, para o extrato não ser medido vazio. Estado vazio é
  // justamente o layout que **não** quebra.
  await fetch(`${API}/v1/admin/commission/rules`, {
    method: 'POST', headers: cabecalho,
    body: JSON.stringify({ modo: 'percent', valor: 4000 }),
  }).catch(() => undefined);
  await fetch(`${API}/v1/admin/commission/rules`, {
    method: 'PUT', headers: cabecalho,
    body: JSON.stringify({ modo: 'percent', valor: 4000 }),
  });
  await fetch(`${API}/v1/admin/commission/rules`, {
    method: 'PUT', headers: cabecalho,
    body: JSON.stringify({
      professionalId: catalogo.professionals[0]?.id,
      serviceId: catalogo.services[0]?.id,
      modo: 'tiers', valor: 0,
      faixas: [
        { ateCents: 500000, pontosBase: 4000 },
        { ateCents: 800000, pontosBase: 4500 },
        { ateCents: null, pontosBase: 5000 },
      ],
    }),
  });

  const comissionada = await fetch(`${API}/v1/admin/orders`, {
    method: 'POST', headers: cabecalho, body: JSON.stringify({}),
  });
  if (comissionada.ok) {
    const { id } = await comissionada.json();
    await fetch(`${API}/v1/admin/orders/${id}/items`, {
      method: 'POST', headers: cabecalho,
      body: JSON.stringify({
        tipo: 'service', descricao: 'Corte degradê com máquina e tesoura',
        quantidade: 1, precoUnitarioCents: 129000,
        professionalId: catalogo.professionals[0]?.id,
      }),
    });
    await fetch(`${API}/v1/admin/orders/${id}/close`, {
      method: 'POST', headers: cabecalho,
      body: JSON.stringify({ pagamentos: [{ forma: 'cash', valorCents: 129000 }] }),
    });
  }

  return { ok: true, orderId };
}

/**
 * Convida um barbeiro e devolve a sessão dele.
 *
 * A tela `/admin/meu-dia` precisa ser medida com a conta de quem ela serve: com
 * o cookie do dono ela renderiza, mas mostrando o salão inteiro — que é
 * justamente o layout que ela existe para não ter.
 */
async function prepararBarbeiro(token, profissionalId) {
  const cabecalho = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const email = `barbeiro${Date.now()}@teste.com`;

  const convite = await fetch(`${API}/v1/admin/team/invite`, {
    method: 'POST',
    headers: cabecalho,
    body: JSON.stringify({ professionalId: profissionalId, email }),
  });
  if (!convite.ok) return null;
  const { senhaInicial } = await convite.json();

  const entrar = (senha) =>
    fetch(`${API}/v1/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: senha }),
    }).then((r) => r.json());

  const primeira = await entrar(senhaInicial);
  await fetch(`${API}/v1/admin/me/password`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${primeira.token}` },
    body: JSON.stringify({ currentPassword: senhaInicial, newPassword: 'a-senha-do-barbeiro' }),
  });

  const dele = await entrar('a-senha-do-barbeiro');
  if (!dele.token) return null;

  // Meta definida: sem ela a tela mostra "sem meta", que é um estado legítimo e
  // o mais curto — medir só ele deixaria a barra e o ritmo fora da régua.
  const hoje = new Date().toISOString().slice(0, 10);
  await fetch(`${API}/v1/admin/pro/goals`, {
    method: 'PUT',
    headers: cabecalho,
    body: JSON.stringify({
      professionalId: profissionalId,
      mes: `${hoje.slice(0, 7)}-01`,
      metaCents: 1_500_000,
    }),
  });

  return dele.token;
}

/**
 * Envia um arquivo de base e deixa a importação **em preview**.
 *
 * O estado mais largo da tela de importação é o do passo 2, com a lista de
 * linhas recusadas. Conteúdo real de propósito: nome composto de quatro
 * palavras, telefone em três formatos e uma linha estragada — que é o que
 * quebra layout, não texto de preenchimento.
 */
async function prepararImportacao(token) {
  const linhas = [
    'Nome;Celular;Data de Nascimento;Observações',
    'José Antônio da Silva Nascimento;(71) 98888-1111;07/09/1985;Corta na tesoura, sem máquina',
    'Ana Paula Rodrigues;71 97777-2222;1990-03-12;',
    'Bruno Carvalho;(71) 8888-3333;;Sempre atrasa uns quinze minutos',
    'Cliente Sem Telefone Cadastrado No Sistema Antigo;;;',
    ';71966664444;;linha sem nome',
    'Outro Nome Para O Mesmo Celular;(71) 98888-1111;;',
  ].join('\n');

  const resposta = await fetch(`${API}/v1/admin/imports`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ fileName: 'clientes-agenda-antiga-exportacao-final.csv', conteudo: linhas }),
  });
  if (!resposta.ok) return null;
  return (await resposta.json()).id;
}

async function main() {
  const { token, slug } = await preparar();
  const tokenCliente = await prepararCliente(slug);
  const balcao = await prepararBalcao(token);
  await prepararRecursos(token);
  const filaPreparada = await prepararFila(token);
  await prepararAgenda(token, balcao.dia);
  const catalogo = await (await fetch(`${API}/v1/admin/catalog`, {
    headers: { authorization: `Bearer ${token}` },
  })).json();
  const caixa = await prepararCaixa(token, catalogo);
  const tokenBarbeiro = balcao.profissionalLivre
    ? await prepararBarbeiro(token, balcao.profissionalLivre)
    : null;
  if (!tokenBarbeiro) console.warn('  aviso: barbeiro não convidado; "meu dia" fora da medição');
  if (!caixa.ok) console.warn(`  aviso: caixa não preparado (${caixa.motivo})`);
  const importacao = await prepararImportacao(token);
  if (!importacao) console.warn('  aviso: importação não preparada; passo 2 fora da medição');
  const tokenPlataforma = await prepararPlataforma();

  const telas = [
    // A porta do produto. Não pertence a barbearia nenhuma e não precisa de
    // sessão — é a única tela medida sem nada preparado antes.
    { nome: 'landing', url: '/' },
    { nome: 'pública', url: `/${slug}` },
    { nome: 'agendar', url: `/${slug}/agendar` },
    { nome: 'entrar (cliente)', url: `/${slug}/entrar` },
    { nome: 'meus agendamentos', url: `/${slug}/meus-agendamentos`, cookie: { nome: `sessao_${slug}`, valor: tokenCliente, caminho: `/${slug}` } },
    { nome: 'criar conta', url: '/admin/criar-conta' },
    { nome: 'entrar (gestor)', url: '/admin/entrar' },
    { nome: 'entrar (plataforma)', url: '/plataforma/entrar' },
    ...(tokenPlataforma
      ? [
          { nome: 'plataforma — barbearias', url: '/plataforma', cookie: { nome: 'plataforma', valor: tokenPlataforma, caminho: '/plataforma' } },
          { nome: 'plataforma — métricas', url: '/plataforma/metricas', cookie: { nome: 'plataforma', valor: tokenPlataforma, caminho: '/plataforma' } },
          { nome: 'plataforma — trilha', url: '/plataforma/trilha', cookie: { nome: 'plataforma', valor: tokenPlataforma, caminho: '/plataforma' } },
          { nome: 'plataforma — segurança', url: '/plataforma/seguranca', cookie: { nome: 'plataforma', valor: tokenPlataforma, caminho: '/plataforma' } },
        ]
      : []),
    { nome: 'onboarding', url: '/admin/onboarding', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'configurações', url: '/admin/configuracoes', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'fotos', url: '/admin/fotos', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'equipe', url: '/admin/equipe', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'catálogo', url: '/admin/catalogo', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'profissionais', url: '/admin/profissionais', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'jornada aberta', url: `/admin/profissionais?pessoa=${balcao.profissionalLivre}`, cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'recursos', url: '/admin/recursos', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'trocar senha', url: '/admin/trocar-senha', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'agenda — dia', url: `/admin/agenda?de=${balcao.dia}`, cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'agenda — semana', url: `/admin/agenda?v=semana&de=${balcao.dia}`, cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'agenda — lista', url: `/admin/agenda?v=lista&de=${balcao.dia}`, cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'fila (balcão)', url: '/admin/fila', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    ...(filaPreparada.link
      ? [{ nome: 'fila (cliente)', url: `/${slug}/fila/${filaPreparada.link}` }]
      : []),
    { nome: 'balcão — o dia', url: `/admin/dia?d=${balcao.dia}`, cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'balcão — serviço', url: '/admin/dia/marcar', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'balcão — horário', url: `/admin/dia/marcar?s=${balcao.servicoId}&d=${balcao.dataLivre}&e=c`, cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    {
      nome: 'balcão — para quem',
      url: `/admin/dia/marcar?s=${balcao.servicoId}&p=${balcao.profissionalLivre}&d=${balcao.dataLivre}&h=${balcao.horaLivre}&e=d&q=nascimento`,
      cookie: { nome: 'gestor', valor: token, caminho: '/admin' },
    },
    { nome: 'segurança (MFA)', url: '/admin/seguranca', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'caixa', url: '/admin/caixa', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'cobrar', url: '/admin/comanda', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    ...(caixa.ok
      ? [{ nome: 'comanda', url: `/admin/comanda/${caixa.orderId}`, cookie: { nome: 'gestor', valor: token, caminho: '/admin' } }]
      : []),
    { nome: 'fiado', url: '/admin/fiado', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'comissão', url: '/admin/comissao', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'regras de comissão', url: '/admin/comissao/regras', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'avisos', url: '/admin/avisos', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    // O painel entra com o segundo fator já provado (o `prepararCaixa` o liga),
    // porque é com o bloco de dinheiro desenhado que ele fica mais largo — medir
    // a versão sem faturamento mediria a tela mais fácil.
    { nome: 'painel', url: '/admin/painel', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'diagnóstico do catálogo', url: '/admin/catalogo/diagnostico', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'trilha', url: '/admin/trilha', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    // A aba do dinheiro é outra rota e outra permissão, com valores em centavos
    // no corpo do evento — que é o que estoura a linha em 360px.
    { nome: 'trilha — dinheiro', url: '/admin/trilha?aba=dinheiro', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    // A importação é medida **com um preview aberto**: é o estado mais largo da
    // tela, com a lista de linhas recusadas e o nome de arquivo comprido. Medir
    // o formulário vazio mediria a versão fácil.
    { nome: 'importar base', url: '/admin/importar', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    ...(importacao
      ? [{ nome: 'importar — conferindo', url: `/admin/importar?i=${importacao}`, cookie: { nome: 'gestor', valor: token, caminho: '/admin' } }]
      : []),
    // A tela do barbeiro e a ficha do cliente. O `token` aqui é o do dono, que
    // vê tudo — o recorte por profissional é do servidor e tem teste próprio;
    // o que se mede aqui é o layout.
    ...(balcao.clienteId
      ? [{ nome: 'ficha do cliente', url: `/admin/cliente/${balcao.clienteId}`, cookie: { nome: 'gestor', valor: token, caminho: '/admin' } }]
      : []),
    ...(tokenBarbeiro
      ? [
          { nome: 'meu dia (barbeiro)', url: '/admin/meu-dia', cookie: { nome: 'gestor', valor: tokenBarbeiro, caminho: '/admin' } },
          { nome: 'meus números', url: '/admin/meus-numeros', cookie: { nome: 'gestor', valor: tokenBarbeiro, caminho: '/admin' } },
        ]
      : []),
  ];

  const browser = await chromium.launch({
    // Sem `executablePath`: o Playwright usa o navegador que ele mesmo
    // instalou. `PLAYWRIGHT_BROWSERS_PATH` aponta a pasta quando ela já existe,
    // e é assim que o ambiente daqui e o da esteira usam o mesmo código.
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  let problemas = 0;

  for (const tela of telas) {
    const resultados = [];

    for (const largura of LARGURAS) {
      const ctx = await browser.newContext({ viewport: { width: largura, height: 900 } });
      await ctx.route('https://images.unsplash.com/**', async (route) => {
        const bytes = await baixarFoto(route.request().url());
        if (!bytes) return route.abort();
        await route.fulfill({ contentType: 'image/jpeg', body: bytes });
      });
      if (tela.cookie) {
        await ctx.addCookies([
          { name: tela.cookie.nome, value: tela.cookie.valor, domain: '127.0.0.1', path: tela.cookie.caminho },
        ]);
      }
      const page = await ctx.newPage();
      try {
        await page.goto(`${WEB}${tela.url}`, { waitUntil: 'networkidle' });
      } catch (erro) {
        // Uma tela que nem abre é uma linha do relatório, não o fim dele: parar
        // aqui esconderia o estado das outras trinta e sete.
        console.log(`FALHA ${tela.nome.padEnd(20)} ${largura}px não abriu: ${erro.message.split('\n')[0]}`);
        problemas += 1;
        await ctx.close();
        continue;
      }

      /**
       * Uma tela que não carregou passa em qualquer largura.
       *
       * O estado de erro é uma caixa curta e centrada — nunca rola, nunca
       * estoura, nunca tem alvo pequeno. Sem esta conferência, esquecer de
       * migrar o banco da demonstração devolvia "ok" para trinta e cinco telas
       * que ninguém tinha visto. E o desvio para o login é o mesmo caso: mede-se
       * a tela de entrar quatro vezes achando que se mediu o painel.
       */
      const caminhoFinal = new URL(page.url()).pathname;
      const esperado = new URL(tela.url, WEB).pathname;
      const carregou = await page.evaluate(
        () => !document.body.textContent?.includes('Não deu para carregar'),
      );
      if (caminhoFinal !== esperado || !carregou) {
        console.log(
          `FALHA ${tela.nome.padEnd(20)} ${largura}px `
          + (caminhoFinal !== esperado ? `desviou para ${caminhoFinal}` : 'não carregou'),
        );
        problemas += 1;
        await ctx.close();
        continue;
      }

      // Conteúdo dobrado é conteúdo. As telas de cadastro guardam os
      // formulários atrás de `<details>` — inclusive a tabela da jornada, que é
      // a coisa mais larga do painel. Medir só o que está aberto seria aprovar
      // a tela pelo que ela esconde.
      await page.evaluate(() => {
        for (const dobra of document.querySelectorAll('details')) dobra.open = true;
      });

      const medida = await page.evaluate(() => {
        const limite = document.documentElement.clientWidth;
        const rola = document.documentElement.scrollWidth > limite;

        const estouram = [];
        for (const el of document.querySelectorAll('body *')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;

          // Conteúdo largo pode passar, desde que fique **contido** por um
          // ancestral e não leve a página junto.
          //
          // `auto` é o caso do `.ui-scroll-x`, em que a pessoa rola a tabela com
          // o dedo. `hidden` e `clip` são o caso do enfeite: a faixa que corre é
          // `max-content` por definição, e a janela do produto sangra de
          // propósito para fora do container. Os três impedem a página de rolar,
          // que é o que a regra proíbe — e a rolagem da página continua sendo
          // conferida em separado, logo acima.
          let pai = el.parentElement;
          let contido = false;
          while (pai) {
            const overflow = getComputedStyle(pai).overflowX;
            if (overflow === 'auto' || overflow === 'hidden' || overflow === 'clip') {
              contido = true;
              break;
            }
            pai = pai.parentElement;
          }
          if (contido) continue;

          if (r.right > limite + 1 || r.left < -1) {
            estouram.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`);
          }
        }

        // Alvo de toque: vale para qualquer aparelho — mouse impreciso e
        // acessibilidade motora não são exclusividade do celular.
        //
        // Link **dentro de frase** é exceção, e não por conveniência: forçar
        // 44px num link no meio de um parágrafo abre buracos no texto e é o que
        // a própria WCAG 2.5.8 isenta. Link de navegação sozinho não é isso e
        // não é isento.
        const pequenos = [];
        for (const el of document.querySelectorAll('a[href], button, input, select, textarea')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.height < 44) {
            // Caixa e rádio dentro de um `<label>`: o alvo é o rótulo inteiro,
            // porque clicar em qualquer parte dele aciona o controle — que é
            // exatamente o que a WCAG 2.5.8 mede. Medir a caixinha de 13px
            // reprovava um padrão correto, e o padrão já existia no onboarding
            // desde o bloco 10 sem nunca ter sido medido: a régua de etapas
            // abre no passo publicado, e as caixas ficam nos passos 2 e 4.
            const tipo = el.getAttribute('type');
            if (el.tagName === 'INPUT' && (tipo === 'checkbox' || tipo === 'radio')) {
              const rotulo = el.closest('label');
              if (rotulo && rotulo.getBoundingClientRect().height >= 44) continue;
            }
            const dentroDeTexto = el.tagName === 'A' && el.parentElement
              && ['P', 'SPAN', 'LI', 'TD'].includes(el.parentElement.tagName)
              && (el.parentElement.textContent ?? '').trim() !== (el.textContent ?? '').trim();
            if (dentroDeTexto) continue;
            pequenos.push(
              `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0] || '(sem classe)'}`
              + ` "${(el.textContent ?? '').trim().slice(0, 24)}" ${Math.round(r.height)}px`,
            );
          }
        }

        return { rola, estouram: [...new Set(estouram)].slice(0, 4), pequenos: [...new Set(pequenos)].slice(0, 4) };
      });

      resultados.push({ largura, ...medida });
      await ctx.close();
    }

    const ruins = resultados.filter((r) => r.rola || r.estouram.length > 0 || r.pequenos.length > 0);
    problemas += ruins.length;

    // Largura que nem chegou a ser medida não conta como aprovada: sem isto,
    // uma tela que falhou nas quatro ainda terminava com um "ok" embaixo.
    const marca = ruins.length === 0 && resultados.length === LARGURAS.length ? 'ok ' : 'FALHA';
    const medidas = resultados.map((r) => r.largura);
    console.log(`${marca} ${tela.nome.padEnd(20)} ${(medidas.length ? medidas : ['nenhuma largura medida']).join(' · ')}`);
    for (const r of ruins) {
      if (r.rola) console.log(`      ${r.largura}px rolagem horizontal na página`);
      if (r.estouram.length) console.log(`      ${r.largura}px estoura: ${r.estouram.join(', ')}`);
      if (r.pequenos.length) console.log(`      ${r.largura}px alvo < 44px: ${r.pequenos.join(', ')}`);
    }
  }

  await browser.close();
  console.log(problemas === 0 ? '\ntodas as telas passam nas quatro larguras' : `\n${problemas} medições com problema`);
  process.exit(problemas === 0 ? 0 : 1);
}

main().catch((erro) => {
  console.error(erro);
  process.exit(1);
});
