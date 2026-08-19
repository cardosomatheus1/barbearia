import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  equipeDaBarbearia,
  type Equipe,
  type MembroDaEquipe,
  type Papel,
} from '@/lib/admin-api';
import { painelOuDesvio } from '@/lib/painel';
import { lerSenhaDeUmaVez, lerSessaoGestor } from '@/lib/sessao-gestor';
import {
  acaoCriarMembro,
  acaoLigarMembro,
  acaoReemitirSenha,
  acaoSair,
  acaoTrocarPapel,
} from '../acoes';
import { secao } from '../secoes';

/**
 * Equipe.
 *
 * Até o bloco 11 existia uma conta só, a do dono, e era ela que ficava aberta
 * no balcão o dia inteiro — o que entregava junto o faturamento, o catálogo e a
 * base de clientes. Esta tela é por onde cada pessoa passa a ter a própria.
 *
 * O que cada papel pode vem da **API**, não de uma cópia da lista aqui: é a
 * mesma fonte que a guarda aplica. Recalcular na tela é como se acaba
 * prometendo um acesso que o servidor recusa (CLAUDE.md).
 */

export const metadata: Metadata = {
  title: 'Usuários e acessos',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const PAPEL: Record<Papel, string> = {
  owner: 'Dono',
  manager: 'Gerente',
  receptionist: 'Recepção',
  professional: 'Barbeiro',
};

/** O que cada papel faz, em uma frase, para a escolha não ser adivinhação. */
const PARA_QUE: Record<Papel, string> = {
  owner: 'Acesso completo, inclusive faturamento e equipe.',
  manager: 'Opera e configura a barbearia. Vê faturamento, não vê margem.',
  receptionist: 'Agenda, balcão e cadastro de cliente. Sem dinheiro e sem equipe.',
  professional: 'A própria agenda e a própria comissão.',
};

const FALHA: Record<string, string> = {
  email_taken: 'Este e-mail já tem conta na plataforma. Use outro.',
  invalid_phone: 'Confira o celular: precisa ter DDD e nove dígitos.',
  owner_protected: 'A conta do dono não pode ser alterada por aqui.',
  staff_not_found: 'Esta conta não existe mais.',
  forbidden: 'Só o dono administra a equipe.',
  invalid_request: 'Confira os dados e tente de novo.',
  request_failed: 'Não deu para salvar. Tente de novo.',
};

const ATRIBUIVEIS: readonly Papel[] = ['receptionist', 'professional', 'manager'];

function Pessoa({
  membro,
  permissoes,
}: {
  readonly membro: MembroDaEquipe;
  readonly permissoes: readonly string[];
}) {
  const dono = membro.role === 'owner';

  return (
    <li className={`pessoa-equipe ${membro.active ? '' : 'pessoa-equipe--fora'}`}>
      <div className="pessoa-equipe__quem">
        <h3 className="pessoa-equipe__nome">
          {membro.name}
          {membro.active ? null : <span className="pessoa-equipe__selo">desligada</span>}
          {membro.mustChangePassword ? (
            <span className="pessoa-equipe__selo">senha não trocada</span>
          ) : null}
        </h3>
        <p className="pessoa-equipe__email">{membro.email}</p>
        {/*
          A contagem vira link, e a frase sai daqui (bloco 104).

          `PARA_QUE` é um mapa fixo no arquivo, e os papéis são **editáveis**
          desde o bloco 30: bastou conceder `team.manage` à recepção para a tela
          continuar dizendo "sem dinheiro e sem equipe" ao lado de "17
          permissões" — a contagem vem da API e subiu, a frase não. Era a frase
          que o dono lia ao decidir em que papel colocar a próxima contratação.

          O que existe de verdade é a lista, e agora a tela leva até ela — que
          também conserta a tela de permissões não ser alcançável a partir daqui.
        */}
        <p className="pessoa-equipe__pode">
          <a className="pessoa-equipe__contagem tabular" href="/admin/equipe/permissoes">
            {permissoes.length} permissões
          </a>
        </p>
      </div>

      {dono ? (
        // Não é falta de tela: o dono é a única conta que não pode ser trancada
        // para fora do próprio negócio, e a API recusa os três caminhos.
        <p className="pessoa-equipe__dono">Dono da barbearia</p>
      ) : (
        <div className="pessoa-equipe__acoes">
          <form action={acaoTrocarPapel} className="pessoa-equipe__papel">
            <input type="hidden" name="id" value={membro.id} />
            <label className="ui-visually-hidden" htmlFor={`papel-${membro.id}`}>
              Papel de {membro.name}
            </label>
            <select
              className="ui-field__input"
              defaultValue={membro.role}
              id={`papel-${membro.id}`}
              name="role"
            >
              {ATRIBUIVEIS.map((papel) => (
                <option key={papel} value={papel}>
                  {PAPEL[papel]}
                </option>
              ))}
            </select>
            <button className="ui-button ui-button--ghost" type="submit">
              Trocar
            </button>
          </form>

          <div className="pessoa-equipe__miudas">
            <form action={acaoReemitirSenha}>
              <input type="hidden" name="id" value={membro.id} />
              <input type="hidden" name="nome" value={membro.name} />
              <button className="ui-button ui-button--ghost pessoa-equipe__miuda" type="submit">
                Nova senha
              </button>
            </form>
            <form action={acaoLigarMembro}>
              <input type="hidden" name="id" value={membro.id} />
              <input type="hidden" name="active" value={membro.active ? '0' : '1'} />
              <button
                className={`ui-button ui-button--ghost pessoa-equipe__miuda ${
                  membro.active ? 'pessoa-equipe__risco' : ''
                }`}
                type="submit"
              >
                {membro.active ? 'Desligar' : 'Religar'}
              </button>
            </form>
          </div>
        </div>
      )}
    </li>
  );
}

export default async function EquipePage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);

  const resposta = await equipeDaBarbearia(token);
  const query = await searchParams;
  const erro = first(query['erro']);
  // Do cookie de vida curta, nunca da URL: senha em parâmetro de consulta fica
  // no histórico do balcão e no `Referer` de toda requisição da página.
  const recemCriada = await lerSenhaDeUmaVez();
  const salvo = first(query['salvo']) === '1';

  if (!resposta.ok) {
    // 403 aqui não é defeito: é uma conta sem `team.manage` tentando entrar.
    return (
      <main className="ui-container painel__conteudo" {...secao('equipe')}>
        <header className="painel__topo">
          <a className="painel__marca" href="/admin/dia">← {estado.businessName}</a>
        </header>
        <div className="ui-alert ui-alert--warning" role="alert">
          {FALHA[resposta.code] ?? FALHA['request_failed']}{' '}
          <a className="ui-button ui-button--secondary painel__saida" href="/admin/dia">Voltar ao dia</a>
        </div>
      </main>
    );
  }

  const equipe: Equipe = resposta.dados;

  return (
    <main className="ui-container painel__conteudo" {...secao('equipe')}>
      <header className="painel__topo">
        <a className="painel__marca" href="/admin/dia">← {estado.businessName}</a>
        <form action={acaoSair}>
          <button className="ui-button ui-button--ghost painel__sair" type="submit">
            Sair
          </button>
        </form>
      </header>

      <h1 className="painel__titulo">Usuários e acessos</h1>
      <p className="painel__sub">
        Cada pessoa com a própria conta e só o acesso de que precisa. Enquanto a recepção usa a
        sua senha, ela também tem o seu faturamento.
      </p>

      {erro ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {FALHA[erro] ?? FALHA['request_failed']}
        </div>
      ) : null}

      {salvo ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Alteração salva.
        </div>
      ) : null}

      {recemCriada ? (
        // Some sozinha em dois minutos, com o cookie. Não fica no histórico nem
        // no endereço, e a conta nasce obrigada a trocar.
        <div className="ui-alert ui-alert--info painel__aviso senha-nova" role="status">
          <p className="senha-nova__titulo">
            Senha de primeiro acesso de {recemCriada.nome}
          </p>
          <p className="senha-nova__valor tabular">{recemCriada.senha}</p>
          <p className="senha-nova__nota">
            Anote e entregue agora — ela some desta tela em dois minutos e não aparece de novo.
            No primeiro acesso o sistema pede para trocar.
          </p>
        </div>
      ) : null}

      <ul className="equipe-lista">
        {equipe.members.map((membro) => (
          <Pessoa
            key={membro.id}
            membro={membro}
            permissoes={equipe.permissionsByRole[membro.role] ?? []}
          />
        ))}
      </ul>

      <section className="painel__grupo">
        <h2 className="rotulo">Adicionar alguém</h2>
        <form action={acaoCriarMembro} className="formulario">
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="name">Nome</label>
            <input className="ui-field__input" id="name" name="name" required
                   minLength={3} maxLength={80} autoComplete="off" />
          </div>

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="email">E-mail</label>
            <input className="ui-field__input" id="email" name="email" type="email" required
                   maxLength={160} autoComplete="off" />
            <p className="ui-field__hint">É por ele que a pessoa entra.</p>
          </div>

          <fieldset className="painel__grupo">
            <legend className="ui-field__label">O que ela vai fazer</legend>
            <div className="papeis">
              {ATRIBUIVEIS.map((papel, indice) => (
                <label className="papel" key={papel}>
                  <input defaultChecked={indice === 0} name="role" type="radio" value={papel} />
                  <span className="papel__nome">{PAPEL[papel]}</span>
                  {/* "No padrão" porque o papel é editável: a frase descreve o
                      que ele traz de fábrica, e a contagem ao lado é a verdade
                      de agora. */}
                  <span className="papel__sobre">No padrão: {PARA_QUE[papel]}</span>
                  <span className="papel__contagem tabular">
                    {(equipe.permissionsByRole[papel] ?? []).length} permissões
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="ui-sticky-action">
            <button className="ui-button ui-button--primary ui-button--block" type="submit">
              Criar conta
            </button>
          </div>
        </form>
      </section>

      <p className="painel__nota">
        Toda criação, troca de papel e desligamento fica registrado — com quem fez, quando e o
        que mudou. O registro não pode ser apagado, nem por esta tela.
      </p>
    </main>
  );
}
