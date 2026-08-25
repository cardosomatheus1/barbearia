import { avaliar, type Alerta } from '@barbearia/core';
import { semTenant, withTenant } from '@barbearia/db';

/**
 * A origem dos números que as regras de alerta avaliam.
 *
 * `packages/core/src/alertas.ts` decide **quando** alertar; este arquivo é de
 * onde vêm os números. Os dois separados porque a decisão é testável sem banco
 * e a coleta não é — mas eles entram no mesmo bloco de propósito: regra de
 * alerta sem coletor é motor que aceita um campo que ninguém preenche, e o
 * projeto já teve um (`blocks`, oito blocos aceito e sempre vazio).
 *
 * É por isso que só duas das quatro regras foram entregues. As outras duas —
 * conversão da página e proporção de erro na gravação — precisam de contagem de
 * visita e de leitura de log agregado, que o produto não tem. Estão na tabela
 * de lacunas do ROADMAP com o bloco em que a origem chega.
 */

/**
 * Quantos agendamentos a barbearia recebeu num dia.
 *
 * Conta pela **criação**, não pelo dia atendido: o sinal procurado é "pararam
 * de marcar", e quem mede o dia atendido só descobre isso quando o dia chega —
 * uma semana tarde, com a agenda já vazia.
 *
 * Cancelado continua contando. Uma queda de *cancelamento* não é queda de
 * demanda, e excluí-los faria uma onda de cancelamento parecer queda de
 * procura, mandando olhar a página pública quando o problema é outro.
 */
async function marcadosNoDia(tenantId: string, agora: Date, atras: number): Promise<number> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ total: bigint }[]>`
      SELECT count(*) AS total
        FROM appointments a
        JOIN locations l ON l.id = a.location_id
       WHERE (a.created_at AT TIME ZONE l.timezone)::date
             = ((${agora}::timestamptz AT TIME ZONE l.timezone)::date - ${atras}::int)
    `;
    return Number(linhas[0]?.total ?? 0);
  });
}

/**
 * O estado da fila de trabalho.
 *
 * Sem tenant de propósito: `jobs` não tem RLS — é infraestrutura, e a pergunta
 * "o worker está vivo?" não é de nenhuma barbearia em particular. É também por
 * isso que nada aqui lê `payload`, que guarda id e nunca conteúdo.
 */
async function estadoDaFila(agora: Date): Promise<{
  readonly pendentes: number;
  readonly idadeDaMaisAntigaMinutos: number;
}> {
  return semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<{ pendentes: bigint; mais_antiga: Date | null }[]>`
      SELECT count(*) AS pendentes, min(run_after) AS mais_antiga
      FROM jobs
      -- run_after <= agora é o que separa fila parada de fila agendada: o
      -- lembrete de amanhã está pendente e não está atrasado, e contá-lo faria
      -- toda barbearia com aviso ligado parecer travada.
      WHERE status = 'pending' AND run_after <= ${agora}
    `;

    const linha = linhas[0];
    const pendentes = Number(linha?.pendentes ?? 0);
    const maisAntiga = linha?.mais_antiga ?? null;

    return {
      pendentes,
      idadeDaMaisAntigaMinutos: maisAntiga
        ? Math.floor((agora.getTime() - maisAntiga.getTime()) / 60_000)
        : 0,
    };
  });
}


/**
 * Coleta e avalia os alertas de uma barbearia.
 *
 * O relógio entra por parâmetro: sem isso o teste dependeria da hora em que
 * roda, e um alerta que só falha às onze da noite é pior do que nenhum
 * (CLAUDE.md §1).
 */
export async function alertasDaBarbearia(tenantId: string, agora: Date): Promise<readonly Alerta[]> {
  const [hoje, semanaPassada, fila] = await Promise.all([
    marcadosNoDia(tenantId, agora, 0),
    marcadosNoDia(tenantId, agora, 7),
    estadoDaFila(agora),
  ]);

  return avaliar({
    volume: { hoje, mesmoDiaSemanaPassada: semanaPassada },
    fila,
  });
}
