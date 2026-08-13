import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  cicloDoCliente,
  corteDeVip,
  medianaDaBase,
  segmentoDoCliente,
  type CicloDoCliente,
  type Segmento,
} from '@barbearia/core';

/**
 * O segmento de cada cliente, do banco para a tela (bloco 61, SPEC §4.4).
 *
 * ## Uma consulta para a base inteira, sempre
 *
 * O segmento de **um** cliente depende da base: "frequente" é ciclo abaixo da
 * mediana dela, "VIP" é o topo do decil de gasto. Não existe versão barata que
 * responda por uma pessoa — para saber se ele está acima da mediana é preciso
 * ter a mediana.
 *
 * Por isso a carga é uma só, e quem quer um cliente pede o mapa e procura nele.
 * A alternativa — duas consultas por ficha aberta, uma para a pessoa e outra
 * para as estatísticas — é o N+1 disfarçado de cuidado.
 *
 * ## O que entra como visita
 *
 * Só `completed`. Falta e cancelamento **não** são visita: incluí-los daria um
 * ciclo curto a quem marca e não aparece, e a pessoa que mais falta seria a que
 * o produto classificaria como mais frequente. Este é o mesmo desfecho que o
 * score de confiabilidade já separa desde o bloco 39.
 */

export interface ClienteSegmentado {
  readonly customerId: string;
  readonly segmento: Segmento;
  readonly ciclo: CicloDoCliente | null;
  readonly ultimaVisita: Date | null;
  readonly gastoTotalCents: number;
  /** Quantos dias desde a última visita. Nulo para quem nunca veio. */
  readonly diasSemVir: number | null;
}

interface LinhaDoCliente {
  customer_id: string;
  visitas: Date[] | null;
  gasto: number | null;
  assina: boolean;
}

/**
 * Todos os clientes da barbearia com o segmento resolvido.
 *
 * O `agora` entra por parâmetro porque ele decide tudo aqui — quem está em risco
 * é uma função do relógio, e ler `now()` no banco tornaria o resultado
 * impossível de testar sem esperar o tempo passar.
 */
export async function segmentosDaBase(
  tenantId: string,
  agora: Date = new Date(),
  tx?: TransactionClient,
): Promise<readonly ClienteSegmentado[]> {
  const dentro = async (t: TransactionClient) => {
    /**
     * Uma consulta, com as visitas agregadas por cliente.
     *
     * O `array_agg` traz as datas de todos os atendimentos concluídos; o ciclo
     * é calculado em `packages/core`, onde a mediana pode ser lida e discutida.
     * Calculá-lo em SQL — `percentile_cont` sobre `lag()` — seria regra de
     * negócio na consulta, onde o teste não alcança.
     */
    const linhas = await t.$queryRaw<LinhaDoCliente[]>`
      SELECT c.id AS customer_id,
             (SELECT array_agg(a.service_starts_at ORDER BY a.service_starts_at)
                FROM appointments a
               WHERE a.customer_id = c.id AND a.status = 'completed') AS visitas,
             (SELECT sum(o.total_cents)::int
                FROM orders o
               WHERE o.customer_id = c.id AND o.status = 'paid') AS gasto,
             EXISTS (
               SELECT 1 FROM club_subscriptions s
                WHERE s.customer_id = c.id AND s.status IN ('ativa', 'inadimplente')
             ) AS assina
        FROM customers c
       WHERE c.anonymized_at IS NULL
    `;

    const parciais = linhas.map((l) => {
      const visitas = l.visitas ?? [];
      return {
        customerId: l.customer_id,
        ciclo: cicloDoCliente(visitas),
        /**
         * A mais recente, não a última do vetor.
         *
         * O `ORDER BY` do `array_agg` já as entrega em ordem, e continua ali
         * porque saída determinística é boa por si. Mas depender dele aqui faria
         * a data da última visita mudar em silêncio no dia em que alguém
         * reescrevesse a consulta — é a mesma razão de `cicloDoCliente` ordenar
         * o que recebe em vez de exigir ordenado.
         */
        ultimaVisita: visitas.reduce<Date | null>(
          (maior, v) => (maior === null || v.getTime() > maior.getTime() ? v : maior),
          null,
        ),
        gastoTotalCents: Number(l.gasto ?? 0),
        assinanteAtivo: l.assina,
      };
    });

    /**
     * As duas estatísticas da base saem **de quem tem o dado**, não de todo
     * mundo.
     *
     * A mediana de ciclo entre clientes sem ciclo seria a mediana de nada; e o
     * decil de gasto contando quem nunca comprou puxaria o corte para baixo e
     * faria "VIP" incluir gente comum. Quem não tem o dado não entra na conta e
     * também não é comparado.
     */
    const medianaBase = medianaDaBase(
      parciais.filter((p) => p.ciclo !== null).map((p) => p.ciclo?.medianaDias ?? 0),
    );
    const corteVip = corteDeVip(
      parciais.filter((p) => p.gastoTotalCents > 0).map((p) => p.gastoTotalCents),
    );

    return parciais.map((p) => ({
      customerId: p.customerId,
      segmento: segmentoDoCliente({
        ciclo: p.ciclo,
        ultimaVisita: p.ultimaVisita,
        agora,
        assinanteAtivo: p.assinanteAtivo,
        gastoTotalCents: p.gastoTotalCents,
        medianaDaBaseDias: medianaBase,
        corteDeVipCents: corteVip,
      }),
      ciclo: p.ciclo,
      ultimaVisita: p.ultimaVisita,
      gastoTotalCents: p.gastoTotalCents,
      diasSemVir:
        p.ultimaVisita === null
          ? null
          : Math.floor((agora.getTime() - p.ultimaVisita.getTime()) / 86_400_000),
    }));
  };

  return tx ? dentro(tx) : withTenant(tenantId, dentro);
}

/** O segmento de uma pessoa. Ver o cabeçalho: ele depende da base inteira. */
export async function segmentoDe(
  tenantId: string,
  customerId: string,
  agora: Date = new Date(),
): Promise<ClienteSegmentado | null> {
  const todos = await segmentosDaBase(tenantId, agora);
  return todos.find((c) => c.customerId === customerId) ?? null;
}

/** Quantos clientes em cada segmento, para a tela do dono. */
export function contarPorSegmento(
  clientes: readonly ClienteSegmentado[],
): Readonly<Record<Segmento, number>> {
  const contagem = {
    novo: 0,
    ativo: 0,
    frequente: 0,
    vip: 0,
    em_risco: 0,
    perdido: 0,
    assinante: 0,
  };
  for (const cliente of clientes) contagem[cliente.segmento] += 1;
  return contagem;
}
