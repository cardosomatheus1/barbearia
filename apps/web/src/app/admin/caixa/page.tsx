import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { caixaDaUnidade, faturamentoDeHoje, type MovimentoDoCaixa, type SessaoDeCaixa } from '@/lib/admin-api';
import { painelOuDesvio } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { reaisDoCampo } from '@/lib/dinheiro';
import { acaoAbrirCaixa, acaoFecharCaixa, acaoMovimentarCaixa, acaoSair } from '../acoes';
import { BalcaoNav } from '../balcao-nav';

/**
 * O caixa: a gaveta com dono.
 *
 * A decisão que molda a tela é o **fechamento cego**: o esperado não aparece em
 * lugar nenhum enquanto o caixa está aberto para fechamento. Quem conta digita
 * o que contou, e só então vê a diferença. Mostrar o esperado antes transforma
 * a conferência em "digitar o número que está na tela", que é o mesmo que não
 * conferir.
 *
 * O esperado **aparece** durante o dia, no cartão do topo — ali ele serve para
 * a recepção saber se dá para dar troco, e não para colar no fechamento.
 */

export const metadata: Metadata = {
  title: 'Caixa',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const FALHA: Record<string, string> = {
  ja_aberto: 'Já existe um caixa aberto nesta unidade.',
  nenhum_aberto: 'Não há caixa aberto. Abra o caixa antes.',
  sangria_maior_que_a_gaveta: 'Não há esse valor na gaveta. Confira quanto tem antes de tirar.',
  valor_invalido: 'Confira o valor: use só números, como 150,00.',
  mfa_required: 'Confirme o código do segundo fator para continuar.',
  mfa_setup_required: 'Ative o segundo fator antes de acessar o caixa.',
  forbidden: 'Sua conta não abre nem fecha o caixa.',
  invalid_request: 'Confira os dados e tente de novo.',
  request_failed: 'Não deu para salvar. Tente de novo.',
};

const NOME_DO_MOVIMENTO: Record<string, string> = {
  opening: 'Abertura',
  sale: 'Venda',
  debt_payment: 'Fiado recebido',
  withdrawal: 'Sangria',
  supply: 'Suprimento',
  adjustment: 'Ajuste',
};

const reais = (centavos: number): string => `R$ ${reaisDoCampo(centavos)}`;

/** "13:42" no fuso da unidade — o servidor já mandou o instante em ISO. */
const hora = (iso: string, timezone: string): string =>
  new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  }).format(new Date(iso));

function Movimento({
  movimento,
  timezone,
}: {
  readonly movimento: MovimentoDoCaixa;
  readonly timezone: string;
}) {
  const saiu = movimento.amountCents < 0;
  return (
    <li className="movimento">
      <div className="movimento__quem">
        <span className="movimento__tipo">
          {NOME_DO_MOVIMENTO[movimento.kind] ?? movimento.kind}
        </span>
        <span className="movimento__detalhe">
          {hora(movimento.createdAt, timezone)} · {movimento.createdByName}
          {movimento.reason ? ` · ${movimento.reason}` : ''}
        </span>
      </div>
      <span className={`movimento__valor${saiu ? ' movimento__valor--saiu' : ''}`}>
        {saiu ? '−' : '+'} {reais(Math.abs(movimento.amountCents))}
      </span>
    </li>
  );
}

function Fechado({ sessao, timezone }: { readonly sessao: SessaoDeCaixa; readonly timezone: string }) {
  const bateu = sessao.differenceCents === 0;
  return (
    <li className="fechamento">
      <div className="fechamento__quando">
        <span className="fechamento__data">
          {new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', timeZone: timezone })
            .format(new Date(sessao.openedAt))}
        </span>
        <span className="fechamento__quem">{sessao.closedByName ?? sessao.openedByName}</span>
      </div>
      <span className="fechamento__contado">{reais(sessao.countedCents ?? 0)}</span>
      <span
        className={`fechamento__divergencia${bateu ? '' : ' fechamento__divergencia--fora'}`}
      >
        {bateu
          ? 'bateu'
          : `${(sessao.differenceCents ?? 0) > 0 ? 'sobrou ' : 'faltou '}${reais(
              Math.abs(sessao.differenceCents ?? 0),
            )}`}
      </span>
    </li>
  );
}

export default async function CaixaPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const query = await searchParams;

  const [caixa, faturamento] = await Promise.all([
    caixaDaUnidade(token),
    faturamentoDeHoje(token),
  ]);

  const erro = first(query['erro']);
  const salvo = first(query['salvo']) === '1';
  const divergencia = first(query['divergencia']);

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

  if (!caixa.ok) {
    // Segundo fator não é erro: é um passo. Mandar para lá com o destino junto
    // evita a tela sem saída que "sem permissão" produziria numa conta que tem
    // permissão.
    if (caixa.code === 'mfa_required' || caixa.code === 'mfa_setup_required') {
      redirect('/admin/seguranca?de=caixa');
    }
    return (
      <main className="ui-container painel__conteudo">
        {topo}
        <div className="ui-alert ui-alert--warning" role="alert">
          {FALHA[caixa.code] ?? FALHA['request_failed']} <a href="/admin/dia">Voltar ao dia</a>
        </div>
      </main>
    );
  }

  const { aberto, historico, timezone } = caixa.dados;

  return (
    <main className="ui-container painel__conteudo">
      {topo}
      <BalcaoNav atual="/admin/caixa" />

      <h1 className="painel__titulo">Caixa</h1>

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

      {divergencia !== undefined ? (
        <div
          className={`ui-alert painel__aviso ${
            Number(divergencia) === 0 ? 'ui-alert--success' : 'ui-alert--warning'
          }`}
          role="status"
        >
          {Number(divergencia) === 0
            ? 'Caixa fechado e a gaveta bateu com o esperado.'
            : `Caixa fechado. ${Number(divergencia) > 0 ? 'Sobrou' : 'Faltou'} ${reais(
                Math.abs(Number(divergencia)),
              )} — a diferença ficou registrada no seu nome.`}
        </div>
      ) : null}

      {aberto ? (
        <>
          <section className="gaveta">
            <p className="gaveta__rotulo">Na gaveta agora</p>
            <p className="gaveta__valor">{reais(aberto.esperadoAgoraCents ?? 0)}</p>
            <p className="gaveta__quem">
              Aberto por {aberto.openedByName} às {hora(aberto.openedAt, timezone)} com{' '}
              {reais(aberto.openingCents)} de troco
            </p>
          </section>

          {faturamento.ok ? (
            <section className="resumo-dia">
              <h2 className="resumo-dia__titulo">Hoje</h2>
              <dl className="resumo-dia__lista">
                <div className="resumo-dia__item">
                  <dt>Recebido</dt>
                  <dd>{reais(faturamento.dados.recebidoCents)}</dd>
                </div>
                <div className="resumo-dia__item">
                  <dt>Fiado</dt>
                  <dd>{reais(faturamento.dados.fiadoCents)}</dd>
                </div>
                <div className="resumo-dia__item">
                  <dt>Gorjeta</dt>
                  <dd>{reais(faturamento.dados.gorjetaCents)}</dd>
                </div>
                <div className="resumo-dia__item">
                  <dt>Comandas</dt>
                  <dd>{faturamento.dados.comandas}</dd>
                </div>
              </dl>
              <p className="resumo-dia__nota">
                Fiado não entra no recebido: ele vira receita quando o cliente volta e paga.
              </p>
            </section>
          ) : null}

          <section className="cartao-balcao">
            <h2 className="cartao-balcao__titulo">Movimento</h2>
            {aberto.movimentos.length === 0 ? (
              <p className="vazio">Nenhum movimento ainda.</p>
            ) : (
              <ul className="movimentos">
                {aberto.movimentos.map((movimento) => (
                  <Movimento key={movimento.id} movimento={movimento} timezone={timezone} />
                ))}
              </ul>
            )}
          </section>

          <details className="dobra">
            <summary className="dobra__titulo">Sangria ou suprimento</summary>
            <form action={acaoMovimentarCaixa} className="formulario">
              <div className="ui-field">
                <label className="ui-field__label" htmlFor="kind">
                  O que aconteceu
                </label>
                <select className="ui-field__input" defaultValue="withdrawal" id="kind" name="kind">
                  <option value="withdrawal">Tirei dinheiro da gaveta (sangria)</option>
                  <option value="supply">Coloquei dinheiro na gaveta (suprimento)</option>
                </select>
              </div>

              <div className="ui-field">
                <label className="ui-field__label" htmlFor="amountCents">
                  Quanto
                </label>
                <input
                  className="ui-field__input"
                  id="amountCents"
                  inputMode="decimal"
                  name="amountCents"
                  placeholder="150,00"
                  required
                />
              </div>

              <div className="ui-field">
                <label className="ui-field__label" htmlFor="reason">
                  Por quê
                </label>
                <input
                  className="ui-field__input"
                  id="reason"
                  maxLength={200}
                  minLength={3}
                  name="reason"
                  placeholder="Depósito no banco"
                  required
                />
                <p className="ui-field__hint">
                  Fica no seu nome. É o que responde a pergunta do dia seguinte.
                </p>
              </div>

              <button className="ui-button ui-button--primary ui-button--block" type="submit">
                Registrar
              </button>
            </form>
          </details>

          <details className="dobra dobra--fechar">
            <summary className="dobra__titulo">Fechar o caixa</summary>
            <form action={acaoFecharCaixa} className="formulario">
              <div className="ui-field">
                <label className="ui-field__label" htmlFor="countedCents">
                  Quanto você contou na gaveta
                </label>
                <input
                  className="ui-field__input"
                  id="countedCents"
                  inputMode="decimal"
                  name="countedCents"
                  placeholder="0,00"
                  required
                />
                <p className="ui-field__hint">
                  Conte antes de olhar o esperado. A diferença aparece depois, registrada no seu
                  nome — inclusive quando é zero.
                </p>
              </div>

              <div className="ui-field">
                <label className="ui-field__label" htmlFor="notes">
                  Observação <span className="ui-field__opcional">(opcional)</span>
                </label>
                <input
                  className="ui-field__input"
                  id="notes"
                  maxLength={500}
                  name="notes"
                  placeholder="Faltou troco de 20"
                />
              </div>

              <button className="ui-button ui-button--primary ui-button--block" type="submit">
                Fechar caixa
              </button>
            </form>
          </details>
        </>
      ) : (
        <section className="cartao-balcao">
          <h2 className="cartao-balcao__titulo">O caixa está fechado</h2>
          <p className="cartao-balcao__texto">
            Abra com o troco que ficou na gaveta. Sem caixa aberto não dá para fechar comanda: a
            venda precisa saber em qual gaveta entrou, senão a diferença do fim do dia não tem dono.
          </p>
          <form action={acaoAbrirCaixa} className="formulario">
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="openingCents">
                Troco na gaveta
              </label>
              <input
                autoFocus
                className="ui-field__input"
                id="openingCents"
                inputMode="decimal"
                name="openingCents"
                placeholder="200,00"
                required
              />
            </div>
            <button className="ui-button ui-button--primary ui-button--block" type="submit">
              Abrir caixa
            </button>
          </form>
        </section>
      )}

      <section className="cartao-balcao">
        <h2 className="cartao-balcao__titulo">Fechamentos anteriores</h2>
        {historico.length === 0 ? (
          <p className="vazio">Nenhum caixa fechado ainda.</p>
        ) : (
          <ul className="fechamentos">
            {historico.map((sessao) => (
              <Fechado key={sessao.id} sessao={sessao} timezone={timezone} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
