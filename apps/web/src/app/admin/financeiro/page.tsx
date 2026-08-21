import { randomUUID } from 'node:crypto';
import {
  DIRECOES_DA_CONTA,
  ROTULO_DA_CATEGORIA_FINANCEIRA,
  ROTULO_DA_DIRECAO,
  VERBO_DA_DIRECAO,
} from '@barbearia/core';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  agendaDoFinanceiro,
  categoriasDoFinanceiro,
  contasBancarias,
  transferenciasDoFinanceiro,
  type CategoriaFinanceira,
  type ContaBancaria,
  type ContaDoFinanceiro,
} from '@/lib/admin-api';
import { painelOuDesvio } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { reais, reaisDoCampo } from '@/lib/dinheiro';
import {
  acaoCancelarContaDoFinanceiro,
  acaoCriarCategoriaDoFinanceiro,
  acaoCriarContaBancaria,
  acaoCriarContaDoFinanceiro,
  acaoQuitarContaDoFinanceiro,
  acaoSair,
  acaoTransferirEntreContas,
} from '../acoes';
import { secao } from '../secoes';
import { AvisoDeRecusa } from '@/app/admin/aviso-de-recusa';
import { marcaDaRecusa } from '../falha-da-leitura';

/**
 * O que a casa deve e o que tem a receber (bloco 51, SPEC §3.10).
 *
 * A tela abre em **três números e uma lista ordenada por vencimento**, porque a
 * pergunta de quem entra aqui é sempre a mesma: *o que vence agora, e sobra
 * quanto?* Contas pagas são histórico e ficam atrás de um filtro — numa
 * barbearia com dois anos de operação elas são a esmagadora maioria das linhas.
 *
 * Densidade de admin: quem abre esta tela abre no fim do expediente, com o
 * notebook do balcão, e rolagem custa tempo. Cada conta é uma linha; o
 * formulário de quitação mora dentro dela, dobrado.
 */

export const metadata: Metadata = {
  title: 'Contas',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const FALHA: Record<string, string> = {
  conta_nao_encontrada: 'Esta conta não existe mais.',
  conta_nao_aberta: 'Esta conta já foi paga ou cancelada.',
  valor_invalido: 'Confira o valor: use só números, como 250,00.',
  valor_pago_invalido: 'Confira quanto foi pago — e se há esse dinheiro na gaveta.',
  descricao_obrigatoria: 'Diga do que é a conta.',
  vencimento_invalido: 'Confira a data de vencimento.',
  categoria_invalida: 'Esta categoria não existe.',
  conta_bancaria_invalida: 'Esta conta não existe.',
  direcao_incompativel: 'A categoria escolhida é do outro lado: receita não classifica despesa.',
  mesma_conta: 'Escolha duas contas diferentes.',
  motivo_obrigatorio: 'Escreva o motivo do cancelamento.',
  nome_repetido: 'Já existe uma com esse nome.',
  mfa_required: 'Confirme o código do segundo fator para continuar.',
  forbidden: 'Sua conta não mexe no financeiro.',
  invalid_request: 'Confira os dados e tente de novo.',
  request_failed: 'Não deu para salvar. Tente de novo.',
};

const SUCESSO: Record<string, string> = {
  criada: 'Conta lançada.',
  quitada: 'Conta quitada.',
  cancelada: 'Conta cancelada. Ela sai do total e fica no histórico.',
  categoria: 'Categoria criada.',
  conta: 'Conta criada.',
  transferida: 'Transferência registrada.',
};

/**
 * O sinal vem **antes** do símbolo: `−R$ 3.812,90`, não `R$ −3.812,90`.
 *
 * A segunda forma lê-se como se existisse uma moeda negativa, e a sobra
 * projetada é justamente o número que mais aparece negativo nesta tela — é a
 * resposta para "se eu pagar tudo, sobra quanto?" quando a resposta é "não
 * sobra".
 */

/** "15/11" — o vencimento no calendário, sem o ano quando ele é o corrente. */
function dataCurta(iso: string, hoje: string): string {
  const [ano, mes, dia] = iso.split('-');
  if (!ano || !mes || !dia) return iso;
  return ano === hoje.slice(0, 4) ? `${dia}/${mes}` : `${dia}/${mes}/${ano}`;
}

function Linha({
  conta,
  hoje,
}: {
  readonly conta: ContaDoFinanceiro;
  readonly hoje: string;
}) {
  const aberta = conta.estado === 'aberta';

  return (
    <li>
      <article className={`item-cadastro${aberta ? '' : ' item-cadastro--fora'}`}>
        <div className="item-cadastro__cabeca">
          <div className="item-cadastro__quem">
            <h3 className="item-cadastro__nome">{conta.descricao}</h3>
            <p className="item-cadastro__linha">
              {dataCurta(conta.vencimentoEm, hoje)} · {conta.categoriaNome ?? 'Sem categoria'}
              {conta.estado === 'paga' && conta.valorPagoCents !== null
                ? ` · pagou ${reais(conta.valorPagoCents)}${conta.pagaPelaGaveta ? ' pela gaveta' : ''}`
                : null}
              {conta.estado === 'cancelada' ? ' · cancelada' : null}
            </p>
            {aberta ? (
              <p
                className={
                  conta.vencida ? 'item-cadastro__linha item-cadastro__risco' : 'item-cadastro__linha'
                }
              >
                {conta.prazo}
              </p>
            ) : null}
          </div>
          <span className="conta__valor tabular">{reais(conta.valorCents)}</span>
        </div>

        {aberta ? (
          <>
            <details className="dobra">
              <summary className="dobra__titulo">
                {VERBO_DA_DIRECAO[conta.direcao]}
              </summary>
              <form action={acaoQuitarContaDoFinanceiro} className="formulario">
                <input name="contaId" type="hidden" value={conta.id} />

                <div className="campos-lado">
                  <div className="ui-field">
                    <label className="ui-field__label" htmlFor={`pago-${conta.id}`}>
                      Quanto {conta.direcao === 'pagar' ? 'saiu' : 'entrou'}
                    </label>
                    <input
                      className="ui-field__input"
                      defaultValue={reaisDoCampo(conta.valorCents)}
                      id={`pago-${conta.id}`}
                      inputMode="decimal"
                      name="valorPagoCents"
                      required
                    />
                  </div>

                  <div className="ui-field">
                    <label className="ui-field__label" htmlFor={`quando-${conta.id}`}>
                      Em que dia
                    </label>
                    <input
                      className="ui-field__input"
                      defaultValue={hoje}
                      id={`quando-${conta.id}`}
                      name="pagaEm"
                      required
                      type="date"
                    />
                  </div>
                </div>

                <div className="ui-field">
                  <label className="ui-field__label" htmlFor={`gaveta-${conta.id}`}>
                    Por onde
                  </label>
                  <select
                    className="ui-field__input"
                    defaultValue="0"
                    id={`gaveta-${conta.id}`}
                    name="pelaGaveta"
                  >
                    <option value="0">Por fora da gaveta (banco, Pix, cartão)</option>
                    <option value="1">Pela gaveta do caixa</option>
                  </select>
                  <p className="ui-field__hint">
                    Pela gaveta, o valor entra no fechamento do dia. Precisa de caixa aberto.
                  </p>
                </div>

                <button className="ui-button ui-button--primary ui-button--block" type="submit">
                  {conta.direcao === 'pagar' ? 'Registrar pagamento' : 'Registrar recebimento'}
                </button>
              </form>
            </details>

            <details className="dobra">
              <summary className="dobra__titulo">Cancelar</summary>
              <form action={acaoCancelarContaDoFinanceiro} className="formulario">
                <input name="contaId" type="hidden" value={conta.id} />
                <div className="ui-field">
                  <label className="ui-field__label" htmlFor={`motivo-${conta.id}`}>
                    Por quê
                  </label>
                  <input
                    className="ui-field__input"
                    id={`motivo-${conta.id}`}
                    name="motivo"
                    placeholder="Nota lançada em duplicidade"
                    required
                  />
                  <p className="ui-field__hint">
                    Cancelar tira do total e mantém a linha no histórico. Nada aqui se apaga.
                  </p>
                </div>
                <button className="ui-button ui-button--ghost ui-button--block" type="submit">
                  Cancelar esta conta
                </button>
              </form>
            </details>
          </>
        ) : null}
      </article>
    </li>
  );
}

function NovaConta({
  categorias,
  hoje,
}: {
  readonly categorias: readonly CategoriaFinanceira[];
  readonly hoje: string;
}) {
  return (
    <details className="dobra">
      {/* A ação principal desta tela: o trabalho dela é lançar conta, e em
          repouso não havia destaque nenhum — só o cartão vermelho da sobra. */}
      <summary className="dobra__titulo dobra__titulo--principal">Lançar uma conta</summary>
      <form action={acaoCriarContaDoFinanceiro} className="formulario">
        <div className="ui-field">
          <label className="ui-field__label" htmlFor="nova-descricao">
            Do que é
          </label>
          <input
            className="ui-field__input"
            id="nova-descricao"
            name="descricao"
            placeholder="Distribuidora São Paulo"
            required
          />
        </div>

        <div className="campos-lado">
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="nova-direcao">
              Tipo
            </label>
            <select className="ui-field__input" defaultValue="pagar" id="nova-direcao" name="direcao">
              {DIRECOES_DA_CONTA.map((d) => (
                <option key={d} value={d}>
                  {ROTULO_DA_DIRECAO[d]}
                </option>
              ))}
            </select>
          </div>

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="nova-valor">
              Valor
            </label>
            <input
              className="ui-field__input"
              id="nova-valor"
              inputMode="decimal"
              name="valorCents"
              placeholder="480,00"
              required
            />
          </div>

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="nova-vencimento">
              Vence em
            </label>
            <input
              className="ui-field__input"
              defaultValue={hoje}
              id="nova-vencimento"
              name="vencimentoEm"
              required
              type="date"
            />
          </div>
        </div>

        <div className="ui-field">
          <label className="ui-field__label" htmlFor="nova-categoria">
            Categoria
          </label>
          <select className="ui-field__input" defaultValue="" id="nova-categoria" name="categoriaId">
            <option value="">Sem categoria</option>
            {categorias
              .filter((c) => c.ativa)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nome} ({ROTULO_DA_CATEGORIA_FINANCEIRA[c.direcao].toLowerCase()})
                </option>
              ))}
          </select>
          <p className="ui-field__hint">
            É a categoria que faz o relatório do mês responder <em>em quê</em> o dinheiro foi.
          </p>
        </div>

        <button className="ui-button ui-button--primary ui-button--block" type="submit">
          Lançar conta
        </button>
      </form>
    </details>
  );
}

function Transferencia({
  contas,
  hoje,
  chave,
}: {
  readonly contas: readonly ContaBancaria[];
  readonly hoje: string;
  readonly chave: string;
}) {
  if (contas.length < 2) {
    return (
      <details className="dobra">
        <summary className="dobra__titulo">Transferir entre contas</summary>
        <div className="formulario">
          <p className="painel__nota">
            Para transferir são precisas duas contas. Cadastre onde o dinheiro fica — a gaveta e o
            banco, por exemplo — e o depósito passa a ter de onde e para onde.
          </p>
          <form action={acaoCriarContaBancaria} className="formulario">
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="conta-nome">
                Nome da conta
              </label>
              <input
                className="ui-field__input"
                id="conta-nome"
                name="nome"
                placeholder="Banco do Brasil"
                required
              />
            </div>
            <button className="ui-button ui-button--secondary ui-button--block" type="submit">
              Criar conta
            </button>
          </form>
        </div>
      </details>
    );
  }

  return (
    <details className="dobra">
      <summary className="dobra__titulo">Transferir entre contas</summary>
      <form action={acaoTransferirEntreContas} className="formulario">
        {/* A chave nasce com a página e viaja no formulário: o segundo toque no
            botão manda a mesma, e a API devolve a transferência já feita. */}
        <input name="chave" type="hidden" value={chave} />
        <div className="campos-lado">
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="transf-de">
              De
            </label>
            <select className="ui-field__input" id="transf-de" name="deContaId">
              {contas.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nome}
                </option>
              ))}
            </select>
          </div>

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="transf-para">
              Para
            </label>
            <select
              className="ui-field__input"
              defaultValue={contas[1]?.id}
              id="transf-para"
              name="paraContaId"
            >
              {contas.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nome}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="campos-lado">
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="transf-valor">
              Valor
            </label>
            <input
              className="ui-field__input"
              id="transf-valor"
              inputMode="decimal"
              name="valorCents"
              placeholder="700,00"
              required
            />
          </div>

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="transf-dia">
              Em que dia
            </label>
            <input
              className="ui-field__input"
              defaultValue={hoje}
              id="transf-dia"
              name="quandoEm"
              required
              type="date"
            />
          </div>
        </div>

        <p className="ui-field__hint">
          Saindo da gaveta, o valor sai como sangria e entra na outra conta. Precisa de caixa aberto.
        </p>

        <button className="ui-button ui-button--primary ui-button--block" type="submit">
          Registrar transferência
        </button>
      </form>
    </details>
  );
}

export default async function FinanceiroPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const query = await searchParams;
  const fechadas = first(query['fechadas']) === '1';

  const [agenda, categorias, contas, transferencias] = await Promise.all([
    agendaDoFinanceiro(token, fechadas),
    categoriasDoFinanceiro(token),
    contasBancarias(token),
    transferenciasDoFinanceiro(token),
  ]);

  const erro = first(query['erro']);
  const salvo = first(query['salvo']);
  /**
   * Uma chave por montagem da página, gerada no servidor.
   *
   * `randomUUID` é o único ponto desta tela que olha para fora do pedido, e é
   * de propósito: ela precisa ser diferente a cada vez que a tela é aberta e a
   * mesma dentro de uma abertura. Um valor derivado do formulário faria duas
   * transferências legítimas iguais no mesmo dia colidirem — e elas acontecem.
   */
  const chaveDaTransferencia = randomUUID();

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

  if (!agenda.ok) {
    if (agenda.code === 'mfa_required' || agenda.code === 'mfa_setup_required') {
      redirect('/admin/seguranca?de=financeiro');
    }
    return (
      <main className="ui-container painel__conteudo" {...secao('financeiro')}>
        {topo}
        <div className="ui-alert ui-alert--warning" role="alert" {...marcaDaRecusa(agenda.code)}>
          {FALHA[agenda.code] ?? FALHA['request_failed']}{' '}
          <a className="ui-button ui-button--secondary painel__saida" href="/admin/dia">
            Voltar ao dia
          </a>
        </div>
      </main>
    );
  }

  const { contas: lista, resumo, hoje } = agenda.dados;
  const aPagar = lista.filter((c) => c.direcao === 'pagar');
  const aReceber = lista.filter((c) => c.direcao === 'receber');
  const listaDeCategorias = categorias.ok ? categorias.dados.categorias : [];
  const listaDeContas = contas.ok ? contas.dados.contas : [];
  const ultimasTransferencias = transferencias.ok ? transferencias.dados.transferencias : [];

  return (
    <main className="ui-container painel__conteudo" {...secao('financeiro')}>
      {topo}

      <h1 className="painel__titulo">Contas</h1>
      <p className="painel__sub">O que a casa deve e o que tem a receber, fora da comanda.</p>

      {erro ? (
        <AvisoDeRecusa erro={erro} mapa={FALHA} className="painel__aviso" />
      ) : null}

      {salvo ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          {SUCESSO[salvo] ?? 'Pronto.'}
        </div>
      ) : null}

      <section className="resumo-contas">
        <div className="resumo-contas__numeros">
        <article className="gaveta">
          <p className="gaveta__rotulo">A pagar</p>
          <p className="gaveta__valor tabular">{reais(resumo.aPagarCents)}</p>
          <p className="gaveta__quem">
            {resumo.vencidoAPagarCents > 0
              ? `${reais(resumo.vencidoAPagarCents)} já venceu`
              : 'nada vencido'}
          </p>
        </article>

        <article className="gaveta">
          <p className="gaveta__rotulo">A receber</p>
          <p className="gaveta__valor tabular">{reais(resumo.aReceberCents)}</p>
          <p className="gaveta__quem">
            {resumo.vencidoAReceberCents > 0
              ? `${reais(resumo.vencidoAReceberCents)} atrasado`
              : 'nada atrasado'}
          </p>
        </article>

        <article className="gaveta">
          <p className="gaveta__rotulo">Sobra projetada</p>
          <p className="gaveta__valor tabular">{reais(resumo.saldoProjetadoCents)}</p>
          <p className="gaveta__quem">se pagar e receber tudo</p>
        </article>
        </div>
      </section>

      <NovaConta categorias={listaDeCategorias} hoje={hoje} />
      <Transferencia chave={chaveDaTransferencia} contas={listaDeContas} hoje={hoje} />

      <details className="dobra">
        <summary className="dobra__titulo">Criar categoria</summary>
        <form action={acaoCriarCategoriaDoFinanceiro} className="formulario">
          <div className="campos-lado">
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="cat-nome">
                Nome
              </label>
              <input
                className="ui-field__input"
                id="cat-nome"
                name="nome"
                placeholder="Aluguel"
                required
              />
            </div>
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="cat-direcao">
                Serve para
              </label>
              <select className="ui-field__input" defaultValue="pagar" id="cat-direcao" name="direcao">
                {DIRECOES_DA_CONTA.map((d) => (
                  <option key={d} value={d}>
                    {ROTULO_DA_CATEGORIA_FINANCEIRA[d]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <button className="ui-button ui-button--secondary ui-button--block" type="submit">
            Criar categoria
          </button>
        </form>
      </details>

      {lista.length === 0 ? (
        <section className="ui-card vazio">
          <h2 className="vazio__titulo">Nenhuma conta em aberto</h2>
          <p>
            Lance aqui o que a barbearia paga todo mês — aluguel, distribuidora, contador — e o que
            entra fora da comanda, como o aluguel da cadeira. O que vence primeiro fica no topo.
          </p>
        </section>
      ) : (
        <>
          <section className="painel__grupo">
            <h2 className="rotulo">A pagar ({aPagar.length})</h2>
            {aPagar.length === 0 ? (
              <p className="painel__nota">Nada a pagar neste recorte.</p>
            ) : (
              <ul className="lista-cadastro">
                {aPagar.map((conta) => (
                  <Linha conta={conta} hoje={hoje} key={conta.id} />
                ))}
              </ul>
            )}
          </section>

          <section className="painel__grupo">
            <h2 className="rotulo">A receber ({aReceber.length})</h2>
            {aReceber.length === 0 ? (
              <p className="painel__nota">Nada a receber neste recorte.</p>
            ) : (
              <ul className="lista-cadastro">
                {aReceber.map((conta) => (
                  <Linha conta={conta} hoje={hoje} key={conta.id} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <p className="painel__nota">
        <a className="ui-button ui-button--ghost" href={`/admin/financeiro${fechadas ? '' : '?fechadas=1'}`}>
          {fechadas ? 'Ver só o que está em aberto' : 'Ver também as pagas e canceladas'}
        </a>
      </p>

      {ultimasTransferencias.length > 0 ? (
        <section className="painel__grupo">
          <h2 className="rotulo">Últimas transferências</h2>
          <ul className="lista-cadastro">
            {ultimasTransferencias.map((t) => (
              <li key={t.id}>
                <article className="item-cadastro">
                  <div className="item-cadastro__cabeca">
                    <div className="item-cadastro__quem">
                      <h3 className="item-cadastro__nome">
                        {t.deNome} → {t.paraNome}
                      </h3>
                      <p className="item-cadastro__linha">
                        {dataCurta(t.quandoEm, hoje)} · {t.criadaPor}
                      </p>
                    </div>
                    <span className="conta__valor tabular">{reais(t.valorCents)}</span>
                  </div>
                </article>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
