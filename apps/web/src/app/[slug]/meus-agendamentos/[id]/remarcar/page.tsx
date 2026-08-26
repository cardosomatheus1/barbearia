import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getProfile, listarAgendamentos, opcoesDeRemarcacao } from '@/lib/api';
import { addDays, dayNumber, humanInstant, localDate, localTime, weekdayShort } from '@/lib/date';
import { lerSessao } from '@/lib/sessao';
import { remarcar } from '../../acoes';
import { MOTIVO_DE_DIA_SEM_HORARIO } from '@barbearia/core';

/**
 * Remarcar.
 *
 * Mesma grade do agendamento, com uma diferença que importa: o **serviço** já
 * está decidido. Remarcar é escolher quando e, se quiser, com quem — trocar de
 * serviço é que exige cancelar e agendar de novo.
 *
 * A grade é consultada com os ids que vieram do agendamento, não da URL: senão
 * bastaria trocar o parâmetro para remarcar para um serviço mais caro pelo
 * preço do antigo.
 */

interface Props {
  readonly params: Promise<{ slug: string; id: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export const metadata: Metadata = {
  title: 'Remarcar',
  robots: { index: false, follow: false },
};

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const FALHA: Record<string, string> = {
  slot_taken: 'Esse horário acabou de ser ocupado. Escolha outro.',
  slot_not_available: 'Esse horário já não está disponível. Escolha outro.',
  too_late: 'Passou do prazo para remarcar. Ligue para a barbearia.',
  too_many_reschedules: 'Este horário já foi remarcado o máximo de vezes.',
  already_started: 'Este horário já começou.',
};

const MOTIVO: Record<string, string> = {
  ...MOTIVO_DE_DIA_SEM_HORARIO,
  // Só a grade pública o produz: no balcão `atCounter` impede o motor de
  // emiti-lo, e por isso ele não está na união do domínio.
  beyond_booking_window: 'Este dia ainda não está aberto para agendamento.',
};

export default async function RemarcarPage({ params, searchParams }: Props) {
  const { slug, id } = await params;
  const query = await searchParams;
  const profile = await getProfile(slug);
  if (!profile) notFound();

  const token = await lerSessao(slug);
  if (!token) redirect(`/${slug}/entrar?destino=${encodeURIComponent(`/${slug}/meus-agendamentos`)}`);

  const agendamentos = await listarAgendamentos(slug, token);
  if (agendamentos === null) redirect(`/${slug}/entrar`);

  const atual = agendamentos.find((a) => a.id === id);
  // Não distingue "não existe" de "não é seu": a lista já vem filtrada pelo
  // cliente da sessão, e diferenciar aqui viraria oráculo de existência.
  if (!atual) notFound();

  if (!atual.canReschedule) {
    redirect(`/${slug}/meus-agendamentos?erro=${atual.blockedReason ?? 'appointment_not_found'}`);
  }

  const hoje = localDate(profile.location.timezone);
  /**
   * A grade abre no dia do agendamento atual, não em hoje.
   *
   * Quem remarca costuma querer outro horário no mesmo dia, ou perto dele.
   * Abrindo em hoje, um horário marcado para sábado caía nas sobras desta
   * noite — e o cliente confirmava sem perceber que mudou de dia.
   */
  const diaAtual = localDate(profile.location.timezone, new Date(atual.startsAt));
  const dia = first(query['d']) ?? diaAtual;
  const falha = first(query['erro']);
  /**
   * A régua de dias precisa conter o dia selecionado.
   *
   * Ancorada só em hoje, um horário marcado para daqui a três semanas ficaria
   * fora dela: a grade mostraria os horários certos e nenhum dia apareceria
   * marcado. Nunca começa antes de hoje — não se remarca para o passado.
   */
  const inicio = dia > addDays(hoje, 3) ? addDays(dia, -3) : hoje;
  const dias = Array.from({ length: 14 }, (_, i) => addDays(inicio, i));

  // Rota própria da remarcação, não o `/availability` público: só ela ignora o
  // horário atual do cliente na ocupação — a mesma conta que a gravação faz.
  /**
   * Com quem. O padrão é quem já atende — trocar de horário é o pedido comum.
   *
   * Trocar de barbeiro exigia cancelar e agendar de novo, o que jogava fora o
   * horário atual antes de saber se havia outro. Aqui o horário só sai quando o
   * novo entra.
   */
  const quem = first(query['p']) ?? atual.professionalId;
  const doDia = await opcoesDeRemarcacao(slug, token, id, dia, quem);

  const equipe = profile.professionals.filter((pessoa) =>
    atual.serviceIds.every((servico) =>
      profile.categories.some((c) =>
        c.services.some((s) => s.id === servico && s.professionalIds.includes(pessoa.id)),
      ),
    ),
  );
  const nomePorId = new Map(profile.professionals.map((p) => [p.id, p.name]));

  /**
   * O horário que o cliente já tem aparece na grade — a rota o ignora na
   * ocupação, então ele volta como livre. Marcá-lo evita a armadilha de
   * "remarcar" para o mesmo horário: nada mudaria e uma das remarcações
   * permitidas seria gasta à toa.
   */
  const horaAtual = localTime(profile.location.timezone, atual.startsAt);

  const href = (mudanca: { d?: string; p?: string }): string => {
    const busca = new URLSearchParams({ d: mudanca.d ?? dia, p: mudanca.p ?? quem });
    return `/${slug}/meus-agendamentos/${id}/remarcar?${busca.toString()}`;
  };

  return (
    <main className="ui-container fluxo">
      <a className="meus__voltar" href={`/${slug}/meus-agendamentos`}>
        ← Meus agendamentos
      </a>

      <h1 className="fluxo__titulo">Novo horário</h1>

      <div className="ui-card confirmacao remarcar__atual">
        <p className="remarcar__rotulo">Hoje está marcado para</p>
        <p className="remarcar__quando tabular">
          {humanInstant(profile.location.timezone, atual.startsAt)}
        </p>
        <p className="remarcar__servico">
          {atual.services.join(' + ')} · com {atual.professionalName}
        </p>
      </div>

      {falha ? (
        <div className="ui-alert ui-alert--danger fluxo__falha" role="alert">
          {FALHA[falha] ?? 'Não foi possível remarcar. Tente de novo.'}
        </div>
      ) : null}

      {equipe.length > 1 ? (
        <div className="quem ui-scroll-x" role="group" aria-label="Com quem">
          <ul className="quem__lista">
            <li>
              <a
                className={`quem__opcao ${quem === 'any' ? 'quem__opcao--atual' : ''}`}
                href={href({ p: 'any' })}
                aria-current={quem === 'any' ? 'true' : undefined}
              >
                Qualquer profissional
              </a>
            </li>
            {equipe.map((pessoa) => (
              <li key={pessoa.id}>
                <a
                  className={`quem__opcao ${quem === pessoa.id ? 'quem__opcao--atual' : ''}`}
                  href={href({ p: pessoa.id })}
                  aria-current={quem === pessoa.id ? 'true' : undefined}
                >
                  {pessoa.name}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="dias ui-scroll-x">
        <ul className="dias__lista">
          {dias.map((data) => (
            <li key={data}>
              <a
                className={`dia ${data === dia ? 'dia--atual' : ''}`}
                href={href({ d: data })}
                aria-current={data === dia ? 'date' : undefined}
              >
                <span className="dia__semana">
                  {weekdayShort(profile.location.timezone, data)}
                </span>
                <span className="dia__numero tabular">{dayNumber(data)}</span>
              </a>
            </li>
          ))}
        </ul>
      </div>

      {doDia && doDia.slots.length > 0 ? (
        <ul className="horas">
          {doDia.slots.map((slot) => {
            const eAtual =
              dia === diaAtual &&
              slot.start === horaAtual &&
              slot.professionalId === atual.professionalId;
            return (
              <li key={slot.start}>
                {eAtual ? (
                  <p className="hora hora--atual">
                    <span className="hora__valor tabular">{slot.start}</span>
                    <span className="hora__quem">seu horário</span>
                  </p>
                ) : (
                  /* Botão, não link: escolher o horário aqui já grava. */
                  <form action={remarcar}>
                    <input type="hidden" name="slug" value={slug} />
                    <input type="hidden" name="id" value={id} />
                    <input type="hidden" name="date" value={dia} />
                    <input type="hidden" name="start" value={slot.start} />
                    {/* O id vem do slot, não do filtro: com "qualquer
                        profissional" a grade já resolveu quem atende, e mandar
                        `any` faria o servidor escolher de novo — podendo cair
                        em outra pessoa entre a tela e a gravação. */}
                    <input type="hidden" name="professionalId" value={slot.professionalId} />
                    <button className="hora hora--botao" type="submit">
                      <span className="hora__valor tabular">{slot.start}</span>
                      {quem === 'any' ? (
                        <span className="hora__quem">
                          {nomePorId.get(slot.professionalId) ?? ''}
                        </span>
                      ) : null}
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="vazio">
          <p className="vazio__titulo">Nenhum horário neste dia</p>
          <p className="vazio__saida">
            {MOTIVO[doDia?.unavailableReason ?? ''] ?? 'Tente outro dia.'}
          </p>
          <a className="ui-button ui-button--secondary" href={href({ d: addDays(dia, 1) })}>
            Ver o dia seguinte
          </a>
        </div>
      )}

      <p className="remarcar__nota">
        Seu horário atual continua reservado até você escolher o novo.
      </p>
    </main>
  );
}
