import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { trilhaDeAuditoria, trilhaDoDinheiro, type EventoDaTrilha } from '@/lib/admin-api';
import { FRASE_DO_EVENTO, diferencaDoEvento } from '@/lib/trilha';
import { painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { acaoSair } from '../acoes';
import { secao } from '../secoes';

/**
 * A trilha de auditoria — lacuna aberta no bloco 12.
 *
 * `audit_log` existe desde lá: append-only por `REVOKE`, escrita na mesma
 * transação que muda o estado, com antes e depois, e com leitura paginada por
 * cursor. Faltava onde olhar sem `psql`.
 *
 * **A tela traduz, não despeja.** `staff.role_changed` com
 * `{"role":"receptionist"}` e `{"role":"manager"}` é o formato certo para
 * guardar e o errado para ler: quem abre esta tela está no meio de uma
 * pergunta — "quem deu acesso ao caixa para o Bruno?" — e precisa da frase, não
 * do JSON.
 *
 * **Duas abas, porque são duas permissões.** A primeira versão desta tela lia
 * tudo com `settings.manage`, e isso entregava o fechamento do caixa, o desconto
 * dado e o total da folha sem segundo fator — para a mesma conta que a API
 * barraria em `/dashboard/revenue`. A trilha não guarda senha; guarda **quanto**,
 * e foi a categoria que a primeira leitura não conferiu. A aba de dinheiro só
 * aparece para quem tem `finance.view`, e a API a recusa de todo jeito: esconder
 * aqui é conforto, não a garantia.
 *
 * **Paginação por cursor, nunca por página.** A trilha só cresce; com `OFFSET`,
 * um evento novo entre duas leituras empurra o resto e a pessoa lê a mesma
 * linha duas vezes enquanto outra passa despercebida.
 */

export const metadata: Metadata = {
  title: 'Trilha',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const QUANDO = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function Evento({ evento }: { readonly evento: EventoDaTrilha }) {
  const mudou = diferencaDoEvento(evento.before, evento.after);

  return (
    <li className="evento">
      <p className="evento__quando tabular">
        <time dateTime={evento.createdAt}>{QUANDO.format(new Date(evento.createdAt))}</time>
      </p>
      <p className="evento__frase">
        <strong>{evento.actorName}</strong>{' '}
        {/* Ação sem tradução aparece como o próprio código: melhor um rótulo
            feio e verdadeiro do que uma frase genérica que esconde o evento. */}
        {FRASE_DO_EVENTO[evento.action] ?? evento.action}
      </p>
      {mudou.length > 0 ? (
        <ul className="evento__mudou">
          {mudou.map((linha) => (
            <li key={linha}>{linha}</li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export default async function TrilhaPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const podeDinheiro = podeNaTela(estado, 'finance.view');

  const query = await searchParams;
  const antesDe = first(query['antesDe']);
  const noDinheiro = first(query['aba']) === 'dinheiro' && podeDinheiro;

  const resposta = noDinheiro
    ? await trilhaDoDinheiro(token, antesDe)
    : await trilhaDeAuditoria(token, antesDe);

  const base = noDinheiro ? '/admin/trilha?aba=dinheiro' : '/admin/trilha';

  const topo = (
    <header className="painel__topo">
      <a className="painel__marca" href="/admin/painel">
        ← {estado.businessName}
      </a>
      <form action={acaoSair}>
        <button className="ui-button ui-button--ghost painel__sair" type="submit">
          Sair
        </button>
      </form>
    </header>
  );

  const abas = podeDinheiro ? (
    <nav aria-label="Trilha" className="cadastro-nav ui-scroll-x">
      <ul className="cadastro-nav__lista">
        <li>
          {noDinheiro ? (
            <a className="cadastro-nav__aba" href="/admin/trilha">
              Contas e permissões
            </a>
          ) : (
            <span aria-current="page" className="cadastro-nav__aba cadastro-nav__aba--atual">
              Contas e permissões
            </span>
          )}
        </li>
        <li>
          {noDinheiro ? (
            <span aria-current="page" className="cadastro-nav__aba cadastro-nav__aba--atual">
              Dinheiro
            </span>
          ) : (
            <a className="cadastro-nav__aba" href="/admin/trilha?aba=dinheiro">
              Dinheiro
            </a>
          )}
        </li>
      </ul>
    </nav>
  ) : null;

  if (!resposta.ok) {
    return (
      <main className="ui-container painel__conteudo" {...secao('trilha')}>
        {topo}
        <h1 className="painel__titulo">Trilha</h1>
        <div className="ui-alert ui-alert--warning" role="alert">
          {resposta.code === 'forbidden'
            ? 'Sua conta não lê a trilha da barbearia.'
            : resposta.code === 'mfa_required' || resposta.code === 'mfa_setup_required'
              ? 'O que aconteceu com o dinheiro pede o código do segundo fator.'
              : 'Não deu para carregar. Tente de novo.'}
          <a
            className="ui-button ui-button--secondary painel__saida"
            href={
              resposta.code === 'mfa_required' || resposta.code === 'mfa_setup_required'
                ? '/admin/seguranca?de=trilha'
                : '/admin/dia'
            }
          >
            {resposta.code === 'mfa_required' || resposta.code === 'mfa_setup_required'
              ? 'Confirmar agora'
              : 'Voltar ao dia'}
          </a>
        </div>
      </main>
    );
  }

  const { entries, proximoCursor } = resposta.dados;

  return (
    <main className="ui-container painel__conteudo" {...secao('trilha')}>
      {topo}
      {abas}

      <h1 className="painel__titulo">Trilha</h1>
      <p className="painel__sub">
        {noDinheiro
          ? 'Abertura e fechamento de caixa, sangria, suprimento, desconto, fiado e comissão — com o valor de cada um.'
          : 'Quem mexeu em quê: conta, papel, permissão e segundo fator.'}{' '}
        O registro é gravado junto com a mudança e não pode ser apagado nem reescrito — nem por esta
        tela, nem por quem tem acesso ao banco da aplicação.
      </p>

      {entries.length === 0 ? (
        <div className="vazio">
          <p className="vazio__titulo">{antesDe ? 'Chegou ao começo' : 'Nada registrado ainda'}</p>
          <p className="vazio__saida">
            {antesDe
              ? 'Estes são os eventos mais antigos da barbearia.'
              : noDinheiro
                ? 'Começa quando alguém abrir o caixa, dar um desconto ou fechar uma comissão.'
                : 'Começa quando alguém criar uma conta ou mudar uma permissão.'}
          </p>
          <a className="ui-button ui-button--secondary" href={base}>
            Ver os mais recentes
          </a>
        </div>
      ) : (
        <>
          <ul className="eventos">
            {entries.map((evento) => (
              <Evento evento={evento} key={evento.id} />
            ))}
          </ul>

          {proximoCursor ? (
            <a
              className="ui-button ui-button--secondary ui-button--block"
              href={`${base}${noDinheiro ? '&' : '?'}antesDe=${proximoCursor}`}
            >
              Ver mais antigos
            </a>
          ) : null}
        </>
      )}
    </main>
  );
}
