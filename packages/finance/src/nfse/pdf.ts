import { withTenant } from '@barbearia/db';
import { cifrarFiscal, decifrarFiscal } from './cofre.js';
import { lerDocumentoNfse, snapshotDoDocumento, escopoDocumento } from './documentos.js';
import { certificadoDaUnidade } from './configuracao.js';
import { NfseError } from './erros.js';
import { obterPdfNfse, type TransportePdfNfse } from './pdf-transporte.js';
import { urlDoDocumento, verificarTokenDoDocumento } from './link.js';

/** A autorização não depende do PDF estar disponível; a varredura recupera o documento depois. */
export async function prepararPdfsNfse(tenantId: string, transporte: TransportePdfNfse = obterPdfNfse): Promise<{ preparados: number; falhas: number }> {
  const rows = await withTenant(tenantId, tx => tx.$queryRaw<{ invoice_id: string }[]>`
    SELECT d.invoice_id FROM fiscal_native_documents d JOIN fiscal_invoices i ON i.id = d.invoice_id
     WHERE d.nfse_cipher IS NOT NULL AND d.pdf_cipher IS NULL AND i.status = 'autorizada'
     ORDER BY d.created_at LIMIT 10
  `);
  let preparados = 0; let falhas = 0;
  for (const row of rows) {
    try {
      const doc = await lerDocumentoNfse(tenantId, row.invoice_id);
      if (!doc.access_key) continue;
      const snapshot = snapshotDoDocumento(tenantId, doc);
      const certificado = await certificadoDaUnidade(tenantId, doc.location_id, snapshot.cnpj);
      const pdf = await transporte({ ambiente: doc.environment, chave: doc.access_key, certificado });
      if (pdf.length > 5 * 1024 * 1024 || pdf.subarray(0, 5).toString() !== '%PDF-') throw new NfseError('nfse_pdf_invalido', 'O documento retornado não é um PDF válido.');
      const cipher = cifrarFiscal(pdf.toString('base64'), escopoDocumento(tenantId, doc, 'pdf'));
      const link = urlDoDocumento({ tenantId, locationId: doc.location_id, invoiceId: doc.invoice_id });
      await withTenant(tenantId, async tx => {
        const atualizou = await tx.$executeRaw`
          UPDATE fiscal_native_documents SET pdf_cipher = ${cipher}, last_error_code = NULL, updated_at = now()
           WHERE invoice_id = ${doc.invoice_id}::uuid AND pdf_cipher IS NULL
        `;
        if (atualizou) {
          await tx.$executeRaw`UPDATE fiscal_invoices SET pdf_url = ${link} WHERE id = ${doc.invoice_id}::uuid`;
          preparados += 1;
        }
      });
    } catch (erro) {
      falhas += 1;
      const code=erro instanceof NfseError && /^[a-z0-9_]{1,80}$/.test(erro.code) ? erro.code : 'nfse_pdf_indisponivel';
      // Persistir só código conhecido; mensagem de rede pode carregar dados externos.
      await withTenant(tenantId,tx=>tx.$executeRaw`UPDATE fiscal_native_documents SET last_error_code=${code},updated_at=now()
        WHERE invoice_id=${row.invoice_id}::uuid AND pdf_cipher IS NULL`);
    }
  }
  return { preparados, falhas };
}

export async function baixarPdfNfse(p: { tenantId: string; locationId: string; invoiceId: string }): Promise<Buffer> {
  const rows = await withTenant(p.tenantId, tx => tx.$queryRaw<{ pdf_cipher: string | null }[]>`
    SELECT pdf_cipher FROM fiscal_native_documents WHERE invoice_id = ${p.invoiceId}::uuid AND location_id = ${p.locationId}::uuid
  `);
  if (!rows[0]?.pdf_cipher) throw new NfseError('nfse_pdf_indisponivel', 'O PDF desta nota ainda não está disponível.', 404);
  return Buffer.from(decifrarFiscal(rows[0].pdf_cipher, `${p.tenantId}:${p.locationId}:${p.invoiceId}:pdf`), 'base64');
}

export async function pdfPeloLinkNfse(token: string): Promise<Buffer> {
  const p = verificarTokenDoDocumento(token);
  const rows = await withTenant(p.tenantId, tx => tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM fiscal_invoices WHERE id = ${p.invoiceId}::uuid AND location_id = ${p.locationId}::uuid AND status = 'autorizada'
  `);
  if (!rows[0]) throw new NfseError('nfse_link_invalido', 'Esta nota não está disponível. Consulte a barbearia.', 404);
  return baixarPdfNfse(p);
}
