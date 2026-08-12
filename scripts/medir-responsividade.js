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

  // O cartão na conta (bloco 29): a tela do plano tem dois estados, e o
  // preenchido é o que tem marca, final e validade na mesma linha.
  psql(
    `INSERT INTO billing_customers (tenant_id, psp_customer_id, psp_method_id, brand, last4,` +
      ` exp_month, exp_year) SELECT tenant_id, 'cus_medicao', 'pm_medicao', 'mastercard',` +
      ` '4242', 11, 2029 FROM tenant_platform ON CONFLICT DO NOTHING`,
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
    `select id from appointments where tenant_id = '${tenant}' order by starts_at limit 4`,
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

  psql(
    `INSERT INTO tenant_features (tenant_id, flag_code, enabled) VALUES ('${tenant}', 'avisos', true)
       ON CONFLICT (tenant_id, flag_code) DO UPDATE SET enabled = true`,
  );

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

  psql(
    `INSERT INTO whatsapp_settings
       (location_id, tenant_id, status, phone_number_id, waba_id, display_phone,
        access_token_cipher, verified_at)
     VALUES ('${local}', '${tenant}', 'ativo', '109876543210987', '102030405060708',
             '+55 71 3333-4444', 'nonce.tag.dados', now())
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
  const tokenCliente = await prepararCliente(slug);
  const balcao = await prepararBalcao(token);
  await prepararRecursos(token);
  const filaPreparada = await prepararFila(token);
  const convitePreparado = await prepararConvite(slug);
  await prepararRecadosEFidelidade(slug);
  await prepararPacotes(slug, balcao.clienteId);
  await prepararAvaliacoes(slug, balcao.clienteId);
  await prepararEstoque(slug);
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
          { nome: 'plataforma — cobrança', url: '/plataforma/faturas', cookie: { nome: 'plataforma', valor: tokenPlataforma, caminho: '/plataforma' } },
        ]
      : []),
    { nome: 'onboarding', url: '/admin/onboarding', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'configurações', url: '/admin/configuracoes', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'privacidade (LGPD)', url: '/admin/lgpd', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
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
    ...(convitePreparado.link
      ? [
          { nome: 'convite de vaga', url: `/${slug}/vaga/${convitePreparado.link}` },
          // O caminho triste tem layout próprio, e é o que mais gente vê: quem
          // abre o link dez minutos depois.
          { nome: 'convite vencido', url: `/${slug}/vaga/${'x'.repeat(43)}` },
        ]
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
    { nome: 'avaliações', url: '/admin/avaliacoes', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'fidelidade', url: '/admin/fidelidade', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'pacotes', url: '/admin/pacotes', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'estoque', url: '/admin/estoque', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'clube', url: '/admin/clube', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'fale com a gente', url: `/${slug}/falar` },
    // O painel entra com o segundo fator já provado (o `prepararCaixa` o liga),
    // porque é com o bloco de dinheiro desenhado que ele fica mais largo — medir
    // a versão sem faturamento mediria a tela mais fácil.
    { nome: 'painel', url: '/admin/painel', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'diagnóstico do catálogo', url: '/admin/catalogo/diagnostico', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'nota fiscal', url: '/admin/fiscal', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'whatsapp', url: '/admin/whatsapp', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
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
