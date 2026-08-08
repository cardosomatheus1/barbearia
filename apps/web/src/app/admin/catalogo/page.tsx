import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { catalogoDeServicos, type ServicoDoCatalogo } from '@/lib/admin-api';
import { painelOuDesvio } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { reaisDoCampo } from '@/lib/dinheiro';
import { acaoLigarServico, acaoSair, acaoSalvarServico } from '../acoes';
import { CadastroNav } from '../cadastro-nav';

/**
 * Serviços.
 *
 * Até aqui o catálogo só nascia nas seis etapas do onboarding, que
 * **substituem** o conjunto inteiro. Trocar o preço de um corte depois do
 * primeiro dia apagava e recriava os serviços — e com eles os ids que o
 * histórico de vendas usa. Esta tela edita no lugar.
 *
 * O que ela mostra e a de onboarding não mostrava: quantos clientes já têm hora
 * marcada com cada serviço. É o número que muda a decisão de desativar.
 */

export const metadata: Metadata = {
  title: 'Serviços',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const FALHA: Record<string, string> = {
  preco_invalido: 'Confira o preço: use números, como 49,90.',
  invalid_catalog: 'Confira as durações — um combo está prometendo menos tempo que as partes.',
  name_taken: 'Já existe um serviço com este nome.',
  service_not_found: 'Este serviço não existe mais.',
  forbidden: 'Sua conta não administra o cadastro da barbearia.',
  invalid_request: 'Confira os dados e tente de novo.',
  request_failed: 'Não deu para salvar. Tente de novo.',
};

/** Formulário de um serviço — o mesmo para criar e para editar. */
function CamposDoServico({
  servico,
  outros,
  prefixo,
}: {
  readonly servico?: ServicoDoCatalogo;
  readonly outros: readonly ServicoDoCatalogo[];
  readonly prefixo: string;
}) {
  const combo = (servico?.componentIds.length ?? 0) >= 2;

  return (
    <form action={acaoSalvarServico} className="formulario">
      {servico ? <input name="id" type="hidden" value={servico.id} /> : null}

      <div className="ui-field">
        <label className="ui-field__label" htmlFor={`${prefixo}-name`}>
          Nome
        </label>
        <input
          className="ui-field__input"
          defaultValue={servico?.name ?? ''}
          id={`${prefixo}-name`}
          maxLength={80}
          minLength={2}
          name="name"
          required
        />
      </div>

      <div className="ui-field">
        <label className="ui-field__label" htmlFor={`${prefixo}-categoryName`}>
          Categoria
        </label>
        <input
          className="ui-field__input"
          defaultValue={servico?.categoryName ?? 'Cabelo'}
          id={`${prefixo}-categoryName`}
          list="categorias"
          maxLength={60}
          name="categoryName"
          required
        />
        <p className="ui-field__hint">Agrupa os serviços na sua página. Ex.: Cabelo, Barba.</p>
      </div>

      <div className="campos-lado">
        <div className="ui-field">
          <label className="ui-field__label" htmlFor={`${prefixo}-preco`}>
            Preço (R$)
          </label>
          <input
            className="ui-field__input"
            defaultValue={servico ? reaisDoCampo(servico.priceCents) : ''}
            id={`${prefixo}-preco`}
            inputMode="decimal"
            name="preco"
            placeholder="49,90"
            required
          />
        </div>

        <div className="ui-field">
          <label className="ui-field__label" htmlFor={`${prefixo}-durationMinutes`}>
            Duração (min)
          </label>
          <input
            className="ui-field__input"
            defaultValue={servico?.durationMinutes ?? 30}
            id={`${prefixo}-durationMinutes`}
            inputMode="numeric"
            max={720}
            min={5}
            name="durationMinutes"
            required
            step={5}
            type="number"
          />
        </div>
      </div>

      <div className="campos-lado">
        <div className="ui-field">
          <label className="ui-field__label" htmlFor={`${prefixo}-bufferBeforeMinutes`}>
            Preparo antes (min)
          </label>
          <input
            className="ui-field__input"
            defaultValue={servico?.bufferBeforeMinutes ?? 0}
            id={`${prefixo}-bufferBeforeMinutes`}
            inputMode="numeric"
            max={120}
            min={0}
            name="bufferBeforeMinutes"
            step={5}
            type="number"
          />
        </div>

        <div className="ui-field">
          <label className="ui-field__label" htmlFor={`${prefixo}-bufferAfterMinutes`}>
            Limpeza depois (min)
          </label>
          <input
            className="ui-field__input"
            defaultValue={servico?.bufferAfterMinutes ?? 0}
            id={`${prefixo}-bufferAfterMinutes`}
            inputMode="numeric"
            max={120}
            min={0}
            name="bufferAfterMinutes"
            step={5}
            type="number"
          />
        </div>
      </div>

      <div className="ui-field">
        <label className="ui-field__label" htmlFor={`${prefixo}-description`}>
          Descrição
        </label>
        <textarea
          className="ui-field__input"
          defaultValue={servico?.description ?? ''}
          id={`${prefixo}-description`}
          maxLength={500}
          name="description"
          rows={2}
        />
        <p className="ui-field__hint">Aparece na sua página, abaixo do nome.</p>
      </div>

      <label className="opcao-simples">
        <input defaultChecked={servico?.bookableOnline ?? true} name="bookableOnline" type="checkbox" />
        <span>
          <span className="opcao-simples__nome">O cliente pode marcar sozinho</span>
          <span className="opcao-simples__sobre">
            Desmarque para serviços que só a recepção agenda.
          </span>
        </span>
      </label>

      <details className="dobra" open={combo}>
        <summary className="dobra__titulo">
          Este serviço é um combo{combo ? ` (${servico?.componentIds.length} partes)` : ''}
        </summary>
        <p className="dobra__ajuda">
          Marque as partes que ele junta. A duração precisa dar conta de todas — o sistema recusa
          um &ldquo;corte + barba&rdquo; de 40 minutos se corte e barba somam 55.
        </p>
        <div className="marcas-lista">
          {outros.map((outro) => (
            <label className="marca" key={outro.id}>
              <input
                defaultChecked={servico?.componentIds.includes(outro.id) ?? false}
                name="componentIds"
                type="checkbox"
                value={outro.id}
              />
              <span>
                {outro.name} <span className="tabular">{outro.durationMinutes} min</span>
              </span>
            </label>
          ))}
        </div>
      </details>

      <button className="ui-button ui-button--primary ui-button--block" type="submit">
        {servico ? 'Salvar alterações' : 'Adicionar serviço'}
      </button>
    </form>
  );
}

function Servico({
  servico,
  outros,
}: {
  readonly servico: ServicoDoCatalogo;
  readonly outros: readonly ServicoDoCatalogo[];
}) {
  return (
    <li className={`item-cadastro ${servico.active ? '' : 'item-cadastro--fora'}`}>
      <div className="item-cadastro__cabeca">
        <div className="item-cadastro__quem">
          <h3 className="item-cadastro__nome">
            {servico.name}
            {servico.active ? null : <span className="item-cadastro__selo">fora do catálogo</span>}
            {servico.bookableOnline ? null : (
              <span className="item-cadastro__selo">só pelo balcão</span>
            )}
            {servico.componentIds.length >= 2 ? (
              <span className="item-cadastro__selo">combo</span>
            ) : null}
          </h3>
          <p className="item-cadastro__linha">
            {servico.categoryName ?? 'Sem categoria'} ·{' '}
            <span className="tabular">{servico.durationMinutes} min</span> ·{' '}
            <span className="tabular">R$ {reaisDoCampo(servico.priceCents)}</span>
          </p>
          {servico.futureAppointments > 0 ? (
            <p className="item-cadastro__aviso">
              <span className="tabular">{servico.futureAppointments}</span>{' '}
              {servico.futureAppointments === 1 ? 'cliente já tem' : 'clientes já têm'} hora marcada
              com este serviço.
            </p>
          ) : null}
        </div>

        <form action={acaoLigarServico}>
          <input name="id" type="hidden" value={servico.id} />
          <input name="active" type="hidden" value={servico.active ? '0' : '1'} />
          <button
            className={`ui-button ui-button--ghost item-cadastro__miuda ${
              servico.active ? 'item-cadastro__risco' : ''
            }`}
            type="submit"
          >
            {servico.active ? 'Tirar do catálogo' : 'Voltar ao catálogo'}
          </button>
        </form>
      </div>

      <details className="dobra">
        <summary className="dobra__titulo">Editar</summary>
        <CamposDoServico outros={outros} prefixo={`s-${servico.id}`} servico={servico} />
      </details>
    </li>
  );
}

export default async function CatalogoPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const resposta = await catalogoDeServicos(token);
  const query = await searchParams;
  const erro = first(query['erro']);
  const salvo = first(query['salvo']) === '1';

  if (!resposta.ok) {
    return (
      <main className="ui-container painel__conteudo">
        <header className="painel__topo">
          <a className="painel__marca" href="/admin/dia">
            ← {estado.businessName}
          </a>
        </header>
        <div className="ui-alert ui-alert--warning" role="alert">
          {FALHA[resposta.code] ?? FALHA['request_failed']} <a className="ui-button ui-button--secondary painel__saida" href="/admin/dia">Voltar ao dia</a>
        </div>
      </main>
    );
  }

  const servicos = resposta.dados.services;
  const ativos = servicos.filter((servico) => servico.active);

  return (
    <main className="ui-container painel__conteudo">
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

      <CadastroNav atual="/admin/catalogo" />

      <h1 className="painel__titulo">Serviços</h1>
      <p className="painel__sub">
        O que sai daqui aparece na sua página e na grade de horários. Editar mantém o histórico:
        quem já foi atendido continua com o preço que pagou.
      </p>

      {erro ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {FALHA[erro] ?? FALHA['request_failed']}
        </div>
      ) : null}

      {salvo ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Catálogo salvo.
        </div>
      ) : null}

      <datalist id="categorias">
        {resposta.dados.categories.map((categoria) => (
          <option key={categoria.id} value={categoria.name} />
        ))}
      </datalist>

      {servicos.length === 0 ? (
        <div className="ui-card vazio">
          <p className="vazio__titulo">Nenhum serviço ainda</p>
          <p className="vazio__saida">
            Sem serviço não há grade: é ele que diz quanto tempo cada horário ocupa. Comece pelo
            corte mais pedido.
          </p>
        </div>
      ) : (
        <ul className="lista-cadastro">
          {servicos.map((servico) => (
            <Servico
              key={servico.id}
              outros={ativos.filter((outro) => outro.id !== servico.id)}
              servico={servico}
            />
          ))}
        </ul>
      )}

      <section className="painel__grupo">
        <h2 className="rotulo">Adicionar serviço</h2>
        <CamposDoServico outros={ativos} prefixo="novo" />
      </section>

      <p className="painel__nota">
        Para dizer quem executa cada serviço, vá em{' '}
        <a href="/admin/profissionais">Equipe e jornadas</a>. Para cadeira, lavatório e sala,{' '}
        <a href="/admin/recursos">Recursos</a>.
      </p>
    </main>
  );
}
