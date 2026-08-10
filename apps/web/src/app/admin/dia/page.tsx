import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import {
  ACAO_PRINCIPAL,
  ACOES_PESADAS,
  ESTADOS_COBRAVEIS,
  ROTULO_DO_ESTADO,
  VERBO_DA_ACAO,
} from '@barbearia/core';

import type { Metadata } from 'next';
import {
  painelDoDia,
  type AcaoAtendimento,
  type LinhaDoDia,
  type PainelDoDia,
} from '@/lib/admin-api';
import { addDays, localTime, weekdayShort } from '@/lib/date';
import { painelDoBalcaoOuDesvio, podeNaTela } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { acaoAbrirComanda, acaoAtendimento, acaoSair } from '../acoes';
import { secao } from '../secoes';

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
 * A cor do selo de estado, no vocabulário do mock.
 *
 * Cor **e** texto, nunca cor sozinha: um em doze homens não distingue verde de
 * vermelho, e barbearia é público de homem. O rótulo continua escrito dentro da
 * pílula — o que a cor faz é acelerar a leitura de relance, não substituí-la.
 */
const TOM_DO_SELO: Record<LinhaDoDia['status'], string> = {
  pending: '',
  confirmed: '',
  checked_in: 'selo--espera',
  waiting: 'selo--espera',
  in_progress: 'selo--agora',
  completed: 'selo--feito',
  cancelled_customer: 'selo--fora',
  cancelled_business: 'selo--fora',
  no_show: 'selo--fora',
  rescheduled: '',
};

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
 * **O número não anda.** Sem componente de cliente ele é o instantâneo da
 * carga, e a faixa diz isso em vez de fingir um cronômetro — um contador que
 * parece contar e não conta é pior que nenhum. Um que conta de verdade é o
 * primeiro JavaScript do admin, e essa decisão tem bloco próprio.
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

function Atendimento({
  linha,
  tolerancia,
  voltarPara,
  podeCobrar,
}: {
  readonly linha: LinhaDoDia;
  readonly tolerancia: number;
  readonly voltarPara: string;
  readonly podeCobrar: boolean;
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
    <article className={`atendimento ${tom(linha)}`}>
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
      </div>

      {linha.actions.length > 0 || cobrar ? (
        <div className="atendimento__acoes">
          {principal ? (
            <form action={acaoAtendimento}>
              <input type="hidden" name="id" value={linha.id} />
              <input type="hidden" name="action" value={principal} />
              <input type="hidden" name="voltar" value={voltarPara} />
              <button className="ui-button ui-button--primary atendimento__botao" type="submit">
                {AÇÃO[principal]}
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
                <form action={acaoAtendimento} key={acao}>
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
      <header className="painel__topo">
        <a className="painel__marca" href="/admin/onboarding">
          ← {estado.businessName}
        </a>
        <nav className="painel__atalhos">
          {/* Só sair. Painel, equipe, agenda, fila e cadastro moram no trilho
              do casco desde que ele existe — repetir aqui é o mesmo link duas
              vezes na mesma tela. */}
          <form action={acaoSair}>
            <button className="ui-button ui-button--ghost painel__sair" type="submit">
              Sair
            </button>
          </form>
        </nav>
      </header>

      <div className="balcao__cabeca">
        <div>
          <h1 className="painel__titulo balcao__titulo">
            {éHoje ? 'Hoje' : weekdayShort(dia.timezone, dia.date)}
            <span className="balcao__data tabular"> {dia.date.split('-').reverse().join('/')}</span>
          </h1>
          <p className="painel__sub balcao__sub">
            {éHoje ? `São ${agora} na barbearia.` : 'Você está vendo outro dia.'}{' '}
            <a href={voltarPara}>Atualizar</a>
          </p>
        </div>

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
      </div>

      {erro ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {FALHA[erro] ?? FALHA['request_failed']}
        </div>
      ) : null}

      <NasCadeiras hora={agora} linhas={dia.entries} />

      <Totais totals={dia.totals} />

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
