import type { TransactionClient } from '@barbearia/db';
import { withTenant } from '@barbearia/db';
import { identificadorDps, type DadosDps } from './dps.js';
import { ratearDesconto } from '@barbearia/core';
import { cifrarFiscal, decifrarFiscal } from './cofre.js';
import { lerConfiguracaoNfse } from './configuracao.js';
import { recusarNfse } from './erros.js';
import type { AmbienteNfse } from './transporte.js';

export interface DocumentoNfse {
  invoice_id: string; location_id: string; environment: AmbienteNfse; dps_id: string;
  snapshot_cipher: string; signed_dps_cipher: string | null; nfse_cipher: string | null;
  access_key: string | null; cancel_request_cipher: string | null; cancel_event_cipher: string | null;
  cancel_error_code: string | null;
  attempt_at: Date | null;
}
export function escopoDocumento(tenantId: string, doc: Pick<DocumentoNfse, 'invoice_id' | 'location_id'>, tipo: string): string {
  return `${tenantId}:${doc.location_id}:${doc.invoice_id}:${tipo}`;
}

/** Chamado sob a trava de fiscal_settings e na mesma transação que cria a nota. */
export async function prepararDocumentoNfse(tx: TransactionClient, tenantId: string, invoiceId: string): Promise<void> {
  const rows = await tx.$queryRaw<{
    location_id: string; cnpj: string; regime: string; municipality_ibge: string; municipal_registration: string | null;
    service_cents: number; discount_cents: number; requested_at: Date; competence: string; customer_name: string | null; customer_document: string | null;
  }[]>`
    SELECT i.location_id, s.cnpj, i.regime::text, i.municipality_ibge, s.municipal_registration,
           i.service_cents, o.discount_cents, i.requested_at, to_char(i.requested_at AT TIME ZONE l.timezone, 'YYYY-MM-DD') AS competence,
           i.customer_name, i.customer_document
      FROM fiscal_invoices i JOIN fiscal_settings s ON s.location_id = i.location_id
      JOIN locations l ON l.id = i.location_id JOIN orders o ON o.id = i.order_id WHERE i.id = ${invoiceId}::uuid
  `;
  const r = rows[0];
  if (!r) recusarNfse('nota_nao_encontrada', 'Esta nota não existe.', 404);
  const config = await lerConfiguracaoNfse(tx, r.location_id);
  if (!config?.habilitada || (r.regime !== 'mei' && r.regime !== 'simples')) {
    recusarNfse('nfse_nao_configurada', 'Confira a configuração do emissor nacional.');
  }
  const itens = await tx.$queryRaw<{ id: string; kind: string; description: string; quantity: number; unit_price_cents: number }[]>`
    SELECT oi.id, oi.kind::text, oi.description, oi.quantity, oi.unit_price_cents
      FROM order_items oi JOIN fiscal_invoices i ON i.order_id = oi.order_id
     WHERE i.id = ${invoiceId}::uuid ORDER BY oi.position
  `;
  const descontos = ratearDesconto({ descontoCents: r.discount_cents, itens: itens.map(i => ({ id: i.id,
    professionalId: null, serviceId: null, categoryId: null, totalCents: i.quantity * i.unit_price_cents })) });
  const servicos = itens.filter(i => i.kind === 'service');
  const counters = await tx.$queryRaw<{ last_number: bigint }[]>`
    INSERT INTO fiscal_dps_counters (tenant_id, cnpj, municipality_ibge, environment, series, last_number)
    VALUES (${tenantId}::uuid, ${r.cnpj}, ${r.municipality_ibge}, ${config.ambiente}, ${config.serie}, 1)
    ON CONFLICT (cnpj, municipality_ibge, environment, series) DO UPDATE
      SET last_number = fiscal_dps_counters.last_number + 1
    RETURNING last_number
  `;
  const numero = counters[0]?.last_number.toString();
  if (!numero) recusarNfse('nfse_numeracao_indisponivel', 'Não foi possível reservar a numeração da nota.');
  const snapshot: DadosDps = { ambiente: config.ambiente, cnpj: r.cnpj, municipioEmissor: r.municipality_ibge,
    municipioPrestacao: r.municipality_ibge, regime: r.regime, serie: config.serie, numero, emitidaEm: r.requested_at,
    competencia: r.competence, codigoNacional: config.codigoNacional,
    ...(config.codigoMunicipal ? { codigoMunicipal: config.codigoMunicipal } : {}),
    ...(config.nbs ? { nbs: config.nbs } : {}),
    ...(r.municipal_registration ? { inscricaoMunicipal: r.municipal_registration } : {}),
    ...(config.aliquotaTotalSimplesBps !== null ? { aliquotaTotalSimplesBps: config.aliquotaTotalSimplesBps } : {}),
    descricao: servicos.map(i => `${i.quantity}x ${i.description}`).join('; '), servicoCents: r.service_cents,
    descontoIncondicionadoCents: servicos.reduce((total, i) => total + (descontos.get(i.id) ?? 0), 0),
    ...(r.customer_document ? { tomador: { documento: r.customer_document, nome: r.customer_name ?? 'Consumidor' } } : {}),
  };
  const idDps = identificadorDps(snapshot);
  const cipher = cifrarFiscal(JSON.stringify(snapshot), escopoDocumento(tenantId, { invoice_id: invoiceId, location_id: r.location_id }, 'snapshot'));
  await tx.$executeRaw`
    INSERT INTO fiscal_native_documents (invoice_id, location_id, tenant_id, environment, dps_id, snapshot_cipher)
    VALUES (${invoiceId}::uuid, ${r.location_id}::uuid, ${tenantId}::uuid, ${config.ambiente}, ${idDps}, ${cipher})
  `;
}

export async function lerDocumentoNfse(tenantId: string, invoiceId: string): Promise<DocumentoNfse> {
  const rows = await withTenant(tenantId, tx => tx.$queryRaw<DocumentoNfse[]>`
    SELECT invoice_id, location_id, environment, dps_id, snapshot_cipher, signed_dps_cipher, nfse_cipher,
           access_key, cancel_request_cipher, cancel_event_cipher, cancel_error_code, attempt_at
      FROM fiscal_native_documents WHERE invoice_id = ${invoiceId}::uuid
  `);
  if (!rows[0]) recusarNfse('nfse_documento_ausente', 'Esta nota não tem uma DPS do emissor nacional.', 404);
  return rows[0];
}

export function snapshotDoDocumento(tenantId: string, doc: DocumentoNfse): DadosDps {
  const dados = JSON.parse(decifrarFiscal(doc.snapshot_cipher, escopoDocumento(tenantId, doc, 'snapshot'))) as Omit<DadosDps, 'emitidaEm'> & { emitidaEm: string };
  return { ...dados, emitidaEm: new Date(dados.emitidaEm) };
}

export async function baixarXmlNfse(p: { tenantId: string; locationId: string; invoiceId: string }): Promise<string> {
  const doc = await lerDocumentoNfse(p.tenantId, p.invoiceId);
  if (doc.location_id !== p.locationId) recusarNfse('nota_nao_encontrada', 'Esta nota não existe.', 404);
  if (!doc.nfse_cipher) recusarNfse('nfse_xml_indisponivel', 'O XML autorizado ainda não está disponível.');
  return decifrarFiscal(doc.nfse_cipher, escopoDocumento(p.tenantId, doc, 'nfse'));
}
