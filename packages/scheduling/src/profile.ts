import { withTenant } from '@barbearia/db';
import {
  instantToLocal,
  weekdayIn,
  type SellableBundle,
  type WeeklyPlan,
} from '@barbearia/core';

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
  /**
   * O endereço da página dele, quando ela existe (bloco 73, SPEC §5.2).
   *
   * Nulo é "não tem página" — o padrão, porque expor uma pessoa numa página
   * indexada é decisão dela. Sai daqui e não de uma consulta separada porque a
   * lista de profissionais já é lida inteira: uma segunda ida ao banco por
   * causa de uma coluna é latência que a meta de LCP paga.
   */
  readonly perfilPublico: string | null;
  /**
   * Os dias da semana em que ele atende (bloco 66).
   *
   * Sai daqui porque a pergunta *"João trabalha sexta?"* é uma das quatro que a
   * SPEC §4.17 lista, e o dado sempre esteve em `work_schedules` — o que faltava
   * era o perfil público expô-lo. Sem isso a recepção digital registraria como
   * lacuna uma pergunta que a barbearia **já respondeu** ao cadastrar a jornada.
   */
  readonly weekdays: readonly number[];
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
  /**
   * O encarregado de dados, público de propósito (bloco 31).
   *
   * A LGPD art. 41 §1 manda divulgar publicamente a identidade e o contato do
   * encarregado — não é dado interno que vaza, é obrigação de quem controla
   * dado pessoal. Sem isso o titular que quer exercer um direito não tem para
   * quem escrever, e o pedido cai no suporte da plataforma, que é **operadora**
   * e não tem competência para responder por dado que não é dela.
   */
  readonly encarregado: { readonly nome: string; readonly email: string | null } | null;
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
  /**
   * Combos vendáveis: o item do cardápio e os serviços que ele substitui.
   *
   * Vai no perfil porque quem compara é a tela de escolha, e ela já carrega o
   * cardápio inteiro — buscar à parte seria uma segunda ida ao servidor a cada
   * serviço marcado.
   */
  readonly bundles: readonly SellableBundle[];
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
    const tenants = await tx.$queryRaw<
      {
        name: string; logo_url: string | null; instagram: string | null;
        dpo_name: string | null; dpo_email: string | null;
      }[]
    >`
      SELECT name, logo_url, instagram, dpo_name, dpo_email
        FROM tenants WHERE id = ${tenantId}::uuid
    `;
    const tenant = tenants[0];
    if (!tenant) return null;

    // A unidade primária é a mais antiga; multiunidade entra no bloco 58.
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
      {
        id: string; name: string; bio: string | null; photo_url: string | null;
        public_slug: string | null;
      }[]
    >`
      SELECT id, name, bio, photo_url,
             CASE WHEN public_profile THEN public_slug END AS public_slug
        FROM professionals
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
      { professional_id: string; weekday: number; start_minute: number; end_minute: number }[]
    >`
      SELECT w.professional_id::text AS professional_id, w.weekday, w.start_minute, w.end_minute
      FROM work_schedules w
      JOIN professionals p ON p.id = w.professional_id
      WHERE p.location_id = ${location.id}::uuid
        AND p.active AND p.bookable_online AND p.kind IN ('professional', 'external')
    `;

    // Combos vendáveis da unidade. Uma consulta só, com os componentes
    // agregados: buscar os componentes por combo seria N+1 no cardápio.
    const bundleRows = await tx.$queryRaw<
      { service_id: string; name: string; price_cents: number; component_ids: string[] }[]
    >`
      SELECT c.sold_as_service_id::text AS service_id,
             s.name, s.price_cents,
             array_agg(cc.service_id::text) AS component_ids
      FROM service_combos c
      JOIN services s ON s.id = c.sold_as_service_id
      JOIN service_combo_components cc ON cc.combo_id = c.id
      WHERE c.sold_as_service_id IS NOT NULL
        AND s.active AND s.bookable_online
      GROUP BY c.id, s.name, s.price_cents
    `;

    const bundles: SellableBundle[] = bundleRows.map((row) => ({
      serviceId: row.service_id,
      name: row.name,
      priceCents: row.price_cents,
      componentIds: row.component_ids,
    }));

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
      // Sem nome não há encarregado: e-mail solto não diz a quem se escreve, e
      // a lei pede identidade **e** contato.
      encarregado: tenant.dpo_name
        ? { nome: tenant.dpo_name, email: tenant.dpo_email }
        : null,
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
      bundles,
      professionals: professionalRows.map((row) => ({
        id: row.id,
        name: row.name,
        bio: row.bio,
        photoUrl: row.photo_url,
        perfilPublico: row.public_slug,
        // Ordenados e sem repetição: a jornada pode ter mais de um intervalo no
        // mesmo dia, e "atende terça, terça e sexta" é a frase que ninguém quer.
        weekdays: [
          ...new Set(
            scheduleRows.filter((s) => s.professional_id === row.id).map((s) => s.weekday),
          ),
        ].sort((a, b) => a - b),
      })),
      hours,
      open: openState(hours, location.timezone, now),
      priceFromCents: prices.length > 0 ? Math.min(...prices) : null,
    };
  });
}
