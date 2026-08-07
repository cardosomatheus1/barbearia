/**
 * Cliente da API pública.
 *
 * Roda no servidor durante o SSR: o HTML já sai com nome, serviços, preços,
 * endereço e horários dentro. O sistema analisado entrega uma casca vazia com
 * `<title>Agende online</title>`, então nenhum buscador indexa nada (defeito D6).
 */

const BASE = process.env['API_URL'] ?? 'http://127.0.0.1:3000';

export interface PublicService {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  durationMinutes: number;
  professionalIds: string[];
}

export interface PublicProfile {
  slug: string;
  name: string;
  logoUrl: string | null;
  instagram: string | null;
  location: {
    id: string; name: string; timezone: string;
    street: string | null; district: string | null; city: string | null;
    state: string | null; postalCode: string | null;
    latitude: number | null; longitude: number | null;
    phone: string | null; whatsapp: string | null;
    coverUrl: string | null; about: string | null;
    amenities: string[]; cancellationPolicy: string | null;
  };
  categories: { id: string | null; name: string; services: PublicService[] }[];
  professionals: { id: string; name: string; bio: string | null; photoUrl: string | null }[];
  hours: { weekday: number; opensAt: string | null; closesAt: string | null }[];
  open: { isOpen: boolean; detail: string };
  priceFromCents: number | null;
}

export interface DayAvailability {
  date: string;
  slots: {
    start: string;
    end: string;
    startsAt: string;
    professionalId: string;
    priceCents: number | null;
  }[];
  unavailableReason: string | null;
  waitlistAvailable: boolean;
}

async function get<T>(path: string, revalidate: number): Promise<T | null> {
  const response = await fetch(`${BASE}${path}`, { next: { revalidate } });
  if (!response.ok) return null;
  return (await response.json()) as T;
}

/**
 * Perfil da barbearia.
 *
 * Mesmo TTL da disponibilidade de propósito: o estado "Aberto/Fechado" sai
 * daqui e os horários saem de lá. Com TTLs diferentes, a página chega a dizer
 * "Fechado" enquanto lista horários livres para hoje.
 */
export const getProfile = (slug: string) => get<PublicProfile>(`/v1/b/${slug}`, 30);

/**
 * Disponibilidade de hoje.
 *
 * Cache de 30 s: é o herói da página e precisa estar quase ao vivo, mas
 * renderizar do zero a cada visita desperdiça o trabalho num link de bio que
 * recebe rajadas.
 */
export async function getToday(
  slug: string,
  locationId: string,
  serviceId: string,
  date: string,
): Promise<DayAvailability | null> {
  // `anyProfessional` colapsa em um cartão por horário. Sem isso a faixa mostra
  // "20:20 Ruan" e "20:20 Gleidson" lado a lado, gastando o espaço mais valioso
  // da página para repetir a mesma informação.
  const query = new URLSearchParams({
    locationId,
    serviceIds: serviceId,
    dateFrom: date,
    anyProfessional: 'true',
  });
  const result = await get<{ days: DayAvailability[] }>(
    `/v1/b/${slug}/availability?${query.toString()}`,
    30,
  );
  return result?.days[0] ?? null;
}
