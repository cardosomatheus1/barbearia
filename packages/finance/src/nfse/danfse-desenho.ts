import PDFDocument from 'pdfkit';
import qrcode from 'qrcode-generator';
import { fileURLToPath } from 'node:url';
import type { FontesDanfse } from './danfse-fontes.js';

const CM = 72 / 2.54;
export const BORDA_DANFSE = 0.2;
export const LARGURA_DANFSE = 20.6;
const COLUNA = LARGURA_DANFSE / 4;

/** Coordenadas em cm; tipografia/linhas conforme NT008 v1.02, §2.2–2.4. */
export function desenhoDanfse(fontes: FontesDanfse) {
  const pdf = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: true, compress: true,
    info: { Title: 'DANFSe v2.0', Author: 'Barberdock', Creator: 'Barberdock — NT008 v1.02' } });
  pdf.registerFont('rotulo', fontes.arialNegrito); pdf.registerFont('conteudo', fontes.conteudo);
  pdf.registerFont('arial', fontes.arialRegular);
  const fundo = (x: number, y: number, w: number, h: number) => pdf.save().fillColor('#f2f2f2').rect(x * CM, y * CM, w * CM, h * CM).fill().restore();
  const linha = (y: number) => pdf.lineWidth(0.5).moveTo(BORDA_DANFSE * CM, y * CM).lineTo((BORDA_DANFSE + LARGURA_DANFSE) * CM, y * CM).stroke();
  const texto = (valor: string, x: number, y: number, w: number, h: number, tamanho = 7,
    fonte = 'conteudo', cor = '#000000', align: 'left' | 'center' = 'left') => {
    pdf.font(fonte).fontSize(tamanho).fillColor(cor).text(valor || '-', x * CM, y * CM, {
      width: w * CM, height: h * CM, ellipsis: true, lineGap: 0, align, paragraphGap: 0,
    });
  };
  const campo = (titulo: string, valor: string, coluna: number, y: number, colunas = 1, h = 0.65, sombreado = false, identificacao = false) => {
    const x = BORDA_DANFSE + coluna * COLUNA; const largura = colunas * COLUNA;
    if (sombreado) fundo(x, y, largura, h);
    texto(identificacao ? titulo.toUpperCase() : titulo, x + 0.06, y + 0.025, largura - 0.12, 0.27, identificacao ? 7 : 6, 'rotulo');
    texto(valor, x + 0.06, y + 0.29, largura - 0.12, h - 0.30);
  };
  const faixa = (titulo: string, y: number, h = 0.4) => {
    fundo(BORDA_DANFSE, y, LARGURA_DANFSE, h);
    texto(titulo.toUpperCase(), BORDA_DANFSE + 0.06, y + 0.05, LARGURA_DANFSE - 0.12, h - 0.06, 7, 'rotulo');
    linha(y); linha(y + h);
  };
  const tituloNaLinha = (titulo: string, y: number, h = 0.65) => {
    fundo(BORDA_DANFSE, y, COLUNA, h);
    texto(titulo.toUpperCase(), BORDA_DANFSE + 0.06, y + 0.14, COLUNA - 0.12, h - 0.16, 7, 'rotulo');
  };
  const cabecalho = (municipio: string, gerador: string, homologacao: boolean, chave: string) => {
    fundo(BORDA_DANFSE, BORDA_DANFSE, LARGURA_DANFSE, 1.16);
    pdf.image(fileURLToPath(new URL('../../assets/danfse/logo-nfse.png', import.meta.url)), 0.4 * CM, 0.5 * CM, { width: 4 * CM });
    texto('DANFSe v2.0', 5.3, 0.25, 10.3, 0.4, 9, 'rotulo', '#000000', 'center');
    texto('Documento Auxiliar da NFS-e', 5.3, 0.63, 10.3, 0.4, 9, 'rotulo', '#000000', 'center');
    if (homologacao) texto('NFS-e SEM VALIDADE JURÍDICA', 5.3, 1.03, 10.3, 0.3, 9, 'rotulo', '#ff0000', 'center');
    texto(`Município: ${municipio}`, 15.65, 0.3, 5, 0.6, 8);
    texto(`Ambiente gerador: ${gerador}`, 15.65, 0.95, 5, 0.24, 6);
    texto(homologacao ? 'Ambiente: Homologação' : 'Ambiente: Produção', 15.65, 1.18, 5, 0.24, 6);
    linha(1.46);
    const qr = qrcode(0, 'M');
    const url = `https://www.nfse.gov.br/ConsultaPublica/?tpc=1&chave=${chave}`;
    qr.addData(url); qr.make();
    const quantidade = qr.getModuleCount(); const tamanho = 1.65 * CM; const celula = tamanho / quantidade;
    // Vetores com margem branca: não dependem de CDN nem de imagem externa.
    pdf.save().fillColor('#000000');
    for (let r = 0; r < quantidade; r++) for (let c = 0; c < quantidade; c++) {
      if (qr.isDark(r, c)) pdf.rect(17.48 * CM + c * celula, 1.67 * CM + r * celula, celula, celula).fill();
    }
    pdf.restore(); pdf.link(17.48 * CM, 1.67 * CM, tamanho, tamanho, url);
    texto('A autenticidade desta NFS-e pode ser verificada pela leitura deste código QR ou pela consulta da chave de acesso no portal nacional da NFS-e',
      15.85, 3.46, 4.7, 0.8, 6);
  };
  const terminar = async (): Promise<Buffer> => {
    pdf.lineWidth(1).rect(BORDA_DANFSE * CM, BORDA_DANFSE * CM, LARGURA_DANFSE * CM, (29.7 - 2 * BORDA_DANFSE) * CM).stroke();
    const partes: Buffer[] = [];
    const resultado = new Promise<Buffer>((resolve, reject) => {
      pdf.on('data', (parte: Buffer) => partes.push(parte));
      pdf.on('end', () => resolve(Buffer.concat(partes))); pdf.on('error', reject);
    });
    pdf.end(); return resultado;
  };
  const cancelada = () => {
    pdf.save().rotate(-35, { origin: [10.5 * CM, 14.85 * CM] });
    texto('CANCELADA', 3, 14, 15, 2.5, 50, 'arial', '#a6a6a6', 'center'); pdf.restore();
  };
  return { campo, texto, linha, faixa, tituloNaLinha, cabecalho, terminar, cancelada };
}
