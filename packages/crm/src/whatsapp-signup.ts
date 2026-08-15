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

import { salvarCadastroDoWhatsApp, type CadastroDoWhatsApp } from './whatsapp.js';

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
 * O que a tela precisa para desenhar o botão — e **nunca** o segredo.
 *
 * `appId` e `configId` vão para o navegador porque o `FB.login` precisa deles;
 * o `appSecret` fica no servidor. Devolver os três seria mandar a credencial
 * que assina em nome do app inteiro para dentro de um HTML que fica no
 * histórico do navegador — é o precedente do token, que a tela recebe como
 * "existe" e nunca como valor.
 */
export function signupNaTela(
  credenciais = credenciaisDaPlataforma(),
): { readonly appId: string; readonly configId: string } | null {
  if (!credenciais) return null;
  return { appId: credenciais.appId, configId: credenciais.configId };
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
  readonly error?: { readonly message?: string; readonly error_user_msg?: string };
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
): Promise<string> {
  const url = new URL(`${BASE}/oauth/access_token`);
  url.searchParams.set('client_id', credenciais.appId);
  url.searchParams.set('client_secret', credenciais.appSecret);
  url.searchParams.set('code', code);

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
  readonly wabaId: string;
  readonly phoneNumberId: string;
  readonly numeroVisivel: string | null;
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

  const token = await trocarCodigoPorToken(params.code, credenciais, buscar);
  await assinarWebhook(params.wabaId, token, buscar);

  try {
    await registrarNumero(params.phoneNumberId, token, pinDaUnidade(params.locationId), buscar);
  } catch {
    // Número já registrado é o caso de reconexão, e é sucesso do ponto de vista
    // de quem clicou. O que decide se o canal funciona é o cadastro gravado.
  }

  return salvarCadastroDoWhatsApp({
    tenantId: params.tenantId,
    locationId: params.locationId,
    phoneNumberId: params.phoneNumberId,
    wabaId: params.wabaId,
    numeroVisivel: params.numeroVisivel,
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
