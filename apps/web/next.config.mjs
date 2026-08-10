import { origensPermitidas } from './origens-permitidas.mjs';

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // A página pública é o principal ativo de SEO da barbearia; o pacote do
  // cliente fica separado do admin de propósito (defeito D10).
  transpilePackages: ['@barbearia/ui'],
  poweredByHeader: false,
  // A lista de endereços de confiança é resolvida aqui, na construção, e
  // entregue ao `middleware` por `env` — que é o único caminho: o middleware
  // roda numa sandbox que não enxerga a variável de ambiente do processo.
  //
  // Consequência a saber: quem constrói numa máquina e roda em outra leva a
  // lista da primeira. Não é problema no fluxo que existe — `rodar-local.sh`
  // constrói e sobe no mesmo terminal —, mas `--sem-build` depois de trocar de
  // ambiente traz de volta o erro.
  env: {
    WEB_ORIGENS_DE_CONFIANCA: origensPermitidas(process.env).join(','),
  },
};
