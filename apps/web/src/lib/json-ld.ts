import type { PublicProfile } from './api';

/**
 * Dados estruturados para o Google.
 *
 * É o que faz o resultado de busca mostrar horário, preço e "Aberto agora" em
 * vez de só um link azul. Para negócio local vale mais que qualquer meta tag.
 */
export function jsonLd(profile: PublicProfile): Record<string, unknown> {
  const { location } = profile;

  const openingHours = profile.hours
    .filter((day) => day.opensAt && day.closesAt)
    .map((day) => ({
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: [
        'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
      ][day.weekday],
      opens: day.opensAt,
      closes: day.closesAt,
    }));

  const services = profile.categories.flatMap((categoria) =>
    categoria.services.map((servico) => ({
      '@type': 'Offer',
      itemOffered: {
        '@type': 'Service',
        name: servico.name,
        ...(servico.description ? { description: servico.description } : {}),
      },
      price: (servico.priceCents / 100).toFixed(2),
      priceCurrency: 'BRL',
    })),
  );

  return {
    '@context': 'https://schema.org',
    '@type': 'HairSalon',
    name: profile.name,
    ...(location.about ? { description: location.about } : {}),
    ...(location.coverUrl ? { image: location.coverUrl } : {}),
    ...(location.phone ? { telephone: location.phone } : {}),
    ...(profile.instagram ? { sameAs: [`https://instagram.com/${profile.instagram}`] } : {}),
    address: {
      '@type': 'PostalAddress',
      ...(location.street ? { streetAddress: location.street } : {}),
      ...(location.district ? { addressLocality: location.district } : {}),
      ...(location.city ? { addressRegion: location.city } : {}),
      ...(location.postalCode ? { postalCode: location.postalCode } : {}),
      addressCountry: 'BR',
    },
    ...(location.latitude !== null && location.longitude !== null
      ? {
          geo: {
            '@type': 'GeoCoordinates',
            latitude: location.latitude,
            longitude: location.longitude,
          },
        }
      : {}),
    openingHoursSpecification: openingHours,
    ...(services.length > 0
      ? { hasOfferCatalog: { '@type': 'OfferCatalog', name: 'Serviços', itemListElement: services } }
      : {}),
    ...(profile.priceFromCents !== null ? { priceRange: `R$ ${(profile.priceFromCents / 100).toFixed(0)}+` } : {}),
  };
}
