import { withTenant, type TransactionClient } from '@barbearia/db';
import { ratearDesconto } from '@barbearia/core';
import { cifrarFiscal, decifrarFiscal } from '../nfse/cofre.js';
import { NfseError } from '../nfse/erros.js';
import { lerConfiguracaoMunicipal } from './configuracao.js';
import type { SnapshotMunicipal, NotaMunicipal } from './contrato.js';

export interface DocumentoMunicipal {
  invoice_id: string; location_id: string; environment: 'homologacao' | 'producao'; snapshot_cipher: string;
  request_cipher: string | null; response_cipher: string | null; initial_response_cipher: string | null; nfse_cipher: string | null;
  number: string | null; verification_code: string | null; protocol: string | null; batch_number: number | null;
  attempt_at: Date | null; cancel_request_cipher: string | null; cancel_event_cipher: string | null;
  cancel_error_code: string | null; rejection_codes: string[] | null;
}
export function escopoMunicipal(tenantId: string, doc: Pick<DocumentoMunicipal, 'invoice_id' | 'location_id'>, tipo: string): string {
  return `${tenantId}:${doc.location_id}:${doc.invoice_id}:municipal_${tipo}`;
}
export function dataMunicipal(data: Date, timeZone: string): string {
  const partes = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' }).formatToParts(data);
  const campo = (tipo: string) => partes.find(p => p.type === tipo)?.value ?? '';
  const offset = campo('timeZoneName').replace('GMT', '') || '+00:00';
  return `${campo('year')}-${campo('month')}-${campo('day')}T${campo('hour')}:${campo('minute')}:${campo('second')}${offset}`;
}
export async function prepararDocumentoMunicipal(tx: TransactionClient, tenantId: string, invoiceId: string): Promise<void> {
  const rows = await tx.$queryRaw<{
    location_id: string; cnpj: string; regime: string; municipality_ibge: string; municipal_registration: string | null;
    service_cents: number; discount_cents: number; iss_bps: number; requested_at: Date; timezone: string;
    customer_name: string | null; customer_document: string | null;
  }[]>`
    SELECT i.location_id, s.cnpj, i.regime::text, i.municipality_ibge, s.municipal_registration,
           i.service_cents, o.discount_cents, i.iss_bps, i.requested_at, l.timezone, i.customer_name, i.customer_document
      FROM fiscal_invoices i JOIN fiscal_settings s ON s.location_id = i.location_id
      JOIN locations l ON l.id = i.location_id JOIN orders o ON o.id = i.order_id WHERE i.id = ${invoiceId}::uuid
  `;
  const r = rows[0];
  if (!r) throw new NfseError('nota_nao_encontrada', 'Esta nota não existe.', 404);
  const c = await lerConfiguracaoMunicipal(tx, r.location_id);
  if (!c?.habilitada || !r.municipal_registration || (r.regime !== 'simples' && r.regime !== 'normal'))
    throw new NfseError('nfse_municipal_nao_configurada', 'Confira a configuração municipal.');
  const itens = await tx.$queryRaw<{ id: string; kind: string; description: string; quantity: number; unit_price_cents: number }[]>`
    SELECT oi.id, oi.kind::text, oi.description, oi.quantity, oi.unit_price_cents
      FROM order_items oi JOIN fiscal_invoices i ON i.order_id = oi.order_id WHERE i.id = ${invoiceId}::uuid ORDER BY oi.position
  `;
  const descontos = ratearDesconto({ descontoCents: r.discount_cents, itens: itens.map(i => ({ id: i.id,
    professionalId: null, serviceId: null, categoryId: null, totalCents: i.quantity * i.unit_price_cents })) });
  const servicos = itens.filter(i => i.kind === 'service');
  const descontoCents = servicos.reduce((s, i) => s + (descontos.get(i.id) ?? 0), 0);
  if (r.municipality_ibge === '3550308' && (descontoCents > 0 || c.layoutSaoPaulo !== 1))
    throw new NfseError('nfse_municipal_perfil_sem_suporte', 'O emissor de São Paulo disponível atende ao layout 1 sem desconto. Para esta operação, utilize o portal da prefeitura.', 400);
  const counter = await tx.$queryRaw<{ last_number: number }[]>`
    INSERT INTO fiscal_rps_counters (tenant_id, cnpj, municipality_ibge, environment, series, last_number)
    VALUES (${tenantId}::uuid, ${r.cnpj}, ${r.municipality_ibge}, ${c.ambiente}, ${c.serie}, ${c.numeroInicial})
    ON CONFLICT (cnpj, municipality_ibge, environment, series) DO UPDATE SET last_number = fiscal_rps_counters.last_number + 1
    RETURNING last_number
  `;
  const numeroRps = counter[0]?.last_number;
  if (!numeroRps) throw new NfseError('nfse_municipal_numeracao', 'A numeração municipal não está disponível.');
  const emitidaEm = dataMunicipal(r.requested_at, r.timezone);
  const snapshot: SnapshotMunicipal = {
    ambiente: c.ambiente, municipio: Number(r.municipality_ibge), cnpj: r.cnpj,
    inscricaoMunicipal: r.municipal_registration, razaoSocial: c.razaoSocial, enderecoPrestador: c.enderecoPrestador,
    regime: r.regime, serie: c.serie, numeroRps, emitidaEm, competencia: emitidaEm.slice(0, 10),
    descricao: servicos.map(i => `${i.quantity}x ${i.description}`).join('; '), servicoCents: r.service_cents,
    descontoCents, aliquotaIssBps: r.iss_bps,
    itemListaServico: c.itemListaServico, codigoMunicipal: c.codigoMunicipal, cnae: c.cnae, nbs: c.nbs,
    layoutSaoPaulo: c.layoutSaoPaulo, codigoCancelamento: c.codigoCancelamento,
    tomador: r.customer_document ? { documento: r.customer_document, nome: r.customer_name ?? 'Consumidor' } : null,
  };
  const cipher = cifrarFiscal(JSON.stringify(snapshot), escopoMunicipal(tenantId, { invoice_id: invoiceId, location_id: r.location_id }, 'snapshot'));
  await tx.$executeRaw`
    INSERT INTO fiscal_municipal_documents (invoice_id, location_id, tenant_id, environment, snapshot_cipher)
    VALUES (${invoiceId}::uuid, ${r.location_id}::uuid, ${tenantId}::uuid, ${c.ambiente}, ${cipher})
  `;
}
export async function lerDocumentoMunicipal(tenantId: string, invoiceId: string): Promise<DocumentoMunicipal> {
  const rows = await withTenant(tenantId, tx => tx.$queryRaw<DocumentoMunicipal[]>`
    SELECT invoice_id, location_id, environment, snapshot_cipher, request_cipher, response_cipher, initial_response_cipher, rejection_codes, nfse_cipher,
           number, verification_code, protocol, batch_number, attempt_at, cancel_request_cipher, cancel_event_cipher, cancel_error_code
      FROM fiscal_municipal_documents WHERE invoice_id = ${invoiceId}::uuid
  `);
  if (!rows[0]) throw new NfseError('nota_nao_encontrada', 'Esta nota municipal não existe.', 404);
  return rows[0];
}
export function snapshotMunicipal(tenantId: string, doc: DocumentoMunicipal): SnapshotMunicipal {
  return JSON.parse(decifrarFiscal(doc.snapshot_cipher, escopoMunicipal(tenantId, doc, 'snapshot'))) as SnapshotMunicipal;
}
export function conferirNotaMunicipal(nota: NotaMunicipal, snapshot: SnapshotMunicipal): void {
  // O layout 1 de São Paulo preenche a IM numérica até oito posições.
  // Não aplicar a outros municípios: inscrições alfanuméricas são literais.
  const inscricao = (valor: string) => snapshot.municipio === 3550308 && /^\d{1,8}$/.test(valor)
    ? valor.padStart(8, '0') : valor;
  const emissorConfere = Boolean(nota.cnpj || nota.inscricaoMunicipal) &&
    (!nota.cnpj || nota.cnpj === snapshot.cnpj) &&
    (!nota.inscricaoMunicipal || inscricao(nota.inscricaoMunicipal) === inscricao(snapshot.inscricaoMunicipal));
  if (!nota.numero || !nota.xml || !emissorConfere || Number(nota.rps) !== snapshot.numeroRps ||
      nota.serie.trim() !== snapshot.serie || nota.servicoCents !== snapshot.servicoCents ||
      nota.descontoCents !== snapshot.descontoCents || nota.documentoTomador !== (snapshot.tomador?.documento ?? '') ||
      (!nota.dataEmissao && !nota.competencia) ||
      (nota.dataEmissao !== null && nota.dataEmissao !== snapshot.emitidaEm.slice(0, 10)) ||
      (nota.competencia !== null && nota.competencia !== snapshot.competencia))
    throw new NfseError('nfse_municipal_resposta_divergente', 'A nota retornada não corresponde ao RPS desta unidade.', 502);
}
export async function baixarXmlMunicipal(p: { tenantId: string; locationId: string; invoiceId: string }): Promise<string> {
  const doc = await lerDocumentoMunicipal(p.tenantId, p.invoiceId);
  if (doc.location_id !== p.locationId || !doc.nfse_cipher) throw new NfseError('nfse_xml_indisponivel', 'O XML desta nota não está disponível.', 404);
  return decifrarFiscal(doc.nfse_cipher, escopoMunicipal(p.tenantId, doc, 'nfse'));
}
