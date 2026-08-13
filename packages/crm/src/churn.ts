import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  faixaDeChurn,
  riscoDeChurn,
  type FaixaDeChurn,
  type MotivoDeChurn,
  type SinaisDeChurn,
} from '@barbearia/core';
import { segmentosDaBase } from './segmento.js';

/**
 * Os sete sinais de churn, do banco para a conta (bloco 62, SPEC §4.5).
 *
 * ## Uma consulta, e o ritmo vem do bloco 61
 *
 * O primeiro sinal — *"desvio do ciclo próprio"* — é exatamente o ciclo que o
 * bloco anterior já calcula, e ele não é recalculado aqui. Duas fontes para o
 * mesmo número fariam a ficha dizer "volta a cada 21 dias" e o painel de risco
 * dizer 23, sobre a mesma pessoa e na mesma tarde.
 *
 * Os outros seis saem de uma consulta só, agregada por cliente. Um `SELECT` por
 * pessoa seria o N+1 sobre a base inteira — e é justamente a barbearia com mais
 * gente em risco que mais precisa desta tela abrir.
 *
 * ## O que **não** entra
 *
 * Nenhum valor em reais sai daqui. O ticket é lido para decidir se caiu e vira
 * *"está gastando 50% menos por visita"*: a porcentagem é o sinal, e os centavos
 * são `finance.view`. Devolvê-los seria o faturamento por cliente saindo de uma
 * rota de retenção — o defeito que a revisão do bloco 54 achou na nota fiscal.
 */

export interface ClienteEmRiscoDeChurn {
  readonly customerId: string;
  readonly nome: string;
  readonly risco: number;
  readonly faixa: FaixaDeChurn;
  readonly motivos: readonly MotivoDeChurn[];
  /** Nulo quando não há ritmo — e aí o produto diz que não sabe, não que é baixo. */
  readonly cicloDias: number | null;
  readonly diasSemVir: number | null;
}

interface LinhaDeSinais {
  customer_id: string;
  name: string;
  ultima_nota: number | null;
  tem_futuro: boolean;
  barbeiro_saiu: boolean;
  barbeiro_nome: string | null;
  cancelou: boolean;
  assinatura_vencida: boolean;
  assinatura_ativa: boolean;
  ticket_recente: number | null;
  ticket_anterior: number | null;
}

/** Quantas visitas formam o ticket "de agora" contra o "de antes". */
const VISITAS_DO_TICKET = 3;

/**
 * O risco de cada cliente da barbearia, com os motivos.
 *
 * `agora` entra por parâmetro pela razão de sempre: quem está em risco é uma
 * função do relógio, e ler `now()` no banco tornaria o resultado impossível de
 * testar sem esperar o tempo passar.
 */
export async function churnDaBase(
  tenantId: string,
  agora: Date = new Date(),
  tx?: TransactionClient,
): Promise<readonly ClienteEmRiscoDeChurn[]> {
  const dentro = async (t: TransactionClient) => {
    const ritmos = await segmentosDaBase(tenantId, agora, t);

    /**
     * Os seis sinais restantes, numa consulta.
     *
     * O barbeiro habitual é o que mais atendeu esta pessoa — `mode()`, e não o
     * do último atendimento: quem foi atendido nove vezes por João e uma por
     * Ruan tem João como barbeiro de sempre, mesmo que a última tenha sido com
     * Ruan. É a diferença entre um sinal e uma coincidência.
     */
    const linhas = await t.$queryRaw<LinhaDeSinais[]>`
      WITH visitas AS (
        SELECT a.customer_id, a.professional_id, a.price_cents, a.service_starts_at,
               row_number() OVER (
                 PARTITION BY a.customer_id ORDER BY a.service_starts_at DESC
               ) AS recencia
          FROM appointments a
         WHERE a.status = 'completed' AND a.customer_id IS NOT NULL
      )
      SELECT c.id AS customer_id, c.name,
             (SELECT r.rating FROM reviews r
               WHERE r.customer_id = c.id
               ORDER BY r.created_at DESC LIMIT 1) AS ultima_nota,
             EXISTS (
               SELECT 1 FROM appointments f
                WHERE f.customer_id = c.id
                  AND f.service_starts_at > ${agora}::timestamptz
                  AND f.status IN ('pending', 'confirmed')
             ) AS tem_futuro,
             -- O último horário marcado que já passou não aconteceu.
             EXISTS (
               SELECT 1 FROM appointments u
                WHERE u.customer_id = c.id
                  AND u.service_starts_at <= ${agora}::timestamptz
                  AND u.status IN ('no_show', 'cancelled_customer')
                  AND u.service_starts_at = (
                    SELECT max(v.service_starts_at) FROM appointments v
                     WHERE v.customer_id = c.id
                       AND v.service_starts_at <= ${agora}::timestamptz
                       AND v.status <> 'cancelled_business'
                  )
             ) AS cancelou,
             EXISTS (
               SELECT 1 FROM club_subscriptions s
                WHERE s.customer_id = c.id AND s.status IN ('ativa', 'inadimplente')
             ) AS assinatura_ativa,
             EXISTS (
               SELECT 1 FROM club_subscriptions s
                WHERE s.customer_id = c.id AND s.status = 'cancelada'
             ) AND NOT EXISTS (
               SELECT 1 FROM club_subscriptions s
                WHERE s.customer_id = c.id AND s.status IN ('ativa', 'inadimplente', 'pendente')
             ) AS assinatura_vencida,
             hab.nome AS barbeiro_nome,
             (hab.nome IS NOT NULL AND hab.ativo IS NOT TRUE) AS barbeiro_saiu,
             (SELECT avg(v.price_cents)::int FROM visitas v
               WHERE v.customer_id = c.id AND v.recencia <= ${VISITAS_DO_TICKET}) AS ticket_recente,
             (SELECT avg(v.price_cents)::int FROM visitas v
               WHERE v.customer_id = c.id AND v.recencia > ${VISITAS_DO_TICKET}) AS ticket_anterior
        FROM customers c
        LEFT JOIN LATERAL (
          SELECT p.name AS nome, p.active AS ativo
            FROM visitas v
            JOIN professionals p ON p.id = v.professional_id
           WHERE v.customer_id = c.id
           GROUP BY p.id, p.name, p.active
           ORDER BY count(*) DESC, p.name
           LIMIT 1
        ) hab ON true
       WHERE c.anonymized_at IS NULL
    `;

    const porId = new Map(ritmos.map((r) => [r.customerId, r]));

    return linhas
      .map((l) => {
        const ritmo = porId.get(l.customer_id);
        const sinais: SinaisDeChurn = {
          ritmo: ritmo?.ciclo
            ? { medianaDias: ritmo.ciclo.medianaDias, folgaDias: ritmo.ciclo.folgaDias }
            : null,
          diasSemVir: ritmo?.diasSemVir ?? null,
          ultimaNota: l.ultima_nota,
          temAgendamentoFuturo: l.tem_futuro,
          barbeiroHabitualSaiu: l.barbeiro_saiu,
          nomeDoBarbeiroHabitual: l.barbeiro_nome,
          cancelouRecentemente: l.cancelou,
          assinaturaVencida: l.assinatura_vencida,
          assinaturaAtiva: l.assinatura_ativa,
          ticketRecenteCents: l.ticket_recente,
          ticketAnteriorCents: l.ticket_anterior,
        };
        const calculado = riscoDeChurn(sinais);
        return {
          customerId: l.customer_id,
          nome: l.name,
          risco: calculado.risco,
          faixa: faixaDeChurn(calculado.risco),
          motivos: calculado.motivos,
          temBase: calculado.temBase,
          cicloDias: ritmo?.ciclo?.medianaDias ?? null,
          diasSemVir: ritmo?.diasSemVir ?? null,
        };
      })
      /**
       * Quem não tem base sai da lista, em vez de entrar com risco zero.
       *
       * "Risco 0" sobre quem veio uma vez é uma afirmação que o produto não tem
       * como fazer, e numa lista ordenada por risco ele desce para o fim como se
       * fosse boa notícia — o dono lê a lista inteira e conclui que a base está
       * saudável, quando metade dela é gente sobre a qual não se sabe nada.
       */
      .filter((c) => c.temBase)
      .map(({ temBase: _temBase, ...resto }) => resto)
      .sort((a, b) => b.risco - a.risco || a.nome.localeCompare(b.nome, 'pt-BR'));
  };

  return tx ? dentro(tx) : withTenant(tenantId, dentro);
}

/** O risco de uma pessoa. Ver o cabeçalho: o ritmo depende da base inteira. */
export async function churnDe(
  tenantId: string,
  customerId: string,
  agora: Date = new Date(),
  tx?: TransactionClient,
): Promise<ClienteEmRiscoDeChurn | null> {
  const todos = await churnDaBase(tenantId, agora, tx);
  return todos.find((c) => c.customerId === customerId) ?? null;
}
