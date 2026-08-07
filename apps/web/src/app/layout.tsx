import type { ReactNode } from 'react';
// Tokens e componentes vêm do pacote, não de uma cópia. Copiar o CSS criaria
// uma segunda fonte que envelhece em silêncio a cada mudança no design system.
import '@barbearia/ui/tokens.css';
import './globals.css';

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="pt-BR" data-theme="dark">
      <body>{children}</body>
    </html>
  );
}
