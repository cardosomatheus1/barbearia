import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getComprovante, getProfile } from '@/lib/api';
import { humanInstant } from '@/lib/date';
import { regraDeCancelamento } from '@/lib/politica';

/**
 * Confirmação. A tela existe para dizer o que foi feito e o que vem depois.
 *
 * Os dados vêm da API, não da URL. Repetir o que o formulário mandou seria
 * afirmar sem conferir: "Qualquer profissional" nunca viraria um nome, e um
 * agendamento já cancelado continuaria aparecendo como confirmado.
 */

interface Props {
  readonly params: Promise<{ slug: string; id: string }>;
}

export const metadata: Metadata = {
  title: 'Agendamento confirmado',
  // O id na URL é a credencial do comprovante; indexar publicaria o link.
  robots: { index: false, follow: false },
};

const money = (cents: number): string =>
  (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

const TITULO: Record<string, string> = {
  active: 'Agendamento confirmado',
  done: 'Atendimento concluído',
  cancelled: 'Agendamento cancelado',
  // Quem abrir o link antigo depois de remarcar precisa entender que o horário
  // mudou, não que foi cancelado.
  rescheduled: 'Este horário foi remarcado',
};

const MARCA: Record<string, string> = {
  active: '✓', done: '✓', cancelled: '×', rescheduled: '→',
};

export default async function ConfirmadoPage({ params }: Props) {
  const { slug, id } = await params;
  const [profile, comprovante] = await Promise.all([getProfile(slug), getComprovante(slug, id)]);
  if (!profile || !comprovante) notFound();

  const ativo = comprovante.state === 'active';
  const quando = humanInstant(profile.location.timezone, comprovante.startsAt);
  const minutos = Math.round(
    (new Date(comprovante.endsAt).getTime() - new Date(comprovante.startsAt).getTime()) / 60000,
  );
  const endereco = [profile.location.street, profile.location.district, profile.location.city]
    .filter(Boolean)
    .join(' · ');

  return (
    <main className={`ui-container confirmado ${comprovante.state === 'active' || comprovante.state === 'done' ? '' : 'confirmado--cancelado'}`}>
      <p className="confirmado__marca" aria-hidden="true">
        {MARCA[comprovante.state] ?? '✓'}
      </p>
      <h1 className="confirmado__titulo">
        {TITULO[comprovante.state] ?? 'Agendamento'}
      </h1>

      <p className="confirmado__quando tabular">{quando}</p>

      <p className="confirmado__onde">
        {profile.name}
        {endereco ? <> · {endereco}</> : null}
      </p>

      {/* O comprovante: o que foi marcado, com quem, quanto tempo e quanto custa. */}
      <dl className="comprovante">
        <div className="comprovante__linha">
          <dt>Serviço</dt>
          <dd>{comprovante.services.join(' + ')}</dd>
        </div>
        <div className="comprovante__linha">
          <dt>Com</dt>
          <dd>{comprovante.professionalName}</dd>
        </div>
        <div className="comprovante__linha">
          <dt>Total</dt>
          <dd className="tabular">
            {minutos} min · R$ {money(comprovante.priceCents)}
          </dd>
        </div>
      </dl>

      {ativo ? (
        <div className="ui-alert ui-alert--info confirmado__aviso">
          Para ver ou cancelar depois, entre com o mesmo celular — a barbearia envia
          um código no WhatsApp.
        </div>
      ) : null}

      <div className="confirmado__acoes">
        {ativo && profile.location.latitude !== null && profile.location.longitude !== null ? (
          <a
            className="ui-button ui-button--primary"
            href={`https://www.google.com/maps/search/?api=1&query=${profile.location.latitude},${profile.location.longitude}`}
            rel="noopener noreferrer"
            target="_blank"
          >
            Como chegar
          </a>
        ) : null}
        <a className="ui-button ui-button--secondary" href={`/${slug}`}>
          {ativo ? 'Voltar à barbearia' : 'Agendar de novo'}
        </a>
      </div>

      {ativo ? (
        <p className="confirmado__politica">
          {/* O prazo sai da coluna que a API aplica, não do texto livre. Eles
              divergem assim que a barbearia muda um e esquece o outro — e quem
              lê a página é quem sai perdendo. */}
          {regraDeCancelamento(profile.location.cancelMinHours)}
          {profile.location.cancellationPolicy ? (
            <> {profile.location.cancellationPolicy}</>
          ) : null}
        </p>
      ) : null}
    </main>
  );
}
