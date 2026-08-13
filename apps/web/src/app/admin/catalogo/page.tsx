import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  catalogoDeServicos,
  produtosNaApi,
  type ProdutoNaTela,
  type ServicoDoCatalogo,
} from '@/lib/admin-api';
import { painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { reaisDoCampo } from '@/lib/dinheiro';
import { acaoLigarServico, acaoSair, acaoSalvarFicha, acaoSalvarServico } from '../acoes';
import { secao } from '../secoes';

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

      {/*
        A exigência de sinal, por serviço (bloco 37).

        Fica no cadastro do serviço e não na tela de configuração porque é uma
        propriedade dele: a coloração de três horas custa a tarde inteira quando
        alguém falta, independentemente de quem faltou. O `hidden` acompanhando
        a caixa é o que faz "desmarcado" chegar como `false` em vez de sumir do
        formulário — sem ele, desmarcar não desligaria nada.
      */}
      <input name="alwaysRequireDeposit" type="hidden" value="0" />
      <label className="opcao-simples">
        <input defaultChecked={servico?.alwaysRequireDeposit ?? false}
               name="alwaysRequireDeposit" type="checkbox" value="1" />
        <span>
          <span className="opcao-simples__nome">Sempre pedir sinal para este serviço</span>
          <span className="opcao-simples__sobre">
            Para o serviço longo e caro, em que a falta custa a tarde. Quem nunca falta
            continua sem pagar. Precisa de sinal ligado em{' '}
            <a href="/admin/configuracoes">Configurações</a>.
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

/**
 * A ficha de consumo de um serviço (bloco 44, SPEC §3.7).
 *
 * ```
 * Barba Premium consome:
 *   óleo pré-barba    5 ml
 *   pós-barba         2 ml
 *   lâmina            1 un
 * ```
 *
 * Fica no cadastro do **serviço** e não no do produto porque a pergunta é dele:
 * "o que este corte gasta?". Lista todos os insumos com a quantidade em branco —
 * quem ficar em zero simplesmente não entra, e não há botão de adicionar linha
 * para uma lista que cabe inteira na tela.
 *
 * É ela que faz a margem de contribuição existir: sem a ficha, o shampoo vira
 * custo nenhum e o corte parece render mais do que rende.
 */
function FichaDeConsumo({
  servico,
  insumos,
}: {
  readonly servico: ServicoDoCatalogo;
  readonly insumos: readonly ProdutoNaTela[];
}) {
  return (
    <form action={acaoSalvarFicha} className="formulario">
      <input name="serviceId" type="hidden" value={servico.id} />
      <p className="dobra__ajuda">
        Quanto de cada insumo este serviço gasta. É o que faz o custo real por atendimento — e a
        margem — aparecerem no estoque.
      </p>

      {insumos.map((produto) => (
        <div className="ui-field" key={produto.id}>
          <input name="produtoId" type="hidden" value={produto.id} />
          <label className="ui-field__label" htmlFor={`f-${servico.id}-${produto.id}`}>
            {produto.nome} <span className="ui-field__hint">({produto.unidade})</span>
          </label>
          <input
            className="ui-field__input"
            defaultValue={servico.consumiveis[produto.id] ?? ''}
            id={`f-${servico.id}-${produto.id}`}
            inputMode="numeric"
            min={0}
            name={`qtd-${produto.id}`}
            placeholder="0"
            type="number"
          />
        </div>
      ))}

      <button className="ui-button ui-button--ghost ui-button--block" type="submit">
        Salvar ficha
      </button>
    </form>
  );
}

function Servico({
  servico,
  outros,
  insumos,
}: {
  readonly servico: ServicoDoCatalogo;
  readonly outros: readonly ServicoDoCatalogo[];
  readonly insumos: readonly ProdutoNaTela[];
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

      {insumos.length > 0 ? (
        <details className="dobra">
          <summary className="dobra__titulo">O que este serviço consome</summary>
          <FichaDeConsumo insumos={insumos} servico={servico} />
        </details>
      ) : null}
    </li>
  );
}

export default async function CatalogoPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const [resposta, estoque] = await Promise.all([
    catalogoDeServicos(token),
    // A ficha técnica só aparece para quem pode editá-la, e a rota que a grava
    // exige as duas permissões. Pedir a lista sem `inventory.view` devolveria
    // 403 em toda abertura do catálogo.
    podeNaTela(estado, 'inventory.view') && podeNaTela(estado, 'inventory.adjust')
      ? produtosNaApi(token)
      : Promise.resolve(null),
  ]);
  const query = await searchParams;
  const erro = first(query['erro']);
  const salvo = first(query['salvo']) === '1';

  if (!resposta.ok) {
    return (
      <main className="ui-container painel__conteudo" {...secao('servicos')}>
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
  // Só o de uso interno entra na ficha: pendurar uma pomada de revenda faria o
  // serviço baixar do estoque de venda sem ninguém ter comprado nada.
  const insumos = estoque?.ok
    ? estoque.dados.produtos.filter((p) => p.tipo === 'internal' && p.ativo)
    : [];
  const ativos = servicos.filter((servico) => servico.active);

  return (
    <main className="ui-container painel__conteudo" {...secao('servicos')}>
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
              insumos={insumos}
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
        <a href="/admin/profissionais">Profissionais e jornadas</a>. Para cadeira, lavatório e sala,{' '}
        <a href="/admin/recursos">Recursos</a>.
      </p>
    </main>
  );
}
