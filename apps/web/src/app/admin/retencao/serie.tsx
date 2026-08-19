import type { PontoDaSerieNaTela } from '@/lib/admin-api';
import { reais } from '@/lib/dinheiro';

/**
 * A linha de faturamento por dia, em SVG servido pelo servidor (bloco 62).
 *
 * ## Por que SVG escrito à mão
 *
 * Não há componente de cliente neste produto, e uma biblioteca de gráfico é
 * JavaScript no navegador por definição. O que a tela precisa é de uma linha com
 * eixo e um rótulo — isso é `path` e `text`, e cabe em cem linhas sem nenhuma
 * dependência nova.
 *
 * ## Uma série, nenhuma legenda
 *
 * O título já diz o que a linha é. Uma caixa de legenda para uma série só é
 * decoração que ocupa a altura que o gráfico não tem no celular.
 *
 * ## O que substitui o `tooltip`
 *
 * Sem JavaScript não há crosshair. O `<title>` dentro de cada ponto é o
 * equivalente nativo — o navegador mostra o valor ao parar o cursor, e o leitor
 * de tela o anuncia. E a tabela abaixo do gráfico é o caminho de quem não usa
 * nenhum dos dois: ela é a fonte, o desenho é o resumo.
 */

interface Props {
  readonly pontos: readonly PontoDaSerieNaTela[];
  readonly maximoCents: number;
  readonly mediaCents: number | null;
}

/** A caixa do desenho. O SVG escala; estes números são só a proporção interna. */
const LARGURA = 720;
const ALTURA = 200;
const MARGEM_BAIXO = 22;
const MARGEM_TOPO = 12;


const diaCurto = (dia: string): string => {
  const partes = dia.split('-');
  return `${partes[2]}/${partes[1]}`;
};

export function SerieDeFaturamento({ pontos, maximoCents, mediaCents }: Props) {
  if (pontos.length === 0) {
    return (
      <p className="cartao-balcao__texto">
        Ainda não há venda nesta janela. A linha aparece assim que a primeira comanda for paga.
      </p>
    );
  }

  /**
   * O topo da escala nunca é zero.
   *
   * Uma janela inteira sem venda daria divisão por zero e uma linha colada no
   * eixo — que é honesto — mas o `maximo` também é o divisor de todo `y`. Um
   * piso de um centavo mantém a aritmética viva e o desenho no chão.
   */
  const maximo = Math.max(1, maximoCents);
  const passo = pontos.length > 1 ? (LARGURA - 8) / (pontos.length - 1) : 0;
  const alturaUtil = ALTURA - MARGEM_BAIXO - MARGEM_TOPO;

  const x = (i: number) => 4 + i * passo;
  const y = (cents: number) => MARGEM_TOPO + alturaUtil - (cents / maximo) * alturaUtil;

  const linha = pontos.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.valorCents)}`).join(' ');
  const area = `${linha} L ${x(pontos.length - 1)} ${ALTURA - MARGEM_BAIXO} L ${x(0)} ${
    ALTURA - MARGEM_BAIXO
  } Z`;

  const ultimo = pontos[pontos.length - 1];
  const maiorPonto = pontos.reduce((a, b) => (b.valorCents > a.valorCents ? b : a), pontos[0]!);
  const indiceDoMaior = pontos.indexOf(maiorPonto);

  return (
    <figure className="serie">
      {/* `preserveAspectRatio="none"` não: ele esticaria a espessura do traço em
          telas largas. O `viewBox` com largura fluida mantém o traço de 2px. */}
      <svg
        aria-label={`Faturamento por dia, de ${diaCurto(pontos[0]!.dia)} a ${diaCurto(ultimo!.dia)}`}
        className="serie__desenho"
        role="img"
        viewBox={`0 0 ${LARGURA} ${ALTURA}`}
      >
        {mediaCents !== null && mediaCents > 0 ? (
          <>
            <line
              className="serie__media"
              x1={0}
              x2={LARGURA}
              y1={y(mediaCents)}
              y2={y(mediaCents)}
            />
            <text className="serie__media-rotulo" x={4} y={y(mediaCents) - 5}>
              média {reais(mediaCents)}
            </text>
          </>
        ) : null}

        <path className="serie__area" d={area} />
        <path className="serie__linha" d={linha} />

        {/* O eixo do chão. Sem grade: ela competiria com a linha, que é o dado. */}
        <line
          className="serie__eixo"
          x1={0}
          x2={LARGURA}
          y1={ALTURA - MARGEM_BAIXO}
          y2={ALTURA - MARGEM_BAIXO}
        />

        {pontos.map((p, i) => (
          <circle
            className={`serie__ponto${i === indiceDoMaior ? ' serie__ponto--maior' : ''}`}
            cx={x(i)}
            cy={y(p.valorCents)}
            key={p.dia}
            r={i === indiceDoMaior ? 5 : 3}
          >
            <title>{`${diaCurto(p.dia)}: ${reais(p.valorCents)}`}</title>
          </circle>
        ))}

        {/* Rótulo direto só no maior dia: um número em cada ponto vira ruído, e
            é o pico que a pessoa procura quando abre esta tela. */}
        {maiorPonto.valorCents > 0 ? (
          <text
            className="serie__pico"
            textAnchor={indiceDoMaior > pontos.length / 2 ? 'end' : 'start'}
            x={x(indiceDoMaior) + (indiceDoMaior > pontos.length / 2 ? -8 : 8)}
            y={y(maiorPonto.valorCents) - 8}
          >
            {reais(maiorPonto.valorCents)}
          </text>
        ) : null}

        <text className="serie__data" x={4} y={ALTURA - 6}>
          {diaCurto(pontos[0]!.dia)}
        </text>
        <text className="serie__data" textAnchor="end" x={LARGURA - 4} y={ALTURA - 6}>
          {diaCurto(ultimo!.dia)}
        </text>
      </svg>
    </figure>
  );
}
