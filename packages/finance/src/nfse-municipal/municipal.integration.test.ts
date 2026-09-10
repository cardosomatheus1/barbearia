import { PrismaClient } from '@prisma/client';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTenant } from '@barbearia/db';
import { abrirCaixa } from '../caixa.js';
import { abrirComanda, adicionarItem, ajustarComanda, fecharComanda } from '../comanda.js';
import { salvarConfiguracaoFiscal } from '../fiscal-configuracao.js';
import { notaDaVenda, notasDoPeriodo, pedirNota } from '../fiscal-notas.js';
import { cancelarNota, enviarNota } from '../fiscal-emissao.js';
import { salvarCertificadoNfse } from '../nfse/configuracao.js';
import { decifrarFiscal } from '../nfse/cofre.js';
import { salvarConfiguracaoMunicipal, situacaoMunicipal } from './configuracao.js';
import { baixarXmlMunicipal, lerDocumentoMunicipal, snapshotMunicipal, escopoMunicipal } from './documentos.js';
import { EmissorMunicipalNfse } from './emissor.js';
import { EmissorProprioNfse } from './roteador.js';
import { baixarPdfMunicipal } from './pdf.js';
import type { ConfiguracaoMunicipal, NotaMunicipal, PedidoMunicipal, ResultadoMunicipal } from './contrato.js';
import type { MotorMunicipal } from './ponte.js';
import { CNPJ_TESTE_NFSE } from '../../test/nfse-fixtures.js';
import { confiancaA1Sintetica } from '../../test/nfse-confianca-fixture.js';

const SEED_URL = process.env['SEED_DATABASE_URL'];
const describeDb = SEED_URL && process.env['APP_DATABASE_URL'] ? describe : describe.skip;
const TENANT = '63111111-1111-1111-1111-111111111111';
const RIVAL = '63222222-2222-2222-2222-222222222222';
const LOCATION = '63111111-0000-0000-0000-000000000001';
const STAFF = '63111111-0000-0000-0000-000000000002';
const SERVICE = '63111111-0000-0000-0000-000000000003';
const PROFESSIONAL = '63111111-0000-0000-0000-000000000004';
const CUSTOMER = '63111111-0000-0000-0000-000000000005';
const ator = { tenantId: TENANT, locationId: LOCATION, staffId: STAFF, staffName: 'Operadora sintetica' };
let admin: PrismaClient; let cred: ReturnType<typeof confiancaA1Sintetica>;
const config: ConfiguracaoMunicipal = {
  ambiente: 'producao', serie: 'TESTE', numeroInicial: 51, serieExclusiva: true,
  itemListaServico: '6.01', codigoMunicipal: '2658', codigoCancelamento: '1', cnae: '9602501', nbs: null,
  razaoSocial: 'Barbearia sintética', layoutSaoPaulo: 1, habilitada: true,
  enderecoPrestador: { logradouro: 'Rua sintética', numero: '1', bairro: 'Centro', cep: '01001000',
    municipio: 3550308, nomeMunicipio: 'São Paulo', uf: 'SP' },
};
const respostaVazia = (): ResultadoMunicipal => ({ sucesso: true, erro: null, codigos: [], xmlEnvio: '', xmlRetorno: '<retorno/>', protocolo: null, lote: null, notas: [] });
function prefeitura() {
  let nota: NotaMunicipal | undefined;
  const chamadas: PedidoMunicipal[] = [];
  const falhas = { perderEmissao: false, perderCancelamento: false, recusarEmissao: false, recusarCancelamento: false };
  const motor: MotorMunicipal = async p => {
    chamadas.push(p);
    const r = respostaVazia();
    if (p.operacao === 'preparar' || p.operacao === 'preparar_cancelamento') return { ...r, xmlEnvio: '<pedido-assinado/>',
      requisicao: { url: 'https://nfews.prefeitura.sp.gov.br/ws/lotenfe.asmx', metodo: 'POST',
        corpoBase64: Buffer.from(`<pedido operacao="${p.operacao}" motivo="${p.motivoCancelamento ?? ''}"/>`).toString('base64'), cabecalhos: {}, cabecalhosConteudo: {} } };
    if (p.operacao === 'emitir') {
      expect(p.requisicao).toBeTruthy();
      if (falhas.recusarEmissao) return { ...r, sucesso: false, codigos: ['100'] };
      nota = { numero: '101', verificacao: 'ABC123', xml: '<NFe numero="101"/>', rps: String(p.numeroRps), serie: p.serie,
        cnpj: p.cnpj, inscricaoMunicipal: p.inscricaoMunicipal, servicoCents: p.servicoCents,
        descontoCents: p.descontoCents, dataEmissao: p.emitidaEm.slice(0, 10), competencia: p.competencia,
        documentoTomador: p.tomador?.documento ?? '', situacao: 'autorizada' };
      if (falhas.perderEmissao) return { ...r, sucesso: false, erro: 'nfse_municipal_confirmacao_pendente', codigos: [] };
      return { ...r, protocolo: 'lote-51', lote: 51 };
    }
    if (p.operacao === 'cancelar') {
      if (falhas.recusarCancelamento) return { ...r, sucesso: false, codigos: ['200'] };
      if (!nota) throw new Error('nota ausente');
      nota = { ...nota, situacao: 'cancelada', xml: '<NFe numero="101" cancelada="true"/>' };
      if (falhas.perderCancelamento) throw new Error('timeout sintético');
      return r;
    }
    return { ...r, notas: nota ? [nota] : [] };
  };
  return { motor, chamadas, falhas, alterarNota: (valores: Partial<NotaMunicipal>) => { if (!nota) throw new Error('nota ausente'); nota = { ...nota, ...valores }; } };
}

describeDb('NFS-e municipal reutilizada: persistência, conciliação e isolamento', () => {
  beforeAll(() => {
    if (!SEED_URL) throw new Error('Banco isolado obrigatório');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
    cred = confiancaA1Sintetica();
  }, 30000);
  afterAll(async () => { cred?.limpar(); await admin?.$disconnect(); });
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(async () => {
    vi.stubEnv('FISCAL_MODO', 'nacional'); vi.stubEnv('FISCAL_SECRET_KEY', Buffer.alloc(32, 21).toString('base64'));
    vi.stubEnv('FISCAL_AUTORIDADES_PEM_B64', Buffer.from(cred.certificado.certificadoPem).toString('base64'));
    vi.stubEnv('FISCAL_CONFIANCA_DIR', cred.pasta); cred.atualizarCrls();
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
    vi.stubEnv('FISCAL_MUNICIPAL_BIN', '/bin/true');
    await salvarConfiguracaoFiscal({ ...ator, inscricaoMunicipal: '12345678', config: { cnpj: CNPJ_TESTE_NFSE, regime: 'simples', codigoDeServico: '060101',
      issBps: 200, municipioIbge: '3550308', emitirAutomaticamente: true } });
    await salvarCertificadoNfse({ ...ator, pfx: cred.pfx, senha: cred.senha });
    await salvarConfiguracaoMunicipal({ ...ator, config, credenciais: { usuario: 'cadastro-sintetico', senha: 'segredo-sintetico' } });
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

  it('numeração, credenciais cifradas e RLS preservam unidade e tenant', async () => {
    expect((await situacaoMunicipal(TENANT, LOCATION)).pronta).toBe(true);
    const id = await vender();
    const doc = await lerDocumentoMunicipal(TENANT, id);
    expect(snapshotMunicipal(TENANT, doc).numeroRps).toBe(51);
    expect(snapshotMunicipal(TENANT, await lerDocumentoMunicipal(TENANT, await vender())).numeroRps).toBe(52);
    expect(await withTenant(RIVAL, tx => tx.$queryRaw`SELECT * FROM fiscal_municipal_documents`)).toEqual([]);
    expect(await withTenant(RIVAL, tx => tx.$queryRaw`SELECT * FROM fiscal_rps_counters`)).toEqual([]);
    expect(await withTenant(RIVAL, tx => tx.$queryRaw`SELECT * FROM fiscal_municipal_settings`)).toEqual([]);
    const segredos = await withTenant(TENANT, tx => tx.$queryRaw<{ credentials_cipher: string }[]>`SELECT credentials_cipher FROM fiscal_municipal_settings`);
    expect(segredos[0]?.credentials_cipher).not.toContain('segredo-sintetico');
    await expect(salvarConfiguracaoMunicipal({ ...ator, config: { ...config, numeroInicial: 2 } })).rejects.toThrow('número inicial');
    await expect(withTenant(TENANT, tx => tx.$executeRaw`UPDATE fiscal_municipal_documents SET snapshot_cipher = 'alterado' WHERE invoice_id = ${id}::uuid`)).rejects.toThrow('imutavel');
  });

  it('lote aceito aguarda XML; pedido e primeira resposta permanecem imutáveis', async () => {
    const id = await vender(); const a = prefeitura(); const provider = new EmissorMunicipalNfse(a.motor);
    expect(await enviarNota({ tenantId: TENANT, invoiceId: id, provider })).toBe('processando');
    const antes = await lerDocumentoMunicipal(TENANT, id);
    expect(JSON.parse(decifrarFiscal(antes.request_cipher!, escopoMunicipal(TENANT, antes, 'pedido')))).toEqual(a.chamadas.find(p => p.operacao === 'emitir')?.requisicao);
    expect(await enviarNota({ tenantId: TENANT, invoiceId: id, provider })).toBe('autorizada');
    const depois = await lerDocumentoMunicipal(TENANT, id);
    expect(depois.request_cipher).toBe(antes.request_cipher);
    expect(depois.initial_response_cipher).toBe(antes.initial_response_cipher);
    expect(await baixarXmlMunicipal({ tenantId: TENANT, locationId: LOCATION, invoiceId: id })).toContain('101');
    await expect(baixarXmlMunicipal({ tenantId: RIVAL, locationId: LOCATION, invoiceId: id })).rejects.toThrow();
    for (const coluna of ['request_cipher', 'initial_response_cipher', 'nfse_cipher']) {
      await expect(withTenant(TENANT, tx => tx.$executeRawUnsafe(`UPDATE fiscal_municipal_documents SET ${coluna} = 'alterado' WHERE invoice_id = $1::uuid`, id))).rejects.toThrow('imutavel');
    }
    await expect(withTenant(TENANT, tx => tx.$executeRaw`UPDATE fiscal_municipal_exchanges SET payload_cipher = 'alterado'`)).rejects.toThrow();
    expect(await withTenant(RIVAL, tx => tx.$queryRaw`SELECT * FROM fiscal_municipal_exchanges`)).toEqual([]);
  });

  it('timeout após emissão concilia sem enviar outro RPS e não libera a venda', async () => {
    const id = await vender(); const a = prefeitura(); a.falhas.perderEmissao = true;
    const provider = new EmissorMunicipalNfse(a.motor);
    await expect(enviarNota({ tenantId: TENANT, invoiceId: id, provider })).rejects.toThrow();
    expect((await lerDocumentoMunicipal(TENANT, id)).rejection_codes).toBeNull();
    expect(await enviarNota({ tenantId: TENANT, invoiceId: id, provider })).toBe('autorizada');
    expect(a.chamadas.filter(p => p.operacao === 'emitir')).toHaveLength(1);
  });

  it('recusa fiscal arquivada é recuperável sem novo envio nem consulta', async () => {
    const id = await vender(); const a = prefeitura(); a.falhas.recusarEmissao = true;
    const provider = new EmissorMunicipalNfse(a.motor);
    expect(await enviarNota({ tenantId: TENANT, invoiceId: id, provider })).toBe('rejeitada');
    const chamadas = a.chamadas.length;
    expect((await provider.consultar(`nfse-municipal:${TENANT}:${id}`)).estado).toBe('rejeitada');
    expect(a.chamadas).toHaveLength(chamadas);
  });

  it.each([{ servicoCents: 1 }, { documentoTomador: '00000000000' }, { dataEmissao: '2020-01-01' }, { cnpj: '99887766000199' }, { inscricaoMunicipal: '87654321' }, { descontoCents: 1 }])('não aceita nota divergente: %j', async divergencia => {
    const id = await vender(); const a = prefeitura(); const provider = new EmissorMunicipalNfse(a.motor);
    await enviarNota({ tenantId: TENANT, invoiceId: id, provider }); a.alterarNota(divergencia);
    await expect(enviarNota({ tenantId: TENANT, invoiceId: id, provider })).rejects.toThrow('não corresponde');
    expect((await lerDocumentoMunicipal(TENANT, id)).nfse_cipher).toBeNull();
    expect(a.chamadas.filter(p => p.operacao === 'emitir')).toHaveLength(1);
  });

  it('cancelamento perdido é consultado e nunca reenviado', async () => {
    const id = await vender(); const a = prefeitura(); const provider = new EmissorMunicipalNfse(a.motor);
    await enviarNota({ tenantId: TENANT, invoiceId: id, provider });
    await enviarNota({ tenantId: TENANT, invoiceId: id, provider });
    a.falhas.perderCancelamento = true;
    await expect(cancelarNota({ ...ator, invoiceId: id, provider, motivo: 'Serviço não foi realizado pelo profissional' })).rejects.toThrow();
    expect(await enviarNota({ tenantId: TENANT, invoiceId: id, provider })).toBe('cancelada');
    expect(a.chamadas.filter(p => p.operacao === 'cancelar')).toHaveLength(1);
  });

  it('São Paulo reconhece a mesma inscrição municipal preenchida com zeros pelo layout', async () => {
    await salvarConfiguracaoFiscal({ ...ator, inscricaoMunicipal: '123456', config: { cnpj: CNPJ_TESTE_NFSE,
      regime: 'simples', codigoDeServico: '060101', issBps: 200, municipioIbge: '3550308', emitirAutomaticamente: true } });
    const id = await vender(); const a = prefeitura(); const provider = new EmissorMunicipalNfse(a.motor);
    await enviarNota({ tenantId: TENANT, invoiceId: id, provider });
    a.alterarNota({ inscricaoMunicipal: '00123456' });
    expect(await enviarNota({ tenantId: TENANT, invoiceId: id, provider })).toBe('autorizada');
  });

  it('recusa do cancelamento permite nova ação com motivo corrigido e preserva histórico', async () => {
    const id = await vender(); const a = prefeitura(); const provider = new EmissorMunicipalNfse(a.motor);
    await enviarNota({ tenantId: TENANT, invoiceId: id, provider });
    await enviarNota({ tenantId: TENANT, invoiceId: id, provider });
    a.falhas.recusarCancelamento = true;
    await expect(cancelarNota({ ...ator, invoiceId: id, provider, motivo: 'Primeiro motivo incorreto da operação' })).rejects.toThrow();
    expect(await enviarNota({ tenantId: TENANT, invoiceId: id, provider })).toBe('autorizada');
    a.falhas.recusarCancelamento = false;
    await cancelarNota({ ...ator, invoiceId: id, provider, motivo: 'Motivo corrigido solicitado pelo contador' });
    expect(a.chamadas.filter(p => p.operacao === 'cancelar').map(p => p.motivoCancelamento)).toEqual([
      'Primeiro motivo incorreto da operação', 'Motivo corrigido solicitado pelo contador']);
    expect(await withTenant(TENANT, tx => tx.$queryRaw`SELECT id FROM fiscal_municipal_exchanges WHERE operation = 'preparar_cancelamento'`)).toHaveLength(2);
  });

  it('lease permanece tomado durante o cancelamento assíncrono', async () => {
    const id = await vender(); const a = prefeitura();
    let soltar!: () => void; const trava = new Promise<void>(resolve => { soltar = resolve; });
    let entrou!: () => void; const iniciou = new Promise<void>(resolve => { entrou = resolve; });
    const provider = new EmissorMunicipalNfse(async p => {
      if (p.operacao === 'cancelar') { entrou(); await trava; }
      return a.motor(p);
    });
    await enviarNota({ tenantId: TENANT, invoiceId: id, provider });
    await enviarNota({ tenantId: TENANT, invoiceId: id, provider });
    const primeira = cancelarNota({ ...ator, invoiceId: id, provider, motivo: 'Serviço não foi realizado pelo profissional' });
    await iniciou;
    try {
      expect((await provider.consultar(`nfse-municipal:${TENANT}:${id}`)).estado).toBe('cancelando');
      const lease = await withTenant(TENANT, tx => tx.$queryRaw<{ lease_token: string | null }[]>`SELECT lease_token FROM fiscal_municipal_documents WHERE invoice_id = ${id}::uuid`);
      expect(lease[0]?.lease_token).not.toBeNull();
    } finally { soltar(); await primeira; }
    expect(a.chamadas.filter(p => p.operacao === 'cancelar')).toHaveLength(1);
  });

  it('consulta de RPS preexistente impede transmissão e permite corrigir cadastro', async () => {
    const id = await vender(); const a = prefeitura(); const chamadas: string[] = [];
    const provider = new EmissorMunicipalNfse(async p => {
      chamadas.push(p.operacao);
      if (p.operacao === 'consultar') {
        await a.motor({ ...p, operacao: 'emitir', requisicao: { url: 'https://example.invalid', metodo: 'POST', corpoBase64: '', cabecalhos: {}, cabecalhosConteudo: {} } });
      }
      return a.motor(p);
    });
    expect(await enviarNota({ tenantId: TENANT, invoiceId: id, provider })).toBe('rejeitada');
    expect(chamadas).toEqual(['consultar']);
    expect((await lerDocumentoMunicipal(TENANT, id)).attempt_at).toBeNull();
  });

  it('preparação inválida recusa localmente antes de transmitir', async () => {
    const id = await vender(); const chamadas: string[] = [];
    const provider = new EmissorMunicipalNfse(async p => {
      chamadas.push(p.operacao);
      if (p.operacao === 'preparar') throw new Error('perfil não disponível');
      return respostaVazia();
    });
    expect(await enviarNota({ tenantId: TENANT, invoiceId: id, provider })).toBe('rejeitada');
    expect(chamadas).toEqual(['consultar', 'preparar']);
    expect((await lerDocumentoMunicipal(TENANT, id)).attempt_at).toBeNull();
  });

  it('concorrência de emissão transmite somente uma vez', async () => {
    const id = await vender(); const a = prefeitura();
    let soltar!: () => void; const trava = new Promise<void>(resolve => { soltar = resolve; });
    let entrou!: () => void; const iniciou = new Promise<void>(resolve => { entrou = resolve; });
    const provider = new EmissorMunicipalNfse(async p => {
      if (p.operacao === 'emitir') { entrou(); await trava; }
      return a.motor(p);
    });
    const primeira = enviarNota({ tenantId: TENANT, invoiceId: id, provider });
    await iniciou;
    try { expect((await provider.consultar(`nfse-municipal:${TENANT}:${id}`)).estado).toBe('processando'); }
    finally { soltar(); await primeira; }
    expect(a.chamadas.filter(p => p.operacao === 'emitir')).toHaveLength(1);
  });

  it('roteador usa emissor do documento após mudar a unidade para nacional', async () => {
    const id = await vender(); const a = prefeitura(); const municipal = new EmissorMunicipalNfse(a.motor);
    const nacional = { emitir: vi.fn(), consultar: vi.fn(), cancelar: vi.fn() };
    await withTenant(TENANT, tx => tx.$executeRaw`UPDATE fiscal_settings SET native_emitter = 'nacional' WHERE location_id = ${LOCATION}::uuid`);
    const provider = new EmissorProprioNfse(nacional, municipal);
    await enviarNota({ tenantId: TENANT, invoiceId: id, provider });
    expect(nacional.emitir).not.toHaveBeenCalled();
    expect(await enviarNota({ tenantId: TENANT, invoiceId: id, provider })).toBe('autorizada');
    expect(nacional.consultar).not.toHaveBeenCalled();
  });

  it('desconto em São Paulo preserva o pagamento e orienta emissão no portal', async () => {
    const venda = await abrirComanda({ ...ator, customerId: CUSTOMER });
    await adicionarItem({ ...ator, orderId: venda.id, tipo: 'service', descricao: 'Corte', serviceId: SERVICE,
      professionalId: PROFESSIONAL, quantidade: 1, precoUnitarioCents: 5000 });
    await ajustarComanda({ ...ator, orderId: venda.id, desconto: { tipo: 'amount', valor: 100, motivo: 'Cortesia' } });
    await fecharComanda({ ...ator, orderId: venda.id, hojeNaUnidade: '2026-09-09', pagamentos: [{ forma: 'cash', valorCents: 4900 }] });
    expect(await withTenant(TENANT, tx => tx.$queryRaw`SELECT status::text, total_cents FROM orders WHERE id = ${venda.id}::uuid`))
      .toEqual([{ status: 'paid', total_cents: 4900 }]);
    expect(await notaDaVenda(TENANT, LOCATION, venda.id)).toBeNull();
    await expect(withTenant(TENANT, tx => pedirNota(tx, { ...ator, orderId: venda.id, automatica: false })))
      .rejects.toThrow('portal da prefeitura');
  });

  it('cancelamento mantém XML original, PDF identificado e histórico isolado', async () => {
    const id = await vender(); const a = prefeitura(); const provider = new EmissorMunicipalNfse(a.motor);
    const pedido = { tenantId: TENANT, locationId: LOCATION, invoiceId: id };
    await expect(baixarPdfMunicipal(pedido)).rejects.toThrow('ainda não foi autorizada');
    await enviarNota({ tenantId: TENANT, invoiceId: id, provider });
    await enviarNota({ tenantId: TENANT, invoiceId: id, provider });
    const xml = await baixarXmlMunicipal(pedido);
    await cancelarNota({ ...ator, invoiceId: id, provider, motivo: 'Serviço não foi realizado pelo profissional' });
    expect(await baixarXmlMunicipal(pedido)).toBe(xml);
    const documento = await getDocument({ data: new Uint8Array(await baixarPdfMunicipal(pedido)), useSystemFonts: true }).promise;
    try {
      const pagina = await documento.getPage(1);
      const texto = (await pagina.getTextContent()).items.map(item => 'str' in item ? item.str : '').join(' ');
      expect(texto).toContain('NOTA CANCELADA');
      expect(texto).toContain('Representação auxiliar da NFS-e municipal');
      expect(texto).toContain('101');
      expect(texto).toContain('12345678');
    } finally { await documento.destroy(); }
    const consulta = { tenantId: TENANT, locationId: LOCATION, de: '2026-01-01', ate: '2026-12-31', podeVerCliente: true };
    expect(await notasDoPeriodo(consulta)).toEqual([expect.objectContaining({ id, estado: 'cancelada', xmlDisponivel: true })]);
    expect(await notasDoPeriodo({ ...consulta, tenantId: RIVAL })).toEqual([]);
    await expect(baixarPdfMunicipal({ ...pedido, tenantId: RIVAL })).rejects.toThrow();
    await expect(baixarPdfMunicipal({ ...pedido, locationId: RIVAL })).rejects.toThrow();
  });
});
