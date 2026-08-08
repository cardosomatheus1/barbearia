import { redirect } from 'next/navigation';
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
import { acaoAtendimento, acaoSair } from '../acoes';

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

/** O que cada estado significa para quem está no balcão. */
const RÓTULO: Record<LinhaDoDia['status'], string> = {
  pending: 'Marcado',
  confirmed: 'Confirmado',
  checked_in: 'Chegou',
  waiting: 'Aguardando',
  in_progress: 'Em atendimento',
  completed: 'Concluído',
  cancelled_customer: 'Cancelado pelo cliente',
  cancelled_business: 'Cancelado pela casa',
  no_show: 'Faltou',
  rescheduled: 'Remarcado',
};

/**
 * O texto do botão é o que vai acontecer, não o nome do estado.
 *
 * "Chegou" e não "check-in": quem opera descreve o cliente, não o sistema.
 */
const AÇÃO: Record<AcaoAtendimento, string> = {
  confirm: 'Confirmar',
  check_in: 'Chegou',
  wait: 'Mandar esperar',
  start: 'Iniciar',
  complete: 'Concluir',
  no_show: 'Faltou',
  undo_no_show: 'Não faltou',
  cancel: 'Cancelar',
};

/**
 * A ação em destaque de cada estado.
 *
 * Uma só, e sempre a que a recepção mais aperta naquele momento. `no_show` e
 * `cancel` nunca são primárias: são decisões que tiram dinheiro da casa e não
 * devem ser o botão mais fácil de acertar sem querer.
 */
const PRINCIPAL: Partial<Record<LinhaDoDia['status'], AcaoAtendimento>> = {
  pending: 'check_in',
  confirmed: 'check_in',
  checked_in: 'start',
  waiting: 'start',
  in_progress: 'complete',
  // `no_show` fica sem ação em destaque de propósito: a linha já saiu do dia, e
  // desfazer é conserto de engano, não o próximo passo de ninguém.
};

/** Ações que tiram dinheiro da casa. Nunca em destaque, sempre distinguíveis. */
const PESADA: ReadonlySet<AcaoAtendimento> = new Set(['no_show', 'cancel']);

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
  const numeros: readonly [string, number | string][] = [
    ['esperados', totals.esperados],
    ['chegaram', totals.chegaram],
    ['atendendo', totals.atendendo],
    ['concluídos', totals.concluidos],
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
}: {
  readonly linha: LinhaDoDia;
  readonly tolerancia: number;
  readonly voltarPara: string;
}) {
  const principal = PRINCIPAL[linha.status];
  const secundarias = linha.actions.filter((a) => a !== principal);
  const frase = situacao(linha, tolerancia);

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
          <span className="atendimento__selo">{RÓTULO[linha.status]}</span>
          {frase ? <span className="atendimento__frase">{frase}</span> : null}
        </p>
      </div>

      {linha.actions.length > 0 ? (
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
      <main className="ui-container painel__conteudo" data-secao="dia">
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
    <main className="ui-container balcao" data-secao="dia">
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
              <Atendimento linha={linha} tolerancia={dia.noShowAfterMinutes} voltarPara={voltarPara} />
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
