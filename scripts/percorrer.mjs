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
import { readFileSync, statSync } from 'node:fs';
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

/**
 * Um recorte para o laço interno — e que **se anuncia**.
 *
 * Cada volta completa custa alguns minutos de subir banco, construir e medir;
 * consertar um percurso pagando isso a cada tentativa é o desperdício que o
 * `--rapido` do portão existe para evitar. O aviso impresso é o que impede o
 * recorte de virar cobertura escondida: portão que cobre menos sem dizer é
 * pior que portão lento.
 */
const FILTRO = process.env.PERCURSOS ?? '';
if (FILTRO) console.log(`\x1b[33mPERCURSOS="${FILTRO}" — recorte ligado, isto não fecha bloco.\x1b[0m`);

async function percurso(nome, corpo) {
  if (FILTRO && !nome.includes(FILTRO)) return;
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
async function submeter(page, oque, alvo) {
  const antes = page.url();
  /**
   * O botão é **dito**, não o primeiro da tela.
   *
   * `button[type="submit"]` sozinho serviu enquanto os percursos eram um
   * formulário por tela. Ele para de servir na primeira tela do painel: o
   * cabeçalho do onboarding abre com o "Sair", que é o primeiro `submit` do
   * documento — o percurso sairia da conta em vez de avançar a etapa, e o
   * relatório diria "a tela não saiu do onboarding" sobre uma sessão encerrada.
   */
  const botao = alvo ?? page.locator('button[type="submit"]').first();
  await botao.click();
  try {
    await page.waitForURL((u) => u.toString() !== antes, { timeout: 15_000 });
  } catch {
    /**
     * E **por que** ela não saiu, quando o navegador é quem barrou.
     *
     * `required` e `minlength` fazem o formulário não enviar sem nenhum sinal
     * na rede: sem esta linha o relatório diz "a tela não saiu" e quem lê
     * refaz o percurso à mão para descobrir que um campo ficou vazio. Foi o
     * que aconteceu no primeiro percurso de LGPD — a ficha tem dois campos
     * chamados `motivo`, o preenchimento pegou o outro, e o que faltava era
     * invisível no relatório.
     */
    const invalido = await page.evaluate(() => {
      const campo = document.querySelector('input:invalid, select:invalid, textarea:invalid');
      return campo ? `${campo.getAttribute('name') ?? campo.tagName}: ${campo.validationMessage}` : null;
    });
    throw new Error(
      `${oque}: a tela não saiu de ${antes}${invalido ? ` — o navegador barrou em ${invalido}` : ''}`,
    );
  }
  await page.waitForLoadState('networkidle');
}

/**
 * Espera a URL **assentar** onde deveria.
 *
 * Um `redirect` de servidor dentro de uma navegação do app router chega em dois
 * saltos: o cliente vai para o endereço pedido, recebe o desvio e vai de novo.
 * `submeter` volta no primeiro, e ler `page.url()` ali pega o endereço do meio
 * do caminho — foi assim que "o barbeiro caiu em /admin/dia" acusou um desvio
 * que estava funcionando.
 */
async function esperarUrl(page, padrao, oque) {
  try {
    await page.waitForURL(padrao, { timeout: 15_000 });
  } catch {
    throw new Error(`${oque}: parou em ${page.url()}`);
  }
}

/** O botão pelo texto que a pessoa lê. */
const botao = (escopo, texto) => escopo.getByRole('button', { name: texto }).first();

/**
 * Abre uma dobra pelo título.
 *
 * Metade do painel mora dentro de `<details>`, e o conteúdo fechado não existe
 * para o navegador: preencher sem abrir falha com "elemento não visível", que
 * não diz a quem lê que faltou um clique.
 */
async function abrir(escopo, titulo) {
  const resumo = escopo.locator('summary').filter({ hasText: titulo }).first();
  await resumo.waitFor({ state: 'visible', timeout: 8000 });
  // O escopo é dito por quem chama: no painel da plataforma há um "Bloquear"
  // por barbearia, e abrir o primeiro da página bloquearia a conta errada.
  if (!(await resumo.evaluate((s) => s.parentElement?.open === true))) await resumo.click();
}

/** Entra no painel como gestor e devolve onde a tela parou. */
async function entrarNoPainel(page, email, senha) {
  await page.goto(`${WEB}/admin/entrar`, { waitUntil: 'networkidle' });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', senha);
  await submeter(page, `entrar como ${email}`);
  if (page.url().includes('/entrar')) {
    throw new Error(`o login de ${email} não passou — a sessão não abriu pela tela`);
  }
  return page.url();
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
  /**
   * E, entre os dias, o primeiro que tenha um horário **de preço diferente**.
   *
   * Sem esta procura a asserção de preço logo abaixo passava pelo motivo
   * errado: num dia sem faixa cadastrada, o preço do motor e a soma do catálogo
   * são o mesmo número, e comparar dois números iguais não prova nada — o
   * percurso ficaria verde com o defeito de volta. É a mesma armadilha do teste
   * de remarcação que passava com e sem `ignoreAppointmentId`.
   *
   * A semente liga a precificação dinâmica e cadastra faixas em três janelas,
   * então dentro de catorze dias sempre há uma. Não achando nenhuma, o percurso
   * **falha** em vez de seguir: um dia sem faixa nenhuma significa que a
   * semente parou de produzir o cenário, e isso é para ser consertado, não
   * ignorado.
   */
  const outrosDias = await page
    .locator('.dia:not(.dia--atual)')
    .evaluateAll((as) => as.map((a) => a.getAttribute('href')).filter(Boolean));

  let achouFaixa = false;
  for (const destino of outrosDias) {
    // Por endereço e não por clique: clicar move o `--atual`, e o conjunto que
    // o laço percorre mudaria embaixo dele a cada volta.
    await page.goto(`${WEB}${destino}`, { waitUntil: 'networkidle' });
    if ((await page.locator('.hora .hora__preco').count()) > 0) {
      achouFaixa = true;
      break;
    }
  }
  if (!achouFaixa) {
    throw new Error(
      'nenhum horário com preço diferente do catálogo em catorze dias — '
        + 'a semente parou de cadastrar faixa de preço, e a asserção abaixo viraria decoração',
    );
  }
  await clicar(page, '.hora:has(.hora__preco)', 'um horário de preço diferente');

  /**
   * O total que a tela promete, lido **antes** de confirmar.
   *
   * É a asserção que o bloco 105 existe para prender, e ela só é possível aqui:
   * a tela dizia R$ 45,00 somando o catálogo e o banco gravava R$ 54,00, porque
   * o preço do profissional e a faixa de horário entram no motor e não na soma.
   * Nada ficava vermelho — `precoDoHorario` tinha teste, a API tinha teste, e as
   * duas telas eram coerentes cada uma consigo mesma (§6, pergunta 6).
   *
   * Nenhum teste de unidade alcança isto: o que se compara é o que a pessoa lê
   * na tela contra o que ficou na linha do banco.
   */
  const totalNaTela = await page.locator('.confere > div:last-of-type dd').innerText();
  const centavosNaTela = (() => {
    const achado = /R\$\s*([\d.]+),(\d{2})/.exec(totalNaTela);
    if (!achado) throw new Error(`não achei o total na tela: ${totalNaTela}`);
    return Number(achado[1].replace(/\./g, '')) * 100 + Number(achado[2]);
  })();

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

  const gravado = consultar(
    `SELECT a.price_cents FROM appointments a
       JOIN customers c ON c.id = a.customer_id
      WHERE c.phone_e164 = '+55${telefone.replace(/\D/g, '')}'`,
  );
  if (Number(gravado) !== centavosNaTela) {
    throw new Error(
      `a tela prometeu ${centavosNaTela} centavos e o banco gravou ${gravado} — `
        + 'é o preço do catálogo aparecendo no lugar do preço do motor',
    );
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

  await entrarNoPainel(page, DONO, SENHA_DO_DONO);
  await page.goto(`${WEB}/admin/comanda`, { waitUntil: 'networkidle' });

  const depois = Number(consultar(`SELECT count(*) FROM orders WHERE status = 'paid'`));
  if (depois < antes) throw new Error('comanda fechada sumiu no caminho');
});

// ---------------------------------------------------------------------------
// 3 — o dono abre a barbearia do zero e publica o link
// ---------------------------------------------------------------------------

await percurso('dono abre a barbearia e publica', async (page) => {
  /**
   * A promessa da SPEC Parte 1 §1.5: da conta ao link publicado, sem ajuda.
   *
   * É o único percurso que **cria um tenant**, e por isso ele é o que mais se
   * parece com o primeiro dia de uma barbearia de verdade. Tudo o mais neste
   * arquivo entra numa casa que a medição montou por HTTP; aqui a casa nasce
   * pelo formulário, que é onde nada nunca clicou.
   *
   * Ele roda depois dos dois primeiros de propósito: `slug` e `DONO` são lidos
   * no topo do arquivo, pela conta **mais antiga**, então a barbearia nova não
   * desloca ninguém.
   */
  const marca = `Percurso ${Date.now() % 100000}`;
  const email = `dono${Date.now()}@percurso.teste`;
  const senha = 'senha-do-percurso-longa';

  await page.goto(`${WEB}/admin/criar-conta`, { waitUntil: 'networkidle' });
  await page.fill('input[name="businessName"]', marca);
  await page.fill('input[name="name"]', 'Dona do Percurso');
  await page.fill('input[name="phone"]', `(71) 9${String(Date.now()).slice(-8)}`);
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', senha);
  await submeter(page, 'criar a conta');

  /**
   * E depois **entrar**, porque criar não dá sessão — de propósito.
   *
   * A API responde igual para e-mail novo e já cadastrado, e entregar sessão só
   * num dos casos desfaria isso na tela. O percurso passa por essa porta como
   * quem abre a barbearia passa.
   */
  await entrarNoPainel(page, email, senha);
  await clicar(page, 'a[href="/admin/onboarding"]', 'a volta para o cadastro');

  // Etapa 2 — onde fica. O nome já vem preenchido do passo anterior.
  await page.fill('input[name="street"]', 'Rua da Paciência, 240');
  await page.fill('input[name="city"]', 'Salvador');
  await page.fill('input[name="state"]', 'BA');
  await page.selectOption('select[name="timezone"]', 'America/Bahia');
  await submeter(page, 'salvar onde fica', botao(page, 'Continuar'));

  // Etapa 3 — o cardápio já vem marcado e com preço; é isso que a etapa promete.
  await submeter(page, 'salvar o cardápio', botao(page, 'Continuar'));

  // Etapa 4 — quem atende. Só o primeiro é obrigatório.
  await page.locator('input[name="profissional"]').first().fill('Gleidson do Percurso');
  await submeter(page, 'salvar a equipe', botao(page, 'Continuar'));

  // Etapa 5 — como se paga.
  await submeter(page, 'salvar os pagamentos', botao(page, 'Continuar'));

  // Etapa 6 — o link no ar.
  await submeter(page, 'publicar', botao(page, 'Publicar minha página'));

  const tenant = consultar(
    `SELECT id FROM tenants WHERE name = '${marca.replace(/'/g, "''")}' LIMIT 1`,
  );
  if (!tenant) throw new Error(`a barbearia "${marca}" não chegou ao banco`);

  const estado = consultar(
    `SELECT (published_at IS NOT NULL)::int
       || ':' || (SELECT count(*) FROM services WHERE tenant_id = '${tenant}' AND active)
       || ':' || (SELECT count(*) FROM professionals WHERE tenant_id = '${tenant}')
       || ':' || (SELECT count(*) FROM work_schedules WHERE tenant_id = '${tenant}')
       || ':' || (SELECT count(*) FROM tenant_slugs WHERE tenant_id = '${tenant}')
       FROM tenants WHERE id = '${tenant}'`,
  );
  const [publicada, servicos, equipe, jornadas, slugs] = estado.split(':').map(Number);
  if (!publicada) throw new Error('a barbearia não ficou publicada');
  if (!servicos || !equipe || !jornadas || !slugs) {
    throw new Error(
      `publicou sem o que a página precisa (serviços ${servicos}, equipe ${equipe}, ` +
        `jornadas ${jornadas}, endereços ${slugs})`,
    );
  }

  /**
   * E o link **abre**. É a frase que o produto vende — "um link para colocar na
   * bio" —, e é a única que nenhuma consulta ao banco consegue conferir.
   */
  const novoSlug = consultar(`SELECT slug FROM tenant_slugs WHERE tenant_id = '${tenant}' LIMIT 1`);
  const resposta = await page.goto(`${WEB}/${novoSlug}`, { waitUntil: 'networkidle' });
  if (!resposta || resposta.status() >= 400) {
    throw new Error(`/${novoSlug} respondeu ${resposta?.status() ?? 'nada'} depois de publicar`);
  }
});

// ---------------------------------------------------------------------------
// 4 — o dono dá acesso ao barbeiro, e o barbeiro entra
// ---------------------------------------------------------------------------

await percurso('barbeiro recebe acesso e chega ao dia dele', async (page) => {
  /**
   * Duas pessoas, uma sessão de cada vez — e a senha atravessando entre elas.
   *
   * O que só este percurso prova: a senha de primeiro acesso aparece **na
   * tela** (nunca na URL, que fica no histórico), a conta nasce obrigada a
   * trocá-la, e depois de trocada o barbeiro cai em `/admin/meu-dia` e não no
   * balcão. Os três são decisões escritas do produto, e nenhum teste as
   * exercitava pelo caminho por onde elas acontecem.
   */
  const emailDoBarbeiro = `barbeiro${Date.now()}@percurso.teste`;
  const senhaNova = 'senha-do-barbeiro-longa';

  await entrarNoPainel(page, DONO, SENHA_DO_DONO);
  await page.goto(`${WEB}/admin/profissionais`, { waitUntil: 'networkidle' });

  /**
   * A cadeira **sem** conta, não a primeira da lista.
   *
   * As duas do cadastro nascem sem conta, mas o percurso não pode depender
   * disso: uma execução parcial, uma semente nova ou o próprio percurso rodando
   * duas vezes já deixam a primeira ocupada. O título diz qual é — o produto
   * escreve "— criado" ao lado de quem já tem —, e é dele que sai a escolha.
   */
  const semConta = page
    .locator('summary.dobra__titulo')
    .filter({ hasText: 'Acesso ao aplicativo' })
    .filter({ hasNotText: 'criado' })
    .first();
  if ((await semConta.count()) === 0) {
    throw new Error('nenhuma cadeira sem conta: o percurso não exercitaria o convite');
  }
  await semConta.click();
  const convite = page.locator('form.convite').filter({ has: page.getByRole('button', { name: 'Criar acesso' }) }).first();
  await convite.locator('input[name="email"]').fill(emailDoBarbeiro);
  await submeter(page, 'criar o acesso', botao(convite, 'Criar acesso'));

  /**
   * A senha sai da tela, e é a única vez que ela existe em claro.
   *
   * Ela vem por cookie de dois minutos com caminho restrito — nunca por
   * parâmetro de consulta, que ficaria no histórico e no autocompletar. Ler
   * daqui é ler exatamente o que o dono lê para o barbeiro.
   */
  const senhaInicial = (await page.locator('.convite__senha').first().textContent())?.trim();
  if (!senhaInicial) throw new Error('a senha de primeiro acesso não apareceu na tela');

  await submeter(page, 'o dono sair', botao(page, 'Sair'));

  await page.goto(`${WEB}/admin/entrar`, { waitUntil: 'networkidle' });
  await page.fill('input[name="email"]', emailDoBarbeiro);
  await page.fill('input[name="password"]', senhaInicial);
  await submeter(page, 'o barbeiro entrar pela primeira vez');

  if (!page.url().includes('/admin/trocar-senha')) {
    throw new Error(`a senha de primeiro acesso não obrigou a troca (parou em ${page.url()})`);
  }

  await page.fill('input[name="currentPassword"]', senhaInicial);
  await page.fill('input[name="newPassword"]', senhaNova);
  await page.fill('input[name="confirmPassword"]', senhaNova);
  await submeter(page, 'trocar a senha de primeiro acesso');

  /**
   * E o destino é o **dele**.
   *
   * A ação manda para `/admin/dia`, e é a tela que desvia: o barbeiro tem
   * permissão de ver a agenda, então o balcão *funciona* para ele — e funcionar
   * não é servir. Se este desvio quebrar, nada fica vermelho no portão: a tela
   * do balcão simplesmente abre.
   */
  await esperarUrl(page, /\/admin\/meu-dia$/, 'o barbeiro não chegou ao dia dele');

  const esperado = 'professional:1:0';
  const conta = consultar(
    `SELECT role || ':' || (professional_id IS NOT NULL)::int || ':' || must_change_password::int
       FROM staff_users WHERE email = '${emailDoBarbeiro}'`,
  );
  if (conta !== esperado) {
    throw new Error(`a conta do barbeiro ficou "${conta}", esperava "${esperado}"`);
  }
});

// ---------------------------------------------------------------------------
// 5 — o titular pede cópia dos dados, e depois pede para sair
// ---------------------------------------------------------------------------

await percurso('LGPD: registrar, exportar e anonimizar', async (page) => {
  /**
   * O percurso que a lei cobra, e o que ele pega que mais nada pega.
   *
   * A anonimização apaga o cadastro **e** os textos que moram fora dele —
   * anotação de fidelidade, nota de pedido, motivo de contestação — por um
   * gatilho. Esse gatilho ficou **inerte por dois commits**, sem erro e sem
   * log, e quem o descobriu foi um teste escrito para outra coisa. É o retrato
   * do defeito que só aparece perguntando ao banco depois de clicar.
   */
  const alvo = consultar(
    `SELECT c.id || ':' || c.name FROM customers c
       JOIN loyalty_entries l ON l.customer_id = c.id AND l.note IS NOT NULL
      WHERE c.anonymized_at IS NULL
      ORDER BY c.created_at LIMIT 1`,
  );
  if (!alvo) {
    /**
     * Sem texto satélite, o percurso passaria provando menos do que promete.
     *
     * É a disciplina de semente do `CLAUDE.md`: ela precisa satisfazer **tudo
     * menos** a regra sob teste. Um cliente sem anotação faria a asserção do
     * gatilho ser verdadeira por ausência de dado.
     */
    throw new Error('nenhum cliente com anotação: a asserção do gatilho não provaria nada');
  }
  const [cliente, nome] = [alvo.slice(0, 36), alvo.slice(37)];

  await entrarNoPainel(page, DONO, SENHA_DO_DONO);
  await page.goto(`${WEB}/admin/cliente/${cliente}`, { waitUntil: 'networkidle' });

  await abrir(page, 'Pedido de dados (LGPD)');
  await submeter(page, 'registrar o pedido de cópia', botao(page, 'Registrar pedido de cópia'));

  const pedidos = consultar(
    `SELECT count(*) FROM data_requests WHERE customer_id = '${cliente}' AND kind = 'export'`,
  );
  if (pedidos === '0') throw new Error('o pedido do titular não chegou ao banco');

  // O arquivo. A rota existe porque o cookie do painel é `httpOnly` e o
  // navegador não monta o `Authorization` que a API exige — é a única ponte
  // desse tipo no produto, e nunca ninguém a tinha exercitado por um clique.
  await abrir(page, 'Pedido de dados (LGPD)');
  const [baixado] = await Promise.all([
    page.waitForEvent('download', { timeout: 20_000 }),
    page.click(`a[href="/admin/cliente/${cliente}/dados"]`),
  ]);
  const arquivo = await baixado.path();
  if (!arquivo || statSync(arquivo).size === 0) throw new Error('a exportação veio vazia');
  if (!readFileSync(arquivo, 'utf8').includes(nome)) {
    throw new Error('a exportação não traz o nome do titular — o arquivo é de outra pessoa');
  }
  const exportacoes = consultar(
    `SELECT count(*) FROM audit_log
      WHERE entity_id = '${cliente}' AND action = 'customer.data_exported'`,
  );
  if (exportacoes === '0') throw new Error('a exportação não ficou na trilha');

  /**
   * E o pedido de exclusão, a única ação sem volta do painel.
   *
   * Os campos são escritos **dentro do formulário**, nunca pela tela: a ficha
   * tem dois campos chamados `motivo` — o desta dobra e o do ajuste de
   * confiança —, e preencher pelo documento pegava o outro. O que se via era o
   * botão respondendo nada, porque o `required` deste ficara vazio.
   */
  await abrir(page, 'Apagar os dados deste cliente');
  const apagar = page
    .locator('form.formulario')
    .filter({ has: page.locator('input[name="confirmacao"]') })
    .first();
  await apagar
    .locator('input[name="motivo"]')
    .fill('Pedido de exclusao do titular, percurso da medicao');
  await apagar.locator('input[name="confirmacao"]').fill('APAGAR');
  await submeter(page, 'apagar os dados', botao(apagar, `Apagar os dados de ${nome}`));

  const depois = consultar(
    /**
     * O texto satélite é contado pelo que **ainda diz algo sobre a pessoa**.
     *
     * Nem toda anotação vira nulo: a linha de ajuste manual guarda um marcador
     * fixo, porque `loyalty_entries_ajuste_tem_motivo` exige motivo escrito e
     * um nulo ali derruba a anonimização inteira. Contar "nota não nula" faria
     * este percurso reprovar justamente o conserto.
     */
    `SELECT (c.anonymized_at IS NOT NULL)::int
       || ':' || (c.name = '${nome.replace(/'/g, "''")}')::int
       || ':' || (SELECT count(*) FROM loyalty_entries
                   WHERE customer_id = c.id AND note IS NOT NULL
                     AND note <> 'texto removido na anonimizacao do titular')
       FROM customers c WHERE c.id = '${cliente}'`,
  );
  const [anonimizado, aindaTemNome, textosSatelites] = depois.split(':');
  if (anonimizado !== '1') throw new Error('o cadastro não foi anonimizado');
  if (aindaTemNome !== '0') throw new Error('o nome continua no cadastro depois de anonimizar');
  if (textosSatelites !== '0') {
    throw new Error(
      `${textosSatelites} anotação(ões) sobreviveram à anonimização — o gatilho não disparou`,
    );
  }
});

// ---------------------------------------------------------------------------
// 6 — a plataforma reativa e volta a bloquear uma barbearia
// ---------------------------------------------------------------------------

await percurso('plataforma reativa e bloqueia', async (page) => {
  /**
   * A porta que não tem cadastro: a conta de plataforma nasce por comando, e
   * quem entra por aqui decide se uma barbearia inteira sai do ar.
   *
   * O alvo é a que a medição já deixou bloqueada — nunca a `slug` que os outros
   * percursos usam, porque bloqueá-la derrubaria a página pública no meio da
   * execução. Reativar primeiro e bloquear de volta deixa o banco como estava.
   */
  const alvo = consultar(
    `SELECT t.id || ':' || t.name FROM tenants t
       JOIN tenant_platform p ON p.tenant_id = t.id
      WHERE p.blocked_at IS NOT NULL ORDER BY p.blocked_at LIMIT 1`,
  );
  if (!alvo) throw new Error('nenhuma barbearia bloqueada para reativar');
  const [tenant, nome] = [alvo.slice(0, 36), alvo.slice(37)];

  const email = process.env.MEDICAO_PLATAFORMA_EMAIL;
  const senha = process.env.MEDICAO_PLATAFORMA_SENHA;
  if (!email || !senha) {
    throw new Error('MEDICAO_PLATAFORMA_EMAIL e MEDICAO_PLATAFORMA_SENHA vêm do medicao.sh');
  }

  await page.goto(`${WEB}/plataforma/entrar`, { waitUntil: 'networkidle' });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="senha"]', senha);
  await submeter(page, 'entrar na plataforma');
  if (page.url().includes('/entrar')) throw new Error('o login da plataforma não passou');

  const conta = page.locator('li.conta').filter({ hasText: nome }).first();
  await submeter(page, `reativar ${nome}`, botao(conta, 'Reativar'));

  if (consultar(`SELECT blocked_at IS NULL FROM tenant_platform WHERE tenant_id = '${tenant}'`) !== 't') {
    throw new Error('a reativação não chegou ao banco');
  }

  const motivo = 'inadimplente ha 60 dias, percurso da medicao';
  const cartao = page.locator('li.conta').filter({ hasText: nome }).first();
  await abrir(cartao, 'Bloquear');
  /**
   * Pelo `id`, que é a única coisa que separa os dois.
   *
   * O cartão tem dois campos `motivo` — o do bloqueio e o de entrar na conta
   * como suporte —, dentro de dois `details` de mesma classe, com dois `summary`
   * de mesma aparência. Escrever o motivo do bloqueio no campo do suporte é o
   * defeito da ficha do cliente outra vez, agora numa tela cujo alvo é uma
   * barbearia inteira.
   */
  await cartao.locator('input[id^="motivo-"]').fill(motivo);
  await submeter(page, `bloquear ${nome}`, botao(cartao, `Bloquear ${nome}`));

  const estado = consultar(
    `SELECT (blocked_at IS NOT NULL)::int || ':' || coalesce(blocked_reason, '')
       FROM tenant_platform WHERE tenant_id = '${tenant}'`,
  );
  if (estado !== `1:${motivo}`) {
    throw new Error(`o bloqueio ficou "${estado}", esperava "1:${motivo}"`);
  }
});

// ---------------------------------------------------------------------------
// 7 — os cabeçalhos de segurança, do servidor de verdade
// ---------------------------------------------------------------------------

await percurso('cabeçalhos de segurança saem do servidor', async (page) => {
  /**
   * Porque o teste unitário prova a **minha leitura**, não o Next.
   *
   * `next.config.mjs` declara três regras de cabeçalho e elas precisam ser
   * excludentes: o Next aplica todas as que casam, então uma regra ampla no fim
   * reescreveria o referrer fechado do painel. O teste em `apps/web` confere
   * isso reimplementando o casamento de rota numa regex escrita à mão — o que
   * é útil e não é prova. Aqui quem responde é o servidor.
   *
   * E a CSP com nonce é o caso extremo desse mesmo problema: ela sai de um
   * middleware, o Next precisa achar o nonce no cabeçalho da requisição para
   * repeti-lo nos scripts dele, e se essa ponte quebrar a política sai correta
   * e a página fica em branco. Os seis percursos acima já cairiam — este diz
   * **por quê** em vez de deixar o diagnóstico para quem lê.
   */
  const esperado = [
    ['/', 'strict-origin-when-cross-origin'],
    [`/${slug}`, 'strict-origin-when-cross-origin'],
    ['/admin/entrar', 'no-referrer'],
    ['/plataforma/entrar', 'no-referrer'],
  ];

  for (const [caminho, referrer] of esperado) {
    const resposta = await page.goto(`${WEB}${caminho}`, { waitUntil: 'domcontentloaded' });
    if (!resposta) throw new Error(`${caminho} não respondeu`);
    const cabecalhos = resposta.headers();

    const conferir = (nome, contem) => {
      const valor = cabecalhos[nome] ?? '';
      if (!valor.includes(contem)) {
        throw new Error(`${caminho}: ${nome} é "${valor}", esperava conter "${contem}"`);
      }
    };

    conferir('x-frame-options', 'DENY');
    conferir('x-content-type-options', 'nosniff');
    conferir('strict-transport-security', 'max-age=31536000');
    conferir('permissions-policy', 'camera=()');
    conferir('referrer-policy', referrer);
    conferir('content-security-policy', "frame-ancestors 'none'");

    // O referrer é comparação exata: `no-referrer` é subcadeia de
    // `no-referrer-when-downgrade`, que é o contrário do que se quer.
    if (cabecalhos['referrer-policy'] !== referrer) {
      throw new Error(`${caminho}: referrer-policy é "${cabecalhos['referrer-policy']}"`);
    }

    const csp = cabecalhos['content-security-policy'] ?? '';
    const scripts = csp.split('; ').find((d) => d.startsWith('script-src')) ?? '';
    if (!/'nonce-[a-zA-Z0-9+/]+'/.test(scripts)) {
      throw new Error(`${caminho}: script-src saiu sem nonce ("${scripts}")`);
    }
    if (scripts.includes('unsafe-inline')) {
      throw new Error(`${caminho}: script-src abriu exceção para script embutido`);
    }
  }

  /**
   * E o nonce chega **ao HTML**, que é a metade que nenhum cabeçalho prova.
   *
   * Política com nonce e página sem nonce é uma página em branco no navegador
   * de quem instalou — e um `curl` no cabeçalho diria que está tudo certo.
   *
   * A conferência é sobre os **bytes**, nunca sobre o DOM: o navegador esconde
   * o valor do nonce depois de analisar a página (é o *nonce hiding* do CSP 3,
   * feito justamente para que um script injetado não consiga lê-lo), então
   * `page.content()` devolve `nonce=""` mesmo quando está tudo certo. A
   * primeira versão deste percurso acusou o produto por causa disso.
   */
  const bruta = await page.request.get(`${WEB}/${slug}`);
  const nonce = /'nonce-([a-zA-Z0-9+/]+)'/.exec(bruta.headers()['content-security-policy'] ?? '');
  if (!nonce) throw new Error('a resposta crua saiu sem nonce na política');
  if (!(await bruta.text()).includes(`nonce="${nonce[1]}"`)) {
    throw new Error('o nonce da política não chegou a nenhum script do HTML');
  }
});

// ---------------------------------------------------------------------------

console.log('');
if (falhas.length > 0) {
  console.log(`\x1b[31mpercursos: ${falhas.length} falharam.\x1b[0m`);
  for (const f of falhas) console.log(`  · ${f}`);
  process.exit(1);
}
console.log(`\x1b[32mpercursos: ${percorridos} caminhos inteiros, do clique ao banco.\x1b[0m`);
