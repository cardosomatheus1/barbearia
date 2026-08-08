import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * Painel do gestor.
 *
 * Rota própria, e não app separado — ainda. O que o defeito D10 cobra é que o
 * visitante anônimo não baixe o ERP inteiro, e o roteamento do Next já separa
 * os pacotes por rota: quem abre `/domari` não recebe nada de `/admin`.
 *
 * Extrair para `apps/admin` vira necessário quando o painel crescer a ponto de
 * ter dependências que a página pública não usa. Está declarado no ROADMAP como
 * parte do bloco 11.
 *
 * A densidade aqui é outra: a recepção passa o dia nesta tela, então ela é
 * compacta. A página do cliente respira porque ele entra uma vez por mês.
 */

export const metadata: Metadata = {
  title: 'Painel',
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { readonly children: ReactNode }) {
  return <div className="painel">{children}</div>;
}
