import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { estadoDoPainel } from '@/lib/admin-api';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { Casco } from './casco';

/**
 * Painel do gestor.
 *
 * Rota própria, e não app separado — ainda. O que o defeito D10 cobra é que o
 * visitante anônimo não baixe o ERP inteiro, e o roteamento do Next já separa
 * os pacotes por rota: quem abre `/domari` não recebe nada de `/admin`.
 *
 * A densidade aqui é outra: a recepção passa o dia nesta tela, então ela é
 * compacta. A página do cliente respira porque ele entra uma vez por mês.
 *
 * ## O tema virou escuro, e isso reverte uma decisão anterior
 *
 * Até aqui era `data-theme="light"`, com um motivo escrito: fundo claro cansa
 * menos em sessão longa, e o balcão fica horas com a tela ligada. O argumento
 * continua de pé — o que mudou foi que a marca chegou, e o desenho do sistema
 * que veio com ela é escuro. Direção do cliente ganha de escolha do projeto.
 *
 * A troca é de um atributo, e os dois temas passam pela mesma verificação de
 * contraste: voltar é uma linha, se a recepção reclamar depois de um mês de uso.
 *
 * ## Quem não tem sessão não recebe o casco
 *
 * Entrar, criar conta e trocar a senha de primeiro acesso ficam sem moldura, e a
 * regra é o estado, não uma lista de caminhos: `estadoDoPainel` recusa nos três
 * casos — sem sessão nos dois primeiros, com `must_change_password` no terceiro.
 * Uma lista de rotas esqueceria a próxima porta que alguém criar; a pergunta
 * "esta pessoa já pode navegar?" não esquece.
 */

export const metadata: Metadata = {
  title: 'Painel',
  robots: { index: false, follow: false },
};

export default async function AdminLayout({ children }: { readonly children: ReactNode }) {
  const token = await lerSessaoGestor();
  const estado = token ? await estadoDoPainel(token) : null;

  if (!estado?.ok) {
    return (
      <div className="painel painel--porta" data-theme="dark">
        {children}
      </div>
    );
  }

  return (
    <div className="painel" data-theme="dark">
      <Casco
        barbearia={estado.dados.businessName}
        nome={estado.dados.staff.name}
        papel={estado.dados.staff.role}
      >
        {children}
      </Casco>
    </div>
  );
}
