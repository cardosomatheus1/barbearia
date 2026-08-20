import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  progressoDaMeta,
  taxaDeRetorno,
  ticketMedio,
  variacao,
  type ProgressoDaMeta,
} from '@barbearia/core';

/**
 * Os números do barbeiro, do banco para a tela — SPEC §4.21.
 *
 * A leitura é toda de `packages/core`; aqui só se conta. E se conta em **duas
 * consultas**: uma para o mês corrente e a anterior, outra para a meta. Uma
 * consulta por indicador seria N+1 na tela que o barbeiro abre entre um cliente
 * e outro.
 *
 * Fica em `finance` porque os números são de dinheiro e a comissão — que é a
 * outra metade desta tela — já mora aqui. A alternativa seria um pacote de
 * relatórios com dois arquivos e a mesma dependência.
 */

export class MetaError extends Error {
  constructor(readonly code: 'profissional_nao_encontrado' | 'mes_invalido', message: string) {
    super(message);
    this.name = 'MetaError';
  }
}

export interface DesempenhoDoMes {
  readonly faturamentoCents: number;
  readonly atendimentos: number;
  readonly ticketMedioCents: number;
  /** `rebooking rate` em pontos inteiros. */
  readonly taxaDeRetorno: number;
  readonly produtosVendidos: number;
}

export interface Desempenho {
  readonly professionalId: string;
  readonly professionalName: string;
  /** Primeiro dia do mês, YYYY-MM-DD. */
  readonly mes: string;
  readonly hoje: DesempenhoDoMes;
  readonly mesAtual: DesempenhoDoMes;
  readonly mesAnterior: DesempenhoDoMes;
  /** Variação do faturamento contra o mês anterior, em pontos. Nulo no primeiro. */
  readonly variacaoDoFaturamento: number | null;
  readonly meta: ProgressoDaMeta;
}

interface LinhaDeTotais {
  faturamento_cents: bigint | null;
  atendimentos: bigint;
  saiu_com_horario: bigint;
  produtos: bigint;
}

/**
 * Os totais de um intervalo, para uma cadeira.
 *
 * **O faturamento sai de `order_items`, não de `appointments.price_cents`.** O
 * segundo é o preço combinado na marcação; o primeiro é o que foi vendido de
 * fato, com desconto, produto e o que a recepção acrescentou no balcão. É a
 * mesma base que a comissão do bloco 19 usa, e ter duas contas de faturamento
 * no produto seria ter duas verdades.
 *
 * `business_day` e não `closed_at`: o dia de uma venda é o dia **da unidade**.
 * Uma comanda fechada às 23h50 de sábado pertence ao sábado, mesmo que em UTC
 * já seja domingo (a mesma decisão do bloco 19).
 */
async function totais(
  tx: TransactionClient,
  professionalId: string,
  de: string,
  ate: string,
): Promise<LinhaDeTotais> {
  const linhas = await tx.$queryRaw<LinhaDeTotais[]>`
    SELECT
      (SELECT coalesce(sum(oi.unit_price_cents * oi.quantity), 0)
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
        WHERE oi.professional_id = ${professionalId}::uuid
          AND o.status = 'paid'
          AND o.business_day BETWEEN ${de}::date AND ${ate}::date)::bigint
      AS faturamento_cents,

      (SELECT count(*) FROM appointments a
        WHERE a.professional_id = ${professionalId}::uuid
          AND a.status = 'completed'
          AND a.service_starts_at >= ${de}::date
          AND a.service_starts_at < (${ate}::date + 1))::bigint
      AS atendimentos,

      -- O rebooking rate da SPEC 4.21.
      --
      -- "Saiu com o próximo horário marcado" é medido contra o instante em que
      -- ESTE atendimento aconteceu, não contra agora: perguntar "tem
      -- agendamento futuro hoje?" contaria quem marcou meses depois por outro
      -- motivo, e a taxa de um mês fechado mudaria toda vez que alguém
      -- abrisse a tela.
      (SELECT count(*) FROM appointments a
        WHERE a.professional_id = ${professionalId}::uuid
          AND a.status = 'completed'
          AND a.service_starts_at >= ${de}::date
          AND a.service_starts_at < (${ate}::date + 1)
          -- Redundante para a correção e mantida para o planejador: com o
          -- cliente nulo o EXISTS abaixo já é falso, porque NULL = NULL não é
          -- verdadeiro em SQL. Quebrar esta linha de propósito não deixou
          -- nenhum teste vermelho, e é isso que ela é: uma poda, não uma regra.
          AND a.customer_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM appointments proximo
             WHERE proximo.customer_id = a.customer_id
               AND proximo.id <> a.id
               AND proximo.created_at <= a.service_starts_at + interval '1 day'
               AND proximo.service_starts_at > a.service_starts_at
               AND proximo.status NOT IN ('cancelled_customer', 'cancelled_business', 'rescheduled')
          ))::bigint
      AS saiu_com_horario,

      (SELECT coalesce(sum(oi.quantity), 0)
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
        WHERE oi.professional_id = ${professionalId}::uuid
          AND oi.kind = 'product'
          AND o.status = 'paid'
          AND o.business_day BETWEEN ${de}::date AND ${ate}::date)::bigint
      AS produtos
  `;

  return (
    linhas[0] ?? {
      faturamento_cents: 0n,
      atendimentos: 0n,
      saiu_com_horario: 0n,
      produtos: 0n,
    }
  );
}

function daLinha(linha: LinhaDeTotais): DesempenhoDoMes {
  const contados = {
    faturamentoCents: Number(linha.faturamento_cents ?? 0),
    atendimentos: Number(linha.atendimentos),
    saiuComHorario: Number(linha.saiu_com_horario),
  };

  return {
    faturamentoCents: contados.faturamentoCents,
    atendimentos: contados.atendimentos,
    ticketMedioCents: ticketMedio(contados),
    taxaDeRetorno: taxaDeRetorno(contados),
    produtosVendidos: Number(linha.produtos),
  };
}

/** Primeiro e último dia do mês de uma data local, em YYYY-MM-DD. */
function limitesDoMes(dia: string): { primeiro: string; ultimo: string; diasNoMes: number } {
  const [ano, mes] = dia.split('-').map(Number);
  if (!ano || !mes) throw new MetaError('mes_invalido', 'Mês inválido.');
  // Dia 0 do mês seguinte é o último do mês corrente — e acerta fevereiro
  // bissexto sem tabela.
  const diasNoMes = new Date(Date.UTC(ano, mes, 0)).getUTCDate();
  const dois = (n: number) => String(n).padStart(2, '0');
  return {
    primeiro: `${ano}-${dois(mes)}-01`,
    ultimo: `${ano}-${dois(mes)}-${dois(diasNoMes)}`,
    diasNoMes,
  };
}

function mesAnteriorDe(primeiro: string): { primeiro: string; ultimo: string } {
  const [ano, mes] = primeiro.split('-').map(Number);
  if (!ano || !mes) throw new MetaError('mes_invalido', 'Mês inválido.');
  const anterior = mes === 1 ? { ano: ano - 1, mes: 12 } : { ano, mes: mes - 1 };
  const dois = (n: number) => String(n).padStart(2, '0');
  const dias = new Date(Date.UTC(anterior.ano, anterior.mes, 0)).getUTCDate();
  return {
    primeiro: `${anterior.ano}-${dois(anterior.mes)}-01`,
    ultimo: `${anterior.ano}-${dois(anterior.mes)}-${dois(dias)}`,
  };
}

/**
 * O desempenho de uma cadeira no mês de `hoje`.
 *
 * `hoje` é a data **da unidade**, não a do processo: recebida já resolvida pela
 * borda, como todo o resto do produto desde o defeito D2.
 */
export async function desempenhoDoProfissional(params: {
  readonly tenantId: string;
  readonly professionalId: string;
  /** Data local da unidade, YYYY-MM-DD. */
  readonly hoje: string;
}): Promise<Desempenho> {
  const mes = limitesDoMes(params.hoje);
  const anterior = mesAnteriorDe(mes.primeiro);
  const diaDoMes = Number(params.hoje.slice(8, 10));

  return withTenant(params.tenantId, async (tx) => {
    const quem = await tx.$queryRaw<{ name: string }[]>`
      SELECT name FROM professionals WHERE id = ${params.professionalId}::uuid
    `;
    // Cadeira de outra barbearia não existe: a RLS devolve zero linhas, e a
    // resposta é a mesma de um id inventado.
    if (!quem[0]) {
      throw new MetaError('profissional_nao_encontrado', 'Profissional não encontrado.');
    }

    const [doMes, doAnterior, doDia] = await Promise.all([
      totais(tx, params.professionalId, mes.primeiro, mes.ultimo),
      totais(tx, params.professionalId, anterior.primeiro, anterior.ultimo),
      totais(tx, params.professionalId, params.hoje, params.hoje),
    ]);

    const metas = await tx.$queryRaw<{ revenue_cents: number }[]>`
      SELECT revenue_cents FROM professional_goals
       WHERE professional_id = ${params.professionalId}::uuid
         AND month = ${mes.primeiro}::date
    `;

    const mesAtual = daLinha(doMes);
    const mesAnterior = daLinha(doAnterior);

    return {
      professionalId: params.professionalId,
      professionalName: quem[0].name,
      mes: mes.primeiro,
      hoje: daLinha(doDia),
      mesAtual,
      mesAnterior,
      variacaoDoFaturamento: variacao(mesAtual.faturamentoCents, mesAnterior.faturamentoCents),
      meta: progressoDaMeta({
        metaCents: metas[0]?.revenue_cents ?? 0,
        realizadoCents: mesAtual.faturamentoCents,
        diaDoMes,
        diasNoMes: mes.diasNoMes,
      }),
    };
  });
}

export interface MetaDoMes {
  readonly professionalId: string;
  readonly professionalName: string;
  readonly mes: string;
  readonly metaCents: number | null;
  /** A do mês anterior, para a tela sugerir sem decidir por ninguém. */
  readonly anteriorCents: number | null;
}

/** As metas do mês, com a sugestão do mês passado. */
export async function metasDoMes(params: {
  readonly tenantId: string;
  /**
   * A unidade da sessão, pelo mesmo motivo de `salvarMeta`.
   *
   * A gravação foi escopada e a leitura ficou: o gerente da filial via o nome e
   * a meta de faturamento de todo barbeiro da matriz, e a tela listava cadeiras
   * cujo botão de salvar responde "profissional não encontrado" (§6, pergunta
   * 6, dentro de uma tela só).
   */
  readonly locationId: string;
  readonly mes: string;
}): Promise<readonly MetaDoMes[]> {
  const { primeiro } = limitesDoMes(params.mes);
  const anterior = mesAnteriorDe(primeiro);

  return withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        name: string;
        meta_cents: number | null;
        anterior_cents: number | null;
      }[]
    >`
      SELECT p.id, p.name,
             (SELECT g.revenue_cents FROM professional_goals g
               WHERE g.professional_id = p.id AND g.month = ${primeiro}::date) AS meta_cents,
             (SELECT g.revenue_cents FROM professional_goals g
               WHERE g.professional_id = p.id AND g.month = ${anterior.primeiro}::date)
               AS anterior_cents
        FROM professionals p
       WHERE p.active AND p.kind = 'professional'
         AND p.location_id = ${params.locationId}::uuid
       ORDER BY p.name
    `;

    return linhas.map((linha) => ({
      professionalId: linha.id,
      professionalName: linha.name,
      mes: primeiro,
      metaCents: linha.meta_cents,
      anteriorCents: linha.anterior_cents,
    }));
  });
}

/**
 * Define — ou apaga — a meta de uma cadeira num mês.
 *
 * `metaCents` nulo apaga a linha, e é o único jeito de dizer "sem meta". Zero
 * seria uma segunda forma de dizer o mesmo, e a CHECK do banco a recusa de
 * propósito: duas maneiras de expressar a ausência é como a tela acaba
 * mostrando "0% de R$ 0,00".
 *
 * O profissional é conferido sob RLS antes de gravar: a chave estrangeira não
 * protege, porque a checagem de integridade referencial ignora row security.
 */
export async function salvarMeta(params: {
  readonly tenantId: string;
  /**
   * A unidade da sessão. A RLS separa barbearias e não separa lojas: sem ela, o
   * gerente da filial definia a meta do mês de um barbeiro da matriz.
   */
  readonly locationId: string;
  readonly professionalId: string;
  readonly mes: string;
  readonly metaCents: number | null;
  readonly staffUserId: string;
}): Promise<void> {
  const { primeiro } = limitesDoMes(params.mes);

  await withTenant(params.tenantId, async (tx) => {
    const existe = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM professionals
       WHERE id = ${params.professionalId}::uuid
         AND location_id = ${params.locationId}::uuid
    `;
    if (!existe[0]) {
      throw new MetaError('profissional_nao_encontrado', 'Profissional não encontrado.');
    }

    if (params.metaCents === null) {
      await tx.$executeRaw`
        DELETE FROM professional_goals
         WHERE professional_id = ${params.professionalId}::uuid AND month = ${primeiro}::date
      `;
      return;
    }

    await tx.$executeRaw`
      INSERT INTO professional_goals
        (tenant_id, professional_id, month, revenue_cents, updated_by)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${params.professionalId}::uuid, ${primeiro}::date,
        ${params.metaCents}, ${params.staffUserId}::uuid
      )
      ON CONFLICT (professional_id, month) DO UPDATE SET
        revenue_cents = EXCLUDED.revenue_cents,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
    `;
  });
}
