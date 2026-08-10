import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  catalogoDeServicos,
  recursosDaUnidade,
  type RecursoDaUnidade,
  type ServicoDoCatalogo,
} from '@/lib/admin-api';
import { painelOuDesvio } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { acaoExigenciasDoServico, acaoSair, acaoSalvarRecursos } from '../acoes';
import { secao } from '../secoes';

/**
 * Recursos: cadeira, lavatório, sala.
 *
 * O motor respeita recursos desde o bloco 1 — `resource_pools` diz quantos
 * existem e `service_resource_requirements` diz o que cada serviço consome. Só
 * que **nada nunca preencheu as duas tabelas**, e o campo que ninguém preenche
 * é uma mentira do sistema (CLAUDE.md §4).
 *
 * O que a ausência custava, em concreto: barbearia com dois barbeiros e um
 * lavatório oferecia dois horários simultâneos de lavagem, e o segundo cliente
 * esperava de cabelo molhado. O sistema sabia evitar e não tinha por onde
 * ser avisado.
 */

export const metadata: Metadata = {
  title: 'Recursos',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const FALHA: Record<string, string> = {
  invalid_catalog: 'Confira os recursos: o nome precisa existir na lista e a quantidade ser pelo menos 1.',
  service_not_found: 'Este serviço não existe mais.',
  forbidden: 'Sua conta não administra o cadastro da barbearia.',
  invalid_request: 'Confira os dados e tente de novo.',
  request_failed: 'Não deu para salvar. Tente de novo.',
};

/** Duas linhas em branco: cadastrar o segundo recurso não pode exigir salvar antes. */
const LINHAS_EM_BRANCO = 2;

function ExigenciasDoServico({
  servico,
  recursos,
}: {
  readonly servico: ServicoDoCatalogo;
  readonly recursos: readonly RecursoDaUnidade[];
}) {
  const usa = recursos.filter((recurso) =>
    recurso.usedBy.some((uso) => uso.serviceId === servico.id),
  );

  return (
    <li className="item-cadastro">
      <div className="item-cadastro__cabeca">
        <div className="item-cadastro__quem">
          <h3 className="item-cadastro__nome">{servico.name}</h3>
          <p className="item-cadastro__linha">
            {usa.length === 0
              ? 'Não ocupa nenhum recurso'
              : usa
                  .map((recurso) => {
                    const uso = recurso.usedBy.find((u) => u.serviceId === servico.id);
                    return `${uso?.quantity ?? 1}× ${recurso.resourceType}`;
                  })
                  .join(' · ')}
          </p>
        </div>
      </div>

      <details className="dobra">
        <summary className="dobra__titulo">Mudar o que ocupa</summary>
        <form action={acaoExigenciasDoServico} className="formulario">
          <input name="id" type="hidden" value={servico.id} />

          <div className="ui-scroll-x">
            <table className="recursos">
              <caption className="ui-visually-hidden">
                Recursos que {servico.name} ocupa
              </caption>
              <thead>
                <tr>
                  <th scope="col">Recurso</th>
                  <th scope="col">Quantos</th>
                </tr>
              </thead>
              <tbody>
                {recursos.map((recurso) => {
                  const uso = recurso.usedBy.find((u) => u.serviceId === servico.id);
                  const campo = `${servico.id}-${recurso.resourceType}`;
                  return (
                    <tr key={recurso.resourceType}>
                      <th scope="row">
                        {recurso.resourceType}
                        <input name="resourceType" type="hidden" value={recurso.resourceType} />
                      </th>
                      <td>
                        <label className="ui-visually-hidden" htmlFor={`q-${campo}`}>
                          Quantos {recurso.resourceType} este serviço ocupa
                        </label>
                        <input
                          className="ui-field__input recursos__numero"
                          defaultValue={uso?.quantity ?? 0}
                          id={`q-${campo}`}
                          inputMode="numeric"
                          max={Math.min(recurso.capacity, 20)}
                          min={0}
                          name="quantity"
                          type="number"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="ui-field__hint">
            Zero significa que este serviço não ocupa aquele recurso.
          </p>

          <button className="ui-button ui-button--primary ui-button--block" type="submit">
            Salvar
          </button>
        </form>
      </details>
    </li>
  );
}

export default async function RecursosPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const query = await searchParams;

  const [recursos, catalogo] = await Promise.all([
    recursosDaUnidade(token),
    catalogoDeServicos(token),
  ]);

  const erro = first(query['erro']);
  const salvo = first(query['salvo']) === '1';

  if (!recursos.ok || !catalogo.ok) {
    const code = recursos.ok ? (catalogo.ok ? 'request_failed' : catalogo.code) : recursos.code;
    return (
      <main className="ui-container painel__conteudo" {...secao('recursos')}>
        <header className="painel__topo">
          <a className="painel__marca" href="/admin/dia">
            ← {estado.businessName}
          </a>
        </header>
        <div className="ui-alert ui-alert--warning" role="alert">
          {FALHA[code] ?? FALHA['request_failed']} <a className="ui-button ui-button--secondary painel__saida" href="/admin/dia">Voltar ao dia</a>
        </div>
      </main>
    );
  }

  const lista = recursos.dados.resources;
  const servicos = catalogo.dados.services.filter((servico) => servico.active);
  const emBranco = Array.from({ length: LINHAS_EM_BRANCO }, (_, i) => i);

  return (
    <main className="ui-container painel__conteudo" {...secao('recursos')}>
      <header className="painel__topo">
        <a className="painel__marca" href="/admin/dia">
          ← {estado.businessName}
        </a>
        <form action={acaoSair}>
          <button className="ui-button ui-button--ghost painel__sair" type="submit">
            Sair
          </button>
        </form>
      </header>

      <h1 className="painel__titulo">Recursos</h1>
      <p className="painel__sub">
        O que a barbearia tem em quantidade limitada: cadeira, lavatório, sala de barba. Com isso
        cadastrado, dois barbeiros e um lavatório param de oferecer duas lavagens ao mesmo tempo.
      </p>

      {erro ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {FALHA[erro] ?? FALHA['request_failed']}
        </div>
      ) : null}

      {salvo ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Recursos salvos.
        </div>
      ) : null}

      <section className="painel__grupo">
        <h2 className="rotulo">O que a barbearia tem</h2>
        <form action={acaoSalvarRecursos} className="formulario">
          <div className="ui-scroll-x">
            <table className="recursos">
              <caption className="ui-visually-hidden">Recursos da barbearia</caption>
              <thead>
                <tr>
                  <th scope="col">Nome</th>
                  <th scope="col">Quantos</th>
                </tr>
              </thead>
              <tbody>
                {[...lista, ...emBranco].map((recurso, indice) => {
                  const existente = typeof recurso === 'object' ? recurso : null;
                  const chave = existente?.resourceType ?? `vazio-${indice}`;
                  return (
                    <tr key={chave}>
                      <td>
                        <label className="ui-visually-hidden" htmlFor={`tipo-${chave}`}>
                          Nome do recurso
                        </label>
                        <input
                          className="ui-field__input"
                          defaultValue={existente?.resourceType ?? ''}
                          id={`tipo-${chave}`}
                          maxLength={40}
                          name="resourceType"
                          placeholder="cadeira"
                        />
                      </td>
                      <td>
                        <label className="ui-visually-hidden" htmlFor={`cap-${chave}`}>
                          Quantos existem
                        </label>
                        <input
                          className="ui-field__input recursos__numero"
                          defaultValue={existente?.capacity ?? ''}
                          id={`cap-${chave}`}
                          inputMode="numeric"
                          max={100}
                          min={1}
                          name="capacity"
                          type="number"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="ui-field__hint">
            Deixar o nome em branco apaga o recurso — e com ele o que os serviços exigiam dele.
            Use o vocabulário da sua barbearia: &ldquo;cadeira&rdquo;, &ldquo;lavatório&rdquo;,
            &ldquo;sala de barba&rdquo;.
          </p>

          <button className="ui-button ui-button--primary ui-button--block" type="submit">
            Salvar recursos
          </button>
        </form>
      </section>

      <section className="painel__grupo">
        <h2 className="rotulo">O que cada serviço ocupa</h2>
        {lista.length === 0 ? (
          <div className="ui-card vazio">
            <p className="vazio__titulo">Cadastre um recurso primeiro</p>
            <p className="vazio__saida">
              Sem a lista acima não há o que um serviço ocupe. Comece pelas cadeiras.
            </p>
          </div>
        ) : servicos.length === 0 ? (
          <div className="ui-card vazio">
            <p className="vazio__titulo">Nenhum serviço no catálogo</p>
            <p className="vazio__saida">
              <a href="/admin/catalogo">Cadastre um serviço</a> para dizer o que ele ocupa.
            </p>
          </div>
        ) : (
          <ul className="lista-cadastro">
            {servicos.map((servico) => (
              <ExigenciasDoServico key={servico.id} recursos={lista} servico={servico} />
            ))}
          </ul>
        )}
      </section>

      <p className="painel__nota">
        A grade recorta a janela quando um recurso acaba, e o cliente simplesmente não vê aquele
        horário — sem mensagem de erro e sem espera de cabelo molhado.
      </p>
    </main>
  );
}
