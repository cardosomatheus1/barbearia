import { describe, expect, it } from 'vitest';
import { qrCodeSvg } from './qrcode.js';

/**
 * O QR Code do Pix (bloco 35).
 *
 * O que estes testes protegem é o modo de falhar que ninguém vê em revisão: um
 * código malformado tem cara de código e simplesmente não lê no banco do
 * cliente, com ele parado na frente do balcão.
 */

const PIX_REAL =
  '00020126580014BR.GOV.BCB.PIX0136123e4567-e12b-12d1-a456-42665544000052040000' +
  '5303986540510.005802BR5913Domari Barber6008SALVADOR62070503***6304ABCD';

describe('o QR Code do Pix', () => {
  it('sai como SVG sem largura fixa', () => {
    /**
     * Quem decide o tamanho é o CSS. Um SVG com medida em pixel embutida não
     * caberia numa tela de 360px sem estourar — e rolagem horizontal na página
     * é o defeito que o piso do projeto proíbe.
     */
    const { svg } = qrCodeSvg(PIX_REAL);

    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('viewBox="0 0');
    expect(/<svg[^>]*\swidth=/.test(svg)).toBe(false);
    expect(/<svg[^>]*\sheight=/.test(svg)).toBe(false);
  });

  it('tem a área tranquila que o padrão exige', () => {
    /**
     * Quatro módulos de margem em volta. Sem ela o leitor não encontra os
     * padrões de posição quando o código está sobre fundo colorido — que é
     * exatamente o caso desta tela.
     */
    const { lado, svg } = qrCodeSvg(PIX_REAL);
    const primeiro = /M(\d+) (\d+)h1v1h-1z/.exec(svg);

    // O canto superior esquerdo do primeiro módulo escuro nunca encosta na
    // borda: ele começa em 4, que é onde a matriz começa.
    expect(primeiro?.[1]).toBe('4');
    expect(primeiro?.[2]).toBe('4');
    // E o `viewBox` acomoda a matriz mais as duas margens.
    expect(lado).toBeGreaterThanOrEqual(21 + 8);
  });

  it('texto longo não estoura — a versão cresce com o conteúdo', () => {
    // Fixar uma versão faria o copia-e-cola de uma barbearia com nome comprido
    // simplesmente não caber, e o erro apareceria só em produção.
    const curto = qrCodeSvg('00020126');
    const longo = qrCodeSvg(`${PIX_REAL}${PIX_REAL}`);

    expect(longo.lado).toBeGreaterThan(curto.lado);
  });

  it('desenha um caminho só, não mil retângulos', () => {
    // Um `<rect>` por módulo produz mais de mil elementos para um Pix comum, e
    // o HTML da tela fica maior que o resto da página inteira.
    const { svg } = qrCodeSvg(PIX_REAL);

    expect(svg.split('<path').length - 1).toBe(1);
    // O único `<rect>` é o fundo branco, que o leitor precisa para ter
    // contraste sobre o tema escuro do painel.
    expect(svg.split('<rect').length - 1).toBe(1);
  });

  it('é legível por leitor de tela', () => {
    // Uma imagem sem nome é uma imagem que não existe para quem não enxerga —
    // e o copia-e-cola ao lado é o caminho que essa pessoa vai usar.
    const { svg } = qrCodeSvg(PIX_REAL);

    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="QR Code do Pix"');
  });

  it('o mesmo texto produz sempre o mesmo código', () => {
    // Determinístico: a tela é remontada a cada recarga, e um código que mudasse
    // de forma faria o cliente achar que o anterior venceu.
    expect(qrCodeSvg(PIX_REAL).svg).toBe(qrCodeSvg(PIX_REAL).svg);
  });
});
