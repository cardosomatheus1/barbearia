import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  horariosEmDestaque,
  horariosRestantes,
  imagemPublica,
  PROPORCAO,
  notaExibida,
  ROTULO_DA_COMODIDADE,
  type Comodidade,
} from '@barbearia/core';
import { getAvaliacoesPublicas, getProfile, getToday, type PublicProfile } from '@/lib/api';
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

  const capa = imagemPublica(profile.location.coverUrl);
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
      ...(capa ? { images: [capa] } : {}),
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

  /**
   * A grade e a reputação juntas.
   *
   * As duas dependem do perfil e de mais nada uma da outra: encadeá-las somaria
   * a latência de uma na outra numa página cujo alvo de LCP é 2,5s em 4G.
   */
  const [availability, reputacao] = await Promise.all([
    firstService ? getToday(slug, profile.location.id, firstService.id, today) : null,
    getAvaliacoesPublicas(slug),
  ]);

  /**
   * Seis cartões espalhados pelo dia, não os seis primeiros da fila.
   *
   * A grade sai ordenada por horário, então "os primeiros" eram
   * `12:30 12:35 12:40 12:45` — a mesma hora quatro vezes, seguida de "e mais
   * 122 horários". Isso não é escolha, é o começo de uma lista.
   */
  /**
   * Revalidado na leitura, não só na gravação.
   *
   * Hoje `savePhotos` é o único caminho que escreve estas colunas, e ele já
   * valida. Mas o dado fica no banco por anos e a próxima importação em massa
   * ou migração não vai lembrar — e o endereço termina num atributo HTML e no
   * `og:image`. Validar dos dois lados custa uma expressão regular.
   */
  const capa = imagemPublica(profile.location.coverUrl);

  const destaque = availability ? horariosEmDestaque(availability.slots, 6) : [];
  const restantes = availability ? horariosRestantes(availability.slots, destaque.length) : 0;

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
        {/* A abertura é uma composição só: o que dá para marcar hoje à esquerda,
            a foto do salão à direita. A tese não mudou — o herói continua sendo
            a disponibilidade, e no celular ela continua vindo primeiro, porque
            é a ordem do DOM. O que mudou é que num notebook metade da dobra era
            fundo vazio enquanto a única foto da página esperava embaixo, fora
            do campo de visão. Em barbearia a escolha é visual: a foto trabalha
            ao lado do horário, não depois dele. */}
        <div className="abertura">
        <div className="ui-container abertura__grade">
        <section className="hoje" aria-labelledby="hoje-titulo">
          <div>
            <h2 className="rotulo" id="hoje-titulo">
              Hoje
            </h2>

            {availability && availability.slots.length > 0 ? (
              <>
                <div className="faixa ui-scroll-x">
                  <ul className="faixa__lista">
                    {destaque.map((slot) => (
                      <li key={`${slot.start}-${slot.professionalId}`}>
                        <a
                          className="chip"
                          href={`/${slug}/s/${firstService?.id ?? ''}?d=${today}&h=${slot.start}`}
                        >
                          <span className="chip__hora tabular">{slot.start}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
                {/* O cartão carrega só o horário, que é o que se escolhe.
                    O nome do barbeiro saía dentro de cada um e repetia seis
                    vezes o mesmo — a grade vem colapsada por horário, então o
                    primeiro da fila ganhava todos. Pior que ruído: sugeria que
                    só ele estava livre. Quem atende é escolha do passo seguinte,
                    e a seção "Quem atende" mostra a equipe com rosto. */}
                <p className="hoje__nota">
                  {restantes > 0
                    ? `e mais ${restantes} ${restantes === 1 ? 'horário' : 'horários'} hoje`
                    : `${destaque.length} ${destaque.length === 1 ? 'horário livre' : 'horários livres'} hoje`}
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

            {/* A entrada da conversa fica **aqui**, colada na agenda, porque é
                aqui que mora a intenção de marcar — e é um link dentro de frase,
                não um botão: a ação primária da tela continua sendo "Agendar
                horário", e duas ações em destaque não são duas, são nenhuma.

                É diferente de "Fale com a gente" lá embaixo, e a diferença está
                escrita nas duas: aqui se pergunta e se recebe horário agora; lá
                se deixa recado para a equipe ler depois. */}
            <p className="politica agenda__conversa">
              Não achou o que queria? <a href={`/${slug}/conversar`}>Escreva o que você
              precisa</a> — em português mesmo, como no balcão.
            </p>
          </div>
        </section>

        {capa ? (
          /* No celular ela continua vindo **depois** da agenda, porque é a ordem
             do DOM e o herói é a disponibilidade (docs/03-direcao-visual.md).
             `width`/`height` reservam o espaço para ela não empurrar o
             conteúdo ao carregar — o toque errado no horário errado. */
          <figure className="capa">
            {/* eslint-disable-next-line @next/next/no-img-element -- domínio
                externo arbitrário; `next/image` exigiria cadastrá-lo antes. */}
            <img
              alt={`Ambiente da ${profile.name}`}
              className="capa__img"
              height={PROPORCAO.capa.height}
              src={capa}
              width={PROPORCAO.capa.width}
            />
          </figure>
        ) : null}
        </div>
        </div>

        <div className="corpo ui-container">
        <section className="secao secao--menu" id="servicos" aria-labelledby="servicos-titulo">
          <div>
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
                  {categoria.services.map((servico) => {
                    const foto = imagemPublica(servico.photoUrl);
                    return (
                    <li key={servico.id}>
                      <a
                        className={`servico ${foto ? 'servico--ilustrado' : ''}`}
                        href={`/${slug}/s/${servico.id}`}
                      >
                        {foto ? (
                          /* eslint-disable-next-line @next/next/no-img-element */
                          <img
                            alt=""
                            className="servico__foto"
                            height={PROPORCAO.servico.height}
                            src={foto}
                            width={PROPORCAO.servico.width}
                          />
                        ) : null}
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
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </section>

        <aside className="lado">
        {profile.professionals.length > 0 ? (
          <section className="secao" aria-labelledby="equipe-titulo">
            <div>
              <h2 className="rotulo" id="equipe-titulo">
                Quem atende
              </h2>
              {/* O cliente escolhe barbeiro por rosto. Sem foto, esta seção era
                  duas etiquetas cinzas com nomes dentro — o item mais fraco da
                  página inteira, num lugar em que a decisão é visual. */}
              <ul className="equipe">
                {profile.professionals.map((pessoa) => {
                  const rosto = imagemPublica(pessoa.photoUrl);
                  return (
                  <li className="pessoa" key={pessoa.id}>
                    {/**
                      * O link ia para `/{slug}/p/{id}`, que **não existe** — o
                      * cartão do profissional era um caminho para lugar nenhum,
                      * na seção em que a decisão do cliente acontece (§6,
                      * pergunta 1). Achado ao abrir o bloco 73.
                      *
                      * Com página pública, leva a ela; sem, leva ao agendamento
                      * já com aquela cadeira escolhida, que é o que a pessoa
                      * queria ao clicar num rosto.
                      */}
                    <a
                      className="pessoa__link"
                      href={
                        pessoa.perfilPublico
                          ? `/${slug}/b/${pessoa.perfilPublico}`
                          : `/${slug}/agendar?p=${pessoa.id}`
                      }
                    >
                      {rosto ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          alt=""
                          className="pessoa__foto"
                          height={PROPORCAO.pessoa.height}
                          src={rosto}
                          width={PROPORCAO.pessoa.width}
                        />
                      ) : (
                        /* Sem foto o lugar continua reservado, com a inicial.
                           Some a foto, não some a pessoa. */
                        <span className="pessoa__inicial" aria-hidden="true">
                          {pessoa.name.trim().charAt(0)}
                        </span>
                      )}
                      <span className="pessoa__nome">{pessoa.name}</span>
                      {pessoa.bio ? <span className="pessoa__bio">{pessoa.bio}</span> : null}
                    </a>
                  </li>
                  );
                })}
              </ul>
            </div>
          </section>
        ) : null}

        {/*
          A reputação (bloco 43, SPEC §4.10).

          Fica ao lado de "quem atende" porque responde a mesma pergunta do
          cliente novo — "posso confiar nessa casa?" —, e vem **depois** dela:
          rosto convence antes de número. Só aparece a partir de três
          avaliações; "5,0 de uma avaliação" é ruído estatístico com cara de
          excelência, e o visitante lê isso como propaganda.

          Só o primeiro nome de quem escreveu: esta página é indexada.
        */}
        {reputacao && reputacao.media !== null ? (
          <section className="secao" aria-labelledby="notas-titulo">
            <div>
              <h2 className="rotulo" id="notas-titulo">
                O que dizem
              </h2>
              <p className="reputacao">
                <span className="reputacao__nota tabular">
                  {notaExibida(reputacao.media)}
                </span>
                <span aria-hidden="true">
                  {'\u2605'.repeat(Math.round(reputacao.media))}
                </span>
                <span className="reputacao__quantas">
                  {reputacao.total} {reputacao.total === 1 ? 'avaliação' : 'avaliações'} de quem
                  foi atendido aqui
                </span>
              </p>

              {reputacao.avaliacoes
                .filter((a) => a.comentario)
                .slice(0, 3)
                .map((a, i) => (
                  <article className="avaliacao" key={`${a.quando}-${i}`}>
                    <p className="avaliacao__estrelas" aria-label={`Nota ${a.nota} de 5`}>
                      {a.estrelas}
                    </p>
                    <blockquote className="avaliacao__texto">{a.comentario}</blockquote>
                    <p className="avaliacao__quando">
                      {a.primeiroNome}
                      {a.profissionalNome ? ` · atendido por ${a.profissionalNome}` : ''}
                    </p>
                  </article>
                ))}
            </div>
          </section>
        ) : null}

        <section className="secao" aria-labelledby="onde-titulo">
          <div className="onde">
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
                      {ROTULO_DA_COMODIDADE[item as Comodidade] ?? item}
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

        <section className="secao secao--miudo">
          <div>
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

        {/*
          O encarregado de dados, publicado porque a lei manda publicar.

          LGPD art. 41 §1: a identidade e o contato do encarregado são de
          divulgação **pública**. Escondê-lo atrás do login deixaria de fora
          justamente quem ainda não é cliente e quer saber o que a barbearia faz
          com o telefone que ele está prestes a digitar.

          Só aparece quando existe: um bloco com "não informado" seria pior que
          a ausência — anuncia o descumprimento em vez de resolvê-lo, e a tela
          de configurações já cobra o cadastro de quem administra.
        */}
        {/*
          O canal de recados (bloco 40).

          Fica na página pública e não só em "Meus agendamentos" porque a
          reclamação mais valiosa é a de quem **não** virou cliente: esperou,
          desistiu e foi embora. Essa pessoa não tem conta, e não vai criar uma
          para reclamar.
        */}
        <section className="secao secao--miudo">
          <div>
            <h2 className="rotulo">Fale com a gente</h2>
            <p className="politica">
              Sugestão, reclamação ou elogio — chega direto para a equipe, e não aparece em
              lugar nenhum público.{' '}
              <a href={`/${slug}/falar`}>Escrever para a barbearia</a>.
            </p>
          </div>
        </section>

        {profile.encarregado ? (
          <section className="secao secao--miudo">
            <div>
              <h2 className="rotulo">Seus dados</h2>
              <p className="politica">
                Para pedir, corrigir ou apagar os seus dados, fale com{' '}
                {profile.encarregado.nome}
                {profile.encarregado.email ? (
                  <>
                    {' '}
                    pelo{' '}
                    <a href={`mailto:${profile.encarregado.email}`}>
                      {profile.encarregado.email}
                    </a>
                  </>
                ) : null}
                .
              </p>
            </div>
          </section>
        ) : null}
        </aside>
        </div>
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


/**
 * A página inteira revalida a cada minuto, não a cada cinco.
 *
 * O herói é a disponibilidade ao vivo; cache longo contradiz a tese da página —
 * o visitante veria horários já ocupados. Um minuto é o limite aceitável: se um
 * horário for tomado nesse intervalo, o fluxo de agendamento recusa com
 * "Este horário já não está mais disponível", que é caminho já tratado.
 */
export const revalidate = 60;
