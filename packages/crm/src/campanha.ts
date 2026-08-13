import { withTenant } from '@barbearia/db';
import {
  decidirDisparo,
  FILTROS_DE_CAMPANHA,
  ROTULO_DO_FILTRO,
  SEGMENTO_DO_FILTRO,
  type FiltroDeCampanha,
  type Segmento,
  type TipoDeNotificacao,
} from '@barbearia/core';
import { audit } from '@barbearia/identity';
import { segmentosDaBase } from './segmento.js';

/**
 * Campanhas (bloco 57, SPEC §4.13).
 *
 * > *"Toda campanha reporta: enviados · entregues · lidos · cliques ·
 * > agendamentos gerados · receita atribuída. A última coluna é a única que
 * > importa."*
 *
 * ## O público é congelado na criação
 *
 * `campaign_targets` guarda **quem entrou**, não o filtro. Guardar o filtro
 * faria "quantos receberam" mudar toda vez que alguém fosse cadastrado — e a
 * receita atribuída, que é lida contra esse conjunto, mudaria junto. O filtro é
 * como se chegou ao público; o público é o fato.
 *
 * ## As proteções são as mesmas da automação
 *
 * Teto, opt-out, janela de silêncio e um-por-dia moram em `packages/core` desde
 * o bloco 20 e são **chamados** aqui, nunca reescritos. Uma campanha que
 * ignorasse o teto porque "foi o dono que mandou" seria a porta pela qual o
 * número da barbearia queima.
 */

/**
 * O vocabulário mora em `packages/core` desde o bloco 61 — aqui só se reexporta.
 *
 * Ele estava escrito duas vezes, aqui e dentro da tela de campanhas, e o bloco
 * que acrescentou três públicos teria deixado a tela oferecendo quatro com a API
 * aceitando sete. `FILTROS` continua com o nome antigo porque é o que a borda da
 * API importa para montar o `z.enum`.
 */
export const FILTROS = FILTROS_DE_CAMPANHA;
export type { FiltroDeCampanha };
export { ROTULO_DO_FILTRO };

/**
 * O segmento por trás do filtro, quando existe.
 *
 * O segmento depende da base inteira — "frequente" é ciclo abaixo da mediana
 * dela, "VIP" é o topo do decil de gasto — e a mediana de uma base não cabe numa
 * cláusula `WHERE` sobre uma linha. Escrevê-la em SQL seria regra de negócio na
 * consulta, onde o teste não alcança, e é a mesma razão de o ciclo ser calculado
 * em `packages/core`.
 */
function segmentoDoFiltro(filtro: FiltroDeCampanha): Segmento | null {
  return SEGMENTO_DO_FILTRO[filtro] ?? null;
}

export type CampanhaFailure = 'nao_encontrada' | 'invalida' | 'ja_enviada';

export class CampanhaError extends Error {
  constructor(
    readonly code: CampanhaFailure,
    message: string,
  ) {
    super(message);
    this.name = 'CampanhaError';
  }
}

export interface CampanhaNaTela {
  readonly id: string;
  readonly nome: string;
  readonly filtro: FiltroDeCampanha;
  readonly valorDoFiltro: number | null;
  readonly diaDaSemana: number | null;
  readonly tipo: TipoDeNotificacao;
  readonly estado: 'rascunho' | 'enviando' | 'enviada';
  readonly criadaEm: string;
  /** As seis colunas da SPEC §4.13. A última é a que importa. */
  readonly publico: number;
  readonly enviados: number;
  readonly entregues: number;
  readonly lidos: number;
  readonly cliques: number;
  readonly agendamentos: number;
  readonly receitaCents: number;
}

/**
 * A lista, com as seis colunas numa consulta só.
 *
 * Agregação e não laço: uma ida ao banco por campanha para contar entregues
 * seria o N+1 que a regra proíbe. `whatsapp_messages` entra por `LEFT JOIN`
 * porque entregue e lido são fato **da Meta**, e não nosso — quem os grava é o
 * webhook do bloco 55.
 */
export async function campanhasDaCasa(tenantId: string): Promise<readonly CampanhaNaTela[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        name: string;
        filter: FiltroDeCampanha;
        filter_value: number | null;
        filter_weekday: number | null;
        kind: TipoDeNotificacao;
        status: 'rascunho' | 'enviando' | 'enviada';
        created_at: Date;
        publico: bigint;
        enviados: bigint;
        entregues: bigint;
        lidos: bigint;
        cliques: bigint;
        agendamentos: bigint;
        receita: bigint | null;
      }[]
    >`
      SELECT c.id, c.name, c.filter::text AS filter, c.filter_value, c.filter_weekday,
             c.kind::text AS kind, c.status::text AS status, c.created_at,
             count(t.id) AS publico,
             count(t.id) FILTER (WHERE t.sent_at IS NOT NULL) AS enviados,
             count(t.id) FILTER (WHERE m.delivered_at IS NOT NULL) AS entregues,
             count(t.id) FILTER (WHERE m.read_at IS NOT NULL) AS lidos,
             count(t.id) FILTER (WHERE t.clicked_at IS NOT NULL) AS cliques,
             count(t.id) FILTER (WHERE t.goal_met_at IS NOT NULL) AS agendamentos,
             COALESCE(sum(t.goal_amount_cents), 0) AS receita
        FROM campaigns c
        LEFT JOIN campaign_targets t ON t.campaign_id = c.id
        LEFT JOIN whatsapp_messages m ON m.wamid = t.wamid
       GROUP BY c.id
       ORDER BY c.created_at DESC
    `;
    return linhas.map((l) => ({
      id: l.id,
      nome: l.name,
      filtro: l.filter,
      valorDoFiltro: l.filter_value,
      diaDaSemana: l.filter_weekday,
      tipo: l.kind,
      estado: l.status,
      criadaEm: l.created_at.toISOString(),
      publico: Number(l.publico),
      enviados: Number(l.enviados),
      entregues: Number(l.entregues),
      lidos: Number(l.lidos),
      cliques: Number(l.cliques),
      agendamentos: Number(l.agendamentos),
      receitaCents: Number(l.receita ?? 0),
    }));
  });
}

/**
 * Cria a campanha e **congela o público** na mesma transação.
 *
 * As duas coisas juntas porque separá-las cria o estado em que a campanha
 * existe sem público — e é nele que alguém aperta "enviar" e não acontece nada,
 * sem erro. O filtro roda uma vez; depois disso o público é o que está gravado.
 */
export async function criarCampanha(params: {
  readonly tenantId: string;
  readonly nome: string;
  readonly filtro: FiltroDeCampanha;
  readonly valorDoFiltro: number | null;
  readonly diaDaSemana: number | null;
  readonly tipo: TipoDeNotificacao;
  readonly janelaDias: number;
  readonly agora: Date;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<{ readonly id: string; readonly publico: number }> {
  if (params.nome.trim().length === 0) {
    throw new CampanhaError('invalida', 'Dê um nome para a campanha.');
  }
  if (params.filtro === 'celula_fria' && (params.diaDaSemana === null || params.valorDoFiltro === null)) {
    throw new CampanhaError('invalida', 'A célula precisa de dia e hora.');
  }

  return withTenant(params.tenantId, async (tx) => {
    const criadas = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO campaigns
        (tenant_id, name, filter, filter_value, filter_weekday, kind, goal_window_days, created_by)
      VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid,
              ${params.nome.trim()}, ${params.filtro}::campaign_filter,
              ${params.valorDoFiltro}, ${params.diaDaSemana},
              ${params.tipo}::notification_kind, ${params.janelaDias},
              ${params.staffId}::uuid)
      RETURNING id
    `;
    const campanha = criadas[0];
    if (!campanha) throw new CampanhaError('invalida', 'Não deu para criar a campanha.');

    /**
     * Quando o filtro é um segmento, quem escolhe é `packages/core`.
     *
     * A carga é uma só, dentro **desta** transação: o segmento depende da base
     * inteira, e ler a base fora dela deixaria a janela em que alguém é
     * cadastrado entre o cálculo e a gravação do público.
     */
    const segmento = segmentoDoFiltro(params.filtro);
    const doSegmento =
      segmento === null
        ? []
        : (await segmentosDaBase(params.tenantId, params.agora, tx))
            .filter((c) => c.segmento === segmento)
            .map((c) => c.customerId);

    /**
     * O público, congelado agora.
     *
     * Todo filtro exclui quem foi anonimizado e quem não tem telefone: os dois
     * entrariam no público para serem pulados no envio, inflando "quantos
     * receberam" com gente que nunca poderia receber — e a receita atribuída
     * divide por esse número.
     */
    const publico = await tx.$executeRawUnsafe(
      `INSERT INTO campaign_targets (tenant_id, campaign_id, customer_id)
       SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, c.id
         FROM customers c
        WHERE c.anonymized_at IS NULL AND c.phone_e164 IS NOT NULL
          AND ${condicaoDoFiltro(params.filtro)}
       ON CONFLICT (campaign_id, customer_id) DO NOTHING`,
      campanha.id,
      params.agora,
      params.valorDoFiltro ?? 0,
      params.diaDaSemana ?? 0,
      doSegmento,
    );

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'campaign.created',
      entity: 'campaigns',
      entityId: campanha.id,
      after: { nome: params.nome, filtro: params.filtro, publico },
    });

    return { id: campanha.id, publico };
  });
}

/**
 * A condição de cada filtro, com os parâmetros na mesma ordem sempre.
 *
 * `$2` é o instante, `$3` o número do filtro, `$4` o dia da semana, `$5` a lista
 * do segmento — sempre, em todos os filtros, mesmo quando um deles não usa. Uma
 * ordem que mudasse por filtro faria o parâmetro certo chegar na posição errada,
 * e o erro seria um público silenciosamente diferente do pedido.
 *
 * Por isso todo caso menciona os quatro: um parâmetro que o Postgres nunca vê no
 * texto é um parâmetro sem tipo inferido, e a instrução é recusada.
 */
function condicaoDoFiltro(filtro: FiltroDeCampanha): string {
  /**
   * Todo caso menciona os quatro parâmetros, inclusive os que não usa.
   *
   * Não é adorno: a instrução vai com cinco valores sempre, e o Postgres recusa
   * um `bind` com mais parâmetros do que o texto declara. Antes de `$5` existir
   * isso já era assim para `$3` e `$4` — o que muda é que agora há uma frase
   * explicando por quê.
   */
  const naoUsados = `$2::timestamptz IS NOT NULL AND $3::int IS NOT NULL
                     AND $4::int IS NOT NULL AND $5::uuid[] IS NOT NULL`;
  switch (filtro) {
    case 'em_risco':
    case 'perdido':
    case 'vip':
      /**
       * A lista já veio decidida por `packages/core`, e ela sai de uma consulta
       * feita sob a RLS **desta** barbearia — ninguém de fora entra por aqui.
       * As condições de anonimizado e telefone continuam valendo por cima, como
       * em todo filtro.
       */
      return `c.id = ANY($5::uuid[]) AND $2::timestamptz IS NOT NULL
              AND $3::int IS NOT NULL AND $4::int IS NOT NULL`;
    case 'todos':
      return `(${naoUsados})`;
    case 'inativos':
      return `NOT EXISTS (
                SELECT 1 FROM appointments a
                 WHERE a.customer_id = c.id
                   AND a.starts_at > $2::timestamptz - ($3::int * interval '1 day')
              ) AND $4::int IS NOT NULL AND $5::uuid[] IS NOT NULL`;
    case 'aniversariantes':
      return `c.birth_date IS NOT NULL
              AND EXTRACT(MONTH FROM c.birth_date) = EXTRACT(MONTH FROM $2::timestamptz)
              AND $3::int IS NOT NULL AND $4::int IS NOT NULL
              AND $5::uuid[] IS NOT NULL`;
    case 'celula_fria':
      /**
       * Quem **costuma vir naquele horário** — e não quem já veio uma vez.
       *
       * A célula fria é uma hora que a barbearia quer encher; o público certo é
       * quem tem o hábito daquele horário, porque é quem pode voltar a ele. Uma
       * campanha para toda a base sobre uma terça às 14h é ruído para quem só
       * corta no sábado.
       */
      return `EXISTS (
                SELECT 1 FROM appointments a
                 JOIN locations l ON l.id = a.location_id
                 WHERE a.customer_id = c.id
                   AND a.status = 'completed'
                   AND a.starts_at > $2::timestamptz - interval '180 days'
                   AND EXTRACT(DOW FROM a.starts_at AT TIME ZONE l.timezone)::int = $4::int
                   AND EXTRACT(HOUR FROM a.starts_at AT TIME ZONE l.timezone)::int = $3::int
              ) AND $5::uuid[] IS NOT NULL`;
  }
}

export interface AlvoAEnviar {
  readonly id: string;
  readonly customerId: string;
  readonly telefone: string;
  readonly clienteNome: string;
  readonly barbearia: string;
  readonly tipo: TipoDeNotificacao;
}

export async function alvosAEnviar(
  tenantId: string,
  campanhaId: string,
  limite = 200,
): Promise<readonly AlvoAEnviar[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        customer_id: string;
        phone_e164: string;
        name: string;
        barbearia: string;
        kind: TipoDeNotificacao;
      }[]
    >`
      SELECT t.id, t.customer_id, c.phone_e164, c.name, tn.name AS barbearia,
             ca.kind::text AS kind
        FROM campaign_targets t
        JOIN campaigns ca ON ca.id = t.campaign_id
        JOIN customers c ON c.id = t.customer_id
        JOIN tenants tn ON tn.id = t.tenant_id
       WHERE t.campaign_id = ${campanhaId}::uuid
         AND t.sent_at IS NULL AND t.skipped_reason IS NULL
       LIMIT ${limite}
    `;
    return linhas.map((l) => ({
      id: l.id,
      customerId: l.customer_id,
      telefone: l.phone_e164,
      clienteNome: l.name,
      barbearia: l.barbearia,
      tipo: l.kind,
    }));
  });
}

/**
 * Decide e carimba cada alvo, com as mesmas proteções da automação.
 *
 * Devolve quantos saíram. O que **não** sai fica com o motivo escrito, pela
 * razão de sempre: "nada foi enviado" sem motivo transforma toda pergunta do
 * dono numa investigação.
 */
export async function despacharCampanha(params: {
  readonly tenantId: string;
  readonly campanhaId: string;
  readonly agora: Date;
  readonly timeZone: string;
  readonly enviar: (alvo: AlvoAEnviar) => Promise<void>;
}): Promise<{ readonly enviados: number; readonly pulados: number }> {
  const alvos = await alvosAEnviar(params.tenantId, params.campanhaId);
  let enviados = 0;
  let pulados = 0;

  for (const alvo of alvos) {
    const contagem = await withTenant(params.tenantId, async (tx) => {
      const linhas = await tx.$queryRaw<{ hoje: bigint; no_mes: bigint; aceita: boolean }[]>`
        SELECT
          (SELECT count(*) FROM campaign_targets o
            WHERE o.customer_id = ${alvo.customerId}::uuid
              AND o.sent_at IS NOT NULL
              AND (o.sent_at AT TIME ZONE 'UTC')::date
                = (${params.agora}::timestamptz AT TIME ZONE 'UTC')::date) AS hoje,
          (SELECT count(*) FROM notifications n
            WHERE n.customer_id = ${alvo.customerId}::uuid AND n.status = 'sent'
              AND n.sent_at > ${params.agora}::timestamptz - interval '30 days') AS no_mes,
          (SELECT accepts_marketing FROM customers WHERE id = ${alvo.customerId}::uuid) AS aceita
      `;
      return linhas[0];
    });

    const decisao = decidirDisparo({
      ativa: true,
      tipo: alvo.tipo,
      jaDisparouPorEsteFato: false,
      jaRecebeuHoje: Number(contagem?.hoje ?? 0) > 0,
      temTelefone: true,
      aceitaPromocional: contagem?.aceita ?? false,
      promocionaisNoMes: Number(contagem?.no_mes ?? 0),
      atrasoMinutos: 0,
      fatoEm: params.agora,
      agora: params.agora,
      timeZone: params.timeZone,
    });

    if (!decisao.disparar || !decisao.quando || decisao.quando.getTime() > params.agora.getTime()) {
      await withTenant(params.tenantId, async (tx) => {
        await tx.$executeRaw`
          UPDATE campaign_targets SET skipped_reason = ${decisao.motivo ?? 'fora_da_janela'}
           WHERE id = ${alvo.id}::uuid AND sent_at IS NULL
        `;
      });
      pulados += 1;
      continue;
    }

    /**
     * O carimbo vem antes da mensagem — precedente do bloco 54 — e usa o
     * relógio **injetado**, não o `now()` do banco.
     *
     * A decisão logo acima já recebe `agora` por parâmetro, como manda a regra
     * do projeto. Carimbar com `now()` fazia as duas discordarem: a regra de
     * um-por-dia comparava a data do parâmetro com uma coluna gravada pelo
     * relógio do processo, e o teste flagrou — a segunda campanha do mesmo dia
     * saía porque as duas datas eram diferentes.
     */
    const nosso = await withTenant(params.tenantId, async (tx) => {
      const afetadas = await tx.$executeRaw`
        UPDATE campaign_targets SET sent_at = ${params.agora}
         WHERE id = ${alvo.id}::uuid AND sent_at IS NULL AND skipped_reason IS NULL
      `;
      return afetadas === 1;
    });
    if (!nosso) continue;

    await params.enviar(alvo);
    enviados += 1;
  }

  await withTenant(params.tenantId, async (tx) => {
    await tx.$executeRaw`
      UPDATE campaigns SET status = 'enviada', sent_at = COALESCE(sent_at, ${params.agora})
       WHERE id = ${params.campanhaId}::uuid
    `;
  });

  return { enviados, pulados };
}

/**
 * A receita atribuída — *"a única coluna que importa"*.
 *
 * Congelada no momento da atribuição, e é a exceção da regra de valor derivado
 * deste schema. Recalcular na leitura faria o relatório de uma campanha de
 * março mudar quando alguém estornasse uma venda em maio, e a pergunta que a
 * coluna responde é "quanto esta campanha trouxe", não "quanto vale hoje".
 */
export async function atribuirReceita(params: {
  readonly tenantId: string;
  readonly agora: Date;
}): Promise<number> {
  return withTenant(params.tenantId, async (tx) => {
    /**
     * A venda mais próxima de cada envio, numa instrução só.
     *
     * `LATERAL` não enxerga a tabela que o `UPDATE` altera — o Postgres recusa
     * a referência —, então o cálculo vira uma subconsulta que já traz o id do
     * alvo. Um laço por alvo seria o N+1 que a regra proíbe, e aqui ele é sobre
     * o público inteiro de todas as campanhas.
     */
    const atribuidos = await tx.$executeRaw`
      UPDATE campaign_targets t
         SET goal_met_at = v.closed_at, goal_ref = v.venda, goal_amount_cents = v.total_cents
        FROM (
          SELECT tt.id AS alvo, o.id AS venda, o.closed_at, o.total_cents
            FROM campaign_targets tt
            JOIN campaigns c ON c.id = tt.campaign_id
            JOIN LATERAL (
              SELECT o.id, o.closed_at, o.total_cents
                FROM orders o
               WHERE o.customer_id = tt.customer_id
                 AND o.status = 'paid'
                 AND o.closed_at > tt.sent_at
                 AND o.closed_at <= tt.sent_at + (c.goal_window_days * interval '1 day')
               ORDER BY o.closed_at
               LIMIT 1
            ) o ON true
           WHERE tt.sent_at IS NOT NULL AND tt.goal_met_at IS NULL
        ) v
       WHERE t.id = v.alvo AND t.goal_met_at IS NULL
    `;
    return atribuidos;
  });
}
