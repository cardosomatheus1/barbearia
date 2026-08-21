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

  const suporte = estado.dados.staff.suporte === true;

  return (
    <div className="painel" data-theme="dark">
      {suporte ? (
        /**
         * A faixa de suporte.
         *
         * Não é decoração e não é opcional: esta tela é idêntica à do gestor —
         * mesmo tema, mesmos componentes, mesmos números —, e quem está aqui é
         * um funcionário nosso dentro da conta de um cliente. Sem a faixa, ler
         * o faturamento da barbearia errada durante uma ligação é uma questão
         * de tempo.
         *
         * Ela diz também que o dono está vendo, porque ele está: cada tela
         * aberta vira uma linha na trilha dele.
         */
        <p className="faixa-suporte" role="status">
          <strong>Modo suporte</strong> · você está dentro da conta de{' '}
          {estado.dados.businessName}. Somente leitura, trinta minutos, e o dono vê na trilha
          dele o que você abriu.
        </p>
      ) : null}
      <Casco
        barbearia={estado.dados.businessName}
        nome={estado.dados.staff.name}
        papel={suporte ? 'suporte' : estado.dados.staff.role}
        permissoes={estado.dados.staff.permissions}
        recursos={estado.dados.recursos}
        unidade={estado.dados.unidade?.ehRede ? estado.dados.unidade.nome : null}
      >
        {children}
      </Casco>
    </div>
  );
}
