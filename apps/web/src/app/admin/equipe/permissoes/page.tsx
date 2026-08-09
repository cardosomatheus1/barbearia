import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { PERMISSOES, type Papel, type Permissao } from '@barbearia/core';
import { equipeDaBarbearia } from '@/lib/admin-api';
import { painelOuDesvio } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { acaoPermissoesDoPapel } from '../../acoes';
import { secao } from '../../secoes';

/**
 * O que cada papel pode.
 *
 * A SPEC §1.3 pediu isto desde o começo — "permissões granulares, não papéis
 * fixos" — e `role_permissions` nasceu por barbearia no bloco 16 justamente
 * para que hoje bastasse a tela. Até aqui, tirar `appointments.cancel` da
 * recepção era um `DELETE` no banco de produção.
 *
 * ## Três decisões da tela
 *
 * 1. **O dono não aparece.** Ele tem tudo por definição, e é a única conta que
 *    não pode ser trancada para fora do próprio negócio. Mostrá-lo com as
 *    caixas travadas convidaria à pergunta "por que não desmarca?" a cada
 *    visita; não mostrá-lo responde antes.
 *
 * 2. **Agrupado por assunto, e não em lista alfabética.** Vinte e nove caixas
 *    em ordem alfabética põem `cashier.close` ao lado de `commission.view_own`,
 *    e a pessoa que quer "mexer no dinheiro" tem que caçar. O agrupamento é o
 *    mesmo do vocabulário: dinheiro perto de dinheiro.
 *
 * 3. **O que exige segundo fator é dito na própria caixa.** Conceder
 *    `finance.discount` à recepção sem avisar que ela vai precisar de
 *    autenticador é criar um chamado para daqui a uma semana.
 */

export const metadata: Metadata = {
  title: 'Permissões',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<{ salvo?: string; erro?: string }>;
}

const PAPEL: Record<Papel, string> = {
  owner: 'Dono',
  manager: 'Gerente',
  receptionist: 'Recepção',
  professional: 'Barbeiro',
};

/** Os papéis editáveis. `owner` fica de fora aqui, na borda e no domínio. */
const EDITAVEIS: readonly Papel[] = ['manager', 'receptionist', 'professional'];

interface Grupo {
  readonly titulo: string;
  readonly sobre: string;
  readonly permissoes: readonly Permissao[];
}

/**
 * O vocabulário em português, uma frase por permissão.
 *
 * Não é enfeite: `commission.view_all` e `commission.view_own` diferem por uma
 * palavra em inglês e por quem briga na barbearia. Quem concede precisa ler a
 * diferença sem traduzir.
 */
const TEXTO: Readonly<Record<Permissao, string>> = {
  'appointments.view': 'Ver a agenda',
  'appointments.create': 'Marcar horário',
  'appointments.cancel': 'Cancelar horário',
  'appointments.reschedule': 'Remarcar horário',
  'appointments.view_all_professionals': 'Ver a agenda de todos, não só a própria',
  'appointments.attend': 'Marcar presença, iniciar e concluir atendimento',
  'cashier.open': 'Abrir o caixa e operar o balcão',
  'cashier.close': 'Fechar o caixa e conferir a gaveta',
  'cashier.withdraw': 'Fazer sangria',
  'finance.view': 'Ver faturamento',
  'finance.view_profit': 'Ver margem e lucro',
  'finance.export': 'Exportar relatório financeiro',
  'finance.discount': 'Dar desconto na comanda',
  'commission.view_own': 'Ver a própria comissão',
  'commission.view_all': 'Ver a comissão de todo mundo',
  'commission.edit_rules': 'Mudar as regras de comissão',
  'customers.view': 'Ver e buscar clientes',
  'customers.edit': 'Editar cadastro de cliente',
  'customers.export': 'Exportar a base de clientes',
  'customers.view_photos': 'Ver fotos do cliente',
  'customers.view_notes': 'Ler a anotação sobre o cliente',
  'customers.edit_notes': 'Escrever a anotação sobre o cliente',
  'reports.finance': 'Relatórios financeiros',
  'reports.operational': 'Relatórios de operação',
  'inventory.view': 'Ver o estoque',
  'inventory.adjust': 'Ajustar o estoque',
  'marketing.send': 'Disparar campanha de marketing',
  'settings.manage': 'Mudar configurações da barbearia',
  'team.manage': 'Criar contas e mudar permissões',
};

const GRUPOS: readonly Grupo[] = [
  {
    titulo: 'Agenda',
    sobre: 'O dia a dia de marcar e atender.',
    permissoes: PERMISSOES.filter((p) => p.startsWith('appointments.')),
  },
  {
    titulo: 'Dinheiro',
    sobre: 'Caixa, faturamento e comissão. Tudo aqui pede segundo fator.',
    permissoes: PERMISSOES.filter(
      (p) => p.startsWith('cashier.') || p.startsWith('finance.') || p.startsWith('commission.'),
    ),
  },
  {
    titulo: 'Clientes',
    sobre: 'Cadastro, ficha e a base inteira.',
    permissoes: PERMISSOES.filter((p) => p.startsWith('customers.')),
  },
  {
    titulo: 'A casa',
    sobre: 'Estoque, relatórios, configuração e equipe.',
    permissoes: PERMISSOES.filter(
      (p) =>
        p.startsWith('inventory.') ||
        p.startsWith('reports.') ||
        p.startsWith('marketing.') ||
        p === 'settings.manage' ||
        p === 'team.manage',
    ),
  },
];

/**
 * As que cobram o segundo fator, derivadas da mesma regra que a guarda aplica.
 *
 * Repetir a lista aqui faria a tela prometer uma coisa e a API cobrar outra na
 * primeira vez que alguém acrescentasse uma permissão de dinheiro.
 */
const exigeSegundoFator = (p: Permissao): boolean =>
  (p.startsWith('finance.') || p.startsWith('cashier.') || p === 'commission.view_all' ||
    p === 'commission.edit_rules') &&
  p !== 'commission.view_own';

const FALHA: Record<string, string> = {
  owner_protected: 'O dono tem todas as permissões por definição, e isso não se edita.',
  invalid_role: 'Papel desconhecido.',
  unknown_permission: 'Uma das permissões enviadas não existe.',
  cannot_grant:
    'Você só concede o que você mesmo tem. Peça ao dono para conceder a você primeiro.',
  forbidden: 'Sua conta não pode editar permissões.',
};

export default async function PermissoesPage({ searchParams }: Props) {
  const parametros = await searchParams;
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');
  await painelOuDesvio(token);

  const resposta = await equipeDaBarbearia(token);

  if (!resposta.ok) {
    return (
      <main className="ui-container painel__conteudo" {...secao('equipe')}>
        <h1 className="painel__titulo">Permissões</h1>
        <div className="ui-alert ui-alert--danger" role="alert">
          Não deu para carregar as permissões. Recarregue a página.
        </div>
      </main>
    );
  }

  const porPapel = resposta.dados.permissionsByRole;

  return (
    <main className="ui-container painel__conteudo" {...secao('equipe')}>
      <h1 className="painel__titulo">Permissões</h1>
      <p className="painel__sub">
        O que cada papel pode fazer nesta barbearia. Vale na requisição seguinte, para quem já está
        logado também.
      </p>

      {parametros.salvo ? (
        <div className="ui-alert ui-alert--success" role="status">
          Permissões salvas.
        </div>
      ) : null}
      {parametros.erro ? (
        <div className="ui-alert ui-alert--danger" role="alert">
          {FALHA[parametros.erro] ?? 'Não deu para salvar. Tente de novo.'}
        </div>
      ) : null}

      <div className="ui-alert ui-alert--info" role="status">
        O dono não aparece aqui: ele tem todas as permissões por definição, e é a única conta que
        não pode ficar trancada para fora do próprio negócio.
      </div>

      {EDITAVEIS.map((papel) => {
        const atuais = new Set(porPapel[papel] ?? []);
        return (
          <section className="painel__grupo permissoes-do-papel" key={papel}>
            <h2 className="painel__secao">{PAPEL[papel]}</h2>
            <form action={acaoPermissoesDoPapel}>
              <input name="papel" type="hidden" value={papel} />

              {GRUPOS.map((grupo) => (
                <fieldset className="permissao__grupo" key={grupo.titulo}>
                  <legend className="permissao__legenda">{grupo.titulo}</legend>
                  <p className="permissao__sobre">{grupo.sobre}</p>
                  <ul className="permissao__lista">
                    {grupo.permissoes.map((permissao) => (
                      <li className="permissao__item" key={permissao}>
                        <label className="permissao__opcao">
                          <input
                            defaultChecked={atuais.has(permissao)}
                            name="permissoes"
                            type="checkbox"
                            value={permissao}
                          />
                          <span className="permissao__texto">
                            {TEXTO[permissao]}
                            {exigeSegundoFator(permissao) ? (
                              <span className="permissao__selo">2º fator</span>
                            ) : null}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </fieldset>
              ))}

              <button className="ui-button ui-button--primary permissao__salvar" type="submit">
                Salvar as permissões de {PAPEL[papel].toLowerCase()}
              </button>
            </form>
          </section>
        );
      })}
    </main>
  );
}
