/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // A página pública é o principal ativo de SEO da barbearia; o pacote do
  // cliente fica separado do admin de propósito (defeito D10).
  transpilePackages: ['@barbearia/ui'],
  poweredByHeader: false,
};
