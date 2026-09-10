import PDFDocument from 'pdfkit';
import { withTenant } from '@barbearia/db';
import { NfseError } from '../nfse/erros.js';
import { lerDocumentoMunicipal, snapshotMunicipal } from './documentos.js';

/** Representação auxiliar da nota municipal; o XML original permanece disponível. */
export async function baixarPdfMunicipal(p: { tenantId: string; locationId: string; invoiceId: string }): Promise<Buffer> {
  const doc = await lerDocumentoMunicipal(p.tenantId, p.invoiceId);
  if (doc.location_id !== p.locationId || !doc.nfse_cipher || !doc.number)
    throw new NfseError('nfse_pdf_indisponivel', 'A nota municipal ainda não foi autorizada.', 404);
  const rows = await withTenant(p.tenantId, tx => tx.$queryRaw<{ status: string }[]>`
    SELECT status::text FROM fiscal_invoices WHERE id = ${p.invoiceId}::uuid AND location_id = ${p.locationId}::uuid
  `);
  const snapshot = snapshotMunicipal(p.tenantId, doc);
  const moeda = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const pdf = new PDFDocument({ size: 'A4', margin: 44, info: { Title: `NFS-e ${doc.number}` } });
  const resultado = new Promise<Buffer>((resolve, reject) => {
    const partes: Buffer[] = [];
    pdf.on('data', (b: Buffer) => partes.push(b));
    pdf.on('end', () => resolve(Buffer.concat(partes)));
    pdf.on('error', reject);
  });
  pdf.font('Helvetica-Bold').fontSize(19).text('Nota fiscal de serviços eletrônica');
  pdf.font('Helvetica').fontSize(10).text('Representação auxiliar da NFS-e municipal');
  pdf.moveDown();
  if (doc.environment === 'homologacao') pdf.font('Helvetica-Bold').text('HOMOLOGAÇÃO — SEM VALOR FISCAL');
  if (rows[0]?.status === 'cancelada' || doc.cancel_event_cipher) pdf.font('Helvetica-Bold').text('NOTA CANCELADA');
  pdf.font('Helvetica').fontSize(11).text(`Número: ${doc.number}    Código de verificação: ${doc.verification_code ?? '—'}`);
  pdf.text(`Competência: ${snapshot.competencia.split('-').reverse().join('/')}    RPS: ${snapshot.serie}/${snapshot.numeroRps}`);
  pdf.moveDown().font('Helvetica-Bold').text('Prestador');
  pdf.font('Helvetica').text(snapshot.razaoSocial).text(`CNPJ: ${snapshot.cnpj}    Inscrição municipal: ${snapshot.inscricaoMunicipal}`);
  const e = snapshot.enderecoPrestador;
  pdf.text(`${e.logradouro}, ${e.numero} — ${e.bairro}`).text(`${e.nomeMunicipio}/${e.uf} — CEP ${e.cep}`);
  pdf.moveDown().font('Helvetica-Bold').text('Tomador');
  pdf.font('Helvetica').text(snapshot.tomador ? `${snapshot.tomador.nome} — ${snapshot.tomador.documento}` : 'Consumidor não identificado');
  pdf.moveDown().font('Helvetica-Bold').text('Serviços');
  pdf.font('Helvetica').text(snapshot.descricao);
  pdf.moveDown().text(`Valor dos serviços: ${moeda(snapshot.servicoCents)}`)
    .text(`Desconto incondicionado: ${moeda(snapshot.descontoCents)}`)
    .font('Helvetica-Bold').text(`Total: ${moeda(snapshot.servicoCents - snapshot.descontoCents)}`);
  pdf.moveDown().font('Helvetica').fontSize(9).text('Consulte a autenticidade no portal da prefeitura com o número e o código de verificação. O XML autorizado é o documento original e pode ser baixado no sistema.');
  pdf.end();
  return resultado;
}
