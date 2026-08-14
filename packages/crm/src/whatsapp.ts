import { createHmac, timingSafeEqual } from 'node:crypto';
import { withTenant, semTenant, type TransactionClient } from '@barbearia/db';
import {
  BOTOES_DO_AVISO,
  lerPayload,
  montarPayload,
  templateUtilizavel,
  whatsappDisponivel,
  type BotaoDaMensagem,
  type EstadoDoTemplate,
  type EstadoDoWhatsApp,
  type TipoDeNotificacao,
  type WhatsAppProvider,
} from '@barbearia/core';
import { audit } from '@barbearia/identity';
import { enfileirarPara } from '@barbearia/jobs';
import { cifrarCom, decifrarCom } from '@barbearia/identity';

/**
 * A chave do token do WhatsApp é **própria**, não a do segundo fator.
 *
 * Uma por finalidade: com uma só, girar a chave do segundo fator — operação
 * normal de segurança — deixaria ilegível o token de todas as barbearias ao
 * mesmo tempo, e o defeito apareceria como "a mensagem parou de sair" dias
 * depois. É o precedente do segredo próprio do webhook da Stripe.
 */
const CHAVE_DO_TOKEN = 'WHATSAPP_TOKEN_KEY';

/**
 * WhatsApp oficial, do banco para a Meta (bloco 55, SPEC §4.12).
 *
 * ## Por que mora em `crm`
 *
 * O canal é conversa com o cliente, que é o assunto deste pacote — e ele já
 * depende de `jobs` (por `enfileirar`) e de `identity` (por `audit`), que são
 * exatamente as duas coisas que o WhatsApp precisa. Um pacote próprio importaria
 * os mesmos dois e acrescentaria uma seta ao grafo para não fazer nada novo.
 *
 * ## O que ele não faz
 *
 * Não cancela agendamento. O botão "Cancelar" que o cliente toca vira uma linha
 * em `whatsapp_inbound` e uma tarefa na fila; quem mexe na agenda é
 * `packages/scheduling`, pela função injetada no `Contexto` do worker. A seta
 * não volta — é o mesmo desenho de `varrerRetencao`.
 */

export type WhatsAppFailure =
  | 'nao_configurado'
  | 'token_invalido'
  | 'template_nao_encontrado'
  | 'template_nao_aprovado'
  | 'numero_invalido'
  | 'numero_indisponivel'
  | 'nome_invalido';

export class WhatsAppError extends Error {
  constructor(
    readonly code: WhatsAppFailure,
    message: string,
  ) {
    super(message);
    this.name = 'WhatsAppError';
  }
}

const MENSAGEM: Readonly<Record<WhatsAppFailure, string>> = {
  nao_configurado: 'Cadastre o número do WhatsApp antes.',
  token_invalido: 'O token de acesso não confere. Copie de novo do painel da Meta.',
  template_nao_encontrado: 'Este texto não existe.',
  template_nao_aprovado: 'Só um texto aprovado pela Meta pode ser enviado.',
  numero_invalido: 'Confira o identificador do número.',
  /**
   * A mesma frase de "não deu para gravar", e é decisão.
   *
   * "Este número é de outra barbearia" confirmaria o id para quem o adivinhou —
   * o precedente do OTP, que responde igual para telefone existente e
   * inexistente.
   */
  numero_indisponivel: 'Não foi possível salvar este número. Confira o identificador.',
  nome_invalido: 'O nome do texto aceita só minúsculas, números e sublinhado.',
};

function recusar(code: WhatsAppFailure): never {
  throw new WhatsAppError(code, MENSAGEM[code]);
}

// ---------------------------------------------------------------------------
// O cadastro
// ---------------------------------------------------------------------------

export interface CadastroDoWhatsApp {
  readonly estado: EstadoDoWhatsApp;
  readonly phoneNumberId: string | null;
  readonly wabaId: string | null;
  readonly numeroVisivel: string | null;
  readonly motivo: string | null;
  readonly verificadoEm: string | null;
  /**
   * **Se** existe token, nunca qual é.
   *
   * A tela precisa dizer "o token está salvo" e oferecer trocá-lo; devolver o
   * valor faria toda abertura da tela de configurações mandar uma credencial
   * viva pela rede, para dentro de um HTML que fica no histórico do navegador.
   */
  readonly temToken: boolean;
}

const NUMERO_DA_META = /^[0-9]{5,32}$/;

export async function cadastroDoWhatsApp(
  tenantId: string,
  locationId: string,
  tx?: TransactionClient,
): Promise<CadastroDoWhatsApp | null> {
  const dentro = async (t: TransactionClient) => {
    const linhas = await t.$queryRaw<
      {
        status: EstadoDoWhatsApp;
        phone_number_id: string | null;
        waba_id: string | null;
        display_phone: string | null;
        status_reason: string | null;
        verified_at: Date | null;
        tem_token: boolean;
      }[]
    >`
      SELECT status::text AS status, phone_number_id, waba_id, display_phone,
             status_reason, verified_at,
             (access_token_cipher IS NOT NULL) AS tem_token
        FROM whatsapp_settings
       WHERE location_id = ${locationId}::uuid
    `;
    const linha = linhas[0];
    if (!linha) return null;
    return {
      estado: linha.status,
      phoneNumberId: linha.phone_number_id,
      wabaId: linha.waba_id,
      numeroVisivel: linha.display_phone,
      motivo: linha.status_reason,
      verificadoEm: linha.verified_at?.toISOString() ?? null,
      temToken: linha.tem_token,
    };
  };
  return tx ? dentro(tx) : withTenant(tenantId, dentro);
}

/**
 * Salva o cadastro, cifrando o token.
 *
 * O token é opcional na entrada e **ausente significa "não mexa"**: a tela não
 * o devolve, então ela não pode reenviá-lo, e escrever `null` por omissão
 * apagaria a credencial toda vez que alguém corrigisse o número visível. É a
 * mesma regra de campo opcional que o bloco 37 escreveu.
 */
export async function salvarCadastroDoWhatsApp(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly phoneNumberId: string;
  readonly wabaId: string;
  readonly numeroVisivel: string | null;
  readonly token?: string | null;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<CadastroDoWhatsApp> {
  if (!NUMERO_DA_META.test(params.phoneNumberId) || !NUMERO_DA_META.test(params.wabaId)) {
    recusar('numero_invalido');
  }

  const cifrado = params.token ? cifrarCom(CHAVE_DO_TOKEN, params.token) : null;

  return withTenant(params.tenantId, async (tx) => {
    const antes = await cadastroDoWhatsApp(params.tenantId, params.locationId, tx);

    /**
     * O estado sai do que existe, e não do corpo da requisição.
     *
     * Deixar a tela mandar `ativo` faria "está ativo?" ser uma opinião do
     * cliente HTTP. Com token e ids, o cadastro entra em `aguardando_verificacao`
     * — quem o promove a `ativo` é a Meta respondendo, pela conciliação.
     */
    const temToken = cifrado !== null || (antes?.temToken ?? false);
    const estado: EstadoDoWhatsApp = temToken ? 'aguardando_verificacao' : 'nao_configurado';

    // A unidade vem do servidor, mas a conferência sob RLS fica: a chave
    // estrangeira aceita a de outra barbearia, porque a checagem referencial
    // ignora row security.
    const gravadas = await tx.$executeRaw`
      INSERT INTO whatsapp_settings
        (location_id, tenant_id, status, phone_number_id, waba_id, display_phone,
         access_token_cipher, updated_by)
      SELECT ${params.locationId}::uuid,
             NULLIF(current_setting('app.tenant_id', true), '')::uuid,
             ${estado}::whatsapp_status,
             ${params.phoneNumberId}, ${params.wabaId}, ${params.numeroVisivel},
             ${cifrado}, ${params.staffId}::uuid
       WHERE EXISTS (SELECT 1 FROM locations WHERE id = ${params.locationId}::uuid)
      ON CONFLICT (location_id) DO UPDATE SET
        status = EXCLUDED.status,
        phone_number_id = EXCLUDED.phone_number_id,
        waba_id = EXCLUDED.waba_id,
        display_phone = EXCLUDED.display_phone,
        -- Ausente é "não mexa": COALESCE mantém o que já estava.
        access_token_cipher = COALESCE(EXCLUDED.access_token_cipher,
                                       whatsapp_settings.access_token_cipher),
        status_reason = NULL,
        updated_at = now(),
        updated_by = EXCLUDED.updated_by
    `;
    if (gravadas === 0) recusar('nao_configurado');

    /**
     * A rota do webhook, em dia com o cadastro.
     *
     * Sem esta linha o webhook da Meta chegaria com um `phone_number_id` que
     * ninguém sabe de quem é — e sem tenant não há como ler nada que tenha RLS.
     * Mora na mesma transação do cadastro porque as duas coisas são o mesmo
     * fato: este número é desta barbearia.
     */
    /**
     * A sobrescrita é condicionada à dona da linha.
     *
     * Sem o `WHERE`, a segunda barbearia a reivindicar o mesmo
     * `phone_number_id` **levava o roteamento** — e com ele o telefone e o texto
     * que os clientes da primeira escrevem, que passavam a ser gravados sob o
     * tenant de quem tomou. A política da migração 0078 é a camada que
     * sobrevive a uma reescrita deste arquivo; esta é a que produz a frase.
     *
     * A recusa tem a **mesma mensagem** de qualquer outra falha de gravação:
     * "este número é de outra barbearia" confirmaria o id para quem o adivinhou,
     * e é o precedente do OTP, que responde igual para telefone existente e
     * inexistente.
     */
    const roteamento = await tx.$executeRaw`
      INSERT INTO whatsapp_numbers (phone_number_id, tenant_id, location_id)
      VALUES (${params.phoneNumberId},
              NULLIF(current_setting('app.tenant_id', true), '')::uuid,
              ${params.locationId}::uuid)
      ON CONFLICT (phone_number_id) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id,
        location_id = EXCLUDED.location_id
      WHERE whatsapp_numbers.tenant_id
            = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    `;
    if (roteamento === 0) {
      recusar('numero_indisponivel');
    }

    /**
     * Auditado, e a trilha guarda **se** o token mudou, nunca o token.
     *
     * É o precedente do CPF no bloco 54: `audit_log` é append-only e legível por
     * quem administra a casa — uma credencial ali seria um segredo em repouso
     * que nenhuma limpeza alcança.
     */
    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'whatsapp.settings_changed',
      entity: 'whatsapp_settings',
      entityId: params.locationId,
      ...(antes ? { before: { estado: antes.estado, temToken: antes.temToken } } : {}),
      after: { estado, temToken, phoneNumberId: params.phoneNumberId },
    });

    const salvo = await cadastroDoWhatsApp(params.tenantId, params.locationId, tx);
    if (!salvo) recusar('nao_configurado');
    return salvo;
  });
}

/**
 * O token decifrado, para quem vai falar com a Meta.
 *
 * Não é exportado para a API: só o worker e o envio o chamam. A tela nunca
 * recebe o valor — `cadastroDoWhatsApp` devolve `temToken` e mais nada.
 */
async function tokenDaUnidade(tenantId: string, locationId: string): Promise<string> {
  const cifrado = await withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ access_token_cipher: string | null }[]>`
      SELECT access_token_cipher FROM whatsapp_settings
       WHERE location_id = ${locationId}::uuid AND status = 'ativo'
    `;
    return linhas[0]?.access_token_cipher ?? null;
  });
  if (!cifrado) recusar('nao_configurado');
  try {
    return decifrarCom(CHAVE_DO_TOKEN, cifrado);
  } catch {
    // Chave de ambiente trocada, ou linha corrompida. Recusar alto é o certo:
    // seguir com token vazio produziria erro da Meta em toda mensagem.
    recusar('token_invalido');
  }
}

export { tokenDaUnidade as tokenDoWhatsApp };

// ---------------------------------------------------------------------------
// Os templates
// ---------------------------------------------------------------------------

export interface TemplateNaTela {
  readonly id: string;
  readonly tipo: TipoDeNotificacao;
  readonly nome: string;
  readonly idioma: string;
  readonly estado: EstadoDoTemplate;
  readonly corpo: string;
  readonly botoes: readonly BotaoDaMensagem[];
  readonly motivoDaRecusa: string | null;
}

const COLUNAS_DO_TEMPLATE = `id, kind::text AS kind, name, language, status::text AS status,
                             body, buttons, rejection_reason`;

const paraTela = (l: {
  id: string;
  kind: TipoDeNotificacao;
  name: string;
  language: string;
  status: EstadoDoTemplate;
  body: string;
  buttons: unknown;
  rejection_reason: string | null;
}): TemplateNaTela => ({
  id: l.id,
  tipo: l.kind,
  nome: l.name,
  idioma: l.language,
  estado: l.status,
  corpo: l.body,
  botoes: Array.isArray(l.buttons) ? (l.buttons as BotaoDaMensagem[]) : [],
  motivoDaRecusa: l.rejection_reason,
});

export async function templatesDaUnidade(
  tenantId: string,
  locationId: string,
): Promise<readonly TemplateNaTela[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRawUnsafe<Parameters<typeof paraTela>[0][]>(
      `SELECT ${COLUNAS_DO_TEMPLATE}
         FROM whatsapp_templates
        WHERE location_id = $1::uuid
        ORDER BY kind, created_at DESC`,
      locationId,
    );
    return linhas.map(paraTela);
  });
}

const NOME_DO_TEMPLATE = /^[a-z0-9_]{1,512}$/;

/**
 * Cria o texto e o manda para a Meta aprovar.
 *
 * A linha nasce **antes** da chamada, e é a mesma ordem da cobrança online do
 * bloco 41: a chamada acontece fora da transação, e se o processo cair depois
 * dela o template existiria na Meta e não aqui — invisível, e impossível de
 * consultar porque nem o nome estaria gravado.
 *
 * Os botões saem de `BOTOES_DO_AVISO`, não do formulário. O que a Meta aprova
 * precisa ser o que o motor manda: um template aprovado com "Remarcar" que o
 * lembrete de 2h não oferece seria aprovação gasta à toa, e o contrário —
 * mandar um botão que não foi aprovado — a Meta recusa na hora do envio.
 */
export async function submeterTemplate(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly tipo: TipoDeNotificacao;
  readonly nome: string;
  readonly idioma?: string;
  readonly corpo: string;
  readonly provider: WhatsAppProvider;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<TemplateNaTela> {
  if (!NOME_DO_TEMPLATE.test(params.nome)) recusar('nome_invalido');
  const idioma = params.idioma ?? 'pt_BR';
  const botoes = BOTOES_DO_AVISO[params.tipo];

  const criado = await withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO whatsapp_templates
        (tenant_id, location_id, kind, name, language, status, body, buttons)
      SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid,
             ${params.locationId}::uuid, ${params.tipo}::notification_kind,
             ${params.nome}, ${idioma}, 'pendente', ${params.corpo},
             ${JSON.stringify(botoes)}::jsonb
       WHERE EXISTS (SELECT 1 FROM locations WHERE id = ${params.locationId}::uuid)
      ON CONFLICT (location_id, name, language) DO UPDATE SET
        body = EXCLUDED.body,
        buttons = EXCLUDED.buttons,
        status = 'pendente',
        rejection_reason = NULL,
        updated_at = now()
      RETURNING id
    `;
    const linha = linhas[0];
    if (!linha) recusar('nao_configurado');

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'whatsapp.template_submitted',
      entity: 'whatsapp_templates',
      entityId: linha.id,
      after: { nome: params.nome, tipo: params.tipo },
    });
    return linha.id;
  });

  const resposta = await params.provider.submeterTemplate({
    nome: params.nome,
    idioma,
    corpo: params.corpo,
    botoes,
  });
  await gravarRespostaDoTemplate({ tenantId: params.tenantId, templateId: criado, resposta });

  const atual = await templateDaUnidade(params.tenantId, criado);
  if (!atual) recusar('template_nao_encontrado');
  return atual;
}

export async function templateDaUnidade(
  tenantId: string,
  templateId: string,
): Promise<TemplateNaTela | null> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRawUnsafe<Parameters<typeof paraTela>[0][]>(
      `SELECT ${COLUNAS_DO_TEMPLATE} FROM whatsapp_templates WHERE id = $1::uuid`,
      templateId,
    );
    const linha = linhas[0];
    return linha ? paraTela(linha) : null;
  });
}

export async function gravarRespostaDoTemplate(params: {
  readonly tenantId: string;
  readonly templateId: string;
  readonly resposta: { readonly metaId: string | null; readonly estado: EstadoDoTemplate; readonly motivoDaRecusa: string | null };
}): Promise<void> {
  await withTenant(params.tenantId, async (tx) => {
    await tx.$executeRaw`
      UPDATE whatsapp_templates
         SET meta_id = COALESCE(${params.resposta.metaId}, meta_id),
             status = ${params.resposta.estado}::whatsapp_template_status,
             rejection_reason = ${params.resposta.motivoDaRecusa},
             updated_at = now()
       WHERE id = ${params.templateId}::uuid
    `;
  });
}

/** Os templates que ainda esperam resposta da Meta. */
export async function templatesEmCurso(
  tenantId: string,
  limite = 50,
): Promise<readonly { readonly id: string; readonly nome: string; readonly idioma: string }[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ id: string; name: string; language: string }[]>`
      SELECT id, name, language FROM whatsapp_templates
       WHERE status = 'pendente'
       ORDER BY created_at
       LIMIT ${limite}
    `;
    return linhas.map((l) => ({ id: l.id, nome: l.name, idioma: l.language }));
  });
}

// ---------------------------------------------------------------------------
// O envio
// ---------------------------------------------------------------------------

export interface PedidoDeMensagem {
  readonly tenantId: string;
  readonly locationId: string;
  readonly tipo: TipoDeNotificacao;
  readonly telefone: string;
  readonly variaveis: readonly string[];
  readonly customerId: string | null;
  readonly appointmentId: string | null;
  readonly provider: WhatsAppProvider;
}

/**
 * Manda um aviso pelo WhatsApp, se der.
 *
 * Devolve `null` quando o canal não está disponível — cadastro inativo, template
 * não aprovado — e **não lança**: quem chama é o motor de aviso, que tem um
 * canal de reserva. A SPEC §4.12 pede isso em letras (*"fallback para SMS/push
 * quando o WhatsApp falha"*), e transformar canal indisponível em exceção faria
 * a tarefa da fila morrer em vez de cair para o outro caminho.
 *
 * A linha em `whatsapp_messages` nasce **depois** do envio, porque é o `wamid`
 * que a identifica e ele só existe depois. O que protege contra duplicata é a
 * unicidade dele: uma retentativa que já tinha enviado grava o mesmo id e
 * esbarra na constraint em vez de contar duas vezes.
 */
export async function enviarPeloWhatsApp(
  pedido: PedidoDeMensagem,
): Promise<{ readonly wamid: string } | null> {
  const cadastro = await cadastroDoWhatsApp(pedido.tenantId, pedido.locationId);
  if (!cadastro || !whatsappDisponivel(cadastro.estado)) return null;

  const template = await withTenant(pedido.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      { id: string; name: string; language: string; status: EstadoDoTemplate }[]
    >`
      SELECT id, name, language, status::text AS status
        FROM whatsapp_templates
       WHERE location_id = ${pedido.locationId}::uuid
         AND kind = ${pedido.tipo}::notification_kind
         AND status = 'aprovado'
       LIMIT 1
    `;
    return linhas[0] ?? null;
  });
  if (!template || !templateUtilizavel(template.status)) return null;

  const botoes = BOTOES_DO_AVISO[pedido.tipo];
  const respostas = pedido.appointmentId
    ? botoes.map((botao) => ({ botao, payload: montarPayload(botao, pedido.appointmentId!) }))
    : [];

  const enviada = await pedido.provider.enviar({
    para: pedido.telefone,
    template: template.name,
    idioma: template.language,
    variaveis: pedido.variaveis,
    respostas,
  });

  await withTenant(pedido.tenantId, async (tx) => {
    await tx.$executeRaw`
      INSERT INTO whatsapp_messages (tenant_id, wamid, customer_id, template_id)
      VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid,
              ${enviada.wamid}, ${pedido.customerId}::uuid, ${template.id}::uuid)
      ON CONFLICT (wamid) DO NOTHING
    `;
  });

  return { wamid: enviada.wamid };
}

// ---------------------------------------------------------------------------
// O que a Meta conta de volta
// ---------------------------------------------------------------------------

export type EstadoDaMensagem = 'enviada' | 'entregue' | 'lida' | 'falhou';

/**
 * Atualiza o que aconteceu com uma mensagem.
 *
 * Idempotente por `wamid`, e **só avança**: a Meta entrega os eventos fora de
 * ordem com frequência, e um `lida` chegando antes do `entregue` não pode fazer
 * a mensagem voltar. É o mesmo cuidado do espelho de consentimento no bloco 31,
 * que só avança se a decisão for a mais recente.
 */
const ORDEM: Readonly<Record<EstadoDaMensagem, number>> = {
  enviada: 0,
  entregue: 1,
  lida: 2,
  // Falha é terminal e vem de outro caminho: ela não compete com as três acima.
  falhou: 3,
};

export async function registrarEstadoDaMensagem(params: {
  readonly tenantId: string;
  readonly wamid: string;
  readonly estado: EstadoDaMensagem;
  readonly motivo?: string | null;
}): Promise<boolean> {
  /**
   * Sob `withTenant`, e a primeira versão não era — foi o teste que pegou.
   *
   * A tentação era usar `semTenant`, porque o webhook chega antes de sabermos
   * de quem é: a Meta manda o id da mensagem, não o nosso id de barbearia. Mas
   * sem tenant no contexto a política de RLS não casa com **nenhuma** linha, e
   * o `UPDATE` não achava nada — a função devolvia `false` para tudo, em
   * silêncio, e a mensagem ficaria "enviada" para sempre.
   *
   * Quem resolve o tenant é a porta do webhook, por `tenantDoNumero`, antes de
   * chamar aqui. É o mesmo desenho do webhook da Stripe: o metadado abre o
   * tenant, e o id procurado **dentro** dele é quem confirma.
   */
  return withTenant(params.tenantId, async (tx) => {
    const afetadas = await tx.$executeRaw`
      UPDATE whatsapp_messages
         SET status = ${params.estado}::whatsapp_message_status,
             failure_reason = COALESCE(${params.motivo ?? null}, failure_reason),
             delivered_at = CASE WHEN ${params.estado} IN ('entregue', 'lida')
                                 THEN COALESCE(delivered_at, now()) ELSE delivered_at END,
             read_at = CASE WHEN ${params.estado} = 'lida'
                            THEN COALESCE(read_at, now()) ELSE read_at END
       WHERE wamid = ${params.wamid}
         AND ${ORDEM[params.estado]} > CASE status::text
               WHEN 'enviada' THEN 0 WHEN 'entregue' THEN 1
               WHEN 'lida' THEN 2 ELSE 3 END
    `;
    return afetadas === 1;
  });
}

/**
 * Grava o toque no botão e enfileira o tratamento.
 *
 * Grava **antes** de tratar, e devolve rápido: a Meta desiste da entrega se o
 * webhook demorar, e reentrega — o que faria o mesmo cancelamento chegar duas
 * vezes. A unicidade por `wamid` é quem barra a segunda, e é por isso que ela
 * existe no banco e não só aqui.
 *
 * Quem mexe na agenda é `packages/scheduling`, pela tarefa. Este arquivo não
 * sabe cancelar horário nenhum, e é de propósito.
 */
export async function registrarResposta(params: {
  readonly tenantId: string;
  readonly wamid: string;
  readonly telefone: string;
  readonly payload: string | null;
  readonly texto: string | null;
}): Promise<{ readonly novo: boolean }> {
  return withTenant(params.tenantId, async (tx) => {
    const lido = lerPayload(params.payload);

    /**
     * O agendamento é **provado** antes de virar coluna, e a prova tem duas
     * partes.
     *
     * `lerPayload` confere forma — botão conhecido, UUID bem formado — e nada
     * mais. Gravá-lo direto na chave estrangeira seria confiar num id que
     * voltou pelo aparelho do cliente por um endereço público: a checagem de
     * integridade referencial do Postgres roda como dono da tabela e **ignora
     * row security**, então a chave aceitaria o horário de outra barbearia sem
     * reclamar. É a regra escrita do projeto, e a `/security-review` deste bloco
     * a cobrou aqui.
     *
     * A consulta abaixo dá as duas partes: a RLS filtra a barbearia, e o
     * `customer_id` — resolvido pelo telefone que a Meta mandou — filtra a
     * pessoa. A RLS separa barbearias e **não** separa clientes dentro de uma;
     * sem a segunda metade, quem descobrisse um id cancelaria o horário de
     * qualquer outro cliente da mesma casa.
     *
     * Não casou, grava nulo: a linha continua existindo — é o registro de que
     * alguém respondeu — e o desfecho explica por que nada foi feito. Recusar a
     * gravação inteira apagaria o rastro justamente do caso suspeito.
     */
    const donos = await tx.$queryRaw<{ id: string }[]>`
      SELECT a.id
        FROM appointments a
        JOIN customers c ON c.id = a.customer_id
       WHERE a.id = ${lido?.agendamentoId ?? null}::uuid
         AND c.phone_e164 = ${params.telefone}
    `;
    const agendamentoProvado = donos[0]?.id ?? null;

    const linhas = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO whatsapp_inbound
        (tenant_id, wamid, from_phone, payload, body, appointment_id, customer_id)
      SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid,
             ${params.wamid}, ${params.telefone}, ${params.payload}, ${params.texto},
             ${agendamentoProvado}::uuid,
             (SELECT id FROM customers WHERE phone_e164 = ${params.telefone} LIMIT 1)
      ON CONFLICT (wamid) DO NOTHING
      RETURNING id
    `;
    const linha = linhas[0];
    if (!linha) return { novo: false };

    await enfileirarPara(tx, params.tenantId, {
      kind: 'whatsapp.responder',
      // Id, nunca conteúdo: `jobs` não tem RLS, e o texto que o cliente digitou
      // é conversa dele com a casa.
      payload: { inboundId: linha.id },
      idempotencyKey: `whatsapp-inbound:${linha.id}`,
    });
    return { novo: true };
  });
}

export interface RespostaAExecutar {
  readonly id: string;
  readonly botao: BotaoDaMensagem | null;
  readonly agendamentoId: string | null;
  readonly customerId: string | null;
  readonly telefone: string;
  readonly texto: string | null;
}

export async function respostaAExecutar(
  tenantId: string,
  inboundId: string,
): Promise<RespostaAExecutar | null> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        payload: string | null;
        appointment_id: string | null;
        customer_id: string | null;
        from_phone: string;
        body: string | null;
      }[]
    >`
      SELECT id, payload, appointment_id, customer_id, from_phone, body
        FROM whatsapp_inbound
       WHERE id = ${inboundId}::uuid AND handled_at IS NULL
    `;
    const linha = linhas[0];
    if (!linha) return null;
    const lido = lerPayload(linha.payload);
    return {
      id: linha.id,
      botao: lido?.botao ?? null,
      agendamentoId: linha.appointment_id,
      customerId: linha.customer_id,
      telefone: linha.from_phone,
      texto: linha.body,
    };
  });
}

/**
 * Fecha a resposta com o que foi feito.
 *
 * O desfecho é escrito **sempre**, inclusive quando nada foi feito: "o horário
 * já tinha passado" e "o cliente escreveu um texto livre" são coisas diferentes,
 * e o balcão que abre a caixa de entrada precisa saber qual das duas foi. Sem o
 * carimbo, a linha voltaria à fila a cada volta do laço.
 */
export async function fecharResposta(params: {
  readonly tenantId: string;
  readonly inboundId: string;
  readonly desfecho: string;
}): Promise<boolean> {
  return withTenant(params.tenantId, async (tx) => {
    const afetadas = await tx.$executeRaw`
      UPDATE whatsapp_inbound
         SET handled_at = now(), outcome = ${params.desfecho}
       WHERE id = ${params.inboundId}::uuid AND handled_at IS NULL
    `;
    return afetadas === 1;
  });
}

// ---------------------------------------------------------------------------
// O botão virando ação
// ---------------------------------------------------------------------------

/**
 * O que fazer com o toque, decidido aqui e executado por quem sabe.
 *
 * Esta função **não** cancela nem remarca: ela lê a resposta, decide, chama a
 * ação que recebeu por parâmetro e fecha a linha com o desfecho. `crm` não
 * conhece `scheduling`, e a seta não vai voltar por causa de um botão.
 *
 * ## O filtro por cliente não é detalhe
 *
 * O payload volta **pelo aparelho do cliente** e chega por um endereço público.
 * A RLS separa barbearias e **não separa clientes dentro de uma**: sem o
 * `customerId`, quem descobrisse o id de um agendamento cancelaria o horário de
 * qualquer outra pessoa da mesma barbearia mandando um webhook forjado. É a
 * mesma regra que o cancelamento pelo site já cumpre desde o bloco 8.
 *
 * Resposta de quem não é cliente conhecido não vira ação nenhuma — e isso é
 * estado legítimo, não erro: gente escreve para o número da barbearia o tempo
 * todo, e o texto livre fica na caixa de entrada para alguém ler.
 */
export async function executarResposta(params: {
  readonly tenantId: string;
  readonly inboundId: string;
  readonly agora: Date;
  readonly cancelar: (entrada: {
    readonly tenantId: string;
    readonly appointmentId: string;
    readonly customerId: string;
    readonly agora: Date;
  }) => Promise<void>;
  readonly confirmar: (entrada: {
    readonly tenantId: string;
    readonly appointmentId: string;
    readonly customerId: string;
  }) => Promise<void>;
}): Promise<string> {
  const resposta = await respostaAExecutar(params.tenantId, params.inboundId);
  if (!resposta) return 'ja tratada';

  const fechar = async (desfecho: string) => {
    await fecharResposta({ tenantId: params.tenantId, inboundId: params.inboundId, desfecho });
    return desfecho;
  };

  /**
   * `agendamentoId` aqui é o **provado**, lido da coluna que só foi escrita
   * depois de casar barbearia e cliente. O que veio no payload não chega até
   * este ponto: sem prova, a coluna é nula e a resposta cai no caminho de baixo.
   */
  if (!resposta.botao) {
    // Texto livre: a pessoa escreveu em vez de tocar. Fica para alguém ler.
    return fechar('mensagem de texto, sem ação automática');
  }

  /**
   * Sem cliente conhecido, nada acontece.
   *
   * O telefone que a Meta manda é o do aparelho, e ele pode não estar no
   * cadastro — número novo, pessoa que nunca marcou, ou um webhook forjado.
   *
   * A ordem importa: esta pergunta vem **antes** da do agendamento porque as
   * duas dão nulo no mesmo caso, e sem separá-las quem tocou um botão de
   * número desconhecido lia "mensagem de texto" no balcão — que é falso e manda
   * procurar um texto que não existe.
   */
  if (!resposta.customerId) {
    return fechar('quem respondeu não está no cadastro — nada foi alterado');
  }

  /**
   * Botão com dono conhecido, mas sem horário provado.
   *
   * A coluna só foi escrita depois de casar barbearia **e** cliente. Nulo aqui
   * significa que o id que voltou não é um horário desta pessoa — horário de
   * outro cliente, de outra barbearia, ou que já não existe.
   */
  if (!resposta.agendamentoId) {
    return fechar('o horário não é de quem respondeu — nada foi alterado');
  }

  const entrada = {
    tenantId: params.tenantId,
    appointmentId: resposta.agendamentoId,
    customerId: resposta.customerId,
  };

  try {
    if (resposta.botao === 'cancelar') {
      await params.cancelar({ ...entrada, agora: params.agora });
      return fechar('horário cancelado pelo cliente');
    }
    if (resposta.botao === 'confirmar') {
      await params.confirmar(entrada);
      return fechar('presença confirmada');
    }
    /**
     * Remarcar e agendar de novo não têm ação automática, e é decisão.
     *
     * Escolher horário exige ver a grade, e uma mensagem de texto não tem grade.
     * Fingir que remarca — pegando o próximo horário livre, por exemplo — poria
     * a pessoa num horário que ela não escolheu. O que a mensagem faz é levá-la
     * ao site, e o que fica aqui é o registro de que ela quis.
     */
    return fechar(
      resposta.botao === 'remarcar' ? 'quer remarcar' : 'quer agendar de novo',
    );
  } catch (erro) {
    /**
     * A recusa do domínio é desfecho, não falha da tarefa.
     *
     * "Cancelou depois do prazo" e "o horário já passou" são respostas
     * legítimas, e relançá-las faria a tarefa ser retentada até esgotar as
     * tentativas — cinco chamadas que já sabem a resposta, e a linha ficaria
     * para sempre sem desfecho na caixa de entrada.
     */
    const motivo = erro instanceof Error ? erro.message : 'não deu para aplicar';
    return fechar(`não aplicado: ${motivo}`);
  }
}

// ---------------------------------------------------------------------------
// A assinatura do webhook da Meta
// ---------------------------------------------------------------------------

/**
 * A conta da Meta é **outra** que a do adquirente, e não dá para reaproveitar.
 *
 * Mora aqui e não em `packages/core` por duas razões, e as duas são regra
 * escrita: `core` não depende de nada — nem de `node:crypto` —, e o precedente
 * do adquirente põe `conferirAssinaturaDoWebhook` em `packages/platform`, ao
 * lado de quem consome o webhook.
 *
 * A Stripe assina `${instante}.${corpo}` e manda o instante no cabeçalho, o que
 * permite recusar reenvio antigo por janela de tempo. A Meta assina **só o
 * corpo cru**, em `X-Hub-Signature-256: sha256=<hex>`, com o *app secret* — não
 * há instante, então não há janela.
 *
 * O que substitui a janela é a idempotência por id de mensagem: reenviar um
 * evento capturado grava o mesmo `wamid`, esbarra na unicidade e não faz nada.
 * É por isso que aquela constraint existe no banco e não só no código.
 *
 * O segredo vem do ambiente e **falha alto quando ausente**: cair num padrão
 * vazio faria toda assinatura conferir, e o endereço é público.
 */
export type FalhaDaAssinatura =
  | 'segredo_ausente'
  | 'assinatura_ausente'
  | 'assinatura_malformada'
  | 'assinatura_invalida';

export class AssinaturaDoWhatsAppInvalida extends Error {
  constructor(readonly code: FalhaDaAssinatura) {
    super(code);
    this.name = 'AssinaturaDoWhatsAppInvalida';
  }
}

export function assinarWebhookDaMeta(entrada: {
  readonly corpoCru: string;
  readonly segredo: string;
}): string {
  return createHmac('sha256', entrada.segredo).update(entrada.corpoCru, 'utf8').digest('hex');
}

export function conferirAssinaturaDaMeta(entrada: {
  readonly corpoCru: string;
  readonly cabecalho: string | undefined;
  readonly segredo: string;
}): void {
  if (!entrada.segredo) throw new AssinaturaDoWhatsAppInvalida('segredo_ausente');
  if (!entrada.cabecalho) throw new AssinaturaDoWhatsAppInvalida('assinatura_ausente');

  const prefixo = 'sha256=';
  if (!entrada.cabecalho.startsWith(prefixo)) {
    throw new AssinaturaDoWhatsAppInvalida('assinatura_malformada');
  }
  const recebida = entrada.cabecalho.slice(prefixo.length);
  if (!/^[0-9a-f]+$/i.test(recebida)) {
    throw new AssinaturaDoWhatsAppInvalida('assinatura_malformada');
  }

  const esperada = assinarWebhookDaMeta(entrada);
  const a = Buffer.from(esperada, 'utf8');
  const b = Buffer.from(recebida, 'utf8');
  // Comprimento diferente já é recusa, e `timingSafeEqual` lança nesse caso —
  // conferir antes é o que transforma a exceção em recusa. E é `timingSafeEqual`
  // e nunca `===`: a comparação de string sai no primeiro byte diferente, e
  // isso basta para reconstruir a assinatura byte a byte.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AssinaturaDoWhatsAppInvalida('assinatura_invalida');
  }
}

/**
 * De quem é este número — a porta do webhook.
 *
 * `semTenant` aqui é legítimo e é o único lugar do arquivo em que ele é: a
 * tabela consultada **não tem RLS**, de propósito, porque o webhook chega antes
 * de existir tenant no contexto. É a mesma decisão de `tenant_slugs`, que
 * resolve a barbearia a partir do endereço público.
 *
 * O que ela devolve são dois ids opacos. Nada mais é lido sem tenant: o token,
 * as mensagens e as respostas moram em tabelas com RLS, e só são alcançadas
 * depois desta linha.
 */
export async function tenantDoNumero(
  phoneNumberId: string,
): Promise<{ readonly tenantId: string; readonly locationId: string } | null> {
  return semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<{ tenant_id: string; location_id: string }[]>`
      SELECT tenant_id, location_id FROM whatsapp_numbers
       WHERE phone_number_id = ${phoneNumberId}
    `;
    const linha = linhas[0];
    return linha ? { tenantId: linha.tenant_id, locationId: linha.location_id } : null;
  });
}
