import { withTenant } from '@barbearia/db';
import type { ChaveDeMetrica, DimensaoDaMetrica } from '@barbearia/core';

import { inteiroSeguroDoBanco } from './inteiro-seguro.js';

/**
 * O executor do schema semântico (bloco 63, SPEC §4.15).
 *
 * O catálogo mora em `packages/core` e não sabe o que é um banco. Este arquivo é
 * a outra metade: para cada entrada do catálogo, a consulta que a responde.
 *
 * ## O tenant é aplicado aqui, e não no pedido
 *
 * > *"com escopo de tenant aplicado na camada de dados — jamais confiando no
 * > prompt para isolar tenant."*
 *
 * É a frase da SPEC, e ela descreve o que este produto já faz em toda parte:
 * `withTenant` abre a transação com o tenant no contexto, e a RLS filtra. O que
 * o bloco 63 acrescenta é que **nenhum texto vindo de fora chega perto do SQL** —
 * a métrica é uma chave de um `switch`, e a dimensão é outra. Não há concatenação
 * em lugar nenhum deste arquivo, e não pode passar a haver.
 *
 * ## Uma consulta por métrica, e nenhuma delas inventa número
 *
 * Onde já existe a definição — a comissão, a margem, o ciclo do cliente — este
 * arquivo **não** a reescreve. Faturamento e ticket saem de `orders` pelo mesmo
 * recorte de `business_day` do bloco 19; margem e churn não estão aqui porque
 * quem os define é `dre.ts` e `packages/crm`, e duas fontes de verdade para o
 * mesmo número é o que a SPEC §3.5 proíbe em letras.
 */

export interface FatiaDaMetrica {
  /** Nula quando a dimensão é `nenhuma`: é o total, e ele não tem rótulo. */
  readonly rotulo: string | null;
  readonly valor: number | null;
}

export interface RespostaDaMetrica {
  readonly total: number | null;
  readonly fatias: readonly FatiaDaMetrica[];
}

export async function medir(params: {
  readonly tenantId: string;
  readonly metrica: ChaveDeMetrica;
  readonly dimensao: DimensaoDaMetrica;
  readonly de: string;
  readonly ate: string;
  readonly locationId?: string | null;
}): Promise<RespostaDaMetrica> {
  const { tenantId, metrica, dimensao, de, ate } = params;
  const unidade = params.locationId ?? null;

  return withTenant(tenantId, async (tx) => {
    /**
     * As métricas de venda, numa consulta por dimensão.
     *
     * `business_day` e não `closed_at`: é o dia da barbearia, o mesmo recorte do
     * fechamento de caixa que o balcão conferiu e assinou.
     */
    if (metrica === 'faturamento' || metrica === 'ticket_medio') {
      /**
       * Por profissional a conta é **item a item**, e é a mesma de
       * `desempenho.ts` — a tela que o barbeiro abre.
       *
       * Duas consultas literais e não um `CASE`, porque a diferença não é o
       * rótulo: é de onde o número sai. Atribuir a **comanda inteira** ao
       * profissional do agendamento — que era o que este arquivo fazia — põe na
       * conta dele a pomada que a recepção vendeu junto e o desconto que a casa
       * deu, e produzia R$ 673,00 de diferença sobre o mesmo barbeiro no mesmo
       * mês: o dono lia um número no assistente e o barbeiro lia outro na tela
       * dele. Sobre o dinheiro que ele recebe.
       *
       * O cabeçalho deste arquivo diz que *"onde já existe a definição, este
       * arquivo não a reescreve"* — e reescrevia, na dimensão.
       *
       * O total sem dimensão continua saindo de `orders`: ali a pergunta é
       * quanto a **casa** faturou, e a pomada é dela.
       */
      if (dimensao === 'profissional') {
        const linhas = await tx.$queryRaw<
          { rotulo: string | null; total: bigint; comandas: bigint }[]
        >`
          SELECT pr.name AS rotulo,
                 sum(oi.unit_price_cents * oi.quantity)::bigint AS total,
                 count(DISTINCT o.id)::bigint AS comandas
            FROM order_items oi
            JOIN orders o ON o.id = oi.order_id
            JOIN professionals pr ON pr.id = oi.professional_id
           WHERE o.status = 'paid'
             AND o.business_day BETWEEN ${de}::date AND ${ate}::date
             AND (${unidade}::uuid IS NULL OR o.location_id = ${unidade}::uuid)
           GROUP BY 1
           ORDER BY 2 DESC
        `;
        return dobrar(linhas, metrica === 'faturamento' ? 'soma' : 'media', dimensao);
      }

      const linhas = await tx.$queryRaw<{ rotulo: string | null; total: bigint; comandas: bigint }[]>`
        SELECT
          CASE WHEN ${dimensao} = 'unidade' THEN lo.name ELSE NULL END AS rotulo,
          -- Sem a gorjeta, como o painel e o DRE: e a mesma pergunta feita em
          -- portugues, e tres respostas diferentes para "quanto faturei" e a
          -- pior coisa que um assistente pode devolver.
          sum(o.total_cents - o.tip_cents)::bigint AS total,
          count(*)::bigint AS comandas
          FROM orders o
          LEFT JOIN locations lo ON lo.id = o.location_id
         WHERE o.status = 'paid'
           AND o.business_day BETWEEN ${de}::date AND ${ate}::date
           AND (${unidade}::uuid IS NULL OR o.location_id = ${unidade}::uuid)
         GROUP BY 1
         ORDER BY 2 DESC
      `;
      return dobrar(linhas, metrica === 'faturamento' ? 'soma' : 'media', dimensao);
    }

    if (metrica === 'atendimentos' || metrica === 'faltas' || metrica === 'perda_por_falta') {
      const estado = metrica === 'atendimentos' ? 'completed' : 'no_show';
      // Soma preço ou conta linhas — decidido aqui, e não com a chave da métrica
      // viajando para dentro do `CASE`: o SQL fica dizendo o que faz.
      const somaPreco = metrica === 'perda_por_falta';
      const linhas = await tx.$queryRaw<{ rotulo: string | null; total: bigint; comandas: bigint }[]>`
        SELECT
          CASE
            WHEN ${dimensao} = 'profissional' THEN pr.name
            WHEN ${dimensao} = 'unidade' THEN lo.name
            WHEN ${dimensao} = 'servico' THEN sv.name
            ELSE NULL
          END AS rotulo,
          -- A perda soma o preço; as outras duas contam linhas.
          sum(CASE WHEN ${somaPreco} THEN a.price_cents ELSE 1 END)::bigint AS total,
          count(*)::bigint AS comandas
          FROM appointments a
          JOIN professionals pr ON pr.id = a.professional_id
          LEFT JOIN locations lo ON lo.id = a.location_id
          LEFT JOIN LATERAL (
            SELECT s.name
              FROM appointment_services aps
              JOIN services s ON s.id = aps.service_id
             WHERE aps.appointment_id = a.id
             ORDER BY aps.position
             LIMIT 1
          ) sv ON true
         WHERE a.status = ${estado}::appointment_status
           AND a.service_starts_at >= ${de}::date
           AND a.service_starts_at < (${ate}::date + interval '1 day')
           AND (${unidade}::uuid IS NULL OR a.location_id = ${unidade}::uuid)
         GROUP BY 1
         ORDER BY 2 DESC
      `;
      return dobrar(linhas, 'soma', dimensao);
    }

    if (metrica === 'ocupacao') {
      /**
       * Minutos vendidos sobre minutos de jornada, em pontos-base.
       *
       * O denominador sai da jornada cadastrada, com pausa descontada — nunca
       * "horas × cadeiras × dias", que erra em toda barbearia que fecha na
       * segunda. É a mesma conta do bloco 62, e ela mora aqui porque a dimensão
       * por profissional exige agrupar os dois lados juntos.
       */
      const linhas = await tx.$queryRaw<{ rotulo: string | null; vendidos: bigint; abertos: bigint }[]>`
        WITH jornada AS (
          SELECT p.id AS professional_id, p.name,
                 sum(w.end_minute - w.start_minute - COALESCE((
                   SELECT sum((b->>'end')::int - (b->>'start')::int)
                     FROM jsonb_array_elements(w.breaks) AS b
                 ), 0))::bigint AS minutos
            FROM generate_series(${de}::date, ${ate}::date, interval '1 day') AS d
            JOIN work_schedules w ON w.weekday = EXTRACT(DOW FROM d)::int
            JOIN professionals p ON p.id = w.professional_id AND p.active
           WHERE (${unidade}::uuid IS NULL OR p.location_id = ${unidade}::uuid)
           GROUP BY p.id, p.name
        ), vendido AS (
          SELECT a.professional_id,
                 sum(EXTRACT(EPOCH FROM (a.service_ends_at - a.service_starts_at)) / 60)::bigint AS minutos
            FROM appointments a
           WHERE a.status = 'completed'
             AND a.service_starts_at >= ${de}::date
             AND a.service_starts_at < (${ate}::date + interval '1 day')
             AND (${unidade}::uuid IS NULL OR a.location_id = ${unidade}::uuid)
           GROUP BY a.professional_id
        )
        SELECT CASE WHEN ${dimensao} = 'profissional' THEN j.name ELSE NULL END AS rotulo,
               COALESCE(sum(v.minutos), 0)::bigint AS vendidos,
               sum(j.minutos)::bigint AS abertos
          FROM jornada j
          LEFT JOIN vendido v ON v.professional_id = j.professional_id
         GROUP BY 1
         ORDER BY 2 DESC
      `;
      const fatias = linhas.map((l) => ({
        rotulo: l.rotulo,
        valor: Number(l.abertos) > 0 ? Math.round((Number(l.vendidos) / Number(l.abertos)) * 10_000) : null,
      }));
      const vendidos = linhas.reduce((s, l) => s + Number(l.vendidos), 0);
      const abertos = linhas.reduce((s, l) => s + Number(l.abertos), 0);
      return {
        /**
         * O total é recalculado sobre as somas, nunca a média das fatias.
         *
         * A média de porcentagens dá peso igual a quem trabalha dois dias e a
         * quem trabalha seis — e a ocupação da casa passa a depender de quantos
         * barbeiros de meio período ela tem.
         */
        total: abertos > 0 ? Math.round((vendidos / abertos) * 10_000) : null,
        fatias: dimensao === 'nenhuma' ? [] : fatias,
      };
    }

    /**
     * As duas que **não** moram aqui.
     *
     * `clientes_em_risco` é `packages/crm` e `margem_por_servico` é `dre.ts`:
     * reescrever qualquer uma faria o assistente discordar da tela sobre o mesmo
     * número. Quem as compõe é a borda, como no bloco 62 — e o tipo de retorno
     * obriga quem chamar a tratar o caso.
     */
    return { total: null, fatias: [] };
  });
}

/**
 * Junta as linhas em total e fatias.
 *
 * `media` divide a soma pelo número de comandas — e não é a média das médias:
 * essa daria peso igual a um barbeiro com duas comandas e a outro com duzentas.
 */
function dobrar(
  linhas: readonly { rotulo: string | null; total: bigint; comandas: bigint }[],
  como: 'soma' | 'media',
  dimensao: DimensaoDaMetrica,
): RespostaDaMetrica {
  const soma = linhas.reduce((s, l) => s + inteiroSeguroDoBanco(l.total, 'métrica agregada'), 0);
  const comandas = linhas.reduce((s, l) => s + Number(l.comandas), 0);

  const fatias = linhas.map((l) => ({
    rotulo: l.rotulo,
    valor:
      como === 'soma'
        ? inteiroSeguroDoBanco(l.total, 'fatia da métrica')
        : Number(l.comandas) > 0
          ? Math.round(inteiroSeguroDoBanco(l.total, 'fatia da métrica') / Number(l.comandas))
          : null,
  }));

  return {
    total: como === 'soma' ? soma : comandas > 0 ? Math.round(soma / comandas) : null,
    fatias: dimensao === 'nenhuma' ? [] : fatias,
  };
}
