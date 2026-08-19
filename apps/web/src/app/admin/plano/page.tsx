import {
  MOTIVOS_DA_CONTESTACAO_DE_COMISSAO,
  ROTULO_DO_MOTIVO_DE_COMISSAO,
} from '@barbearia/core';
import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  clientesDoMarketplace,
  faturasDoPlano,
  opcoesDePlano,
  planoDaBarbearia,
  type FaturaDaBarbearia,
  type OpcaoDePlano,
  type PlanoDaBarbearia,
} from '@/lib/admin-api';
import { painelOuDesvio } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { acaoContestarMarketplace, acaoTrocarDePlano } from '../acoes';
import { secao } from '../secoes';
import { reais } from '@/lib/dinheiro';

/**
 * O plano, para quem paga por ele.
 *
 * A assinatura nasceu no painel da plataforma, e ficar só lá seria o defeito de
 * sempre pelo avesso: o dado existe, é cobrado, e a pessoa de quem se cobra não
 * consegue vê-lo. É também para onde a régua de vencimento do bloco 28 vai
 * apontar — um aviso que diz "sua conta vence em três dias" precisa de uma tela
 * onde o dono confira isso.
 *
 * A tela responde três perguntas, nesta ordem: até quando, quanto e o que vem
 * junto. Nenhuma delas é opinião — todas saem da assinatura.
 */

export const metadata: Metadata = {
  title: 'Plano',
  robots: { index: false, follow: false },
};


const dia = (iso: string): string =>
  new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

/**
 * Quantos dias faltam, contra o instante em que a página é montada.
 *
 * Arredondado para cima: faltando vinte horas, o dono precisa ler "1 dia", não
 * "0 dias" — que ele leria como "venceu".
 */
const faltam = (iso: string): number =>
  Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);

function Estado({ p }: { readonly p: PlanoDaBarbearia }) {
  if (p.estado === 'trialing' && p.testeAte) {
    const dias = faltam(p.testeAte);
    return (
      <div className={`ui-alert ${dias <= 3 ? 'ui-alert--warning' : 'ui-alert--info'}`} role="status">
        {dias > 0 ? (
          <>
            Você está em teste até <strong>{dia(p.testeAte)}</strong> — faltam {dias}{' '}
            {dias === 1 ? 'dia' : 'dias'}. Nada é cobrado até lá.
          </>
        ) : (
          <>O período de teste terminou em {dia(p.testeAte)}.</>
        )}
      </div>
    );
  }

  if (p.estado === 'past_due') {
    return (
      <div className="ui-alert ui-alert--danger" role="alert">
        Há uma cobrança em aberto desde {dia(p.periodoAte)}. A barbearia continua no ar — o extrato
        abaixo mostra o que está em aberto.
      </div>
    );
  }

  if (p.estado === 'canceled') {
    return (
      <div className="ui-alert ui-alert--warning" role="status">
        Assinatura cancelada. A barbearia continua no ar até {dia(p.periodoAte)}.
      </div>
    );
  }

  return (
    <div className="ui-alert ui-alert--info" role="status">
      Assinatura ativa. Próxima renovação em <strong>{dia(p.periodoAte)}</strong>.
    </div>
  );
}

/**
 * O cartão de um plano ao qual se pode mudar.
 *
 * O preço da troca aparece **antes** do botão, e é o que separa esta tela de
 * um formulário: "R$ 75,00 agora pelos 15 dias que faltam" é uma decisão que o
 * dono consegue tomar; "mudar para Business" sozinho não é.
 */
function CartaoDePlano({ o }: { readonly o: OpcaoDePlano }) {
  const bloqueado = o.impedimento !== null;

  return (
    <li className={`plano-opcao ${o.atual ? 'plano-opcao--atual' : ''}`}>
      <p className="plano-opcao__nome">
        {o.nome}
        {o.atual ? <span className="plano__selo">seu plano</span> : null}
      </p>
      <p className="plano-opcao__preco">
        {reais(o.precoCents)}
        <span className="plano-opcao__mes">/mês</span>
      </p>
      <p className="plano-opcao__publico">{o.publico}</p>
      <p className="plano-opcao__cadeiras">
        {o.tetoDeCadeiras === null
          ? 'Cadeiras sem limite'
          : `Até ${o.tetoDeCadeiras} ${o.tetoDeCadeiras === 1 ? 'cadeira' : 'cadeiras'}`}
      </p>

      {o.atual ? null : (
        <>
          <p className="plano-opcao__acerto">
            {o.cobrarCents > 0 ? (
              <>
                <strong>{reais(o.cobrarCents)}</strong> agora, pelos {o.diasRestantes}{' '}
                {o.diasRestantes === 1 ? 'dia que falta' : 'dias que faltam'} deste período.
              </>
            ) : o.creditarCents > 0 ? (
              <>
                <strong>{reais(o.creditarCents)}</strong> de crédito, que abatem a próxima
                mensalidade.
              </>
            ) : (
              <>Sem acerto agora — a mudança vale a partir do próximo período.</>
            )}
          </p>

          {bloqueado ? (
            <p className="plano-opcao__impedimento">{o.impedimento}</p>
          ) : (
            <form action={acaoTrocarDePlano}>
              <input name="planoCode" type="hidden" value={o.code} />
              <input name="idempotencyKey" type="hidden" value={randomUUID()} />
              <button className="ui-button ui-button--ghost plano-opcao__botao" type="submit">
                Mudar para {o.nome}
              </button>
            </form>
          )}
        </>
      )}
    </li>
  );
}

const ESTADO_DA_FATURA: Readonly<Record<FaturaDaBarbearia['estado'], string>> = {
  open: 'Em aberto',
  paid: 'Paga',
  void: 'Cancelada',
};

export default async function PlanoPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ trocado?: string; erro?: string }>;
}) {
  const parametros = await searchParams;
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  // Redireciona sozinha quando não há sessão válida ou a senha inicial não foi
  // trocada; o retorno é o estado do painel, que esta tela não usa.
  await painelOuDesvio(token);

  const [resposta, respostaOpcoes, respostaFaturas, respostaMarketplace] = await Promise.all([
    planoDaBarbearia(token),
    opcoesDePlano(token),
    faturasDoPlano(token),
    clientesDoMarketplace(token),
  ]);

  if (!resposta.ok) {
    return (
      <main className="ui-container painel__conteudo" {...secao('plano')}>
        <h1 className="painel__titulo">Plano</h1>
        <div className="ui-alert ui-alert--danger" role="alert">
          Não deu para carregar o plano. Recarregue a página.
        </div>
      </main>
    );
  }

  const p = resposta.dados;
  const teto = p.cadeiras.teto;
  const cheio = teto !== null && p.cadeiras.emUso >= teto;
  const opcoes = respostaOpcoes.ok ? respostaOpcoes.dados : [];
  const faturas = respostaFaturas.ok ? respostaFaturas.dados : [];
  const marketplace = respostaMarketplace.ok
    ? respostaMarketplace.dados
    : { clientes: [], pendenteCents: 0 };
  const emAberto = faturas.filter((f) => f.estado === 'open');

  return (
    <main className="ui-container painel__conteudo" {...secao('plano')}>
      <h1 className="painel__titulo">Plano</h1>
      <p className="painel__sub">O que a barbearia contratou, e o que vem junto.</p>

      {parametros.trocado ? (
        <div className="ui-alert ui-alert--success" role="status">
          Plano alterado. O acerto do período, quando existe, aparece no extrato abaixo.
        </div>
      ) : null}
      {parametros.erro ? (
        <div className="ui-alert ui-alert--danger" role="alert">
          Não deu para trocar de plano ({parametros.erro}). Confira a mensagem e tente de novo.
        </div>
      ) : null}

      <Estado p={p} />

      <section className="painel__grupo">
        <h2 className="painel__secao">
          {p.plano.nome} · {reais(p.plano.precoCents)}
          <span className="plano__publico">{p.plano.publico}</span>
        </h2>

        <p className="ui-field__label">Cadeiras</p>
        <p className="plano__cadeiras">
          <strong>{p.cadeiras.emUso}</strong>
          {teto === null ? ' cadeiras · sem limite no seu plano' : ` de ${teto}`}
        </p>
        {cheio ? (
          // O limite só é útil se aparecer **antes** de a pessoa tentar
          // cadastrar e levar um erro que não explica nada.
          <p className="plano__aviso">
            Você está no limite do plano. Para abrir mais uma cadeira, suba de plano abaixo — ou
            desligue alguém que não atende mais.
          </p>
        ) : null}
      </section>

      <section className="painel__grupo">
        <h2 className="painel__secao">O que vem no plano</h2>
        <ul className="plano__recursos">
          {p.recursos.map((r) => (
            <li className={`plano__recurso ${r.ligado ? '' : 'plano__recurso--fora'}`} key={r.code}>
              <p className="plano__recurso-nome">
                {r.nome}
                {r.ligado && !r.noPlano ? (
                  // Ligado sem estar no plano é cortesia, e dizer isso evita a
                  // conversa ruim do dia em que ela terminar.
                  <span className="plano__selo">cortesia</span>
                ) : null}
                {!r.ligado ? <span className="plano__selo plano__selo--fora">não incluso</span> : null}
              </p>
              <p className="plano__recurso-sobre">{r.descricao}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="painel__grupo plano-vitrine">
        <h2 className="painel__secao">Mudar de plano</h2>
        {opcoes.length === 0 ? (
          <p className="plano__vazio">
            Não deu para carregar as opções agora. Recarregue a página.
          </p>
        ) : (
          <>
            <p className="painel__nota">
              A troca vale na hora. O que muda no valor é só o que falta deste período — o resto
              entra na próxima mensalidade.
            </p>
            <ul className="plano-opcoes">
              {opcoes.map((o) => (
                <CartaoDePlano key={o.code} o={o} />
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="painel__grupo">
        <h2 className="painel__secao">Como a conta é paga</h2>
        {p.cobranca?.cadastrado ? (
          <>
            <p className="plano-cartao">
              <span className="plano-cartao__bandeira">{p.cobranca.bandeira ?? 'Cartão'}</span>
              <span className="plano-cartao__final">•••• {p.cobranca.final}</span>
              {p.cobranca.validadeMes && p.cobranca.validadeAno ? (
                <span className="plano-cartao__validade">
                  vence {String(p.cobranca.validadeMes).padStart(2, '0')}/{p.cobranca.validadeAno}
                </span>
              ) : null}
            </p>
            <p className="painel__nota">
              A mensalidade é debitada neste cartão no vencimento. Para trocá-lo, fale com o
              suporte.
            </p>
          </>
        ) : (
          // Estado vazio desenhado, e com o que fazer em seguida: sem cartão a
          // cobrança não é automática, e o dono precisa saber disso **antes** de
          // a fatura vencer.
          <div className="plano__vazio">
            <p className="plano-cartao__sem">Nenhum cartão cadastrado.</p>
            <p>
              As faturas são pagas por transferência, e alguém do suporte precisa dar baixa. Para
              deixar automático, fale com o suporte.
            </p>
          </div>
        )}
      </section>

      {/**
        * O que o marketplace trouxe (bloco 72, SPEC §5.2).
        *
        * A seção existe mesmo com a lista vazia, e essa é a decisão: o valor
        * deste bloco é a frase que ela escreve quando não há nada a cobrar.
        * *"Cobrar sobre base própria é a principal fonte de revolta contra
        * Fresha e Booksy"* — a barbearia precisa poder abrir esta tela e ver,
        * nome por nome, que a plataforma só cobra por quem ela trouxe.
        *
        * Um total sem nomes seria uma cobrança que não se confere, e um número
        * que não se confere é o começo de não confiar em nenhum.
        */}
      <section className="painel__grupo">
        <h2 className="painel__secao">Clientes que a busca trouxe</h2>
        <p className="plano__nota">
          A plataforma só cobra por <strong>cliente novo</strong> que chegou pela busca. Quem já
          era da sua base nunca gera comissão, mesmo agendando por lá — e você pode contestar
          qualquer linha antes de ela virar fatura.
        </p>
        {marketplace.clientes.length === 0 ? (
          <p className="plano__vazio">
            Nenhum cliente novo veio pela busca ainda. Quando vier, ele aparece aqui com o valor
            do atendimento e a comissão calculada.
          </p>
        ) : (
          <>
            {marketplace.pendenteCents > 0 ? (
              <p className="plano__aviso">
                {reais(marketplace.pendenteCents)} a faturar no fechamento do mês.
              </p>
            ) : null}
            <div className="ui-scroll-x">
              <table className="plano-faturas">
                <thead>
                  <tr>
                    <th scope="col">Cliente</th>
                    <th scope="col">Atendimento</th>
                    <th scope="col">Valor</th>
                    <th scope="col">Comissão</th>
                    <th scope="col">Situação</th>
                  </tr>
                </thead>
                <tbody>
                  {marketplace.clientes.map((c) => (
                    <tr key={c.id}>
                      <td>{c.cliente}</td>
                      <td>{dia(c.quando)}</td>
                      <td className="tabular">{reais(c.baseCents)}</td>
                      <td className="tabular">
                        {reais(c.feeCents)}{' '}
                        <span className="plano__aliquota">({(c.feeBps / 100).toLocaleString('pt-BR')}%)</span>
                      </td>
                      <td>
                        {c.estado === 'pendente' ? (
                          /* O motivo é obrigatório na borda, no domínio e por
                             `CHECK`: contestar renuncia à cobrança de forma
                             permanente — aquele cliente nunca mais gera
                             comissão —, e sem motivo escrito nada distingue
                             discordância de evasão. */
                          <form action={acaoContestarMarketplace} className="plano__contestacao">
                            <input name="id" type="hidden" value={c.id} />

                            {/*
                              A categoria é o que a plataforma lê; a frase abaixo
                              fica com você. Texto livre viraria "não gostei", e
                              "não gostei" é evasão de receita indistinguível de
                              discordância legítima.
                            */}
                            <label className="ui-field__label" htmlFor={`categoria-${c.id}`}>
                              Por quê
                            </label>
                            <select
                              className="ui-field__input"
                              defaultValue="ja_era_cliente"
                              id={`categoria-${c.id}`}
                              name="categoria"
                            >
                              {MOTIVOS_DA_CONTESTACAO_DE_COMISSAO.map((m) => (
                                <option key={m} value={m}>
                                  {ROTULO_DO_MOTIVO_DE_COMISSAO[m]}
                                </option>
                              ))}
                            </select>

                            <label className="ui-field__label" htmlFor={`motivo-${c.id}`}>
                              O que aconteceu
                            </label>
                            <input
                              className="ui-field__input"
                              id={`motivo-${c.id}`}
                              maxLength={500}
                              minLength={10}
                              name="motivo"
                              placeholder="Ex.: já era meu cliente há dois anos"
                              required
                              type="text"
                            />
                            <button className="ui-button ui-button--ghost plano__contestar" type="submit">
                              Contestar
                            </button>
                          </form>
                        ) : (
                          <span className={`plano-fatura__estado plano-fatura__estado--${c.estado === 'faturada' ? 'paid' : 'void'}`}>
                            {c.estado === 'faturada' ? 'Faturada' : 'Contestada'}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className="painel__grupo">
        <h2 className="painel__secao">Faturas</h2>
        {faturas.length === 0 ? (
          <p className="plano__vazio">
            Nenhuma fatura ainda. A primeira é emitida quando o período de teste terminar.
          </p>
        ) : (
          <>
            {emAberto.length > 0 ? (
              <p className="plano__aviso">
                {emAberto.length === 1 ? 'Há 1 fatura em aberto' : `Há ${emAberto.length} faturas em aberto`}
                . Pague por transferência e fale com o suporte para dar baixa.
              </p>
            ) : null}
            <div className="ui-scroll-x">
              <table className="plano-faturas">
                <thead>
                  <tr>
                    <th scope="col">Vencimento</th>
                    <th scope="col">Referente a</th>
                    <th scope="col">Valor</th>
                    <th scope="col">Situação</th>
                  </tr>
                </thead>
                <tbody>
                  {faturas.map((f) => (
                    <tr key={f.id}>
                      <td>{dia(f.vencimento)}</td>
                      <td>
                        {f.tipo === 'proration'
                          ? 'Acerto da troca de plano'
                          : f.tipo === 'marketplace'
                            ? `Clientes da busca · ${dia(f.periodoDe)} a ${dia(f.periodoAte)}`
                            : `${dia(f.periodoDe)} a ${dia(f.periodoAte)}`}
                      </td>
                      <td>{reais(f.valorCents)}</td>
                      <td>
                        <span className={`plano-fatura__estado plano-fatura__estado--${f.estado}`}>
                          {ESTADO_DA_FATURA[f.estado]}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
