import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  ehHorarioDePico,
  horasDaGrade,
  horasDePico,
  montarGrade,
  type CelulaDeOcupacao,
  type CelulaNaTela,
} from '@barbearia/core';

/**
 * O heatmap de ocupação, do banco para a grade (bloco 57, SPEC §5.9).
 *
 * Uma consulta de agregação, não um laço: "quantos minutos foram vendidos na
 * terça às 14h" é `GROUP BY` sobre a agenda, e perguntar dia a dia seria o N+1
 * que a regra proíbe — aqui sobre 7 × 12 células.
 *
 * ## O fuso é o da unidade, e ele muda o resultado
 *
 * Um agendamento das 20h de sexta em Salvador é 23h UTC. Agrupar por hora UTC
 * poria a sexta cheia na madrugada de sábado, e o heatmap mostraria pico numa
 * hora em que a barbearia está fechada. `AT TIME ZONE` resolve no banco, com o
 * fuso lido da unidade — nunca do processo.
 */

/** Quantos dias para trás a grade olha. */
export const JANELA_DO_HEATMAP_DIAS = 56;

/**
 * Oito semanas, e o número tem motivo.
 *
 * Menos que isso e uma semana atípica — feriado, chuva, o barbeiro de férias —
 * move a grade inteira. Muito mais e a grade passa a descrever a barbearia do
 * semestre passado, que é justamente o que quem mudou de horário quer parar de
 * ver.
 */
export async function gradeDeOcupacao(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly agora: Date;
  readonly tx?: TransactionClient;
}): Promise<readonly CelulaNaTela[]> {
  const dentro = async (tx: TransactionClient) => {
    const celulas = await carregarCelulas(tx, params.locationId, params.agora);
    return montarGrade(celulas, horasDaGrade(celulas));
  };
  return params.tx ? dentro(params.tx) : withTenant(params.tenantId, dentro);
}

async function carregarCelulas(
  tx: TransactionClient,
  locationId: string,
  agora: Date,
): Promise<readonly CelulaDeOcupacao[]> {
  const linhas = await tx.$queryRaw<
    { dia: number; hora: number; vendidos: number; jornada: number }[]
  >`
    WITH fuso AS (
      SELECT timezone FROM locations WHERE id = ${locationId}::uuid
    ),
    atendidos AS (
      SELECT
        EXTRACT(DOW FROM a.starts_at AT TIME ZONE (SELECT timezone FROM fuso))::int AS dia,
        EXTRACT(HOUR FROM a.starts_at AT TIME ZONE (SELECT timezone FROM fuso))::int AS hora,
        sum(EXTRACT(EPOCH FROM (a.ends_at - a.starts_at)) / 60)::int AS vendidos
        FROM appointments a
       WHERE a.location_id = ${locationId}::uuid
         AND a.status IN ('completed', 'in_progress', 'checked_in', 'confirmed', 'pending')
         AND a.starts_at >= ${agora}::timestamptz - ${JANELA_DO_HEATMAP_DIAS} * interval '1 day'
         AND a.starts_at < ${agora}::timestamptz
       GROUP BY 1, 2
    ),
    /**
     * A capacidade é o número de cadeiras vezes os minutos da hora, vezes
     * quantas vezes aquele dia da semana passou na janela.
     *
     * Derivada e não cadastrada: uma coluna de capacidade seria um número que
     * alguém sobrescreve, e a pergunta que chega é "por que sexta parece cheia
     * se contratei mais um barbeiro?".
     */
    cadeiras AS (
      SELECT count(*)::int AS total FROM professionals
       WHERE location_id = ${locationId}::uuid AND active
    )
    SELECT g.dia, g.hora,
           COALESCE(at.vendidos, 0) AS vendidos,
           (SELECT total FROM cadeiras) * 60 * ${Math.floor(JANELA_DO_HEATMAP_DIAS / 7)} AS jornada
      FROM (
        SELECT DISTINCT dia, hora FROM atendidos
      ) g
      LEFT JOIN atendidos at ON at.dia = g.dia AND at.hora = g.hora
  `;

  return linhas.map((l) => ({
    diaDaSemana: l.dia,
    hora: l.hora,
    minutosVendidos: Number(l.vendidos),
    minutosDeJornada: Number(l.jornada),
  }));
}

/**
 * Esta hora é de pico?
 *
 * Chamada pelo caminho de reserva, e só quando pode mudar a resposta — o quarto
 * termo do sinal vale para cliente **novo**, e para os outros a grade seria uma
 * consulta jogada fora no caminho mais chamado do produto.
 */
export async function horaCheia(
  tx: TransactionClient,
  locationId: string,
  comecaEm: Date,
): Promise<boolean> {
  const celulas = await carregarCelulas(tx, locationId, new Date());
  const grade = montarGrade(celulas, horasDaGrade(celulas));

  const local = await tx.$queryRaw<{ dia: number; hora: number }[]>`
    SELECT EXTRACT(DOW FROM ${comecaEm}::timestamptz AT TIME ZONE l.timezone)::int AS dia,
           EXTRACT(HOUR FROM ${comecaEm}::timestamptz AT TIME ZONE l.timezone)::int AS hora
      FROM locations l WHERE l.id = ${locationId}::uuid
  `;
  const quando = local[0];
  if (!quando) return false;

  return ehHorarioDePico({
    picos: horasDePico(grade),
    diaDaSemanaLocal: Number(quando.dia),
    horaLocal: Number(quando.hora),
  });
}
