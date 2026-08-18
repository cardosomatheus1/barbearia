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
  variaveisDoCorpo,
  botaoConhecido,
  BOTOES_QUE_A_CASA_ESCOLHE,
} from '@barbearia/core';
import { audit } from '@barbearia/identity';
import { registrarConsentimento } from './lgpd.js';

/**
 * O que fica gravado como "versão do texto" quando a saída foi por botão.
 *
 * Marcador fixo e não a versão do texto de marketing: a pessoa não leu nada,
 * ela apertou. Afirmar que leu seria prova falsa; nulo o `CHECK` recusa.
 */
const VERSAO_DA_SAIDA_PELO_BOTAO = 'saida-pelo-botao-do-whatsapp';
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
  | 'nome_invalido'
  | 'botao_invalido';

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
  botao_invalido:
    'Este botão precisa de um horário marcado, e quem recebe esta mensagem não tem um.',
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
  /**
   * As permissões que a Meta concedeu a este token, ou `null` (bloco 88).
   *
   * **Obrigatório e não opcional**, e a polaridade é o motivo: `escopos?` chega
   * `undefined` na primeira consulta que esquecer dele, e a tela leria isso
   * como "não dá para dizer" — calando o aviso justamente onde ele importa, com
   * o compilador satisfeito. É a regra do campo novo num tipo que decide
   * visibilidade, e aqui o silêncio é o erro caro.
   *
   * Nomes crus da Meta, não um booleano: quem os interpreta é
   * `podeGerenciarTemplates`, em `core`, e a pergunta seguinte se responde lá
   * sem migração.
   */
  readonly escopos: readonly string[] | null;
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
        granted_scopes: string[] | null;
      }[]
    >`
      SELECT status::text AS status, phone_number_id, waba_id, display_phone,
             status_reason, verified_at, granted_scopes,
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
      escopos: linha.granted_scopes,
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
  /**
   * O que a Meta concedeu, quando quem chama falou com ela (bloco 88).
   *
   * Opcional aqui e obrigatório na leitura, e os dois estão certos: o
   * formulário do bloco 55 é o caminho de quem já tem os ids e **nunca** fala
   * com a Meta, então ele não tem o que declarar. Ausente é "não mexa", como o
   * token — escrever `null` por omissão apagaria o que o Embedded Signup
   * descobriu toda vez que alguém corrigisse o número visível pela tela.
   */
  readonly escopos?: readonly string[] | null;
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
     *
     * ## Salvar não rebaixa o que já foi provado (bloco 91)
     *
     * A versão anterior escrevia `aguardando_verificacao` **sempre** que houvesse
     * token. Com isso, trocar o token de um canal ativo — rotação de credencial,
     * que é operação normal de segurança — devolvia a barbearia para "falta
     * confirmar o número", com `verified_at` preenchido na mesma linha. Os dois
     * campos passavam a discordar sobre o mesmo fato, e a tela mandava a pessoa
     * repetir um passo que ela já tinha feito.
     *
     * Aconteceu em produção: a conciliação promoveu às 15:00, o dono salvou o
     * token permanente às 15:0X, e o painel voltou a dizer que faltava verificar.
     *
     * A escada respeita o que existe: sem token não há cadastro; `suspenso` é
     * decisão da Meta e salvar não a desfaz — quem sai dela é a conciliação, que
     * é a única que fala com ela; posse já provada continua provada, porque
     * `verified_at` é um fato do passado e não muda por alguém colar um token
     * novo.
     */
    const temToken = cifrado !== null || (antes?.temToken ?? false);
    const estado: EstadoDoWhatsApp = !temToken
      ? 'nao_configurado'
      : antes?.estado === 'suspenso'
        ? 'suspenso'
        : antes?.verificadoEm
          ? 'ativo'
          : 'aguardando_verificacao';

    // A unidade vem do servidor, mas a conferência sob RLS fica: a chave
    // estrangeira aceita a de outra barbearia, porque a checagem referencial
    // ignora row security.
    const escopos = params.escopos === undefined ? null : (params.escopos as string[] | null);

    /**
     * O motivo vai **na linha proposta**, e não só no `DO UPDATE` (bloco 91).
     *
     * `ON CONFLICT` trata violação de índice único; a `CHECK` é avaliada na
     * linha que o `INSERT` propõe, **antes** de o conflito ser detectado. Com
     * `status_reason` fora da lista de colunas, um cadastro suspenso chegava à
     * `CHECK` como suspenso-sem-motivo e morria ali — o `DO UPDATE` que
     * preservaria o motivo nunca era alcançado.
     *
     * Levou uma reprodução em psql para achar: a mensagem do Postgres aponta a
     * constraint e o `DETAIL` mostra a linha do `INSERT`, com `created_at` igual
     * a `updated_at` — que é a pista de que não é a linha atualizada.
     */
    const motivo = estado === 'suspenso' ? (antes?.motivo ?? null) : null;

    const gravadas = await tx.$executeRaw`
      INSERT INTO whatsapp_settings
        (location_id, tenant_id, status, phone_number_id, waba_id, display_phone,
         access_token_cipher, granted_scopes, status_reason, updated_by)
      SELECT ${params.locationId}::uuid,
             NULLIF(current_setting('app.tenant_id', true), '')::uuid,
             ${estado}::whatsapp_status,
             ${params.phoneNumberId}, ${params.wabaId}, ${params.numeroVisivel},
             ${cifrado}, ${escopos}::text[], ${motivo}, ${params.staffId}::uuid
       WHERE EXISTS (SELECT 1 FROM locations WHERE id = ${params.locationId}::uuid)
      ON CONFLICT (location_id) DO UPDATE SET
        status = EXCLUDED.status,
        phone_number_id = EXCLUDED.phone_number_id,
        waba_id = EXCLUDED.waba_id,
        display_phone = EXCLUDED.display_phone,
        -- Ausente é "não mexa": COALESCE mantém o que já estava.
        access_token_cipher = COALESCE(EXCLUDED.access_token_cipher,
                                       whatsapp_settings.access_token_cipher),
        -- Mesma regra, e pelo mesmo motivo: quem salva pelo formulário não fala
        -- com a Meta e não tem escopo a declarar. Sobrescrever com nulo faria
        -- corrigir o número visível apagar o que o Embedded Signup descobriu.
        granted_scopes = COALESCE(EXCLUDED.granted_scopes,
                                  whatsapp_settings.granted_scopes),
        -- Quem decidiu o motivo foi a linha proposta, acima: suspenso conserva o
        -- que estava, e todo outro estado o limpa. Motivo velho ao lado de um
        -- cadastro que voltou a funcionar é a tela explicando uma falha que já
        -- passou.
        status_reason = EXCLUDED.status_reason,
        updated_at = now(),
        updated_by = EXCLUDED.updated_by
    `;
    if (gravadas === 0) recusar('nao_configurado');

    /**
     * A rota do número **anterior** sai (bloco 88).
     *
     * `whatsapp_settings` é por unidade e o `ON CONFLICT (location_id)` acima
     * sobrescreve a linha inteira, então trocar de número deixava a linha velha
     * de `whatsapp_numbers` órfã — apontando para esta barbearia, para sempre,
     * por um `phone_number_id` que já não é dela.
     *
     * Hoje isso é estado morto; no dia em que a Meta reciclar aquele id para
     * outra empresa, o webhook dela cai aqui dentro: telefone e texto de
     * cliente alheio gravados sob o nosso tenant, que é exatamente o vazamento
     * que o `WHERE` de dono logo abaixo existe para impedir — na direção
     * contrária. Uma barbearia trocando de conta da Meta é o caminho normal
     * depois de um bloqueio, não caso raro.
     *
     * Sem `tenant_id` no `WHERE`: a política de remoção da 0078 é quem filtra, e
     * repeti-la aqui mascararia política ausente.
     *
     * O `location_id`, ao contrário, **não** é defesa repetida — ele é a regra.
     * Numa rede, a unidade que assumiu o número antigo da outra é dona legítima
     * daquela linha: sem o filtro, a matriz reconectando com um número novo
     * apagaria a rota da filial que ficou com o velho, e o webhook da filial
     * passaria a chegar sem dono. Trocar de número entre unidades é raro; ficar
     * sem receber mensagem por causa disso não teria explicação nenhuma na tela.
     */
    if (antes?.phoneNumberId && antes.phoneNumberId !== params.phoneNumberId) {
      await tx.$executeRaw`
        DELETE FROM whatsapp_numbers
         WHERE phone_number_id = ${antes.phoneNumberId}
           AND location_id = ${params.locationId}::uuid
      `;
    }

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
 * Pergunta à Meta se a posse do número já foi provada, e promove (bloco 90).
 *
 * ## O estado que nunca chegava
 *
 * `whatsapp_settings.status` nascia em `aguardando_verificacao` desde o bloco
 * 55, e a única escrita depois disso era `suspenso`. **Nada promovia a
 * `ativo`** — o comentário de `salvarCadastroDoWhatsApp` dizia "quem o promove
 * é a Meta respondendo, pela conciliação", e essa conciliação não existia.
 *
 * O efeito não era a mensagem parar de sair: `provedorDoWhatsApp` nunca olhou
 * status, então o canal funcionava. Era pior de diagnosticar — o checklist da
 * tela lê `estado === 'ativo'` e ficava para sempre em "Passo 1: conectar o
 * número da barbearia", com o número conectado e mandando mensagem. Indicador
 * que nunca preenche é a §6 pergunta 5, e ensina quem opera a não olhar.
 *
 * ## Por que perguntar, e não deduzir
 *
 * Registrar o número na Cloud API e **provar a posse dele** são passos
 * diferentes: o segundo é a pessoa digitando, no painel da Meta, o código que
 * chega por SMS — fora do produto, minutos ou horas depois de conectar. Deduzir
 * `ativo` do registro bem-sucedido marcaria como pronto um cadastro que ainda
 * não pode receber nada.
 *
 * ## Só sobe, nunca desce
 *
 * A promoção é condicionada a `status = 'aguardando_verificacao'`. Sem isso,
 * uma resposta `NOT_VERIFIED` chegando depois de a Meta suspender o número
 * devolveria a barbearia para "falta confirmar" e apagaria o motivo da
 * suspensão, que é a única frase que explica por que as mensagens pararam.
 * Quem desce é `suspenderNumero`, e só ela.
 */
export async function conciliarNumero(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly provider: WhatsAppProvider;
  readonly agora: Date;
}): Promise<{ readonly verificado: boolean; readonly promovido: boolean }> {
  const estado = await params.provider.consultarNumero();
  if (!estado.verificado) return { verificado: false, promovido: false };

  const promovidas = await withTenant(params.tenantId, async (tx) => {
    return tx.$executeRaw`
      UPDATE whatsapp_settings
         SET status = 'ativo',
             verified_at = ${params.agora},
             -- O número como a Meta o escreve vence o que foi digitado à mão,
             -- e ausente é "não mexa", como em todo campo opcional daqui.
             display_phone = COALESCE(${estado.numeroVisivel}, display_phone),
             updated_at = now()
       WHERE location_id = ${params.locationId}::uuid
         AND status = 'aguardando_verificacao'
    `;
  });

  return { verificado: true, promovido: promovidas > 0 };
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
  /**
   * O nome em português, quando a barbearia deu um (bloco 94).
   *
   * Nulo é texto anterior ao bloco: a tela cai no rótulo do tipo, que é o que
   * ela já mostrava. Com vários textos do mesmo tipo, é ele que os distingue —
   * o `nome` é o identificador da Meta e não distingue nada para quem lê.
   */
  readonly titulo: string | null;
  readonly idioma: string;
  readonly estado: EstadoDoTemplate;
  readonly corpo: string;
  readonly botoes: readonly BotaoDaMensagem[];
  readonly motivoDaRecusa: string | null;
}

const COLUNAS_DO_TEMPLATE = `id, kind::text AS kind, name, titulo, language,
                             status::text AS status, body, buttons, rejection_reason`;

const paraTela = (l: {
  id: string;
  kind: TipoDeNotificacao;
  name: string;
  titulo: string | null;
  language: string;
  status: EstadoDoTemplate;
  body: string;
  buttons: unknown;
  rejection_reason: string | null;
}): TemplateNaTela => ({
  id: l.id,
  tipo: l.kind,
  nome: l.name,
  titulo: l.titulo,
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
/**
 * O identificador da Meta a partir do título que a barbearia escreveu.
 *
 * A Meta só aceita minúsculas, números e sublinhado — sem acento, sem espaço,
 * sem pontuação. Até o bloco 89 o balcão era obrigado a acertar isso na mão, e
 * "Lembrete 24h" voltava como "Parâmetro inválido: nome"; depois disso o nome
 * passou a sair do tipo, o que deu **um texto por tipo** e fez as onze
 * automações possíveis mandarem a mesma frase.
 *
 * Sai do título para que dois títulos diferentes produzam dois textos. Sem
 * título — que é o caminho dos seis avisos do motor — continua saindo do tipo.
 *
 * A colisão é possível ("Volta, Carlos!" e "volta carlos" dão o mesmo) e é
 * tratada onde ela aparece: o `ON CONFLICT` reescreve o texto daquele nome, que
 * é o comportamento certo para quem está corrigindo o mesmo texto e o errado
 * para quem queria um segundo. A tela avisa antes, comparando os títulos.
 */
export function identificadorDoTexto(titulo: string | undefined, tipo: TipoDeNotificacao): string {
  const limpo = (titulo ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return limpo === '' ? tipo : limpo;
}

export async function submeterTemplate(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly tipo: TipoDeNotificacao;
  /**
   * O nome do template na Meta — e por padrão **é o próprio tipo do aviso**.
   *
   * A regra da Meta é minúsculas, números e sublinhado, sem acento e sem
   * espaço. É identificador de sistema, e o balcão estava sendo obrigado a
   * digitá-lo: "Lembrete 24h" batia na validação e voltava como "Parâmetro
   * inválido: nome", sobre um campo que a pessoa não tem como acertar sem
   * conhecer a documentação da Meta.
   *
   * Os tipos deste produto já são nomes válidos (`lembrete_24h`,
   * `convite_retorno`), e a tela diz "um por aviso" — então o nome é derivado e
   * o campo saiu. Continua aceito por parâmetro para quem tem um nome já
   * aprovado do lado de lá e precisa casar com ele.
   */
  readonly nome?: string;
  /**
   * O nome que a barbearia deu ao texto, em português (bloco 94).
   *
   * `nome` é o identificador da Meta e só aceita minúsculas, números e
   * sublinhado — nunca foi para ser lido por gente. Com vários textos do mesmo
   * tipo, a tela precisa de algo que os distinga, e "retorno_2" não distingue
   * nada.
   *
   * É ele que gera o identificador quando não vem um pronto, então dois títulos
   * diferentes produzem dois textos, que é o ponto deste bloco inteiro.
   */
  readonly titulo?: string;
  /**
   * Os botões deste texto, quando a barbearia escolheu (bloco 94).
   *
   * Ausente cai em `BOTOES_DO_AVISO`, que é o caminho dos seis avisos que o
   * motor dispara sozinho. Quem escreve um texto de campanha escolhe entre os
   * dois que agem sem horário marcado — os outros precisam de um agendamento
   * provado, e quem recebe campanha não tem.
   */
  readonly botoes?: readonly BotaoDaMensagem[];
  readonly idioma?: string;
  readonly corpo: string;
  readonly provider: WhatsAppProvider;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<TemplateNaTela> {
  const nome = params.nome ?? identificadorDoTexto(params.titulo, params.tipo);
  if (!NOME_DO_TEMPLATE.test(nome)) recusar('nome_invalido');
  const idioma = params.idioma ?? 'pt_BR';

  /**
   * Os botões escolhidos, conferidos contra o que a barbearia **pode** escolher.
   *
   * A borda também confere, e as duas camadas existem porque uma delas é a que
   * sobrevive: `confirmar` e `cancelar` mexem num agendamento provado, e um
   * texto de campanha não tem nenhum. Aprovado com eles, o cliente apertaria e
   * o produto responderia "o horário não é de quem respondeu" — nada acontece,
   * e ninguém sabe por quê.
   */
  const escolhidos = params.botoes;
  if (escolhidos?.some((b) => !BOTOES_QUE_A_CASA_ESCOLHE.includes(b))) {
    recusar('botao_invalido');
  }
  const botoes = escolhidos ?? BOTOES_DO_AVISO[params.tipo];

  /**
   * O id que a Meta já deu a este texto, **antes** de a linha ser reescrita.
   *
   * É ele que decide criar ou editar. Lido depois do `INSERT ... ON CONFLICT`
   * ele já estaria lá de qualquer jeito — a coluna é preservada —, mas ler
   * antes deixa a decisão explícita em vez de depender de um `COALESCE` três
   * linhas acima continuar existindo.
   */
  const jaNaMeta = await withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ meta_id: string | null }[]>`
      SELECT meta_id FROM whatsapp_templates
       WHERE location_id = ${params.locationId}::uuid AND name = ${nome} AND language = ${idioma}
    `;
    return linhas[0]?.meta_id ?? null;
  });

  const criado = await withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO whatsapp_templates
        (tenant_id, location_id, kind, name, language, status, body, buttons, titulo)
      SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid,
             ${params.locationId}::uuid, ${params.tipo}::notification_kind,
             ${nome}, ${idioma}, 'pendente', ${params.corpo},
             ${JSON.stringify(botoes)}::jsonb, ${params.titulo ?? null}
       WHERE EXISTS (SELECT 1 FROM locations WHERE id = ${params.locationId}::uuid)
      ON CONFLICT (location_id, name, language) DO UPDATE SET
        body = EXCLUDED.body,
        buttons = EXCLUDED.buttons,
        titulo = COALESCE(EXCLUDED.titulo, whatsapp_templates.titulo),
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
      after: { nome, tipo: params.tipo },
    });
    return linha.id;
  });

  /**
   * Editar quando a Meta já conhece o texto; criar quando não.
   *
   * Os dois são endpoints diferentes do lado dela, e o de criar é recusado
   * sobre um nome que já existe. Enquanto só ele era chamado, corrigir uma
   * vírgula num texto aprovado devolvia recusa da Meta numa frase que não
   * explicava nada — e o nome é derivado do tipo desde o bloco 89, então a
   * segunda submissão do mesmo aviso **sempre** cai nesse caso.
   */
  const paraAMeta = { nome, idioma, corpo: params.corpo, botoes, tipo: params.tipo };
  const resposta = jaNaMeta
    ? await params.provider.editarTemplate(jaNaMeta, paraAMeta)
    : await params.provider.submeterTemplate(paraAMeta);
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
  /**
   * Qual texto mandar, quando quem chama escolheu (bloco 94).
   *
   * Ausente resolve por tipo, que é o caminho do motor — ele dispara sozinho e
   * não tem quem escolha. A automação e a campanha escolhem, e é isso que faz
   * onze gatilhos diferentes deixarem de mandar a mesma frase.
   */
  readonly templateId?: string | null;
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
/**
 * Os botões gravados na linha do template, conferidos um a um.
 *
 * `jsonb` não tem tipo do lado de cá, e o que estiver ali foi escrito por uma
 * versão anterior deste código ou por uma migração. Um valor que não é botão
 * conhecido é descartado em silêncio — mandá-lo à Meta seria erro de envio, e
 * recusar a mensagem inteira por um botão estranho tiraria do ar um texto que
 * funciona.
 */
function botoesDaLinha(bruto: unknown): readonly BotaoDaMensagem[] {
  if (!Array.isArray(bruto)) return [];
  return bruto.filter((b): b is BotaoDaMensagem => typeof b === 'string' && botaoConhecido(b));
}

export async function enviarPeloWhatsApp(
  pedido: PedidoDeMensagem,
): Promise<{ readonly wamid: string } | null> {
  const cadastro = await cadastroDoWhatsApp(pedido.tenantId, pedido.locationId);
  if (!cadastro || !whatsappDisponivel(cadastro.estado)) return null;

  /**
   * O texto **escolhido**, quando quem chama escolheu (bloco 94).
   *
   * Sem escolha, resolve por tipo como sempre — é o caminho do motor, que
   * dispara sozinho e não tem quem escolha. Com escolha, é a automação ou a
   * campanha dizendo qual dos textos daquele tipo ela manda: até este bloco
   * existia um só por tipo, e as onze automações possíveis saíam todas com a
   * mesma frase.
   *
   * O `location_id` continua no filtro nos dois casos: o id vem de uma linha
   * desta barbearia pela RLS, e a unidade é outra coisa — numa rede, o texto da
   * filial não é o da matriz.
   */
  const template = await withTenant(pedido.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        name: string;
        language: string;
        status: EstadoDoTemplate;
        body: string;
        buttons: unknown;
      }[]
    >`
      SELECT id, name, language, status::text AS status, body, buttons
        FROM whatsapp_templates
       WHERE location_id = ${pedido.locationId}::uuid
         AND status = 'aprovado'
         AND (
           (${pedido.templateId ?? null}::uuid IS NOT NULL AND id = ${pedido.templateId ?? null}::uuid)
           OR (${pedido.templateId ?? null}::uuid IS NULL
               AND kind = ${pedido.tipo}::notification_kind)
         )
       LIMIT 1
    `;
    return linhas[0] ?? null;
  });
  if (!template || !templateUtilizavel(template.status)) return null;

  /**
   * Quantas variáveis o texto **aprovado** pede — e é ele quem manda.
   *
   * A Meta recusa o envio quando a quantidade de parâmetros não bate com a do
   * template: mandar três para um texto sem nenhuma variável falha igual a
   * mandar nenhuma para um texto que tem três.
   *
   * Escrever variável é opcional, e a barbearia que escreve "seu agendamento
   * está confirmado, te esperamos em breve!" tem um texto perfeitamente válido.
   * Sem esta conta, ele seria **aprovado** pela Meta e falharia em todo envio —
   * a pior combinação possível, porque a tela diria "aprovado" e o cliente não
   * receberia nada.
   *
   * Pedidas a mais são cortadas; pedidas a menos deixam o canal indisponível,
   * que cai no de reserva em vez de queimar a chamada.
   */
  const pedidas = variaveisDoCorpo(template.body);
  if (pedidas > pedido.variaveis.length) return null;
  const variaveis = pedido.variaveis.slice(0, pedidas);

  /**
   * Os botões saem da **linha**, e não mais do tipo.
   *
   * O que a Meta aprovou é o que está gravado ali: `BOTOES_DO_AVISO` é o que se
   * pede na criação, e a linha é o que ela devolveu. Com textos escritos pela
   * barbearia — cada um com o seu conjunto — derivar do tipo mandaria os botões
   * de um texto junto do corpo de outro, e a Meta casa a resposta pela
   * **posição**: o cliente apertaria o primeiro e o produto entenderia outro.
   */
  const botoes = botoesDaLinha(template.buttons);
  /**
   * Os botões saem **sempre**, com ou sem agendamento.
   *
   * A versão anterior mandava zero quando `appointmentId` era nulo — que é o
   * caso de toda campanha, toda automação e toda mensagem avulsa. O texto era
   * aprovado com botão, a Meta o desenhava no cadastro, e o cliente recebia uma
   * mensagem sem botão nenhum. Ninguém do lado de cá via a diferença.
   */
  const respostas = botoes.map((botao) => ({
    botao,
    payload: montarPayload(botao, pedido.appointmentId),
  }));

  const enviada = await pedido.provider.enviar({
    para: pedido.telefone,
    template: template.name,
    idioma: template.language,
    variaveis,
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

/**
 * A Meta desconectou o número da Cloud API (bloco 85).
 *
 * ## Quando isto acontece
 *
 * Na coexistência, o número continua no aplicativo WhatsApp Business — e se o
 * cliente **registrar o aplicativo em outro aparelho**, a Meta desfaz o
 * pareamento e manda `ACCOUNT_OFFBOARDED`. O número volta a ser só do
 * aplicativo, e o produto para de conseguir mandar mensagem.
 *
 * ## Por que precisa de estado, e não de silêncio
 *
 * Sem tratar este evento, a tela continuaria dizendo **Ativo** enquanto toda
 * mensagem cai no canal de reserva — o defeito da §6 pergunta 6, com a
 * diferença de que aqui quem mente é o mundo, não a nossa consulta. O barbeiro
 * trocaria de celular numa terça e a barbearia descobriria pela falta que os
 * clientes não confirmam mais.
 *
 * Vai para `suspenso`, que é o estado que já significa "a Meta tirou o número
 * do ar, o motivo está escrito, e os avisos voltaram ao canal antigo". O token
 * **não** é apagado: reconectar é refazer o fluxo, e apagar a credencial aqui
 * só tiraria a informação de que ela existiu.
 */
export async function desconectarNumero(params: {
  readonly tenantId: string;
  readonly phoneNumberId: string;
  readonly motivo: string;
}): Promise<boolean> {
  return withTenant(params.tenantId, async (tx) => {
    const afetadas = await tx.$executeRaw`
      UPDATE whatsapp_settings
         SET status = 'suspenso', status_reason = ${params.motivo}, updated_at = now()
       WHERE phone_number_id = ${params.phoneNumberId}
         AND status <> 'suspenso'
    `;
    return afetadas === 1;
  });
}

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
   * Sair da lista age **sem** horário, e por isso vem antes da checagem dele.
   *
   * É o único botão deste produto que não fala de um agendamento: quem recebeu
   * uma campanha não tem horário marcado, e exigir um faria o pedido de parar
   * cair em "o horário não é de quem respondeu" — a pessoa apertaria, nada
   * aconteceria, e a mensagem seguinte chegaria igual. Depois disso ela não
   * aperta de novo: marca como spam, que derruba a qualidade do número e leva
   * o lembrete de horário junto.
   *
   * Revogação é **inserção** no histórico, nunca apagamento da concessão — é a
   * regra de `customer_consents` desde o bloco 33, e o espelho em
   * `customers.accepts_marketing` é atualizado por gatilho.
   *
   * A versão é um marcador fixo porque não houve texto lido: a pessoa apertou
   * um botão. Escrever a versão do texto de marketing afirmaria que ela leu
   * aquilo agora, o que é falso; nulo o `CHECK` recusa, e com razão. É a decisão
   * do motivo do ajuste de saldo, pela mesma razão.
   */
  if (resposta.botao === 'parar_de_receber') {
    await registrarConsentimento({
      tenantId: params.tenantId,
      customerId: resposta.customerId,
      finalidade: 'marketing',
      concedido: false,
      versaoDoTexto: VERSAO_DA_SAIDA_PELO_BOTAO,
    });
    return fechar('saiu da lista de promoções');
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
