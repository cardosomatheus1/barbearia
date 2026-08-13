import { withTenant } from '@barbearia/db';
import {
  DIAS_DO_PROXIMO_HORARIO,
  formatDate,
  instantToLocal,
  parseDate,
  proximoHorario,
  type DiaComHorarios,
  type HorarioDaVitrine,
} from '@barbearia/core';
import { loadRangeContext } from './repository.js';
import { computeFromContext } from './service.js';

/**
 * O motor de disponibilidade rodado **em lote** (bloco 71, SPEC §5.2).
 *
 * > *"`Próximo horário` como elemento principal do card é o que diferencia de
 * > diretório — e exige que `/availability` seja rápido o bastante para rodar em
 * > lote."*
 *
 * ## O motor é o mesmo, e é isso que faz o card valer
 *
 * Nada aqui calcula disponibilidade: este arquivo abre uma transação por
 * barbearia e chama `loadRangeContext` + `computeFromContext`, exatamente o que
 * `GET /availability` chama. Uma segunda noção de "horário livre" seria a agenda
 * vendida duas vezes — o card prometeria 17:40 e a reserva recusaria, com o
 * cliente já dentro da página de outra barbearia.
 *
 * ## Uma transação por casa, e por que não dá para ser uma só
 *
 * A RLS é fixada por transação (`set_config('app.tenant_id', …, true)`), então
 * atravessar barbearias numa consulta só é justamente o que a política impede.
 * O que dá para fazer é limitar a largura: `CASAS_POR_VEZ` de cada vez, para o
 * lote não esgotar o pool e derrubar a latência de quem está agendando.
 */

/**
 * Quantas barbearias o lote consulta ao mesmo tempo.
 *
 * O pool do Prisma é compartilhado com quem está agendando neste instante. Sem
 * teto, uma busca com quarenta candidatas abriria quarenta transações e a fila
 * de conexões apareceria como lentidão na página pública — que é a tela que
 * este produto mede.
 */
export const CASAS_POR_VEZ = 8;

export interface PedidoDeProximoHorario {
  readonly tenantId: string;
  readonly locationId: string;
  /**
   * O serviço que deu o preço de entrada do card.
   *
   * O mesmo do "a partir de R$ 55,00" de propósito: preço e horário no mesmo
   * card precisam falar do mesmo serviço, senão o card diz "a partir de R$ 55"
   * ao lado de um horário que só existe para a barba de R$ 35.
   *
   * Nulo é barbearia sem nada vendável online — ela aparece na busca e não
   * anuncia horário, que é a verdade.
   */
  readonly serviceId: string | null;
}

/**
 * O próximo horário de cada barbearia da lista, por `locationId`.
 *
 * A chave é a unidade e não a barbearia: uma rede tem uma linha de vitrine por
 * loja, e é a loja que tem agenda.
 */
export async function proximosHorariosEmLote(
  pedidos: readonly PedidoDeProximoHorario[],
  agora: Date,
): Promise<ReadonlyMap<string, HorarioDaVitrine | null>> {
  const achados = new Map<string, HorarioDaVitrine | null>();

  for (let i = 0; i < pedidos.length; i += CASAS_POR_VEZ) {
    const fatia = pedidos.slice(i, i + CASAS_POR_VEZ);
    const respostas = await Promise.all(
      fatia.map(async (pedido) => [pedido.locationId, await umProximo(pedido, agora)] as const),
    );
    for (const [locationId, horario] of respostas) achados.set(locationId, horario);
  }

  return achados;
}

async function umProximo(
  pedido: PedidoDeProximoHorario,
  agora: Date,
): Promise<HorarioDaVitrine | null> {
  if (!pedido.serviceId) return null;
  const serviceId = pedido.serviceId;

  return withTenant(pedido.tenantId, async (tx) => {
    /**
     * O fuso vem da unidade, e é por isso que ele é lido antes das datas.
     *
     * "Hoje" no marketplace é hoje **na barbearia**: às 22h em Salvador já é
     * outro dia em Lisboa, e uma lista que misturasse os dois anunciaria
     * "disponível hoje" sobre a manhã seguinte. `loadRangeContext` já devolve o
     * fuso, mas ele precisa das datas para carregar — e as datas dependem do
     * fuso. Uma consulta indexada por chave primária resolve a ordem.
     */
    const linhas = await tx.$queryRaw<{ timezone: string }[]>`
      SELECT timezone FROM locations WHERE id = ${pedido.locationId}::uuid
    `;
    const timezone = linhas[0]?.timezone;
    if (!timezone) return null;

    const hoje = instantToLocal(timezone, agora).date;
    const datas = proximosDias(hoje, DIAS_DO_PROXIMO_HORARIO);

    const contexto = await loadRangeContext(tx, {
      locationId: pedido.locationId,
      serviceIds: [serviceId],
      dates: datas,
    });
    if (!contexto) return null;

    const dias: DiaComHorarios[] = [];
    for (const date of datas) {
      const dia = contexto.days.get(date);
      if (!dia) continue;
      /**
       * `collapse` é obrigatório aqui.
       *
       * Sem ele a grade sai uma vez por profissional, e o "primeiro horário"
       * seria o do primeiro barbeiro da lista em vez do primeiro da casa. Com
       * três cadeiras, o card mostraria 17:40 tendo 15:00 livre ao lado.
       */
      const resposta = computeFromContext(dia, { date, collapse: true, now: agora });
      dias.push({ date, slots: resposta.slots });
    }

    return proximoHorario(dias, agora, hoje);
  });
}

/** `dias` datas consecutivas a partir de `inicio`, inclusive. */
function proximosDias(inicio: string, dias: number): string[] {
  const base = parseDate(inicio);
  const datas: string[] = [];
  for (let i = 0; i < dias; i += 1) {
    const d = new Date(Date.UTC(base.year, base.month - 1, base.day + i));
    datas.push(
      formatDate({
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
      }),
    );
  }
  return datas;
}
