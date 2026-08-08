import { withTenant } from '@barbearia/db';
import { instantToLocal, weekdayIn, type WeeklyPlan } from '@barbearia/core';

/**
 * Perfil público da barbearia — tudo que a página mostra sem autenticação.
 *
 * Resolve os defeitos D8 e D9: o sistema analisado não expõe endereço, mapa,
 * telefone, horário de funcionamento nem descrição de serviço. Metade das
 * visitas de uma página de barbearia é gente perguntando "onde fica?" e "está
 * aberto?".
 */

export interface PublicService {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly photoUrl: string | null;
  readonly priceCents: number;
  readonly durationMinutes: number;
  readonly professionalIds: readonly string[];
}

export interface PublicCategory {
  readonly id: string | null;
  readonly name: string;
  readonly services: readonly PublicService[];
}

export interface PublicProfessional {
  readonly id: string;
  readonly name: string;
  readonly bio: string | null;
  readonly photoUrl: string | null;
}

export interface OpeningDay {
  readonly weekday: number;
  readonly opensAt: string | null;
  readonly closesAt: string | null;
}

export interface PublicProfile {
  readonly slug: string;
  readonly name: string;
  readonly logoUrl: string | null;
  readonly instagram: string | null;
  readonly location: {
    readonly id: string;
    readonly name: string;
    readonly timezone: string;
    readonly street: string | null;
    readonly district: string | null;
    readonly city: string | null;
    readonly state: string | null;
    readonly postalCode: string | null;
    readonly latitude: number | null;
    readonly longitude: number | null;
    readonly phone: string | null;
    readonly whatsapp: string | null;
    readonly coverUrl: string | null;
    readonly about: string | null;
    readonly amenities: readonly string[];
    readonly cancellationPolicy: string | null;
    /**
     * As horas que a página deve escrever, vindas da coluna que a API aplica.
     *
     * Antes o prazo só existia no texto livre de `cancellationPolicy`, e nada
     * o cumpria. Expor o número é o que impede a página de prometer duas horas
     * enquanto o servidor aceita cancelamento a qualquer momento.
     */
    readonly cancelMinHours: number;
  };
  readonly categories: readonly PublicCategory[];
  readonly professionals: readonly PublicProfessional[];
  readonly hours: readonly OpeningDay[];
  readonly open: {
    readonly isOpen: boolean;
    /** "fecha 18:00" ou "abre terça, 09:00" — pronto para exibir. */
    readonly detail: string;
  };
  readonly priceFromCents: number | null;
}

const WEEKDAY_NAME = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

function minutesToHHMM(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * Horário de funcionamento derivado da jornada dos profissionais.
 *
 * Deliberadamente derivado, não cadastrado à parte: duas fontes para o mesmo
 * fato divergem, e a que importa para o cliente é quando existe alguém para
 * atender — não quando a porta está destrancada.
 */
function openingHours(plans: readonly WeeklyPlan[]): OpeningDay[] {
  const byWeekday = new Map<number, { start: number; end: number }>();

  for (const plan of plans) {
    const current = byWeekday.get(plan.weekday);
    byWeekday.set(plan.weekday, {
      start: current ? Math.min(current.start, plan.start) : plan.start,
      end: current ? Math.max(current.end, plan.end) : plan.end,
    });
  }

  return Array.from({ length: 7 }, (_, weekday) => {
    const hours = byWeekday.get(weekday);
    return {
      weekday,
      opensAt: hours ? minutesToHHMM(hours.start) : null,
      closesAt: hours ? minutesToHHMM(hours.end) : null,
    };
  });
}

/** "Aberto · fecha 18:00" é a informação que a metade não-agendante veio buscar. */
function openState(
  hours: readonly OpeningDay[],
  timezone: string,
  now: Date,
): { isOpen: boolean; detail: string } {
  const local = instantToLocal(timezone, now);
  const weekday = weekdayIn(timezone, local.date);
  const today = hours[weekday];

  if (today?.opensAt && today.closesAt) {
    const opens = Number(today.opensAt.slice(0, 2)) * 60 + Number(today.opensAt.slice(3));
    const closes = Number(today.closesAt.slice(0, 2)) * 60 + Number(today.closesAt.slice(3));

    if (local.minutes >= opens && local.minutes < closes) {
      return { isOpen: true, detail: `fecha ${today.closesAt}` };
    }
    if (local.minutes < opens) {
      return { isOpen: false, detail: `abre hoje, ${today.opensAt}` };
    }
  }

  for (let ahead = 1; ahead <= 7; ahead++) {
    const next = hours[(weekday + ahead) % 7];
    if (next?.opensAt) {
      const label = ahead === 1 ? 'amanhã' : WEEKDAY_NAME[next.weekday];
      return { isOpen: false, detail: `abre ${label}, ${next.opensAt}` };
    }
  }

  return { isOpen: false, detail: 'horários não configurados' };
}

export async function getPublicProfile(
  tenantId: string,
  slug: string,
  now: Date = new Date(),
): Promise<PublicProfile | null> {
  return withTenant(tenantId, async (tx) => {
    const tenants = await tx.$queryRaw<{ name: string; logo_url: string | null; instagram: string | null }[]>`
      SELECT name, logo_url, instagram FROM tenants WHERE id = ${tenantId}::uuid
    `;
    const tenant = tenants[0];
    if (!tenant) return null;

    // A unidade primária é a mais antiga; multiunidade entra no bloco 55.
    const locations = await tx.$queryRaw<
      {
        id: string; name: string; timezone: string;
        street: string | null; district: string | null; city: string | null;
        state: string | null; postal_code: string | null;
        latitude: string | null; longitude: string | null;
        phone_e164: string | null; whatsapp_e164: string | null;
        cover_url: string | null; about: string | null;
        amenities: string[]; cancellation_policy: string | null;
        cancel_min_hours: number;
      }[]
    >`
      SELECT id, name, timezone, street, district, city, state, postal_code,
             latitude, longitude, phone_e164, whatsapp_e164, cover_url, about,
             amenities, cancellation_policy, cancel_min_hours
      FROM locations ORDER BY created_at LIMIT 1
    `;
    const location = locations[0];
    if (!location) return null;

    const professionalRows = await tx.$queryRaw<
      { id: string; name: string; bio: string | null; photo_url: string | null }[]
    >`
      SELECT id, name, bio, photo_url FROM professionals
      WHERE location_id = ${location.id}::uuid
        AND active AND bookable_online AND kind IN ('professional', 'external')
      ORDER BY name
    `;

    const serviceRows = await tx.$queryRaw<
      {
        id: string; name: string; description: string | null; photo_url: string | null;
        price_cents: number; duration_minutes: number;
        category_id: string | null; category_name: string | null; category_position: number | null;
        professional_ids: string[];
      }[]
    >`
      SELECT s.id, s.name, s.description, s.photo_url, s.price_cents, s.duration_minutes,
             c.id AS category_id, c.name AS category_name, c.position AS category_position,
             array_agg(ps.professional_id::text) AS professional_ids
      FROM services s
      LEFT JOIN service_categories c ON c.id = s.category_id
      JOIN professional_services ps ON ps.service_id = s.id
      JOIN professionals p ON p.id = ps.professional_id
      WHERE s.active AND s.bookable_online
        AND p.active AND p.bookable_online AND p.kind IN ('professional', 'external')
        AND p.location_id = ${location.id}::uuid
      GROUP BY s.id, c.id
      ORDER BY c.position NULLS LAST, c.name NULLS LAST, s.price_cents
    `;

    const scheduleRows = await tx.$queryRaw<
      { weekday: number; start_minute: number; end_minute: number }[]
    >`
      SELECT w.weekday, w.start_minute, w.end_minute
      FROM work_schedules w
      JOIN professionals p ON p.id = w.professional_id
      WHERE p.location_id = ${location.id}::uuid
        AND p.active AND p.bookable_online AND p.kind IN ('professional', 'external')
    `;

    const categories = new Map<string, PublicCategory & { services: PublicService[] }>();
    for (const row of serviceRows) {
      const key = row.category_id ?? 'outros';
      const bucket = categories.get(key) ?? {
        id: row.category_id,
        name: row.category_name ?? 'Outros serviços',
        services: [],
      };
      bucket.services.push({
        id: row.id,
        name: row.name,
        description: row.description,
        photoUrl: row.photo_url,
        priceCents: row.price_cents,
        durationMinutes: row.duration_minutes,
        professionalIds: row.professional_ids,
      });
      categories.set(key, bucket);
    }

    const hours = openingHours(
      scheduleRows.map((row) => ({
        weekday: row.weekday,
        start: row.start_minute,
        end: row.end_minute,
      })),
    );

    const prices = serviceRows.map((row) => row.price_cents);

    return {
      slug,
      name: tenant.name,
      logoUrl: tenant.logo_url,
      instagram: tenant.instagram,
      location: {
        id: location.id,
        name: location.name,
        timezone: location.timezone,
        street: location.street,
        district: location.district,
        city: location.city,
        state: location.state,
        postalCode: location.postal_code,
        latitude: location.latitude === null ? null : Number(location.latitude),
        longitude: location.longitude === null ? null : Number(location.longitude),
        phone: location.phone_e164,
        whatsapp: location.whatsapp_e164,
        coverUrl: location.cover_url,
        about: location.about,
        amenities: location.amenities,
        cancellationPolicy: location.cancellation_policy,
        cancelMinHours: location.cancel_min_hours,
      },
      categories: [...categories.values()],
      professionals: professionalRows.map((row) => ({
        id: row.id,
        name: row.name,
        bio: row.bio,
        photoUrl: row.photo_url,
      })),
      hours,
      open: openState(hours, location.timezone, now),
      priceFromCents: prices.length > 0 ? Math.min(...prices) : null,
    };
  });
}
