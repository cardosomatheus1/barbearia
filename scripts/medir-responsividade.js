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
/**
 * Uma tentativa a mais quando o socket ocioso morre.
 *
 * A semeadura faz dezenas de requisições intercaladas com `psql`, e um trecho de
 * banco mais lento deixa a conexão do pool parada. O `keepAliveTimeout` padrão
 * do servidor Node é de 5s: passado isso ele fecha, o `fetch` reaproveita o
 * socket morto e a medição inteira morre com `UND_ERR_SOCKET · other side
 * closed` — duas execuções perdidas, as duas no mesmo ponto, sempre logo depois
 * de uma etapa longa.
 *
 * Repetir é seguro **aqui**, e a razão é o que a torna aceitável: o erro é a
 * conexão fechada antes de a resposta chegar, o banco é descartável e nasce
 * vazio a cada execução, e nada nesta semeadura move dinheiro de verdade. Numa
 * rota de produção a resposta certa seria outra — desfecho ambíguo conta como
 * "saiu", que é a regra do repasse do bloco 50.
 */
const fetchDireto = globalThis.fetch;
globalThis.fetch = async (...args) => {
  try {
    return await fetchDireto(...args);
  } catch (erro) {
    if (erro?.cause?.code !== 'UND_ERR_SOCKET') throw erro;
    return fetchDireto(...args);
  }
};

const { execFileSync } = require('node:child_process');
const { mkdirSync } = require('node:fs');

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
const primeiraLinha = (saida) => saida.split('\n')[0].trim();

/** Pasta dos prints, se alguém pediu. Vazio é o padrão: medir não é fotografar. */
const PRINTS = process.env.MEDICAO_PRINTS ?? '';
if (PRINTS) mkdirSync(PRINTS, { recursive: true });

/**
 * Prepara a conta da plataforma e uma barbearia bloqueada.
 *
 * A conta nasce pelo mesmo comando que a produção usa — não há rota HTTP para
 * criá-la, de propósito. E uma das barbearias entra bloqueada porque o cartão
 * bloqueado é o mais largo da lista: ele tem o selo, o motivo e a data, e é
 * onde a linha estoura em 360px se estourar.
 */
async function prepararPlataforma() {
  // Do ambiente, porque `percorrer.mjs` entra com esta conta e o e-mail da
  // plataforma é guardado como HMAC — não há como lê-lo do banco depois.
  const email = process.env.MEDICAO_PLATAFORMA_EMAIL ?? `super${Date.now()}@plataforma.teste`;
  const senha = process.env.MEDICAO_PLATAFORMA_SENHA ?? 'senha-da-plataforma-medida';

  try {
    // `--operador`: sem ele a conta nasce `viewer`, e toda ação sobre uma
    // barbearia responde 403. O bloqueio abaixo vinha falhando em silêncio
    // desde o bloco 35, e o cartão "bloqueada" que esta função diz preparar
    // nunca chegou a existir — o percurso da medição foi quem descobriu.
    execFileSync('node', ['scripts/criar-super-admin.mjs', 'Super', email, '--operador'], {
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
  // `primeiraLinha`, porque `-tAc` com `RETURNING` devolve a linha **e** a
  // etiqueta do comando ("INSERT 0 1"). Sem ela o id saía com o rótulo colado,
  // a rota respondia 400, e o bloqueio nunca acontecia — em silêncio.
  const alvo = primeiraLinha(
    psql(`INSERT INTO tenants (name) VALUES ('Barbearia com nome bem comprido de teste') RETURNING id`),
  );
  // Conferida, e não disparada e esquecida: uma semente que não checa a
  // resposta prepara o estado que ela **acha** que preparou.
  const bloqueio = await fetch(`${API}/v1/plataforma/barbearias/${alvo}/bloqueio`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ motivo: 'inadimplente há 60 dias, sem retorno no telefone do cadastro' }),
  });
  if (!bloqueio.ok) {
    throw new Error(`bloqueio da semente recusado (${bloqueio.status}) — o cartão bloqueado não existe`);
  }

  // Métricas com a tabela cheia. Medir a tela vazia mediria o estado vazio —
  // que também precisa passar, mas não é onde oito colunas estouram os 360px.
  // Nome comprido e receita de sete dígitos de propósito: são eles que quebram
  // layout, e só aparecem com conteúdo de verdade.
  const ontem = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  psql(
    `INSERT INTO tenant_metrics_daily (tenant_id, business_day, appointments_total,` +
      ` appointments_online, no_shows, minutes_sold, minutes_available, revenue_cents,` +
      ` revenue_pix_cents, revenue_card_cents, revenue_cash_cents, revenue_other_cents)` +
      ` SELECT tenant_id, '${ontem}'::date, 412, 268, 31, 18400, 26400, 1284900,` +
      // A quebra por meio (bloco 29) não fecha com a receita de propósito: o
      // resto é fiado, que é venda registrada e não dinheiro recebido.
      ` 604300, 431200, 187400, 41800` +
      ` FROM tenant_platform ON CONFLICT DO NOTHING`,
  );

  /**
   * Faturas em aberto, porque a fila de cobrança vazia não mede nada.
   *
   * Uma vencida e uma a vencer: o cartão da vencida carrega o selo de prazo
   * crítico, o número de tentativas e os dois formulários lado a lado — é o mais
   * largo da tela, e é onde a linha estoura em 360px se estourar. Valor de
   * quatro dígitos e nome comprido pelo mesmo motivo de sempre.
   */
  psql(
    `INSERT INTO invoices (tenant_id, plan_code, amount_cents, period_start, period_end, due_at,` +
      ` attempts, past_due_at)` +
      ` SELECT tenant_id, 'business', 24900, now() - interval '20 days',` +
      ` now() + interval '10 days', now() - interval '15 days', 3, now() - interval '15 days'` +
      ` FROM tenant_platform ON CONFLICT DO NOTHING`,
  );
  psql(
    `INSERT INTO invoices (tenant_id, kind, plan_code, amount_cents, period_start, period_end,` +
      ` due_at) SELECT tenant_id, 'proration', 'pro', 7450, now(), now() + interval '30 days',` +
      ` now() + interval '4 days' FROM tenant_platform`,
  );

  /**
   * Doze meses de fatura paga, para a linha do tempo da plataforma (bloco 62).
   *
   * Sem elas o MRR mês a mês e o triângulo de safra desenham o estado vazio —
   * que é honesto e não é o que precisa ser fotografado. A barra de um mês só
   * também não mede nada: o que estoura layout é a fileira de doze com valor de
   * cinco dígitos embaixo.
   *
   * A safra é a do **primeiro mês pago**, então uma barbearia que começa doze
   * meses atrás e outra que começa há três produzem duas linhas de comprimento
   * diferente — que é exatamente o triângulo que a tela existe para mostrar.
   */
  psql(
    `INSERT INTO invoices (tenant_id, kind, status, plan_code, amount_cents,` +
      ` period_start, period_end, due_at, paid_at)` +
      ` SELECT tenant_id, 'subscription', 'paid', 'essencial',` +
      ` 9900 + (m * 700),` +
      ` date_trunc('month', now()) - (m * interval '1 month'),` +
      ` date_trunc('month', now()) - ((m - 1) * interval '1 month'),` +
      ` date_trunc('month', now()) - (m * interval '1 month') + interval '5 days',` +
      ` date_trunc('month', now()) - (m * interval '1 month') + interval '5 days'` +
      ` FROM tenant_platform, generate_series(0, 11) AS m` +
      ` ON CONFLICT DO NOTHING`,
  );

  // O cartão na conta (bloco 29): a tela do plano tem dois estados, e o
  // preenchido é o que tem marca, final e validade na mesma linha.
  psql(
    `INSERT INTO billing_customers (tenant_id, psp_customer_id, psp_method_id, brand, last4,` +
      ` exp_month, exp_year) SELECT tenant_id, 'cus_medicao', 'pm_medicao', 'mastercard',` +
      ` '4242', 11, 2029 FROM tenant_platform ON CONFLICT DO NOTHING`,
  );

  /**
   * E uma conta de **consulta**, que é como toda conta de plataforma nasce.
   *
   * O painel desenhava Bloquear, Reativar e Entrar na conta para o `viewer`, que
   * a guarda recusa com 403 — e a tela traduzia isso como "não deu para
   * concluir, tente de novo". Sem este segundo login, a tela que o bloco 113
   * mudou não seria fotografada em largura nenhuma: a conta da medição é
   * operadora, e para ela nada mudou.
   */
  const emailViewer = `consulta${Date.now()}@plataforma.teste`;
  let tokenViewer = null;
  try {
    execFileSync('node', ['scripts/criar-super-admin.mjs', 'Consulta', emailViewer], {
      env: {
        ...process.env,
        SUPER_ADMIN_PASSWORD: senha,
        DATABASE_URL: process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL,
      },
      stdio: 'pipe',
    });
    const entradaViewer = await fetch(`${API}/v1/plataforma/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: emailViewer, senha }),
    });
    if (entradaViewer.ok) tokenViewer = (await entradaViewer.json()).token;
  } catch (erro) {
    console.warn(`  aviso: conta de consulta não criada (${erro.message.split('\n')[0]})`);
  }

  return { token, tokenViewer };
}

/** Prepara uma barbearia publicada e uma sessão de gestor. */
async function preparar() {
  const conta = {
    name: 'Medida',
    email: `medida${Date.now()}@teste.com`,
    password: process.env.MEDICAO_SENHA ?? 'senha-bem-comprida',
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

  // Endereço com coordenada: sem latitude e longitude a barbearia não entra na
  // vitrine do marketplace (bloco 70), e a busca seria fotografada vazia.
  await put(
    '/v1/admin/business',
    {
      name: conta.businessName,
      street: 'Rua da Paciência, 240',
      district: 'Rio Vermelho',
      city: 'Salvador',
      state: 'BA',
      latitude: -12.9899,
      longitude: -38.4767,
      timezone: 'America/Bahia',
      amenities: ['wifi', 'parking', 'accessible'],
    },
    t,
  );
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
/**
 * Os passos 3 e 4 do agendamento público, num horário **de preço diferente**.
 *
 * A medição fotografava `/agendar` e parava no passo 1 — o cardápio. Os dois
 * passos onde o cliente decide, e onde o bloco 105 mexeu (o preço no chip da
 * grade e o total na confirmação), nunca tinham sido olhados em largura
 * nenhuma. Foi ali que a tela dizia R$ 45,00 sobre um agendamento de R$ 54,00.
 *
 * A escolha do horário não é qualquer uma: é a primeira cujo preço difere do
 * catálogo. Um horário sem faixa não desenha o chip nem o parágrafo da
 * diferença, e a medição diria "ok" sobre a tela **antes** da mudança — é a
 * regra da semente que precisa produzir o estado que o bloco criou.
 *
 * Devolve `null` quando não há faixa em catorze dias: a medição segue sem os
 * dois passos e avisa, em vez de parar tudo.
 */
async function prepararAgendamentoPublico(slug) {
  // O perfil público é a raiz de `/v1/b/:slug` — não há `/profile`, e pedi-lo
  // devolvia 404 e um `null` silencioso que tirava as duas telas da medição.
  const perfil = await (await fetch(`${API}/v1/b/${slug}`)).json();
  const servico = perfil?.categories?.flatMap((c) => c.services ?? [])?.[0];
  const local = perfil?.location;
  /**
   * Perfil que não responde é **defeito**, não "não tem faixa hoje".
   *
   * A primeira versão pedia `/v1/b/:slug/profile`, que não existe: o 404 virava
   * `null`, o `null` virava um aviso de uma linha, e as duas telas sumiam da
   * medição sem nada ficar vermelho. Distinguir os dois casos é o que separa
   * "o cenário não aconteceu" de "a preparação está quebrada".
   */
  if (!servico || !local) {
    throw new Error(`o perfil público de ${slug} não respondeu com serviço e unidade`);
  }

  const hoje = new Date();
  const ate = new Date(hoje);
  ate.setUTCDate(ate.getUTCDate() + 13);
  const de = hoje.toISOString().slice(0, 10);

  const grade = await (
    await fetch(
      `${API}/v1/b/${slug}/availability?locationId=${local.id}`
        + `&serviceIds=${servico.id}&dateFrom=${de}&dateTo=${ate.toISOString().slice(0, 10)}`
        + '&anyProfessional=true',
    )
  ).json();

  for (const dia of grade?.days ?? []) {
    // Hoje não: o horário encostado na antecedência mínima some entre listar e
    // abrir, e a tela medida seria a de erro.
    if (dia.date === de) continue;
    const achado = (dia.slots ?? []).find(
      (s) => s.priceCents !== null && s.priceCents !== servico.priceCents,
    );
    if (achado) {
      return {
        servicoId: servico.id,
        profissionalId: achado.professionalId,
        dia: dia.date,
        hora: achado.start,
      };
    }
  }
  return null;
}

async function prepararBalcao(token) {
  const cabecalho = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const catalogo = await (await fetch(`${API}/v1/admin/catalog`, { headers: cabecalho })).json();
  const hoje = await (await fetch(`${API}/v1/admin/day`, { headers: cabecalho })).json();

  const servico = catalogo.services.reduce((maior, s) => (s.name.length > maior.name.length ? s : maior));
  /**
   * Quatro pessoas, quatro estados — e é o número mínimo, não folga.
   *
   * O painel do dia desenha um cartão diferente por estado, e o mais largo é o
   * de quem está na cadeira: ação primária, "Cobrar" e as pesadas na mesma
   * linha. Com só duas pessoas em `pending`/`checked_in`, a medição dizia
   * "todas as telas passam" sem que o cartão mais apertado da tela mais usada
   * do produto tivesse chegado a existir.
   */
  const pessoas = [
    { name: 'Maria Aparecida do Nascimento', phone: '(71) 98111-2233' },
    { name: 'Zé', phone: '(71) 98111-2244' },
    { name: 'João Pedro de Albuquerque Filho', phone: '(71) 98111-2255' },
    { name: 'Antônio Carlos', phone: '(71) 98111-2266' },
  ];

  /** O caminho até cada estado, na ordem que a máquina de estados exige. */
  const ATE_O_ESTADO = [
    ['check_in'],
    [],
    ['check_in', 'start'],
    ['check_in', 'start', 'complete'],
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

    // As linhas têm alturas diferentes por estado — "esperando há X min", "na
    // cadeira há X min", o relógio da falta —, e é a mistura que estoura
    // layout. Em ordem, porque a máquina de estados recusa pular etapa.
    for (const acao of criado.id ? (ATE_O_ESTADO[i] ?? []) : []) {
      await fetch(`${API}/v1/admin/appointments/${criado.id}/attendance`, {
        method: 'POST',
        headers: cabecalho,
        body: JSON.stringify({ action: acao }),
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

  /**
   * Conferir que os estados de fato pegaram, e parar se não pegaram.
   *
   * Sem isto, uma transição recusada — a máquina de estados muda, a rota muda,
   * a antecedência mínima passa a valer — deixaria a medição rodando sobre
   * quatro cartões `pending` e imprimindo "todas as telas passam". Medição que
   * mede a tela errada em silêncio é pior que medição nenhuma, porque tem cara
   * de prova.
   */
  const doDia = await (
    await fetch(`${API}/v1/admin/day?date=${dataLivre}`, { headers: cabecalho })
  ).json();
  const estados = new Set((doDia.entries ?? []).map((e) => e.status));
  for (const exigido of ['pending', 'checked_in', 'in_progress', 'completed']) {
    if (!estados.has(exigido)) {
      throw new Error(
        `painel do dia sem nenhuma linha em "${exigido}" — a medição estaria olhando outra tela. Estados presentes: ${[...estados].join(', ') || 'nenhum'}`,
      );
    }
  }

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
 * Planos do clube e um assinante (bloco 45).
 *
 * O que a medição precisa é do **estado**: um plano com nome longo, um benefício
 * ilimitado com intervalo — que é o que empilha texto no cartão — e um assinante,
 * para o bloco da ficha aparecer.
 */
async function prepararClube(slug, clienteDaFicha) {
  const tenant = psql(`select tenant_id from tenant_slugs where slug = '${slug}'`);
  if (!tenant) return;

  const servicos = psql(
    `select id from services where tenant_id = '${tenant}' and active order by price_cents desc limit 2`,
  ).split('\n').map((l) => l.trim()).filter(Boolean);
  if (servicos.length === 0) return;

  const plano = primeiraLinha(
    psql(
      `INSERT INTO club_plans (tenant_id, name, description, price_cents, product_discount_bps)
       VALUES ('${tenant}', 'Premium ilimitado com barba', 'Para quem corta toda semana',
               14900, 1000)
       RETURNING id`,
    ),
  );
  psql(
    `INSERT INTO club_plans (tenant_id, name, price_cents) VALUES ('${tenant}', 'Essencial', 8900)`,
  );

  if (plano) {
    psql(
      `INSERT INTO club_plan_benefits (plan_id, service_id, tenant_id, quantity, cooldown_days)
       VALUES ('${plano}', '${servicos[0]}', '${tenant}', NULL, 7)`,
    );
    if (servicos[1]) {
      psql(
        `INSERT INTO club_plan_benefits (plan_id, service_id, tenant_id, quantity, cooldown_days)
         VALUES ('${plano}', '${servicos[1]}', '${tenant}', 2, 0)`,
      );
    }
  }

  if (plano && clienteDaFicha) {
    const assinatura = primeiraLinha(
      psql(
        `INSERT INTO club_subscriptions (tenant_id, customer_id, plan_id, price_cents, status, started_at)
         VALUES ('${tenant}', '${clienteDaFicha}', '${plano}', 14900, 'ativa', now() - interval '40 days')
         ON CONFLICT DO NOTHING
         RETURNING id`,
      ),
    );

    // Bloqueio de sábado de manhã e um dependente (bloco 46): são os dois que
    // empilham texto no cartão do plano e na ficha.
    psql(
      `INSERT INTO club_plan_blackouts (tenant_id, plan_id, weekday, start_minute, end_minute)
       VALUES ('${tenant}', '${plano}', 6, 540, 780)`,
    );
    psql(`UPDATE club_plans SET booking_window_days = 60 WHERE id = '${plano}'`);

    const outro = primeiraLinha(
      psql(
        `select id from customers where tenant_id = '${tenant}'
           and id <> '${clienteDaFicha}' limit 1`,
      ),
    );
    if (assinatura && outro) {
      psql(
        `INSERT INTO club_dependents (subscription_id, customer_id, tenant_id)
         VALUES ('${assinatura}', '${outro}', '${tenant}') ON CONFLICT DO NOTHING`,
      );
    }

    /**
     * As mensalidades (bloco 47).
     *
     * Três estados, porque são três larguras de texto diferentes no cartão: uma
     * em atraso com tentativa de cartão registrada — que é a linha mais alta, e
     * a única que o balcão precisa ler rápido —, uma paga e uma cancelada com
     * anotação, para o histórico não ficar vazio.
     */
    if (assinatura) {
      psql(
        `INSERT INTO club_invoices (tenant_id, subscription_id, period_start, period_end,
                                    amount_cents, due_at, attempts, last_error,
                                    marked_delinquent_at)
         VALUES ('${tenant}', '${assinatura}', date_trunc('day', now() - interval '9 days'),
                 date_trunc('day', now() + interval '21 days'), 14900,
                 date_trunc('day', now() - interval '9 days'), 2,
                 'cartão sem limite disponível', now() - interval '8 days')`,
      );
      /*
        O estado da assinatura acompanha, porque é o que a régua faz na mesma
        transação. Sem isto o quadro de cima diz "0 em atraso" enquanto a lista
        logo abaixo mostra um — duas telas mostrando o mesmo fato e discordando,
        que é a sexta pergunta do §6 do CLAUDE.md.
      */
      psql(`UPDATE club_subscriptions SET status = 'inadimplente' WHERE id = '${assinatura}'`);
      psql(
        `INSERT INTO club_invoices (tenant_id, subscription_id, period_start, period_end,
                                    amount_cents, due_at, status, paid_at, paid_method)
         VALUES ('${tenant}', '${assinatura}', date_trunc('day', now() - interval '39 days'),
                 date_trunc('day', now() - interval '9 days'), 14900,
                 date_trunc('day', now() - interval '39 days'), 'paga',
                 now() - interval '38 days', 'pix')`,
      );
      psql(
        `INSERT INTO club_invoices (tenant_id, subscription_id, period_start, period_end,
                                    amount_cents, due_at, status, void_reason)
         VALUES ('${tenant}', '${assinatura}', date_trunc('day', now() - interval '69 days'),
                 date_trunc('day', now() - interval '39 days'), 14900,
                 date_trunc('day', now() - interval '69 days'), 'cancelada',
                 'primeiro mês de cortesia combinado na adesão')`,
      );
    }
  }
}

/**
 * A assinatura de **quem tem sessão** no navegador (bloco 47).
 *
 * Separada de `prepararClube`, que assina o cliente da ficha do admin: são duas
 * pessoas diferentes, e "uma assinatura viva por cliente" impede reaproveitar a
 * mesma. Sem esta, a tela do cliente mede o estado sem plano — que também
 * importa, mas não é o que este bloco entregou.
 */
function prepararPlanoDoCliente(slug, telefone) {
  const tenant = psql(`select tenant_id from tenant_slugs where slug = '${slug}'`);
  if (!tenant) return;

  const cliente = primeiraLinha(
    psql(
      `select id from customers where tenant_id = '${tenant}'
         and phone_e164 = '${telefone}' limit 1`,
    ),
  );
  const plano = primeiraLinha(
    psql(`select id from club_plans where tenant_id = '${tenant}' and name = 'Essencial' limit 1`),
  );
  if (!cliente || !plano) return;

  const servico = primeiraLinha(
    psql(
      `select id from services where tenant_id = '${tenant}' and active
        order by price_cents desc limit 1`,
    ),
  );
  if (servico) {
    psql(
      `INSERT INTO club_plan_benefits (plan_id, service_id, tenant_id, quantity, cooldown_days)
       VALUES ('${plano}', '${servico}', '${tenant}', 2, 7) ON CONFLICT DO NOTHING`,
    );
  }

  const assinatura = primeiraLinha(
    psql(
      `INSERT INTO club_subscriptions (tenant_id, customer_id, plan_id, price_cents, status,
                                       started_at)
       VALUES ('${tenant}', '${cliente}', '${plano}', 8900, 'ativa',
               now() - interval '70 days')
       ON CONFLICT DO NOTHING RETURNING id`,
    ),
  );
  if (!assinatura) return;

  /*
    Assinatura em atraso, como a régua a deixaria: a fatura de dez dias atrás
    ainda aberta **e** o estado `inadimplente`. Os dois juntos porque a régua os
    grava na mesma transação — e porque o quadro do topo conta estado enquanto a
    lista lê vencimento: deixá-los discordando no ensaio faria a tela mentir
    sobre si mesma (§6 do CLAUDE.md, sexta pergunta).
  */
  psql(`UPDATE club_subscriptions SET status = 'inadimplente' WHERE id = '${assinatura}'`);

  /*
    Um plano usado de verdade, para a simulação dos três modelos ter o que
    comparar (bloco 48). Quatro cortes num mês de mensalidade de R$ 89 é
    exatamente o caso que a SPEC §3.4 chama de "o que mais gera conflito": por
    uso custa mais que a mensalidade, e o dono precisa ver isso na tela.

    Pelo banco e não pela comanda: o que a medição precisa é do **estado**, e
    fechar quatro comandas aqui custaria meia dúzia de idas à API por um número
    que já se sabe.
  */
  /*
    A regra de comissão da casa, criada aqui se ainda não existir: sem ela não
    há lançamento, e a simulação mede o estado vazio em vez do estado que este
    bloco entregou.
  */
  psql(
    `INSERT INTO commission_rules (tenant_id, mode, value)
     SELECT '${tenant}', 'percent', 4000
      WHERE NOT EXISTS (SELECT 1 FROM commission_rules WHERE tenant_id = '${tenant}')`,
  );
  const regra = primeiraLinha(
    psql(
      `select id from commission_rules where tenant_id = '${tenant}' limit 1`,
    ),
  );
  const barbeiro = primeiraLinha(
    psql(`select id from professionals where tenant_id = '${tenant}' limit 1`),
  );
  if (regra && barbeiro && servico) {
    for (let i = 0; i < 4; i += 1) {
      psql(
        `INSERT INTO club_uses (tenant_id, subscription_id, customer_id, service_id,
                                value_cents, business_day, used_at)
         VALUES ('${tenant}', '${assinatura}', '${cliente}', '${servico}', 6000,
                 date_trunc('day', now() - interval '${i} days'),
                 now() - interval '${i} days')`,
      );
      psql(
        `INSERT INTO commission_entries
           (tenant_id, professional_id, earned_on, rule_id, mode, value, base_cents, sign,
            club_subscription_id, subscription_fee_cents)
         VALUES ('${tenant}', '${barbeiro}',
                 date_trunc('day', now() - interval '${i} days')::date,
                 '${regra}', 'percent', 4000, 6000, 1, '${assinatura}', 8900)`,
      );
    }
  }

  // Duas pagas e uma em aberto: é o extrato que a pessoa abre para conferir se
  // aquele desconto no cartão era o plano.
  for (const [meses, estado] of [[70, 'paga'], [40, 'paga'], [10, 'aberta']]) {
    const pago = estado === 'paga';
    psql(
      `INSERT INTO club_invoices (tenant_id, subscription_id, period_start, period_end,
                                  amount_cents, due_at, status, paid_at, paid_method)
       VALUES ('${tenant}', '${assinatura}',
               date_trunc('day', now() - interval '${meses} days'),
               date_trunc('day', now() - interval '${meses - 30} days'), 8900,
               date_trunc('day', now() - interval '${meses} days'),
               '${estado}',
               ${pago ? `now() - interval '${meses - 1} days'` : 'NULL'},
               ${pago ? "'pix'" : 'NULL'})`,
    );
  }
}

/**
 * Produtos, movimentos e ficha de consumo (bloco 44).
 *
 * Pelo banco, como os outros: o que a medição precisa é do **estado** — nome
 * longo de verdade, um produto abaixo do mínimo, um vencendo e um esgotado, que
 * são os três selos que empilham no cartão.
 */
async function prepararEstoque(slug) {
  const tenant = psql(`select tenant_id from tenant_slugs where slug = '${slug}'`);
  if (!tenant) return;

  const cadastro = [
    ['Pomada modeladora efeito matte 120g', 'resale', 1200, 3500, 5, 'un', null, 2],
    ['Shampoo profissional antirresíduo', 'internal', 45, null, 200, 'ml', null, 1000],
    ['Lâmina de barbear descartável', 'internal', 140, null, 20, 'un', "current_date + 20", 8],
    ['Óleo pré-barba', 'internal', 20, null, 100, 'ml', null, 0],
  ];

  for (const [nome, tipo, custo, preco, minimo, unidade, vence, saldo] of cadastro) {
    const id = primeiraLinha(
      psql(
        `INSERT INTO products (tenant_id, name, kind, cost_cents, price_cents, min_stock, unit, expires_on)
         VALUES ('${tenant}', '${nome}', '${tipo}', ${custo}, ${preco === null ? 'NULL' : preco},
                 ${minimo}, '${unidade}', ${vence ?? 'NULL'})
         RETURNING id`,
      ),
    );
    if (!id || saldo <= 0) continue;
    psql(
      `INSERT INTO stock_movements (tenant_id, product_id, kind, quantity, unit_cost_cents, business_day)
       VALUES ('${tenant}', '${id}', 'entrada', ${saldo}, ${custo}, current_date)`,
    );
  }

  // Uma perda com motivo, que é a linha mais larga do extrato.
  const pomada = primeiraLinha(
    psql(`select id from products where tenant_id = '${tenant}' and kind = 'resale' limit 1`),
  );
  if (pomada) {
    psql(
      `INSERT INTO stock_movements
         (tenant_id, product_id, kind, quantity, unit_cost_cents, business_day, reason)
       VALUES ('${tenant}', '${pomada}', 'perda', -1, 1200, current_date,
               'Vidro quebrou na caixa da entrega de terca-feira')`,
    );
  }

  // A ficha de consumo do serviço mais caro.
  const servico = primeiraLinha(
    psql(`select id from services where tenant_id = '${tenant}' and active order by price_cents desc limit 1`),
  );
  const shampoo = primeiraLinha(
    psql(`select id from products where tenant_id = '${tenant}' and kind = 'internal' order by name limit 1`),
  );
  if (servico && shampoo) {
    psql(
      `INSERT INTO service_consumables (service_id, product_id, tenant_id, quantity)
       VALUES ('${servico}', '${shampoo}', '${tenant}', 15) ON CONFLICT DO NOTHING`,
    );
  }
}

/**
 * Avaliações, uma delas dentro da janela de recuperação (bloco 43).
 *
 * Pelo banco, como os recados: a nota nasce da página do cliente, e reproduzir
 * o fluxo aqui custaria mais que o que se mede. O que a medição precisa é do
 * **estado** — o cartão de alerta com prazo, comentário longo de verdade, e uma
 * avaliação já tratada, que é a que tem mais texto empilhado.
 */
async function prepararAvaliacoes(slug, clienteDaFicha) {
  const tenant = psql(`select tenant_id from tenant_slugs where slug = '${slug}'`);
  if (!tenant || !clienteDaFicha) return;

  /**
   * Qualquer atendimento da casa, e não só os da ficha.
   *
   * A primeira versão filtrava pelo cliente da ficha e achava **um**: a tela
   * ficava com o cartão de alerta e nada na lista, que é o estado mais fácil de
   * medir e o menos parecido com a barbearia de verdade.
   */
  const agendamentos = psql(
    `select id from appointments where tenant_id = '${tenant}' order by starts_at limit 5`,
  )
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (agendamentos.length === 0) return;



  // Texto longo de propósito: é o que estoura o cartão, e só aparece com
  // conteúdo verdadeiro.
  const notas = [
    [2, 'Esperei quarenta minutos mesmo com horario marcado e ninguem da recepcao veio falar comigo. O corte ficou bom mas sai com pressa e atrasado pro trabalho.', null],
    [5, 'Melhor degrade que ja fiz na vida, o Ruan caprichou demais e ainda me deu dica de produto.', null],
    [3, 'Corte ok mas a musica estava altissima e nao deu pra conversar.',
      'Liguei no dia seguinte, ele contou do volume. Baixamos e ele voltou na semana passada.'],
    // A quarta existe para o bloco de reputação da página pública aparecer: ele
    // só mostra a média a partir de três **publicadas**, e a nota 2 está
    // segurada pela janela de 48h.
    [5, 'Atendimento impecavel do comeco ao fim, marquei pelo site em dois minutos.', null],
    /**
     * A quinta entra com o bloco 80, e é a terceira **publicada**.
     *
     * Com quatro, contestar a terceira derrubava a média pública abaixo do
     * mínimo de exibição e o painel mostrava `—` — a tela ficava sem a única
     * coisa que este bloco existe para mostrar: as duas médias afastadas.
     */
    [4, 'Barba caprichada e a toalha quente no fim faz diferenca. Volto no mes que vem.', null],
  ];

  /**
   * Um atendimento concluído e **sem** avaliação para o cliente logado.
   *
   * Sem ele o formulário de dar nota não aparece na página do cliente — que é a
   * porta de entrada do bloco inteiro —, e a medição diria "passou" sobre uma
   * tela que nunca desenhou a coisa nova. O cliente da medição só tem horário
   * futuro, porque é assim que `prepararCliente` o cria.
   */
  const carlos = psql(
    `select id from customers where tenant_id = '${tenant}' and phone_e164 = '+5571988887777' limit 1`,
  );
  const cadeira = psql(`select id from professionals where tenant_id = '${tenant}' limit 1`);
  const servico = psql(`select id from services where tenant_id = '${tenant}' and active limit 1`);
  if (carlos && cadeira && servico) {
    const feito = primeiraLinha(
      psql(
        `INSERT INTO appointments
           (tenant_id, location_id, customer_id, professional_id,
            starts_at, ends_at, service_starts_at, service_ends_at, price_cents, status)
         SELECT '${tenant}', l.id, '${carlos}', '${cadeira}',
                now() - interval '3 days', now() - interval '3 days' + interval '30 minutes',
                now() - interval '3 days', now() - interval '3 days' + interval '30 minutes',
                5000, 'completed'
           FROM locations l WHERE l.tenant_id = '${tenant}' LIMIT 1
         RETURNING id`,
      ),
    );
    if (feito) {
      psql(
        `INSERT INTO appointment_services
           (appointment_id, service_id, tenant_id, position, price_cents, duration_minutes)
         VALUES ('${feito}', '${servico}', '${tenant}', 0, 5000, 30)`,
      );
    }
  }

  agendamentos.forEach((agendamento, i) => {
    const linha = notas[i];
    if (!linha) return;
    const [nota, texto, tratamento] = linha;
    const criada = i === 0 ? "now() - interval '6 hours'" : "now() - interval '20 days'";
    const resolucao = tratamento
      ? `now() - interval '19 days', 'contato', '${tratamento.replace(/'/g, "''")}'`
      : 'NULL, NULL, NULL';
    // Cliente e profissional saem do próprio agendamento: pendurá-los à mão
    // faria a avaliação apontar para quem não atendeu.
    psql(
      `INSERT INTO reviews
         (tenant_id, appointment_id, customer_id, professional_id, rating, comment,
          created_at, resolved_at, outcome, resolution_note)
       SELECT '${tenant}', a.id, a.customer_id, a.professional_id, ${nota},
              '${texto.replace(/'/g, "''")}', ${criada}, ${resolucao}
         FROM appointments a WHERE a.id = '${agendamento}'
       ON CONFLICT DO NOTHING`,
    );
  });

  /**
   * Uma delas nasce **contestada** (bloco 80).
   *
   * O estado precisa aparecer no print: é ele que carrega o motivo, a
   * justificativa e — o que mais importa — o botão de retirar. Sem semear, a
   * medição fotografaria só a entrada do estado, e a saída ficaria sem prova
   * visual justamente na tela em que a §6 pergunta 3 é decidida.
   */
  const contestada = agendamentos[2];
  if (contestada) {
    psql(
      `UPDATE reviews
          SET contested_at = now() - interval '2 days',
              contest_reason = 'nunca_foi_cliente',
              contest_note = 'Nao temos atendimento no nome dela, e o texto e o mesmo que apareceu em outras tres barbearias da rua'
        WHERE tenant_id = '${tenant}' AND appointment_id = '${contestada}'`,
    );
  }
}

/**
 * Pacotes no catálogo e um comprado pelo cliente (bloco 42).
 *
 * Pelo banco, como os recados: a venda nasce do fechamento de uma comanda, e
 * reproduzir o fluxo aqui custaria mais que o que se mede. O que a medição
 * precisa é do **estado** — nome longo de verdade, preço de quatro dígitos, e um
 * pacote parcialmente usado, que é o que faz a barra e a frase aparecerem.
 */
async function prepararPacotes(slug, clienteDaFicha) {
  const tenant = psql(`select tenant_id from tenant_slugs where slug = '${slug}'`);
  const servico = psql(
    `select id from services where tenant_id = '${tenant}' and active order by price_cents desc limit 1`,
  );
  // O mesmo cliente que a ficha desenha: um pacote pendurado em outra pessoa
  // deixaria o bloco novo fora da única tela em que ele aparece, e a medição
  // diria "passou" sobre um layout que ninguém viu.
  const cliente = clienteDaFicha;
  if (!tenant || !servico) return;

  // Nome longo e preço de quatro dígitos: são eles que quebram o cartão, e só
  // aparecem com conteúdo verdadeiro.
  // `primeiraLinha` porque o `psql` devolve o rótulo `INSERT 0 1` na segunda.
  const pacote = primeiraLinha(
    psql(
      `INSERT INTO packages (tenant_id, service_id, name, quantity, price_cents, validity_days)
       VALUES ('${tenant}', '${servico}', 'Combo fidelidade — 10 cortes com barba', 10, 129000, 365)
       RETURNING id`,
    ),
  );
  psql(
    `INSERT INTO packages (tenant_id, service_id, name, quantity, price_cents)
     VALUES ('${tenant}', '${servico}', '5 cortes', 5, 25000)`,
  );

  if (cliente && pacote) {
    const comprado = primeiraLinha(
      psql(
        `INSERT INTO customer_packages
           (tenant_id, customer_id, package_id, service_id, quantity, price_cents, unit_value_cents)
         VALUES ('${tenant}', '${cliente}', '${pacote}', '${servico}', 10, 129000, 12900)
         RETURNING id`,
      ),
    );
    // Parcialmente usado: cheio, a barra some e a frase perde o que ela tem de
    // mais difícil de acomodar.
    for (let i = 0; i < 8; i += 1) {
      psql(
        `INSERT INTO package_uses (tenant_id, customer_package_id, value_cents, business_day)
         VALUES ('${tenant}', '${comprado}', 12900, current_date - ${i})`,
      );
    }
  }
}

/**
 * Recados na fila e um programa de fidelidade ligado (blocos 40 e 41).
 *
 * Pelo banco: o recado nasce da página pública e o saldo nasce do fechamento de
 * comanda, e reproduzir os dois fluxos aqui custaria mais que o que se mede.
 * O que a medição precisa é do **estado** — a fila com os três tipos, texto
 * longo de verdade, e um saldo que faça o bloco aparecer.
 */
async function prepararRecadosEFidelidade(slug) {
  const tenant = psql(`select tenant_id from tenant_slugs where slug = '${slug}'`);
  const local = psql(`select id from locations where tenant_id = '${tenant}' limit 1`);
  const cliente = psql(
    `select id from customers where tenant_id = '${tenant}' and phone_e164 = '+5571988887777' limit 1`,
  );
  if (!tenant || !local) return;

  // Texto longo de propósito: é o que estoura o cartão, e só aparece com
  // conteúdo verdadeiro.
  const textos = [
    ['reclamacao', 'Esperei quarenta minutos mesmo tendo horario marcado, e ninguem da recepcao veio me avisar que o barbeiro estava atrasado. Sai sem cortar.'],
    ['sugestao', 'Voces deviam abrir aos domingos de manha, nem que fosse so com um barbeiro de plantao.'],
    ['elogio', 'O Ruan cortou muito bem, foi a melhor barba que ja fiz aqui.'],
  ];
  for (const [tipo, texto] of textos) {
    psql(
      `INSERT INTO feedbacks (tenant_id, location_id, customer_id, kind, body)
       VALUES ('${tenant}', '${local}', ${tipo === 'reclamacao' ? `'${cliente}'` : 'NULL'},
               '${tipo}', '${texto.replace(/'/g, "''")}')`,
    );
  }

  psql(
    `INSERT INTO loyalty_programs (tenant_id, mode, expires_days)
     VALUES ('${tenant}', 'pontos', 365)
     ON CONFLICT (tenant_id) DO UPDATE SET mode = 'pontos', expires_days = 365`,
  );
  if (cliente) {
    psql(
      `INSERT INTO loyalty_entries (tenant_id, customer_id, kind, mode, amount, note)
       VALUES ('${tenant}', '${cliente}', 'ajuste', 'pontos', 340, 'saldo para a medicao')`,
    );
  }
}

/**
 * Uma faixa de preço ligada, para medir a tela do bloco 68.
 *
 * Pelo banco: a tela é de cadastro, e reproduzir o formulário aqui mediria o
 * caminho e não o layout. O que a medição precisa é do **estado** — interruptor
 * ligado, uma faixa de desconto e outra de acréscimo, e uma delas exagerada, que
 * é a que desenha a linha "aparado no teto".
 */
/**
 * Consumo medido, para a previsão do bloco 69 aparecer no print.
 *
 * A previsão só existe com histórico: sem semear saídas, a tela de estoque
 * mostra o cadastro e nenhuma frase de prazo, e o print sairia sem a coisa que
 * o bloco entrega. Três semanas distintas de saída é o mínimo que forma ritmo.
 */
async function prepararConsumo(slug) {
  const tenant = psql(`select tenant_id from tenant_slugs where slug = '${slug}'`);
  const local = psql(`select id from locations where tenant_id = '${tenant}' limit 1`);
  const produto = psql(
    `select id from products where tenant_id = '${tenant}' and kind = 'resale' order by name limit 1`,
  );
  if (!tenant || !local || !produto) return;

  /**
   * A entrada vem antes, e com data anterior às saídas.
   *
   * O gatilho do bloco 44 recusa movimento que deixaria o saldo negativo — e
   * está certo. Semear as saídas sem repor primeiro derruba a medição inteira
   * com "estoque ficaria negativo", que foi o que aconteceu.
   */
  psql(
    `INSERT INTO stock_movements (tenant_id, location_id, product_id, kind, quantity, business_day, created_at)
     VALUES ('${tenant}', '${local}', '${produto}', 'entrada', 20, current_date - 60,
             now() - interval '60 days')`,
  );
  psql(
    `INSERT INTO stock_movements (tenant_id, location_id, product_id, kind, quantity, business_day, created_at)
     SELECT '${tenant}', '${local}', '${produto}', 'venda', -3,
            (now() - (semana || ' weeks')::interval)::date,
            now() - (semana || ' weeks')::interval
       FROM generate_series(1, 6) AS semana`,
  );
}

/**
 * Um cliente novo trazido pela busca (bloco 72).
 *
 * A tela de plano tem uma seção que só existe quando há linha, e ela é o
 * produto do bloco: *"a barbearia precisa poder abrir esta tela e ver, nome por
 * nome, que a plataforma só cobra por quem ela trouxe"*. Sem semente, o print
 * fotografa o estado vazio — que também é um estado que precisa passar, mas não
 * é o que o bloco entrega.
 *
 * A varredura não roda aqui: quem grava é o worker, e a medição não o levanta.
 * A linha é escrita direto, com os mesmos números que a varredura produziria.
 */
/**
 * Publica a página de um barbeiro (bloco 73).
 *
 * A tela só existe quando o perfil está ligado, e a medição precisa fotografar
 * a versão com conteúdo: nota, atendimentos e especialidades. Sem semente, o
 * print seria de um 404.
 */
/**
 * Fotos antes/depois com os dois aceites (bloco 74).
 *
 * A seção da ficha e o portfólio da página do barbeiro só existem com foto, e
 * a foto só existe com consentimento — semear os aceites é semear a regra, não
 * contorná-la: as linhas entram pelo mesmo gatilho que a aplicação enfrenta.
 */
function prepararFotos(slug, clienteDaFicha) {
  const tenant = psql(`select tenant_id from tenant_slugs where slug = '${slug}'`);
  if (!tenant) return;

  /**
   * O cliente é **o da ficha fotografada**, não o primeiro da base.
   *
   * A tela de fotos é a que este bloco entrega, e semear noutro cadastro faria
   * o print sair no estado vazio — que também precisa passar, mas não é o que
   * o bloco entrega.
   */
  const cliente =
    clienteDaFicha ??
    psql(`select id from customers where tenant_id = '${tenant}' order by created_at limit 1`);
  const pessoa = psql(
    `select id from professionals
      where tenant_id = '${tenant}' and kind = 'professional' and active
      order by name limit 1`,
  );
  if (!cliente || !pessoa) return;

  for (const finalidade of ['photos', 'photos_public']) {
    psql(
      `INSERT INTO customer_consents (customer_id, tenant_id, purpose, granted, text_version)
       VALUES ('${cliente}', '${tenant}', '${finalidade}', true, 'medicao-v1')`,
    );
  }

  // Fotos de corte, não de rosto: é o que um portfólio de barbearia mostra.
  const fotos = [
    [FOTOS.cortes[0], 'antes', 'Antes do fade'],
    [FOTOS.cortes[1] ?? FOTOS.cortes[0], 'depois', 'Fade médio com risco'],
    [FOTOS.cortes[2] ?? FOTOS.cortes[0], 'depois', 'Social com barba'],
  ];
  for (const [url, momento, legenda] of fotos) {
    psql(
      `INSERT INTO customer_photos
         (tenant_id, customer_id, professional_id, kind, url, caption, in_portfolio)
       VALUES ('${tenant}', '${cliente}', '${pessoa}', '${momento}', '${url}',
               '${legenda}', true)`,
    );
  }
}

/**
 * Um destaque pago vivo (bloco 75).
 *
 * O card patrocinado é o que este bloco entrega, e sem semente o print sairia
 * com a lista orgânica de sempre. A linha entra pelo mesmo caminho do produto:
 * um anúncio ativo na cidade da vitrine, dentro do período.
 */
function prepararDestaque(slug) {
  const tenant = psql(`select tenant_id from tenant_slugs where slug = '${slug}'`);
  if (!tenant) return;

  const local = psql(
    `select id from locations where tenant_id = '${tenant}' and city is not null limit 1`,
  );
  if (!local) return;

  psql(
    `INSERT INTO marketplace_ads
       (tenant_id, location_id, city, state, slot, starts_on, ends_on, price_cents)
     SELECT '${tenant}', l.id, l.city, l.state, 1,
            current_date - 1, current_date + 30, 27000
       FROM locations l WHERE l.id = '${local}'
     ON CONFLICT DO NOTHING`,
  );
}

/**
 * Uma franquia com padrão publicado e um item adotado (bloco 76).
 *
 * A barbearia da medição vira a **franqueadora**: assim a tela mostra as duas
 * metades — o formulário de publicar e a lista com o preço praticado ao lado do
 * de referência. Sem a adoção, a linha da distância nunca apareceria, e a tela
 * seria fotografada sem a única informação que ela existe para dar.
 */
/**
 * Duas chaves de API: uma viva e uma revogada (bloco 78).
 *
 * O `secret_hmac` é lixo de propósito — nenhuma delas autentica, e nem
 * precisa: o que a tela mostra é prefixo, escopo e data. O segredo não existe
 * em lugar nenhum depois da criação, e uma semente que o inventasse estaria
 * mentindo sobre o que o produto guarda.
 */
/**
 * Um endereço de webhook e três entregas: uma boa, uma na fila e uma que
 * desistiu (bloco 79).
 *
 * Sem elas a tabela de "últimos avisos" sai vazia, e a tela seria fotografada
 * sem a única informação que ela existe para dar — se está chegando ou não.
 */
function prepararWebhooks(slug) {
  const tenant = psql(`select tenant_id from tenant_slugs where slug = '${slug}'`);
  if (!tenant) return;
  if (psql(`select 1 from webhook_endpoints where tenant_id = '${tenant}' limit 1`)) return;

  const endpoint = psql(
    `INSERT INTO webhook_endpoints (tenant_id, name, url, secret_cipher, events)
     VALUES ('${tenant}', 'ERP do contador', 'https://erp.exemplo.com.br/barber-dock',
             'nao-e-segredo', ARRAY['appointment.created', 'order.paid']::webhook_event[])
     RETURNING id`,
  )?.split('\n')[0];
  if (!endpoint) return;

  psql(
    `INSERT INTO webhook_deliveries
       (tenant_id, endpoint_id, event, payload, status, attempts, delivered_at, response_status)
     VALUES ('${tenant}', '${endpoint}', 'appointment.created',
             '{"event":"appointment.created"}'::jsonb, 'entregue', 1, now(), 200)`,
  );
  psql(
    `INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event, payload, status, attempts)
     VALUES ('${tenant}', '${endpoint}', 'order.paid',
             '{"event":"order.paid"}'::jsonb, 'pendente', 0)`,
  );
  psql(
    `INSERT INTO webhook_deliveries
       (tenant_id, endpoint_id, event, payload, status, attempts, response_status)
     VALUES ('${tenant}', '${endpoint}', 'appointment.created',
             '{"event":"appointment.created"}'::jsonb, 'desistiu', 1, 404)`,
  );
}

function prepararChaves(slug) {
  const tenant = psql(`select tenant_id from tenant_slugs where slug = '${slug}'`);
  if (!tenant) return;
  if (psql(`select 1 from api_keys where tenant_id = '${tenant}' limit 1`)) return;

  psql(
    `INSERT INTO api_keys (tenant_id, name, prefix, secret_hmac, scopes, last_used_at)
     VALUES ('${tenant}', 'Integracao do site', 'a1b2c3d4e5f6', 'nao-e-segredo',
             ARRAY['appointments.view', 'appointments.create'], now() - interval '2 hours')`,
  );
  psql(
    `INSERT INTO api_keys (tenant_id, name, prefix, secret_hmac, scopes,
                           revoked_at, revoke_reason)
     VALUES ('${tenant}', 'ERP do contador', 'f6e5d4c3b2a1', 'nao-e-segredo',
             ARRAY['customers.view'], now() - interval '10 days',
             'contrato com o escritorio encerrado')`,
  );
}

function prepararFranquia(slug) {
  const tenant = psql(`select tenant_id from tenant_slugs where slug = '${slug}'`);
  if (!tenant) return;
  if (psql(`select 1 from franchise_tenants where tenant_id = '${tenant}'`)) return;

  // `psql -tAc` com `RETURNING` devolve a linha **e** a etiqueta do comando
  // ("INSERT 0 1"). Sem pegar a primeira linha, o id sai com o rótulo colado.
  const franquia = psql(
    `INSERT INTO franchises (name) VALUES ('Rede Barber Dock') RETURNING id`,
  )?.split('\n')[0];
  if (!franquia) return;

  psql(
    `INSERT INTO franchise_tenants (tenant_id, franchise_id, role)
     VALUES ('${tenant}', '${franquia}', 'franqueadora')`,
  );
  psql(
    `INSERT INTO role_permissions (tenant_id, role, permission)
     VALUES ('${tenant}', 'owner', 'franchise.manage') ON CONFLICT DO NOTHING`,
  );

  // Conteúdo real: nome longo e preço de quatro dígitos são o que quebra
  // layout, e só aparecem com conteúdo verdadeiro.
  const itens = [
    ['Corte social', 'Cabelo', 5500, 30],
    ['Barba modelada com toalha quente', 'Barba', 4500, 40],
    ['Coloração completa com hidratação', 'Química', 18900, 180],
  ];
  itens.forEach(([nome, categoria, preco, minutos], i) => {
    psql(
      `INSERT INTO franchise_services
         (franchise_id, name, category_name, reference_price_cents, duration_minutes, position)
       VALUES ('${franquia}', '${nome}', '${categoria}', ${preco}, ${minutos}, ${i})
       ON CONFLICT DO NOTHING`,
    );
  });

  /**
   * Duas franqueadas com faturamento e meta.
   *
   * Sem elas a tela da rede sai com quatro indicadores em `—` e uma tabela
   * vazia — e indicador que é sempre `—` é pior que indicador ausente. Os
   * números vêm de comandas pagas de verdade, com `business_day` no mês
   * corrente, que é a janela que a tela pergunta.
   */
  ['Dock Feira', 'Dock Norte'].forEach((nome, i) => {
    const filha = psql(
      `INSERT INTO tenants (name) VALUES ('${nome}') RETURNING id`,
    )?.split('\n')[0];
    if (!filha) return;
    const local = psql(
      `INSERT INTO locations (tenant_id, name, timezone)
       VALUES ('${filha}', 'Matriz', 'America/Bahia') RETURNING id`,
    )?.split('\n')[0];
    psql(
      `INSERT INTO franchise_tenants (tenant_id, franchise_id, role)
       VALUES ('${filha}', '${franquia}', 'franqueada')`,
    );
    const valor = 128_00 * (i + 3);
    psql(
      `INSERT INTO orders (tenant_id, location_id, status, subtotal_cents, total_cents,
                           business_day, opened_at, closed_at)
       VALUES ('${filha}', '${local}', 'paid', ${valor}, ${valor},
               date_trunc('month', current_date)::date + 2, now(), now())`,
    );
    psql(
      `INSERT INTO franchise_goals (franchise_id, tenant_id, month, revenue_cents)
       VALUES ('${franquia}', '${filha}', date_trunc('month', current_date)::date, ${valor * 2})
       ON CONFLICT DO NOTHING`,
    );
  });

  // Um adotado e com preço diferente: é a linha que mostra a distância.
  const primeiro = psql(
    `select id from franchise_services where franchise_id = '${franquia}' order by position limit 1`,
  );
  if (!primeiro) return;
  psql(
    `UPDATE services SET franchise_service_id = '${primeiro}', adopted_at = now(), price_cents = 4500
      WHERE id = (SELECT id FROM services WHERE tenant_id = '${tenant}' AND active
                   ORDER BY created_at LIMIT 1)`,
  );
}

function prepararPerfilDoBarbeiro(slug) {
  const tenant = psql(`select tenant_id from tenant_slugs where slug = '${slug}'`);
  if (!tenant) return null;

  const pessoa = psql(
    `select id from professionals
      where tenant_id = '${tenant}' and kind = 'professional' and active
      order by name limit 1`,
  );
  if (!pessoa) return null;

  psql(
    `UPDATE professionals
        SET public_profile = true,
            public_slug = COALESCE(public_slug, 'barbeiro-da-medicao'),
            specialties = ARRAY['fade', 'degrade', 'barba']
      WHERE id = '${pessoa}'`,
  );
  return 'barbeiro-da-medicao';
}

async function prepararMarketplace(slug) {
  const tenant = psql(`select tenant_id from tenant_slugs where slug = '${slug}'`);
  const local = psql(`select id from locations where tenant_id = '${tenant}' limit 1`);
  if (!tenant || !local) return;

  psql(`UPDATE tenant_platform SET marketplace_fee_bps = 2000 WHERE tenant_id = '${tenant}'`);

  const cliente = psql(
    `select id from customers where tenant_id = '${tenant}' order by created_at desc limit 1`,
  );
  const profissional = psql(`select id from professionals where tenant_id = '${tenant}' limit 1`);
  if (!cliente || !profissional) return;

  const agendamento = psql(
    `INSERT INTO appointments
       (tenant_id, location_id, customer_id, professional_id, status, source,
        starts_at, ends_at, service_starts_at, service_ends_at, price_cents)
     VALUES ('${tenant}', '${local}', '${cliente}', '${profissional}', 'completed', 'marketplace',
             -- Hora fixa e fora do expediente: com o relogio, a linha colide
             -- com o agendamento que outra semeadura ja criou para a mesma
             -- cadeira, e a constraint anti-overbooking recusa tudo.
             (current_date - 3) + time '06:15', (current_date - 3) + time '06:45',
             (current_date - 3) + time '06:15', (current_date - 3) + time '06:45',
             6500)
     RETURNING id`,
  ).split('\n')[0];
  // O `psql` imprime a etiqueta do comando ("INSERT 0 1") depois da linha do
  // `RETURNING`: sem a primeira linha, o id sai com o rótulo colado e o insert
  // seguinte recusa o uuid.
  if (!agendamento) return;

  psql(
    `INSERT INTO marketplace_attributions
       (tenant_id, customer_id, appointment_id, base_cents, fee_bps, fee_cents, attributed_at)
     VALUES ('${tenant}', '${cliente}', '${agendamento}', 6500, 2000, 1300,
             (current_date - 3) + time '06:15')
     ON CONFLICT DO NOTHING`,
  );
  psql(
    `UPDATE customers SET acquired_via = 'marketplace', acquired_at = now() - interval '3 days'
      WHERE id = '${cliente}' AND acquired_via IS NULL`,
  );
}

/**
 * Uma tarefa que desistiu, para a faixa de aviso ser fotografada (bloco 102).
 *
 * Sem ela, as telas de Automações e Campanhas são medidas no estado em que a
 * faixa **não** aparece — e o print sairia da tela anterior ao bloco, com a
 * medição dizendo "ok" sobre o que ninguém olhou. É a mesma regra do cadastro
 * do WhatsApp no bloco 88.
 *
 * No banco da medição, que é descartável, e **não** na semente de demonstração:
 * lá um alerta vermelho permanente faria o produto parecer quebrado em toda
 * apresentação, que é exatamente a confusão entre "o que está pronto" e "o que
 * está errado" que a semente já cobrou uma vez.
 *
 * `failed` com `finished_at` recente é o estado exato que a produção tinha e que
 * o aviso do bloco 101 não enxergava: nada pendente, a fila andando, e a
 * varredura da automação morrendo em toda volta havia quatro dias.
 */
/**
 * A carga do cookie da vaga, no formato exato que `daEspera` produz.
 *
 * Escrita à mão porque o estado nasce de um POST que a medição não faz — ela
 * abre telas, não opera o balcão. O formato é o que `lerVaga` confere, e há
 * teste unitário do outro lado: se as duas pontas divergirem, o aviso some do
 * print em vez de aparecer errado.
 */
function vagaDaMedicao() {
  const nomes = [
    { id: 'v1', nome: 'Maria Aparecida do Nascimento', fim4: '4821', de: '09:00', ate: '12:00' },
    { id: 'v2', nome: 'Ruan Carlos', fim4: '7130', de: '08:30', ate: '11:00' },
    { id: 'v3', nome: 'José Antônio da Silva Filho', fim4: null, de: '10:00', ate: '14:30' },
    { id: 'v4', nome: 'Ana Beatriz', fim4: '2299', de: '09:30', ate: '10:30' },
    { id: 'v5', nome: 'Wellington Souza', fim4: '5074', de: '11:00', ate: '13:00' },
  ];
  return { nomes, total: 6 };
}

async function prepararFalhaNaFila(slug) {
  const tenant = psql(`select tenant_id from tenant_slugs where slug = '${slug}'`);
  if (!tenant) return;
  psql(
    `INSERT INTO jobs (tenant_id, kind, payload, status, run_after, finished_at, attempts, last_error)
     VALUES ('${tenant}', 'automacao.varrer', '{}'::jsonb, 'failed',
             now() - interval '70 minutes', now() - interval '65 minutes', 3,
             'Raw query failed. Code: 42883')`,
  );
}

async function prepararPrecos(slug) {
  const tenant = psql(`select tenant_id from tenant_slugs where slug = '${slug}'`);
  const local = psql(`select id from locations where tenant_id = '${tenant}' limit 1`);
  if (!tenant || !local) return;

  psql(`UPDATE locations SET dynamic_pricing_enabled = true WHERE id = '${local}'`);

  /**
   * Uma hora de verdade cheia, para a sugestão aparecer no print.
   *
   * A sugestão só existe para hora **medida** cheia — o desconto no escuro saiu
   * do produto. Sem semear ocupação, a tela seria fotografada sem o bloco que o
   * bloco 68 entrega, e print de tela pela metade é o que a medição existe para
   * não deixar passar.
   *
   * Oito semanas de sexta às 18h, as duas cadeiras ocupadas a hora inteira: é
   * exatamente a capacidade daquela célula, e portanto 100%.
   */
  const cliente = psql(
    `select id from customers where tenant_id = '${tenant}' order by created_at limit 1`,
  );
  if (cliente) {
    psql(
      `INSERT INTO appointments
         (tenant_id, location_id, customer_id, professional_id,
          starts_at, ends_at, service_starts_at, service_ends_at, status)
       SELECT '${tenant}', '${local}', '${cliente}', p.id,
              (semana.dia + time '18:00') AT TIME ZONE l.timezone,
              (semana.dia + time '19:00') AT TIME ZONE l.timezone,
              (semana.dia + time '18:00') AT TIME ZONE l.timezone,
              (semana.dia + time '19:00') AT TIME ZONE l.timezone,
              'completed'
         FROM professionals p
         CROSS JOIN locations l
         CROSS JOIN LATERAL (
           -- Ancorado na sexta da semana corrente e recuando de sete em sete.
           -- Um generate_series com passo de 7 dias mantém o dia da semana da
           -- ponta inicial: filtrar por DOW depois só acerta quando hoje já é
           -- sexta, e nas outras seis vezes a semeadura sai vazia em silêncio.
           SELECT generate_series(
             date_trunc('week', current_date)::date + 4 - 56,
             date_trunc('week', current_date)::date + 4 - 7,
             interval '7 days'
           )::date AS dia
         ) AS semana
        WHERE p.location_id = '${local}' AND p.active AND l.id = '${local}'`,
    );
  }

  for (const [dia, inicio, fim, delta] of [
    [2, 780, 960, -1000],
    [6, 540, 780, 1000],
    [4, 1080, 1260, -4000],
  ]) {
    psql(
      `INSERT INTO pricing_rules (tenant_id, location_id, weekday, start_minute, end_minute, delta_bps)
       VALUES ('${tenant}', '${local}', ${dia}, ${inicio}, ${fim}, ${delta})`,
    );
  }
}

/**
 * Perguntas que a recepção digital não soube responder (bloco 66).
 *
 * Pela rota pública, e não pelo banco: é ela que decide o que vira lacuna, e
 * semear a tabela direto mediria uma tela sobre um estado que o produto talvez
 * nunca produza. O que se mede é a lista real — inclusive a contagem, que é o
 * que ordena os cartões.
 *
 * Perguntas de verdade, com abreviação e sem acento: é assim que chega no
 * celular, e é isso que estoura o cartão.
 */
async function prepararRecepcao(slug) {
  const perguntas = [
    'vcs aceitam pix ou so dinheiro mesmo?',
    'vcs aceitam pix?',
    'aceitam pagamento no pix',
    'posso levar meu filho de 4 anos junto no horario marcado?',
    'posso levar meu filho',
    'voces tem estacionamento proprio ou tem que deixar na rua?',
  ];
  for (const texto of perguntas) {
    await fetch(`${API}/v1/b/${slug}/agente`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ texto }),
    });
  }
}

/**
 * Prepara um convite de vaga aberto, para medir a tela do bloco 39.
 *
 * Pelo banco, e não pela HTTP: o convite nasce no worker, e subir um worker só
 * para medir uma tela sairia caro. O que a medição precisa é do **estado** —
 * convite aberto, com nome de serviço longo e o relógio correndo.
 *
 * O recurso `avisos` entra ligado junto: conta nova nasce sem ele, e a rota
 * recusa o convite de quem o desligou.
 */
async function prepararConvite(slug) {
  const { createHash, randomBytes } = require('node:crypto');
  const tenant = psql(`select tenant_id from tenant_slugs where slug = '${slug}'`);
  const local = psql(`select id from locations where tenant_id = '${tenant}' limit 1`);
  const profissional = psql(
    `select id from professionals where tenant_id = '${tenant}' and active order by name limit 1`,
  );
  // O serviço de nome mais longo: é ele que estoura a linha, não o mais barato.
  const servico = psql(
    `select id from services where tenant_id = '${tenant}' and active order by length(name) desc limit 1`,
  );
  // O **mesmo** cliente que tem sessão na medição: o convite precisa aparecer no
  // cartão de "Meus agendamentos", que é a segunda porta dele. Um cliente
  // qualquer mediria a tela do convite e deixaria o cartão fora.
  const cliente = psql(
    `select id from customers where tenant_id = '${tenant}' and phone_e164 = '+5571988887777' limit 1`,
  );
  if (!tenant || !local || !profissional || !servico || !cliente) return { link: null };

  const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  // A primeira linha: `psql -tAc` com RETURNING imprime o id **e** o `INSERT 0 1`
  // do comando, e o segundo vira parte do uuid na consulta seguinte.
  const entrada = primeiraLinha(psql(
    `INSERT INTO waitlist_entries
       (tenant_id, location_id, customer_id, wanted_from, wanted_to,
        window_start_minute, window_end_minute, duration_minutes)
     VALUES ('${tenant}', '${local}', '${cliente}', '${amanha}', '${amanha}', 480, 720, 30)
     RETURNING id`,
  ));
  psql(
    `INSERT INTO waitlist_entry_services (entry_id, service_id, tenant_id, position)
     VALUES ('${entrada}', '${servico}', '${tenant}', 0)`,
  );

  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  psql(
    `INSERT INTO waitlist_offers
       (tenant_id, entry_id, professional_id, starts_at, ends_at, service_starts_at,
        expires_at, token_hash)
     VALUES ('${tenant}', '${entrada}', '${profissional}',
             '${amanha}T12:00:00Z', '${amanha}T12:30:00Z', '${amanha}T12:00:00Z',
             now() + interval '10 min', '${hash}')`,
  );

  return { link: token };
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
/**
 * Split ligado, com repasses de verdade (bloco 49).
 *
 * Pelo banco, como o resto: o que a medição precisa é do **estado** — a tabela
 * de repasses com as três partes, uma delas retida, que é a linha mais alta e a
 * única que o balcão precisa ler devagar.
 */
function prepararSplit(slug) {
  const tenant = psql(`select tenant_id from tenant_slugs where slug = '${slug}'`);
  if (!tenant) return;

  psql(`UPDATE tenants SET split_enabled = true WHERE id = '${tenant}'`);
  psql(
    `UPDATE tenant_platform SET platform_fee_bps = 500 WHERE tenant_id = '${tenant}'`,
  );

  const venda = primeiraLinha(
    psql(
      `select id from orders where tenant_id = '${tenant}' and status = 'paid'
        order by closed_at desc limit 1`,
    ),
  );
  const local = primeiraLinha(
    psql(`select id from locations where tenant_id = '${tenant}' limit 1`),
  );
  const barbeiro = primeiraLinha(
    psql(`select id from professionals where tenant_id = '${tenant}' limit 1`),
  );
  if (!venda || !local || !barbeiro) return;

  const cobranca = primeiraLinha(
    psql(
      `INSERT INTO order_charges
         (tenant_id, location_id, order_id, method, amount_cents, status,
          created_by_name, paid_at, psp_payment_id)
       VALUES ('${tenant}', '${local}', '${venda}', 'pix', 10000, 'pago',
               'Maria Recepção', now(), 'pay_medicao_49')
       RETURNING id`,
    ),
  );
  if (!cobranca) return;

  // Um barbeiro aprovado e outro sem cadastro (bloco 50): são os dois estados
  // que a tela precisa mostrar lado a lado, e o segundo é o que traz o valor
  // retido — o número que faz o cadastro acontecer.
  psql(
    `UPDATE professionals SET psp_recipient_id = 'rec_medicao', psp_kyc_status = 'aprovado',
            psp_kyc_updated_at = now()
      WHERE id = '${barbeiro}'`,
  );

  const partes = [
    ['barbearia', 'NULL', 5500, 'liquidado', 'now()'],
    ['profissional', `'${barbeiro}'`, 4000, 'liquidado', 'now()'],
    ['plataforma', 'NULL', 500, 'liquidado', 'now()'],
  ];
  for (const [parte, dono, valor, estado, quando] of partes) {
    psql(
      `INSERT INTO payment_splits
         (tenant_id, order_id, charge_id, party, professional_id, amount_cents,
          status, settled_at)
       VALUES ('${tenant}', '${venda}', '${cobranca}', '${parte}', ${dono}, ${valor},
               '${estado}', ${quando})
       ON CONFLICT DO NOTHING`,
    );
  }
}

/**
 * Contas a pagar e a receber, com conteúdo de verdade (bloco 51).
 *
 * Pelo banco, como o split: o que a medição precisa é do **estado**. Nome de
 * fornecedor longo, valor de quatro dígitos e uma conta vencida são o que
 * estoura a grade — a tela vazia é justamente o layout que não quebra.
 */
function prepararFinanceiro(slug) {
  const tenant = psql(`select tenant_id from tenant_slugs where slug = '${slug}'`);
  if (!tenant) return;
  const local = primeiraLinha(
    psql(`select id from locations where tenant_id = '${tenant}' limit 1`),
  );
  if (!local) return;

  const categorias = [
    ['Aluguel e condomínio', 'pagar'],
    ['Produtos e insumos', 'pagar'],
    ['Aluguel de cadeira', 'receber'],
  ];
  for (const [nome, direcao] of categorias) {
    psql(
      `INSERT INTO financial_categories (tenant_id, name, direction)
       VALUES ('${tenant}', '${nome}', '${direcao}') ON CONFLICT DO NOTHING`,
    );
  }

  psql(
    `INSERT INTO financial_accounts (tenant_id, location_id, name, is_cash)
     VALUES ('${tenant}', '${local}', 'Gaveta da Matriz', true) ON CONFLICT DO NOTHING`,
  );
  psql(
    `INSERT INTO financial_accounts (tenant_id, location_id, name, is_cash)
     VALUES ('${tenant}', NULL, 'Banco do Brasil — conta PJ', false) ON CONFLICT DO NOTHING`,
  );

  const contas = [
    ['pagar', 'Aluguel e condomínio do salão', 'Aluguel e condomínio', 285000, "current_date + 5"],
    ['pagar', 'Distribuidora São Paulo Cosméticos', 'Produtos e insumos', 148790, "current_date - 3"],
    ['pagar', 'Contabilidade Ferreira & Associados', null, 62000, "current_date"],
    ['receber', 'Aluguel da cadeira 3 — Bruno Nascimento', 'Aluguel de cadeira', 90000, "current_date + 12"],
    ['receber', 'Reembolso da distribuidora (lote trocado)', null, 24500, "current_date - 8"],
  ];
  for (const [direcao, descricao, categoria, valor, vence] of contas) {
    const cat = categoria
      ? `(SELECT id FROM financial_categories WHERE tenant_id = '${tenant}' AND name = '${categoria}')`
      : 'NULL';
    psql(
      `INSERT INTO bills
         (tenant_id, location_id, direction, description, category_id, amount_cents,
          due_on, created_by_name)
       VALUES ('${tenant}', '${local}', '${direcao}', '${descricao}', ${cat}, ${valor},
               ${vence}, 'Maria Recepção')
       ON CONFLICT DO NOTHING`,
    );
  }

  psql(
    `INSERT INTO account_transfers
       (tenant_id, location_id, from_account_id, to_account_id, amount_cents,
        happened_on, created_by_name)
     SELECT '${tenant}', '${local}',
            (SELECT id FROM financial_accounts WHERE tenant_id = '${tenant}' AND is_cash),
            (SELECT id FROM financial_accounts WHERE tenant_id = '${tenant}' AND NOT is_cash),
            70000, current_date - 1, 'Maria Recepção'
      WHERE EXISTS (SELECT 1 FROM financial_accounts WHERE tenant_id = '${tenant}' AND is_cash)`,
  );

  // O limite de fiado, que é a origem de dado que este bloco entrega: sem ele a
  // ficha do cliente mostraria "sem limite" para todo mundo na medição.
  psql(
    `UPDATE customers SET credit_limit_cents = 15000
      WHERE tenant_id = '${tenant}' AND balance_cents < 0`,
  );
}

/**
 * Vale concedido e uma venda estornada (bloco 52).
 *
 * Pelo banco, como o resto: o que a medição precisa é do **estado**. O DRE sem
 * despesa e sem vale mostraria três linhas zeradas, e linha zerada é o layout
 * que não quebra — nome composto de barbeiro e valor de cinco dígitos são o que
 * estoura a grade de quatro colunas.
 */
function prepararValeEEstorno(slug) {
  const tenant = psql(`select tenant_id from tenant_slugs where slug = '${slug}'`);
  if (!tenant) return;
  const local = primeiraLinha(
    psql(`select id from locations where tenant_id = '${tenant}' limit 1`),
  );
  const barbeiro = primeiraLinha(
    psql(`select id from professionals where tenant_id = '${tenant}' limit 1`),
  );
  if (!local || !barbeiro) return;

  psql(
    `INSERT INTO professional_advances
       (tenant_id, location_id, professional_id, amount_cents, granted_on, reason,
        created_by_name)
     VALUES ('${tenant}', '${local}', '${barbeiro}', 25000, current_date,
             'Adiantamento pedido no meio do mês', 'Maria Recepção')`,
  );

  /**
   * Uma conta **paga**, para a linha de despesa do DRE ter conteúdo.
   *
   * As contas do bloco 51 nascem em aberto na demonstração, e despesa zerada é
   * justamente o layout que não quebra — o que estoura a grade de quatro colunas
   * é o valor de cinco dígitos com o comparativo ao lado.
   *
   * A venda estornada **não** é semeada aqui, e a razão está escrita: a
   * demonstração tem uma comanda fechada só, e desfazê-la esvaziaria o DRE
   * inteiro — o relatório apareceria zerado na única tela que ele existe para
   * mostrar. Estornar por `UPDATE` seria pior ainda: produziria um estado que o
   * produto não produz, com a venda desfeita e a comissão de pé.
   */
  psql(
    `UPDATE bills
        SET status = 'paga', paid_on = current_date - 2, paid_cents = amount_cents
      WHERE tenant_id = '${tenant}' AND direction = 'pagar'
        AND description LIKE 'Contabilidade%'`,
  );
}

/**
 * Cadastro fiscal e uma nota por venda (bloco 53).
 *
 * Pelo banco, como o resto. Sem cadastro a tela mostra só o formulário vazio, e
 * formulário vazio é o layout que não quebra — o que estoura a grade é a linha
 * de nota com número, motivo de recusa e a repartição do Salão-Parceiro juntos.
 */
/**
 * O WhatsApp cadastrado e dois textos (bloco 55).
 *
 * Pelo banco, como o resto. Sem cadastro a tela mostra só o estado inicial e o
 * formulário vazio — e formulário vazio é o layout que não quebra. O que estoura
 * a grade é a linha de template com nome longo, motivo de recusa e a lista de
 * botões juntos.
 */
function prepararWhatsApp(slug) {
  const tenant = psql(`select tenant_id from tenant_slugs where slug = '${slug}'`);
  if (!tenant) return;
  const local = primeiraLinha(
    psql(`select id from locations where tenant_id = '${tenant}' limit 1`),
  );
  if (!local) return;

  // O escopo só de envio é semeado de propósito: é o estado que faz a tela
  // desenhar o aviso do bloco 88, e sem ele a medição fotografava a tela num
  // estado em que a mudança é invisível — semente que prepara o estado errado
  // mede o que ela acha que preparou, sem nada ficar vermelho.
  psql(
    `INSERT INTO whatsapp_settings
       (location_id, tenant_id, status, phone_number_id, waba_id, display_phone,
        access_token_cipher, granted_scopes, verified_at)
     VALUES ('${local}', '${tenant}', 'ativo', '109876543210987', '102030405060708',
             '+55 71 3333-4444', 'nonce.tag.dados',
             ARRAY['whatsapp_business_messaging'], now())
     ON CONFLICT (location_id) DO NOTHING`,
  );
  psql(
    `INSERT INTO whatsapp_numbers (phone_number_id, tenant_id, location_id)
     VALUES ('109876543210987', '${tenant}', '${local}')
     ON CONFLICT (phone_number_id) DO NOTHING`,
  );

  // Um aprovado e um rejeitado: são os dois estados que a tela precisa mostrar
  // lado a lado, e o segundo traz o texto longo da Meta.
  psql(
    `INSERT INTO whatsapp_templates
       (tenant_id, location_id, kind, name, status, body, buttons)
     VALUES ('${tenant}', '${local}', 'lembrete_24h', 'lembrete_24h_v1', 'aprovado',
             'Olá {{1}}, seu corte é amanhã às {{2}} com {{3}}. Até lá!',
             '["confirmar","remarcar","cancelar"]'::jsonb)
     ON CONFLICT DO NOTHING`,
  );
  psql(
    `INSERT INTO whatsapp_templates
       (tenant_id, location_id, kind, name, status, body, buttons, rejection_reason)
     VALUES ('${tenant}', '${local}', 'retorno', 'convite_de_retorno_v2', 'rejeitado',
             'Já faz 28 dias desde seu último corte. Quer reservar novamente?',
             '["agendar_novamente"]'::jsonb,
             'Conteúdo promocional em template de categoria utilitária — reenvie como marketing')
     ON CONFLICT DO NOTHING`,
  );

  /**
   * **Dois** convites de retorno aprovados, com títulos diferentes (bloco 96).
   *
   * São eles que fazem a campanha e a automação desenharem a escolha do texto:
   * com nenhum, as duas telas mostram "Nenhum texto aprovado — nada vai sair" e
   * a medição fotografa o estado de antes do bloco. Com um só, o rádio vira
   * campo escondido e a escolha some.
   *
   * É a regra da semente que confere a resposta, aplicada ao que a medição
   * fotografa: semente que prepara o estado errado mede o que ela acha que
   * preparou, sem nada ficar vermelho.
   */
  psql(
    `INSERT INTO whatsapp_templates
       (tenant_id, location_id, kind, name, titulo, status, body, buttons)
     VALUES ('${tenant}', '${local}', 'retorno', 'volta_sentimos_falta',
             'Volta que a gente sente falta', 'aprovado',
             'Oi {{1}}, faz tempo! Volte à {{2}} — a cadeira está esperando.',
             '["agendar_novamente","parar_de_receber"]'::jsonb)
     ON CONFLICT DO NOTHING`,
  );
  psql(
    `INSERT INTO whatsapp_templates
       (tenant_id, location_id, kind, name, titulo, status, body, buttons)
     VALUES ('${tenant}', '${local}', 'retorno', 'pacote_no_fim',
             'Seu pacote está no fim', 'aprovado',
             'Oi {{1}}, seu pacote na {{2}} está acabando. Quer renovar?',
             '["agendar_novamente"]'::jsonb)
     ON CONFLICT DO NOTHING`,
  );
}

/**
 * Duas automações, uma com resultado e outra sem (bloco 56).
 *
 * Pelo banco, como o resto. O que estoura a linha é a automação com nome longo,
 * gatilho, objetivo, janela e os dois contadores juntos — não a lista vazia.
 */
function prepararAutomacoes(slug) {
  const tenant = psql(`select tenant_id from tenant_slugs where slug = '${slug}'`);
  if (!tenant) return;

  psql(
    `INSERT INTO automations
       (tenant_id, name, trigger, threshold, delay_minutes, kind, goal, goal_window_days, active)
     VALUES
       ('${tenant}', 'Volta pro corte — quem sumiu há um mês', 'sem_retorno', 30, 0,
        'retorno', 'agendamento', 7, true),
       ('${tenant}', 'Parabéns na véspera', 'aniversario', 1, 0,
        'retorno', 'agendamento', 14, false)
     ON CONFLICT DO NOTHING`,
  );

  /**
   * Uma automação **com público** (bloco 100).
   *
   * É o estado que o bloco criou: sem ela a linha sai como "Quando sumiu há um
   * tempo (30) · espera ..." e a metade nova da frase — "só para Em risco" —
   * não aparece em largura nenhuma. Semente que não produz o estado novo
   * fotografa a tela de antes da mudança, e a medição diz "ok" sobre o que não
   * foi olhado.
   */
  psql(
    `INSERT INTO automations
       (tenant_id, name, trigger, threshold, delay_minutes, kind, goal,
        goal_window_days, active, audience)
     VALUES
       ('${tenant}', 'Sumiu e é dos que mais gastam', 'sem_retorno', 45, 0,
        'retorno', 'agendamento', 14, true, 'vip')
     ON CONFLICT DO NOTHING`,
  );
}

/**
 * Uma campanha já enviada, com receita atribuída (bloco 57).
 *
 * O heatmap se desenha sozinho a partir da agenda que a carga já monta. O que
 * precisa de semente é a **linha da campanha**: é ela que carrega as seis
 * colunas da SPEC §4.13 numa linha só, e é ela que pode estourar a largura.
 */
/**
 * A segunda loja (bloco 58).
 *
 * A tela de unidades tem dois estados, e o de uma loja só é uma frase — que é
 * honesta e não é o que precisa ser fotografado. A filial nasce com produto na
 * prateleira e uma transferência já feita, para a lista e a tabela de saldo
 * desenharem o que desenham em uso.
 */
function prepararUnidades(slug) {
  const tenant = psql(`select tenant_id from tenant_slugs where slug = '${slug}'`);
  if (!tenant) return;

  const matriz = primeiraLinha(
    psql(`select id from locations where tenant_id = '${tenant}' order by created_at limit 1`),
  );
  if (!matriz) return;

  const filial = primeiraLinha(
    psql(
      `INSERT INTO locations (tenant_id, name, timezone, street, district, city, state)
       VALUES ('${tenant}', 'Domari Pituba', 'America/Bahia',
               'Rua Ceará, 1210', 'Pituba', 'Salvador', 'BA')
       RETURNING id`,
    ),
  );
  if (!filial) return;

  const produto = primeiraLinha(
    psql(`select id from products where tenant_id = '${tenant}' order by name limit 1`),
  );
  const dono = primeiraLinha(
    psql(`select id from staff_users where tenant_id = '${tenant}' and role = 'owner' limit 1`),
  );
  if (!produto || !dono) return;

  const hoje = new Date().toISOString().slice(0, 10);
  psql(
    `INSERT INTO stock_movements
       (tenant_id, product_id, location_id, kind, quantity, unit_cost_cents,
        reason, staff_user_id, business_day)
     VALUES ('${tenant}', '${produto}', '${matriz}', 'entrada', 40, 1200,
             'compra do mês', '${dono}', '${hoje}')`,
  );

  const transferencia = primeiraLinha(
    psql(
      `INSERT INTO stock_transfers
         (tenant_id, product_id, from_location_id, to_location_id, quantity,
          unit_cost_cents, note, created_by, created_by_name)
       VALUES ('${tenant}', '${produto}', '${matriz}', '${filial}', 12, 1200,
               'abertura da Pituba', '${dono}', 'Matheus Cardoso')
       RETURNING id`,
    ),
  );
  if (!transferencia) return;

  psql(
    `INSERT INTO stock_movements
       (tenant_id, product_id, location_id, kind, quantity, unit_cost_cents,
        reason, staff_user_id, business_day)
     VALUES ('${tenant}', '${produto}', '${matriz}', 'transferencia', -12, 1200,
             'transferência ${transferencia}', '${dono}', '${hoje}'),
            ('${tenant}', '${produto}', '${filial}', 'transferencia', 12, 1200,
             'transferência ${transferencia}', '${dono}', '${hoje}')`,
  );
}

/**
 * A regra de recusa ligada, com uma recusa registrada (bloco 60).
 *
 * Ela nasce desligada, e é a decisão certa do produto — mas isso faz o cartão
 * "Quem a regra recusou" nunca aparecer na medição. Estado vazio e estado cheio
 * são telas diferentes, e a que ninguém fotografa é a que ninguém confere.
 */
function prepararRecusaOnline(slug) {
  const tenant = psql(`select tenant_id from tenant_slugs where slug = '${slug}'`);
  if (!tenant) return;

  const local = primeiraLinha(
    psql(`select id from locations where tenant_id = '${tenant}' order by created_at limit 1`),
  );
  const cliente = primeiraLinha(
    psql(`select id from customers where tenant_id = '${tenant}' order by created_at limit 1`),
  );
  if (!local || !cliente) return;

  // Cinco faltas em dez é o que a tela pergunta; o motor guarda o limiar de
  // score equivalente, que é o que a coluna aceita.
  psql(`UPDATE locations SET online_block_score = 60 WHERE id = '${local}'`);
  psql(
    `INSERT INTO online_blocks (tenant_id, location_id, customer_id, score, threshold, wanted_at)
     VALUES ('${tenant}', '${local}', '${cliente}', 25, 60, now() + interval '2 days')`,
  );
}

function prepararCampanha(slug) {
  const tenant = psql(`select tenant_id from tenant_slugs where slug = '${slug}'`);
  if (!tenant) return;

  /**
   * Movimento **passado**, que é o que o heatmap lê.
   *
   * A carga do `/availability` monta agenda para os próximos sete dias, e a
   * grade olha as oito semanas anteriores: sem esta semente a tela mostra o
   * estado vazio — que é honesto e não é o que precisa ser fotografado.
   *
   * As horas variam de propósito: uma grade em que todas as células têm o mesmo
   * valor não mostra o que a tela existe para mostrar.
   */
  const local = primeiraLinha(
    psql(`select id from locations where tenant_id = '${tenant}' limit 1`),
  );
  const profissionais = psql(
    `select id from professionals where tenant_id = '${tenant}' order by created_at limit 4`,
  )
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const cliente = primeiraLinha(
    psql(`select id from customers where tenant_id = '${tenant}' limit 1`),
  );
  if (local && profissionais.length > 0 && cliente) {
    /**
     * Uma instrução só, com `generate_series`.
     *
     * A primeira versão fazia um `psql` por agendamento — seiscentas chamadas de
     * processo, e a medição não chegava nem às telas. O que se quer aqui é a
     * grade preenchida, não um laço em JavaScript.
     *
     * A tarde é mais cheia que a manhã de propósito: uma grade em que todas as
     * células têm o mesmo valor não mostra o que a tela existe para mostrar.
     *
     * Cada repetição vai para **um profissional diferente**, e não para o mesmo
     * com sete minutos de diferença: a constraint anti-overbooking recusa dois
     * atendimentos que se sobrepõem na mesma cadeira, e ela está certa. É assim
     * que uma hora cheia acontece de verdade — várias cadeiras ocupadas ao
     * mesmo tempo.
     */
    for (const [indice, profissional] of profissionais.entries()) {
      psql(
        `INSERT INTO appointments
           (tenant_id, location_id, professional_id, customer_id, status,
            starts_at, ends_at, service_starts_at, service_ends_at)
         SELECT '${tenant}', '${local}', '${profissional}', '${cliente}', 'completed',
                inicio, inicio + interval '30 minutes', inicio, inicio + interval '30 minutes'
           FROM (
             SELECT date_trunc('week', now())
                    - semana * interval '1 week'
                    + dia * interval '1 day'
                    + hora * interval '1 hour' AS inicio
               FROM generate_series(1, 6) AS semana,
                    generate_series(1, 6) AS dia,
                    generate_series(9, 19) AS hora
              WHERE ${indice + 1} <= CASE WHEN hora >= 17 THEN 4 WHEN hora >= 13 THEN 2 ELSE 1 END
           ) t
          ON CONFLICT DO NOTHING`,
      );
    }
  }

  const campanha = primeiraLinha(
    psql(
      `INSERT INTO campaigns (tenant_id, name, filter, filter_value, filter_weekday, kind, status, sent_at)
       VALUES ('${tenant}', 'Encher a terça das 14h', 'celula_fria', 14, 2, 'retorno', 'enviada', now())
       RETURNING id`,
    ),
  );
  if (!campanha) return;

  const clientes = psql(
    `select id from customers where tenant_id = '${tenant}' order by created_at limit 12`,
  )
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  /**
   * Nove enviados e três **pulados**, com motivos diferentes (bloco 97).
   *
   * O resumo por motivo e o link "ver quem" só existem quando alguém foi
   * pulado: sem isso a medição fotografa o cartão de antes do bloco. Dois
   * motivos e não um, porque a linha os junta com "·" e é ela que pode
   * estourar a largura no celular.
   *
   * `wamid` nos enviados: sem ele o cartão passa a dizer "nada saiu pelo
   * WhatsApp" — que é o aviso certo para aquele estado, e não o desta tela.
   */
  for (const [i, cliente] of clientes.entries()) {
    if (i >= 9) {
      const motivo = i === 9 ? 'optou_por_nao_receber' : 'teto_do_mes';
      psql(
        `INSERT INTO campaign_targets
           (tenant_id, campaign_id, customer_id, skipped_reason)
         VALUES ('${tenant}', '${campanha}', '${cliente}', '${motivo}')
         ON CONFLICT DO NOTHING`,
      );
      continue;
    }
    const objetivo = i < 3 ? `now(), NULL, ${4500 + i * 900}` : 'NULL, NULL, NULL';
    psql(
      `INSERT INTO campaign_targets
         (tenant_id, campaign_id, customer_id, sent_at, wamid, goal_met_at, goal_ref,
          goal_amount_cents)
       VALUES ('${tenant}', '${campanha}', '${cliente}', now(),
               'wamid.medicao.${i}', ${objetivo})
       ON CONFLICT DO NOTHING`,
    );
  }
}

/**
 * Três ritmos diferentes, para o cartão de segmentos ter o que mostrar (bloco 61).
 *
 * Sem esta semente a base inteira cai em "novo" — quem tem menos de três visitas
 * não tem ciclo —, e o cartão fotografado seria sete zeros e uma lista vazia.
 * Zero é honesto e não é o que precisa ser olhado: a pergunta que a tela existe
 * para responder é *"quem passou do próprio ritmo?"*, e ela só aparece quando
 * alguém passou.
 *
 * **Gente própria, nunca a do balcão.** A ficha do cliente e a fila medem outra
 * coisa sobre os clientes que já existem, e pendurar um histórico neles muda o
 * que aquelas telas mostram — foi assim que uma semente do bloco 60 consertou a
 * reputação do cliente que o teste queria ver recusado.
 *
 * As horas ficam antes das 9h porque a semente do heatmap ocupa das 9h às 19h, e
 * `appointments_no_overlap` recusa dois atendimentos sobrepostos na mesma
 * cadeira — ela está certa, e a semente é que precisa caber.
 */
function prepararSegmentos(slug) {
  const tenant = psql(`select tenant_id from tenant_slugs where slug = '${slug}'`);
  if (!tenant) return null;
  const local = primeiraLinha(
    psql(`select id from locations where tenant_id = '${tenant}' limit 1`),
  );
  const profissional = primeiraLinha(
    psql(`select id from professionals where tenant_id = '${tenant}' order by created_at limit 1`),
  );
  if (!local || !profissional) return null;

  /**
   * Nome, telefone, hora, ciclo em dias e dias desde a última visita.
   *
   * Os números não são livres: com intervalos todos iguais o desvio é zero e a
   * folga cai no piso de um dia, então "em risco" é a faixa `ciclo + 1 <
   * ausência <= 2 × ciclo`. Quarenta e cinco dias sobre um ciclo de vinte e um
   * já passou do dobro e cai em **perdido** — foi o que a primeira versão desta
   * semente produziu, com o cartão fotografado mostrando zero em risco.
   */
  const gente = [
    ['Reinaldo Estêvão de Farias', '+5571977001101', 6, 21, 30],
    ['Domingos Sávio da Conceição', '+5571977001102', 7, 14, 60],
    ['Otávio Bezerra Lins', '+5571977001103', 8, 30, 12],
    ["Maria das Graças Sant'Anna", '+5571977001104', 5, 35, 50],
  ];

  let emRisco = null;
  for (const [nome, telefone, hora, ciclo, ultima] of gente) {
    const cliente = primeiraLinha(
      psql(
        `INSERT INTO customers (tenant_id, name, phone_e164, accepts_marketing)
         VALUES ('${tenant}', '${nome.replace(/'/g, "''")}', '${telefone}', true)
         -- Apóstrofo dobrado: "Sant'Anna" é nome real e é exatamente o tipo de
         -- conteúdo que quebra uma semente escrita com interpolação ingênua.
         ON CONFLICT (tenant_id, phone_e164) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
      ),
    );
    if (!cliente) continue;

    // Quatro visitas: três é o mínimo para existir ciclo, e a quarta é o que
    // torna a mediana diferente do único intervalo.
    psql(
      `INSERT INTO appointments
         (tenant_id, location_id, professional_id, customer_id, status,
          starts_at, ends_at, service_starts_at, service_ends_at)
       SELECT '${tenant}', '${local}', '${profissional}', '${cliente}', 'completed',
              inicio, inicio + interval '30 minutes', inicio, inicio + interval '30 minutes'
         FROM (
           SELECT date_trunc('day', now())
                  - (${ultima} + n * ${ciclo}) * interval '1 day'
                  + ${hora} * interval '1 hour' AS inicio
             FROM generate_series(0, 3) AS n
         ) t
        ON CONFLICT DO NOTHING`,
    );
    // O primeiro é o que está em risco, e é a ficha dele que a medição
    // fotografa: a do balcão tem uma visita só e nunca mostra a linha do ritmo.
    if (!emRisco) emRisco = cliente;
  }
  return emRisco;
}

/**
 * Liga os recursos que a plataforma controla (bloco 26, e o fiscal no 81).
 *
 * Sem isto a medição fotografa a página de 404: `fila`, `importacao`, `avisos` e
 * `fiscal` nascem desligados no catálogo, e a tela de cada um fecha a própria
 * porta quando o recurso não está ligado. Uma barbearia de verdade tem os três
 * primeiros pelo plano e o quarto pelo toggle do Super Admin — o que a medição
 * mede é a tela **existindo**, então ela liga os quatro.
 *
 * Confere a resposta em vez de disparar e seguir: uma semente que prepara um
 * estado e não o verifica prepara o estado que ela **acha** que preparou, e a
 * tela é medida no estado errado sem nada ficar vermelho. Foi o defeito do
 * cartão "bloqueada" no bloco 80.
 */
function ligarRecursos(slug) {
  const tenant = psql(`select tenant_id from tenant_slugs where slug = '${slug}'`);
  if (!tenant) return false;
  for (const code of ['fila', 'importacao', 'avisos', 'fiscal']) {
    psql(
      `INSERT INTO tenant_features (tenant_id, flag_code, enabled) VALUES ('${tenant}', '${code}', true)
         ON CONFLICT (tenant_id, flag_code) DO UPDATE SET enabled = true`,
    );
  }
  const ligados = psql(
    `select count(*) from tenant_features where tenant_id = '${tenant}' and enabled
       and flag_code in ('fila', 'importacao', 'avisos', 'fiscal')`,
  );
  if (Number(ligados) !== 4) {
    console.warn(`  aviso: só ${ligados} de 4 recursos ligados; telas gateadas medirão 404`);
    return false;
  }
  return true;
}

function prepararFiscal(slug) {
  const tenant = psql(`select tenant_id from tenant_slugs where slug = '${slug}'`);
  if (!tenant) return null;
  const local = primeiraLinha(
    psql(`select id from locations where tenant_id = '${tenant}' limit 1`),
  );
  if (!local) return null;

  psql(
    `INSERT INTO fiscal_settings
       (location_id, tenant_id, cnpj, regime, service_code, iss_bps,
        municipality_ibge, municipal_registration, auto_issue)
     VALUES ('${local}', '${tenant}', '11222333000181', 'salao_parceiro', '14.01', 200,
             '2927408', '123456-7', true)
     ON CONFLICT (location_id) DO NOTHING`,
  );

  // Com cliente na frente das avulsas: é a venda com cadastro que desenha o
  // campo de CPF do bloco 54, e a avulsa desenha só a frase que o substitui.
  // Medir a avulsa deixaria o campo novo fora da foto.
  const venda = primeiraLinha(
    psql(
      `select id from orders where tenant_id = '${tenant}' and status = 'paid'
        order by (customer_id is null), closed_at limit 1`,
    ),
  );
  if (!venda) return null;

  /**
   * A venda medida ganha cliente e CPF.
   *
   * O balcão fecha comanda avulsa o tempo todo, e é o que a semente produz — mas
   * a avulsa desenha a frase que **substitui** o campo de CPF, e não o campo. A
   * tela que precisa ser vista é a com cadastro: é ela que tem rótulo, campo,
   * dica e botão, e é ela que pode estourar a linha em 360px.
   */
  const cliente = primeiraLinha(
    psql(`select id from customers where tenant_id = '${tenant}' order by created_at limit 1`),
  );
  if (cliente) {
    psql(`UPDATE orders SET customer_id = '${cliente}' WHERE id = '${venda}'`);
    psql(`UPDATE customers SET tax_id = '52998224725' WHERE id = '${cliente}'`);
  }

  // Uma autorizada e uma rejeitada: são os dois estados que a tela precisa
  // mostrar lado a lado, e o segundo é o que traz o texto longo da prefeitura.
  psql(
    `INSERT INTO fiscal_invoices
       (tenant_id, location_id, order_id, status, provider_invoice_id, number, pdf_url,
        regime, service_cents, partner_cents, iss_bps, service_code, municipality_ibge,
        customer_name, authorized_at, created_by_name)
     VALUES ('${tenant}', '${local}', '${venda}', 'autorizada', 'nf_demo_1', '2026/1043',
             'https://nfse.exemplo/2026-1043.pdf', 'salao_parceiro', 129000, 51600, 200,
             '14.01', '2927408', 'Carlos Eduardo Nascimento', now(), 'Maria Recepção')
     ON CONFLICT DO NOTHING`,
  );
  psql(
    `INSERT INTO fiscal_invoices
       (tenant_id, location_id, order_id, status, rejection_reason,
        regime, service_cents, partner_cents, iss_bps, service_code, municipality_ibge,
        customer_name, created_by_name)
     VALUES ('${tenant}', '${local}', '${venda}', 'rejeitada',
             'Código de serviço 14.01 não habilitado para o CNPJ informado na inscrição municipal',
             'salao_parceiro', 129000, 51600, 200, '14.01', '2927408',
             'Carlos Eduardo Nascimento', 'Maria Recepção')
     ON CONFLICT DO NOTHING`,
  );

  // A venda paga volta porque o bloco da nota **só desenha em comanda fechada**,
  // e a comanda medida até aqui era a aberta. Sem esta linha, a seção que este
  // bloco acrescentou à tela do balcão não é medida nem fotografada — e é ela
  // que carrega o motivo de recusa da prefeitura, que é o texto longo.
  return venda;
}

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

  /**
   * Uma segunda comanda **com Pix vivo** (bloco 35).
   *
   * O QR Code é o elemento novo mais largo do produto, e ele só existe quando
   * há cobrança em aberto. Medir só a comanda sem cobrança deixaria justamente
   * a tela nova de fora — e é aos 360px que um código quadrado estoura.
   */
  let comPix = null;
  const segunda = await fetch(`${API}/v1/admin/orders`, {
    method: 'POST',
    headers: cabecalho,
    body: JSON.stringify({}),
  });
  if (segunda.ok) {
    const { id } = await segunda.json();
    await fetch(`${API}/v1/admin/orders/${id}/items`, {
      method: 'POST',
      headers: cabecalho,
      body: JSON.stringify({
        tipo: 'service',
        quantidade: 1,
        professionalId: proNome?.id,
        descricao: 'Corte degradê com máquina e tesoura',
        precoUnitarioCents: 129000,
      }),
    });
    const cobrada = await fetch(`${API}/v1/admin/orders/${id}/charges`, {
      method: 'POST',
      headers: { ...cabecalho, 'idempotency-key': 'medicao-pix' },
      body: JSON.stringify({ meio: 'pix' }),
    });
    if (cobrada.ok) comPix = id;
  }

  return { ok: true, orderId, comPix };
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

/**
 * Um pedido de titular aberto, o encarregado cadastrado e um consentimento
 * registrado — para a tela de privacidade ser medida cheia.
 *
 * A fila vazia é a versão fácil: mede-se o estado vazio, que é uma caixa de
 * texto curta, e não passa pela linha com prazo, motivo escrito e o formulário
 * de encerramento aberto, que é o que de fato disputa largura em 360px.
 */
async function prepararLgpd(token, clienteId) {
  if (!clienteId) return false;
  const cabecalho = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  await fetch(`${API}/v1/admin/change-window`, {
    method: 'PUT',
    headers: cabecalho,
    body: JSON.stringify({
      cancelMinHours: 2,
      rescheduleMinHours: 2,
      maxReschedules: 2,
      dpoName: 'Matheus Cardoso de Albuquerque',
      dpoEmail: 'protecao.de.dados@domaribarberclub.com.br',
    }),
  });

  await fetch(`${API}/v1/admin/customers/${clienteId}/consentimentos`, {
    method: 'PUT',
    headers: cabecalho,
    body: JSON.stringify({
      finalidade: 'marketing',
      concedido: true,
      versaoDoTexto: 'marketing-2026-08',
    }),
  });

  const aberto = await fetch(`${API}/v1/admin/customers/${clienteId}/lgpd/pedidos`, {
    method: 'POST',
    headers: cabecalho,
    body: JSON.stringify({ tipo: 'export' }),
  });
  if (!aberto.ok) return false;

  // Um segundo pedido, já respondido com motivo comprido: é a linha que mais
  // estica, e ela só aparece na seção "já respondidos".
  const outro = await fetch(`${API}/v1/admin/customers/${clienteId}/lgpd/pedidos`, {
    method: 'POST',
    headers: cabecalho,
    body: JSON.stringify({ tipo: 'deletion' }),
  });
  if (outro.ok) {
    const { id } = await outro.json();
    await fetch(`${API}/v1/admin/customers/lgpd/pedidos/${id}`, {
      method: 'PUT',
      headers: cabecalho,
      body: JSON.stringify({
        atendido: false,
        nota: 'Recusado por obrigação legal de guarda fiscal dos comprovantes por cinco anos',
      }),
    });
  }

  return true;
}

/**
 * Um cadastro avisado por retenção, para a tela de privacidade ser medida com a
 * lista cheia (bloco 32).
 *
 * Pelo banco e não pela API, como as métricas da plataforma acima: quem carimba
 * `retention_notified_at` é a varredura do worker, de madrugada, e a medição não
 * sobe worker. O que ela precisa é do **estado**, que é o que a tela desenha.
 *
 * Nome comprido de propósito: é ele que estoura a linha do cartão em 360px, ao
 * lado do prazo.
 */
function prepararRetencao(clienteId) {
  if (!clienteId) return false;
  psql(
    `UPDATE customers SET name = 'Sebastião Nascimento Albuquerque',` +
      ` retention_notified_at = now() - interval '27 days'` +
      ` WHERE id = '${clienteId}'`,
  );
  return true;
}

async function main() {
  const { token, slug } = await preparar();
  // Antes de qualquer tela: as gateadas fecham a própria porta quando o recurso
  // está desligado, e o resto da semeadura escreve dentro delas.
  ligarRecursos(slug);
  const tokenCliente = await prepararCliente(slug);
  const balcao = await prepararBalcao(token);
  await prepararRecursos(token);
  const filaPreparada = await prepararFila(token);
  const convitePreparado = await prepararConvite(slug);
  await prepararRecadosEFidelidade(slug);
  await prepararRecepcao(slug);
  await prepararPrecos(slug);
  await prepararFalhaNaFila(slug);
  await prepararMarketplace(slug);
  const barbeiro = prepararPerfilDoBarbeiro(slug);
  prepararDestaque(slug);
  prepararFranquia(slug);
  prepararChaves(slug);
  prepararWebhooks(slug);
  prepararFotos(slug, balcao.clienteId);
  await prepararPacotes(slug, balcao.clienteId);
  await prepararAvaliacoes(slug, balcao.clienteId);
  await prepararEstoque(slug);
  // Depois de `prepararEstoque`: o consumo é sobre produto que já existe, e
  // rodar antes fazia a semeadura sair vazia em silêncio.
  await prepararConsumo(slug);
  await prepararClube(slug, balcao.clienteId);
  prepararPlanoDoCliente(slug, '+5571988887777');
  await prepararAgenda(token, balcao.dia);
  const catalogo = await (await fetch(`${API}/v1/admin/catalog`, {
    headers: { authorization: `Bearer ${token}` },
  })).json();
  const caixa = await prepararCaixa(token, catalogo);
  prepararSplit(slug);
  prepararFinanceiro(slug);
  prepararValeEEstorno(slug);
  const vendaComNota = prepararFiscal(slug);
  prepararWhatsApp(slug);
  prepararAutomacoes(slug);
  prepararCampanha(slug);
  const emRisco = prepararSegmentos(slug);
  prepararUnidades(slug);
  prepararRecusaOnline(slug);
  const tokenBarbeiro = balcao.profissionalLivre
    ? await prepararBarbeiro(token, balcao.profissionalLivre)
    : null;
  if (!tokenBarbeiro) console.warn('  aviso: barbeiro não convidado; "meu dia" fora da medição');
  if (!caixa.ok) console.warn(`  aviso: caixa não preparado (${caixa.motivo})`);
  const importacao = await prepararImportacao(token);
  if (!importacao) console.warn('  aviso: importação não preparada; passo 2 fora da medição');
  const lgpd = await prepararLgpd(token, balcao.clienteId);
  if (!lgpd) console.warn('  aviso: LGPD não preparada; a fila de pedidos entra vazia');
  // Depois do `prepararLgpd`: ele registra consentimento e abre pedidos usando o
  // mesmo cliente, e renomeá-lo antes faria a ficha ser medida com outro nome.
  if (!prepararRetencao(balcao.clienteId)) {
    console.warn('  aviso: retenção não preparada; o aviso prévio entra vazio');
  }
  const daPlataforma = await prepararPlataforma();
  const tokenPlataforma = daPlataforma?.token ?? null;
  const tokenDeConsulta = daPlataforma?.tokenViewer ?? null;
  const agendamento = await prepararAgendamentoPublico(slug);
  if (!agendamento) {
    console.warn('  aviso: nenhum horário com preço de faixa; os passos 3 e 4 não entram');
  }

  const telas = [
    // A porta do produto. Não pertence a barbearia nenhuma e não precisa de
    // sessão — é a única tela medida sem nada preparado antes.
    { nome: 'landing', url: '/' },
    // A política de privacidade, que a Meta exige em URL pública para aprovar o
    // app na App Review. Sem sessão e sem dado preparado, como a landing — e é
    // a única tela do produto que é texto longo, onde o que quebra não é grade
    // e sim medida de linha.
    { nome: 'privacidade', url: '/privacidade' },
    // Onde a Stripe deixa quem pagou por link. Sem sessão e sem dado: é a
    // única tela do produto cujo endereço quem escolhe é o adquirente.
    { nome: 'retorno do pagamento', url: '/pagamento?pago=1' },
    { nome: 'pública', url: `/${slug}` },
    { nome: 'agendar', url: `/${slug}/agendar` },
    // A porta do agente (bloco 106). O estado sem resposta é o que todo mundo vê
    // primeiro; o com resposta tem percurso, que é onde ele é exercitado.
    { nome: 'conversar', url: `/${slug}/conversar` },
    ...(agendamento
      ? [
          {
            nome: 'agendar — horário',
            url: `/${slug}/agendar?s=${agendamento.servicoId}&p=${agendamento.profissionalId}`
              + `&d=${agendamento.dia}&e=h`,
          },
          {
            nome: 'agendar — confirmar',
            url: `/${slug}/agendar?s=${agendamento.servicoId}&p=${agendamento.profissionalId}`
              + `&d=${agendamento.dia}&h=${encodeURIComponent(agendamento.hora)}&e=d`,
          },
        ]
      : []),
    { nome: 'entrar (cliente)', url: `/${slug}/entrar` },
    { nome: 'meus agendamentos', url: `/${slug}/meus-agendamentos`, cookie: { nome: `sessao_${slug}`, valor: tokenCliente, caminho: `/${slug}` } },
    { nome: 'criar conta', url: '/admin/criar-conta' },
    { nome: 'entrar (gestor)', url: '/admin/entrar' },
    { nome: 'entrar (plataforma)', url: '/plataforma/entrar' },
    ...(tokenPlataforma
      ? [
          { nome: 'plataforma — barbearias', url: '/plataforma', cookie: { nome: 'plataforma', valor: tokenPlataforma, caminho: '/plataforma' } },
          ...(tokenDeConsulta
            ? [
                {
                  // A mesma tela para quem só consulta: sem botão de ação e com
                  // a frase que explica a ausência deles.
                  nome: 'plataforma — consulta',
                  url: '/plataforma',
                  cookie: { nome: 'plataforma', valor: tokenDeConsulta, caminho: '/plataforma' },
                },
              ]
            : []),
          { nome: 'plataforma — métricas', url: '/plataforma/metricas', cookie: { nome: 'plataforma', valor: tokenPlataforma, caminho: '/plataforma' } },
          { nome: 'plataforma — destaques', url: '/plataforma/destaques', cookie: { nome: 'plataforma', valor: tokenPlataforma, caminho: '/plataforma' } },
          { nome: 'plataforma — franquias', url: '/plataforma/franquias', cookie: { nome: 'plataforma', valor: tokenPlataforma, caminho: '/plataforma' } },
          { nome: 'plataforma — trilha', url: '/plataforma/trilha', cookie: { nome: 'plataforma', valor: tokenPlataforma, caminho: '/plataforma' } },
          { nome: 'plataforma — segurança', url: '/plataforma/seguranca', cookie: { nome: 'plataforma', valor: tokenPlataforma, caminho: '/plataforma' } },
          { nome: 'plataforma — cobrança', url: '/plataforma/faturas', cookie: { nome: 'plataforma', valor: tokenPlataforma, caminho: '/plataforma' } },
        ]
      : []),
    { nome: 'onboarding', url: '/admin/onboarding', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    {
      /**
       * A etapa 2 **preenchida** (bloco 111).
       *
       * `/admin/onboarding` sem parâmetro mostra a etapa 6 — a barbearia da
       * medição está publicada —, então a tela que este bloco mudou não
       * aparecia em largura nenhuma. É a regra da semente que produz o estado
       * novo: sem ela, o print é da tela de antes e a medição diz "ok" sobre o
       * que ninguém olhou.
       *
       * E é a tela real do caso: quem volta para corrigir o endereço chega
       * exatamente aqui, com a casa já no ar.
       */
      nome: 'onboarding — empresa',
      url: '/admin/onboarding?e=2',
      cookie: { nome: 'gestor', valor: token, caminho: '/admin' },
    },
    {
      /**
       * A etapa que **não desenha formulário** depois de a casa abrir.
       *
       * O domínio recusa desde o bloco 111, e recusar sozinho não basta:
       * oferecer o botão e depois negar é pior que não oferecer. O print é de
       * onde a pessoa cai, com para onde ir em seguida.
       */
      nome: 'onboarding — já no ar',
      url: '/admin/onboarding?e=3',
      cookie: { nome: 'gestor', valor: token, caminho: '/admin' },
    },
    { nome: 'configurações', url: '/admin/configuracoes', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'privacidade (LGPD)', url: '/admin/lgpd', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'fotos', url: '/admin/fotos', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'franquia', url: '/admin/franquia', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'rede da franquia', url: '/admin/rede', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
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
    ...(convitePreparado.link
      ? [
          { nome: 'convite de vaga', url: `/${slug}/vaga/${convitePreparado.link}` },
          // O caminho triste tem layout próprio, e é o que mais gente vê: quem
          // abre o link dez minutos depois.
          { nome: 'convite vencido', url: `/${slug}/vaga/${'x'.repeat(43)}` },
        ]
      : []),
    { nome: 'balcão — o dia', url: `/admin/dia?d=${balcao.dia}`, cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    {
      /**
       * O aviso da vaga que acabou de abrir (bloco 110).
       *
       * Ele vive num cookie de dois minutos gravado pelo handler que move o
       * atendimento — não dá para alcançá-lo por URL, e por isso a semente é o
       * próprio cookie. Sem ela, o print seria da tela **antes** da mudança e a
       * medição diria "ok" sobre o que ninguém olhou.
       *
       * Seis nomes contra o teto de cinco, de propósito: é o caso que mostra a
       * frase do resto ("falta 1") e o nome composto longo, que é o conteúdo
       * que decide a largura da coluna em 360px.
       */
      nome: 'balcão — vaga que abriu',
      url: `/admin/dia?d=${balcao.dia}`,
      cookie: [
        { nome: 'gestor', valor: token, caminho: '/admin' },
        { nome: 'vaga', valor: encodeURIComponent(JSON.stringify(vagaDaMedicao())), caminho: '/admin' },
      ],
    },
    {
      /**
       * O mesmo aviso para quem **não pode ver cliente** (bloco 38).
       *
       * O domínio devolve a linha com o nome em branco, e a tela precisa dizer a
       * contagem em vez de desenhar cinco nomes vazios. Sem este print, o caso
       * da recepção sem `customers.view` só seria olhado quando acontecesse.
       */
      nome: 'balcão — vaga sem nomes',
      url: `/admin/dia?d=${balcao.dia}`,
      cookie: [
        { nome: 'gestor', valor: token, caminho: '/admin' },
        { nome: 'vaga', valor: encodeURIComponent(JSON.stringify({ nomes: [], total: 4 })), caminho: '/admin' },
      ],
    },
    { nome: 'balcão — serviço', url: '/admin/dia/marcar', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'balcão — horário', url: `/admin/dia/marcar?s=${balcao.servicoId}&d=${balcao.dataLivre}&e=c`, cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    {
      nome: 'balcão — para quem',
      url: `/admin/dia/marcar?s=${balcao.servicoId}&p=${balcao.profissionalLivre}&d=${balcao.dataLivre}&h=${balcao.horaLivre}&e=d&q=nascimento`,
      cookie: { nome: 'gestor', valor: token, caminho: '/admin' },
    },
    { nome: 'segurança (MFA)', url: '/admin/seguranca', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'plano da barbearia', url: '/admin/plano', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'permissões por papel', url: '/admin/equipe/permissoes', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'caixa', url: '/admin/caixa', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'cobrar', url: '/admin/comanda', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    ...(caixa.ok
      ? [{ nome: 'comanda', url: `/admin/comanda/${caixa.orderId}`, cookie: { nome: 'gestor', valor: token, caminho: '/admin' } }]
      : []),
    ...(caixa.comPix
      ? [{ nome: 'comanda — Pix em curso', url: `/admin/comanda/${caixa.comPix}`, cookie: { nome: 'gestor', valor: token, caminho: '/admin' } }]
      : []),
    ...(vendaComNota
      ? [{ nome: 'comanda paga — nota', url: `/admin/comanda/${vendaComNota}`, cookie: { nome: 'gestor', valor: token, caminho: '/admin' } }]
      : []),
    { nome: 'fiado', url: '/admin/fiado', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'contas', url: '/admin/financeiro', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'comissão', url: '/admin/comissao', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'resultado', url: '/admin/dre', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'regras de comissão', url: '/admin/comissao/regras', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'avisos', url: '/admin/avisos', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'recados', url: '/admin/recados', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'recepção', url: '/admin/recepcao', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'avaliações', url: '/admin/avaliacoes', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'fidelidade', url: '/admin/fidelidade', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'pacotes', url: '/admin/pacotes', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'estoque', url: '/admin/estoque', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'clube', url: '/admin/clube', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'fale com a gente', url: `/${slug}/falar` },
    { nome: 'buscar barbearia', url: '/buscar' },
    ...(barbeiro ? [{ nome: 'perfil do barbeiro', url: `/${slug}/b/${barbeiro}` }] : []),
    // Com o filtro de disponibilidade ligado o card muda de forma — e é a única
    // largura em que a frase do truncamento aparece. Medir só a versão sem
    // filtro mediria a tela mais fácil.
    { nome: 'buscar — disponível hoje', url: '/buscar?disponivel=hoje' },
    // O painel entra com o segundo fator já provado (o `prepararCaixa` o liga),
    // porque é com o bloco de dinheiro desenhado que ele fica mais largo — medir
    // a versão sem faturamento mediria a tela mais fácil.
    { nome: 'painel', url: '/admin/painel', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'diagnóstico do catálogo', url: '/admin/catalogo/diagnostico', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'preços por horário', url: '/admin/precos', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'nota fiscal', url: '/admin/fiscal', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'whatsapp', url: '/admin/whatsapp', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'automações', url: '/admin/automacoes', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'campanhas', url: '/admin/campanhas', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'unidades', url: '/admin/unidades', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'chaves de API', url: '/admin/chaves', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'webhooks', url: '/admin/webhooks', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
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
    { nome: 'retenção', url: '/admin/retencao', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    // O assistente com resposta na tela, e não o campo vazio: o vazio mede a
    // versão fácil, e o que estoura layout é o número grande com as fatias.
    { nome: 'assistente', url: '/admin/assistente', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'assistente — respondendo', url: `/admin/assistente?p=${encodeURIComponent('quanto faturei por barbeiro este mês')}`, cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    // A ficha de quem tem ritmo (bloco 61). A do balcão tem uma visita só, e
    // sem ciclo a linha do ritmo não é escrita — mediria a tela sem o elemento
    // que o bloco acrescentou.
    ...(emRisco
      ? [{ nome: 'ficha — em risco', url: `/admin/cliente/${emRisco}`, cookie: { nome: 'gestor', valor: token, caminho: '/admin' } }]
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
      // Uma tela pode precisar de mais de um cookie: o aviso da vaga só existe
      // sobre a sessão do gestor, e é o segundo cookie que o traz para a tela.
      const cookies = tela.cookie ? [tela.cookie].flat() : [];
      if (cookies.length > 0) {
        await ctx.addCookies(
          cookies.map((c) => ({ name: c.nome, value: c.valor, domain: '127.0.0.1', path: c.caminho })),
        );
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
       * Esperar o CSS **aplicar**, e não só a rede sossegar.
       *
       * `networkidle` diz que nada mais está sendo baixado; não diz que a folha
       * de estilo já entrou em vigor. A janela entre as duas coisas é curta e
       * existe: nela a página é HTML cru, o trilho mede 17px de altura e o selo
       * transborda — e a medição reprova uma tela que está certa.
       *
       * Isso aconteceu de verdade: a tela de regras de comissão reprovou uma vez
       * em 360px e passou na execução seguinte, sem nenhuma mudança de CSS. Um
       * portão que inventa falha é pior que um lento — ele treina todo mundo a
       * ignorar vermelho.
       */
      try {
        await page.waitForFunction(
          () =>
            [...document.styleSheets].some((folha) => {
              try {
                return folha.cssRules.length > 0;
              } catch {
                // Folha de outra origem: se ela está listada, foi aplicada.
                return true;
              }
            }),
          { timeout: 5000 },
        );
      } catch {
        console.log(`FALHA ${tela.nome.padEnd(20)} ${largura}px o CSS não aplicou em 5s`);
        problemas += 1;
        await ctx.close();
        continue;
      }

      /**
       * Esperar a **fonte** também, e não só a folha de estilo.
       *
       * A fonte de display é mais larga que a de fallback, e a troca acontece
       * depois de o CSS já estar em vigor. Medir na janela entre as duas coisas
       * mede metrica de texto que a tela não vai ter — e erra **para menos**,
       * que é a direção perigosa: a medição aprova.
       *
       * Não foi isto que escondeu o transbordo da barra da plataforma (aquilo
       * era o `scrollWidth` clamped, logo abaixo), e está aqui pelo próprio
       * mérito: esta medição existe para conferir largura, e largura de texto
       * depende de qual fonte está aplicada no instante da conta.
       */
      try {
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
      } catch {
        console.log(`FALHA ${tela.nome.padEnd(20)} ${largura}px as fontes não carregaram`);
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
        /**
         * Os **dois** elementos, e o `body` é quem pega o caso difícil.
         *
         * `documentElement.scrollWidth` vem clamped quando o transbordo mora
         * dentro de um elemento `position: sticky`: o Chromium não propaga
         * aquele estouro para a caixa de rolagem do `<html>`. A barra do painel
         * da plataforma é sticky, e por isso 156px de transbordo em 390px
         * ficaram invisíveis para esta medição por vários blocos — com "ok" nas
         * quatro larguras, nas seis telas, enquanto dois destinos da navegação
         * ficavam fora do alcance de quem usa o celular.
         *
         * `body.scrollWidth` enxerga. Medido: 546 contra os 390 que o
         * `documentElement` relatava.
         */
        const rola =
          document.documentElement.scrollWidth > limite || document.body.scrollWidth > limite;

        /**
         * Conteúdo **cortado** por um ancestral que não rola (bloco 104).
         *
         * `rola` continua sendo cego no painel, e o motivo é estrutural: o casco
         * usa `.trabalho { overflow-x: clip }`, que corta antes de o estouro
         * chegar ao `body`. Uma tabela de 900px dentro de `<main>` em 390px
         * deixava 526px fora da tela, inalcançáveis — sem barra e sem pista de
         * que havia mais —, e esta medição respondia `rola: false` com
         * `estouram: []`. Toda tela de `/admin` estava nesse ponto cego, com o
         * portão fechando verde.
         *
         * O detector certo é o próprio elemento que corta: `scrollWidth` **vê**
         * o transbordo mesmo sob `clip`, o que foi conferido antes de escrever
         * esta linha (900 contra 390 num caso sintético).
         *
         * `auto` e `scroll` ficam de fora de propósito: ali a pessoa alcança o
         * resto com o dedo, que é o padrão `.ui-scroll-x` do projeto.
         *
         * O corte de 1px isenta `ui-visually-hidden` — conteúdo de leitor de
         * tela, invisível por desenho. É recorte estrutural e não lista de nomes
         * de classe: a próxima tela que use o padrão nasce isenta sem ninguém
         * lembrar dela, e nada além de 1px passa por engano.
         */
        const cortados = [];
        for (const el of document.querySelectorAll('body *')) {
          const overflow = getComputedStyle(el).overflowX;
          if (overflow !== 'clip' && overflow !== 'hidden') continue;
          if (el.clientWidth <= 1 || el.clientHeight <= 1) continue;

          /**
           * O que denuncia é um **filho de verdade** passando da borda, e não
           * `scrollWidth`.
           *
           * A primeira versão comparava `scrollWidth > clientWidth`, e a
           * primeira medição com ela acendeu três coisas — todas legítimas:
           *
           * - `.numero`, cujo `::after` é um brilho decorativo com
           *   `right: -30%`, sangrando de propósito para o `overflow: hidden`
           *   recortar. Pseudo-elemento conta no `scrollWidth` e não é filho;
           * - `input.ui-field__input`, em que o valor digitado é mais largo que
           *   a caixa — normal, e alcançável: o navegador rola o campo com o
           *   cursor;
           * - `path` de SVG, cuja caixa é coordenada de desenho e não layout.
           *
           * O filho real separa os três do defeito: uma tabela de 900px dentro
           * de `<main>` **é** um elemento, e o seu retângulo passa da borda do
           * recipiente. Texto solto e pseudo-elemento não são elementos, e por
           * isso saem sozinhos — sem lista de exceções por nome de classe.
           */
          /**
           * `ui-sangra` é a declaração do autor de que o recorte é enfeite.
           *
           * Par de `.ui-scroll-x`: um diz "rola, a pessoa alcança", o outro diz
           * "sangra, e não há o que alcançar". A faixa que corre da landing é
           * `max-content` animado — indistinguível, para esta varredura, de uma
           * tabela que perdeu colunas. A diferença é intenção, e intenção não se
           * deduz do layout: quem sabe é quem escreveu o CSS, e é lá que a
           * marca mora, ao lado da regra que a justifica.
           */
          const caixa = el.getBoundingClientRect();
          for (const filho of el.querySelectorAll('*')) {
            const r = filho.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;

            /**
             * Filho dentro de um rolador intermediário **é alcançável**.
             *
             * `.ui-scroll-x` é o padrão do projeto para conteúdo largo: a
             * tabela do clube e o heatmap das campanhas passam da borda do
             * casco de propósito, e a pessoa chega neles com o dedo. Sem parar
             * no primeiro `auto`/`scroll` entre o filho e o recipiente, a
             * varredura acusava justamente o padrão que ela existe para
             * incentivar — e o padrão está certo desde o bloco 5.
             */
            let alcancavel = false;
            for (let p = filho.parentElement; p && p !== el; p = p.parentElement) {
              const o = getComputedStyle(p).overflowX;
              if (o === 'auto' || o === 'scroll') { alcancavel = true; break; }
            }
            if (alcancavel) continue;

            /**
             * `ui-sangra` é a marca de **quem sangra**, e por isso é conferida
             * no filho — não no recipiente.
             *
             * A primeira versão marcava o recipiente, e a faixa da landing
             * continuou acusando: quem reclamava era `div.lp`, ancestral dela,
             * que não carrega a marca e nunca carregaria. Um enfeite que sangra
             * não conta contra recipiente nenhum, em nenhum nível.
             */
            if (filho.closest('.ui-sangra') !== null) continue;

            if (r.right > caixa.right + 1 || r.left < caixa.left - 1) {
              const nome = `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`;
              cortados.push(`${nome} (+${Math.round(r.right - caixa.right)}px)`);
              break;
            }
          }
        }

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
            /**
             * Os quatro contêm, e aqui isso está **certo**.
             *
             * As duas listas respondem perguntas diferentes, e confundi-las foi
             * o erro de uma primeira versão deste bloco:
             *
             * - `estouram` pergunta *"o conteúdo empurra a página para o
             *   lado?"*. `hidden` e `clip` impedem exatamente isso — eles
             *   contêm, e a faixa animada da landing é o caso legítimo;
             * - `cortados`, acima, pergunta *"o conteúdo foi cortado e ficou
             *   inalcançável?"*. Ali só `auto` e `scroll` valem, porque só neles
             *   a pessoa chega no resto com o dedo.
             *
             * Trocar o critério daqui fez a faixa da landing acusar em quatro
             * larguras sem nada estar errado. O que faltava não era mudar esta
             * pergunta: era fazer a outra.
             */
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
        // `summary` entra na varredura (bloco 104): ele é alvo autônomo — abre e
        // fecha uma dobra — e estava de fora, então nenhum `<details>` do
        // produto era medido. O da tela de importação saía com 24px.
        for (const el of document.querySelectorAll(
          'a[href], button, input, select, textarea, summary',
        )) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          /**
           * As **duas** medidas, e a segunda foi um achado (bloco 109).
           *
           * A guarda media só a altura. Uma seta de 39×44 passava verde nas
           * quatro larguras — e era exatamente o caso de `.balcao__seta`, o
           * "← Dia anterior" que troca o dia no painel e nas três vistas da
           * agenda: o controle mais usado do dia a dia.
           *
           * A regra do projeto é sobre o **alvo**, não sobre uma das dimensões
           * dele: "alvo de toque abaixo de 44px, em qualquer largura".
           */
          if (r.height < 44 || r.width < 44) {
            // Caixa e rádio dentro de um `<label>`: o alvo é o rótulo inteiro,
            // porque clicar em qualquer parte dele aciona o controle — que é
            // exatamente o que a WCAG 2.5.8 mede. Medir a caixinha de 13px
            // reprovava um padrão correto, e o padrão já existia no onboarding
            // desde o bloco 10 sem nunca ter sido medido: a régua de etapas
            // abre no passo publicado, e as caixas ficam nos passos 2 e 4.
            const tipo = el.getAttribute('type');
            if (el.tagName === 'INPUT' && (tipo === 'checkbox' || tipo === 'radio')) {
              const rotulo = el.closest('label');
              const caixa = rotulo?.getBoundingClientRect();
              if (caixa && caixa.height >= 44 && caixa.width >= 44) continue;
            }
            const dentroDeTexto = el.tagName === 'A' && el.parentElement
              && ['P', 'SPAN', 'LI', 'TD'].includes(el.parentElement.tagName)
              && (el.parentElement.textContent ?? '').trim() !== (el.textContent ?? '').trim();
            if (dentroDeTexto) continue;
            pequenos.push(
              `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0] || '(sem classe)'}`
              + ` "${(el.textContent ?? '').trim().slice(0, 24)}"`
              + ` ${Math.round(r.width)}×${Math.round(r.height)}px`,
            );
          }
        }

        return {
          rola,
          estouram: [...new Set(estouram)].slice(0, 4),
          cortados: [...new Set(cortados)].slice(0, 4),
          pequenos: [...new Set(pequenos)].slice(0, 4),
        };
      });

      resultados.push({ largura, ...medida });



      /**
       * O print, quando `MEDICAO_PRINTS` aponta para uma pasta.
       *
       * A medição vê rolagem, transbordo e alvo de toque — e é cega para o que
       * mais estraga uma tela: coluna que colapsa, texto que some de tão
       * apertado, botão desalinhado. No bloco 26 o cartão da barbearia passou
       * na medição com o nome espremido em noventa pixels, e só olhar pegou.
       *
       * **Depois de medir, e com a janela esticada.** O painel rola dentro do
       * próprio recipiente, então `fullPage` corta na altura da janela e a
       * primeira versão daqui fotografou só o topo de cada tela. Esticar antes
       * de medir mudaria o que se mede — a altura entra no cálculo de alvo de
       * toque e de transbordo.
       */
      if (PRINTS) {
        await page.setViewportSize({ width: largura, height: 2400 });
        const arquivo = `${tela.nome.replace(/[^\p{L}\p{N}]+/gu, '-')}-${largura}.png`;
        await page.screenshot({ path: `${PRINTS}/${arquivo}`, fullPage: true });
      }

      await ctx.close();
    }

    const ruins = resultados.filter(
      (r) => r.rola || r.estouram.length > 0 || r.cortados.length > 0 || r.pequenos.length > 0,
    );
    problemas += ruins.length;

    // Largura que nem chegou a ser medida não conta como aprovada: sem isto,
    // uma tela que falhou nas quatro ainda terminava com um "ok" embaixo.
    const marca = ruins.length === 0 && resultados.length === LARGURAS.length ? 'ok ' : 'FALHA';
    const medidas = resultados.map((r) => r.largura);
    console.log(`${marca} ${tela.nome.padEnd(20)} ${(medidas.length ? medidas : ['nenhuma largura medida']).join(' · ')}`);
    for (const r of ruins) {
      if (r.rola) console.log(`      ${r.largura}px rolagem horizontal na página`);
      if (r.estouram.length) console.log(`      ${r.largura}px estoura: ${r.estouram.join(', ')}`);
      // "Corta" e não "estoura": o conteúdo não empurra a página — ele some, e
      // quem lê não tem como saber que havia mais.
      if (r.cortados.length) console.log(`      ${r.largura}px corta: ${r.cortados.join(', ')}`);
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
