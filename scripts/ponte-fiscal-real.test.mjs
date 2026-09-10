import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { executarMotorMunicipal } from '../packages/finance/src/nfse-municipal/ponte.ts';
import { certificadoNfseSintetico } from '../packages/finance/test/nfse-fixtures.ts';

// Somente preparar: este teste nunca solicita uma operação de rede.
process.env.FISCAL_MUNICIPAL_BIN ??= resolve('integrations/fiscal-municipal/publish/Barbearia.FiscalMunicipal');
const { certificado } = certificadoNfseSintetico();
const pedido = {
  operacao: 'preparar', ambiente: 'producao', municipio: 3550308, cnpj: certificado.cnpj,
  inscricaoMunicipal: '12345678', razaoSocial: 'Barbearia sintética', regime: 'simples',
  serie: 'A', numeroRps: 1, emitidaEm: '2026-09-10T10:00:00-03:00', competencia: '2026-09-10',
  descricao: 'Corte & barba', servicoCents: 12345, descontoCents: 0, aliquotaIssBps: 200,
  itemListaServico: '6.01', codigoMunicipal: '2658', cnae: '9602501', nbs: null, layoutSaoPaulo: 1,
  enderecoPrestador: { logradouro: 'Rua teste', numero: '1', bairro: 'Centro', cep: '01001000',
    municipio: 3550308, nomeMunicipio: 'São Paulo', uf: 'SP' },
  tomador: { documento: '13167474254', nome: 'Cliente de teste' },
  certificadoPem: certificado.cadeiaPem, chavePem: certificado.chavePem,
};

test('Node entrega o pedido por stdin e recebe o lote assinado do executável publicado', async () => {
  const resposta = await executarMotorMunicipal(pedido);
  assert.equal(resposta.sucesso, true);
  assert.equal(resposta.erro, null);
  assert.ok(resposta.requisicao);
  assert.match(resposta.xmlEnvio, /<ValorServicos>123.45<\/ValorServicos>/);
  assert.match(Buffer.from(resposta.requisicao.corpoBase64, 'base64').toString('utf8'), /EnvioLoteRPSRequest/);
  assert.doesNotMatch(JSON.stringify(resposta), /PRIVATE KEY/);
});

test('CLI recusa perfil não suportado sem devolver dados de certificado na exceção', async () => {
  await assert.rejects(executarMotorMunicipal({ ...pedido, descontoCents: 100 }), erro => {
    assert.equal(erro.code, 'nfse_municipal_processamento_falhou');
    assert.doesNotMatch(erro.message, /PRIVATE KEY|Corte|12345678/);
    return true;
  });
});
