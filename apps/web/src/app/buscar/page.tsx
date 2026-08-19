import type { Metadata } from 'next';
import {
  COMODIDADES,
  DISPONIBILIDADES,
  ehComodidade,
  imagemPublica,
  ORDENS_DA_BUSCA,
  raioDaBusca,
  RAIO_PADRAO_KM,
  RAIOS_DA_BUSCA,
  ROTULO_DA_COMODIDADE,
  ROTULO_DA_DISPONIBILIDADE,
  ROTULO_DA_ORDEM,
  type Disponibilidade,
  type OrdemDaBusca,
} from '@barbearia/core';
import { buscarBarbearias, cidadesDaVitrine, type CasaNaBusca } from '@/lib/api';
import { reais } from '@/lib/dinheiro';

/**
 * A busca do marketplace (bloco 70, SPEC §5.2).
 *
 * ## Esta página não é de uma barbearia
 *
 * `/{slug}` é a página de uma casa; esta é a da **plataforma**, e quem chega
 * nela ainda não escolheu ninguém. É a segunda porta de entrada do produto: até
 * aqui, o cliente só chegava se soubesse o endereço da barbearia.
 *
 * ## O card é o produto
 *
 * *"Próximo horário como elemento principal do card é o que diferencia de
 * diretório."* Um diretório lista endereços; o que faz a pessoa agendar é ver
 * que dá para cortar hoje — e desde o bloco 71 o card diz isso, com o motor de
 * disponibilidade rodado em lote sobre a lista.
 *
 * ## O botão passa por uma porta, e ela existe por dinheiro
 *
 * "Agendar horário" leva a `/ir/{slug}`, que carimba a passagem pelo
 * marketplace num cookie e só então manda para a página da barbearia (bloco
 * 72). Sem esse carimbo, a comissão sobre cliente novo seria uma tabela que
 * ninguém preenche — e ela é a promessa comercial do produto inteiro.
 *
 * ## Zero JavaScript de cliente, como o resto do produto
 *
 * O formulário é `GET`: cada filtro é um campo, e a busca é a própria URL — o
 * que a torna compartilhável e indexável de graça. "Perto de mim" precisaria ler
 * a coordenada do aparelho, que exige o primeiro componente de cliente deste
 * produto; enquanto ele não existe, a pessoa escolhe a cidade, e o centro dela
 * sai das próprias barbearias listadas.
 */

export const metadata: Metadata = {
  title: 'Encontre uma barbearia na sua cidade',
  description:
    'Busque barbearias por cidade, veja nota, preço a partir de e agende online.',
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const primeiro = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;


/**
 * Uma casa decimal, e o **máximo** também é uma.
 *
 * A nota deste produto tem uma casa desde o bloco 43, e quem escreve a vitrine
 * já arredonda assim — `atualizarVitrine` usa a mesma `resumoPublico` da página
 * da barbearia. Sem o teto, este card ficava dependendo daquele invariante:
 * qualquer `rating_bps` que não fosse múltiplo de dez sairia como "4,69" ao
 * lado de uma página dizendo "4,7", sobre a mesma casa (§6, pergunta 6).
 */
const nota = (bps: number): string =>
  (bps / 100).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/**
 * Os degraus de nota e de preço que o formulário oferece.
 *
 * Nota em centésimos de estrela, que é como a borda a recebe (`400` é 4,0); o
 * teto de preço em centavos, como todo dinheiro deste código. Poucos degraus de
 * propósito: uma lista longa num `<select>` de celular responde pior que quatro
 * opções que cobrem a decisão.
 */
const NOTAS_MINIMAS = [400, 450] as const;
const TETOS_DE_PRECO = [3000, 5000, 8000] as const;

const distancia = (km: number): string =>
  km < 1 ? `${Math.round(km * 1000)} m` : `${km.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} km`;

export default async function BuscarPage({ searchParams }: Props) {
  const busca = await searchParams;
  const cidades = await cidadesDaVitrine();

  const pedida = primeiro(busca['cidade']);
  const escolhida = cidades.find((c) => `${c.cidade}/${c.estado}` === pedida) ?? cidades[0];
  const ordem = (ORDENS_DA_BUSCA as readonly string[]).includes(primeiro(busca['ordem']) ?? '')
    ? (primeiro(busca['ordem']) as OrdemDaBusca)
    : 'distancia';
  const raio = raioDaBusca(Number(primeiro(busca['raioKm']) ?? RAIO_PADRAO_KM));
  const clube = primeiro(busca['clube']) === 'true';

  /**
   * Nota e preço: os dois primeiros filtros de quem escolhe barbearia.
   *
   * A API os aceita desde o bloco 70 e o domínio os implementa com a assimetria
   * documentada lá — sem nota **não passa** no filtro de nota, sem preço
   * **passa** no de preço. O que faltava era por onde pedi-los: o `ROADMAP` os
   * dava por entregues e nenhum campo da tela os mandava. É o defeito de
   * `blocks` na direção inversa, com a lacuna registrada como fechada.
   *
   * Os degraus são da tela, não do domínio: nota e preço são contínuos, e o que
   * a pessoa escolhe no celular com uma mão é uma faixa. Ficam aqui de
   * propósito, ao contrário de `COMODIDADES`, que é conjunto fechado gravado no
   * banco e por isso mora em `core`.
   */
  const notaMinimaBps = NOTAS_MINIMAS.find(
    (n) => String(n) === primeiro(busca['notaMinimaBps']),
  );
  const precoMaximoCents = TETOS_DE_PRECO.find(
    (p) => String(p) === primeiro(busca['precoMaximoCents']),
  );
  const comodidades = (Array.isArray(busca['comodidades'])
    ? busca['comodidades']
    : busca['comodidades'] === undefined
      ? []
      : [busca['comodidades']]
  ).filter(ehComodidade);
  const disponivel = (DISPONIBILIDADES as readonly string[]).includes(
    primeiro(busca['disponivel']) ?? '',
  )
    ? (primeiro(busca['disponivel']) as Disponibilidade)
    : 'qualquer';

  const encontrado = escolhida
    ? await buscarBarbearias({
        lat: String(escolhida.latitude),
        lon: String(escolhida.longitude),
        raioKm: String(raio),
        ordem,
        disponivel,
        ...(clube ? { clube: 'true' } : {}),
        ...(notaMinimaBps !== undefined ? { notaMinimaBps: String(notaMinimaBps) } : {}),
        ...(precoMaximoCents !== undefined ? { precoMaximoCents: String(precoMaximoCents) } : {}),
        ...(comodidades.length > 0 ? { comodidades: [...comodidades] } : {}),
      })
    : { resultados: [], analisadas: 0, truncada: false };
  const resultados = encontrado.resultados;

  return (
    <main className="ui-container buscar">
      <header className="buscar__topo">
        <h1 className="buscar__titulo">Encontre uma barbearia</h1>
        <p className="buscar__sub">
          Escolha a cidade e veja quem atende ali, com nota, preço de entrada e agendamento
          online.
        </p>
      </header>

      {cidades.length === 0 ? (
        /* Estado vazio desenhado: sem barbearia publicada, a busca não tem o que
           mostrar — e a página diz isso em vez de exibir um formulário inerte. */
        <div className="vazio">
          <p className="vazio__titulo">Nenhuma barbearia publicada ainda</p>
          <p className="vazio__saida">
            Assim que a primeira publicar a página dela, ela aparece aqui.{' '}
            <a href="/">Conheça o Barber Dock</a>.
          </p>
        </div>
      ) : (
        <>
          <form action="/buscar" className="buscar__form" method="get">
            <div className="ui-field buscar__campo">
              <label className="ui-field__label" htmlFor="busca-cidade">
                Cidade
              </label>
              <select
                className="ui-field__input"
                defaultValue={escolhida ? `${escolhida.cidade}/${escolhida.estado}` : ''}
                id="busca-cidade"
                name="cidade"
              >
                {cidades.map((c) => (
                  <option key={`${c.cidade}/${c.estado}`} value={`${c.cidade}/${c.estado}`}>
                    {c.cidade} — {c.estado} ({c.casas})
                  </option>
                ))}
              </select>
            </div>

            <div className="ui-field buscar__campo">
              <label className="ui-field__label" htmlFor="busca-ordem">
                Ordenar por
              </label>
              <select className="ui-field__input" defaultValue={ordem} id="busca-ordem" name="ordem">
                {ORDENS_DA_BUSCA.map((o) => (
                  <option key={o} value={o}>
                    {ROTULO_DA_ORDEM[o]}
                  </option>
                ))}
              </select>
            </div>

            <div className="ui-field buscar__campo">
              <label className="ui-field__label" htmlFor="busca-quando">
                Disponibilidade
              </label>
              <select
                className="ui-field__input"
                defaultValue={disponivel}
                id="busca-quando"
                name="disponivel"
              >
                {DISPONIBILIDADES.map((d) => (
                  <option key={d} value={d}>
                    {ROTULO_DA_DISPONIBILIDADE[d]}
                  </option>
                ))}
              </select>
            </div>

            <div className="ui-field buscar__campo">
              <label className="ui-field__label" htmlFor="busca-raio">
                Distância
              </label>
              <select className="ui-field__input" defaultValue={String(raio)} id="busca-raio" name="raioKm">
                {RAIOS_DA_BUSCA.map((km) => (
                  <option key={km} value={km}>
                    até {km} km
                  </option>
                ))}
              </select>
            </div>

            <div className="ui-field buscar__campo">
              <label className="ui-field__label" htmlFor="busca-nota">
                Nota
              </label>
              <select
                className="ui-field__input"
                defaultValue={notaMinimaBps === undefined ? '' : String(notaMinimaBps)}
                id="busca-nota"
                name="notaMinimaBps"
              >
                <option value="">Qualquer nota</option>
                {NOTAS_MINIMAS.map((bps) => (
                  <option key={bps} value={bps}>
                    {nota(bps)} ou mais
                  </option>
                ))}
              </select>
            </div>

            <div className="ui-field buscar__campo">
              <label className="ui-field__label" htmlFor="busca-preco">
                Preço de entrada
              </label>
              <select
                className="ui-field__input"
                defaultValue={precoMaximoCents === undefined ? '' : String(precoMaximoCents)}
                id="busca-preco"
                name="precoMaximoCents"
              >
                <option value="">Qualquer preço</option>
                {TETOS_DE_PRECO.map((cents) => (
                  <option key={cents} value={cents}>
                    Até R$ {reais(cents)}
                  </option>
                ))}
              </select>
            </div>

            {/* Caixas e não `<select>` múltiplo: são três, e as três cabem na
                tela. "Todas as pedidas, não qualquer uma" é a regra do domínio —
                quem marcou estacionamento **e** acessibilidade precisa das duas. */}
            <fieldset className="ui-field buscar__campo buscar__comodidades">
              <legend className="ui-field__label">A barbearia tem</legend>
              {COMODIDADES.map((valor) => (
                <label className="ui-field__label buscar__marca" key={valor}>
                  <input
                    defaultChecked={comodidades.includes(valor)}
                    name="comodidades"
                    type="checkbox"
                    value={valor}
                  />
                  {ROTULO_DA_COMODIDADE[valor]}
                </label>
              ))}
            </fieldset>

            <label className="ui-field__label buscar__marca buscar__clube">
              <input defaultChecked={clube} name="clube" type="checkbox" value="true" />
              Só com plano de assinatura
            </label>

            <button className="ui-button ui-button--primary buscar__acao" type="submit">
              Buscar
            </button>
          </form>

          {/* O que ainda não funciona aparece marcado, nunca escondido: esconder
              faria a SPEC parecer entregue.

              Esta frase nasceu de um print: com uma barbearia na cidade, o card
              dizia "0 m". O número está certo — a origem é o centro da cidade,
              que com uma casa só é ela mesma —, e é justamente por isso que ele
              mente: quem lê "0 m" entende "é aqui do lado", e a página havia
              prometido "perto de você" sem nunca ter perguntado onde a pessoa
              está. */}
          <p className="buscar__pendente">
            As distâncias saem do centro de {escolhida?.cidade}, não de onde você está — a busca
            pela localização do aparelho ainda não está pronta.{' '}
            {/* O horário do card é o do serviço de entrada, o mesmo do "a partir
                de": é o pareamento que faz preço e horário falarem da mesma
                coisa, e ele tem um efeito que a tela precisa admitir — uma casa
                cujo serviço mais barato está lotado some do filtro mesmo com a
                tarde livre para o resto do cardápio. O filtro por serviço é
                lacuna declarada. */}
            Os horários são os do serviço de entrada de cada casa, o mesmo do &ldquo;a partir
            de&rdquo;.
            {encontrado.truncada ? (
              <>
                {' '}
                Com filtro de disponibilidade, a agenda foi consultada nas{' '}
                {encontrado.analisadas} primeiras por{' '}
                {ROTULO_DA_ORDEM[ordem].toLocaleLowerCase('pt-BR')} — pode haver outras fora dessa
                faixa.
              </>
            ) : null}
          </p>

          {resultados.length === 0 ? (
            <div className="vazio">
              <p className="vazio__titulo">Nenhuma barbearia nesse raio</p>
              <p className="vazio__saida">
                Aumente a distância ou tire os filtros. {escolhida?.cidade} tem{' '}
                {escolhida?.casas === 1 ? '1 barbearia' : `${escolhida?.casas} barbearias`} no total.
              </p>
            </div>
          ) : (
            <ul className="buscar__lista">
              {resultados.map((casa) => (
                <li key={casa.slug}>
                  <Card casa={casa} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
}

function Card({ casa }: { readonly casa: CasaNaBusca }) {
  /**
   * A foto passa por `imagemPublica`, como em toda tela deste produto.
   *
   * A URL é cadastrada pela barbearia, e o resto do produto não a trata como
   * confiável: só `https`, sem caractere de controle e com teto de tamanho. Um
   * `src` cru aqui seria a única porta do produto que aceita o que a outra
   * recusa — e esta é justamente a página que lista barbearias que o leitor não
   * conhece.
   */
  const foto = imagemPublica(casa.fotoUrl);

  return (
    <article className={`casa${casa.patrocinado ? ' casa--patrocinada' : ''}`}>
      {foto ? (
        /* `width` e `height` no `img` mais `aspect-ratio` no CSS: sem os dois o
           navegador não reserva o espaço e a foto empurra o conteúdo ao carregar. */
        <img alt="" className="casa__foto" height={200} loading="lazy" src={foto} width={320} />
      ) : (
        /* Sem foto, a inicial — e não um retângulo vazio.
           Um bloco cinza de 150px lê como imagem quebrada, e a primeira coisa
           que a pessoa vê de uma barbearia que ela não conhece não pode parecer
           defeito. A inicial é curta, cabe em qualquer largura e é o que uma
           vitrine de verdade faria. */
        <div aria-hidden="true" className="casa__foto casa__foto--vazia">
          <span className="casa__inicial">{casa.nome.trim().charAt(0).toUpperCase()}</span>
        </div>
      )}

      <div className="casa__corpo">
        {/**
          * O rótulo do card pago (bloco 75).
          *
          * Em letras, acima do nome, e não um selo discreto no canto: um
          * resultado pago sem rótulo é publicidade disfarçada de recomendação, e
          * é a única coisa que faria esta busca valer menos que um diretório.
          * O destaque compra **posição**, nunca a aparência de escolha do
          * produto.
          */}
        {casa.patrocinado ? <p className="casa__patrocinio">Patrocinado</p> : null}
        <div className="casa__topo">
          <h2 className="casa__nome">{casa.nome}</h2>
          {casa.notaBps !== null ? (
            <p className="casa__nota tabular">
              ★ {nota(casa.notaBps)}
              <span className="casa__avaliacoes">
                {casa.avaliacoes === 1 ? '1 avaliação' : `${casa.avaliacoes} avaliações`}
              </span>
            </p>
          ) : (
            /* Sem nota **não** é nota baixa: quem ainda não tem avaliação
               suficiente é desconhecido, e a tela diz isso. */
            <p className="casa__nota casa__nota--sem">ainda sem avaliações</p>
          )}
        </div>

        <p className="casa__linha tabular">
          {distancia(casa.distanciaKm)}
          {casa.precoDeCents !== null ? ` · a partir de ${reais(casa.precoDeCents)}` : ''}
          {casa.temClube ? ' · tem plano' : ''}
        </p>

        {/**
         * O próximo horário é o **elemento principal** do card (SPEC §5.2), e é
         * por isso que ele tem peso próprio em vez de virar mais um item da
         * linha acima: é ele que responde "dá para ir hoje?", que é a pergunta
         * que separa um marketplace de um diretório.
         *
         * Sem vaga, a frase é a ausência — nunca um espaço em branco. Card mudo
         * lê como defeito de carregamento, e a barbearia lotada continua sendo
         * um resultado legítimo.
         */}
        {casa.proximoHorario ? (
          <p className="casa__horario">
            <span className="casa__horario-rotulo">Próximo horário</span>
            <strong className="casa__horario-valor tabular">{casa.proximoHorario.rotulo}</strong>
          </p>
        ) : (
          <p className="casa__horario casa__horario--sem">Sem horário hoje nem amanhã</p>
        )}

        {/* "Agendar horário" é o que o botão da página da barbearia diz, e o
            card leva exatamente para lá. Dizia "Ver horários" — dois nomes para
            a mesma ação em duas telas seguidas do mesmo fluxo (§6, pergunta 2),
            e o mais fraco dos dois: agora que o card já mostra o horário, "ver"
            promete o que a pessoa acabou de ler. */}
        <a
          className="ui-button ui-button--secondary casa__acao"
          href={`/ir/${casa.slug}?c=${encodeURIComponent(casa.carimbo)}`}
        >
          Agendar horário
        </a>
      </div>
    </article>
  );
}
