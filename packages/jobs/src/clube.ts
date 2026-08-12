import { semTenant } from '@barbearia/db';

/**
 * O agendamento da régua de cobrança do clube (bloco 47).
 *
 * ## Por que uma tarefa por barbearia, e não uma régua global
 *
 * A régua da **plataforma** roda sem tenant, porque `invoices` foi desenhada
 * assim: ela é da plataforma, e uma barbearia que escrevesse ali se daria baixa
 * sozinha. `club_invoices` é o oposto — tem RLS `FORCE`, e um processo sem
 * tenant no contexto enxerga zero linhas. Então "quem venceu hoje?" não é uma
 * consulta: é uma por barbearia, com `withTenant`, como a varredura de retenção
 * e a apuração diária.
 *
 * ## Por que a lista sai de `tenant_platform`
 *
 * É a única tabela sem RLS que sabe quem existe. Barbearia bloqueada fica de
 * fora: ela está fora do ar, e suspender o clube de assinantes que ninguém pode
 * nem atender seria punir o cliente por uma dívida que não é dele.
 */
export async function agendarCobrancaDoClubeDeTodas(params: {
  readonly dia: string;
  readonly quando?: Date;
}): Promise<number> {
  return semTenant(async (tx) =>
    tx.$executeRaw`
      INSERT INTO jobs (tenant_id, kind, payload, run_after, idempotency_key, max_attempts)
      SELECT tp.tenant_id, 'clube.cobranca', '{}'::jsonb,
             ${params.quando ?? new Date()},
             'clube:' || tp.tenant_id::text || ':' || ${params.dia},
             3
      FROM tenant_platform tp
      WHERE tp.blocked_at IS NULL
      ON CONFLICT DO NOTHING
    `,
  );
}

/**
 * Que dia cobrar, e a partir de quando.
 *
 * Às 6h UTC são 3h da manhã em Salvador e meia-noite em Rio Branco: a barbearia
 * está fechada em todo o Brasil. Uma hora depois da retenção e três antes da
 * apuração, pelo mesmo motivo de não empilhar dois trabalhos pesados na mesma
 * volta do laço — e esta é a única das três que fala com o adquirente, o que a
 * torna a mais lenta e a mais sujeita a espera de rede.
 */
export const HORA_DA_COBRANCA_DO_CLUBE_UTC = 6;

export function cobrancaDoClubePendente(agora: Date): {
  readonly dia: string;
  readonly quando: Date;
} {
  const quando = new Date(
    Date.UTC(
      agora.getUTCFullYear(),
      agora.getUTCMonth(),
      agora.getUTCDate(),
      HORA_DA_COBRANCA_DO_CLUBE_UTC,
    ),
  );
  return { dia: quando.toISOString().slice(0, 10), quando };
}
