import { semTenant } from '@barbearia/db';

/**
 * O agendamento da entrega da nota ao cliente (bloco 54).
 *
 * ## Por que uma tarefa por barbearia
 *
 * Mesma razão da varredura de retenção: `fiscal_invoices` tem RLS, e um
 * processo sem tenant no contexto enxerga zero linhas — sempre, e em silêncio.
 * "Quais notas ainda não chegaram ao cliente?" não é uma consulta global: é uma
 * por barbearia, com `withTenant`.
 *
 * ## Por que existe, se o `fiscal.emitir` já se reprograma
 *
 * Porque as duas perguntas são diferentes. `fiscal.emitir` acompanha **uma**
 * nota até ela ter desfecho, e morre junto com ela; a entrega é sobre o
 * conjunto, e precisa alcançar a nota cuja tarefa se perdeu — processo morto no
 * meio da volta, banco reiniciado, fila truncada numa manutenção. Sem ela, a
 * nota autorizada de uma tarefa perdida fica com o link no banco e nunca sai,
 * e ninguém descobre: não há erro, não há alerta, há uma mensagem que não
 * aconteceu.
 *
 * ## O que ela **não** faz
 *
 * Não decide nada. Se aquela nota vai sair agora, mais tarde ou nunca é
 * `decisaoDaEntregaDaNota`, em `packages/core`; a leitura do banco é de
 * `packages/finance`. Aqui só se enfileira.
 */
export async function agendarEntregaDeNotasDeTodas(params: {
  readonly hora: string;
  readonly quando?: Date;
}): Promise<number> {
  return semTenant(async (tx) =>
    tx.$executeRaw`
      INSERT INTO jobs (tenant_id, kind, payload, run_after, idempotency_key, max_attempts)
      SELECT tp.tenant_id, 'fiscal.entregar', '{}'::jsonb,
             ${params.quando ?? new Date()},
             'nota-entrega:' || tp.tenant_id::text || ':' || ${params.hora},
             3
      FROM tenant_platform tp
      WHERE tp.blocked_at IS NULL
      ON CONFLICT DO NOTHING
    `,
  );
}

/**
 * A conciliação das notas em voo.
 *
 * ## O estado que não tinha saída
 *
 * `notasEmCurso` — a única consulta que junta as notas paradas, escrita no
 * bloco 53 com o comentário *"as notas que ainda esperam resposta da
 * prefeitura"* — **não era chamada por ninguém**. E `fiscal.emitir` nasce com
 * cinco tentativas: esgotadas, a tarefa vira `failed` e nada mais olha aquela
 * nota. A comanda ficava com "Na fila. Ela sai sozinha em alguns minutos" para
 * sempre, sem botão — `vendaAceitaNota` é falso em estado em voo —, e a venda
 * não aceitava emissão nova. Saída: `UPDATE fiscal_invoices`.
 *
 * `cancelando` era pior: fora de `ESTADOS_NAO_TERMINAIS`, nem uma varredura
 * futura o alcançaria.
 *
 * É o caso que o repositório já nomeou em *"reprogramar uma tarefa **e** ter
 * varredura — escolha uma"*: ali a conclusão foi que o webhook não precisa de
 * varredura porque `next_attempt_at` já responde "quando tentar de novo". Aqui
 * não ficou nenhuma das duas para a tarefa morta, e a diferença é que a
 * resposta não vem de nós: vem da prefeitura, que pode demorar horas.
 *
 * ## Uma por barbearia, pela razão de sempre
 *
 * `fiscal_invoices` tem RLS: uma varredura sem tenant enxerga zero linhas,
 * sempre e em silêncio. Mesma forma de `agendarEntregaDeNotasDeTodas`.
 */
export async function agendarConciliacaoDeNotasDeTodas(params: {
  readonly hora: string;
  readonly quando?: Date;
}): Promise<number> {
  return semTenant(async (tx) =>
    tx.$executeRaw`
      INSERT INTO jobs (tenant_id, kind, payload, run_after, idempotency_key, max_attempts)
      SELECT tp.tenant_id, 'fiscal.conciliar', '{}'::jsonb,
             ${params.quando ?? new Date()},
             'nota-conciliar:' || tp.tenant_id::text || ':' || ${params.hora},
             3
      FROM tenant_platform tp
      WHERE tp.blocked_at IS NULL
      ON CONFLICT DO NOTHING
    `,
  );
}

/**
 * De hora em hora, e não uma vez por dia.
 *
 * A retenção varre de madrugada porque o que ela faz é irreversível e pesado. A
 * entrega é o contrário: é uma mensagem sobre uma venda que **acabou de
 * acontecer**, e um cliente que corta às 10h não pode receber a nota no dia
 * seguinte. A janela de silêncio é quem segura o que cai de madrugada, e ela é
 * decidida por nota, com o fuso da unidade — não pelo horário do laço, que é
 * UTC e valeria a mesma hora para Salvador e para Rio Branco.
 *
 * A chave carrega a hora: duas voltas do laço dentro do mesmo minuto não
 * enfileiram duas tarefas, e a hora seguinte enfileira a dela.
 */
export function entregaDeNotasPendente(agora: Date): {
  readonly hora: string;
  readonly quando: Date;
} {
  const hora = agora.toISOString().slice(0, 13);
  return { hora, quando: agora };
}

/**
 * A varredura de automação (bloco 56), agendada como a de entrega da nota.
 *
 * Uma tarefa por barbearia porque `customers` e `automation_sends` têm RLS: um
 * processo sem tenant no contexto enxerga zero linhas, sempre e em silêncio.
 *
 * De hora em hora e não uma vez por dia: os gatilhos são sobre fatos que
 * acabaram de acontecer — quem cortou hoje, quem fez aniversário hoje — e uma
 * volta diária faria "duas horas depois do corte" virar "amanhã de manhã". A
 * janela de silêncio é quem segura o que cai de madrugada, e ela é decidida por
 * disparo, com o fuso da unidade.
 */
export async function agendarAutomacaoDeTodas(params: {
  readonly hora: string;
  readonly quando?: Date;
}): Promise<number> {
  return semTenant(async (tx) =>
    tx.$executeRaw`
      INSERT INTO jobs (tenant_id, kind, payload, run_after, idempotency_key, max_attempts)
      SELECT tp.tenant_id, 'automacao.varrer', '{}'::jsonb,
             ${params.quando ?? new Date()},
             'automacao:' || tp.tenant_id::text || ':' || ${params.hora},
             3
      FROM tenant_platform tp
      WHERE tp.blocked_at IS NULL
      ON CONFLICT DO NOTHING
    `,
  );
}
