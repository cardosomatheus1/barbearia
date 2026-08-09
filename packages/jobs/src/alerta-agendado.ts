import { semTenant } from '@barbearia/db';

/**
 * O agendamento da varredura de alerta (bloco 33).
 *
 * Mesma forma da retenção e da apuração, e pelo mesmo motivo: `appointments`
 * tem RLS, então "quem teve queda de volume?" não é uma consulta global — é uma
 * por barbearia, com `withTenant`.
 *
 * Barbearia bloqueada fica de fora. Ela está fora do ar: alertar que o volume
 * de agendamento caiu numa conta suspensa é informar o óbvio pelo canal que
 * deveria ser reservado ao que exige ação.
 */
export async function agendarAlertasDeTodas(params: {
  readonly dia: string;
  readonly quando?: Date;
}): Promise<number> {
  return semTenant(async (tx) =>
    tx.$executeRaw`
      INSERT INTO jobs (tenant_id, kind, payload, run_after, idempotency_key, max_attempts)
      SELECT tp.tenant_id, 'alerta.varredura', '{}'::jsonb,
             ${params.quando ?? new Date()},
             'alerta:' || tp.tenant_id::text || ':' || ${params.dia},
             3
      FROM tenant_platform tp
      WHERE tp.blocked_at IS NULL
      ON CONFLICT DO NOTHING
    `,
  );
}

/**
 * Que dia varrer, e a partir de quando.
 *
 * 11h UTC são 8h em Salvador e 6h em Rio Branco — a barbearia mais a oeste
 * acabou de entrar na janela em que o aviso pode sair, e a mais a leste está
 * abrindo. É o primeiro instante do dia em que um alerta chega útil em todo o
 * país sem acordar ninguém.
 *
 * Depois da apuração das métricas (9h), de propósito: o alerta compara hoje com
 * o mesmo dia da semana passada, e o número da semana passada precisa já estar
 * apurado.
 */
export const HORA_DO_ALERTA_UTC = 11;

export function alertaPendente(agora: Date): { readonly dia: string; readonly quando: Date } {
  const quando = new Date(
    Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate(), HORA_DO_ALERTA_UTC),
  );
  return { dia: quando.toISOString().slice(0, 10), quando };
}
