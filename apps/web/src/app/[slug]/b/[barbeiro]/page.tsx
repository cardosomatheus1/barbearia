import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  frasedasEspecialidades,
  imagemPublica,
  ROTULO_DA_ESPECIALIDADE,
  type Especialidade,
} from '@barbearia/core';
import { getProfile, perfilDoBarbeiro } from '@/lib/api';

/**
 * A página pública do barbeiro (bloco 73, SPEC §5.2).
 *
 * > ```
 * > João Silva                    ⭐ 4,92 · 1.842 atendimentos
 * > Especialidades: fade · degradê · barba · corte social
 * > [ portfólio ]  [ horários ]  [ Agendar com João ]
 * > ```
 *
 * ## Ela existe porque a escolha é por pessoa
 *
 * Numa barbearia o cliente não escolhe "a casa", escolhe **quem corta o cabelo
 * dele**. Até aqui o produto sabia disso na agenda e não na vitrine: a seção de
 * equipe da página pública mostrava rosto e nome e levava a `/{slug}/p/{id}`,
 * um endereço que nunca existiu — caminho de ida sem chegada, na tela em que a
 * decisão acontece.
 *
 * ## O que ainda não está aqui aparece **marcado**
 *
 * `[ portfólio ]` é o bloco 74 e depende do consentimento de uso público da
 * foto (SPEC §1.8): publicar trabalho feito no cabelo de alguém sem essa
 * decisão registrada é o oposto do que este produto faz com dado de pessoa.
 * Esconder o botão faria a SPEC parecer entregue.
 */

interface Props {
  readonly params: Promise<{ slug: string; barbeiro: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, barbeiro } = await params;
  const perfil = await perfilDoBarbeiro(slug, barbeiro);
  if (!perfil) return { title: 'Barbeiro não encontrado' };

  return {
    title: `${perfil.nome} — agende um horário`,
    /**
     * A descrição sai das especialidades, não de um texto genérico.
     *
     * É o que a pessoa procurando "fade em Salvador" precisa ler no resultado
     * do Google, e é conteúdo que a barbearia cadastrou — não uma frase que o
     * produto inventou sobre alguém.
     */
    description:
      perfil.especialidades.length > 0
        ? `${perfil.nome}: ${frasedasEspecialidades(perfil.especialidades as Especialidade[])}.`
        : `Agende um horário com ${perfil.nome}.`,
  };
}

/**
 * Uma casa decimal, como em toda parte do produto.
 *
 * O mock da SPEC escreve "4,92", mas a nota deste produto arredonda para uma
 * casa desde o bloco 43 — e a página da barbearia mostra assim. Duas telas que
 * exibem a nota da mesma pessoa com precisões diferentes é a §6, pergunta 6.
 */
const nota = (bps: number): string =>
  (bps / 100).toLocaleString('pt-BR', { minimumFractionDigits: 1 });

export default async function BarbeiroPage({ params }: Props) {
  const { slug, barbeiro } = await params;
  const [perfil, casa] = await Promise.all([
    perfilDoBarbeiro(slug, barbeiro),
    getProfile(slug),
  ]);

  // Perfil desligado responde 404, como a API: "existe mas está escondido"
  // confirma para quem adivinhou o endereço que aquela pessoa trabalha ali.
  if (!perfil || !casa) notFound();

  const rosto = imagemPublica(perfil.fotoUrl);
  const especialidades = perfil.especialidades as Especialidade[];

  return (
    <main className="ui-container barbeiro">
      {/* Toda tela tem volta (§6, pergunta 1): daqui se sobe para a casa. */}
      <a className="barbeiro__voltar" href={`/${slug}`}>
        ← {casa.name}
      </a>

      <header className="barbeiro__topo">
        {rosto ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img alt="" className="barbeiro__foto" height={240} src={rosto} width={240} />
        ) : (
          <span aria-hidden="true" className="barbeiro__foto barbeiro__foto--vazia">
            {perfil.nome.trim().charAt(0)}
          </span>
        )}

        <div className="barbeiro__identidade">
          <h1 className="barbeiro__nome">{perfil.nome}</h1>
          <p className="barbeiro__numeros tabular">
            {perfil.notaBps !== null ? (
              <>
                <span className="barbeiro__nota">★ {nota(perfil.notaBps)}</span>
                <span className="barbeiro__sep"> · </span>
                <span>
                  {perfil.avaliacoes === 1 ? '1 avaliação' : `${perfil.avaliacoes} avaliações`}
                </span>
                <span className="barbeiro__sep"> · </span>
              </>
            ) : null}
            {/* Sem nota, a contagem de atendimentos é o que sustenta a confiança
                — e é o número que a SPEC põe ao lado da nota. */}
            <span>
              {perfil.atendimentos === 1
                ? '1 atendimento'
                : `${perfil.atendimentos.toLocaleString('pt-BR')} atendimentos`}
            </span>
          </p>
        </div>
      </header>

      {especialidades.length > 0 ? (
        <section className="barbeiro__bloco">
          <h2 className="barbeiro__secao">Especialidades</h2>
          <ul className="barbeiro__especialidades">
            {especialidades.map((e) => (
              <li className="barbeiro__especialidade" key={e}>
                {ROTULO_DA_ESPECIALIDADE[e]}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {perfil.bio ? (
        <section className="barbeiro__bloco">
          <h2 className="barbeiro__secao">Sobre</h2>
          <p className="barbeiro__bio">{perfil.bio}</p>
        </section>
      ) : null}

      <div className="barbeiro__acoes">
        {/* Uma ação primária por tela (§5). O resto é secundário, e o que não
            existe ainda aparece marcado em vez de escondido. */}
        <a
          className="ui-button ui-button--primary barbeiro__agendar"
          href={`/${slug}/agendar?p=${perfil.professionalId}`}
        >
          Agendar com {perfil.nome.split(' ')[0]}
        </a>
        <a className="ui-button ui-button--secondary barbeiro__acao" href={`/${slug}`}>
          Ver a barbearia
        </a>
      </div>

      {/**
        * O portfólio (bloco 74, SPEC §4.2 e §5.2).
        *
        * Só aparece foto de cliente que autorizou o **uso público** — o aceite
        * de guardar na ficha não publica nada, e são duas decisões separadas
        * desde o bloco 5. Sem nome de quem está na foto: a pessoa autorizou a
        * imagem, não a publicação de quem ela é.
        *
        * Sem portfólio a seção não existe. Um bloco vazio dizendo "sem fotos"
        * numa página de venda é pior que a ausência dele — a página continua
        * inteira com nota, atendimentos e especialidades.
        */}
      {perfil.portfolio.length > 0 ? (
        <section className="barbeiro__bloco">
          <h2 className="barbeiro__secao">Trabalhos</h2>
          <ul className="portfolio">
            {perfil.portfolio.map((foto) => {
              const imagem = imagemPublica(foto.url);
              if (!imagem) return null;
              return (
                <li className="portfolio__item" key={foto.id}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    alt={foto.legenda ?? ''}
                    className="portfolio__foto"
                    height={400}
                    loading="lazy"
                    src={imagem}
                    width={400}
                  />
                  {foto.legenda ? (
                    <span className="portfolio__legenda">{foto.legenda}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
