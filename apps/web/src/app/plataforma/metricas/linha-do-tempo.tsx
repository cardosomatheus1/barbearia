import type { MesDoMrrNaTela, SafraNaTela } from '@/lib/plataforma-api';

/**
 * A linha do tempo da plataforma: MRR mês a mês e a curva de retenção por safra.
 *
 * ## Duas formas diferentes, e é de propósito
 *
 * O MRR é **barra**: doze meses são doze categorias discretas, e a pergunta é
 * comparar a altura de uma com a da outra. A retenção é **tabela pintada** — o
 * triângulo de safra é a forma que existe há décadas para esta leitura, e
 * transformá-la em linhas sobrepostas exigiria uma cor por safra, doze cores que
 * ninguém distingue e uma legenda maior que o gráfico.
 *
 * A pintura é uma **rampa de um tom só**, do fraco ao forte — a mesma do heatmap
 * de ocupação do bloco 57. Rampa sequencial é uma cor com intensidade variável,
 * nunca um arco-íris: o arco-íris obriga a consultar a legenda para saber se
 * verde é mais que laranja.
 *
 * ## A cor não carrega sozinha nenhuma informação
 *
 * Cada célula mostra o número. É o que a torna legível para quem não distingue
 * as intensidades, no papel impresso e no modo de alto contraste — e é a
 * exigência que uma rampa de baixo contraste traz junto.
 */

const reais = (centavos: number): string =>
  (centavos / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 0,
  });

const mesCurto = (mes: string): string => {
  const partes = mes.split('-');
  return `${partes[1]}/${partes[0]?.slice(2)}`;
};

/** Em quantas faixas a rampa é cortada. Três, como o heatmap de ocupação. */
function faixaDaRetencao(retidas: number, entraram: number): 'baixa' | 'media' | 'alta' {
  if (entraram <= 0) return 'baixa';
  const fracao = retidas / entraram;
  if (fracao >= 0.7) return 'alta';
  if (fracao >= 0.35) return 'media';
  return 'baixa';
}

export function MrrMesAMes({
  meses,
  maiorMrrCents,
}: {
  readonly meses: readonly MesDoMrrNaTela[];
  readonly maiorMrrCents: number;
}) {
  if (meses.length === 0) {
    return (
      <p className="cartao-balcao__texto">
        Nenhuma fatura paga ainda. A linha do tempo começa no primeiro mês cobrado.
      </p>
    );
  }

  // Piso de um centavo no divisor: um mês inteiro sem receita zeraria a escala e
  // levaria a divisão junto.
  const maior = Math.max(1, maiorMrrCents);

  return (
    <div className="ui-scroll-x">
      <ol className="mrr">
        {meses.map((m) => (
          <li className="mrr__mes" key={m.mes}>
            <span className="mrr__valor">{reais(m.mrrCents)}</span>
            {/* A barra é um `div` com altura em porcentagem, e não um SVG: uma
                barra é um retângulo, e um retângulo é CSS. */}
            <span
              className="mrr__barra"
              style={{ blockSize: `${Math.max(2, (m.mrrCents / maior) * 100)}%` }}
              title={`${mesCurto(m.mes)}: ${reais(m.mrrCents)} de ${m.barbeariasPagantes} barbearias`}
            />
            <span className="mrr__rotulo">{mesCurto(m.mes)}</span>
            <span className="mrr__quantas">{m.barbeariasPagantes}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function CurvaDeRetencao({ safras }: { readonly safras: readonly SafraNaTela[] }) {
  if (safras.length === 0) {
    return (
      <p className="cartao-balcao__texto">
        Nenhuma safra ainda. Ela aparece assim que a primeira barbearia pagar o segundo mês.
      </p>
    );
  }

  const maiorCurva = safras.reduce((m, s) => Math.max(m, s.retidas.length), 0);

  return (
    <div className="ui-scroll-x">
      <table className="safras">
        <caption className="safras__legenda">
          Cada linha é quem entrou naquele mês. Cada coluna é quantos meses depois — o mês 0 é a
          própria entrada, e ele fica na tabela de propósito: uma curva que começa no mês 1 esconde
          a base de comparação.
        </caption>
        <thead>
          <tr>
            <th scope="col">Entraram em</th>
            {Array.from({ length: maiorCurva }, (_, i) => (
              <th key={i} scope="col">
                {i === 0 ? 'entrada' : `+${i}`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {safras.map((s) => (
            <tr key={s.safra}>
              <th scope="row">{mesCurto(s.safra)}</th>
              {Array.from({ length: maiorCurva }, (_, i) => {
                const valor = s.retidas[i];
                /**
                 * Célula fora da curva é vazia, e é diferente de zero.
                 *
                 * Uma safra de dois meses atrás não tem mês +5 ainda: aquela
                 * célula não é "todas saíram", é "ainda não aconteceu". Pintá-la
                 * de vermelho seria o triângulo mentindo sobre o futuro.
                 */
                if (valor === undefined) {
                  return <td className="safras__fora" key={i} />;
                }
                return (
                  <td className={`safras__celula safras__celula--${faixaDaRetencao(valor, s.entraram)}`} key={i}>
                    {valor}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
