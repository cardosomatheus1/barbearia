import { semTenant, withTenant, type TransactionClient } from '@barbearia/db';

/**
 * A fila de trabalho.
 *
 * O que ela resolve: o lembrete de 24 horas não cabe no modelo de requisição —
 * ninguém está esperando resposta às 9h da manhã de ontem. A partir daqui o
 * produto tem coisas que acontecem sem alguém do outro lado.
 *
 * **A tomada usa `FOR UPDATE SKIP LOCKED`.** É o que permite dois processos
 * consumirem a mesma fila sem um esperar o outro e sem os dois pegarem a mesma
 * tarefa. Sem `SKIP LOCKED`, o segundo worker ficaria bloqueado atrás do
 * primeiro e a fila viraria sequencial — com o custo de dois processos e a
 * vazão de um.
 *
 * **Falha não some.** Tentativa tem teto e espera crescente; esgotado o teto, a
 * tarefa vira `failed` e fica visível. Mensagem que ninguém enviou e ninguém
 * soube é a pior das duas falhas possíveis: a barbearia acha que avisou.
 */

export interface Tarefa {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
  readonly maxAttempts: number;
}

/**
 * Espera antes da próxima tentativa: 1, 2, 4, 8… minutos, com teto de uma hora.
 *
 * Crescente porque a causa mais comum de falha é o provedor fora do ar, e
 * repetir de segundo em segundo contra um serviço caído só gasta cota e atrasa
 * as outras tarefas. O teto existe para que uma indisponibilidade longa não
 * empurre a tarefa para daqui a dois dias.
 */
export function esperaDaTentativa(tentativa: number): number {
  const minutos = Math.min(2 ** Math.max(0, tentativa - 1), 60);
  return minutos * 60_000;
}

/**
 * Enfileira dentro de uma transação já aberta.
 *
 * Recebe `tx` de propósito: o trabalho nasce **junto** com o fato que o
 * origina. Se o agendamento entra, o lembrete entra; se a transação volta
 * atrás, o lembrete some junto. Enfileirar depois, fora da transação, cria a
 * janela em que o corte existe e o lembrete não.
 *
 * `ON CONFLICT DO NOTHING` na chave: reentrega do mesmo evento não vira segunda
 * mensagem, e quem garante é o índice único — não uma consulta antes de
 * inserir, que tem janela de corrida entre o `SELECT` e o `INSERT`.
 */
export async function enfileirar(
  tx: TransactionClient,
  tarefa: {
    readonly kind: string;
    readonly payload?: Record<string, unknown>;
    readonly rodarApos?: Date;
    readonly idempotencyKey?: string;
    readonly maxAttempts?: number;
  },
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO jobs (tenant_id, kind, payload, run_after, idempotency_key, max_attempts)
    VALUES (
      NULLIF(current_setting('app.tenant_id', true), '')::uuid,
      ${tarefa.kind},
      ${JSON.stringify(tarefa.payload ?? {})}::jsonb,
      ${tarefa.rodarApos ?? new Date()},
      ${tarefa.idempotencyKey ?? null},
      ${tarefa.maxAttempts ?? 5}
    )
    ON CONFLICT DO NOTHING
  `;
}

/**
 * Cancela o que ainda não saiu.
 *
 * Cliente que desmarcou não pode receber "não esqueça do seu horário". A tarefa
 * é **apagada** e não marcada como cancelada porque ela ainda não aconteceu —
 * o que precisa de trilha é o envio, e isso vive em `notifications`.
 *
 * Só `pending`: uma tarefa em execução já está a caminho, e o handler confere o
 * estado do agendamento antes de mandar. Duas defesas, porque cancelamento e
 * envio podem se cruzar no mesmo segundo.
 */
export async function cancelarTarefas(
  tx: TransactionClient,
  params: { readonly chaves: readonly string[] },
): Promise<number> {
  if (params.chaves.length === 0) return 0;
  return tx.$executeRaw`
    DELETE FROM jobs
     WHERE status = 'pending' AND idempotency_key = ANY(${[...params.chaves]}::text[])
  `;
}

/**
 * Toma até `quantas` tarefas prontas e as marca como em execução.
 *
 * Roda **sem tenant**: a fila é infraestrutura e o worker precisa ver a
 * próxima tarefa antes de saber de quem ela é. O que protege o dado de negócio
 * é a RLS das tabelas que o handler toca — ele abre `withTenant` com o tenant
 * da própria tarefa.
 */
export async function tomarTarefas(
  quantas: number,
  quem: string,
  agora: Date = new Date(),
): Promise<readonly Tarefa[]> {
  return semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        tenant_id: string;
        kind: string;
        payload: Record<string, unknown>;
        attempts: number;
        max_attempts: number;
      }[]
    >`
      UPDATE jobs SET
        status = 'running',
        locked_at = ${agora},
        locked_by = ${quem},
        attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM jobs
         WHERE status = 'pending' AND run_after <= ${agora}
         ORDER BY run_after, id
         FOR UPDATE SKIP LOCKED
         LIMIT ${quantas}
      )
      RETURNING id, tenant_id, kind, payload, attempts, max_attempts
    `;

    return linhas.map((linha) => ({
      id: linha.id,
      tenantId: linha.tenant_id,
      kind: linha.kind,
      payload: linha.payload,
      attempts: linha.attempts,
      maxAttempts: linha.max_attempts,
    }));
  });
}

export async function concluirTarefa(id: string): Promise<void> {
  await semTenant(async (tx) => {
    await tx.$executeRaw`
      UPDATE jobs SET status = 'done', finished_at = now(), locked_at = NULL, locked_by = NULL
       WHERE id = ${id}::uuid
    `;
  });
}

/**
 * Devolve a tarefa à fila, ou a aposenta.
 *
 * Esgotado o teto, ela vira `failed` — visível, com o último erro guardado.
 * Sumir em silêncio faria a barbearia acreditar que avisou o cliente.
 */
export async function falharTarefa(
  tarefa: Tarefa,
  erro: string,
  agora: Date = new Date(),
): Promise<'retry' | 'failed'> {
  const desiste = tarefa.attempts >= tarefa.maxAttempts;
  const proxima = new Date(agora.getTime() + esperaDaTentativa(tarefa.attempts));
  // O detalhe do erro fica no banco para quem investiga; o cliente nunca o vê.
  const resumo = erro.slice(0, 500);

  await semTenant(async (tx) => {
    if (desiste) {
      await tx.$executeRaw`
        UPDATE jobs SET status = 'failed', last_error = ${resumo},
               finished_at = now(), locked_at = NULL, locked_by = NULL
         WHERE id = ${tarefa.id}::uuid
      `;
    } else {
      await tx.$executeRaw`
        UPDATE jobs SET status = 'pending', last_error = ${resumo},
               run_after = ${proxima}, locked_at = NULL, locked_by = NULL
         WHERE id = ${tarefa.id}::uuid
      `;
    }
  });

  return desiste ? 'failed' : 'retry';
}

/**
 * Devolve à fila o que ficou preso em `running`.
 *
 * Worker morto no meio de uma tarefa a deixa travada para sempre — e "para
 * sempre" aqui significa um cliente que nunca é avisado. A varredura é a única
 * defesa contra o processo que não teve chance de se despedir.
 *
 * A tentativa já foi contada na tomada, então soltar aqui não zera o teto: um
 * handler que derruba o processo toda vez esgota as tentativas e vira `failed`,
 * em vez de reiniciar o worker eternamente.
 */
export async function soltarOrfas(
  limiteMinutos = 15,
  agora: Date = new Date(),
): Promise<number> {
  const corte = new Date(agora.getTime() - limiteMinutos * 60_000);
  return semTenant(async (tx) =>
    tx.$executeRaw`
      UPDATE jobs SET status = 'pending', locked_at = NULL, locked_by = NULL
       WHERE status = 'running' AND locked_at < ${corte}
    `,
  );
}

/**
 * Enfileira com o dono dito na chamada, dentro de uma transação já aberta.
 *
 * `enfileirar` tira o tenant de `current_setting`, o que é o certo para quem
 * roda dentro de `withTenant` — a tarefa herda o dono do fato que a originou e
 * não há como enfileirar para a barbearia errada.
 *
 * A régua de cobrança não tem esse contexto: ela roda sem tenant, porque a
 * pergunta "quem venceu hoje?" atravessa todas as barbearias. Sem esta porta,
 * ela escreveria em `jobs` na mão — e a fila voltaria a ser conhecimento
 * espalhado, que é justamente o que este arquivo evita.
 */
export async function enfileirarPara(
  tx: TransactionClient,
  tenantId: string,
  tarefa: Parameters<typeof enfileirar>[1],
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO jobs (tenant_id, kind, payload, run_after, idempotency_key, max_attempts)
    VALUES (
      ${tenantId}::uuid,
      ${tarefa.kind},
      ${JSON.stringify(tarefa.payload ?? {})}::jsonb,
      ${tarefa.rodarApos ?? new Date()},
      ${tarefa.idempotencyKey ?? null},
      ${tarefa.maxAttempts ?? 5}
    )
    ON CONFLICT DO NOTHING
  `;
}

/** Enfileira fora de uma transação de domínio, abrindo a sua própria. */
export async function enfileirarAvulso(
  tenantId: string,
  tarefa: Parameters<typeof enfileirar>[1],
): Promise<void> {
  await withTenant(tenantId, (tx) => enfileirar(tx, tarefa));
}
