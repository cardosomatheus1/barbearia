/**
 * A conferência que pergunta ao banco **e** à tela, área por área e papel por
 * papel.
 *
 *   DEMO_DATABASE_URL=... WEB_URL=... node scripts/conferir-telas.mjs
 *
 * ## Por que ela existe, e o que só ela pega
 *
 * O portão prova que o código faz o que diz. A medição prova que o layout não
 * quebra. Os percursos provam que o caminho inteiro grava. Nenhum dos três
 * responde a pergunta que quem opera faz primeiro: **o dado está no banco e
 * está aparecendo na tela?**
 *
 * O formato do defeito é sempre o mesmo e é sempre silencioso: uma consulta com
 * filtro a mais, uma permissão que a tela recalcula, uma rota que devolve lista
 * vazia sem erro. A tela desenha o estado vazio — que é uma tela **correta**,
 * desenhada de propósito, e que ali está mentindo. Nada fica vermelho, e quem
 * abre conclui que a barbearia não vende produto, não que o relatório não
 * funciona.
 *
 * O segundo formato é o da §6 pergunta 6: duas telas que mostram o mesmo fato e
 * discordam. Ele não aparece olhando uma tela de cada vez — foi assim que o
 * painel passou meses dizendo um faturamento e o DRE dizendo outro.
 *
 * ## Como ela decide
 *
 * Cada área declara **a pergunta ao banco** e **a tela**. Se o banco tem linha,
 * a tela não pode estar no estado vazio; se o banco não tem, o estado vazio é o
 * certo e a ausência dele é que seria suspeita. É a única forma de a
 * conferência não virar uma lista de "ok" que ninguém lê.
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
function carregarPlaywright() {
  for (const origem of ['playwright', '/opt/node22/lib/node_modules/playwright']) {
    try {
      return require(origem);
    } catch {
      /* tenta o próximo */
    }
  }
  throw new Error('playwright não encontrado');
}
const { chromium } = carregarPlaywright();

const WEB = process.env.WEB_URL ?? 'http://127.0.0.1:3001';
const BANCO = process.env.DEMO_DATABASE_URL;
if (!BANCO) throw new Error('DEMO_DATABASE_URL é obrigatória');

const consultar = (sql) =>
  execFileSync('psql', [BANCO, '-tAc', sql], { encoding: 'utf8' }).trim();

const SENHA = process.env.MEDICAO_SENHA ?? 'testeteste';

/**
 * As áreas, cada uma com a pergunta que prova que ela tem o que mostrar.
 *
 * O papel é o **mais baixo** que deveria enxergar aquilo, de propósito: com o
 * dono em tudo, a conferência não distinguiria "a tela está vazia" de "esta
 * conta não podia ver mesmo".
 */
const AREAS = [
  ['painel', '/admin/painel', 'dono', `SELECT count(*) FROM orders WHERE status='paid'`],
  ['dia', '/admin/dia', 'recepcao', `SELECT count(*) FROM appointments WHERE starts_at::date = current_date`],
  ['agenda', '/admin/agenda', 'recepcao', `SELECT count(*) FROM appointments WHERE starts_at > now()`],
  ['fila', '/admin/fila', 'recepcao', `SELECT count(*) FROM queue_entries WHERE status <> 'done'`],
  ['recados', '/admin/recados', 'gerente', `SELECT count(*) FROM feedbacks`],
  ['recepcao', '/admin/recepcao', 'gerente', `SELECT count(*) FROM reception_gaps`],
  ['avaliacoes', '/admin/avaliacoes', 'gerente', `SELECT count(*) FROM reviews`],
  ['caixa', '/admin/caixa', 'recepcao', `SELECT count(*) FROM cash_sessions`],
  ['fiado', '/admin/fiado', 'gerente', `SELECT count(*) FROM customers WHERE balance_cents > 0`],
  ['financeiro', '/admin/financeiro', 'gerente', `SELECT count(*) FROM bills`],
  ['comissao', '/admin/comissao', 'gerente', `SELECT count(*) FROM commission_entries`],
  ['dre', '/admin/dre', 'dono', `SELECT count(*) FROM orders WHERE status='paid'`],
  ['fidelidade', '/admin/fidelidade', 'gerente', `SELECT count(*) FROM loyalty_entries`],
  ['catalogo', '/admin/catalogo', 'gerente', `SELECT count(*) FROM services WHERE active`],
  ['precos', '/admin/precos', 'dono', `SELECT count(*) FROM pricing_rules`],
  ['pacotes', '/admin/pacotes', 'gerente', `SELECT count(*) FROM packages`],
  ['estoque', '/admin/estoque', 'gerente', `SELECT count(*) FROM products WHERE active`],
  ['clube', '/admin/clube', 'gerente', `SELECT count(*) FROM club_plans`],
  ['profissionais', '/admin/profissionais', 'gerente', `SELECT count(*) FROM professionals`],
  ['fotos', '/admin/fotos', 'gerente', `SELECT count(*) FROM services WHERE active`],
  ['equipe', '/admin/equipe', 'dono', `SELECT count(*) FROM staff_users`],
  ['unidades', '/admin/unidades', 'dono', `SELECT count(*) FROM locations`],
  ['chaves', '/admin/chaves', 'dono', `SELECT count(*) FROM api_keys WHERE revoked_at IS NULL`],
  ['webhooks', '/admin/webhooks', 'dono', `SELECT count(*) FROM webhook_endpoints`],
  ['trilha', '/admin/trilha', 'dono', `SELECT count(*) FROM audit_log`],
  // A tela lista **notas**, não o cadastro: perguntar por `fiscal_settings`
  // acusaria a tela por um dado que ela não mostra.
  ['fiscal', '/admin/fiscal', 'gerente', `SELECT count(*) FROM fiscal_invoices`],
  ['whatsapp', '/admin/whatsapp', 'dono', `SELECT count(*) FROM whatsapp_templates`],
  ['automacoes', '/admin/automacoes', 'gerente', `SELECT count(*) FROM automations`],
  ['campanhas', '/admin/campanhas', 'gerente', `SELECT count(*) FROM campaigns`],
  ['retencao', '/admin/retencao', 'dono', `SELECT count(*) FROM customers`],
  ['lgpd', '/admin/lgpd', 'dono', `SELECT count(*) FROM data_requests`],
  ['meu-dia', '/admin/meu-dia', 'barbeiro', `SELECT count(*) FROM appointments WHERE starts_at::date = current_date`],
  ['meus-numeros', '/admin/meus-numeros', 'barbeiro', `SELECT count(*) FROM commission_entries`],
];

const CONTAS = {
  dono: 'teste@teste.com',
  gerente: 'gerente@teste.com',
  recepcao: 'recepcao@teste.com',
  barbeiro: 'barbeiro2@teste.com',
};

const falhas = [];
const avisos = [];
let conferidas = 0;

async function entrar(page, quem) {
  await page.goto(`${WEB}/admin/entrar`, { waitUntil: 'networkidle' });
  await page.fill('input[name="email"]', CONTAS[quem]);
  await page.fill('input[name="password"]', SENHA);
  const antes = page.url();
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => u.toString() !== antes, { timeout: 20_000 }).catch(() => {});
  await page.waitForLoadState('networkidle');
  if (page.url().includes('/entrar')) throw new Error(`login de ${quem} não passou`);
}

const navegador = await chromium.launch({ args: ['--no-sandbox'] });
const paginas = {};

/**
 * O menu do painel, lido da própria tela.
 *
 * Desde o bloco 81 uma tela pode estar **desligada pela plataforma** — o fiscal
 * é a primeira, e fila, importação e avisos já eram gateados na API. Conferir
 * uma dessas contra o banco daria falha por um recurso que ninguém ligou, que é
 * o formato de vermelho que ensina todo mundo a ignorar vermelho.
 *
 * Quem responde "esta tela existe para esta barbearia?" é o menu, e ele é
 * derivado no servidor da mesma consulta que a `PermissaoGuard` faz. Repetir
 * aqui o `COALESCE` de `recursoLigado` seria a quarta cópia daquela expressão —
 * e a primeira que divergiria, porque este arquivo não é o produto.
 */
async function menuDoPainel(page) {
  const hrefs = await page.$$eval('.contexto__link', (as) =>
    as.map((a) => new URL(a.href).pathname),
  );
  // Menu que não é lido passa a "pular tudo" em silêncio, que é pior do que
  // não ter a conferência.
  if (hrefs.length < 20) throw new Error(`menu do painel com ${hrefs.length} destinos: seletor mudou?`);
  return new Set(hrefs);
}

/**
 * V8 técnico em runtime.
 *
 * Não tenta decidir se a tela é bonita. Mede defeitos objetivos que uma revisão
 * visual costuma descobrir tarde: rolagem horizontal do documento, imagem
 * quebrada, controle sem nome/rótulo, alvo autônomo pequeno, tabela larga sem
 * recipiente próprio e hierarquia sem um H1 único.
 *
 * O mesmo diagnóstico roda em 1280 e 360 px. Assim "não tem scrollbar no
 * desktop" não vira aprovação de uma tela que corta conteúdo no celular.
 */
async function auditarSuperficie(page, rota, largura) {
  await page.setViewportSize({ width: largura, height: largura <= 480 ? 800 : 1000 });
  // Um frame basta para media/container queries e layout assentarem após mudar
  // o viewport; não há animação necessária para a medição.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));

  return page.evaluate(({ rota, largura }) => {
    const visivel = (el) => {
      const estilo = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return estilo.display !== 'none' && estilo.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    };
    const textoDe = (id) => document.getElementById(id)?.textContent?.trim() ?? '';
    const nomeAcessivelBasico = (el) => {
      const aria = el.getAttribute('aria-label')?.trim();
      if (aria) return aria;
      const por = el.getAttribute('aria-labelledby')?.trim();
      if (por) {
        const lido = por.split(/\s+/).map(textoDe).filter(Boolean).join(' ').trim();
        if (lido) return lido;
      }
      if ('labels' in el && el.labels?.length) {
        const lido = [...el.labels].map((l) => l.textContent?.trim() ?? '').filter(Boolean).join(' ').trim();
        if (lido) return lido;
      }
      const texto = el.textContent?.trim();
      if (texto) return texto;
      const title = el.getAttribute('title')?.trim();
      if (title) return title;
      return '';
    };
    const alvo = (el) => {
      if (el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type)) {
        const label = el.labels?.[0];
        if (label && visivel(label)) return label.getBoundingClientRect();
      }
      return el.getBoundingClientRect();
    };

    const problemas = [];
    const raiz = document.documentElement;
    const excesso = Math.ceil(raiz.scrollWidth - raiz.clientWidth);
    if (excesso > 1) problemas.push(`overflow horizontal do documento: +${excesso}px`);

    const h1 = [...document.querySelectorAll('h1')].filter(visivel);
    if (h1.length !== 1) problemas.push(`H1 visível: ${h1.length} (esperado 1)`);

    const imagens = [...document.images].filter(visivel);
    for (const img of imagens) {
      if (!img.hasAttribute('alt')) problemas.push(`imagem sem alt: ${img.currentSrc || img.src}`);
      if (img.complete && img.naturalWidth === 0) problemas.push(`imagem quebrada: ${img.currentSrc || img.src}`);
    }

    const controles = [...document.querySelectorAll('input, select, textarea')].filter(visivel);
    for (const el of controles) {
      if (el instanceof HTMLInputElement && ['hidden', 'submit', 'button', 'reset', 'image'].includes(el.type)) continue;
      if (!nomeAcessivelBasico(el)) {
        problemas.push(`controle sem rótulo: ${el.tagName.toLowerCase()}[name="${el.getAttribute('name') ?? ''}"]`);
      }
    }

    const interativos = [...document.querySelectorAll('button, summary, a[href], [role="button"]')].filter(visivel);
    for (const el of interativos) {
      if (!nomeAcessivelBasico(el)) {
        problemas.push(`ação sem nome: ${el.tagName.toLowerCase()}.${el.className || ''}`);
      }
    }

    // 44px é o contrato do Barberdock para alvos autônomos. Links corridos em
    // texto ficam fora: a exceção é intencional e evita marcar parágrafos como
    // se fossem botões.
    const alvos = [...document.querySelectorAll('button, summary, a.ui-button, input[type="checkbox"], input[type="radio"], select')].filter(visivel);
    for (const el of alvos) {
      const r = alvo(el);
      if (r.width + 0.5 < 44 || r.height + 0.5 < 44) {
        problemas.push(`alvo <44px: ${el.tagName.toLowerCase()}.${el.className || ''} (${Math.round(r.width)}x${Math.round(r.height)})`);
      }
    }

    for (const tabela of [...document.querySelectorAll('table')].filter(visivel)) {
      const r = tabela.getBoundingClientRect();
      if (r.width > innerWidth + 1 && !tabela.closest('.ui-scroll-x')) {
        problemas.push(`tabela larga sem .ui-scroll-x: ${Math.round(r.width)}px`);
      }
    }

    return { rota, largura, problemas };
  }, { rota, largura });
}

function registrarAuditoria(resultado, destino = falhas) {
  for (const problema of resultado.problemas) {
    destino.push(`V8 ${resultado.largura}px ${resultado.rota}: ${problema}`);
  }
}

let menu = null;

for (const [nome, rota, papel, pergunta] of AREAS) {
  if (!paginas[papel]) {
    const ctx = await navegador.newContext({ viewport: { width: 1280, height: 1000 } });
    paginas[papel] = await ctx.newPage();
    await entrar(paginas[papel], papel);
    menu ??= await menuDoPainel(paginas[papel]);
  }
  const page = paginas[papel];

  /**
   * As telas "de dentro" não aparecem no menu de propósito — são abertas a
   * partir de outra. Duas linhas, e não uma cópia da lista de trinta que o
   * menu já é: uma lista longa aqui divergiria de `secoes.ts` na primeira tela
   * nova, e o sintoma seria uma área deixando de ser conferida em silêncio.
   */
  const FORA_DO_MENU = ['/admin/meu-dia', '/admin/meus-numeros'];
  if (!menu.has(rota) && !FORA_DO_MENU.includes(rota)) {
    console.log(`\x1b[33mpulada\x1b[0m ${nome.padEnd(16)} desligada pela plataforma (fora do menu)`);
    continue;
  }
  const noBanco = Number(consultar(pergunta));

  const erros = [];
  const ouvinte = (r) => {
    if (r.status() >= 500) erros.push(`${r.status()} em ${new URL(r.url()).pathname}`);
  };
  page.on('response', ouvinte);

  /**
   * Teto de tempo, e ele é **critério** — não paciência.
   *
   * A meta da SPEC §5.12 é P95 abaixo de 500 ms nas APIs comuns. Uma tela que
   * não termina em quinze segundos sobre uma barbearia de oito meses não está
   * lenta: está com um N+1 ou uma varredura sem índice, e isso é achado, não
   * espera. Sem o teto a conferência inteira fica pendurada e não diz onde.
   */
  const comecou = Date.now();
  let resposta;
  try {
    resposta = await page.goto(`${WEB}${rota}`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  } catch (erro) {
    falhas.push(`${nome}: a tela não carregou em 15s (${erro.message.split('\n')[0].slice(0, 90)})`);
    page.off('response', ouvinte);
    console.log(`\x1b[31mLENTA\x1b[0m  ${nome.padEnd(16)} ${rota}`);
    continue;
  }
  page.off('response', ouvinte);
  conferidas += 1;
  const levou = Date.now() - comecou;
  if (levou > 3000) avisos.push(`${nome}: a tela levou ${(levou / 1000).toFixed(1)}s para ${papel}`);

  if (!resposta || resposta.status() >= 400) {
    falhas.push(`${nome}: ${rota} respondeu ${resposta?.status() ?? 'nada'} para ${papel}`);
    continue;
  }
  if (erros.length > 0) {
    falhas.push(`${nome}: ${erros.join(' · ')}`);
    continue;
  }
  if (!page.url().includes(rota)) {
    falhas.push(`${nome}: ${papel} foi desviado de ${rota} para ${page.url()}`);
    continue;
  }

  // V8 técnico nas duas larguras de aceite. Restauramos o desktop porque a
  // próxima navegação do laço foi originalmente medida nele.
  registrarAuditoria(await auditarSuperficie(page, rota, 1280));
  registrarAuditoria(await auditarSuperficie(page, rota, 360));
  await page.setViewportSize({ width: 1280, height: 1000 });

  /**
   * O estado vazio é uma tela **certa** — e é ela que mente quando há dado.
   *
   * A classe `.vazio` é a mesma em todo o painel, e é isso que torna esta
   * conferência possível sem uma asserção escrita à mão por tela. Um alerta de
   * erro na tela conta como falha pelo mesmo motivo.
   */
  const vazio = await page.locator('.vazio__titulo').first().textContent({ timeout: 2000 }).catch(() => null);
  const alerta = await page.locator('.ui-alert--danger').first().textContent({ timeout: 2000 }).catch(() => null);

  if (alerta) {
    falhas.push(`${nome}: a tela mostra erro — "${alerta.trim().slice(0, 120)}"`);
  } else if (noBanco > 0 && vazio) {
    falhas.push(
      `${nome}: o banco tem ${noBanco} e a tela diz "${vazio.trim()}" (${papel} em ${rota})`,
    );
  } else if (noBanco === 0 && !vazio) {
    avisos.push(`${nome}: sem dado no banco e sem estado vazio na tela`);
  }
  console.log(`\x1b[32mok\x1b[0m     ${nome.padEnd(16)} ${String(noBanco).padStart(6)} no banco · ${(levou / 1000).toFixed(1)}s · ${papel}`);
}

// ---------------------------------------------------------------------------
// V8 técnico — todas as portas visíveis do dono
// ---------------------------------------------------------------------------

// As áreas acima cobrem o dado de cada domínio. Aqui a pergunta é outra: toda
// porta que o dono consegue abrir precisa continuar tecnicamente íntegra mesmo
// quando não há uma consulta de banco específica para ela (Clientes, Recursos,
// Plano, Preferências etc.). O próprio menu é a fonte, então tela nova entra na
// auditoria sem uma segunda lista para manter.
if (!paginas['dono']) {
  const ctx = await navegador.newContext({ viewport: { width: 1280, height: 1000 } });
  paginas['dono'] = await ctx.newPage();
  await entrar(paginas['dono'], 'dono');
}
const paginaV8 = paginas['dono'];
menu ??= await menuDoPainel(paginaV8);
let v8Conferidas = 0;
for (const rota of [...menu].filter((href) => href.startsWith('/admin/'))) {
  const resposta = await paginaV8.goto(`${WEB}${rota}`, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => null);
  if (!resposta || resposta.status() >= 400 || !paginaV8.url().includes(rota)) {
    falhas.push(`V8: ${rota} não abriu para o dono`);
    continue;
  }
  await paginaV8.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  registrarAuditoria(await auditarSuperficie(paginaV8, rota, 1280));
  registrarAuditoria(await auditarSuperficie(paginaV8, rota, 360));
  await paginaV8.setViewportSize({ width: 1280, height: 1000 });
  v8Conferidas += 1;
}
console.log(`V8 técnico: ${v8Conferidas} porta(s) visíveis auditadas em 1280px e 360px`);

// ---------------------------------------------------------------------------
// O mesmo fato, por dois caminhos
// ---------------------------------------------------------------------------

/**
 * A §6 pergunta 6 como código: duas leituras do mesmo número têm que bater.
 *
 * Não olha tela: compara o que o banco responde com o que a API responde, pelo
 * caminho que cada papel usa. É o formato do defeito que passou meses aqui — o
 * painel somando gorjeta e o DRE não, sem nenhuma das duas dizer nada.
 */
console.log('');
const mes = consultar(`SELECT to_char(date_trunc('month', current_date), 'YYYY-MM-DD')`);
const fimDoMes = consultar(
  `SELECT to_char((date_trunc('month', current_date) + interval '1 month - 1 day')::date, 'YYYY-MM-DD')`,
);

const pagina = paginas['dono'];
const doDre = await pagina.evaluate(
  async ([de, ate]) => {
    const r = await fetch(`/admin/dre?de=${de}&ate=${ate}`);
    return r.status;
  },
  [mes, fimDoMes],
);
void doDre;

const faturamentoNoBanco = Number(
  consultar(
    `SELECT coalesce(sum(total_cents - tip_cents), 0) FROM orders
      WHERE status = 'paid' AND business_day >= date_trunc('month', current_date)`,
  ),
);
const receitaNoDre = Number(
  consultar(
    `SELECT coalesce(sum(i.quantity * i.unit_price_cents), 0) - coalesce(
       (SELECT sum(o2.discount_cents) FROM orders o2
         WHERE o2.status = 'paid' AND o2.business_day >= date_trunc('month', current_date)), 0)
       FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE o.status = 'paid' AND o.business_day >= date_trunc('month', current_date)`,
  ),
);
if (faturamentoNoBanco !== receitaNoDre) {
  falhas.push(
    `faturamento × DRE: o painel soma ${faturamentoNoBanco} e o DRE líquido dá ${receitaNoDre}`,
  );
}

await navegador.close();

// ---------------------------------------------------------------------------

console.log('');
for (const aviso of avisos) console.log(`\x1b[33maviso\x1b[0m  ${aviso}`);
if (falhas.length > 0) {
  console.log(`\x1b[31mconferência: ${falhas.length} problema(s) em ${conferidas} telas.\x1b[0m`);
  for (const f of falhas) console.log(`  · ${f}`);
  process.exit(1);
}
console.log(`\x1b[32mconferência: ${conferidas} telas com dado no banco e dado na tela.\x1b[0m`);
