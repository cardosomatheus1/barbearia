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
  ROTULO_DO_BOTAO_QUE_LEVA,
  categoriaDoAviso,
  exemplosDoCorpo,
  ROTULO_DO_BOTAO,
  type BotaoDaMensagem,
  type EstadoDoNumero,
  type EstadoDoTemplate,
  type MensagemEnviada,
  type MensagemParaEnviar,
  type RespostaDoTemplate,
  type TemplateParaAprovar,
  type WhatsAppProvider,
  WhatsAppDeliveryUnknownError,
} from '@barbearia/core';
import { decifrarCom } from '@barbearia/identity';
import {
  cadastroDoWhatsApp,
  conciliarNumero,
  gravarRespostaDoTemplate,
  templatesEmCurso,
} from './whatsapp.js';
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

class WhatsAppMetaTransportError extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'WhatsAppMetaTransportError';
  }
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
/**
 * Os botões no formato da Meta, dos três tipos que ela aceita.
 *
 * `QUICK_REPLY` volta para nós como mensagem e é o que aciona confirmar e
 * cancelar. `URL` e `PHONE_NUMBER` não voltam: o aparelho abre o navegador ou o
 * discador, e é justamente por isso que eles resolvem o que o "agendar
 * novamente" de resposta rápida nunca resolveu — aquele registra a intenção e
 * deixa a pessoa parada na conversa.
 *
 * A ordem importa: os de resposta rápida primeiro, como a Meta os desenha.
 */
function botoesDaMeta(template: TemplateParaAprovar): readonly unknown[] {
  const rapidos = template.botoes.map((botao: BotaoDaMensagem) => ({
    type: 'QUICK_REPLY',
    text: ROTULO_DO_BOTAO[botao],
  }));

  const levam = (template.acoes ?? []).map((a) =>
    a.botao === 'ligar'
      ? {
          type: 'PHONE_NUMBER',
          text: ROTULO_DO_BOTAO_QUE_LEVA[a.botao],
          phone_number: a.destino,
        }
      : { type: 'URL', text: ROTULO_DO_BOTAO_QUE_LEVA[a.botao], url: a.destino },
  );

  return [...rapidos, ...levam];
}

/**
 * O componente de corpo, com uma amostra por variável.
 *
 * A Meta **recusa** template cujas variáveis chegam sem exemplo, e a recusa vem
 * com o nome da política: *"Variáveis de modelo sem texto de amostra"*. O texto
 * fica rejeitado sem nunca ter sido lido — ela não tem como saber se `{{1}}` é
 * um nome, um valor em reais ou um link.
 *
 * Nada do nosso lado apontava para isso: a submissão respondia sucesso, o
 * estado virava `pendente`, e a rejeição chegava depois pelo painel dela. Foi o
 * que aconteceu com o primeiro texto de verdade deste produto.
 *
 * Texto sem variável nenhuma não leva `example`: mandar um arranjo vazio é a
 * mesma recusa por outro caminho.
 */
function corpoComAmostra(template: TemplateParaAprovar): unknown {
  const amostras = exemplosDoCorpo(template.tipo, template.corpo);
  if (amostras.length === 0) return { type: 'BODY', text: template.corpo };
  return {
    type: 'BODY',
    text: template.corpo,
    // `body_text` é um arranjo de arranjos: um conjunto de amostras por
    // exemplo, e a Meta aceita um só.
    example: { body_text: [amostras] },
  };
}

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

    let corpo: unknown;
    try {
      corpo = await this.chamar(`${this.credenciais.phoneNumberId}/messages`, {
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
    } catch (erro) {
      if (erro instanceof WhatsAppMetaTransportError) {
        throw new WhatsAppDeliveryUnknownError(
          'a conexão com a Meta terminou antes de confirmar se a mensagem foi aceita',
        );
      }
      throw erro;
    }

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
      throw new WhatsAppDeliveryUnknownError(
        `a Meta respondeu sucesso para ${mascarar(mensagem.para)}, mas não devolveu wamid`,
      );
    }
    return { wamid };
  }

  /**
   * Submete um texto para aprovação.
   *
   * A categoria sai de `categoriaDoAviso`, que a deriva do **tipo** — e não do
   * conjunto de botões, como esta linha fazia antes. Botão era um palpite bom
   * para quase tudo e errado para `sua_vez`: sem botão nenhum, a mensagem mais
   * transacional do produto ia declarada como marketing, que aprova menos,
   * custa mais e é a primeira que a Meta limita em número novo.
   */
  async submeterTemplate(template: TemplateParaAprovar): Promise<RespostaDoTemplate> {
    const componentes: unknown[] = [corpoComAmostra(template)];
    const botoes = botoesDaMeta(template);
    if (botoes.length > 0) componentes.push({ type: 'BUTTONS', buttons: botoes });

    const corpo = await this.chamar(`${this.credenciais.wabaId}/message_templates`, {
      name: template.nome,
      language: template.idioma,
      category: categoriaDoAviso(template.tipo),
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
  /**
   * Reescreve um texto que a Meta já conhece.
   *
   * `POST /{id-do-template}` e não `POST /{waba}/message_templates`: o segundo
   * **cria**, e criar sobre um nome existente é recusado. Enquanto só o de
   * criar existia aqui, corrigir uma vírgula num texto aprovado era impossível
   * pela tela — o produto tinha o `meta_id` guardado desde o bloco 55 e não o
   * usava para nada.
   *
   * Nome e idioma não vão no corpo: a Meta não deixa mudá-los na edição, e
   * mandá-los seria pedir o que ela recusa. O que se reescreve é o corpo e os
   * botões, e um texto editado volta para análise — por isso a resposta é lida
   * pelo mesmo caminho da submissão.
   */
  async editarTemplate(metaId: string, template: TemplateParaAprovar): Promise<RespostaDoTemplate> {
    const componentes: unknown[] = [corpoComAmostra(template)];
    const botoes = botoesDaMeta(template);
    if (botoes.length > 0) componentes.push({ type: 'BUTTONS', buttons: botoes });

    await this.chamar(metaId, { components: componentes });

    /**
     * A Meta responde `{ success: true }` na edição, sem estado.
     *
     * Ela recoloca o texto em análise, então o estado é `pendente` — e não o que
     * ele era antes. Ler "aprovado" de uma resposta que não diz nada faria o
     * produto mandar por um texto que a Meta ainda está olhando.
     */
    return { metaId, estado: 'pendente', motivoDaRecusa: null };
  }

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
   * A posse do número, perguntada à Meta (bloco 90).
   *
   * `code_verification_status` é dela e tem três valores: `VERIFIED`,
   * `NOT_VERIFIED` e `EXPIRED`. Só o primeiro conta, e a comparação é por
   * igualdade e não por "diferente de NOT_VERIFIED": um valor novo que ela
   * invente amanhã seria lido como verificado, e o cadastro subiria para
   * `ativo` sobre um número que ninguém provou possuir.
   *
   * `display_phone_number` vem junto porque é o mesmo GET, e é o número **como
   * a Meta o escreve** — melhor que o que a pessoa digitou no formulário, que é
   * o que a tela mostra hoje quando a conexão foi manual.
   */
  async consultarNumero(): Promise<EstadoDoNumero> {
    const url = new URL(`${BASE}/${this.credenciais.phoneNumberId}`);
    url.searchParams.set('fields', 'code_verification_status,display_phone_number');
    const corpo = (await this.chamar(url, null)) as {
      code_verification_status?: string;
      display_phone_number?: string;
    };

    return {
      verificado: corpo.code_verification_status === 'VERIFIED',
      numeroVisivel: corpo.display_phone_number ?? null,
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

    let resposta: Response;
    try {
      resposta = await this.buscar(url, {
        method: corpo === null ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${this.credenciais.token}`,
          ...(corpo === null ? {} : { 'content-type': 'application/json' }),
        },
        ...(corpo === null ? {} : { body: JSON.stringify(corpo) }),
        // Sem timeout uma Meta degradada prende o worker/API e cria justamente
        // o desfecho ambíguo que o envio manual precisa tratar. Quinze segundos
        // são suficientes para uma chamada de API; depois disso, a verdade é
        // "não sabemos se aceitou", nunca "falhou".
        signal: AbortSignal.timeout(15_000),
        // Um `302` para um endereço qualquer faria a credencial ser apresentada a
        // quem não é a Meta. É a mesma guarda do webhook de saída do bloco 79.
        redirect: 'manual',
      });
    } catch (erro) {
      const nome = erro instanceof Error ? erro.name : 'erro de rede';
      throw new WhatsAppMetaTransportError(`falha de transporte ao falar com a Meta (${nome})`);
    }

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

/**
 * Uma volta da conciliação para uma barbearia (bloco 90).
 *
 * É esta função que o worker injeta no `Contexto`: `jobs` não sabe falar com a
 * Meta e não pode aprender, e quem monta o processo liga as duas pontas.
 *
 * **Canal ausente devolve zero, nunca lança.** Barbearia sem WhatsApp
 * configurado é o caso comum — a varredura passa por todas —, e transformar
 * isso em exceção faria a tarefa ser retentada três vezes por barbearia por
 * volta, com a fila enchendo de falhas que não são falhas. É a mesma regra do
 * canal indisponível no motor de aviso.
 */
export async function conciliarWhatsAppDaUnidade(
  tenantId: string,
  locationId: string,
  agora: Date,
): Promise<{ readonly promovido: boolean; readonly templates: number }> {
  const provider = await provedorDoWhatsApp(tenantId, locationId);
  if (!provider) return { promovido: false, templates: 0 };

  const { promovido } = await conciliarNumero({ tenantId, locationId, provider, agora });

  /**
   * Os textos que ainda esperam, perguntados um a um.
   *
   * A recusa de **um** template não derruba a volta: a Meta responde 404 para
   * o que ela ainda não indexou, e deixar isso subir faria um texto recém-criado
   * impedir a conciliação de todos os outros — e do número junto.
   */
  const pendentes = await templatesEmCurso(tenantId, locationId);
  let conciliados = 0;
  for (const t of pendentes) {
    try {
      const resposta = await provider.consultarTemplate(t.nome, t.idioma);
      await gravarRespostaDoTemplate({ tenantId, templateId: t.id, resposta });
      conciliados += 1;
    } catch {
      // Fica para a volta seguinte: o estado na tela continua "Na Meta", que é
      // verdade, e a varredura roda de novo.
    }
  }

  return { promovido, templates: conciliados };
}
