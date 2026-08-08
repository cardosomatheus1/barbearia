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

async function main() {
  const { token, slug } = await preparar();
  const tokenCliente = await prepararCliente(slug);

  const telas = [
    { nome: 'pública', url: `/${slug}` },
    { nome: 'agendar', url: `/${slug}/agendar` },
    { nome: 'entrar (cliente)', url: `/${slug}/entrar` },
    { nome: 'meus agendamentos', url: `/${slug}/meus-agendamentos`, cookie: { nome: `sessao_${slug}`, valor: tokenCliente, caminho: `/${slug}` } },
    { nome: 'criar conta', url: '/admin/criar-conta' },
    { nome: 'entrar (gestor)', url: '/admin/entrar' },
    { nome: 'onboarding', url: '/admin/onboarding', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
    { nome: 'configurações', url: '/admin/configuracoes', cookie: { nome: 'gestor', valor: token, caminho: '/admin' } },
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
      if (tela.cookie) {
        await ctx.addCookies([
          { name: tela.cookie.nome, value: tela.cookie.valor, domain: '127.0.0.1', path: tela.cookie.caminho },
        ]);
      }
      const page = await ctx.newPage();
      await page.goto(`${WEB}${tela.url}`, { waitUntil: 'networkidle' });

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
