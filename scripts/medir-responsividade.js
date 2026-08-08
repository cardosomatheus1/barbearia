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

const { chromium } = require('/opt/node22/lib/node_modules/playwright');
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

  return {
    dia: dataLivre,
    servicoId: servico.id,
    dataLivre,
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

async function main() {
  const { token, slug } = await preparar();
  const tokenCliente = await prepararCliente(slug);
  const balcao = await prepararBalcao(token);
  await prepararRecursos(token);
  const filaPreparada = await prepararFila(token);

  const telas = [
    { nome: 'pública', url: `/${slug}` },
    { nome: 'agendar', url: `/${slug}/agendar` },
    { nome: 'entrar (cliente)', url: `/${slug}/entrar` },
    { nome: 'meus agendamentos', url: `/${slug}/meus-agendamentos`, cookie: { nome: `sessao_${slug}`, valor: tokenCliente, caminho: `/${slug}` } },
    { nome: 'criar conta', url: '/admin/criar-conta' },
    { nome: 'entrar (gestor)', url: '/admin/entrar' },
    { nome: 'onboarding', url: '/admin/onboarding', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'configurações', url: '/admin/configuracoes', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'fotos', url: '/admin/fotos', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'equipe', url: '/admin/equipe', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'catálogo', url: '/admin/catalogo', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'profissionais', url: '/admin/profissionais', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'jornada aberta', url: `/admin/profissionais?pessoa=${balcao.profissionalLivre}`, cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'recursos', url: '/admin/recursos', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'trocar senha', url: '/admin/trocar-senha', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
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
  ];

  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
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
      await page.goto(`${WEB}${tela.url}`, { waitUntil: 'networkidle' });

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

          // Conteúdo largo pode passar, desde que role dentro do próprio
          // recipiente e não leve a página junto.
          let pai = el.parentElement;
          let emRecipienteQueRola = false;
          while (pai) {
            if (getComputedStyle(pai).overflowX === 'auto') { emRecipienteQueRola = true; break; }
            pai = pai.parentElement;
          }
          if (emRecipienteQueRola) continue;

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

    const marca = ruins.length === 0 ? 'ok ' : 'FALHA';
    console.log(`${marca} ${tela.nome.padEnd(20)} ${LARGURAS.join(' · ')}`);
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
