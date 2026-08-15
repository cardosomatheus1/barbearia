/**
 * A Cloud API da Meta, de verdade (bloco 82).
 *
 * O contrato `WhatsAppProvider` existe desde o bloco 55 e tinha **uma**
 * implementação: a de mentira. `enviarPeloWhatsApp` também não tinha chamador
 * nenhum fora do teste. As duas coisas juntas significavam que uma barbearia
 * podia cadastrar o número, ver "Ativo" na tela, aprovar o template — e nenhuma
 * mensagem sairia, sem erro, sem log e sem nada ficar vermelho. É o defeito de
 * `blocks` na sua forma mais cara: a tela inteira pronta em cima de um caminho
 * que não existia.
 *
 * ## Sem SDK
 *
 * `fetch` e nada mais, como a Stripe do bloco 80. A superfície que este arquivo
 * usa da Graph API são três chamadas; uma dependência nova para isso seria uma
 * dependência para não fazer nada novo.
 *
 * ## O que vai para o log
 *
 * Nada do que identifica pessoa, e nunca o token. O erro que sobe carrega o
 * código da Meta e a frase dela — que é o que responde "por que a mensagem
 * parou de sair" — e o telefone sai mascarado, pelo mesmo mascarador do
 * provedor de console.
 */

import {
  ROTULO_DO_BOTAO,
  type BotaoDaMensagem,
  type EstadoDoTemplate,
  type MensagemEnviada,
  type MensagemParaEnviar,
  type RespostaDoTemplate,
  type TemplateParaAprovar,
  type WhatsAppProvider,
} from '@barbearia/core';
import { decifrarCom } from '@barbearia/identity';
import { cadastroDoWhatsApp } from './whatsapp.js';
import { withTenant } from '@barbearia/db';

/**
 * A versão da Graph API, fixada.
 *
 * A Meta aposenta versão por data e muda forma de resposta entre elas. Sem
 * fixar, o produto passaria a falar uma versão nova no dia em que ela virasse
 * padrão — e o sintoma seria "a mensagem parou de sair", que é o mais caro de
 * diagnosticar deste arquivo inteiro.
 */
const VERSAO = 'v21.0';
const BASE = `https://graph.facebook.com/${VERSAO}`;

/**
 * O interruptor do processo, e por que ele existe apesar de a credencial ser
 * por barbearia.
 *
 * Ao contrário do adquirente e do emissor fiscal, aqui a credencial mora no
 * banco, uma por barbearia — o cadastro preenchido **é** a decisão de mandar. O
 * que este interruptor decide é outra coisa: se **este processo** fala com a
 * internet. Sem ele, um dump de produção restaurado numa máquina de
 * desenvolvimento começaria a mandar promoção para a base de clientes de
 * verdade no primeiro `pnpm dev` — e ninguém teria decidido isso.
 *
 * Valor desconhecido falha alto, pelo precedente de `PSP_MODO`: lido com
 * tolerância, `WHATSAPP_MODO=cloud` viraria "desligado" e a barbearia
 * descobriria pelo cliente que o lembrete não chega.
 */
export type ModoDoWhatsApp = 'nenhum' | 'meta';

export function modoDoWhatsApp(bruto = process.env['WHATSAPP_MODO']): ModoDoWhatsApp {
  if (bruto === undefined || bruto === '') return 'nenhum';
  if (bruto === 'nenhum' || bruto === 'meta') return bruto;
  throw new Error(
    `WHATSAPP_MODO inválido: ${bruto}. Use nenhum ou meta — ` +
      'não existe terceiro canal integrado, e inventar um nome não contrata nenhum.',
  );
}

const CHAVE_DO_TOKEN = 'WHATSAPP_TOKEN_KEY';

function mascarar(telefone: string): string {
  return telefone.length <= 4 ? '***' : `***${telefone.slice(-4)}`;
}

export class WhatsAppMetaError extends Error {
  constructor(
    readonly codigoDaMeta: number | null,
    mensagem: string,
  ) {
    super(mensagem);
    this.name = 'WhatsAppMetaError';
  }
}

interface ErroDaMeta {
  readonly error?: {
    readonly message?: string;
    readonly code?: number;
    /**
     * O que distingue duas recusas com o mesmo `code`.
     *
     * A Meta reusa `code: 100` para quase tudo, e é o `error_subcode` que
     * separa "permissão faltando" de "parâmetro errado". Sem ele, a recusa é
     * indistinguível de dentro, e a investigação vira tentativa.
     */
    readonly error_subcode?: number;
    readonly type?: string;
    /** O único identificador que o suporte da Meta aceita num chamado. */
    readonly fbtrace_id?: string;
    readonly error_user_msg?: string;
  };
}

/**
 * O provedor de uma barbearia.
 *
 * Recebe as credenciais já decifradas: quem sabe abrir o cofre é
 * `provedorDoWhatsApp`, logo abaixo, e manter as duas coisas separadas é o que
 * permite exercitar esta classe contra a Graph API sem passar pelo banco.
 */
export class MetaWhatsAppProvider implements WhatsAppProvider {
  constructor(
    private readonly credenciais: {
      readonly phoneNumberId: string;
      readonly wabaId: string;
      readonly token: string;
    },
    private readonly buscar: typeof fetch = fetch,
  ) {}

  /**
   * Manda um template aprovado.
   *
   * O corpo é montado a partir das variáveis posicionais e dos botões que o
   * **tipo** do aviso determina — nunca de algo escolhido no formulário, porque
   * o que a Meta aprovou precisa ser o que o motor manda.
   */
  async enviar(mensagem: MensagemParaEnviar): Promise<MensagemEnviada> {
    const componentes: unknown[] = [];

    if (mensagem.variaveis.length > 0) {
      componentes.push({
        type: 'body',
        parameters: mensagem.variaveis.map((texto) => ({ type: 'text', text: texto })),
      });
    }

    /**
     * Um componente por botão, com o índice **posicional**.
     *
     * A Meta casa o payload com o botão pela posição no template aprovado, não
     * pelo texto. Como os botões saem de `BOTOES_DO_AVISO` — que é a mesma
     * lista que gerou o template —, a ordem bate por construção.
     */
    mensagem.respostas.forEach((resposta, indice) => {
      componentes.push({
        type: 'button',
        sub_type: 'quick_reply',
        index: String(indice),
        parameters: [{ type: 'payload', payload: resposta.payload }],
      });
    });

    const corpo = await this.chamar(`${this.credenciais.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: mensagem.para,
      type: 'template',
      template: {
        name: mensagem.template,
        language: { code: mensagem.idioma },
        ...(componentes.length > 0 ? { components: componentes } : {}),
      },
    });

    const aceita = (corpo as { messages?: { id?: string; message_status?: string }[] }).messages?.[0];

    /**
     * `paused` é 200 e **não** é entrega.
     *
     * A Meta responde 200 com `message_status: paused` quando o índice de
     * qualidade do template caiu: a mensagem foi aceita e não vai sair. Contar
     * como enviada carimbaria o alvo, e o carimbo é definitivo — a pessoa
     * ficaria como "recebeu" sem nunca ter recebido, e o público inteiro
     * queimaria em silêncio na mesma volta.
     *
     * Sobe como erro de propósito: ele aborta o despacho, a fila retenta com
     * espera crescente, e o motivo fica em `jobs.last_error`. Continuar o laço
     * seria gastar as trezentas restantes contra um template que já se sabe
     * pausado. `held_for_quality_assessment` passa: ali a Meta ainda vai
     * entregar, só demora.
     */
    if (aceita?.message_status === 'paused') {
      throw new WhatsAppMetaError(
        null,
        `a Meta pausou o template "${mensagem.template}" — nada foi entregue. ` +
          'Ele volta sozinho quando o índice de qualidade se recuperar, e mandar menos é o que faz voltar.',
      );
    }

    const wamid = aceita?.id;
    if (!wamid) {
      // Resposta 2xx sem id é o pior desfecho possível: a mensagem pode ter
      // saído e não haveria como conciliar o webhook depois. Falha alto.
      throw new WhatsAppMetaError(
        null,
        `a Meta aceitou a mensagem para ${mascarar(mensagem.para)} e não devolveu wamid`,
      );
    }
    return { wamid };
  }

  /**
   * Submete um texto para aprovação.
   *
   * A categoria é `MARKETING` quando o texto não tem botão de agendamento e
   * `UTILITY` quando tem — e não é escolha estética: a Meta cobra as duas
   * diferente e recusa promoção declarada como utilidade. Quem decide é o
   * conjunto de botões, que já é derivado do tipo do aviso.
   */
  async submeterTemplate(template: TemplateParaAprovar): Promise<RespostaDoTemplate> {
    const componentes: unknown[] = [{ type: 'BODY', text: template.corpo }];
    if (template.botoes.length > 0) {
      componentes.push({
        type: 'BUTTONS',
        buttons: template.botoes.map((botao: BotaoDaMensagem) => ({
          type: 'QUICK_REPLY',
          text: ROTULO_DO_BOTAO[botao],
        })),
      });
    }

    const corpo = await this.chamar(`${this.credenciais.wabaId}/message_templates`, {
      name: template.nome,
      language: template.idioma,
      category: template.botoes.length > 0 ? 'UTILITY' : 'MARKETING',
      components: componentes,
    });

    const resposta = corpo as { id?: string; status?: string };
    return {
      metaId: resposta.id ?? null,
      estado: estadoDoTemplate(resposta.status),
      motivoDaRecusa: null,
    };
  }

  /** A rede de segurança da conciliação: pergunta em que pé o texto está. */
  async consultarTemplate(nome: string, idioma: string): Promise<RespostaDoTemplate> {
    const url = new URL(`${BASE}/${this.credenciais.wabaId}/message_templates`);
    url.searchParams.set('name', nome);
    const corpo = await this.chamar(url, null);

    const encontrados = (
      corpo as {
        data?: {
          id?: string;
          language?: string;
          status?: string;
          rejected_reason?: string;
        }[];
      }
    ).data;

    /**
     * O idioma faz parte da identidade do template.
     *
     * A Meta guarda `boas_vindas` em `pt_BR` e em `en_US` como duas linhas com
     * o mesmo nome. Pegar `data[0]` devolveria o estado de uma pela outra — o
     * defeito de `linhas[0]` de consulta sem ordem, com outra roupa.
     */
    const linha = encontrados?.find((t) => t.language === idioma) ?? null;
    if (!linha) return { metaId: null, estado: 'rascunho', motivoDaRecusa: null };

    const estado = estadoDoTemplate(linha.status);
    return {
      metaId: linha.id ?? null,
      estado,
      motivoDaRecusa: estado === 'rejeitado' ? (linha.rejected_reason ?? null) : null,
    };
  }

  /**
   * Uma chamada à Graph API.
   *
   * `corpo === null` é `GET`. O token vai no cabeçalho e **nunca** na URL:
   * endereço entra em log de proxy, em histórico e em `Referer`, e a
   * convenção deste repositório sobre código de erro na URL vale ainda mais
   * para credencial.
   */
  private async chamar(caminho: string | URL, corpo: unknown): Promise<unknown> {
    const url = caminho instanceof URL ? caminho : new URL(`${BASE}/${caminho}`);

    const resposta = await this.buscar(url, {
      method: corpo === null ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${this.credenciais.token}`,
        ...(corpo === null ? {} : { 'content-type': 'application/json' }),
      },
      ...(corpo === null ? {} : { body: JSON.stringify(corpo) }),
      // Um `302` para um endereço qualquer faria a credencial ser apresentada a
      // quem não é a Meta. É a mesma guarda do webhook de saída do bloco 79.
      redirect: 'manual',
    });

    const texto = await resposta.text();
    let json: unknown = null;
    try {
      json = texto ? JSON.parse(texto) : null;
    } catch {
      json = null;
    }

    if (!resposta.ok) {
      const erro = (json as ErroDaMeta | null)?.error;
      /**
       * A recusa inteira no log, e ela faltava neste caminho.
       *
       * O caminho da conexão já registrava; o do provedor — que é quem cria
       * template e manda mensagem — descartava tudo menos a frase. Quando a
       * Meta recusou um texto em produção, o log da API não tinha uma linha
       * sequer sobre isso, e as perguntas que decidem o diagnóstico
       * (`error_subcode`, `type`, `fbtrace_id`) ficaram sem resposta.
       *
       * O caminho entra para dizer **qual** chamada caiu, e ele carrega o id da
       * conta. A URL completa não: o token vai no cabeçalho, mas a query pode
       * crescer, e log é onde credencial fica em claro sem ninguém decidir.
       */
      console.error('[whatsapp] a Meta recusou', {
        passo: url.pathname,
        status: resposta.status,
        codigo: erro?.code ?? null,
        subcodigo: erro?.error_subcode ?? null,
        tipo: erro?.type ?? null,
        fbtrace: erro?.fbtrace_id ?? null,
        mensagem: erro?.error_user_msg ?? erro?.message ?? null,
      });
      throw new WhatsAppMetaError(
        erro?.code ?? null,
        erro?.error_user_msg ?? erro?.message ?? `a Meta respondeu ${resposta.status}`,
      );
    }
    return json;
  }
}

/**
 * O que a Meta chama de estado, no vocabulário do produto.
 *
 * O desconhecido vira `pendente` e não `aprovado`: um estado novo lido como
 * aprovado faria o produto mandar por um template que a Meta pode ter pausado,
 * e o caminho de conciliação existe justamente para descobrir isso na volta
 * seguinte.
 */
function estadoDoTemplate(bruto: string | undefined): EstadoDoTemplate {
  switch ((bruto ?? '').toUpperCase()) {
    case 'APPROVED':
      return 'aprovado';
    case 'REJECTED':
      return 'rejeitado';
    case 'PAUSED':
    case 'DISABLED':
      return 'pausado';
    default:
      return 'pendente';
  }
}

/**
 * O provedor de uma barbearia, ou `null`.
 *
 * `null` — e não uma exceção — quando o canal não está disponível: quem chama
 * tem canal de reserva, e a SPEC §4.12 pede isso em letras. É a mesma decisão
 * de `enviarPeloWhatsApp`, e transformar "não configurado" em exceção faria a
 * tarefa da fila morrer em vez de cair para o outro caminho.
 */
export async function provedorDoWhatsApp(
  tenantId: string,
  locationId: string,
  modo = modoDoWhatsApp(),
): Promise<WhatsAppProvider | null> {
  if (modo !== 'meta') return null;

  const cadastro = await cadastroDoWhatsApp(tenantId, locationId);
  if (!cadastro?.temToken || !cadastro.phoneNumberId || !cadastro.wabaId) return null;

  /**
   * O token cifrado é lido aqui, e não em `cadastroDoWhatsApp`.
   *
   * Aquela função serve a tela, e a tela recebe **se** existe token, nunca o
   * valor — devolvê-lo faria toda abertura da tela de configurações mandar uma
   * credencial viva pela rede. Esta consulta é a exceção escrita, do tamanho
   * exato de uma coluna.
   */
  const cifrado = await withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ access_token_cipher: string | null }[]>`
      SELECT access_token_cipher FROM whatsapp_settings
       WHERE location_id = ${locationId}::uuid
    `;
    return linhas[0]?.access_token_cipher ?? null;
  });
  if (!cifrado) return null;

  return new MetaWhatsAppProvider({
    phoneNumberId: cadastro.phoneNumberId,
    wabaId: cadastro.wabaId,
    token: decifrarCom(CHAVE_DO_TOKEN, cifrado),
  });
}
