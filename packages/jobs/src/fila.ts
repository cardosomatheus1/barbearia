import { semTenant, withTenant, type TransactionClient } from '@barbearia/db';
import {
  instantToLocal,
  SILENCIO_COMECA_MINUTO,
  SILENCIO_TERMINA_MINUTO,
} from '@barbearia/core';

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
  /** Token da claim atual; impede worker antigo de finalizar uma execução nova. */
  readonly claimToken: string;
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
     WHERE tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
       AND status = 'pending'
       AND idempotency_key = ANY(${[...params.chaves]}::text[])
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
        claim_token: string;
      }[]
    >`
      UPDATE jobs SET
        status = 'running',
        locked_at = ${agora},
        locked_by = ${quem},
        claim_token = gen_random_uuid(),
        attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM jobs
         WHERE status = 'pending' AND run_after <= ${agora}
           AND attempts < max_attempts
         ORDER BY run_after, id
         FOR UPDATE SKIP LOCKED
         LIMIT ${quantas}
      )
      RETURNING id, tenant_id, kind, payload, attempts, max_attempts, claim_token
    `;

    return linhas.map((linha) => ({
      id: linha.id,
      tenantId: linha.tenant_id,
      kind: linha.kind,
      payload: linha.payload,
      attempts: linha.attempts,
      maxAttempts: linha.max_attempts,
      claimToken: linha.claim_token,
    }));
  });
}

/**
 * Renova o lease da claim atual enquanto um handler legítimo continua vivo.
 *
 * Sem heartbeat, um handler que demora mais que a janela do reaper pode ser
 * devolvido para `pending` e executado por outro processo enquanto o primeiro
 * ainda conversa com um provedor externo. O `claim_token` impede o worker velho
 * de finalizar a linha nova, mas não desfaz efeitos que já saíram pela rede.
 */
export async function renovarTarefa(
  tarefa: Tarefa,
  agora: Date = new Date(),
): Promise<boolean> {
  return semTenant(async (tx) => {
    const renovadas = await tx.$executeRaw`
      UPDATE jobs SET locked_at = ${agora}
       WHERE id = ${tarefa.id}::uuid
         AND status = 'running'
         AND claim_token = ${tarefa.claimToken}::uuid
    `;
    return renovadas === 1;
  });
}

export async function concluirTarefa(tarefa: Tarefa): Promise<void> {
  await semTenant(async (tx) => {
    await tx.$executeRaw`
      UPDATE jobs SET status = 'done', finished_at = now(), locked_at = NULL, locked_by = NULL,
                      claim_token = NULL
       WHERE id = ${tarefa.id}::uuid AND status = 'running'
         AND claim_token = ${tarefa.claimToken}::uuid
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
  // O chamador do worker passa apenas tipo/código técnico sanitizado. A função
  // continua aceitando string para testes e chamadas administrativas explícitas.
  // Nunca monte este valor com payload ou mensagem bruta de provedor.
  const resumo = erro.slice(0, 500);

  await semTenant(async (tx) => {
    if (desiste) {
      await tx.$executeRaw`
        UPDATE jobs SET status = 'failed', last_error = ${resumo},
               finished_at = now(), locked_at = NULL, locked_by = NULL, claim_token = NULL
         WHERE id = ${tarefa.id}::uuid AND status = 'running'
           AND claim_token = ${tarefa.claimToken}::uuid
      `;
    } else {
      await tx.$executeRaw`
        UPDATE jobs SET status = 'pending', last_error = ${resumo},
               run_after = ${proxima}, locked_at = NULL, locked_by = NULL, claim_token = NULL
         WHERE id = ${tarefa.id}::uuid AND status = 'running'
           AND claim_token = ${tarefa.claimToken}::uuid
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
  return semTenant(async (tx) => {
    // Corrige também resíduos históricos que a implementação antiga podia
    // deixar `pending` já depois do teto. Eles não podem ficar invisíveis para
    // sempre nem ganhar uma tentativa extra.
    const esgotadas = await tx.$executeRaw`
      UPDATE jobs
         SET status = 'failed', last_error = COALESCE(last_error, 'max_attempts_exhausted'),
             finished_at = ${agora}, locked_at = NULL, locked_by = NULL, claim_token = NULL
       WHERE status = 'pending' AND attempts >= max_attempts
    `;

    // A tentativa é contada no claim. Se o processo morreu já no último degrau,
    // reabrir a linha faria o teto de `max_attempts` deixar de existir justamente
    // para a classe de falha mais dura: crash do processo.
    const falhadas = await tx.$executeRaw`
      UPDATE jobs
         SET status = 'failed', last_error = 'worker_orphaned', finished_at = ${agora},
             locked_at = NULL, locked_by = NULL, claim_token = NULL
       WHERE status = 'running' AND locked_at < ${corte}
         AND attempts >= max_attempts
    `;

    const reabertas = await tx.$executeRaw`
      UPDATE jobs
         SET status = 'pending', run_after = ${agora}, last_error = 'worker_orphaned',
             locked_at = NULL, locked_by = NULL, claim_token = NULL
       WHERE status = 'running' AND locked_at < ${corte}
         AND attempts < max_attempts
    `;

    return esgotadas + falhadas + reabertas;
  });
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

// ---------------------------------------------------------------------------
// A fila está andando?
// ---------------------------------------------------------------------------

/**
 * Quanto tempo sem concluir nada já é a fila **parada** (bloco 101).
 *
 * O worker roda a cada cinco segundos e a barbearia mais parada do mundo tem
 * varredura de hora em hora, então quinze minutos sem uma única conclusão com
 * tarefa vencida esperando não é lentidão — é processo fora do ar.
 *
 * Generoso de propósito: alarme que dispara à toa é alarme que se aprende a
 * ignorar, e um canal ignorado é pior que canal nenhum.
 */
export const SILENCIO_QUE_PREOCUPA_MS = 15 * 60_000;

export interface SaudeDaFila {
  /** Vencidas: `run_after` já passou e ninguém as executou. */
  readonly atrasadas: number;
  /** Esperando a hora — o lembrete de amanhã. Normal, e não é alarme. */
  readonly agendadas: number;
  /**
   * Tarefas que esgotaram as tentativas e desistiram.
   *
   * Contadas porque a primeira versão desta função **não as via**, e isso não
   * era detalhe: `failed` não é `pending`, então uma barbearia com a varredura
   * de automação morrendo em toda volta tinha `atrasadas = 0`, `ultima`
   * recente — porque os outros tipos de tarefa concluíam — e `parada = false`.
   * O aviso que existe para dizer "as mensagens não estão saindo" afirmava
   * saúde sobre um motor desligado havia quatro dias.
   *
   * Foi assim em produção: 84 `automacao.varrer` falhadas, nenhuma pendente, e
   * nenhuma tela do produto com uma palavra a respeito.
   */
  readonly falhadas: number;
  /** Quando a fila concluiu alguma coisa pela última vez. */
  readonly ultimaConclusao: string | null;
  /**
   * É a janela de silêncio **da unidade** agora (bloco 101).
   *
   * Entre 21h e 8h nada sai, de propósito. A tela mostrava o mesmo zero que
   * mostra quando o processo caiu — duas razões diferentes para o mesmo número,
   * e nenhuma escrita: quem lê não sabe se espera ou se avisa alguém.
   *
   * Respondido aqui e não na tela porque o fuso vem da **unidade**, nunca do
   * aparelho — é a regra do projeto, e a tela não tem o fuso à mão.
   */
  readonly emSilencio: boolean;
  /**
   * A fila parou de andar.
   *
   * Só quando há **tarefa vencida** e nada foi concluído há muito tempo: uma
   * barbearia que não tem nada a fazer tem a fila vazia e silenciosa, e isso é
   * o certo. Sem esta condição, o alarme apareceria em toda casa nova.
   */
  readonly parada: boolean;
  /**
   * Alguma coisa desistiu de tentar.
   *
   * Separado de `parada` porque são dois defeitos diferentes com duas respostas
   * diferentes: `parada` é o processo fora do ar e resolve-se subindo o worker;
   * `desistiu` é o worker de pé executando uma tarefa que sempre falha, e
   * resolve-se olhando o erro. Uma flag só mandaria quem opera reiniciar um
   * processo que está funcionando.
   */
  readonly desistiu: boolean;
}

/**
 * A fila está andando para esta barbearia?
 *
 * Existe porque **nenhuma tela do produto sabia responder isso**. A campanha
 * dizia "entrou na fila", a automação prometia "rodam de hora em hora" e a tela
 * de WhatsApp mostrava o canal de pé — com trinta e três mensagens paradas e o
 * processo que as manda fora do ar. Todas as quatro afirmavam o contrário do
 * que estava acontecendo, e o dono só descobriria pelo cliente que não voltou.
 *
 * `semTenant` porque `jobs` não tem RLS — é decisão do bloco 20, e o filtro por
 * barbearia é escrito aqui, explicitamente, como em todo acesso a esta tabela.
 */
export async function saudeDaFila(
  tenantId: string,
  agora: Date,
  timeZone: string,
): Promise<SaudeDaFila> {
  return semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<
      { atrasadas: bigint; agendadas: bigint; falhadas: bigint; ultima: Date | null }[]
    >`
      SELECT
        count(*) FILTER (WHERE status = 'pending' AND run_after <= ${agora}
           AND attempts < max_attempts) AS atrasadas,
        count(*) FILTER (WHERE status = 'pending' AND run_after > ${agora}) AS agendadas,
        -- Só as recentes: a tarefa que falhou no mês passado e nunca mais foi
        -- tentada é um fato encerrado, e contá-la deixaria o aviso aceso para
        -- sempre — que é como se ensina a ignorar um alarme.
        count(*) FILTER (
          WHERE status = 'failed'
            AND finished_at > ${agora}::timestamptz - interval '2 days'
        ) AS falhadas,
        max(finished_at) AS ultima
        FROM jobs
       WHERE tenant_id = ${tenantId}::uuid
    `;
    const l = linhas[0];
    const atrasadas = Number(l?.atrasadas ?? 0);
    const ultima = l?.ultima ?? null;
    const paradaHa = ultima === null ? Infinity : agora.getTime() - ultima.getTime();

    const minutoLocal = instantToLocal(timeZone, agora).minutes;
    const emSilencio =
      minutoLocal >= SILENCIO_COMECA_MINUTO || minutoLocal < SILENCIO_TERMINA_MINUTO;

    const falhadas = Number(l?.falhadas ?? 0);

    return {
      atrasadas,
      agendadas: Number(l?.agendadas ?? 0),
      falhadas,
      ultimaConclusao: ultima?.toISOString() ?? null,
      emSilencio,
      /**
       * Sem a janela de silêncio na conta, ao contrário de `parada`.
       *
       * Silêncio explica tarefa **esperando**; não explica tarefa que desistiu.
       * Uma falha às 22h continua sendo uma falha às 8h da manhã seguinte, e
       * escondê-la até lá é adiar a única notícia que importa.
       */
      desistiu: falhadas > 0,
      /**
       * Na janela de silêncio, tarefa parada é o **certo** — e o alarme diria o
       * contrário. Sem isto, toda barbearia acenderia o aviso às 21h01.
       */
      parada: !emSilencio && atrasadas > 0 && paradaHa > SILENCIO_QUE_PREOCUPA_MS,
    };
  });
}
