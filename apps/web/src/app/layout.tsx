import type { ReactNode } from 'react';
import { DM_Sans, Oswald } from 'next/font/google';
// Tokens e componentes vêm do pacote, não de uma cópia. Copiar o CSS criaria
// uma segunda fonte que envelhece em silêncio a cada mudança no design system.
import '@barbearia/ui/tokens.css';
import './globals.css';

/**
 * As letras da marca, servidas do nosso domínio.
 *
 * `next/font` baixa os arquivos no build e os serve junto com a aplicação. O
 * `@import` do Google Fonts — que é como o mock chega — faria o navegador de
 * cada cliente pedir a fonte a um terceiro e entregar o IP dele junto: dado
 * pessoal saindo da barbearia a cada visita, por causa de uma fonte.
 *
 * `display: 'swap'` de propósito: o cliente agenda em pé, na rua, em 4G. Texto
 * invisível esperando fonte é pior que texto na fonte do sistema por 200 ms.
 */
const oswald = Oswald({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-oswald',
  display: 'swap',
});

const dmSans = DM_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-dm-sans',
  display: 'swap',
});

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html className={`${oswald.variable} ${dmSans.variable}`} lang="pt-BR" data-theme="dark">
      <body>{children}</body>
    </html>
  );
}
