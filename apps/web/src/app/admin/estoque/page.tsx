import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  ROTULO_DA_UNIDADE_DE_MEDIDA,
  ROTULO_DO_ALERTA,
  ROTULO_DO_TIPO_DE_PRODUTO,
  UNIDADES_DE_MEDIDA,
  frasePorcentagem,
} from '@barbearia/core';
import {
  margemNaApi,
  produtosNaApi,
  type MargemDoServico,
  type ProdutoNaTela,
} from '@/lib/admin-api';
import { painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { reais, reaisDoCampo } from '@/lib/dinheiro';
import { acaoMoverEstoque, acaoSair, acaoSalvarProduto } from '../acoes';
import { secao } from '../secoes';
import { AvisoDeRecusa } from '@/app/admin/aviso-de-recusa';
import { marcaDaRecusa } from '../falha-da-leitura';

/**
 * Estoque, ficha de consumo e margem (bloco 44, SPEC §3.7 e §3.8).
 *
 * ## O que a tela abre mostrando
 *
 * O que está errado. Uma lista de cinquenta produtos ordenada por nome é um
 * inventário; o que a barbearia precisa às oito da manhã é "o que acabou, o que
 * está para acabar e o que vence" — e isso é uma lista de três.
 *
 * ## O saldo tem histórico, e o histórico é a resposta
 *
 * "Por que só tem 12 se eu comprei 20?" é a pergunta que o dono faz olhando a
 * prateleira. Por isso cada produto abre o próprio extrato, com quem lançou e
 * por quê — e por isso não existe campo de estoque editável em lugar nenhum:
 * corrigir é lançar um ajuste, com motivo, ao lado do erro.
 *
 * ## A margem fica atrás de outra permissão
 *
 * `finance.view_profit`, e não `inventory.view`. A decomposição mostra quanto de
 * comissão cada serviço custa — é estratégia, não contagem de vidro, e a SPEC
 * §1.3 separa as duas de propósito.
 */

export const metadata: Metadata = {
  title: 'Estoque',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const FALHA: Record<string, string> = {
  produto_invalido: 'Confira os dados: nome, custo e mínimo precisam fazer sentido.',
  saldo_insuficiente: 'Não há esse tanto em estoque.',
  motivo_obrigatorio: 'Escreva o motivo — perda e ajuste mudam o número sem venda.',
  produto_nao_encontrado: 'Este produto não existe mais.',
  forbidden: 'Sua conta não mexe no estoque.',
  invalid_request: 'Confira os dados e tente de novo.',
  request_failed: 'Não deu para salvar. Tente de novo.',
};

const dinheiro = reais;

function CamposDoProduto({
  produto,
  prefixo,
}: {
  readonly produto?: ProdutoNaTela;
  readonly prefixo: string;
}) {
  return (
    <form action={acaoSalvarProduto} className="formulario">
      {produto ? <input name="id" type="hidden" value={produto.id} /> : null}

      <div className="ui-field">
        <label className="ui-field__label" htmlFor={`${prefixo}-nome`}>
          Nome
        </label>
        <input
          className="ui-field__input"
          defaultValue={produto?.nome ?? ''}
          id={`${prefixo}-nome`}
          maxLength={120}
          minLength={2}
          name="nome"
          placeholder="Pomada modeladora"
          required
        />
      </div>

      <div className="ui-field">
        <label className="ui-field__label" htmlFor={`${prefixo}-tipo`}>
          O que a barbearia faz com ele
        </label>
        <select
          className="ui-field__input"
          defaultValue={produto?.tipo ?? 'resale'}
          id={`${prefixo}-tipo`}
          name="tipo"
        >
          <option value="resale">{ROTULO_DO_TIPO_DE_PRODUTO.resale}</option>
          <option value="internal">{ROTULO_DO_TIPO_DE_PRODUTO.internal}</option>
        </select>
        {/* A distinção é o que permite calcular margem: o shampoo que o barbeiro
            usa baixa por ficha técnica, não por venda. */}
        <p className="ui-field__hint">
          O que vende baixa na comanda. O que se usa no atendimento baixa pela ficha do serviço.
        </p>
      </div>

      <div className="campos-lado">
        <div className="ui-field">
          <label className="ui-field__label" htmlFor={`${prefixo}-custoReais`}>
            Custo (R$)
          </label>
          <input
            className="ui-field__input"
            defaultValue={produto ? reaisDoCampo(produto.custoCents) : ''}
            id={`${prefixo}-custoReais`}
            inputMode="decimal"
            name="custoReais"
            placeholder="12,00"
            required
          />
        </div>

        <div className="ui-field">
          <label className="ui-field__label" htmlFor={`${prefixo}-precoReais`}>
            Preço de venda (R$)
          </label>
          <input
            className="ui-field__input"
            defaultValue={produto?.precoCents ? reaisDoCampo(produto.precoCents) : ''}
            id={`${prefixo}-precoReais`}
            inputMode="decimal"
            name="precoReais"
            placeholder="35,00"
          />
          <p className="ui-field__hint">Só para o que vende. Ignorado no uso interno.</p>
        </div>
      </div>

      <div className="campos-lado">
        <div className="ui-field">
          <label className="ui-field__label" htmlFor={`${prefixo}-minimo`}>
            Estoque mínimo
          </label>
          <input
            className="ui-field__input"
            defaultValue={produto?.minimo ?? 0}
            id={`${prefixo}-minimo`}
            inputMode="numeric"
            min={0}
            name="minimo"
            type="number"
          />
          <p className="ui-field__hint">Abaixo disso a tela avisa. Zero desliga o aviso.</p>
        </div>

        <div className="ui-field">
          <label className="ui-field__label" htmlFor={`${prefixo}-unidade`}>
            Unidade
          </label>
          <select
            className="ui-field__input"
            defaultValue={produto?.unidade ?? 'un'}
            id={`${prefixo}-unidade`}
            name="unidade"
          >
            {UNIDADES_DE_MEDIDA.map((u) => (
              <option key={u} value={u}>
                {ROTULO_DA_UNIDADE_DE_MEDIDA[u]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="campos-lado">
        <div className="ui-field">
          <label className="ui-field__label" htmlFor={`${prefixo}-barcode`}>
            Código de barras
          </label>
          <input
            className="ui-field__input"
            defaultValue={produto?.barcode ?? ''}
            id={`${prefixo}-barcode`}
            maxLength={60}
            name="barcode"
          />
        </div>

        <div className="ui-field">
          <label className="ui-field__label" htmlFor={`${prefixo}-venceEm`}>
            Validade
          </label>
          <input
            className="ui-field__input"
            defaultValue={produto?.venceEm ?? ''}
            id={`${prefixo}-venceEm`}
            name="venceEm"
            type="date"
          />
        </div>
      </div>

      <div className="ui-field">
        <label className="ui-field__label" htmlFor={`${prefixo}-fornecedor`}>
          Fornecedor
        </label>
        <input
          className="ui-field__input"
          defaultValue={produto?.fornecedor ?? ''}
          id={`${prefixo}-fornecedor`}
          maxLength={120}
          name="fornecedor"
        />
      </div>

      <label className="opcao-simples">
        <input defaultChecked={produto?.ativo ?? true} name="ativo" type="checkbox" />
        <span>
          <span className="opcao-simples__nome">Em uso</span>
          <span className="opcao-simples__sobre">
            Desmarque para tirar da lista. O histórico de movimento continua.
          </span>
        </span>
      </label>

      <button className="ui-button ui-button--primary ui-button--block" type="submit">
        {produto ? 'Salvar alterações' : 'Adicionar produto'}
      </button>
    </form>
  );
}

function Produto({ produto, podeMexer }: { readonly produto: ProdutoNaTela; readonly podeMexer: boolean }) {
  return (
    <li className={`item-cadastro ${produto.ativo ? '' : 'item-cadastro--fora'}`}>
      <div className="item-cadastro__cabeca">
        <div className="item-cadastro__quem">
          <h3 className="item-cadastro__nome">
            {produto.nome}
            {produto.alertas.map((alerta) => (
              <span className="item-cadastro__selo" key={alerta}>
                {ROTULO_DO_ALERTA[alerta]}
              </span>
            ))}
          </h3>
          <p className="item-cadastro__linha">
            <span className="tabular">
              {produto.saldo} {produto.unidade}
            </span>{' '}
            em estoque · {ROTULO_DO_TIPO_DE_PRODUTO[produto.tipo]} ·{' '}
            <span className="tabular">{dinheiro(produto.custoCents)}</span> de custo
            {produto.precoCents !== null ? (
              <>
                {' '}
                · vende a <span className="tabular">{dinheiro(produto.precoCents)}</span>
              </>
            ) : null}
          </p>
          {/**
           * A previsão vem **antes** do mínimo, e as duas convivem.
           *
           * O mínimo é um número que alguém digitou uma vez; a previsão é o que
           * o movimento diz. Quando as duas apontam, a maior manda — e quem
           * decide é o dono, que precisa ver as duas para isso.
           *
           * Prazo nulo não vira frase: "não dá para dizer" escrito ao lado de
           * cada produto sem histórico é ruído em toda a lista.
           */}
          {produto.diasAteAcabar !== null ? (
            <p className="item-cadastro__aviso">
              Pelo consumo das últimas 8 semanas, acaba em{' '}
              <span className="tabular">{produto.diasAteAcabar}</span>{' '}
              {produto.diasAteAcabar === 1 ? 'dia' : 'dias'}
              {produto.comprarPorConsumo > 0 ? (
                <>
                  {' '}
                  — comprar <span className="tabular">{produto.comprarPorConsumo}</span> cobre o
                  próximo mês.
                </>
              ) : (
                '.'
              )}
            </p>
          ) : null}
          {produto.sugestaoDeCompra > 0 ? (
            <p className="item-cadastro__aviso">
              Comprar <span className="tabular">{produto.sugestaoDeCompra}</span> repõe a folga
              acima do mínimo de {produto.minimo}.
            </p>
          ) : null}
        </div>
      </div>

      {podeMexer ? (
        <>
          {/*
            Entrada, perda e ajuste — e mais nada.
            Venda e consumo nascem do fechamento da comanda: um botão aqui seria
            a segunda fonte do mesmo fato, com o estoque baixando sem dinheiro
            entrando no caixa.
          */}
          <details className="dobra">
            <summary className="dobra__titulo">Mexer no estoque</summary>
            <form action={acaoMoverEstoque} className="formulario">
              <input name="produtoId" type="hidden" value={produto.id} />

              <div className="campos-lado">
                <div className="ui-field">
                  <label className="ui-field__label" htmlFor={`m-${produto.id}-tipo`}>
                    O que aconteceu
                  </label>
                  <select
                    className="ui-field__input"
                    defaultValue="entrada"
                    id={`m-${produto.id}-tipo`}
                    name="tipo"
                  >
                    <option value="entrada">Chegou do fornecedor</option>
                    <option value="perda">Perdi (quebrou, venceu, sumiu)</option>
                    <option value="ajuste">Contei e o número estava errado</option>
                  </select>
                </div>

                <div className="ui-field">
                  <label className="ui-field__label" htmlFor={`m-${produto.id}-qtd`}>
                    Quantos
                  </label>
                  <input
                    className="ui-field__input"
                    id={`m-${produto.id}-qtd`}
                    inputMode="numeric"
                    name="quantidade"
                    placeholder="10"
                    required
                    type="number"
                  />
                  <p className="ui-field__hint">
                    No ajuste, use número negativo para tirar.
                  </p>
                </div>
              </div>

              <div className="ui-field">
                <label className="ui-field__label" htmlFor={`m-${produto.id}-motivo`}>
                  Por quê
                </label>
                <input
                  className="ui-field__input"
                  id={`m-${produto.id}-motivo`}
                  maxLength={300}
                  name="motivo"
                  placeholder="Dois vidros quebraram na entrega"
                />
                <p className="ui-field__hint">
                  Obrigatório em perda e ajuste: são os dois que mudam o número sem venda.
                </p>
              </div>

              <button className="ui-button ui-button--ghost ui-button--block" type="submit">
                Lançar
              </button>
            </form>
          </details>

          <details className="dobra">
            <summary className="dobra__titulo">Editar cadastro</summary>
            <CamposDoProduto prefixo={`p-${produto.id}`} produto={produto} />
          </details>
        </>
      ) : null}
    </li>
  );
}

/** A decomposição da SPEC §3.8 — o número que nenhum concorrente mostra. */
function Margem({ servico }: { readonly servico: MargemDoServico }) {
  return (
    <li className="margem">
      <div className="margem__topo">
        <h3 className="margem__nome">{servico.nome}</h3>
        <p className="margem__valor tabular">{dinheiro(servico.precoCents)}</p>
      </div>
      <dl className="margem__linhas">
        <div>
          <dt>Comissão</dt>
          <dd className="tabular">−{dinheiro(servico.comissaoCents)}</dd>
        </div>
        <div>
          <dt>Insumos</dt>
          <dd className="tabular">−{dinheiro(servico.insumosCents)}</dd>
        </div>
        <div>
          <dt>Taxa de pagamento</dt>
          <dd className="tabular">−{dinheiro(servico.taxaCents)}</dd>
        </div>
      </dl>
      <p className={`margem__sobra ${servico.margemCents < 0 ? 'margem__sobra--negativa' : ''}`}>
        Sobra <span className="tabular">{dinheiro(servico.margemCents)}</span>{' '}
        <span className="margem__pct">({frasePorcentagem(servico.margemBps)})</span>
        <span className="margem__vezes"> · {servico.vezes}× no período</span>
      </p>
    </li>
  );
}

export default async function EstoquePage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const podeMexer = podeNaTela(estado, 'inventory.adjust');
  const veMargem = podeNaTela(estado, 'finance.view_profit');

  const [resposta, margem] = await Promise.all([
    produtosNaApi(token, true),
    // A margem só é pedida a quem pode vê-la: a rota exige `finance.view_profit`,
    // e chamá-la sem a permissão produziria um erro por um número que a conta
    // não deveria nem saber que existe.
    veMargem ? margemNaApi(token) : Promise.resolve(null),
  ]);

  const query = await searchParams;
  const erro = first(query['erro']);
  const salvo = first(query['salvo']) === '1';
  const movido = first(query['movido']) === '1';

  const topo = (
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
  );

  if (!resposta.ok) {
    return (
      <main className="ui-container painel__conteudo" {...secao('estoque')}>
        {topo}
        <div className="ui-alert ui-alert--warning" role="alert" {...marcaDaRecusa(resposta.code)}>
          {FALHA[resposta.code] ?? FALHA['request_failed']}{' '}
          <a className="ui-button ui-button--secondary painel__saida" href="/admin/dia">
            Voltar ao dia
          </a>
        </div>
      </main>
    );
  }

  const todos = resposta.dados.produtos;
  const comAlerta = todos.filter((p) => p.ativo && p.alertas.length > 0);
  const relatorio = margem?.ok ? margem.dados : null;

  return (
    <main className="ui-container painel__conteudo" {...secao('estoque')}>
      {topo}

      <h1 className="painel__titulo">Estoque</h1>
      <p className="painel__sub">
        O saldo é a soma de tudo que entrou e saiu — não um número que alguém digita. Por isso
        cada produto tem um extrato, e corrigir é lançar um ajuste ao lado do erro.
      </p>

      {erro ? (
        <AvisoDeRecusa erro={erro} mapa={FALHA} className="painel__aviso" />
      ) : null}
      {salvo ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Produto salvo.
        </div>
      ) : null}
      {movido ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Movimento lançado. O saldo já mudou.
        </div>
      ) : null}

      {/*
        O que está errado abre a tela.
        Cinquenta produtos por nome é um inventário; o que a barbearia precisa às
        oito da manhã é "o que acabou, o que vai acabar e o que vence".
      */}
      {comAlerta.length > 0 ? (
        <section aria-labelledby="alertas">
          <h2 className="rotulo" id="alertas">
            Precisa de atenção ({comAlerta.length})
          </h2>
          <ul className="lista-cadastro">
            {comAlerta.map((produto) => (
              <Produto key={produto.id} podeMexer={podeMexer} produto={produto} />
            ))}
          </ul>
        </section>
      ) : todos.length > 0 ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Nada abaixo do mínimo nem vencendo.
        </div>
      ) : null}

      {relatorio && relatorio.servicos.length > 0 ? (
        <section aria-labelledby="margem" className="pacotes__contas">
          <h2 className="rotulo" id="margem">
            O que sobra de cada serviço
          </h2>
          <p className="painel__nota">
            De {relatorio.de.slice(8)} a {relatorio.ate.slice(8)} deste mês. O preço menos a
            comissão, o insumo e a taxa da maquininha — o que resta é o que paga aluguel e luz.
          </p>
          <ul className="lista-margem">
            {relatorio.servicos.map((servico) => (
              <Margem key={servico.serviceId} servico={servico} />
            ))}
          </ul>
          <p className="painel__nota">
            Custo do que saiu do estoque no período: vendido{' '}
            <span className="tabular">{dinheiro(relatorio.cmv.vendaCents)}</span>, consumido{' '}
            <span className="tabular">{dinheiro(relatorio.cmv.consumoCents)}</span>, perdido{' '}
            <span className="tabular">{dinheiro(relatorio.cmv.perdaCents)}</span>.
          </p>
        </section>
      ) : null}

      <h2 className="rotulo">Todos os produtos</h2>

      {todos.length === 0 ? (
        <div className="ui-card vazio">
          <p className="vazio__titulo">Nenhum produto ainda</p>
          <p className="vazio__saida">
            Comece pelo que você vende no balcão. Depois cadastre o que usa no atendimento — é
            ele que faz a margem de cada serviço aparecer.
          </p>
        </div>
      ) : (
        <ul className="lista-cadastro">
          {todos.map((produto) => (
            <Produto key={produto.id} podeMexer={podeMexer} produto={produto} />
          ))}
        </ul>
      )}

      {podeMexer ? (
        <section className="painel__grupo">
          <h2 className="rotulo">Adicionar produto</h2>
          <CamposDoProduto prefixo="novo" />
        </section>
      ) : null}

      <p className="painel__nota">
        A ficha de consumo de cada serviço — quanto de shampoo o corte gasta — fica no cadastro
        do serviço, em <a href="/admin/catalogo">Serviços</a>.
      </p>
    </main>
  );
}
