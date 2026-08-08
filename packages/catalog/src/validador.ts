import { withTenant } from '@barbearia/db';
import {
  validarCatalogo,
  resumoDosAchados,
  type Achado,
  type Catalogo,
  type Severidade,
} from '@barbearia/core';

/**
 * O retrato do catálogo que o validador da SPEC §5.7 examina.
 *
 * A regra é toda de `packages/core` e tem teste puro. Aqui só se lê o banco — e
 * **em três consultas**, uma por família de pergunta. Uma consulta por serviço
 * para descobrir quem o executa e quanto ele leva de fato seria N+1 numa tela
 * que o dono abre justamente quando o cardápio está grande.
 */

export interface Diagnostico {
  readonly achados: readonly Achado[];
  readonly resumo: Record<Severidade, number>;
  /** Quantos serviços ativos foram examinados. Zero explica lista vazia. */
  readonly examinados: number;
}

/**
 * Janela da medição de duração real.
 *
 * Noventa dias, como em `duracoesReais` da fila e pelo mesmo motivo: o barbeiro
 * que ficou mais rápido este ano não deve ser julgado pelo ano passado, e a
 * média de três anos leva um tempo para reagir a qualquer mudança.
 */
const JANELA_DIAS = 90;

export async function diagnosticarCatalogo(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly agora?: Date;
}): Promise<Diagnostico> {
  const agora = params.agora ?? new Date();
  const desde = new Date(agora.getTime() - JANELA_DIAS * 24 * 60 * 60 * 1000);

  return withTenant(params.tenantId, async (tx) => {
    const servicos = await tx.$queryRaw<
      {
        id: string;
        name: string;
        category_name: string | null;
        price_cents: number;
        duration_minutes: number;
        buffer_before_minutes: number;
        buffer_after_minutes: number;
        description: string | null;
        photo_url: string | null;
        active: boolean;
        bookable_online: boolean;
        profissionais: bigint;
        duracao_real: number | null;
        amostras: bigint;
      }[]
    >`
      SELECT s.id, s.name, c.name AS category_name, s.price_cents, s.duration_minutes,
             s.buffer_before_minutes, s.buffer_after_minutes, s.description, s.photo_url,
             s.active, s.bookable_online,
             -- Quem de fato executa: profissional ativo e sem vínculo explícito
             -- conta como "faz tudo", que é a convenção do cadastro desde o
             -- bloco 13. Contar só o vínculo explícito acusaria de órfão todo
             -- serviço numa barbearia que nunca restringiu ninguém.
             (SELECT count(*) FROM professionals p
               WHERE p.active AND p.kind = 'professional'
                 AND p.location_id = ${params.locationId}::uuid
                 AND (
                   NOT EXISTS (SELECT 1 FROM professional_services ps
                                WHERE ps.professional_id = p.id)
                   OR EXISTS (SELECT 1 FROM professional_services ps
                               WHERE ps.professional_id = p.id AND ps.service_id = s.id)
                 ))::bigint AS profissionais,
             m.mediana AS duracao_real,
             coalesce(m.amostras, 0)::bigint AS amostras
        FROM services s
        LEFT JOIN service_categories c ON c.id = s.category_id
        LEFT JOIN (
          -- A mediana, não a média: um atendimento que parou pelo telefone
          -- puxa a média e não move a mediana, e é a mediana que a SPEC pede.
          SELECT aps.service_id,
                 percentile_cont(0.5) WITHIN GROUP (
                   ORDER BY EXTRACT(EPOCH FROM (a.completed_at - a.started_at)) / 60
                 ) AS mediana,
                 count(*) AS amostras
            FROM appointments a
            JOIN appointment_services aps ON aps.appointment_id = a.id
           WHERE a.status = 'completed'
             AND a.started_at IS NOT NULL
             AND a.completed_at >= ${desde}
             -- Um serviço por atendimento: com dois, o tempo medido é o dos
             -- dois juntos e a mediana do corte viraria a do corte com barba.
             AND (SELECT count(*) FROM appointment_services outro
                   WHERE outro.appointment_id = a.id) = 1
           GROUP BY aps.service_id
        ) m ON m.service_id = s.id
       ORDER BY s.name
    `;

    const combos = await tx.$queryRaw<
      {
        id: string;
        name: string;
        declared_duration_minutes: number;
        tolerance_minutes: number;
        price_cents: number | null;
        componentes: { durationMinutes: number; priceCents: number }[] | null;
      }[]
    >`
      SELECT sc.id, sc.name, sc.declared_duration_minutes, sc.tolerance_minutes,
             (SELECT s.price_cents FROM services s WHERE s.name = sc.name LIMIT 1) AS price_cents,
             (SELECT json_agg(json_build_object(
                       'durationMinutes', parte.duration_minutes,
                       'priceCents', parte.price_cents))
                FROM service_combo_components scc
                JOIN services parte ON parte.id = scc.service_id
               WHERE scc.combo_id = sc.id) AS componentes
        FROM service_combos sc
       ORDER BY sc.name
    `;

    const profissionais = await tx.$queryRaw<
      { id: string; name: string; kind: string; minutos: number[] | null }[]
    >`
      SELECT p.id, p.name, p.kind::text AS kind,
             (SELECT array_agg(ws.end_minute - ws.start_minute)
                FROM work_schedules ws WHERE ws.professional_id = p.id) AS minutos
        FROM professionals p
       WHERE p.active AND p.location_id = ${params.locationId}::uuid
       ORDER BY p.name
    `;

    const retrato: Catalogo = {
      servicos: servicos.map((linha) => ({
        id: linha.id,
        name: linha.name,
        categoryName: linha.category_name,
        priceCents: linha.price_cents,
        durationMinutes: linha.duration_minutes,
        bufferBeforeMinutes: linha.buffer_before_minutes,
        bufferAfterMinutes: linha.buffer_after_minutes,
        description: linha.description,
        photoUrl: linha.photo_url,
        active: linha.active,
        bookableOnline: linha.bookable_online,
        profissionais: Number(linha.profissionais),
        duracaoRealMediana:
          linha.duracao_real === null ? null : Math.round(Number(linha.duracao_real)),
        amostras: Number(linha.amostras),
      })),
      combos: combos.map((linha) => ({
        id: linha.id,
        name: linha.name,
        priceCents: linha.price_cents ?? 0,
        durationMinutes: linha.declared_duration_minutes,
        toleranciaMinutes: linha.tolerance_minutes,
        componentes: linha.componentes ?? [],
      })),
      profissionais: profissionais.map((linha) => ({
        id: linha.id,
        name: linha.name,
        kind: linha.kind,
        minutosPorDia: linha.minutos ?? [],
      })),
    };

    const achados = validarCatalogo(retrato);
    return {
      achados,
      resumo: resumoDosAchados(achados),
      examinados: retrato.servicos.filter((servico) => servico.active).length,
    };
  });
}
