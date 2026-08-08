import type { PublicProfile } from './api';

/**
 * Serializa o JSON-LD para dentro de `<script>`.
 *
 * `JSON.stringify` escapa aspas e barra invertida, mas **não** escapa `<`. Um
 * nome de serviço contendo `</script><script>…` fecharia o bloco e abriria
 * outro, na origem verdadeira da plataforma.
 *
 * Enquanto o catálogo só entrava por SQL isso era teórico. Com o cadastro aberto
 * do bloco 10, qualquer um cria uma barbearia e escreve nesses campos pela API —
 * então o escape virou obrigatório, não zelo.
 *
 * `\u003c` é JSON válido e o mesmo caractere para qualquer leitor; só deixa de
 * ser HTML.
 */
export function jsonLdScript(data: Record<string, unknown>): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    // U+2028 e U+2029 quebram literal de string em JavaScript antigo, e o bloco
    // é lido como script.
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

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
