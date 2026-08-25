import { createHash } from 'node:crypto';
import type { TransactionClient } from '@barbearia/db';
import type { MotivoDoSinal } from '@barbearia/core';
import {
  BookingError,
  type AppointmentRef,
  type AppointmentSource,
  type CreateAppointmentRequest,
} from './booking-contratos.js';

export function scopedIdempotencyKey(
  tenantId: string,
  customerId: string | undefined,
  raw: string,
): string {
  return createHash('sha256')
    .update(`${tenantId}\u0000${customerId ?? ''}\u0000${raw}`)
    .digest('hex');
}

function fingerprintDaIntencao(entrada: {
  readonly locationId: string;
  readonly professionalId: string;
  readonly serviceIds: readonly string[];
  readonly date: string;
  readonly start: string;
  readonly customerId: string | null;
  readonly source: AppointmentSource;
  readonly notes: string | null;
}): string {
  return createHash('sha256')
    .update(JSON.stringify({
      locationId: entrada.locationId,
      professionalId: entrada.professionalId,
      serviceIds: [...entrada.serviceIds],
      date: entrada.date,
      start: entrada.start,
      customerId: entrada.customerId,
      source: entrada.source,
      notes: entrada.notes,
    }))
    .digest('hex');
}

export function bookingIntentFingerprint(request: CreateAppointmentRequest): string {
  return fingerprintDaIntencao({
    locationId: request.locationId,
    professionalId: request.professionalId,
    serviceIds: request.serviceIds,
    date: request.date,
    start: request.start,
    customerId: request.customerId ?? null,
    source: request.source ?? 'website',
    notes: request.notes ?? null,
  });
}

export async function findByIdempotencyKey(
  tx: TransactionClient,
  key: string,
  expectedFingerprint: string,
): Promise<AppointmentRef | null> {
  const rows = await tx.$queryRaw<
    {
      id: string;
      starts_at: Date;
      ends_at: Date;
      service_starts_at: Date;
      service_ends_at: Date;
      location_id: string;
      customer_id: string | null;
      professional_id: string;
      status: string;
      source: AppointmentSource;
      notes: string | null;
      local_date: string;
      local_start: string;
      service_ids: string[];
      price_cents: number;
      deposit_required_cents: number;
      deposit_reason: string | null;
      idempotency_fingerprint: string | null;
    }[]
  >`
    SELECT a.id, a.starts_at, a.ends_at, a.service_starts_at, a.service_ends_at,
           a.location_id, a.customer_id, a.professional_id, a.status,
           a.source, a.notes, a.price_cents, a.deposit_required_cents,
           a.deposit_reason, a.idempotency_fingerprint,
           to_char(a.service_starts_at AT TIME ZONE l.timezone, 'YYYY-MM-DD') AS local_date,
           to_char(a.service_starts_at AT TIME ZONE l.timezone, 'HH24:MI') AS local_start,
           COALESCE((
             SELECT array_agg(s.service_id::text ORDER BY s.position)
               FROM appointment_services s
              WHERE s.appointment_id = a.id
           ), ARRAY[]::text[]) AS service_ids
      FROM appointments a
      JOIN locations l ON l.id = a.location_id
     WHERE a.idempotency_key = ${key}
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;

  // Linhas criadas antes da migração 0110 não têm fingerprint persistido.
  // Reconstruir da própria linha preserva retry legítimo sem tratar NULL como
  // autorização para reaproveitar a chave com outra intenção.
  const gravado = row.idempotency_fingerprint ?? fingerprintDaIntencao({
    locationId: row.location_id,
    professionalId: row.professional_id,
    serviceIds: row.service_ids,
    date: row.local_date,
    start: row.local_start,
    customerId: row.customer_id,
    source: row.source,
    notes: row.notes,
  });
  if (gravado !== expectedFingerprint) {
    throw new BookingError(
      'idempotencia_conflitante',
      'Esta chave de idempotência já foi usada para outro agendamento.',
    );
  }

  return {
    id: row.id,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    serviceStartsAt: row.service_starts_at.toISOString(),
    serviceEndsAt: row.service_ends_at.toISOString(),
    professionalId: row.professional_id,
    status: row.status,
    priceCents: row.price_cents,
    depositRequiredCents: row.deposit_required_cents,
    depositReason: (row.deposit_reason as MotivoDoSinal | null) ?? null,
    deduplicated: true,
  };
}
