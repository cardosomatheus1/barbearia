import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getProfile, listarAgendamentos, type AgendamentoDoCliente } from '@/lib/api';
import { humanInstant } from '@/lib/date';
import { lerSessao } from '@/lib/sessao';
import { cancelar, sair } from './acoes';

/**
 * Meus agendamentos.
 *
 * A tela existe para três coisas, nessa ordem de importância: saber quando é o
 * próximo, cancelar, remarcar. O que vem depois — histórico — fica embaixo,
 * porque quem abre isso às sete da manhã quer o horário de hoje.
 */

interface Props {
  readonly params: Promise<{ slug: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export const metadata: Metadata = {
  title: 'Meus agendamentos',
  robots: { index: false, follow: false },
};

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const money = (cents: number): string =>
  (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

const FALHA: Record<string, string> = {
  too_late: 'Passou do prazo para mexer neste horário. Ligue para a barbearia.',
  already_started: 'Este horário já começou.',
  too_many_reschedules: 'Este horário já foi remarcado o máximo de vezes.',
  appointment_not_found: 'Este agendamento não está mais ativo.',
  slot_taken: 'O horário novo acabou de ser ocupado. Escolha outro.',
  slot_not_available: 'O horário novo já não está disponível. Escolha outro.',
};

const FEITO: Record<string, string> = {
  cancelado: 'Agendamento cancelado.',
  remarcado: 'Horário remarcado.',
};

/**
 * Rótulo do que já passou.
 *
 * `rescheduled` tem texto próprio: o horário virou outro, não sumiu. Escrever
 * "Cancelado" ali faria quem acabou de remarcar achar que perdeu a vaga.
 */
const ESTADO: Record<string, string> = {
  cancelled: 'Cancelado',
  done: 'Atendido',
  rescheduled: 'Remarcado',
};

/** Por que o botão não está lá. Ausência sem explicação parece defeito. */
function motivoBloqueio(item: AgendamentoDoCliente): string | null {
  if (item.blockedReason === 'too_late') {
    const horas = item.minHoursToChange === 1 ? '1 hora' : `${item.minHoursToChange} horas`;
    return `Alterações até ${horas} antes. Para mudar agora, fale com a barbearia.`;
  }
  if (item.blockedReason === 'already_started') return 'Este horário já começou.';
  if (item.blockedReason === 'too_many_reschedules') {
    return 'Limite de remarcações atingido. Fale com a barbearia para mudar.';
  }
  return null;
}

export default async function MeusAgendamentosPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const query = await searchParams;
  const profile = await getProfile(slug);
  if (!profile) notFound();

  const token = await lerSessao(slug);
  if (!token) redirect(`/${slug}/entrar`);

  const agendamentos = await listarAgendamentos(slug, token);
  // `null` é sessão morta, não lista vazia. Mostrar "nenhum agendamento" aqui
  // faria o cliente achar que perdeu o horário.
  if (agendamentos === null) redirect(`/${slug}/entrar`);

  const proximos = agendamentos.filter((a) => a.state === 'active');
  const anteriores = agendamentos.filter((a) => a.state !== 'active');

  const falha = first(query['erro']);
  const feito = first(query['feito']);

  return (
    <main className="ui-container meus">
      <header className="meus__topo">
        <a className="meus__voltar" href={`/${slug}`}>
          ← {profile.name}
        </a>
        <form action={sair}>
          <input type="hidden" name="slug" value={slug} />
          <button className="ui-button ui-button--ghost meus__sair" type="submit">
            Sair
          </button>
        </form>
      </header>

      <h1 className="meus__titulo">Meus agendamentos</h1>

      {feito ? (
        <div className="ui-alert ui-alert--success meus__aviso" role="status">
          {FEITO[feito] ?? 'Pronto.'}
        </div>
      ) : null}
      {falha ? (
        <div className="ui-alert ui-alert--danger meus__aviso" role="alert">
          {FALHA[falha] ?? 'Não foi possível concluir. Tente de novo.'}
        </div>
      ) : null}

      {proximos.length === 0 && anteriores.length === 0 ? (
        <div className="vazio">
          <p className="vazio__titulo">Você ainda não tem agendamento aqui</p>
          <p className="vazio__saida">Escolha um serviço e um horário — leva menos de um minuto.</p>
          <a className="ui-button ui-button--primary" href={`/${slug}/agendar`}>
            Agendar horário
          </a>
        </div>
      ) : null}

      {proximos.length > 0 ? (
        <section aria-labelledby="proximos">
          <h2 className="rotulo" id="proximos">
            Próximos
          </h2>
          <ul className="cartoes">
            {proximos.map((item) => (
              <li key={item.id}>
                <Cartao item={item} slug={slug} timezone={profile.location.timezone} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {anteriores.length > 0 ? (
        <section aria-labelledby="anteriores">
          <h2 className="rotulo" id="anteriores">
            Anteriores
          </h2>
          <ul className="cartoes">
            {anteriores.map((item) => (
              <li key={item.id}>
                <Cartao item={item} slug={slug} timezone={profile.location.timezone} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {proximos.length > 0 ? (
        <div className="ui-sticky-action">
          <div className="ui-container">
            <a
              className="ui-button ui-button--secondary ui-button--block"
              href={`/${slug}/agendar`}
            >
              Agendar outro horário
            </a>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function Cartao({
  item,
  slug,
  timezone,
}: {
  item: AgendamentoDoCliente;
  slug: string;
  timezone: string;
}) {
  const minutos = Math.round(
    (new Date(item.endsAt).getTime() - new Date(item.startsAt).getTime()) / 60000,
  );
  const bloqueio = item.state === 'active' ? motivoBloqueio(item) : null;

  return (
    <article className={`cartao cartao--${item.state}`}>
      <p className="cartao__quando tabular">{humanInstant(timezone, item.startsAt)}</p>
      <p className="cartao__servico">{item.services.join(' + ')}</p>
      <p className="cartao__dados">
        com {item.professionalName} · {minutos} min ·{' '}
        <span className="tabular">R$ {money(item.priceCents)}</span>
      </p>

      {ESTADO[item.state] ? <p className="cartao__estado">{ESTADO[item.state]}</p> : null}

      {bloqueio ? <p className="cartao__bloqueio">{bloqueio}</p> : null}

      {item.canCancel || item.canReschedule ? (
        <div className="cartao__acoes">
          {item.canReschedule ? (
            <a
              className="ui-button ui-button--secondary"
              href={`/${slug}/meus-agendamentos/${item.id}/remarcar`}
            >
              Remarcar
            </a>
          ) : null}
          {item.canCancel ? (
            /* Formulário, não link: cancelar altera estado, e link com efeito
               colateral é acionado por prefetch e por leitor de tela. */
            <form action={cancelar}>
              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="id" value={item.id} />
              <button className="ui-button ui-button--ghost cartao__cancelar" type="submit">
                Cancelar
              </button>
            </form>
          ) : null}
        </div>
      ) : null}

      {item.state === 'done' ? (
        <a className="cartao__repetir" href={`/${slug}/agendar`}>
          Agendar de novo
        </a>
      ) : null}
    </article>
  );
}
