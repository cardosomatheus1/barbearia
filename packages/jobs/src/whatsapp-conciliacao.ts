import { semTenant } from '@barbearia/db';

/**
 * A varredura que pergunta à Meta o que ela ainda não respondeu (bloco 90).
 *
 * ## Duas coisas ficavam esperando resposta que nunca era pedida
 *
 * **O número.** `whatsapp_settings.status` nascia em `aguardando_verificacao` e
 * a única escrita depois era `suspenso`. O comentário de
 * `salvarCadastroDoWhatsApp` prometia que "quem promove a `ativo` é a Meta
 * respondendo, pela conciliação" — e a conciliação não existia. O canal
 * funcionava (o envio nunca olhou status), mas o checklist da tela lê
 * `estado === 'ativo'` e ficava para sempre em "Passo 1: conectar o número",
 * com o número conectado.
 *
 * **Os templates.** `templatesEmCurso` estava escrita, exportada e chamada só
 * por teste. Um texto submetido ficava "Na Meta" para sempre na tela, mesmo
 * depois de aprovado — e é justamente o estado que a barbearia abre a tela para
 * conferir. É a regra da varredura prometida num comentário: ou tem chamador e
 * teste, ou é comentário.
 *
 * ## Por que uma tarefa só para as duas
 *
 * São a mesma pergunta — *"Meta, e aquilo que eu te mandei?"* — feita com o
 * mesmo token, na mesma volta do relógio, para a mesma barbearia. Separá-las
 * criaria duas cadeias de agendamento para não fazer nada novo, que é a decisão
 * já escrita em `automacao.varrer`.
 *
 * ## Por que por barbearia, e não uma consulta global
 *
 * A RLS é fixada por transação e o token é de cada unidade: atravessar
 * barbearias numa consulta só é exatamente o que a política impede. É o mesmo
 * desenho do motor rodado em lote — uma transação por barbearia, e o que se
 * limita é a largura.
 */
export async function agendarConciliacaoDoWhatsApp(params: {
  readonly hora: string;
  readonly quando?: Date;
}): Promise<number> {
  return semTenant(async (tx) =>
    tx.$executeRaw`
      INSERT INTO jobs (tenant_id, kind, payload, run_after, idempotency_key, max_attempts)
      SELECT tp.tenant_id, 'whatsapp.conciliar', '{}'::jsonb,
             ${params.quando ?? new Date()},
             'whatsapp-conciliar:' || tp.tenant_id::text || ':' || ${params.hora},
             3
      FROM tenant_platform tp
      WHERE tp.blocked_at IS NULL
      ON CONFLICT DO NOTHING
    `,
  );
}
