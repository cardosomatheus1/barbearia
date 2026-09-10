import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { certificadoNfseSintetico, nfseSintetica, eventoNfseSintetico, CHAVE_TESTE_NFSE, CNPJ_TESTE_NFSE } from '../../test/nfse-fixtures.js';
import { gerarDps } from './dps.js';
import { assinarDps, assinarPedidoDeCancelamento } from './assinatura.js';
import { gerarPedidoDeCancelamento } from './cancelamento.js';
import { compactarXmlFiscal } from './xml-seguro.js';
import { lerNotaAutorizada, lerCancelamentoConfirmado } from './respostas.js';
import { cifrarFiscal, decifrarFiscal } from './cofre.js';
import { conferirMunicipioNfse } from './capacidade.js';
import { httpNfse } from './transporte.js';
import { tokenDoDocumento, verificarTokenDoDocumento } from './link.js';

let cred: ReturnType<typeof certificadoNfseSintetico>;
const dados = { ambiente: 'homologacao' as const, cnpj: CNPJ_TESTE_NFSE, municipioEmissor: '3550308', municipioPrestacao: '3550308',
  regime: 'mei' as const, serie: 1, numero: '1', emitidaEm: new Date('2026-09-10T01:00:00Z'), competencia: '2026-09-09',
  codigoNacional: '060101', descricao: 'Corte sintetico', servicoCents: 5000 };
beforeAll(() => { cred = certificadoNfseSintetico(); });
afterEach(() => vi.unstubAllEnvs());

describe('contratos locais da NFS-e nacional', () => {
  it('aceita XML autorizado com a DPS exata e recusa substituição de tomador, valor ou chave', () => {
    const dps = gerarDps(dados); const assinado = assinarDps(dps.xml, cred.certificado, dps.id, 'sha1');
    const xml = nfseSintetica(assinado, cred.certificado);
    const r = { chaveAcesso: CHAVE_TESTE_NFSE, nfseXmlGZipB64: compactarXmlFiscal(xml) };
    expect(lerNotaAutorizada(r, assinado)).toMatchObject({ chave: CHAVE_TESTE_NFSE, numero: '12' });
    expect(() => lerNotaAutorizada(r, assinado.replace('<vServ>50.00</vServ>', '<vServ>90.00</vServ>'))).toThrow('não corresponde');
    expect(() => lerNotaAutorizada({ ...r, chaveAcesso: '9'.repeat(50) }, assinado)).toThrow('não corresponde');
  });
  it('gera cancelamento 1.01 e exige confirmação vinculada à mesma nota e ambiente', () => {
    const pedido = gerarPedidoDeCancelamento({ ambiente: 'homologacao', cnpj: CNPJ_TESTE_NFSE, chave: CHAVE_TESTE_NFSE,
      motivo: 'Servico nao foi prestado ao cliente', quando: dados.emitidaEm });
    const assinado = assinarPedidoDeCancelamento(pedido.xml, cred.certificado, pedido.id, 'sha1');
    const r = { eventoXmlGZipB64: compactarXmlFiscal(eventoNfseSintetico(assinado, cred.certificado)) };
    expect(lerCancelamentoConfirmado(r, CHAVE_TESTE_NFSE, 'homologacao')).toContain('e101101');
    expect(() => lerCancelamentoConfirmado(r, CHAVE_TESTE_NFSE, 'producao')).toThrow('não corresponde');
    expect(() => gerarPedidoDeCancelamento({ ambiente: 'homologacao', cnpj: CNPJ_TESTE_NFSE, chave: CHAVE_TESTE_NFSE,
      motivo: 'curto', quando: dados.emitidaEm })).toThrow('nfse_cancelamento_invalido');
  });
  it('cifra com nonce aleatório e autentica também tenant, unidade e finalidade', () => {
    vi.stubEnv('FISCAL_SECRET_KEY', Buffer.alloc(32, 17).toString('base64'));
    const a = cifrarFiscal('material-sintetico', 'tenant:unidade:a1');
    expect(cifrarFiscal('material-sintetico', 'tenant:unidade:a1')).not.toBe(a);
    expect(decifrarFiscal(a, 'tenant:unidade:a1')).toBe('material-sintetico');
    expect(() => decifrarFiscal(a, 'vizinha:unidade:a1')).toThrow('nfse_cofre_invalido');
    expect(() => decifrarFiscal(a, 'tenant:unidade:xml')).toThrow('nfse_cofre_invalido');
    vi.stubEnv('FISCAL_SECRET_KEY', ''); expect(() => cifrarFiscal('x', 'y')).toThrow('FISCAL_SECRET_KEY');
  });
  it('MEI usa a exceção nacional; Simples exige confirmação do emissor municipal habilitado', async () => {
    const transporte = vi.fn().mockResolvedValue({ status: 200, dados: { parametrosConvenio: { aderenteAmbienteNacional: 1, aderenteEmissorNacional: 0 } } });
    await conferirMunicipioNfse(dados, cred.certificado, transporte); expect(transporte).not.toHaveBeenCalled();
    await expect(conferirMunicipioNfse({ ...dados, regime: 'simples' }, cred.certificado, transporte)).rejects.toMatchObject({ code: 'nfse_municipio_sem_emissor_nacional' });
    transporte.mockResolvedValue({ status: 200, dados: {} });
    await expect(conferirMunicipioNfse({ ...dados, regime: 'simples' }, cred.certificado, transporte)).rejects.toMatchObject({ code: 'nfse_municipio_nao_verificado' });
    transporte.mockResolvedValue({ status: 200, dados: { parametrosConvenio: { aderenteAmbienteNacional: 1, aderenteEmissorNacional: 1 } } });
    await expect(conferirMunicipioNfse({ ...dados, regime: 'simples' }, cred.certificado, transporte)).resolves.toBeUndefined();
  });
  it('destinos e caminhos arbitrários são recusados antes de qualquer conexão', async () => {
    const enviar = vi.fn();
    await expect(httpNfse({ ambiente: 'homologacao', certificado: cred.certificado, metodo: 'GET', caminho: '//outro.host/segredo' }, enviar)).rejects.toMatchObject({ code: 'nfse_destino_invalido' });
    expect(enviar).not.toHaveBeenCalled();
  });
  it('link de documento expira e a troca de unidade invalida a assinatura', () => {
    vi.stubEnv('FISCAL_SECRET_KEY', Buffer.alloc(32, 17).toString('base64'));
    const p = { tenantId: '11111111-1111-1111-1111-111111111111', locationId: '22222222-2222-2222-2222-222222222222',
      invoiceId: '33333333-3333-3333-3333-333333333333' };
    const quando = new Date('2026-09-10T01:00:00Z');
    const token = tokenDoDocumento(p, quando);
    expect(verificarTokenDoDocumento(token, quando)).toMatchObject(p);
    const [payload, mac] = token.split('.');
    const dados = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()); dados.locationId = p.invoiceId;
    const adulterado = `${Buffer.from(JSON.stringify(dados)).toString('base64url')}.${mac}`;
    expect(() => verificarTokenDoDocumento(adulterado, quando)).toThrow('expirou');
    expect(() => verificarTokenDoDocumento(token, new Date('2026-10-11T01:00:00Z'))).toThrow('expirou');
  });
});
