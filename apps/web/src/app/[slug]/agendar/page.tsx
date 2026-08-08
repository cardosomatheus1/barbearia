import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getProfile, getAvailability, type PublicProfile, type PublicService } from '@/lib/api';
import { localDate, addDays, weekdayShort, dayNumber } from '@/lib/date';
import { applyBundle, suggestBundle, imagemPublica, PROPORCAO } from '@barbearia/core';
import { criarAgendamento } from './acoes';

/**
 * Fluxo de agendamento.
 *
 * Cada passo é uma URL, não estado em memória. Três razões concretas:
 * o botão voltar funciona, o link é compartilhável, e a página continua
 * navegável sem JavaScript — o cliente está num Android modesto, em rede móvel.
 *
 * A ordem segue o que o mercado pratica e o que a análise confirmou:
 * serviço → profissional → horário → nome e celular. **Sem código.** O sistema
 * estudado envia o campo de código vazio e conclui sem verificação; exigir
 * validação aqui seria atrito que ninguém pratica (ver `docs/01-analise`).
 */

interface Props {
  readonly params: Promise<{ slug: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export const metadata: Metadata = {
  title: 'Agendar horário',
  // A tela de fluxo não deve competir com a página da barbearia na busca.
  robots: { index: false, follow: true },
};

const money = (cents: number): string =>
  (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/**
 * Falhas da API traduzidas para o cliente.
 *
 * Erro que volta sem mensagem é pior que erro: o cliente reenvia o formulário
 * achando que o toque não pegou. O texto diz o que houve e o que fazer.
 */
const FALHA: Record<string, string> = {
  slot_not_available:
    'Este horário acabou de ser ocupado. Escolha outro — a lista já está atualizada.',
  slot_taken:
    'Este horário acabou de ser ocupado. Escolha outro — a lista já está atualizada.',
  invalid_phone: 'Confira o celular: precisa ter DDD e nove dígitos.',
  invalid_request: 'Confira os dados e tente de novo.',
  unknown_location: 'Esta unidade não está mais disponível.',
  otp_required: 'Esta barbearia pede validação do número. Entre com seu celular primeiro.',
};

const MOTIVO: Record<string, string> = {
  closed: 'A barbearia não abre neste dia.',
  fully_booked: 'Todos os horários deste dia já foram preenchidos.',
  daily_limit_reached: 'A agenda deste dia já está completa.',
  resource_unavailable: 'Não há estrutura livre para este serviço neste dia.',
  past_cutoff: 'Já passou do horário de agendar para hoje.',
  no_qualified_professional: 'Ninguém executa esta combinação de serviços.',
  beyond_booking_window: 'Este dia ainda não está aberto para agendamento.',
};

export default async function AgendarPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const query = await searchParams;
  const profile = await getProfile(slug);
  if (!profile) notFound();

  const catalogo = new Map<string, PublicService>();
  for (const categoria of profile.categories) {
    for (const servico of categoria.services) catalogo.set(servico.id, servico);
  }

  const escolhidos = (first(query['s']) ?? '')
    .split(',')
    .filter((id) => catalogo.has(id));
  const profissional = first(query['p']);
  const dia = first(query['d']) ?? localDate(profile.location.timezone);
  const hora = first(query['h']);
  const falha = first(query['erro']);

  /**
   * O passo é **marcado** na URL, não inferido do que está preenchido.
   *
   * Inferir quebrava o carrinho: escolher um serviço já pulava para o passo 2,
   * e não havia como adicionar o segundo. Corte + barba na mesma ida é o caso
   * mais comum numa barbearia.
   *
   * O guarda impede estado impossível vindo de link colado: cai no passo mais
   * cedo que ainda falta.
   */
  const marcado = first(query['e']);
  const passo =
    marcado === 'd' && escolhidos.length > 0 && profissional && hora ? 4
    : marcado === 'h' && escolhidos.length > 0 && profissional ? 3
    : marcado === 'p' && escolhidos.length > 0 ? 2
    : 1;

  const carrinho = escolhidos.map((id) => catalogo.get(id)!);
  const total = carrinho.reduce((soma, s) => soma + s.priceCents, 0);
  const duracao = carrinho.reduce((soma, s) => soma + s.durationMinutes, 0);

  const href = (mudanca: Record<string, string | null>): string => {
    const base = new URLSearchParams();
    const atual: Record<string, string | undefined> = {
      s: escolhidos.join(',') || undefined,
      p: profissional,
      d: query['d'] ? dia : undefined,
      h: hora,
      e: marcado,
      ...Object.fromEntries(
        Object.entries(mudanca).map(([k, v]) => [k, v === null ? undefined : v]),
      ),
    };
    for (const [chave, valor] of Object.entries(atual)) {
      if (valor) base.set(chave, valor);
    }
    const busca = base.toString();
    return `/${slug}/agendar${busca ? `?${busca}` : ''}`;
  };

  return (
    <>
      <header className="fluxo-topo">
        <div className="ui-container fluxo-topo__linha">
          <a className="voltar" href={passo === 1 ? `/${slug}` : href(voltarDe(passo))}>
            <span aria-hidden="true">←</span> Voltar
          </a>
          <p className="fluxo-topo__nome">{profile.name}</p>
        </div>
        {/* A régua mostra progresso real, não decoração: quatro decisões. */}
        <div className="ui-container">
          <ol className="passos" aria-label={`Passo ${passo} de 4`}>
            {['Serviço', 'Profissional', 'Horário', 'Seus dados'].map((nome, indice) => (
              <li
                key={nome}
                className={`passos__item ${indice + 1 === passo ? 'passos__item--atual' : ''} ${
                  indice + 1 < passo ? 'passos__item--feito' : ''
                }`}
                aria-current={indice + 1 === passo ? 'step' : undefined}
              >
                <span className="ui-visually-hidden">
                  {indice + 1 < passo ? 'Concluído: ' : indice + 1 === passo ? 'Atual: ' : ''}
                </span>
                {nome}
              </li>
            ))}
          </ol>
        </div>
      </header>

      <main className="ui-container fluxo">
        {passo === 1 ? (
          <PassoServico
            profile={profile}
            escolhidos={escolhidos}
            catalogo={catalogo}
            href={href}
          />
        ) : null}

        {passo === 2 ? (
          <PassoProfissional profile={profile} carrinho={carrinho} href={href} />
        ) : null}

        {passo === 3 ? (
          <PassoHorario
            slug={slug}
            profile={profile}
            escolhidos={escolhidos}
            profissional={profissional!}
            dia={dia}
            href={href}
          />
        ) : null}

        {passo === 4 ? (
          <PassoDados
            slug={slug}
            profile={profile}
            carrinho={carrinho}
            escolhidos={escolhidos}
            profissional={profissional!}
            dia={dia}
            hora={hora!}
            href={href}
            {...(falha ? { falha } : {})}
          />
        ) : null}
      </main>

      {carrinho.length > 0 && passo < 4 ? (
        <div className="ui-sticky-action">
          <div className="ui-container resumo">
            <div>
              <p className="resumo__servicos">
                {carrinho.map((s) => s.name).join(' + ')}
              </p>
              <p className="resumo__dados tabular">
                {duracao} min · R$ {money(total)}
              </p>
            </div>
            {passo === 1 ? (
              <a className="ui-button ui-button--primary" href={href({ e: 'p', p: null })}>
                Continuar
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

function voltarDe(passo: number): Record<string, string | null> {
  if (passo === 4) return { h: null, e: 'h' };
  if (passo === 3) return { p: null, d: null, e: 'p' };
  return { e: null };
}

/* -- Passo 1: serviço ------------------------------------------------------ */

function PassoServico({
  profile,
  escolhidos,
  catalogo,
  href,
}: {
  profile: PublicProfile;
  escolhidos: string[];
  catalogo: Map<string, PublicService>;
  href: (m: Record<string, string | null>) => string;
}) {
  /**
   * O mesmo atendimento existe duas vezes no cardápio: solto e em combo. Sem
   * este aviso, quem monta a escolha à mão paga a mais — na Domari, R$ 84,00
   * contra R$ 74,00 — sem descobrir que a própria barbearia oferece melhor.
   */
  const sugestao = suggestBundle(
    escolhidos,
    (id) => catalogo.get(id)?.priceCents,
    profile.bundles.map((b) => ({
      serviceId: b.serviceId,
      name: b.name,
      priceCents: b.priceCents,
      componentIds: b.componentIds,
    })),
  );

  return (
    <section aria-labelledby="titulo">
      <h1 className="fluxo__titulo" id="titulo">
        O que você vai fazer?
      </h1>
      <p className="fluxo__ajuda">Pode escolher mais de um.</p>

      {sugestao ? (
        <div className="oferta" role="status">
          <p className="oferta__texto">
            <strong>{sugestao.name}</strong> sai por{' '}
            <span className="tabular">R$ {money(sugestao.priceCents)}</span> — economiza{' '}
            <span className="tabular">R$ {money(sugestao.savesCents)}</span>.
          </p>
          {/* Link, não troca automática: quem escolheu solto pode ter motivo, e
              mexer no carrinho por conta própria é o que faz o cliente
              desconfiar do preço no fim. */}
          <a
            className="ui-button ui-button--secondary oferta__trocar"
            href={href({ s: applyBundle(escolhidos, sugestao).join(',') })}
          >
            Trocar pelo combo
          </a>
        </div>
      ) : null}

      {profile.categories.map((categoria) => (
        <div className="grupo" key={categoria.id ?? categoria.name}>
          <h2 className="grupo__titulo">
            <span>{categoria.name}</span>
            <span className="grupo__regua" aria-hidden="true" />
          </h2>

          <ul className="servicos">
            {categoria.services.map((servico) => {
              const marcado = escolhidos.includes(servico.id);
              const novos = marcado
                ? escolhidos.filter((id) => id !== servico.id)
                : [...escolhidos, servico.id];
              // A foto já aparecia no cardápio da página pública e sumia
              // justamente aqui, que é onde a escolha acontece. Numa barbearia
              // ela é o argumento (CLAUDE.md §5), e o dado já estava carregado.
              const foto = imagemPublica(servico.photoUrl);

              return (
                <li key={servico.id}>
                  {/* É um link: navega para a URL com o serviço alternado.
                      `role="button"` seria mentira e `aria-pressed` em link é
                      ARIA inválido — o estado vai em texto para o leitor. */}
                  <a
                    className={`servico escolha ${marcado ? 'escolha--marcada' : ''}`}
                    href={href({ s: novos.join(',') || null, p: null, d: null, h: null, e: null })}
                  >
                    <span className="escolha__marca" aria-hidden="true">
                      {marcado ? '✓' : ''}
                    </span>
                    {foto ? (
                      /* eslint-disable-next-line @next/next/no-img-element -- mesmo
                         motivo do cardápio: domínio externo arbitrário. */
                      <img
                        alt=""
                        className="escolha__foto"
                        height={PROPORCAO.servico.height}
                        src={foto}
                        width={PROPORCAO.servico.width}
                      />
                    ) : null}
                    <span className="servico__nome">
                      {servico.name}
                      <span className="ui-visually-hidden">
                        {marcado ? ' — escolhido, toque para remover' : ' — toque para escolher'}
                      </span>
                    </span>
                    {servico.description ? (
                      <span className="servico__sobre">{servico.description}</span>
                    ) : null}
                    <span className="servico__dados">
                      <span className="servico__duracao tabular">{servico.durationMinutes} min</span>
                      <span className="servico__preco tabular">
                        <span className="servico__moeda">R$</span> {money(servico.priceCents)}
                      </span>
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

/* -- Passo 2: profissional ------------------------------------------------- */

function PassoProfissional({
  profile,
  carrinho,
  href,
}: {
  profile: PublicProfile;
  carrinho: PublicService[];
  href: (m: Record<string, string | null>) => string;
}) {
  // Só quem executa **todos** os serviços escolhidos, como o motor já filtra.
  const habilitados = profile.professionals.filter((pessoa) =>
    carrinho.every((servico) => servico.professionalIds.includes(pessoa.id)),
  );

  return (
    <section aria-labelledby="titulo">
      <h1 className="fluxo__titulo" id="titulo">
        Com quem?
      </h1>

      <ul className="opcoes">
        {/* Primeira opção e a mais usada: quem quer o horário, não a pessoa.
            O sistema analisado obriga a escolher antes de ver a agenda (D7). */}
        <li>
          <a className="opcao opcao--destaque" href={href({ p: 'any', e: 'h' })}>
            <span className="opcao__nome">Qualquer profissional</span>
            <span className="opcao__sobre">Mostra todos os horários livres</span>
          </a>
        </li>

        {habilitados.map((pessoa) => (
          <li key={pessoa.id}>
            <a className="opcao" href={href({ p: pessoa.id, e: 'h' })}>
              <span className="opcao__nome">{pessoa.name}</span>
              {pessoa.bio ? <span className="opcao__sobre">{pessoa.bio}</span> : null}
            </a>
          </li>
        ))}
      </ul>

      {habilitados.length === 0 ? (
        <div className="vazio">
          <p className="vazio__titulo">Ninguém faz essa combinação</p>
          <p className="vazio__saida">Volte e escolha os serviços separadamente.</p>
        </div>
      ) : null}
    </section>
  );
}

/* -- Passo 3: horário ------------------------------------------------------ */

async function PassoHorario({
  slug,
  profile,
  escolhidos,
  profissional,
  dia,
  href,
}: {
  slug: string;
  profile: PublicProfile;
  escolhidos: string[];
  profissional: string;
  dia: string;
  href: (m: Record<string, string | null>) => string;
}) {
  const hoje = localDate(profile.location.timezone);
  const dias = Array.from({ length: 14 }, (_, i) => addDays(hoje, i));

  const resultado = await getAvailability(slug, {
    locationId: profile.location.id,
    serviceIds: escolhidos,
    dateFrom: dia,
    ...(profissional === 'any' ? { anyProfessional: true } : { professionalId: profissional }),
  });

  const doDia = resultado?.days[0];
  const nomePorId = new Map(profile.professionals.map((p) => [p.id, p.name]));

  return (
    <section aria-labelledby="titulo">
      <h1 className="fluxo__titulo" id="titulo">
        Quando?
      </h1>

      <div className="dias ui-scroll-x">
        <ul className="dias__lista">
          {dias.map((data) => (
            <li key={data}>
              <a
                className={`dia ${data === dia ? 'dia--atual' : ''}`}
                href={href({ d: data, h: null, e: 'h' })}
                aria-current={data === dia ? 'date' : undefined}
              >
                <span className="dia__semana">{weekdayShort(profile.location.timezone, data)}</span>
                <span className="dia__numero tabular">{dayNumber(data)}</span>
              </a>
            </li>
          ))}
        </ul>
      </div>

      {doDia && doDia.slots.length > 0 ? (
        <ul className="horas">
          {doDia.slots.map((slot) => (
            <li key={`${slot.start}-${slot.professionalId}`}>
              <a className="hora" href={href({ d: dia, h: slot.start, e: 'd' })}>
                <span className="hora__valor tabular">{slot.start}</span>
                {profissional === 'any' ? (
                  <span className="hora__quem">{nomePorId.get(slot.professionalId) ?? ''}</span>
                ) : null}
              </a>
            </li>
          ))}
        </ul>
      ) : (
        /* Tela vazia é direção, não fim de linha: diz o motivo e o que fazer. */
        <div className="vazio">
          <p className="vazio__titulo">Nenhum horário neste dia</p>
          <p className="vazio__saida">
            {MOTIVO[doDia?.unavailableReason ?? ''] ?? 'Tente outro dia.'}
          </p>
          <a className="ui-button ui-button--secondary" href={href({ d: addDays(dia, 1), h: null, e: 'h' })}>
            Ver o dia seguinte
          </a>
        </div>
      )}
    </section>
  );
}

/* -- Passo 4: nome e celular ----------------------------------------------- */

function PassoDados({
  slug,
  profile,
  carrinho,
  escolhidos,
  profissional,
  dia,
  hora,
  href,
  falha,
}: {
  slug: string;
  profile: PublicProfile;
  carrinho: PublicService[];
  escolhidos: string[];
  profissional: string;
  dia: string;
  hora: string;
  href: (m: Record<string, string | null>) => string;
  falha?: string;
}) {
  const total = carrinho.reduce((soma, s) => soma + s.priceCents, 0);
  const duracao = carrinho.reduce((soma, s) => soma + s.durationMinutes, 0);
  const quem =
    profissional === 'any'
      ? 'Qualquer profissional'
      : (profile.professionals.find((p) => p.id === profissional)?.name ?? '');

  return (
    <section aria-labelledby="titulo">
      <h1 className="fluxo__titulo" id="titulo">
        Falta só seu nome
      </h1>

      {falha ? (
        <div className="ui-alert ui-alert--danger fluxo__falha" role="alert">
          {FALHA[falha] ?? 'Não foi possível concluir. Tente de novo.'}
          {falha === 'slot_not_available' || falha === 'slot_taken' ? (
            <>
              {' '}
              <a href={href({ h: null, e: 'h' })}>Ver horários</a>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="ui-card confirmacao">
        <dl className="confere">
          <div>
            <dt>Serviço</dt>
            <dd>{carrinho.map((s) => s.name).join(' + ')}</dd>
          </div>
          <div>
            <dt>Quando</dt>
            <dd className="tabular">
              {new Date(`${dia}T12:00:00Z`).toLocaleDateString('pt-BR', {
                weekday: 'long',
                day: '2-digit',
                month: 'long',
                timeZone: 'UTC',
              })}
              , {hora}
            </dd>
          </div>
          <div>
            <dt>Com</dt>
            <dd>{quem}</dd>
          </div>
          <div>
            <dt>Total</dt>
            <dd className="tabular">
              {duracao} min · R$ {total.toString() ? money(total) : ''}
            </dd>
          </div>
        </dl>
        <a className="confere__trocar" href={href({ h: null, e: 'h' })}>
          Trocar horário
        </a>
      </div>

      <form action={criarAgendamento} className="formulario">
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="locationId" value={profile.location.id} />
        <input type="hidden" name="serviceIds" value={escolhidos.join(',')} />
        <input type="hidden" name="professionalId" value={profissional} />
        <input type="hidden" name="date" value={dia} />
        <input type="hidden" name="start" value={hora} />

        <div className="ui-field">
          <label className="ui-field__label" htmlFor="nome">
            Nome
          </label>
          <input
            className="ui-field__input"
            id="nome"
            name="name"
            required
            minLength={3}
            maxLength={80}
            autoComplete="name"
            placeholder="Nome e sobrenome"
          />
        </div>

        <div className="ui-field">
          <label className="ui-field__label" htmlFor="celular">
            Celular (WhatsApp)
          </label>
          <input
            className="ui-field__input"
            id="celular"
            name="phone"
            required
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="(71) 98888-7777"
            aria-describedby="celular-ajuda"
          />
          <p className="ui-field__hint" id="celular-ajuda">
            É por ele que você vê e cancela depois.
          </p>
        </div>

        <button className="ui-button ui-button--primary ui-button--lg ui-button--block" type="submit">
          Confirmar agendamento
        </button>
      </form>
    </section>
  );
}
