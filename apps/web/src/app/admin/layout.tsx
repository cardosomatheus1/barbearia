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
 * parte do bloco 13.
 *
 * A densidade aqui é outra: a recepção passa o dia nesta tela, então ela é
 * compacta. A página do cliente respira porque ele entra uma vez por mês.
 *
 * E o tema também: `data-theme="light"` porque o balcão fica horas com a tela
 * ligada, e fundo escuro cansa em sessão longa. Os tokens já declaravam o tema
 * claro como "o padrão do admin" desde o design system — ninguém o aplicava. Os
 * dois temas passam pela mesma verificação de contraste, então trocar aqui não
 * abre buraco de acessibilidade.
 */

export const metadata: Metadata = {
  title: 'Painel',
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { readonly children: ReactNode }) {
  return (
    <div className="painel" data-theme="light">
      {children}
    </div>
  );
}
