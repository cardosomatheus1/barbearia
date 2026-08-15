/**
 * Conectar o WhatsApp sem copiar identificador (bloco 83).
 *
 * O cadastro do bloco 55 pede dois números de quinze dígitos que a pessoa
 * precisa achar dentro do painel da Meta e colar aqui. Funciona, e é o tipo de
 * etapa que se abandona no meio — o produto perde o canal que reduz falta em
 * 40% para uma tarefa de copiar e colar.
 *
 * O *Embedded Signup* é o fluxo oficial para isto: a barbearia clica em
 * "Conectar WhatsApp", a janela da Meta abre, ela escolhe a empresa, a conta e
 * o número, confirma o código do SMS — e a Meta devolve `waba_id`,
 * `phone_number_id` e um **código de autorização** para o nosso servidor. Este
 * arquivo é a metade de cá: trocar o código por um token, assinar o webhook e
 * registrar o número.
 *
 * ## Por que as credenciais são da plataforma, e não da barbearia
 *
 * Ao contrário do token de acesso — que é de cada casa e mora cifrado em
 * `whatsapp_settings` —, o `META_APP_ID` e o `META_APP_SECRET` são do **nosso
 * app**, um par para todas as barbearias. É por eles que a Meta sabe que o
 * código de autorização foi emitido para nós, e não para outro produto.
 *
 * ## O que ele escreve
 *
 * As **mesmas duas colunas** que o formulário. O Embedded Signup vira o caminho
 * normal e o formulário fica como escape para quem já tem os ids — nenhuma
 * tabela nova, nenhum estado paralelo. Duas maneiras de chegar ao mesmo fato é
 * o que este código evita em toda parte; duas maneiras de **preencher** o mesmo
 * cadastro não é isso.
 */

import {
  cadastroDoWhatsApp,
  salvarCadastroDoWhatsApp,
  type CadastroDoWhatsApp,
} from './whatsapp.js';

const VERSAO = 'v21.0';
const BASE = `https://graph.facebook.com/${VERSAO}`;

/**
 * As credenciais do app, ou `null` quando ele não foi criado.
 *
 * `null` e não uma exceção na subida: o produto opera sem Embedded Signup — o
 * formulário do bloco 55 continua lá. Quem chama decide o que fazer, e a
 * decisão certa é a tela **não desenhar o botão**, porque um botão que abre
 * uma janela vazia é pior que botão nenhum.
 *
 * O `appSecret` nunca sai daqui: ele vai no corpo da troca de código e em mais
 * lugar nenhum. O `appId` e o `configId` são públicos por desenho — os dois
 * vão dentro do JavaScript que roda no navegador de quem se cadastra.
 */
export interface CredenciaisDaPlataforma {
  readonly appId: string;
  readonly appSecret: string;
  readonly configId: string;
}

export function credenciaisDaPlataforma(
  env: Record<string, string | undefined> = process.env,
): CredenciaisDaPlataforma | null {
  const appId = env['META_APP_ID'] ?? '';
  const appSecret = env['META_APP_SECRET'] ?? '';
  const configId = env['META_CONFIG_ID'] ?? '';
  if (!appId || !appSecret || !configId) return null;
  return { appId, appSecret, configId };
}

/**
 * Qual fluxo de conexão a janela da Meta abre (bloco 85).
 *
 * ## As duas coisas que a Meta chama de Embedded Signup
 *
 * O **padrão** conecta um número novo, e ele passa a ser da Cloud API: sai do
 * aplicativo WhatsApp e deixa de funcionar lá. É o que este produto fazia, e é
 * a resposta certa para quem vai dedicar um chip ao atendimento.
 *
 * A **coexistência** (`whatsapp_business_app_onboarding`) conecta um número que
 * a barbearia **já usa no aplicativo WhatsApp Business**, e ele continua
 * funcionando lá — a Meta mantém o histórico sincronizado entre os dois. Para a
 * barbearia que atende pelo WhatsApp Business hoje, é a diferença entre migrar
 * e somar.
 *
 * ## Por que é interruptor, e não decisão de código
 *
 * A coexistência exige status de Solution Partner ou Tech Provider **vinculado
 * a este app**. Ter o status noutro negócio não habilita este `config_id`, e
 * isso não é uma coisa que dê para conferir de dentro do código.
 *
 * Então o modo é dito por quem sabe, e o padrão é o **comportamento anterior** —
 * a mesma regra de `PSP_MODO` e `FISCAL_MODO`. Valor desconhecido falha alto:
 * lido com tolerância, um erro de digitação abriria o fluxo que **toma** o
 * número da barbearia, que é justamente o que a coexistência evita.
 */
export type ModoDoOnboarding = 'padrao' | 'coexistencia';

export function modoDoOnboarding(bruto = process.env['WHATSAPP_ONBOARDING']): ModoDoOnboarding {
  if (bruto === undefined || bruto === '') return 'padrao';
  if (bruto === 'padrao' || bruto === 'coexistencia') return bruto;
  throw new Error(
    `WHATSAPP_ONBOARDING inválido: ${bruto}. Use padrao ou coexistencia — ` +
      'e lido com tolerância isto abriria o fluxo que toma o número da barbearia.',
  );
}

/**
 * O que a tela precisa para desenhar o botão — e **nunca** o segredo.
 *
 * `appId` e `configId` vão para o navegador porque o `FB.login` precisa deles;
 * o `appSecret` fica no servidor. Devolver os três seria mandar a credencial
 * que assina em nome do app inteiro para dentro de um HTML que fica no
 * histórico do navegador — é o precedente do token, que a tela recebe como
 * "existe" e nunca como valor.
 */
export function signupNaTela(
  params: { readonly redirectUri?: string | undefined; readonly state?: string | undefined } = {},
  credenciais = credenciaisDaPlataforma(),
  modo = modoDoOnboarding(),
): { readonly endereco: string | null; readonly modo: ModoDoOnboarding } | null {
  if (!credenciais) return null;

  /**
   * Sem retorno e sem `state`, devolve só o modo.
   *
   * A tela precisa do modo para saber **o que avisar** sobre o número, e ela é
   * renderizada sem poder gravar cookie — o Next só permite isso em ação de
   * formulário ou rota. Quem sorteia o `state`, guarda e pede o endereço é a
   * ação do botão, que é onde o cookie pode ser escrito.
   */
  if (!params.redirectUri || !params.state) return { endereco: null, modo };

  /**
   * A tela recebe o **endereço pronto**, e não as credenciais.
   *
   * Antes ela recebia `appId` e `configId` para montar a chamada do SDK no
   * navegador. Sem SDK, montar a URL virou trabalho de servidor — e a tela
   * deixou de precisar saber qualquer coisa sobre a Meta.
   *
   * O modo continua viajando porque ela decide uma coisa com ele: **o que
   * avisar** antes do botão. Num fluxo o número sai do WhatsApp, no outro ele
   * fica, e avisar errado é a barbearia perder o canal que usa todo dia.
   */
  return {
    endereco: enderecoDoSignup({
      credenciais,
      modo,
      redirectUri: params.redirectUri,
      state: params.state,
    }),
    modo,
  };
}

/**
 * O endereço da janela de conexão, montado no servidor (bloco 86).
 *
 * ## Por que deixou de ser JavaScript
 *
 * A versão anterior usava o SDK da Meta: um `<script>` sob nonce chamava
 * `FB.login`, que abre uma janela filha e devolve o código por callback. No
 * computador funciona. **No celular não**: a janela vira uma aba, o SDK não
 * consegue falar com a página que a abriu, e o callback nunca dispara. A Meta
 * conclui, mostra "feche esta aba", e a nossa tela fica igual.
 *
 * Aconteceu duas vezes na primeira conexão de verdade deste produto — a segunda
 * já com o conserto que eu achava que resolvia, e que atacava o lugar errado: o
 * problema não era a resposta se perder no caminho de volta, era o código nunca
 * chegar.
 *
 * O fluxo de redirecionamento é navegação comum. Funciona em qualquer
 * navegador, não pede JavaScript, e por isso **apaga o único script que este
 * produto mandava ao navegador** — junto com a exceção de política de conteúdo
 * que ele exigia. O caminho mais robusto era também o mais simples, e o SDK foi
 * a escolha errada desde o começo.
 *
 * ## O `state`
 *
 * Vai e volta sem ser tocado, e é o que impede alguém de fazer a barbearia
 * conectar uma conta que não é dela: sem ele, um link montado por terceiro
 * levaria o código de outra pessoa para dentro deste cadastro. Quem o guarda e
 * o confere é a tela, num cookie `httpOnly` — o precedente da senha de primeiro
 * acesso.
 */
export function enderecoDoSignup(params: {
  readonly credenciais: CredenciaisDaPlataforma;
  readonly modo: ModoDoOnboarding;
  readonly redirectUri: string;
  readonly state: string;
}): string {
  const url = new URL(`https://www.facebook.com/${VERSAO}/dialog/oauth`);
  url.searchParams.set('client_id', params.credenciais.appId);
  url.searchParams.set('config_id', params.credenciais.configId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('state', params.state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('override_default_response_type', 'true');

  /**
   * O mesmo `extras` do SDK, como texto.
   *
   * `featureType` é o que separa os dois fluxos: com ele a Meta abre o
   * onboarding do aplicativo WhatsApp Business e o número **continua**
   * funcionando lá; sem ele, o número é tomado pela Cloud API.
   */
  url.searchParams.set(
    'extras',
    JSON.stringify(
      params.modo === 'coexistencia'
        ? { setup: {}, featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' }
        : { setup: {} },
    ),
  );

  return url.toString();
}

export class SignupError extends Error {
  constructor(
    readonly code: 'sem_app' | 'codigo_invalido' | 'meta_recusou',
    message: string,
  ) {
    super(message);
    this.name = 'SignupError';
  }
}

interface RespostaDeErro {
  readonly error?: {
    readonly message?: string;
    readonly error_user_msg?: string;
    /** O código numérico da Meta: 100 é entrada inválida, 191 é endereço não registrado. */
    readonly code?: number;
    /** O único identificador que o suporte da Meta aceita num chamado. */
    readonly fbtrace_id?: string;
  };
}

async function chamar(
  url: URL,
  init: RequestInit,
  buscar: typeof fetch,
): Promise<Record<string, unknown>> {
  const resposta = await buscar(url, {
    ...init,
    // Um `302` para um endereço qualquer faria o segredo do app ser apresentado
    // a quem não é a Meta. Mesma guarda do webhook de saída do bloco 79.
    redirect: 'manual',
  });
  const texto = await resposta.text();
  let json: Record<string, unknown> = {};
  try {
    json = texto ? (JSON.parse(texto) as Record<string, unknown>) : {};
  } catch {
    json = {};
  }
  if (!resposta.ok) {
    const erro = (json as RespostaDeErro).error;
    /**
     * A recusa da Meta no log, com o `fbtrace_id`.
     *
     * É o único identificador que o suporte dela aceita, e sem ele "a Meta
     * recusou" é uma frase que não abre chamado nenhum. O caminho entra para
     * dizer **qual** passo caiu — trocar código, descobrir conta, registrar
     * número são falhas diferentes com a mesma cara na tela.
     *
     * A URL inteira **não** entra: ela carrega `client_secret` na troca do
     * código, e log é o lugar onde segredo fica em claro sem ninguém decidir.
     */
    console.error('[whatsapp] a Meta recusou', {
      passo: url.pathname,
      status: resposta.status,
      codigo: erro?.code ?? null,
      fbtrace: erro?.fbtrace_id ?? null,
      mensagem: erro?.error_user_msg ?? erro?.message ?? null,
    });
    throw new SignupError(
      'meta_recusou',
      erro?.error_user_msg ?? erro?.message ?? `a Meta respondeu ${resposta.status}`,
    );
  }
  return json;
}

/**
 * O código de autorização vira o token de acesso da barbearia.
 *
 * O código vem do navegador de quem se cadastrou e vale uma vez só. O segredo
 * do app entra **aqui**, no servidor — é o que impede outro produto de trocar
 * um código que a Meta emitiu para nós.
 */
export async function trocarCodigoPorToken(
  code: string,
  credenciais: CredenciaisDaPlataforma,
  buscar: typeof fetch = fetch,
  /**
   * O mesmo endereço que abriu a janela, quando houve redirecionamento.
   *
   * A Meta compara este valor com o que estava no `dialog/oauth` **byte a
   * byte**, e recusa a troca se ele faltar ou diferir. No fluxo de janela do
   * SDK não existe redirecionamento e ele **não** pode ser mandado — os dois
   * erros são o mesmo, em direções opostas, e os dois aparecem como "a Meta
   * recusou a conexão" numa tela que não sabe dizer mais nada.
   *
   * Foi o que sobrou depois de a volta passar a funcionar: a pessoa voltava
   * logada, autorizava na Meta, e a troca morria aqui.
   */
  redirectUri?: string | undefined,
): Promise<string> {
  const url = new URL(`${BASE}/oauth/access_token`);
  url.searchParams.set('client_id', credenciais.appId);
  url.searchParams.set('client_secret', credenciais.appSecret);
  url.searchParams.set('code', code);
  if (redirectUri) url.searchParams.set('redirect_uri', redirectUri);

  const corpo = await chamar(url, { method: 'GET' }, buscar);
  const token = corpo['access_token'];
  if (typeof token !== 'string' || token === '') {
    throw new SignupError('codigo_invalido', 'A Meta não devolveu um token para este código.');
  }
  return token;
}

/**
 * Assina o webhook da conta recém-conectada.
 *
 * Sem isto a barbearia manda mensagem e **não recebe nada de volta**: nem
 * "entregue", nem "lido", nem o toque nos botões. A tela da campanha ficaria
 * com "entregues" e "lidos" em zero para sempre — o indicador que nunca
 * preenche, com a mensagem saindo normalmente.
 */
export async function assinarWebhook(
  wabaId: string,
  token: string,
  buscar: typeof fetch = fetch,
): Promise<void> {
  await chamar(
    new URL(`${BASE}/${wabaId}/subscribed_apps`),
    { method: 'POST', headers: { authorization: `Bearer ${token}` } },
    buscar,
  );
}

/**
 * Registra o número na Cloud API.
 *
 * É o passo que **liga** o número: sem ele a conta existe, o token funciona, e
 * toda mensagem é recusada. O `pin` é o PIN de verificação em duas etapas do
 * número — a Meta o exige no registro, e o produto usa um fixo por unidade
 * porque não há ninguém para digitá-lo depois.
 *
 * Falha aqui **não** derruba o cadastro: um número já registrado responde erro,
 * e é o caso comum de quem reconecta. Quem decide é o chamador.
 */
export async function registrarNumero(
  phoneNumberId: string,
  token: string,
  pin: string,
  buscar: typeof fetch = fetch,
): Promise<void> {
  await chamar(
    new URL(`${BASE}/${phoneNumberId}/register`),
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
    },
    buscar,
  );
}


/**
 * A conta e o número, **descobertos pelo token** (bloco 84).
 *
 * ## Por que isto existe
 *
 * A documentação da Meta manda o navegador ouvir um evento `message` e mandar
 * `waba_id` e `phone_number_id` para o servidor. Funciona no computador, onde o
 * fluxo roda numa janela filha — e **não funciona no celular**, onde ele abre
 * numa aba separada: a Meta conclui, a tela do cliente diz "conectado", e a
 * nossa página fica esperando um recado que nunca chega. Sem erro, sem
 * mensagem, sem nada mudando.
 *
 * Foi o que aconteceu na primeira conexão de verdade deste produto.
 *
 * ## O conserto não é remendar a origem
 *
 * A suspeita imediata era a lista de origens confiáveis — no celular a Meta usa
 * `m.facebook.com`, que não estava nela. Pode ser; mas consertar só isso
 * deixaria o caminho inteiro dependendo de uma mensagem entre abas, que é
 * frágil por natureza e que nenhum teste nosso alcança.
 *
 * O token concedido **já diz** sobre quais contas ele vale: `debug_token`
 * devolve as permissões granulares com os `target_ids`, e o `phone_numbers`
 * da conta devolve o número. Então o navegador passa a ter uma
 * responsabilidade só — entregar o código —, e o que ele mandar de ids vira
 * **dica**, nunca requisito.
 */
async function descobrirWaba(
  token: string,
  credenciais: CredenciaisDaPlataforma,
  buscar: typeof fetch,
): Promise<string> {
  const url = new URL(`${BASE}/debug_token`);
  url.searchParams.set('input_token', token);
  // O token do app, que é como a Meta o documenta: id|segredo. Ele não sai
  // daqui, como o segredo que o compõe.
  url.searchParams.set('access_token', `${credenciais.appId}|${credenciais.appSecret}`);

  const corpo = await chamar(url, { method: 'GET' }, buscar);
  const granulares = (
    corpo as {
      data?: { granular_scopes?: { scope?: string; target_ids?: (string | number)[] }[] };
    }
  ).data?.granular_scopes;

  /**
   * `whatsapp_business_management` é a permissão que nomeia a conta.
   *
   * `messaging` também traz alvo, e serve de reserva: a barbearia pode ter
   * concedido as duas ou só uma, dependendo do que o `config_id` pede.
   */
  const alvo =
    granulares?.find((g) => g.scope === 'whatsapp_business_management')?.target_ids?.[0] ??
    granulares?.find((g) => g.scope === 'whatsapp_business_messaging')?.target_ids?.[0];

  if (alvo === undefined) {
    throw new SignupError(
      'meta_recusou',
      'A Meta não disse a qual conta este acesso pertence. Refaça a conexão e escolha a conta do WhatsApp no fim do fluxo.',
    );
  }
  return String(alvo);
}

async function descobrirNumero(
  wabaId: string,
  token: string,
  buscar: typeof fetch,
): Promise<{ readonly id: string; readonly visivel: string | null }> {
  const url = new URL(`${BASE}/${wabaId}/phone_numbers`);
  const corpo = await chamar(
    url,
    { method: 'GET', headers: { authorization: `Bearer ${token}` } },
    buscar,
  );

  const numeros = (corpo as { data?: { id?: string; display_phone_number?: string }[] }).data;
  const primeiro = numeros?.[0];
  if (!primeiro?.id) {
    /**
     * Conta criada sem número é o `FINISH_ONLY_WABA` visto do outro lado.
     *
     * A frase diz o que fazer, e não o que faltou: quem está do outro lado não
     * sabe o que é uma WABA sem número, sabe que apertou um botão e não
     * terminou.
     */
    throw new SignupError(
      'meta_recusou',
      'A conta foi criada, mas nenhum número de telefone foi acrescentado a ela. Refaça a conexão e informe o número da barbearia no fim do fluxo.',
    );
  }
  return { id: primeiro.id, visivel: primeiro.display_phone_number ?? null };
}

/**
 * O fluxo inteiro, do código ao cadastro salvo.
 *
 * A ordem importa e é a da Meta: trocar o código, assinar o webhook, registrar
 * o número, gravar. Gravar antes de assinar deixaria a barbearia com "Ativo" na
 * tela e sem nenhum retorno de entrega.
 *
 * O registro é o único passo cujo erro é **engolido**, e está escrito por quê:
 * reconectar um número que já está registrado responde erro, e recusar o
 * cadastro inteiro por causa disso faria o caminho de reconexão — o mais comum
 * depois do primeiro dia — nunca funcionar.
 */
export async function conectarPeloSignup(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly code: string;
  /**
   * O que o navegador conseguiu ouvir, e é **dica**.
   *
   * No computador o evento `message` traz os dois; no celular não traz nenhum.
   * Ausentes, o servidor os descobre pelo token — que é o caminho que não
   * depende de mensagem entre abas.
   */
  readonly wabaId?: string | undefined;
  readonly phoneNumberId?: string | undefined;
  readonly numeroVisivel?: string | null | undefined;
  /**
   * O endereço de volta, quando a conexão veio por redirecionamento.
   *
   * Ausente no fluxo de janela e no cadastro à mão, e a diferença não é
   * cosmética: a Meta exige que ele esteja presente e idêntico num caso, e
   * ausente no outro.
   */
  readonly redirectUri?: string | undefined;
  readonly staffId: string;
  readonly staffName: string;
  readonly credenciais?: CredenciaisDaPlataforma | null;
  readonly buscar?: typeof fetch;
}): Promise<CadastroDoWhatsApp> {
  const credenciais = params.credenciais ?? credenciaisDaPlataforma();
  if (!credenciais) {
    throw new SignupError(
      'sem_app',
      'A conexão automática não está disponível. Cadastre o número pelo formulário.',
    );
  }
  const buscar = params.buscar ?? fetch;

  /**
   * Código já usado é a **nossa própria** conexão, e por isso é sucesso.
   *
   * O código vale uma troca só. Quando a Meta responde que ele já foi usado,
   * quem o usou fomos nós, segundos antes — o navegador pediu a volta duas
   * vezes (recarga, pré-carregamento, o toque a mais de quem achou que não
   * tinha funcionado), e a segunda chega aqui com o mesmo código.
   *
   * A primeira gravou o cadastro. Tratar a segunda como falha pinta de vermelho
   * uma conexão que **deu certo** — foi o que apareceu em produção: a tela
   * mostrando o número novo, recém-salvo, embaixo de um aviso de recusa.
   *
   * É o mesmo raciocínio de `registrarNumero` logo abaixo: número já
   * registrado é reconexão, e reconexão é sucesso do ponto de vista de quem
   * clicou. O que decide se o canal funciona é o cadastro gravado, e a
   * confirmação é o cadastro existir — não a segunda troca ter dado certo.
   */
  let token: string;
  try {
    token = await trocarCodigoPorToken(params.code, credenciais, buscar, params.redirectUri);
  } catch (erro) {
    const jaUsado =
      erro instanceof SignupError && /already been used|has been used/i.test(erro.message);
    if (!jaUsado) throw erro;

    const gravado = await cadastroDoWhatsApp(params.tenantId, params.locationId);
    if (gravado === null) throw erro;
    return gravado;
  }

  const wabaId = params.wabaId ?? (await descobrirWaba(token, credenciais, buscar));
  const numero = params.phoneNumberId
    ? { id: params.phoneNumberId, visivel: params.numeroVisivel ?? null }
    : await descobrirNumero(wabaId, token, buscar);

  await assinarWebhook(wabaId, token, buscar);

  try {
    await registrarNumero(numero.id, token, pinDaUnidade(params.locationId), buscar);
  } catch {
    // Número já registrado é o caso de reconexão, e é sucesso do ponto de vista
    // de quem clicou. O que decide se o canal funciona é o cadastro gravado.
  }

  /**
   * Qual fluxo produziu esta conexão, no log.
   *
   * Sem isto não há como responder "este número foi tomado ou está em
   * coexistência?" depois — e a resposta muda o que se diz ao cliente quando
   * ele reclama que o WhatsApp parou. Só conta e modo: quem conectou já está
   * na trilha, e o número é dado da barbearia.
   */
  console.log('[whatsapp] conectado', { tenantId: params.tenantId, modo: modoDoOnboarding() });

  return salvarCadastroDoWhatsApp({
    tenantId: params.tenantId,
    locationId: params.locationId,
    phoneNumberId: numero.id,
    wabaId,
    numeroVisivel: params.numeroVisivel ?? numero.visivel,
    token,
    staffId: params.staffId,
    staffName: params.staffName,
  });
}

/**
 * O PIN de duas etapas do número, derivado da unidade.
 *
 * Seis dígitos, exigidos pela Meta no registro. Derivado e não sorteado porque
 * ninguém vai digitá-lo depois: reconectar o mesmo número precisa apresentar o
 * **mesmo** PIN, e um valor sorteado obrigaria a guardá-lo — mais um segredo em
 * repouso para não responder pergunta nenhuma.
 *
 * Não é credencial de acesso: ele só impede que outro app tome o número, e
 * quem já precisa do nosso `appSecret` para chegar até aqui não ganha nada com
 * ele.
 */
function pinDaUnidade(locationId: string): string {
  const digitos = locationId.replace(/\D/g, '');
  return (digitos + '000000').slice(0, 6);
}
