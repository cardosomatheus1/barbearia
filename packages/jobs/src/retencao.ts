import { semTenant } from '@barbearia/db';

/**
 * O agendamento da varredura de retenção (bloco 32).
 *
 * ## Por que uma tarefa por barbearia, e não uma varredura só
 *
 * `customers` tem RLS. Um processo sem tenant no contexto enxerga zero linhas —
 * há invariante desde o bloco 1 provando isso. Então "apague quem parou há
 * cinco anos" não é uma consulta global: é uma por barbearia, com `withTenant`,
 * exatamente como a apuração diária e a falta automática.
 *
 * ## Por que a lista de barbearias sai de `tenant_platform`
 *
 * É a única tabela do produto sem RLS que sabe quem existe — pelo mesmo motivo
 * pelo qual `agendarApuracaoDeTodas` a lê desde o bloco 25. Barbearia bloqueada
 * fica de fora: ela está fora do ar, ninguém a está usando, e anonimizar
 * cadastro de quem não pode nem entrar para ver o aviso prévio seria apagar
 * dado pelas costas de alguém sem chance de reagir.
 *
 * ## O que ela **não** faz
 *
 * Não decide nada. A regra dos cinco anos e dos trinta dias de aviso mora em
 * `packages/core`, e a leitura do banco em `packages/crm`. Aqui só se enfileira.
 */
export async function agendarRetencaoDeTodas(params: {
  readonly dia: string;
  readonly quando?: Date;
}): Promise<number> {
  return semTenant(async (tx) =>
    tx.$executeRaw`
      INSERT INTO jobs (tenant_id, kind, payload, run_after, idempotency_key, max_attempts)
      SELECT tp.tenant_id, 'lgpd.retencao', '{}'::jsonb,
             ${params.quando ?? new Date()},
             'retencao:' || tp.tenant_id::text || ':' || ${params.dia},
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
 * Pura, com o instante por parâmetro — a suíte precisa provar a virada do dia
 * sem esperar por ela.
 *
 * Às 5h UTC são 2h da manhã em Salvador e meia-noite em Rio Branco: a barbearia
 * está fechada em todo o Brasil. A hora importa porque a varredura **escreve**,
 * e escrever no meio do expediente disputa conexão com o balcão. Quatro horas
 * antes da apuração de métricas, que roda às 9h, pelo mesmo motivo de não
 * empilhar dois trabalhos pesados na mesma volta do laço.
 */
export const HORA_DA_RETENCAO_UTC = 5;

export function retencaoPendente(agora: Date): {
  readonly dia: string;
  readonly quando: Date;
} {
  const quando = new Date(
    Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate(), HORA_DA_RETENCAO_UTC),
  );
  return { dia: quando.toISOString().slice(0, 10), quando };
}
