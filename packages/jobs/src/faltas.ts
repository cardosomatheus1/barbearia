import { withTenant, type TransactionClient } from '@barbearia/db';
import { enfileirar } from './fila.js';

/**
 * A falta automática — lacuna aberta no bloco 11.
 *
 * `no_show_after_minutes` existia na unidade desde lá, e o painel do dia já
 * mostrava o relógio da tolerância correndo. Quem virava o status era uma
 * pessoa: nada fazia isso sozinho, e o horário seguia ocupado por quem não veio.
 *
 * **Uma tarefa por agendamento, não uma varredura.** A primeira versão era uma
 * varredura de plataforma, sem tenant, atravessando barbearias — e ela não podia
 * funcionar: `appointments` tem RLS, e sem tenant no contexto a consulta devolve
 * zero linhas. O teste pegou.
 *
 * A tarefa por agendamento é melhor por três motivos, e a impossibilidade só
 * apressou a descoberta: dispara no instante exato em que a tolerância vence,
 * não gasta nada quando não há ninguém atrasado, e passa pela RLS como qualquer
 * outra escrita.
 */

export function chaveDaFalta(appointmentId: string): string {
  return `falta:${appointmentId}`;
}

/**
 * Enfileira a falta junto com o agendamento, na mesma transação.
 *
 * `rodarApos` é o fim da tolerância. Não é a decisão: a unidade pode aumentar o
 * prazo depois, e por isso `marcarFalta` reconfere. O `run_after` só decide
 * **quando olhar**.
 *
 * Tolerância zero significa desligado — barbearia que prefere resolver falta na
 * mão. Enfileirar uma tarefa que sempre devolve `false` seria gastar fila para
 * não fazer nada.
 */
export async function agendarFalta(
  tx: TransactionClient,
  params: {
    readonly appointmentId: string;
    readonly comecaEm: Date;
    readonly toleranciaMinutos: number;
  },
): Promise<boolean> {
  if (params.toleranciaMinutos <= 0) return false;

  await enfileirar(tx, {
    kind: 'agendamento.marcar_falta',
    payload: { appointmentId: params.appointmentId },
    rodarApos: new Date(params.comecaEm.getTime() + params.toleranciaMinutos * 60_000),
    idempotencyKey: chaveDaFalta(params.appointmentId),
  });

  return true;
}

/**
 * Marca como falta quem passou da tolerância.
 *
 * O `WHERE` de status é o que protege: só `pending` e `confirmed`. Quem fez
 * check-in está na barbearia e quem está em atendimento evidentemente veio —
 * marcar falta de quem chegou é pior do que não marcar nada, porque ele vê a
 * punição do próprio comparecimento.
 *
 * A conta sai de `service_starts_at`, e não de `starts_at`. Os dois diferem
 * quando o serviço tem preparo antes: `starts_at` é quando a cadeira fica
 * ocupada, `service_starts_at` é a hora que o cliente combinou. Contar atraso a
 * partir da ocupação puniria o cliente pelo tempo de preparo — e, pior, faria o
 * status virar num instante diferente do que o painel do dia mostra, que conta
 * daqui desde o bloco 11.
 *
 * O instante entra por parâmetro, e não como `now()` do banco, pela mesma razão
 * que vale no resto do código: relógio de parede dentro da regra é regra que só
 * se testa esperando. Aqui o preço seria concreto — provar que quem fez check-in
 * não vira falta exigiria um agendamento no passado real do processo.
 */
export async function marcarFalta(
  tenantId: string,
  appointmentId: string,
  agora: Date,
): Promise<boolean> {
  return withTenant(tenantId, async (tx) => {
    const afetados = await tx.$executeRaw`
      UPDATE appointments a SET status = 'no_show', updated_at = now()
        FROM locations l
       WHERE a.id = ${appointmentId}::uuid
         AND l.id = a.location_id
         AND a.status IN ('pending', 'confirmed')
         AND l.no_show_after_minutes > 0
         AND a.service_starts_at + (l.no_show_after_minutes * interval '1 minute') <= ${agora}
    `;
    return afetados > 0;
  });
}
