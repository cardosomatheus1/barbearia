import type { EstadoDoNumero, WhatsAppProvider } from '@barbearia/core';
import { withTenant } from '@barbearia/db';
import { audit } from '@barbearia/identity';

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
 * ## Só a prova da Meta sobe para ativo
 *
 * `aguardando_verificacao` é o caminho normal e `suspenso` também pode voltar
 * quando a própria Meta volta a provar a posse. Isso é necessário porque um
 * `ACCOUNT_RECONNECTED` pode chegar depois de um offboarding; deixar a
 * conciliação aceitar apenas o primeiro estado tornaria a suspensão permanente.
 * Uma resposta não verificada nunca altera estado nem apaga o motivo.
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
             -- Sai junto: um numero de volta ao ar com "qualidade baixa" ainda
             -- escrito ao lado sao dois campos discordando sobre o mesmo fato,
             -- e o motivo so explica alguma coisa enquanto ele vale.
             status_reason = NULL,
             updated_at = now()
       WHERE location_id = ${params.locationId}::uuid
         AND status IN ('aguardando_verificacao', 'suspenso')
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
