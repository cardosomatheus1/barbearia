import {
  botaoConhecido,
  botaoQueLevaConhecido,
  type BotaoDaMensagem,
  type BotaoQueLeva,
  type TipoDeNotificacao,
  type WhatsAppProvider,
} from '@barbearia/core';
import { sql, withTenant } from '@barbearia/db';
import { registrarFalhaDaSubmissao } from './whatsapp-template-submissao.js';
import {
  destinosDosBotoes,
  gravarRespostaDoTemplate,
} from './whatsapp-templates.js';

/**
 * A ida à Meta, agora fora da requisição (bloco 133).
 *
 * ## Por que ela saiu do balcão
 *
 * Medido em produção: `POST /v1/admin/whatsapp/templates` levava **7.039 ms**,
 * contra o teto de 10 s que o `web` impõe a toda chamada de API. Três segundos
 * de folga numa viagem à rede da Meta, que é justamente o que varia.
 *
 * E o desfecho de estourar era o pior possível: o `web` aborta e mostra recusa,
 * a Meta **já recebeu o texto**, e a barbearia tenta de novo — recebendo então
 * a recusa por nome repetido, que não explica nada disso. Uma operação que diz
 * "não deu" sobre o que deu, e cujo conserto natural produz o erro seguinte.
 *
 * É o precedente da nota fiscal, escrito em letras: emissão **nunca** bloqueia
 * a venda — a nota nasce pendente dentro da transação, a fila fala com a
 * prefeitura, e a tela mostra o estado.
 *
 * ## O que ela relê, e por quê
 *
 * Tudo, do banco, sob `withTenant`. O `payload` da tarefa carrega só ids —
 * `jobs` não tem RLS —, e reler é o que garante que o que vai à Meta é o que
 * está gravado aqui, não uma cópia que envelheceu na fila.
 *
 * `buttons` guarda os dois tipos juntos desde o bloco 95, e a separação é por
 * predicado do domínio: resposta rápida vai como está, botão que leva precisa
 * do destino resolvido de novo. Reresolver e não guardar é o certo — o slug e o
 * telefone da casa podem ter mudado entre o pedido e a entrega, e o que a Meta
 * aprova é o que o cliente vai apertar.
 *
 * ## O claim é conferido, não presumido
 *
 * A tarefa pode chegar atrasada, depois de a barbearia ter corrigido o texto e
 * gerado outra reserva. Sem a conferência, a entrega velha gravaria a resposta
 * da Meta sobre o claim novo e o texto certo ficaria com o desfecho do errado.
 */
export async function entregarTemplateNaMeta(params: {
  readonly tenantId: string;
  readonly templateId: string;
  readonly claim: string;
  /**
   * Injetado, nunca resolvido aqui.
   *
   * É o mesmo motivo de `provider` existir no contrato desde o bloco 55: sem
   * ele, provar que a entrega manda os botões certos exigiria falar com a Meta
   * de verdade — e o que se quer provar é justamente o que sai daqui.
   */
  readonly provider: WhatsAppProvider;
}): Promise<void> {
  const alvo = await withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        location_id: string;
        kind: TipoDeNotificacao;
        name: string;
        language: string;
        body: string;
        buttons: unknown;
        meta_id: string | null;
      }[]
    >`
      SELECT location_id, kind::text AS kind, name, language, body, buttons, meta_id
        FROM whatsapp_templates
       WHERE id = ${params.templateId}::uuid
         AND submission_claim = ${params.claim}::uuid
         AND submission_state = 'sending'
    `;
    return linhas[0] ?? null;
  });
  /**
   * Nada a fazer, e **não** é erro.
   *
   * A reserva já foi fechada por outra volta, pela conciliação por nome, ou o
   * texto foi resubmetido com outro claim. Lançar faria a tarefa ser retentada
   * seis vezes contra uma linha que já tem desfecho — chamadas que já sabem a
   * resposta, que é a regra da escada que para na recusa definitiva.
   */
  if (!alvo) return;

  const guardados = Array.isArray(alvo.buttons) ? (alvo.buttons as string[]) : [];
  const botoes = guardados.filter((b): b is BotaoDaMensagem => botaoConhecido(b));
  const acoes = guardados.filter((b): b is BotaoQueLeva => botaoQueLevaConhecido(b));
  const destinos =
    acoes.length === 0 ? [] : await destinosDosBotoes(params.tenantId, alvo.location_id, acoes);

  /**
   * Editar quando a Meta já conhece o texto; criar quando não.
   *
   * Os dois são endpoints diferentes do lado dela, e o de criar é recusado
   * sobre um nome que já existe. Enquanto só ele era chamado, corrigir uma
   * vírgula num texto aprovado devolvia recusa da Meta numa frase que não
   * explicava nada — e o nome é derivado do tipo desde o bloco 89, então a
   * segunda submissão do mesmo aviso **sempre** cai nesse caso.
   */
  const paraAMeta = {
    nome: alvo.name,
    idioma: alvo.language,
    corpo: alvo.body,
    botoes,
    tipo: alvo.kind,
    acoes: destinos,
  };
  let resposta: Awaited<ReturnType<WhatsAppProvider['submeterTemplate']>>;
  try {
    resposta = alvo.meta_id
      ? await params.provider.editarTemplate(alvo.meta_id, paraAMeta)
      : await params.provider.submeterTemplate(paraAMeta);
  } catch (erro) {
    const transporteIncerto = erro instanceof Error && erro.name === 'WhatsAppMetaTransportError';
    await registrarFalhaDaSubmissao({
      tenantId: params.tenantId,
      templateId: params.templateId,
      claim: params.claim,
      incerta: transporteIncerto,
    });
    throw erro;
  }
  await gravarRespostaDoTemplate({
    tenantId: params.tenantId,
    templateId: params.templateId,
    resposta,
    claim: params.claim,
  });
}

/**
 * O texto que ficou preso porque a tarefa desistiu (bloco 133).
 *
 * ## O estado sem saída
 *
 * `whatsapp.submeter_template` nasce com cinco tentativas e uma escada de 1, 2,
 * 4, 8 e 16 minutos: em cerca de meia hora ela desiste. Sem esta varredura, a
 * linha ficaria em `sending` para sempre — e `sending` é justamente o estado
 * que **recusa a submissão seguinte** (`template_em_processamento`). A
 * barbearia perderia o texto e o caminho de refazê-lo ao mesmo tempo, sem erro
 * e sem alerta.
 *
 * É a lição escrita do bloco 121, sobre a nota fiscal: tarefa que se reprograma
 * e desiste precisa de varredura para o depois.
 *
 * ## Por que só quem nunca teve `meta_id`
 *
 * Com `meta_id`, a Meta **já conhece** o texto, e quem resolve é a conciliação
 * por nome — ela pergunta, recebe o estado e libera a linha. Soltar esses aqui
 * criaria a segunda submissão de um texto que a Meta já tem, que ela recusa por
 * nome repetido.
 *
 * Sem `meta_id` e depois do prazo, o fato é o oposto: nada chegou lá. Voltar a
 * `rascunho` é o que devolve o texto inteiro à tela, com o botão de mandar de
 * novo — e uma tarefa atrasada que chegasse depois não escreve nada, porque o
 * `claim` já não bate.
 *
 * Duas horas, e não trinta minutos: a escada leva meia hora para desistir, e
 * soltar antes disso produziria a submissão em duplicidade que o `claim` existe
 * para impedir.
 */
export const ESPERA_PARA_SOLTAR_TEXTO_PRESO = '2 hours';

export async function liberarTemplatesAbandonados(tenantId: string): Promise<number> {
  return withTenant(tenantId, async (tx) =>
    tx.$executeRaw(sql`
      UPDATE whatsapp_templates
         SET submission_state = 'idle',
             submission_claim = NULL,
             status = 'rascunho',
             submission_updated_at = now(),
             updated_at = now()
       WHERE submission_state = 'sending'
         AND meta_id IS NULL
         AND submission_updated_at < now() - ${ESPERA_PARA_SOLTAR_TEXTO_PRESO}::interval
    `),
  );
}
