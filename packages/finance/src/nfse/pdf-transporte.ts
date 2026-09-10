import { request } from 'node:https';
import type { CertificadoA1 } from './certificado.js';
import type { AmbienteNfse } from './transporte.js';
import { NfseError } from './erros.js';

export type TransportePdfNfse = (p: { ambiente: AmbienteNfse; chave: string; certificado: CertificadoA1 }) => Promise<Buffer>;
const BASE = { homologacao: 'https://adn.producaorestrita.nfse.gov.br', producao: 'https://adn.nfse.gov.br' } as const;
/** O DANFSe vem diretamente do ADN oficial, com o A1 da unidade. */
export async function obterPdfNfse(p: Parameters<TransportePdfNfse>[0], enviar: typeof request = request): Promise<Buffer> {
  if (!Object.hasOwn(BASE, p.ambiente) || !/^\d{50}$/.test(p.chave)) throw new NfseError('nfse_destino_invalido', 'Destino fiscal inválido.');
  return new Promise((resolve, reject) => {
    const req = enviar(new URL(`${BASE[p.ambiente]}/danfse/${p.chave}`), { method: 'GET', cert: p.certificado.cadeiaPem,
      key: p.certificado.chavePem, minVersion: 'TLSv1.2', rejectUnauthorized: true, headers: { Accept: 'application/pdf' } }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new NfseError('nfse_pdf_indisponivel', 'O DANFSe ainda não está disponível no emissor.', 503)); return; }
      const partes: Buffer[] = []; let tamanho = 0;
      res.on('data', (parte: Buffer) => {
        tamanho += parte.length;
        if (tamanho > 5 * 1024 * 1024) { req.destroy(); reject(new NfseError('nfse_pdf_invalido', 'O DANFSe excedeu o limite.', 502)); }
        else partes.push(parte);
      });
      res.on('error', () => reject(new NfseError('nfse_pdf_indisponivel', 'O download do DANFSe será repetido.', 503)));
      res.on('end', () => {
        const pdf = Buffer.concat(partes);
        if (pdf.subarray(0, 5).toString() !== '%PDF-') { reject(new NfseError('nfse_pdf_invalido', 'O emissor não retornou um PDF válido.', 502)); return; }
        resolve(pdf);
      });
    });
    const prazo = setTimeout(() => { req.destroy(); reject(new NfseError('nfse_pdf_timeout', 'O download do DANFSe será repetido.', 503)); }, 20_000);
    req.on('close', () => clearTimeout(prazo));
    req.on('error', () => { clearTimeout(prazo); reject(new NfseError('nfse_pdf_indisponivel', 'O download do DANFSe será repetido.', 503)); });
    req.end();
  });
}
