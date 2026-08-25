import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import {
  ACAO_PRINCIPAL,
  ACOES_PESADAS,
  ESTADOS_COBRAVEIS,
  ROTULO_DO_ESTADO,
  TOM_SEMANTICO_DO_ESTADO,
  VERBO_DA_ACAO,
} from '@barbearia/core';

import type { Metadata } from 'next';
import {
  caixaDaUnidade,
  comandasAbertasDaCasa,
  faturamentoDeHoje,
  painelDoDia,
  type LinhaDoDia,
  type PainelDoDia,
} from '@/lib/admin-api';
import type { MotivoDoSinal } from '@barbearia/core';
import { addDays, localTime, weekdayShort } from '@/lib/date';
import { painelDoBalcaoOuDesvio, podeNaTela } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import {
  acaoAbrirComanda,
  acaoDevolverSinal,
  acaoRegistrarSinal,
  acaoSair,
} from '../acoes';
import { reais, reaisDoCampo } from '@/lib/dinheiro';
import { secao } from '../secoes';
import { QuemQueriaAVaga } from '../quem-queria-a-vaga';
import { AvisoDeRecusa } from '@/app/admin/aviso-de-recusa';
import { fraseDoProximo, resumoDoHoje, saudacaoDoBalcao, type ResumoDoHoje } from './hoje';

/**
 * O balcão: o dia da barbearia.
 *
 * A terceira superfície do produto. A página do cliente é visitada uma vez por
 * mês e respira; o painel de configuração é visitado uma vez e some. **Esta é
 * aberta de manhã e fechada à noite**, e é por ela que passa quem de fato veio.
 *
 * Três decisões de desenho, todas por causa de quem opera:
 *
 * - **A linha do agora é o elemento assinatura.** Não é enfeite: ela separa o
 *   que já devia ter acontecido do que ainda vai, que é exatamente a pergunta
 *   que a recepção faz à tela o dia inteiro.
 * - **Uma ação primária por atendimento**, a próxima da máquina de estados. As
 *   outras ficam como texto secundário. Se tudo é botão cheio, a recepção
 *   erra com o cliente na frente.
 * - **Cada linha é um formulário próprio**, sem JavaScript. O balcão trabalha
 *   com o que estiver no notebook, inclusive rede ruim e aba antiga — e uma
 *   aba antiga que envia uma ação vencida recebe 409, não sobrescrita.
 */

export const metadata: Metadata = {
  title: 'O dia',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

/**
 * O vocabulário vem de `packages/core`, e não daqui.
 *
 * Ele era escrito em cada tela, e o resultado é que a mesma transição tinha três
 * nomes no mesmo produto: **Iniciar** aqui, **Começar** na tela do barbeiro e
 * **Sentou** na fila. Quando a recepção diz "já iniciei o Ruan" e o barbeiro
 * procura "Começar", o treinamento vira folclore.
 */
const RÓTULO = ROTULO_DO_ESTADO;
const AÇÃO = VERBO_DA_ACAO;
/**
 * Por que este horário pede sinal, em uma frase de balcão.
 *
 * Sai de um mapa e não de texto escrito na tela: é vocabulário de estado, e o
 * CLAUDE.md §6 manda a mesma coisa ter o mesmo nome em todo lugar. Quando a
 * mesma frase aparecer na página do cliente, ela sai daqui.
 */
const MOTIVO_DO_SINAL: Readonly<Record<MotivoDoSinal, string>> = {
  servico: 'este serviço sempre pede',
  score: 'pelo histórico de faltas',
  ticket: 'pelo tamanho da reserva',
  // Bloco 57. A frase fala da pessoa **e** da casa, e é a mais difícil de dizer
  // no balcão — por isso ela é o último motivo a se aplicar.
  pico: 'primeira vez, em horário cheio',
};

/** O verbo da decisão de reembolso, um só para toda a interface. */
const DESTINO_DO_SINAL: Readonly<Record<'devolver' | 'reter', string>> = {
  devolver: 'devolver',
  reter: 'fica com a casa',
};

const PRINCIPAL = ACAO_PRINCIPAL;
const PESADA = ACOES_PESADAS;

const FALHA: Record<string, string> = {
  transition_not_allowed:
    'Este atendimento já mudou de estado — alguém no balcão foi mais rápido. A tela está atualizada.',
  slot_taken: 'O horário já foi dado a outro cliente. Marque um novo.',
  appointment_not_found: 'Este atendimento não existe mais.',
  request_failed: 'Não deu para concluir. Tente de novo.',
};

/** Situação de quem ainda não chegou, em uma frase. */
function situacao(linha: LinhaDoDia, toleranciaMinutos: number): string | null {
  if (linha.waitingMinutes !== null) {
    return linha.waitingMinutes < 1
      ? 'Chegou agora'
      : `Esperando há ${linha.waitingMinutes} min`;
  }
  if (linha.realDurationMinutes !== null) return `Levou ${linha.realDurationMinutes} min`;
  /**
   * Há quanto tempo está na cadeira.
   *
   * Era a única linha do painel sem frase de contexto: o balcão via "Na
   * cadeira" e não sabia se tinha começado há cinco ou há cinquenta minutos —
   * que é a pergunta que ele faz o dia inteiro para responder "cabe um
   * encaixe?".
   *
   * O dado estava no banco desde a migração 0014 e era descartado antes de
   * chegar aqui.
   */
  if (linha.elapsedMinutes !== null) {
    return linha.elapsedMinutes < 1
      ? 'Começou agora'
      : `Na cadeira há ${linha.elapsedMinutes} min`;
  }

  const p = linha.punctuality;
  if (!p) return null;
  if (p.kind === 'upcoming') {
    return p.minutesUntil > 90 ? null : `Daqui a ${p.minutesUntil} min`;
  }
  if (p.kind === 'due') return 'É agora';
  if (p.kind === 'late') {
    // "Tolerância acaba em", não "falta automática em": nada marca a falta
    // sozinho ainda — a transição automática depende do worker do bloco 20.
    // Escrever "automática" faria a tela prometer o que o sistema não cumpre, e
    // a recepção descobriria pelo cliente que ficou esperando ser chamado.
    return Number.isFinite(p.noShowInMinutes)
      ? `Atrasado ${p.minutesLate} min · tolerância acaba em ${p.noShowInMinutes} min`
      : `Atrasado ${p.minutesLate} min`;
  }
  return toleranciaMinutos > 0
    ? `Atrasado ${p.minutesLate} min · passou da tolerância, marque a falta`
    : `Atrasado ${p.minutesLate} min`;
}

/**
 * V9: o tom do estado vem do mesmo vocabulário semântico usado pela agenda e
 * pela tela do barbeiro. O texto continua dizendo o estado; a cor só acelera a
 * leitura.
 */
const TOM_DO_SELO: Record<LinhaDoDia['status'], string> = Object.fromEntries(
  Object.entries(TOM_SEMANTICO_DO_ESTADO).map(([estado, tom]) => [estado, `selo--${tom}`]),
) as Record<LinhaDoDia['status'], string>;

/** Classe de ênfase da linha. Cor é o último recurso — sempre acompanha texto. */
function tom(linha: LinhaDoDia): string {
  if (linha.status === 'in_progress') return 'atendimento--agora';
  if (linha.status === 'completed') return 'atendimento--feito';
  if (linha.status === 'no_show') return 'atendimento--falta';
  if (linha.status.startsWith('cancel') || linha.status === 'rescheduled') {
    return 'atendimento--fora';
  }
  const p = linha.punctuality;
  if (p && (p.kind === 'late' || p.kind === 'no_show_due')) return 'atendimento--atrasado';
  return '';
}

/**
 * Quem está na cadeira agora, e há quanto tempo.
 *
 * A pergunta que a recepção faz o dia inteiro — "cabe um encaixe?" — e a única
 * que o painel não respondia. As linhas `in_progress` ficavam misturadas na
 * ordem do relógio, então um walk-in que sentou às 14h37 aparecia no meio da
 * manhã, e nenhuma delas dizia há quanto tempo.
 *
 * **O número não anda.** Esta tela continua server-first: ele é o instantâneo
 * da carga, e a faixa diz isso em vez de fingir um cronômetro — um contador que
 * parece contar e não conta é pior que nenhum. Atualização realmente viva exige
 * uma ilha própria e um desenho de reconexão, que continuam em bloco separado.
 */
function NasCadeiras({
  linhas,
  hora,
}: {
  readonly linhas: readonly LinhaDoDia[];
  readonly hora: string;
}) {
  const naCadeira = linhas.filter((l) => l.status === 'in_progress');
  if (naCadeira.length === 0) return null;

  return (
    <section className="cadeiras-agora" aria-labelledby="cadeiras-agora">
      <h2 className="rotulo" id="cadeiras-agora">
        Nas cadeiras agora <span className="cadeiras-agora__hora">· visto às {hora}</span>
      </h2>
      <ul className="cadeiras-agora__lista ui-scroll-x">
        {naCadeira.map((linha) => (
          <li className="cadeiras-agora__item" key={linha.id}>
            <span className="cadeiras-agora__quem">{linha.customerName ?? 'Sem cadastro'}</span>
            <span className="cadeiras-agora__barbeiro">{linha.professionalName}</span>
            <span className="cadeiras-agora__tempo tabular">
              {linha.elapsedMinutes === null || linha.elapsedMinutes < 1
                ? 'começou agora'
                : `há ${linha.elapsedMinutes} min`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * O resumo do dia — contagem, nunca dinheiro.
 *
 * Havia aqui um sexto número, "realizado", que mostrava **R$ NaN** desde o
 * bloco 11: o tipo do cliente declarava `realizadoCents` e a API nunca mandou o
 * campo, de propósito — `/day` é rota de `appointments.view`, e faturamento é
 * `finance.view`, com segundo fator. Há teste na API que reprova se o número
 * aparecer ali.
 *
 * A tela pedia certo pelo TypeScript e errado pela permissão. O faturamento do
 * dia está em `/admin/painel`, para quem pode vê-lo.
 */
function Totais({ totals }: { readonly totals: PainelDoDia['totals'] }) {
  /**
   * Os nomes dos contadores repetem os selos das linhas, de propósito.
   *
   * "atendendo" no resumo e "Em atendimento" no selo eram a mesma coisa com dois
   * nomes na **mesma tela** — quem procura os três da cadeira olhava o número e
   * não achava a palavra embaixo dele.
   */
  const numeros: readonly [string, number | string][] = [
    ['esperados', totals.esperados],
    ['na espera', totals.chegaram],
    ['na cadeira', totals.atendendo],
    ['atendidos', totals.concluidos],
    ['faltaram', totals.faltaram],
  ];

  return (
    // Rola dentro de si em tela estreita; nunca leva a página junto.
    <div className="ui-scroll-x balcao__totais" aria-label="Resumo do dia">
      {numeros.map(([nome, valor]) => (
        <div className="totalzinho" key={nome}>
          <span className="totalzinho__valor tabular">{valor}</span>
          <span className="totalzinho__nome">{nome}</span>
        </div>
      ))}
    </div>
  );
}

function ProximoCliente({
  resumo,
}: {
  readonly resumo: ResumoDoHoje;
}) {
  const linha = resumo.proximo;

  return (
    <section className="hoje-proximo" data-nivel="primario" aria-labelledby="hoje-proximo-titulo">
      <div className="hoje-proximo__topo">
        <p className="rotulo">Próximo</p>
        <span className="hoje-proximo__quando">{fraseDoProximo(linha)}</span>
      </div>
      {linha ? (
        <div className="hoje-proximo__corpo">
          <time className="hoje-proximo__hora tabular" dateTime={linha.startsAt}>{linha.start}</time>
          <div className="hoje-proximo__pessoa">
            <h2 className="hoje-proximo__nome" id="hoje-proximo-titulo">
              {linha.customerName ?? 'Sem cadastro'}
            </h2>
            <p className="hoje-proximo__servico">
              {linha.services.join(' + ')} · {linha.professionalName}
            </p>
          </div>
          <span className={`selo ${TOM_DO_SELO[linha.status]}`}>{RÓTULO[linha.status]}</span>
        </div>
      ) : (
        <div className="hoje-proximo__vazio">
          <h2 id="hoje-proximo-titulo">Agenda livre daqui para frente</h2>
          <p>Não há outro atendimento aberto neste dia.</p>
        </div>
      )}
    </section>
  );
}

function LeiturasDoHoje({
  resumo,
  caixaAberto,
  comandasAbertas,
  faturamentoCents,
  comandasFechadas,
  podeOperarCaixa,
  podeVerDinheiro,
}: {
  readonly resumo: ResumoDoHoje;
  readonly caixaAberto: boolean | null;
  readonly comandasAbertas: number | null;
  readonly faturamentoCents: number | null;
  readonly comandasFechadas: number | null;
  readonly podeOperarCaixa: boolean;
  readonly podeVerDinheiro: boolean;
}) {
  const proximo = resumo.proximo;
  const piorAtraso = proximo?.punctuality?.kind === 'late' || proximo?.punctuality?.kind === 'no_show_due'
    ? `${proximo.customerName ?? 'Cliente'} · ${proximo.punctuality.minutesLate} min de atraso`
    : resumo.atrasados > 0
      ? `${resumo.atrasados} ${resumo.atrasados === 1 ? 'cliente atrasado' : 'clientes atrasados'}`
      : null;

  return (
    <aside className="hoje-leituras" data-nivel="contexto" aria-label="Leituras rápidas de hoje">
      <section className="hoje-leitura">
        <h2 className="hoje-leitura__titulo">Agora</h2>
        <strong>{resumo.esperando} esperando</strong>
        <span>{resumo.atendendo} {resumo.atendendo === 1 ? 'na cadeira' : 'nas cadeiras'}</span>
        <span>{fraseDoProximo(resumo.proximo)}</span>
      </section>

      <section className="hoje-leitura">
        <h2 className="hoje-leitura__titulo">Hoje</h2>
        <strong>{resumo.marcados} marcados</strong>
        <span>{resumo.confirmados} confirmados</span>
        <span>{resumo.aguardandoConfirmacao} aguardando confirmação</span>
      </section>

      <section className="hoje-leitura">
        <h2 className="hoje-leitura__titulo">Caixa</h2>
        {podeOperarCaixa ? (
          <>
            {podeVerDinheiro && faturamentoCents !== null ? (
              <strong className="tabular">{reais(faturamentoCents)} hoje</strong>
            ) : (
              <strong>{caixaAberto === null ? 'Caixa indisponível' : caixaAberto ? 'Caixa aberto' : 'Caixa fechado'}</strong>
            )}
            {comandasFechadas !== null && podeVerDinheiro ? <span>{comandasFechadas} comandas fechadas</span> : null}
            {comandasAbertas !== null ? <span>{comandasAbertas} abertas</span> : null}
          </>
        ) : (
          <>
            <strong>Sem acesso ao caixa</strong>
            <span>Seu perfil acompanha apenas a operação.</span>
          </>
        )}
      </section>

      <section className={`hoje-leitura ${piorAtraso || resumo.sinaisPendentes > 0 || (comandasAbertas ?? 0) > 0 ? 'hoje-leitura--atencao' : ''}`}>
        <h2 className="hoje-leitura__titulo">Atenção</h2>
        {piorAtraso ? <strong>{piorAtraso}</strong> : <strong>Nada urgente agora</strong>}
        {resumo.sinaisPendentes > 0 ? (
          <span>{resumo.sinaisPendentes} {resumo.sinaisPendentes === 1 ? 'sinal pendente' : 'sinais pendentes'}</span>
        ) : null}
        {(comandasAbertas ?? 0) > 0 ? <span>{comandasAbertas} pagamentos em aberto</span> : null}
        {!piorAtraso && resumo.sinaisPendentes === 0 && (comandasAbertas ?? 0) === 0 ? (
          <span>A operação não tem alerta imediato.</span>
        ) : null}
      </section>
    </aside>
  );
}

function Atendimento({
  linha,
  tolerancia,
  voltarPara,
  podeCobrar,
  podeSinal,
}: {
  readonly linha: LinhaDoDia;
  readonly tolerancia: number;
  readonly voltarPara: string;
  readonly podeCobrar: boolean;
  readonly podeSinal: boolean;
}) {
  const principal = PRINCIPAL[linha.status];
  const secundarias = linha.actions.filter((a) => a !== principal);
  const frase = situacao(linha, tolerancia);
  /**
   * O dinheiro fica onde o atendimento termina.
   *
   * Encerrar um corte aqui e ter que ir a Dinheiro → Cobrar procurar a mesma
   * pessoa numa segunda lista eram cinco toques para a operação mais frequente
   * do balcão — e a lista de lá é a **mesma** consulta desta tela, filtrada
   * pelos mesmos dois estados. Duas telas para um passo só.
   *
   * `completed` não tem ação de atendimento nenhuma: sem isto o cartão fica sem
   * saída, que é justamente o momento em que ainda falta receber.
   *
   * Abrir a comanda duas vezes devolve a mesma — quem garante é `abrirComanda`,
   * e é o que permite este botão conviver com o de lá sem virar cobrança
   * dobrada.
   */
  const cobrar = podeCobrar && ESTADOS_COBRAVEIS.has(linha.status);

  return (
    <article className={`atendimento ${tom(linha)}`} id={`atendimento-${linha.id}`} tabIndex={-1}>
      <div className="atendimento__hora">
        <time className="tabular" dateTime={linha.startsAt}>{linha.start}</time>
        <span className="atendimento__fim tabular">{linha.end}</span>
      </div>

      <div className="atendimento__quem">
        <h3 className="atendimento__nome">
          {linha.customerName ?? 'Sem cadastro'}
          {linha.customerPhoneTail ? (
            // Só os quatro últimos: confere identidade sem expor o número a
            // quem passa na frente do notebook.
            <span className="atendimento__fone tabular"> ···{linha.customerPhoneTail}</span>
          ) : null}
        </h3>
        <p className="atendimento__servico">
          {linha.services.join(' + ')} · {linha.professionalName}
        </p>
        <p className="atendimento__estado">
          <span className={`selo ${TOM_DO_SELO[linha.status]}`}>{RÓTULO[linha.status]}</span>
          {frase ? <span className="atendimento__frase">{frase}</span> : null}
        </p>

        {/*
          O sinal, na linha de quem o deve (bloco 37).

          Só aparece em horário que pede sinal — a esmagadora maioria não pede,
          e uma linha "sinal: R$ 0,00" em todo cartão é indicador que se aprende
          a não ler. O motivo vem escrito porque a primeira pergunta do cliente
          no balcão é "por que eu preciso pagar adiantado?", e a recepção precisa
          da resposta na tela.
        */}
        {linha.deposit ? (
          <p className="atendimento__sinal">
            <span className={`selo ${linha.deposit.pagoCents > 0 ? 'selo--ok' : 'selo--atencao'}`}>
              {linha.deposit.pagoCents > 0 ? 'Sinal pago' : 'Sinal a receber'}
            </span>
            <span className="atendimento__frase">
              R$ {reaisDoCampo(linha.deposit.exigidoCents)} ·{' '}
              {/*
                Encerrado o horário, o que importa é o destino do dinheiro — não
                mais por que ele foi cobrado. A frase vem do domínio, a mesma que
                a recepção repete para o cliente: ele discute o motivo, não o
                código.
              */}
              {linha.deposit.reembolso
                ? `${DESTINO_DO_SINAL[linha.deposit.reembolso.desfecho]}: ${
                    linha.deposit.reembolso.porque
                  }`
                : MOTIVO_DO_SINAL[linha.deposit.motivo]}
            </span>
          </p>
        ) : null}
      </div>

      {linha.actions.length > 0 || cobrar
        || (podeSinal && linha.deposit && (linha.deposit.pagoCents === 0
            || linha.deposit.reembolso?.desfecho === 'devolver')) ? (
        <div className="atendimento__acoes">
          {principal ? (
            <form action="/admin/dia/atender" method="post">
              <input type="hidden" name="id" value={linha.id} />
              <input type="hidden" name="action" value={principal} />
              <input type="hidden" name="voltar" value={voltarPara} />
              <button className="ui-button ui-button--primary atendimento__botao" type="submit">
                {AÇÃO[principal]}
              </button>
            </form>
          ) : null}

          {/*
            Registrar o sinal que chegou.

            O Pix do sinal cai no celular da recepção dias antes, e é ela que
            confere o comprovante. Sem este botão, `deposit_paid_cents` seria
            mais uma coluna que o motor aceita e ninguém preenche — e a decisão
            de devolver, que depende dele, nunca teria o que decidir.
          */}
          {podeSinal && linha.deposit && linha.deposit.pagoCents === 0 ? (
            <form action={acaoRegistrarSinal}>
              <input name="appointmentId" type="hidden" value={linha.id} />
              <input name="valorCents" type="hidden" value={linha.deposit.exigidoCents} />
              <input name="voltar" type="hidden" value={voltarPara} />
              <button className="ui-button ui-button--secondary atendimento__botao" type="submit">
                Recebi o sinal
              </button>
            </form>
          ) : null}

          {/*
            Devolver o sinal.

            Sem este botão, "sinal pago" seria estado sem saída na tela: o
            domínio sabe que o dinheiro tem que voltar, a linha diz isso, e não
            havia por onde fazer — que é o defeito de fluxo do §6, e o mesmo que
            deixou `in_service` sem botão para fechar.

            Aparece só quando a política manda devolver. Reter não é uma ação:
            é o que acontece por não fazer nada. Devolver por cortesia contra a
            política é decisão de balcão, e ela cabe — o domínio aceita —, mas
            não é o que este botão oferece.
          */}
          {podeSinal && linha.deposit && linha.deposit.pagoCents > 0
            && linha.deposit.reembolso?.desfecho === 'devolver' ? (
            <form action={acaoDevolverSinal}>
              <input name="appointmentId" type="hidden" value={linha.id} />
              <input name="voltar" type="hidden" value={voltarPara} />
              <button className="ui-button ui-button--secondary atendimento__botao" type="submit">
                Devolver o sinal
              </button>
            </form>
          ) : null}

          {cobrar ? (
            <form action={acaoAbrirComanda}>
              <input name="appointmentId" type="hidden" value={linha.id} />
              {/* Chave por render: dois toques no mesmo botão são um pedido só. */}
              <input name="idempotencyKey" type="hidden" value={randomUUID()} />
              <button
                className={`ui-button atendimento__botao ${
                  principal ? 'ui-button--secondary' : 'ui-button--primary'
                }`}
                type="submit"
              >
                Cobrar
              </button>
            </form>
          ) : null}

          {secundarias.length > 0 ? (
            <div className="atendimento__outras">
              {secundarias.map((acao) => (
                <form action="/admin/dia/atender" key={acao} method="post">
                  <input type="hidden" name="id" value={linha.id} />
                  <input type="hidden" name="action" value={acao} />
                  <input type="hidden" name="voltar" value={voltarPara} />
                  <button
                    className={`ui-button ui-button--ghost atendimento__menor ${
                      PESADA.has(acao) ? 'atendimento__risco' : ''
                    }`}
                    type="submit"
                  >
                    {AÇÃO[acao]}
                  </button>
                </form>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export default async function DiaPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  // O barbeiro tem `appointments.view` e esta tela funcionaria para ele.
  // Funcionar não é servir: a dele é `/admin/meu-dia`.
  const estado = await painelDoBalcaoOuDesvio(token);
  // A tela esconde o que a guarda recusaria: o barbeiro que abre esta página
  // por engano não vê um botão que só dá erro. A recusa de verdade é na API.
  const podeCobrar = podeNaTela(estado, 'cashier.open');
  const podeOperarCaixa = podeCobrar;
  const podeVerDinheiro = podeNaTela(estado, 'finance.view');
  // A mesma função que a API aplica: um botão que responde 403 é pior que
  // botão nenhum, porque a recepção aprende a desconfiar da tela.
  const podeSinal = podeNaTela(estado, 'finance.deposit');

  const query = await searchParams;
  const dataPedida = first(query['d']);
  const profissional = first(query['p']);
  const erro = first(query['erro']);

  const painel = await painelDoDia(token, {
    ...(dataPedida ? { date: dataPedida } : {}),
    ...(profissional ? { professionalId: profissional } : {}),
  });

  if (!painel.ok) {
    return (
      <main className="ui-container painel__conteudo" {...secao('dia')}>
        <div className="ui-alert ui-alert--danger" role="alert">
          Não deu para carregar o dia. <a className="ui-button ui-button--secondary painel__saida" href="/admin/dia">Tentar de novo</a>
        </div>
      </main>
    );
  }

  const dia = painel.dados;
  const éHoje = dia.date === dia.today;
  const agora = localTime(dia.timezone, new Date().toISOString());
  const resumo = resumoDoHoje(dia.entries, dia.totals);

  /**
   * Caixa é uma leitura **separada** da agenda porque as permissões são
   * separadas. A recepção pode operar `cashier.open` e continuar sem
   * `finance.view`; nesse caso ela vê estado e pendências, nunca faturamento.
   *
   * Só consultamos estas rotas no Hoje. Ao navegar para ontem/amanhã, a tela
   * volta a ser agenda histórica e não mistura o caixa corrente com outro dia.
   */
  const [caixa, abertas, faturamento] = await Promise.all([
    éHoje && podeOperarCaixa ? caixaDaUnidade(token) : Promise.resolve(null),
    éHoje && podeOperarCaixa ? comandasAbertasDaCasa(token) : Promise.resolve(null),
    éHoje && podeVerDinheiro ? faturamentoDeHoje(token, dia.date) : Promise.resolve(null),
  ]);

  const caixaAberto = caixa?.ok ? caixa.dados.aberto !== null : null;
  const comandasAbertas = abertas?.ok ? abertas.dados.comandas.length : null;
  const faturamentoCents = faturamento?.ok ? faturamento.dados.recebidoCents : null;
  const comandasFechadas = faturamento?.ok ? faturamento.dados.comandas : null;

  const link = (novo: Record<string, string | undefined>): string => {
    const busca = new URLSearchParams();
    const data = novo['d'] ?? (dia.date === dia.today ? undefined : dia.date);
    const quem = 'p' in novo ? novo['p'] : profissional;
    if (data) busca.set('d', data);
    if (quem) busca.set('p', quem);
    const texto = busca.toString();
    return `/admin/dia${texto ? `?${texto}` : ''}`;
  };

  const voltarPara = link({});

  /**
   * Onde entra a linha do agora.
   *
   * Índice do primeiro atendimento que ainda não começou. Só no dia de hoje:
   * marcar "agora" numa terça que já passou seria mentira na tela.
   */
  const marcaAgora = éHoje
    ? dia.entries.findIndex((linha) => new Date(linha.startsAt).getTime() > Date.now())
    : -1;

  return (
    <main className="ui-container balcao" {...secao('dia')}>
      <header className="hoje-cabeca painel__topo">
        <div className="hoje-cabeca__texto">
          <p className="rotulo">{éHoje ? 'Operação de hoje' : 'Agenda do dia'}</p>
          <h1 className="painel__titulo balcao__titulo">
            {éHoje ? (
              <>{saudacaoDoBalcao(agora)}. Hoje você tem {resumo.marcados} atendimentos.</>
            ) : (
              <>
                {weekdayShort(dia.timezone, dia.date)}
                <span className="balcao__data tabular"> {dia.date.split('-').reverse().join('/')}</span>
              </>
            )}
          </h1>
          <p className="painel__sub balcao__sub">
            {éHoje ? `São ${agora} na barbearia.` : 'Você está vendo outro dia.'}{' '}
            <a href={voltarPara}>Atualizar</a>
          </p>
        </div>

        <div className="hoje-cabeca__acoes">
          <nav className="balcao__dias" aria-label="Trocar de dia">
            <a className="ui-button ui-button--ghost balcao__seta" href={link({ d: addDays(dia.date, -1) })}>
              <span aria-hidden="true">←</span>
              <span className="ui-visually-hidden">Dia anterior</span>
            </a>
            {!éHoje ? (
              <a className="ui-button ui-button--ghost balcao__hoje" href={link({ d: dia.today })}>
                Hoje
              </a>
            ) : null}
            <a className="ui-button ui-button--ghost balcao__seta" href={link({ d: addDays(dia.date, 1) })}>
              <span aria-hidden="true">→</span>
              <span className="ui-visually-hidden">Próximo dia</span>
            </a>
          </nav>
          <form action={acaoSair}>
            <button className="ui-button ui-button--ghost painel__sair" type="submit">Sair</button>
          </form>
        </div>
      </header>

      {erro ? (
        <AvisoDeRecusa erro={erro} mapa={FALHA} className="painel__aviso" />
      ) : null}

      {éHoje ? (
        <section className="hoje-resumo" aria-label="Resumo operacional">
          <ProximoCliente resumo={resumo} />
          <LeiturasDoHoje
            resumo={resumo}
            caixaAberto={caixaAberto}
            comandasAbertas={comandasAbertas}
            faturamentoCents={faturamentoCents}
            comandasFechadas={comandasFechadas}
            podeOperarCaixa={podeOperarCaixa}
            podeVerDinheiro={podeVerDinheiro}
          />
        </section>
      ) : (
        <Totais totals={dia.totals} />
      )}

      <QuemQueriaAVaga />

      {éHoje ? <NasCadeiras hora={agora} linhas={dia.entries} /> : null}

      <div className="hoje-timeline__topo" data-nivel="detalhe">
        <div>
          <p className="rotulo">Linha do tempo</p>
          <h2 className="hoje-timeline__titulo">{éHoje ? 'O restante do dia' : 'Atendimentos'}</h2>
        </div>
        <a className="ui-button ui-button--secondary hoje-timeline__marcar" href={`/admin/dia/marcar?d=${dia.date}`}>
          Marcar alguém
        </a>
      </div>

      {dia.professionals.length > 1 ? (
        <div className="ui-scroll-x balcao__equipe" role="group" aria-label="Filtrar por profissional">
          <a className={`filtro ${profissional ? '' : 'filtro--ativo'}`} href={link({ p: undefined })}>
            Todos
          </a>
          {dia.professionals.map((pessoa) => (
            <a
              className={`filtro ${profissional === pessoa.id ? 'filtro--ativo' : ''}`}
              href={link({ p: pessoa.id })}
              key={pessoa.id}
            >
              {pessoa.name}
            </a>
          ))}
        </div>
      ) : null}

      {dia.entries.length === 0 ? (
        // Estado vazio desenhado, com o que fazer em seguida — não uma lista
        // vazia que parece defeito.
        <div className="vazio">
          <p className="vazio__titulo">Nenhum horário marcado {éHoje ? 'hoje' : 'neste dia'}.</p>
          <p className="vazio__saida">
            Quem chegar sem hora marcada entra por aqui — e o horário já sai da grade do site.
          </p>
          <a className="ui-button ui-button--primary" href={`/admin/dia/marcar?d=${dia.date}`}>
            Marcar alguém
          </a>
        </div>
      ) : (
        <ol className="balcao__lista">
          {dia.entries.map((linha, indice) => (
            <li key={linha.id}>
              {indice === marcaAgora ? (
                <p className="agora">
                  <span className="agora__hora tabular">{agora}</span>
                  <span className="agora__nome">agora</span>
                </p>
              ) : null}
              <Atendimento
                linha={linha}
                podeCobrar={podeCobrar}
                podeSinal={podeSinal}
                tolerancia={dia.noShowAfterMinutes}
                voltarPara={voltarPara}
              />
            </li>
          ))}
          {éHoje && marcaAgora === -1 ? (
            <li>
              <p className="agora">
                <span className="agora__hora tabular">{agora}</span>
                <span className="agora__nome">agora · o dia acabou</span>
              </p>
            </li>
          ) : null}
        </ol>
      )}

      {dia.entries.length > 0 ? (
        // Barra fixa: soma `env(safe-area-inset-bottom)` no design system, senão
        // o botão fica sob a barra de gestos do iPhone.
        <div className="ui-sticky-action balcao__fixo">
          <a className="ui-button ui-button--primary ui-button--block" href={`/admin/dia/marcar?d=${dia.date}`}>
            Marcar alguém
          </a>
        </div>
      ) : null}
    </main>
  );
}
