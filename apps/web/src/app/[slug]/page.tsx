import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getProfile, getToday, type PublicProfile } from '@/lib/api';
import { localDate } from '@/lib/date';
import { jsonLd, jsonLdScript } from '@/lib/json-ld';
import { regraDeCancelamento } from '@/lib/politica';

/**
 * Página pública da barbearia, renderizada no servidor.
 *
 * A tese: o herói é a **disponibilidade**, não uma foto com botão por cima.
 * Quem chega pelo link da bio já viu as fotos no Instagram — veio saber quando
 * dá para ir. Ver `docs/03-direcao-visual.md`.
 */

interface Params {
  readonly params: Promise<{ slug: string }>;
}

const money = (cents: number): string =>
  (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const profile = await getProfile(slug);
  if (!profile) return { title: 'Estabelecimento não encontrado' };

  const where = [profile.location.district, profile.location.city].filter(Boolean).join(', ');
  const from = profile.priceFromCents ? ` · a partir de R$ ${money(profile.priceFromCents)}` : '';
  const description = profile.location.about ?? `Agende seu horário${from}.`;

  return {
    title: `${profile.name}${where ? ` — ${where}` : ''}`,
    description,
    openGraph: {
      title: profile.name,
      description,
      type: 'website',
      ...(profile.location.coverUrl ? { images: [profile.location.coverUrl] } : {}),
    },
    alternates: { canonical: `/${profile.slug}` },
  };
}

export default async function BarbershopPage({ params }: Params) {
  const { slug } = await params;
  const profile = await getProfile(slug);
  if (!profile) notFound();

  const today = localDate(profile.location.timezone);
  const firstService = profile.categories[0]?.services[0];
  const availability = firstService
    ? await getToday(slug, profile.location.id, firstService.id, today)
    : null;

  const byId = new Map(profile.professionals.map((p) => [p.id, p.name]));
  const address = [profile.location.street, profile.location.district, profile.location.city]
    .filter(Boolean)
    .join(' · ');

  return (
    <>
      <script
        type="application/ld+json"
        // JSON-LD é o que faz o Google mostrar nota, preço e "Aberto agora" no
        // resultado da busca. Sem ele a barbearia é só um link azul.
        //
        // `jsonLdScript`, não `JSON.stringify`: este é o único ponto do sistema
        // que injeta HTML sem escape do React, e `JSON.stringify` não escapa `<`.
        dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd(profile)) }}
      />

      <a className="ui-skip-link" href="#servicos">
        Pular para os serviços
      </a>

      <header className="topo">
        <div className="ui-container topo__linha">
          <div>
            <h1 className="topo__nome">{profile.name}</h1>
            {address ? <p className="topo__onde">{address}</p> : null}
          </div>
          <p className={`estado ${profile.open.isOpen ? 'estado--aberto' : ''}`}>
            <span className="estado__ponto" aria-hidden="true" />
            {profile.open.isOpen ? 'Aberto' : 'Fechado'}
            <span className="estado__detalhe"> · {profile.open.detail}</span>
          </p>
        </div>
      </header>

      <main>
        <section className="hoje" aria-labelledby="hoje-titulo">
          <div className="ui-container">
            <h2 className="rotulo" id="hoje-titulo">
              Hoje
            </h2>

            {availability && availability.slots.length > 0 ? (
              <>
                <div className="faixa ui-scroll-x">
                  <ul className="faixa__lista">
                    {availability.slots.slice(0, 14).map((slot) => (
                      <li key={`${slot.start}-${slot.professionalId}`}>
                        <a
                          className="chip"
                          href={`/${slug}/s/${firstService?.id ?? ''}?d=${today}&h=${slot.start}`}
                        >
                          <span className="chip__hora tabular">{slot.start}</span>
                          <span className="chip__quem">{byId.get(slot.professionalId) ?? ''}</span>

                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
                <p className="hoje__nota">
                  {availability.slots.length > 14
                    ? `e mais ${availability.slots.length - 14} horários`
                    : `${availability.slots.length} horários livres`}
                </p>
              </>
            ) : (
              /* Tela vazia é convite para agir, não lista em branco. */
              <div className="vazio">
                <p className="vazio__titulo">Sem horário livre hoje</p>
                <p className="vazio__saida">
                  {profile.open.detail.startsWith('abre')
                    ? `A barbearia ${profile.open.detail}.`
                    : 'Veja os próximos dias na tela de agendamento.'}
                </p>
                <a className="ui-button ui-button--secondary" href={`/${slug}/agendar`}>
                  Ver outros dias
                </a>
              </div>
            )}
          </div>
        </section>

        <section className="secao" id="servicos" aria-labelledby="servicos-titulo">
          <div className="ui-container">
            <h2 className="rotulo" id="servicos-titulo">
              Serviços
            </h2>

            {profile.categories.map((categoria) => (
              <div className="grupo" key={categoria.id ?? categoria.name}>
                {/* A régua carrega a categoria real do cardápio, não decora. */}
                <h3 className="grupo__titulo">
                  <span>{categoria.name}</span>
                  <span className="grupo__regua" aria-hidden="true" />
                </h3>

                <ul className="servicos">
                  {categoria.services.map((servico) => (
                    <li key={servico.id}>
                      <a className="servico" href={`/${slug}/s/${servico.id}`}>
                        <span className="servico__nome">{servico.name}</span>
                        {servico.description ? (
                          <span className="servico__sobre">{servico.description}</span>
                        ) : null}
                        <span className="servico__dados">
                          <span className="servico__duracao tabular">
                            {servico.durationMinutes} min
                          </span>
                          <span className="servico__preco tabular">
                            <span className="servico__moeda">R$</span> {money(servico.priceCents)}
                          </span>
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        {profile.professionals.length > 0 ? (
          <section className="secao" aria-labelledby="equipe-titulo">
            <div className="ui-container">
              <h2 className="rotulo" id="equipe-titulo">
                Quem atende
              </h2>
              <ul className="equipe">
                {profile.professionals.map((pessoa) => (
                  <li className="pessoa" key={pessoa.id}>
                    <a href={`/${slug}/p/${pessoa.id}`}>
                      <span className="pessoa__nome">{pessoa.name}</span>
                      {pessoa.bio ? <span className="pessoa__bio">{pessoa.bio}</span> : null}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ) : null}

        <section className="secao" aria-labelledby="onde-titulo">
          <div className="ui-container onde">
            <div>
              <h2 className="rotulo" id="onde-titulo">
                Onde fica
              </h2>
              {address ? <p className="onde__endereco">{address}</p> : null}
              {profile.location.postalCode ? (
                <p className="onde__cep tabular">CEP {profile.location.postalCode}</p>
              ) : null}

              <div className="onde__acoes">
                {profile.location.latitude !== null && profile.location.longitude !== null ? (
                  <a
                    className="ui-button ui-button--secondary"
                    href={`https://www.google.com/maps/search/?api=1&query=${profile.location.latitude},${profile.location.longitude}`}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    Como chegar
                  </a>
                ) : null}
                {profile.location.whatsapp ?? profile.location.phone ? (
                  <a
                    className="ui-button ui-button--ghost"
                    href={`tel:${profile.location.phone ?? profile.location.whatsapp}`}
                  >
                    Ligar
                  </a>
                ) : null}
              </div>

              {profile.location.amenities.length > 0 ? (
                <ul className="tags">
                  {profile.location.amenities.map((item) => (
                    <li className="tag" key={item}>
                      {AMENITY_LABEL[item] ?? item}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>

            <div>
              <h2 className="rotulo">Horários</h2>
              <table className="horarios">
                <caption className="ui-visually-hidden">Horário de funcionamento por dia</caption>
                <tbody>
                  {profile.hours.map((dia) => (
                    <tr key={dia.weekday} className={dia.opensAt ? '' : 'horarios--fechado'}>
                      <th scope="row">{WEEKDAYS[dia.weekday]}</th>
                      <td className="tabular">
                        {dia.opensAt ? `${dia.opensAt} – ${dia.closesAt}` : 'Fechado'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="secao">
          <div className="ui-container">
            <h2 className="rotulo">Cancelamento</h2>
            {/* O prazo vem da coluna que a API aplica; o texto livre da
                barbearia complementa, não substitui. */}
            <p className="politica">
              {regraDeCancelamento(profile.location.cancelMinHours)}
              {profile.location.cancellationPolicy ? (
                <> {profile.location.cancellationPolicy}</>
              ) : null}
            </p>
          </div>
        </section>
      </main>

      <div className="ui-sticky-action">
        <div className="ui-container">
          <a className="ui-button ui-button--primary ui-button--lg ui-button--block" href={`/${slug}/agendar`}>
            Agendar horário
          </a>
        </div>
      </div>
    </>
  );
}

const AMENITY_LABEL: Record<string, string> = {
  wifi: 'Wi-Fi',
  card: 'Cartão',
  pix: 'Pix',
  cash: 'Dinheiro',
  parking: 'Estacionamento',
  accessible: 'Acessível',
};

/**
 * A página inteira revalida a cada minuto, não a cada cinco.
 *
 * O herói é a disponibilidade ao vivo; cache longo contradiz a tese da página —
 * o visitante veria horários já ocupados. Um minuto é o limite aceitável: se um
 * horário for tomado nesse intervalo, o fluxo de agendamento recusa com
 * "Este horário já não está mais disponível", que é caminho já tratado.
 */
export const revalidate = 60;
