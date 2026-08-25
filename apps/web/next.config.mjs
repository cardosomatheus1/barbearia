/**
 * Os cabeçalhos fixos, com o porquê de cada um.
 *
 * A CSP **não** está aqui: ela leva nonce por requisição e mora em
 * `src/middleware.ts`. Estes são os que não mudam, e ficam neste arquivo porque
 * daqui eles valem também para `_next/static`, que o matcher do middleware
 * deixa de fora de propósito.
 */
const CABECALHOS = [
  /** Sem adivinhação de tipo: um `.js` servido como texto para de virar script. */
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  /**
   * Ninguém põe este produto num quadro.
   *
   * Vale para a página pública também. Não existe widget para incorporar em
   * site de barbearia — se um dia existir, ele é uma rota com política própria,
   * não a ausência desta.
   */
  { key: 'X-Frame-Options', value: 'DENY' },
  /**
   * Um ano, com subdomínios, e sem condição de ambiente: o navegador ignora
   * este cabeçalho fora de TLS (RFC 6797 §8.1), então ele não atrapalha o
   * `http://` de desenvolvimento e não depende de uma variável estar certa no
   * dia do deploy. É o primeiro acesso que ele cobre — justamente o que o
   * `secure` do cookie ainda não protege.
   */
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  /**
   * Nada de câmera, microfone, localização ou pagamento.
   *
   * O produto não pede nenhum dos três hoje. Declarar isso é o que impede um
   * `<iframe>` de terceiro — se um dia entrar — de pedir por baixo.
   */
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), interest-cohort=()',
  },
];

/**
 * O painel não vaza URL nenhuma; a página pública manda só a origem.
 *
 * Toda URL de `/admin` e de `/plataforma` carrega id de cliente, de comanda ou
 * de barbearia — é a mesma razão pela qual o código de recusa por score não
 * nomeia o mecanismo na URL. Na página pública, `strict-origin-when-cross-origin`
 * já garante que caminho e consulta não saem, e deixa a origem passar no clique
 * para o mapa e para o Instagram da casa, que é informação da própria barbearia.
 */
const REFERRER_FECHADO = { key: 'Referrer-Policy', value: 'no-referrer' };
const REFERRER_PADRAO = { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' };

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // A página pública é o principal ativo de SEO da barbearia; o pacote do
  // cliente fica separado do admin de propósito (defeito D10).
  transpilePackages: ['@barbearia/ui'],
  // O R9 envia a imagem preparada por Server Action antes de encaminhá-la à API.
  // O Next limita Server Actions a 1 MB por padrão; a API aceita até 3 MB.
  // 4 MB deixa margem para o envelope multipart sem ampliar o teto de domínio.
  experimental: { serverActions: { bodySizeLimit: '4mb' } },
  poweredByHeader: false,
  async headers() {
    return [
      { source: '/admin/:caminho*', headers: [...CABECALHOS, REFERRER_FECHADO] },
      { source: '/plataforma/:caminho*', headers: [...CABECALHOS, REFERRER_FECHADO] },
      // Excludente, e não "o resto por último": o Next aplica **todas** as
      // entradas que casam, então uma regra ampla no fim reescreveria o
      // referrer fechado das duas de cima sem nada acusar.
      { source: '/((?!admin|plataforma).*)', headers: [...CABECALHOS, REFERRER_PADRAO] },
    ];
  },
};
