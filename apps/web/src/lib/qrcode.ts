import qrcode from 'qrcode-generator';

/**
 * O QR Code do Pix, desenhado no servidor (bloco 35).
 *
 * ## Por que uma dependência
 *
 * O `CLAUDE.md` §2 cobra motivo declarado, e aqui ele é específico: QR Code é
 * um padrão com correção de erro Reed-Solomon, máscara escolhida por
 * penalidade e tabelas de versão. Escrever isso à mão custaria o bloco inteiro,
 * e o modo de falhar é **silencioso** — um código malformado tem cara de código
 * e simplesmente não lê no banco do cliente, com ele parado na frente do
 * balcão. Não é o tipo de coisa que se descobre em revisão.
 *
 * `qrcode-generator` foi escolhido entre as opções por não ter dependência
 * nenhuma. A alternativa popular (`qrcode`) traz cinco, incluindo um analisador
 * de argumentos de linha de comando que este produto não usa.
 *
 * ## Por que SVG e por que no servidor
 *
 * O QR é gerado no servidor para não adicionar JavaScript a toda tela que o usa.
 * O R5 abriu ilhas locais no admin, mas isso não muda a decisão daqui. SVG também
 * é o formato certo: ele escala sem borrar, e um QR
 * Code borrado é um QR Code que não lê.
 */

/**
 * A margem obrigatória, em módulos.
 *
 * O padrão exige quatro módulos de área tranquila em volta. Sem ela o leitor
 * não encontra os padrões de posição quando o código está sobre um fundo
 * colorido — que é exatamente o caso desta tela.
 */
const MARGEM = 4;

/**
 * Correção de erro `M` (~15%).
 *
 * `L` seria menor e o texto do Pix é longo, mas o código vai ser lido de uma
 * tela com brilho e reflexo, muitas vezes por um celular antigo. `H` engordaria
 * a matriz sem ganho proporcional.
 */
const CORRECAO = 'M' as const;

export interface QrCodeSvg {
  readonly svg: string;
  /** Quantos módulos de lado, contando a margem. É o `viewBox` do SVG. */
  readonly lado: number;
}

/**
 * Devolve o SVG do texto, sem largura fixa.
 *
 * Sem `width`/`height` no elemento: quem decide o tamanho é o CSS, e um SVG com
 * medida em pixel embutida não caberia numa tela de 360px sem estourar.
 */
export function qrCodeSvg(texto: string): QrCodeSvg {
  // Versão 0 é "escolha a menor que couber". Fixar uma versão faria o
  // copia-e-cola de uma barbearia com nome longo simplesmente não caber.
  const codigo = qrcode(0, CORRECAO);
  codigo.addData(texto);
  codigo.make();

  const modulos = codigo.getModuleCount();
  const lado = modulos + MARGEM * 2;

  /**
   * Um `<path>` só, com um `M x y h1 v1 h-1 z` por módulo escuro.
   *
   * A alternativa — um `<rect>` por módulo — produz mais de mil elementos para
   * um Pix comum, e o HTML da tela fica maior que o resto da página inteira.
   */
  const partes: string[] = [];
  for (let linha = 0; linha < modulos; linha += 1) {
    for (let coluna = 0; coluna < modulos; coluna += 1) {
      if (codigo.isDark(linha, coluna)) {
        partes.push(`M${coluna + MARGEM} ${linha + MARGEM}h1v1h-1z`);
      }
    }
  }

  return {
    lado,
    svg: [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${lado} ${lado}"`,
      ` shape-rendering="crispEdges" role="img" aria-label="QR Code do Pix">`,
      `<rect width="${lado}" height="${lado}" fill="#ffffff"/>`,
      `<path d="${partes.join('')}" fill="#000000"/>`,
      `</svg>`,
    ].join(''),
  };
}
