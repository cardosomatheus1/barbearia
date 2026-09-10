import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTenant } from '@barbearia/db';
import { abrirCaixa } from '../caixa.js';
import { abrirComanda, adicionarItem, fecharComanda } from '../comanda.js';
import { salvarConfiguracaoFiscal } from '../fiscal-configuracao.js';
import { notaDaVenda } from '../fiscal-notas.js';
import { cancelarNota, conciliarNotas, enviarNota } from '../fiscal-emissao.js';
import { salvarCertificadoNfse, salvarConfiguracaoNfse, situacaoNfse } from './configuracao.js';
import { baixarXmlNfse, lerDocumentoNfse, snapshotDoDocumento } from './documentos.js';
import { EmissorNacionalNfse } from './emissor.js';
import { prepararPdfsNfse, pdfPeloLinkNfse, baixarPdfNfse } from './pdf.js';
import { notasAEntregar } from '../fiscal-entrega.js';
import { verificarTokenDoDocumento } from './link.js';
import { compactarXmlFiscal, descompactarXmlFiscal } from './xml-seguro.js';
import type { PedidoHttpNfse, RespostaHttpNfse, TransporteNfse } from './transporte.js';
import { certificadoNfseSintetico, nfseSintetica, eventoNfseSintetico, CHAVE_TESTE_NFSE, CNPJ_TESTE_NFSE } from '../../test/nfse-fixtures.js';

const SEED_URL = process.env['SEED_DATABASE_URL'];
const describeDb = SEED_URL && process.env['APP_DATABASE_URL'] ? describe : describe.skip;
const TENANT = '62111111-1111-1111-1111-111111111111';
const RIVAL = '62222222-2222-2222-2222-222222222222';
const LOCATION = '62111111-0000-0000-0000-000000000001';
const STAFF = '62111111-0000-0000-0000-000000000002';
const SERVICE = '62111111-0000-0000-0000-000000000003';
const PROFESSIONAL = '62111111-0000-0000-0000-000000000004';
const CUSTOMER = '62111111-0000-0000-0000-000000000005';
const ator = { tenantId: TENANT, locationId: LOCATION, staffId: STAFF, staffName: 'Operadora sintetica' };
let admin: PrismaClient; let cred: ReturnType<typeof certificadoNfseSintetico>;

/** Simula somente a autoridade externa. Banco, RLS, XML, assinatura, fila e casos de uso são reais. */
function autoridade() {
  let nota: string | undefined; let evento: string | undefined;
  let perderEmissao = false; let perderCancelamento = false; let recusarCancelamento = false;
  const requests: PedidoHttpNfse[] = [];
  const transporte: TransporteNfse = async p => {
    requests.push(p);
    if (p.metodo === 'GET' && p.caminho.startsWith('/dps/')) return nota
      ? { status: 200, dados: { chaveAcesso: CHAVE_TESTE_NFSE } } : { status: 404, dados: {} };
    if (p.metodo === 'GET' && p.caminho.endsWith('/101101/1')) return evento
      ? { status: 200, dados: { eventoXmlGZipB64: compactarXmlFiscal(evento) } } : { status: 404, dados: {} };
    if (p.metodo === 'POST' && p.caminho.endsWith('/eventos')) {
      if (recusarCancelamento) return { status: 400, dados: { erros: [{ codigo: 'E0840' }] } };
      evento = eventoNfseSintetico(descompactarXmlFiscal(p.corpo?.['pedidoRegistroEventoXmlGZipB64'] ?? ''), cred.certificado);
      if (perderCancelamento) throw new Error('resposta externa perdida');
      return { status: 201, dados: { eventoXmlGZipB64: compactarXmlFiscal(evento) } };
    }
    if (p.metodo === 'POST' && p.caminho === '/nfse') {
      nota = nfseSintetica(descompactarXmlFiscal(p.corpo?.['dpsXmlGZipB64'] ?? ''), cred.certificado);
      if (perderEmissao) throw new Error('resposta externa perdida');
    }
    if (nota) return { status: 200, dados: { chaveAcesso: CHAVE_TESTE_NFSE, nfseXmlGZipB64: compactarXmlFiscal(nota) } };
    throw new Error('chamada inesperada ao contrato');
  };
  return { transporte, requests,
    perderEmissao: () => { perderEmissao = true; }, perderCancelamento: () => { perderCancelamento = true; },
    rejeitarCancelamento: (valor: boolean) => { recusarCancelamento = valor; } };
}

describeDb('NFS-e própria com banco e RLS', () => {
  beforeAll(() => {
    if (!SEED_URL) throw new Error('Banco isolado obrigatório');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
    cred = certificadoNfseSintetico();
  });
  afterAll(async () => { await admin?.$disconnect(); });
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(async () => {
    vi.stubEnv('FISCAL_MODO', 'nacional'); vi.stubEnv('FISCAL_SECRET_KEY', Buffer.alloc(32, 21).toString('base64'));
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await admin.$executeRawUnsafe('TRUNCATE staff_directory CASCADE');
    await admin.$executeRaw`INSERT INTO tenants (id, name) VALUES (${TENANT}::uuid, 'Sintetica'), (${RIVAL}::uuid, 'Vizinha sintetica')`;
    await admin.$executeRaw`INSERT INTO locations (id, tenant_id, name, timezone) VALUES (${LOCATION}::uuid, ${TENANT}::uuid, 'Matriz', 'America/Sao_Paulo')`;
    await admin.$executeRaw`INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES (${STAFF}::uuid, ${TENANT}::uuid, 'Operadora', 'operadora@example.invalid', 'x', 'owner')`;
    await admin.$executeRaw`INSERT INTO professionals (id, tenant_id, location_id, name, kind)
      VALUES (${PROFESSIONAL}::uuid, ${TENANT}::uuid, ${LOCATION}::uuid, 'Profissional', 'professional')`;
    await admin.$executeRaw`INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes)
      VALUES (${SERVICE}::uuid, ${TENANT}::uuid, 'Corte', 5000, 30)`;
    await admin.$executeRaw`INSERT INTO customers (id, tenant_id, name, tax_id, phone_e164)
      VALUES (${CUSTOMER}::uuid, ${TENANT}::uuid, 'Cliente sintetico', '52998224725', '+5511999991111')`;
    await salvarConfiguracaoFiscal({ ...ator, config: { cnpj: CNPJ_TESTE_NFSE, regime: 'mei', codigoDeServico: '060101',
      issBps: 0, municipioIbge: '3550308', emitirAutomaticamente: true } });
    await salvarConfiguracaoNfse({ ...ator, config: { ambiente: 'homologacao', serie: 1, codigoNacional: '060101',
      codigoMunicipal: null, nbs: null, aliquotaTotalSimplesBps: null, habilitada: true } });
    await salvarCertificadoNfse({ ...ator, pfx: cred.pfx, senha: cred.senha });
    await abrirCaixa({ ...ator, openingCents: 0 });
  });

  async function vender() {
    const o = await abrirComanda({ ...ator, customerId: CUSTOMER });
    await adicionarItem({ ...ator, orderId: o.id, tipo: 'service', descricao: 'Corte', serviceId: SERVICE,
      professionalId: PROFESSIONAL, quantidade: 1, precoUnitarioCents: 5000 });
    await fecharComanda({ ...ator, orderId: o.id, hojeNaUnidade: '2026-09-09', pagamentos: [{ forma: 'cash', valorCents: 5000 }] });
    const nota = await notaDaVenda(TENANT, LOCATION, o.id);
    if (!nota) throw new Error('Fechamento não criou nota');
    return nota.id;
  }

  it('cifra credenciais e impede leitura/vínculo de outra barbearia', async () => {
    const s = await situacaoNfse(TENANT, LOCATION); expect(s.pronta).toBe(true);
    const rows = await withTenant(TENANT, tx => tx.$queryRaw<{ envelope_cipher: string }[]>`SELECT envelope_cipher FROM fiscal_certificates`);
    expect(rows[0]?.envelope_cipher.includes(cred.senha)).toBe(false);
    expect(JSON.stringify(s).includes(cred.senha)).toBe(false);
    expect(await withTenant(RIVAL, tx => tx.$queryRaw`SELECT * FROM fiscal_certificates`)).toEqual([]);
    await expect(salvarCertificadoNfse({ ...ator, tenantId: RIVAL, pfx: cred.pfx, senha: cred.senha })).rejects.toMatchObject({ code: 'nfse_ator_invalido' });
    await expect(withTenant(RIVAL, tx => tx.$executeRaw`
      INSERT INTO fiscal_native_settings (location_id, tenant_id, environment, series, national_service_code)
      VALUES (${LOCATION}::uuid, ${RIVAL}::uuid, 'homologacao', 1, '060101')
    `)).rejects.toThrow();
  });
  it('duas vendas concorrentes reservam números diferentes e o documento fica imutável', async () => {
    const ids = await Promise.all([vender(), vender()]);
    const docs = await Promise.all(ids.map(id => lerDocumentoNfse(TENANT, id)));
    expect(new Set(docs.map(d => d.dps_id)).size).toBe(2);
    expect(docs.map(d => snapshotDoDocumento(TENANT, d).numero).sort()).toEqual(['1', '2']);
    await expect(withTenant(TENANT, tx => tx.$executeRaw`UPDATE fiscal_native_documents SET snapshot_cipher = 'adulterado' WHERE invoice_id = ${ids[0]}::uuid`)).rejects.toThrow('imutavel');
    expect(await withTenant(RIVAL, tx => tx.$queryRaw`SELECT invoice_id FROM fiscal_native_documents`)).toEqual([]);
  });
  it('recupera resposta perdida em outro processo com a mesma DPS e uma única emissão', async () => {
    const id = await vender(); const a = autoridade(); a.perderEmissao();
    await expect(enviarNota({ tenantId: TENANT, invoiceId: id, provider: new EmissorNacionalNfse(a.transporte) })).rejects.toThrow('perdida');
    await admin.$executeRaw`UPDATE fiscal_settings SET service_code = '999999', municipal_registration = 'mudou' WHERE location_id = ${LOCATION}::uuid`;
    expect(await enviarNota({ tenantId: TENANT, invoiceId: id, provider: new EmissorNacionalNfse(a.transporte) })).toBe('autorizada');
    expect(a.requests.filter(r => r.metodo === 'POST' && r.caminho === '/nfse')).toHaveLength(1);
    const xml = await baixarXmlNfse({ tenantId: TENANT, locationId: LOCATION, invoiceId: id });
    expect(xml).toContain('<cTribNac>060101</cTribNac>'); expect(xml).not.toContain('mudou');
    await expect(baixarXmlNfse({ tenantId: TENANT, locationId: RIVAL, invoiceId: id })).rejects.toMatchObject({ code: 'nota_nao_encontrada' });
  });
  it('dois workers sobre a mesma nota não iniciam dois envios', async () => {
    const id = await vender(); const a = autoridade();
    let liberar!: () => void; let entrou!: () => void;
    const espera = new Promise<void>(resolve => { liberar = resolve; });
    const inicio = new Promise<void>(resolve => { entrou = resolve; });
    const transporte: TransporteNfse = async p => { if (p.metodo === 'POST') { entrou(); await espera; } return a.transporte(p); };
    const primeira = enviarNota({ tenantId: TENANT, invoiceId: id, provider: new EmissorNacionalNfse(transporte) });
    await inicio;
    try { expect(await enviarNota({ tenantId: TENANT, invoiceId: id, provider: new EmissorNacionalNfse(transporte) })).toBe('processando'); }
    finally { liberar(); }
    expect(await primeira).toBe('autorizada'); expect(a.requests.filter(r => r.metodo === 'POST')).toHaveLength(1);
  });
  it('falha da consulta não vira permissão para emitir e colisão prévia de série é recusada', async () => {
    const id = await vender(); const chamadas: PedidoHttpNfse[] = [];
    let resposta: RespostaHttpNfse = { status: 503, dados: {} };
    const transporte: TransporteNfse = async p => { chamadas.push(p); return resposta; };
    await expect(enviarNota({ tenantId: TENANT, invoiceId: id, provider: new EmissorNacionalNfse(transporte) })).rejects.toMatchObject({ code: 'nfse_consulta_falhou' });
    resposta = { status: 200, dados: { chaveAcesso: CHAVE_TESTE_NFSE } };
    expect(await enviarNota({ tenantId: TENANT, invoiceId: id, provider: new EmissorNacionalNfse(transporte) })).toBe('rejeitada');
    expect(chamadas.every(p => p.metodo === 'GET')).toBe(true);
  });
  it('cancelamento com resposta perdida é confirmado por consulta após reinício', async () => {
    const id = await vender(); const a = autoridade(); const provider = new EmissorNacionalNfse(a.transporte);
    await enviarNota({ tenantId: TENANT, invoiceId: id, provider }); a.perderCancelamento();
    await expect(cancelarNota({ ...ator, invoiceId: id, motivo: 'Servico nao foi prestado ao cliente', provider })).rejects.toThrow('perdida');
    expect(await conciliarNotas({ tenantId: TENANT, provider: new EmissorNacionalNfse(a.transporte) })).toBe(1);
    const nota = await withTenant(TENANT, tx => tx.$queryRaw<{ status: string }[]>`SELECT status::text FROM fiscal_invoices WHERE id = ${id}::uuid`);
    expect(nota[0]?.status).toBe('cancelada'); expect(a.requests.filter(r => r.metodo === 'POST' && r.caminho.endsWith('/eventos'))).toHaveLength(1);
  });
  it('recusa definitiva devolve nota a autorizada e permite novo motivo; timeout não faz isso', async () => {
    const id = await vender(); const a = autoridade(); const provider = new EmissorNacionalNfse(a.transporte);
    await enviarNota({ tenantId: TENANT, invoiceId: id, provider }); a.rejeitarCancelamento(true);
    await expect(cancelarNota({ ...ator, invoiceId: id, motivo: 'Motivo original da solicitacao', provider })).rejects.toMatchObject({ code: 'nfse_cancelamento_recusado' });
    expect(await conciliarNotas({ tenantId: TENANT, provider })).toBe(1);
    a.rejeitarCancelamento(false);
    await cancelarNota({ ...ator, invoiceId: id, motivo: 'Motivo corrigido para nova solicitacao', provider });
    expect((await lerDocumentoNfse(TENANT, id)).cancel_event_cipher).not.toBeNull();
  });
  it('motivo inválido é recusado antes de entrar em cancelamento', async () => {
    const id = await vender(); const a = autoridade(); const provider = new EmissorNacionalNfse(a.transporte);
    await enviarNota({ tenantId: TENANT, invoiceId: id, provider });
    await expect(cancelarNota({ ...ator, invoiceId: id, motivo: 'curto', provider })).rejects.toMatchObject({ code: 'nfse_motivo_invalido' });
    const rows = await withTenant(TENANT, tx => tx.$queryRaw<{ status: string }[]>`SELECT status::text FROM fiscal_invoices WHERE id = ${id}::uuid`);
    expect(rows[0]?.status).toBe('autorizada');
  });
  it('cancelamento pela API só grava intenção e o worker conclui usando o motivo persistido', async () => {
    const id = await vender(); const a = autoridade(); const provider = new EmissorNacionalNfse(a.transporte);
    await enviarNota({ tenantId: TENANT, invoiceId: id, provider });
    const antes = a.requests.length;
    await cancelarNota({ ...ator, invoiceId: id, motivo: 'Servico nao foi prestado ao cliente', provider, enfileirar: true });
    expect(a.requests).toHaveLength(antes);
    const jobs = await admin.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM jobs WHERE idempotency_key LIKE ${`fiscal-cancelar:${id}:%`}`;
    expect(jobs[0]?.n).toBe(1n);
    expect(await enviarNota({ tenantId: TENANT, invoiceId: id, provider: new EmissorNacionalNfse(a.transporte) })).toBe('cancelada');
  });
  it('PDF indisponível não desfaz autorização; download é retomado e o link não abre nota cancelada', async () => {
    vi.stubEnv('WEB_URL', 'https://barbearia.example');
    const id = await vender(); const a = autoridade(); const provider = new EmissorNacionalNfse(a.transporte);
    await enviarNota({ tenantId: TENANT, invoiceId: id, provider });
    const falha = await prepararPdfsNfse(TENANT, async () => { throw new Error('ADN indisponível'); });
    expect(falha).toEqual({ preparados: 0, falhas: 1 });
    const [erroPdf]=await withTenant(TENANT,tx=>tx.$queryRaw<{last_error_code:string}[]>`SELECT last_error_code FROM fiscal_native_documents WHERE invoice_id=${id}::uuid`);
    expect(erroPdf?.last_error_code).toBe('nfse_pdf_indisponivel');
    const pdf = Buffer.from('%PDF-1.4\nDocumento sintetico de teste\n%%EOF');
    expect(await prepararPdfsNfse(TENANT, async () => pdf)).toEqual({ preparados: 1, falhas: 0 });
    const notas = await withTenant(TENANT, tx => tx.$queryRaw<{ pdf_url: string; status: string }[]>`SELECT pdf_url, status::text FROM fiscal_invoices WHERE id = ${id}::uuid`);
    expect(notas[0]?.status).toBe('autorizada');
    const token = new URL(notas[0]?.pdf_url ?? '').pathname.split('/')[2] ?? '';
    expect((await pdfPeloLinkNfse(token)).equals(pdf)).toBe(true);
    const entregaTardia = new Date(Date.now() + 40 * 86400_000);
    expect(() => verificarTokenDoDocumento(token, entregaTardia)).toThrow();
    const pendentes = await notasAEntregar(TENANT, 50, entregaTardia);
    const novoToken = new URL(pendentes[0]?.linkPdf ?? '').pathname.split('/')[2] ?? '';
    expect(verificarTokenDoDocumento(novoToken, entregaTardia).invoiceId).toBe(id);
    await expect(pdfPeloLinkNfse(`x${token.slice(1)}`)).rejects.toMatchObject({ code: 'nfse_link_invalido' });
    await expect(baixarPdfNfse({ tenantId: RIVAL, locationId: LOCATION, invoiceId: id })).rejects.toMatchObject({ code: 'nfse_pdf_indisponivel' });
    await cancelarNota({ ...ator, invoiceId: id, motivo: 'Servico nao foi prestado ao cliente', provider });
    await expect(pdfPeloLinkNfse(token)).rejects.toMatchObject({ code: 'nfse_link_invalido' });
    expect((await baixarPdfNfse({ tenantId: TENANT, locationId: LOCATION, invoiceId: id })).equals(pdf)).toBe(true);
  });
});
