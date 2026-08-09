import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  catalogoDoBalcao,
  comandaAberta,
  cobrancasDaComanda,
  type Comanda,
  type CobrancaDaComandaNaTela,
  type ItemDaComandaNaTela,
} from '@/lib/admin-api';
import { qrCodeSvg } from '@/lib/qrcode';
import { painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { reaisDoCampo } from '@/lib/dinheiro';
import {
  acaoAdicionarItem,
  acaoAjustarComanda,
  acaoCancelarCobranca,
  acaoCobrarComanda,
  acaoFecharComanda,
  acaoRemoverItem,
  acaoSair,
} from '../../acoes';
import { BalcaoNav } from '../../balcao-nav';
import { secao } from '../../secoes';

/**
 * A comanda: do atendimento ao dinheiro.
 *
 * Três decisões desenham esta tela.
 *
 * **O total é a coisa maior da página.** Quem opera olha para ele o tempo
 * inteiro, e o cliente do outro lado do balcão também — ler errado o valor é o
 * defeito mais caro que um PDV pode ter.
 *
 * **O pagamento aceita três formas.** "Cem no pix e o resto em dinheiro" é
 * rotina, e um campo só transformaria isso em duas comandas ou numa conta feita
 * de cabeça.
 *
 * **Fiado só aparece se der.** O limite do cliente vem junto da comanda, e a
 * opção some quando a conta não cabe nele — oferecer para depois recusar é
 * prometer na frente do cliente o que o sistema vai negar.
 */

export const metadata: Metadata = {
  title: 'Comanda',
  robots: { index: false, follow: false },
};

interface Props {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const FALHA: Record<string, string> = {
  comanda_fechada: 'Esta comanda já foi fechada.',
  comanda_nao_encontrada: 'Esta comanda não existe mais.',
  caixa_fechado: 'Abra o caixa antes de fechar a comanda.',
  pagamento_invalido: 'O pagamento não fecha com o total. Confira os valores.',
  item_invalido: 'Confira o item: descrição, quantidade e preço.',
  desconto_invalido: 'Desconto inválido.',
  servico_desconhecido: 'Este serviço ou profissional não existe nesta barbearia.',
  sem_pagamento: 'Informe pelo menos uma forma de pagamento.',
  valor_invalido: 'Confira o valor: use só números, como 49,90.',
  cobranca_em_curso: 'Já existe um Pix em aberto para esta comanda.',
  cobranca_encerrada: 'Esta cobrança já foi encerrada.',
  comanda_sem_valor: 'Acrescente o que foi feito antes de cobrar.',
  mfa_required: 'Confirme o código do segundo fator para continuar.',
  forbidden: 'Sua conta não fecha comanda.',
  request_failed: 'Não deu para salvar. Tente de novo.',
};

const reais = (centavos: number): string => `R$ ${reaisDoCampo(centavos)}`;

/**
 * Os meios que o adquirente sabe emitir, na ordem em que o balcão os usa.
 *
 * Pix primeiro e como ação primária: é o que a maioria dos clientes escolhe, é
 * o mais barato para a barbearia, e é o único que confirma sem ninguém digitar
 * nada. Cartão e link são o mesmo mecanismo com outra cara — o link existe para
 * mandar por WhatsApp a quem **não** está no balcão, que é o caso do sinal e da
 * conta que ficou para depois.
 */
const MEIOS = [
  { valor: 'pix', rotulo: 'Pix' },
  { valor: 'cartao', rotulo: 'Cartão' },
  { valor: 'link', rotulo: 'Link para mandar' },
] as const;

const NOME_DA_FORMA: Record<string, string> = {
  cash: 'Dinheiro',
  pix: 'Pix',
  debit: 'Débito',
  credit: 'Crédito',
  link: 'Link de pagamento',
  transfer: 'Transferência',
  fiado: 'Fiado',
};

/**
 * O Pix na tela, quando existe um em curso.
 *
 * Três decisões desenham este bloco.
 *
 * **O copia-e-cola vale tanto quanto o QR Code.** Quem paga pelo mesmo celular
 * que abriu a tela não consegue fotografar a própria tela — e é metade dos
 * casos quando o cliente pega o aparelho do balcão. Os dois aparecem juntos, o
 * texto selecionável.
 *
 * **O código tem fundo branco próprio.** O painel é escuro, e leitor de QR Code
 * precisa de contraste com área tranquila em volta. Um código desenhado direto
 * sobre o fundo do tema simplesmente não lê.
 *
 * **Enquanto ele está na tela, o "Receber" some.** Não é economia de espaço: era
 * o achado HIGH da revisão de segurança do bloco 35. Oferecer as duas coisas
 * lado a lado convidava a fechar na mão com o QR Code vivo — e o pagamento que
 * chegasse depois derrubava o webhook e parava a conferência da barbearia
 * inteira. Quem quer receber de outro jeito cancela o Pix primeiro, que é uma
 * decisão explícita.
 *
 * **"Pago" não some com o bloco.** Ele só aparece com a comanda ainda aberta —
 * que é exatamente o caso em que o caixa estava fechado quando o dinheiro
 * entrou. Sem este aviso, a tela mostraria uma comanda aberta e nada dizendo
 * que o cliente já pagou.
 */
function CobrancaEmCurso({
  cobranca,
  orderId,
}: {
  readonly cobranca: CobrancaDaComandaNaTela;
  readonly orderId: string;
}) {
  const codigo = cobranca.pixCopiaECola ? qrCodeSvg(cobranca.pixCopiaECola) : null;
  const titulo =
    cobranca.meio === 'pix' ? 'Pix' : cobranca.meio === 'link' ? 'Link de pagamento' : 'Cartão';

  if (cobranca.estado === 'pago') {
    return (
      <section className="cartao-balcao cobranca">
        <h2 className="cartao-balcao__titulo">Pagamento recebido</h2>
        <p className="cobranca__recebido">{reais(cobranca.valorCents)}</p>
        {/* Este bloco só aparece com a comanda **aberta**: paga, ela mostra
            "Pago com". Então chegar aqui já significa que o caixa estava
            fechado quando o dinheiro entrou, e é isso que a tela explica. */}
        <p className="cartao-balcao__texto">
          O dinheiro está confirmado. Abra o caixa para fechar a comanda — a venda precisa
          saber em qual gaveta entrou.
        </p>
        <a className="ui-button ui-button--primary ui-button--block" href="/admin/caixa">
          Abrir o caixa
        </a>
      </section>
    );
  }

  return (
    <section className="cartao-balcao cobranca">
      <h2 className="cartao-balcao__titulo">
        {titulo} de {reais(cobranca.valorCents)}
      </h2>

      {codigo ? (
        <div
          className="cobranca__codigo"
          // O SVG é gerado aqui, no servidor, a partir do texto que o
          // adquirente devolveu — não há entrada de usuário no caminho.
          dangerouslySetInnerHTML={{ __html: codigo.svg }}
        />
      ) : null}

      {/*
        O endereço do link é o próprio produto quando o meio é link: ele existe
        para ser mandado a quem **não** está no balcão, então o que a tela
        precisa entregar é um texto copiável, não um botão que abre aqui.
      */}
      {cobranca.url ? (
        <div className="ui-field">
          <label className="ui-field__label" htmlFor="endereco-do-link">
            Mande este endereço ao cliente
          </label>
          <textarea
            className="ui-field__input cobranca__texto"
            id="endereco-do-link"
            readOnly
            rows={2}
            value={cobranca.url}
          />
          <p className="ui-field__hint">
            A página é hospedada pelo adquirente: os dados do cartão não passam por aqui.
          </p>
        </div>
      ) : null}

      {cobranca.pixCopiaECola ? (
        <div className="ui-field">
          <label className="ui-field__label" htmlFor="copia-e-cola">
            Ou copie o código
          </label>
          <textarea
            className="ui-field__input cobranca__texto"
            id="copia-e-cola"
            readOnly
            rows={3}
            value={cobranca.pixCopiaECola}
          />
          <p className="ui-field__hint">
            Quem paga pelo mesmo celular que abriu esta tela usa o código, não a foto.
          </p>
        </div>
      ) : null}

      <p className="cartao-balcao__texto">
        Assim que o adquirente confirmar, a comanda fecha sozinha. Recarregue para conferir.
      </p>

      <form action={acaoCancelarCobranca}>
        <input name="orderId" type="hidden" value={orderId} />
        <input name="chargeId" type="hidden" value={cobranca.id} />
        <button className="ui-button ui-button--ghost ui-button--block" type="submit">
          Cancelar a cobrança
        </button>
      </form>
    </section>
  );
}

function Item({
  item,
  orderId,
  fechada,
}: {
  readonly item: ItemDaComandaNaTela;
  readonly orderId: string;
  readonly fechada: boolean;
}) {
  return (
    <li className="item-comanda">
      <div className="item-comanda__quem">
        <span className="item-comanda__nome">
          {item.quantidade > 1 ? `${item.quantidade}× ` : ''}
          {item.descricao}
        </span>
        {item.professionalName ? (
          <span className="item-comanda__executor">{item.professionalName}</span>
        ) : null}
      </div>

      <span className="item-comanda__valor">
        {reais(item.precoUnitarioCents * item.quantidade)}
      </span>

      {fechada ? null : (
        <form action={acaoRemoverItem}>
          <input name="orderId" type="hidden" value={orderId} />
          <input name="itemId" type="hidden" value={item.id} />
          <button
            aria-label={`Tirar ${item.descricao} da comanda`}
            className="ui-button ui-button--ghost item-comanda__tirar"
            type="submit"
          >
            Tirar
          </button>
        </form>
      )}
    </li>
  );
}

/**
 * Quanto ainda dá para fiar.
 *
 * A mesma conta que o domínio faz — e por isso ela não decide nada, só decide
 * o que **mostrar**. A recusa de verdade está no servidor; aqui é para não
 * oferecer o que vai ser negado na frente do cliente.
 */
function fiadoCabe(comanda: Comanda): boolean {
  if (!comanda.conta) return false;
  const dividaDepois = comanda.totalCents - comanda.conta.saldoCents;
  return dividaDepois <= comanda.conta.limiteCents;
}

export default async function ComandaPage({ params, searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const { id } = await params;
  const query = await searchParams;

  const [comanda, catalogo, cobrancas] = await Promise.all([
    comandaAberta(token, id),
    catalogoDoBalcao(token),
    cobrancasDaComanda(token, id),
  ]);

  const erro = first(query['erro']);
  const pago = first(query['pago']) === '1';
  const salvo = first(query['salvo']) === '1';

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

  if (!comanda.ok) {
    if (comanda.code === 'mfa_required' || comanda.code === 'mfa_setup_required') {
      redirect('/admin/seguranca?de=comanda');
    }
    return (
      <main className="ui-container painel__conteudo" {...secao('comanda')}>
        {topo}
        <div className="ui-alert ui-alert--warning" role="alert">
          {FALHA[comanda.code] ?? FALHA['request_failed']} <a href="/admin/dia">Voltar ao dia</a>
        </div>
      </main>
    );
  }

  const conta = comanda.dados;
  const fechada = conta.status !== 'open';
  const podeFiar = fiadoCabe(conta);
  // A mesma pergunta que a API faz: dar desconto é `finance.view`, que a
  // recepção não tem. Mostrar o formulário para ela só produziria um 403.
  const podeDarDesconto = podeNaTela(estado, 'finance.view');
  /**
   * A cobrança que a tela mostra: a viva, ou a paga que ainda não virou venda.
   *
   * As duas interessam ao balcão pelo mesmo motivo — são as únicas em que ainda
   * há algo a fazer. Recusada e expirada viram histórico, e o botão de cobrar
   * volta.
   */
  const cobrancaDoMomento = cobrancas.ok
    ? cobrancas.dados.cobrancas.find((c) => c.estado === 'aguardando' || c.estado === 'pago')
    : undefined;
  const servicos = catalogo.ok ? catalogo.dados.services : [];
  const profissionais = catalogo.ok ? catalogo.dados.professionals : [];

  return (
    <main className="ui-container painel__conteudo" {...secao('comanda')}>
      {topo}
      <BalcaoNav atual="/admin/comanda" />

      <h1 className="painel__titulo">{conta.customerName ?? 'Comanda avulsa'}</h1>

      {erro ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {FALHA[erro] ?? FALHA['request_failed']}
        </div>
      ) : null}

      {salvo ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Salvo.
        </div>
      ) : null}

      {pago ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Comanda paga.
          {conta.trocoCents > 0 ? ` Troco: ${reais(conta.trocoCents)}.` : ''}
        </div>
      ) : null}

      <section className="cartao-balcao">
        <h2 className="cartao-balcao__titulo">Itens</h2>
        {conta.itens.length === 0 ? (
          <p className="vazio">
            Nada na comanda ainda. Acrescente o que foi feito — o valor de cada item é o que vai
            gerar a comissão do barbeiro.
          </p>
        ) : (
          <ul className="itens-comanda">
            {conta.itens.map((item) => (
              <Item fechada={fechada} item={item} key={item.id} orderId={conta.id} />
            ))}
          </ul>
        )}
      </section>

      <section className="total-comanda">
        <dl className="total-comanda__linhas">
          <div className="total-comanda__linha">
            <dt>Subtotal</dt>
            <dd>{reais(conta.subtotalCents)}</dd>
          </div>
          {conta.descontoCents > 0 ? (
            <div className="total-comanda__linha">
              <dt>Desconto</dt>
              <dd>− {reais(conta.descontoCents)}</dd>
            </div>
          ) : null}
          {conta.gorjetaCents > 0 ? (
            <div className="total-comanda__linha">
              <dt>Gorjeta</dt>
              <dd>{reais(conta.gorjetaCents)}</dd>
            </div>
          ) : null}
        </dl>
        <p className="total-comanda__rotulo">Total</p>
        <p className="total-comanda__valor">{reais(conta.totalCents)}</p>
      </section>

      {fechada ? (
        <section className="cartao-balcao">
          <h2 className="cartao-balcao__titulo">Pago com</h2>
          <ul className="pagamentos">
            {conta.pagamentos.map((pagamento, i) => (
              <li className="pagamentos__item" key={`${pagamento.forma}-${i}`}>
                <span>{NOME_DA_FORMA[pagamento.forma] ?? pagamento.forma}</span>
                <span>{reais(pagamento.valorCents)}</span>
              </li>
            ))}
          </ul>
          <a className="ui-button ui-button--primary ui-button--block" href="/admin/dia">
            Voltar ao dia
          </a>
        </section>
      ) : (
        <>
          <details className="dobra">
            <summary className="dobra__titulo">Acrescentar item</summary>
            <form action={acaoAdicionarItem} className="formulario">
              <input name="orderId" type="hidden" value={conta.id} />
              <input name="tipo" type="hidden" value="service" />

              <div className="ui-field">
                <label className="ui-field__label" htmlFor="descricao">
                  O que foi feito
                </label>
                <input
                  className="ui-field__input"
                  id="descricao"
                  list="servicos-do-catalogo"
                  maxLength={120}
                  name="descricao"
                  placeholder="Barba"
                  required
                />
                <datalist id="servicos-do-catalogo">
                  {servicos.map((servico) => (
                    <option key={servico.id} value={servico.name} />
                  ))}
                </datalist>
              </div>

              <div className="ui-field">
                <label className="ui-field__label" htmlFor="precoUnitarioCents">
                  Preço
                </label>
                <input
                  className="ui-field__input"
                  id="precoUnitarioCents"
                  inputMode="decimal"
                  name="precoUnitarioCents"
                  placeholder="35,00"
                  required
                />
              </div>

              <div className="ui-field">
                <label className="ui-field__label" htmlFor="quantidade">
                  Quantos
                </label>
                <input
                  className="ui-field__input"
                  defaultValue={1}
                  id="quantidade"
                  inputMode="numeric"
                  max={99}
                  min={1}
                  name="quantidade"
                  type="number"
                />
              </div>

              <div className="ui-field">
                <label className="ui-field__label" htmlFor="professionalId">
                  Quem fez
                </label>
                <select className="ui-field__input" id="professionalId" name="professionalId">
                  <option value="">Não informar</option>
                  {profissionais.map((pro) => (
                    <option key={pro.id} value={pro.id}>
                      {pro.name}
                    </option>
                  ))}
                </select>
                <p className="ui-field__hint">
                  É por aqui que a comissão sai certa quando o corte foi com um e a barba com outro.
                </p>
              </div>

              <button className="ui-button ui-button--ghost ui-button--block" type="submit">
                Acrescentar
              </button>
            </form>
          </details>

          {podeDarDesconto ? (
          <details className="dobra">
            <summary className="dobra__titulo">Desconto e gorjeta</summary>
            <form action={acaoAjustarComanda} className="formulario">
              <input name="orderId" type="hidden" value={conta.id} />

              <div className="ui-field">
                <label className="ui-field__label" htmlFor="descontoTipo">
                  Tipo de desconto
                </label>
                <select className="ui-field__input" defaultValue="amount" id="descontoTipo" name="descontoTipo">
                  <option value="amount">Valor em reais</option>
                  <option value="percent">Porcentagem</option>
                </select>
              </div>

              <div className="ui-field">
                <label className="ui-field__label" htmlFor="descontoValor">
                  Quanto
                </label>
                <input
                  className="ui-field__input"
                  defaultValue={conta.descontoCents > 0 ? reaisDoCampo(conta.descontoCents) : ''}
                  id="descontoValor"
                  inputMode="decimal"
                  name="descontoValor"
                  placeholder="10,00"
                />
                <p className="ui-field__hint">
                  Porcentagem vira reais na hora de salvar. Assim o desconto não muda sozinho
                  quando você acrescenta um item depois.
                </p>
              </div>

              <div className="ui-field">
                <label className="ui-field__label" htmlFor="motivo">
                  Motivo <span className="ui-field__opcional">(opcional)</span>
                </label>
                <input
                  className="ui-field__input"
                  id="motivo"
                  maxLength={200}
                  name="motivo"
                  placeholder="Cliente antigo"
                />
              </div>

              <div className="ui-field">
                <label className="ui-field__label" htmlFor="gorjetaCents">
                  Gorjeta
                </label>
                <input
                  className="ui-field__input"
                  defaultValue={conta.gorjetaCents > 0 ? reaisDoCampo(conta.gorjetaCents) : ''}
                  id="gorjetaCents"
                  inputMode="decimal"
                  name="gorjetaCents"
                  placeholder="0,00"
                />
                <p className="ui-field__hint">
                  Entra por fora do desconto: a gorjeta é do barbeiro, não da casa.
                </p>
              </div>

              <button className="ui-button ui-button--ghost ui-button--block" type="submit">
                Salvar
              </button>
            </form>
          </details>
          ) : null}

          {cobrancaDoMomento ? (
            <CobrancaEmCurso cobranca={cobrancaDoMomento} orderId={conta.id} />
          ) : (
            <section className="cartao-balcao">
              <h2 className="cartao-balcao__titulo">Cobrar pelo aparelho</h2>
              <p className="cartao-balcao__texto">
                A comanda fecha sozinha quando o adquirente confirmar.
              </p>
              {/*
                Três formas, três formulários, **um botão primário só** — o Pix.
                A tela não pergunta "qual meio?" antes de mostrar o valor: no
                balcão a pergunta é feita ao cliente em voz alta, e quem opera já
                sabe a resposta quando chega aqui.
              */}
              {MEIOS.map((meio) => (
                <form action={acaoCobrarComanda} key={meio.valor}>
                  <input name="orderId" type="hidden" value={conta.id} />
                  <input name="meio" type="hidden" value={meio.valor} />
                  {/* Gerada quando a tela é montada, como no fechamento: gerá-la
                      na ação daria chave nova a cada envio, e o duplo toque
                      produziria duas cobranças para a mesma conta. */}
                  <input name="idempotencyKey" type="hidden" value={randomUUID()} />
                  <button
                    className={`ui-button ui-button--block ${
                      meio.valor === 'pix' ? 'ui-button--primary' : 'ui-button--ghost'
                    } cobranca__meio`}
                    type="submit"
                  >
                    {meio.rotulo} · {reais(conta.totalCents)}
                  </button>
                </form>
              ))}
            </section>
          )}

          {cobrancaDoMomento ? null : (
          <section className="cartao-balcao">
            <h2 className="cartao-balcao__titulo">Receber</h2>

            {conta.conta ? (
              <p className="cartao-balcao__texto">
                {conta.conta.saldoCents < 0
                  ? `Já deve ${reais(-conta.conta.saldoCents)}. `
                  : ''}
                {conta.conta.limiteCents === 0
                  ? 'Este cliente não tem limite de fiado.'
                  : `Limite de fiado: ${reais(conta.conta.limiteCents)}.`}
              </p>
            ) : null}

            <form action={acaoFecharComanda} className="formulario">
              <input name="orderId" type="hidden" value={conta.id} />
              {/* Gerada aqui, quando a tela é montada: gerá-la na ação daria
                  chave nova a cada envio, e o duplo toque cobraria duas vezes. */}
              <input name="idempotencyKey" type="hidden" value={randomUUID()} />

              {[0, 1, 2].map((i) => (
                <fieldset className="pagamento-linha" key={i}>
                  <legend className="pagamento-linha__legenda">
                    {i === 0 ? 'Pagamento' : `Mais uma forma (opcional)`}
                  </legend>

                  <div className="ui-field">
                    <label className="ui-field__label" htmlFor={`forma${i}`}>
                      Como
                    </label>
                    <select
                      className="ui-field__input"
                      defaultValue={i === 0 ? 'cash' : ''}
                      id={`forma${i}`}
                      name={`forma${i}`}
                    >
                      {i === 0 ? null : <option value="">—</option>}
                      <option value="cash">Dinheiro</option>
                      <option value="pix">Pix</option>
                      <option value="debit">Débito</option>
                      <option value="credit">Crédito</option>
                      <option value="link">Link de pagamento</option>
                      <option value="transfer">Transferência</option>
                      {podeFiar ? <option value="fiado">Fiado</option> : null}
                    </select>
                  </div>

                  <div className="ui-field">
                    <label className="ui-field__label" htmlFor={`valor${i}`}>
                      Quanto
                    </label>
                    <input
                      className="ui-field__input"
                      defaultValue={i === 0 ? reaisDoCampo(conta.totalCents) : ''}
                      id={`valor${i}`}
                      inputMode="decimal"
                      name={`valor${i}`}
                      placeholder="0,00"
                    />
                  </div>
                </fieldset>
              ))}

              <p className="ui-field__hint">
                Em dinheiro, digite o que o cliente entregou: o troco sai da gaveta e fica
                registrado.
              </p>

              <button className="ui-button ui-button--primary ui-button--block" type="submit">
                Receber {reais(conta.totalCents)}
              </button>
            </form>
          </section>
          )}
        </>
      )}
    </main>
  );
}
