import { CNPJ_NORMALIZADO } from '@barbearia/core';
import { CHAVE_NFSE } from './identificadores.js';
import { create } from 'xmlbuilder2';
import { NAMESPACE_NFSE } from './assinatura.js';
import { validarSchemaNfse } from './schema.js';
import type { AmbienteNfse } from './transporte.js';

export function gerarPedidoDeCancelamento(p: {
  readonly ambiente: AmbienteNfse; readonly cnpj: string; readonly chave: string;
  readonly motivo: string; readonly quando: Date;
}): { id: string; xml: string } {
  if (!CNPJ_NORMALIZADO.test(p.cnpj) || !CHAVE_NFSE.test(p.chave) || p.motivo.trim().length < 15 || p.motivo.trim().length > 255 ||
    !['producao', 'homologacao'].includes(p.ambiente) || !Number.isFinite(p.quando.getTime())) throw new Error('nfse_cancelamento_invalido');
  const id = `PRE${p.chave}101101`;
  const doc = create({ version: '1.0', encoding: 'UTF-8' }).ele('pedRegEvento', { xmlns: NAMESPACE_NFSE, versao: '1.01' });
  const inf = doc.ele('infPedReg', { Id: id });
  inf.ele('tpAmb').txt(p.ambiente === 'producao' ? '1' : '2');
  inf.ele('verAplic').txt('Barberdock_1.0');
  inf.ele('dhEvento').txt(p.quando.toISOString().replace(/\.\d{3}Z$/, '+00:00'));
  inf.ele('CNPJAutor').txt(p.cnpj); inf.ele('chNFSe').txt(p.chave);
  const e = inf.ele('e101101'); e.ele('xDesc').txt('Cancelamento de NFS-e');
  e.ele('cMotivo').txt('9'); e.ele('xMotivo').txt(p.motivo.trim());
  const xml = doc.end({ prettyPrint: false });
  validarSchemaNfse(xml, 'pedRegEvento');
  return { id, xml };
}
