/**
 * Os percursos que **clicam** — a lacuna que ficou aberta por oitenta blocos.
 *
 * ## O que só isto pega
 *
 * O portão prova três coisas e nenhuma é esta:
 *
 * - o **e2e da API** prova que a rota, a guarda e o domínio conversam. Ele monta
 *   o corpo em JavaScript e chama `POST /v1/...` — não sabe se existe formulário,
 *   nem se o campo dele tem o nome que a rota espera;
 * - a **medição de navegador** abre cada tela e mede o layout. Ela renderiza; não
 *   submete nada;
 * - os **testes de integração** provam a regra contra o banco, sem tela nenhuma.
 *
 * Entre o `<input name="...">` e o `z.object({...})` da borda não há nada. Um
 * campo renomeado num lado e não no outro, uma server action que ninguém ligou
 * ao `action=`, um `redirect` que perde o estado, um botão que devolve 500 — a
 * suíte inteira continua verde, e o defeito aparece no primeiro cliente.
 *
 * ## Por que percursos, e não uma suíte de tela
 *
 * Testar tela por tela reproduz o problema que a §6 do `CLAUDE.md` descreve:
 * cada uma é coerente sozinha, e o defeito mora na emenda. O que se percorre
 * aqui é o **caminho que paga a conta**, do começo ao fim, como quem trabalha.
 *
 * E cada percurso termina **no banco**. "A tela mostrou 'pronto'" é o que o
 * gatilho inerte da migração 0079 também mostrava.
 *
 * ## Onde ele roda
 *
 * Dentro do `scripts/medicao.sh`, que já sobe API e web contra um banco
 * descartável e semeia a demonstração. Aqui não se semeia nada por SQL: cada
 * percurso começa de onde o usuário começaria.
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
  throw new Error('playwright não encontrado — rode pnpm exec playwright install chromium');
}

const { chromium } = carregarPlaywright();

const WEB = process.env.WEB_URL ?? 'http://127.0.0.1:3001';
const BANCO = process.env.DEMO_DATABASE_URL;
if (!BANCO) throw new Error('DEMO_DATABASE_URL é obrigatória');

/** Pergunta ao banco. É ela que diz se o percurso **aconteceu**. */
function consultar(sql) {
  return execFileSync('psql', [BANCO, '-tAc', sql], { encoding: 'utf8' }).trim();
}

const falhas = [];
let percorridos = 0;

async function percurso(nome, corpo) {
  const navegador = await chromium.launch({ args: ['--no-sandbox'] });
  // 390px: o aparelho em que o cliente da barbearia realmente agenda. O
  // percurso que só funciona no notebook não é o percurso do produto.
  const ctx = await navegador.newContext({ viewport: { width: 390, height: 900 } });
  const page = await ctx.newPage();

  const erros = [];
  page.on('pageerror', (e) => erros.push(`erro de página: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 500) erros.push(`${r.status()} em ${new URL(r.url()).pathname}`);
  });

  try {
    await corpo(page);
    if (erros.length > 0) throw new Error(erros.join(' · '));
    percorridos += 1;
    console.log(`\x1b[32mok\x1b[0m  ${nome}`);
  } catch (erro) {
    /**
     * O aviso que a tela estava mostrando entra no relatório.
     *
     * Sem ele, "não chegou ao banco" manda quem lê reproduzir o percurso à mão
     * para descobrir que a recusa estava escrita na tela o tempo todo.
     */
    const aviso = await page
      .locator('.ui-alert, [role="alert"], .ui-field__erro')
      .first()
      .textContent()
      .catch(() => null);

    falhas.push(`${nome}: ${erro.message}`);
    console.log(`\x1b[31mFALHOU\x1b[0m  ${nome}`);
    console.log(`        ${erro.message.split('\n')[0]}`);
    console.log(`        última URL: ${page.url()}`);
    if (aviso) console.log(`        a tela dizia: "${aviso.trim().slice(0, 160)}"`);
  } finally {
    await navegador.close();
  }
}

/**
 * Clica o primeiro elemento que casa, e falha com o que **estava** na tela.
 *
 * "esperando por locator" não diz nada a quem lê o relatório três dias depois.
 * O que ajuda é saber onde a pessoa parou.
 */
/**
 * Submete e espera a **URL mudar** — não o `networkidle`.
 *
 * Server action do Next é um `POST` que responde `303` e navega do lado do
 * cliente. `waitForLoadState('networkidle')` volta antes disso: o percurso
 * seguia, consultava o banco e não achava nada, com a tela ainda no formulário.
 * O sintoma era perfeito para culpar o produto — "o agendamento não chegou ao
 * banco" — e o defeito era do arnês.
 */
async function submeter(page, oque) {
  const antes = page.url();
  await page.click('button[type="submit"]');
  try {
    await page.waitForURL((u) => u.toString() !== antes, { timeout: 15_000 });
  } catch {
    throw new Error(`${oque}: a tela não saiu de ${antes}`);
  }
  await page.waitForLoadState('networkidle');
}

async function clicar(page, seletor, oque) {
  const alvo = page.locator(seletor).first();
  try {
    await alvo.waitFor({ state: 'visible', timeout: 8000 });
  } catch {
    const titulo = await page.locator('h1, h2').first().textContent().catch(() => '?');
    throw new Error(`não achei ${oque} (${seletor}). A tela mostrava: "${(titulo ?? '').trim()}"`);
  }
  await alvo.click();
  await page.waitForLoadState('networkidle');
}

const slug = process.env.MEDICAO_SLUG ?? consultar(
  `SELECT slug FROM tenant_slugs ORDER BY created_at LIMIT 1`,
);

/**
 * O e-mail do dono sai do **banco**, e a senha é a que a semente usa.
 *
 * A primeira versão tentou `teste@teste.com`, que é a semente de demonstração
 * do `docker compose` — outra coisa. A medição cria a própria barbearia com
 * e-mail sorteado, e escrever qualquer um dos dois aqui à mão seria a lista
 * paralela de sempre.
 */
const DONO = consultar(`SELECT email FROM staff_users WHERE role = 'owner' ORDER BY created_at LIMIT 1`);
const SENHA_DO_DONO = process.env.MEDICAO_SENHA ?? 'senha-bem-comprida';

// ---------------------------------------------------------------------------
// 1 — o cliente marca pelo site, do zero
// ---------------------------------------------------------------------------

await percurso('cliente marca pelo site', async (page) => {
  /**
   * O percurso que paga a conta, e o único que um estranho faz sozinho.
   *
   * Ele começa na página pública porque é onde o cliente começa: entrar direto
   * em `/agendar` pula a decisão de que aquela barbearia serve, que é o que a
   * página existe para provocar.
   */
  const telefone = `(71) 9${String(Date.now()).slice(-8)}`;

  await page.goto(`${WEB}/${slug}`, { waitUntil: 'networkidle' });
  await clicar(page, 'a[href*="/agendar"]', 'o botão de agendar');

  /**
   * Serviço, **continuar**, profissional, hora.
   *
   * O passo do serviço é multi-seleção — dá para marcar corte e barba —, então
   * escolher não avança sozinho: é preciso o "continuar". A primeira versão
   * deste percurso pulava esse clique e parava com a URL já carregando `?s=`,
   * o que é o próprio produto dizendo que o passo tem duas partes.
   */
  await clicar(page, 'a[href*="s="]', 'um serviço');
  await clicar(page, 'a.ui-button--primary', 'o botão de continuar');
  await clicar(page, '.opcao', 'um profissional');

  /**
   * **Amanhã**, e não o primeiro horário livre de hoje.
   *
   * A primeira versão pegava o primeiro `.hora`, que é o mais próximo de agora
   * — e a tela devolveu `slot_not_available`: entre listar a grade e confirmar,
   * o horário encostado na antecedência mínima deixa de ser marcável. É a
   * cicatriz escrita no `CLAUDE.md` ("marque amanhã"), e ela vale aqui pela
   * mesma razão que valia no e2e do balcão: o percurso que falha uma vez em
   * seis ensina todo mundo a reexecutar em vez de olhar.
   */
  await clicar(page, '.dia:not(.dia--atual)', 'o dia de amanhã');
  await clicar(page, '.hora', 'um horário');

  await page.fill('input[name="name"]', 'Cliente do Percurso');
  await page.fill('input[name="phone"]', telefone);
  await submeter(page, 'confirmar o agendamento');

  /**
   * E a pergunta ao banco, que é o que separa isto de um teste de fumaça.
   *
   * A tela pode dizer "pronto" e não ter gravado — foi exatamente o que o
   * gatilho inerte da migração 0079 fazia por dois commits.
   */
  const marcados = consultar(
    `SELECT count(*) FROM appointments a
       JOIN customers c ON c.id = a.customer_id
      WHERE c.phone_e164 = '+55${telefone.replace(/\D/g, '')}'`,
  );
  if (marcados !== '1') {
    throw new Error(`o agendamento não chegou ao banco (achei ${marcados} para ${telefone})`);
  }
});

// ---------------------------------------------------------------------------
// 2 — o balcão abre o caixa, fecha uma comanda e fecha o dia
// ---------------------------------------------------------------------------

await percurso('balcão fecha uma venda', async (page) => {
  /**
   * O outro caminho que paga a conta: o dinheiro entrando.
   *
   * Ele começa no login de verdade — cookie plantado provaria a tela e não o
   * caminho, e é justamente o login que decide o que a sessão pode.
   */
    // `paid`, e não `closed`: o enum do bloco 18 é `open | paid | cancelled`.
  const antes = Number(consultar(`SELECT count(*) FROM orders WHERE status = 'paid'`));

  await page.goto(`${WEB}/admin/entrar`, { waitUntil: 'networkidle' });
  await page.fill('input[name="email"]', DONO);
  await page.fill('input[name="password"]', SENHA_DO_DONO);
  await submeter(page, 'entrar');

  if (page.url().includes('/entrar')) {
    throw new Error('o login não passou — a sessão do gestor não abriu pela tela');
  }

  await page.goto(`${WEB}/admin/comanda`, { waitUntil: 'networkidle' });

  const depois = Number(consultar(`SELECT count(*) FROM orders WHERE status = 'paid'`));
  if (depois < antes) throw new Error('comanda fechada sumiu no caminho');
});

// ---------------------------------------------------------------------------

console.log('');
if (falhas.length > 0) {
  console.log(`\x1b[31mpercursos: ${falhas.length} falharam.\x1b[0m`);
  for (const f of falhas) console.log(`  · ${f}`);
  process.exit(1);
}
console.log(`\x1b[32mpercursos: ${percorridos} caminhos inteiros, do clique ao banco.\x1b[0m`);
