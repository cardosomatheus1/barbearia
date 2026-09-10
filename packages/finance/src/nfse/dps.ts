import { create } from 'xmlbuilder2';
import { NAMESPACE_NFSE } from './assinatura.js';
import { validarSchemaNfse } from './schema.js';

/** Primeiro perfil: serviços nacionais, MEI/SN, sem retenção ou benefício. */
export interface DadosDps {
  readonly ambiente: 'homologacao' | 'producao';
  readonly cnpj: string;
  readonly municipioEmissor: string;
  readonly inscricaoMunicipal?: string;
  readonly serie: number;
  /** String: os 15 dígitos fiscais não podem perder precisão em Number. */
  readonly numero: string;
  readonly emitidaEm: Date;
  readonly competencia: string;
  readonly regime: 'mei' | 'simples';
  readonly aliquotaTotalSimplesBps?: number;
  readonly municipioPrestacao: string;
  readonly codigoNacional: string;
  readonly codigoMunicipal?: string;
  readonly nbs?: string;
  readonly descricao: string;
  readonly servicoCents: number;
  readonly descontoIncondicionadoCents?: number;
  readonly tomador?: { readonly documento: string; readonly nome: string };
}

export function identificadorDps(d: Pick<DadosDps, 'municipioEmissor' | 'cnpj' | 'serie' | 'numero'>): string {
  if (!/^\d{7}$/.test(d.municipioEmissor) || !/^\d{14}$/.test(d.cnpj) || !/^[1-9]\d{0,14}$/.test(d.numero) ||
    !Number.isInteger(d.serie) || d.serie < 1 || d.serie > 49999) throw new Error('nfse_id_dps_invalido');
  return `DPS${d.municipioEmissor}2${d.cnpj}${String(d.serie).padStart(5, '0')}${d.numero.padStart(15, '0')}`;
}

function decimal(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('nfse_valor_invalido');
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

export function gerarDps(d: DadosDps): { id: string; xml: string } {
  if (!/^\d{14}$/.test(d.cnpj) || !/^\d{7}$/.test(d.municipioEmissor) ||
    !/^\d{7}$/.test(d.municipioPrestacao) || !/^[1-9]\d{0,14}$/.test(d.numero) ||
    !Number.isInteger(d.serie) || d.serie < 1 || d.serie > 49999 || // RN E0010: aplicativo próprio.
    !['mei', 'simples'].includes(d.regime) || !['homologacao', 'producao'].includes(d.ambiente) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(d.competencia) || !Number.isFinite(d.emitidaEm.getTime()) ||
    !/^\d{6}$/.test(d.codigoNacional) || !d.descricao.trim() || d.descricao.length > 2000 ||
    d.servicoCents <= 0) throw new Error('nfse_dps_dados_invalidos');
  if (d.regime === 'simples' && (d.aliquotaTotalSimplesBps === undefined ||
    !Number.isInteger(d.aliquotaTotalSimplesBps) || d.aliquotaTotalSimplesBps < 0 || d.aliquotaTotalSimplesBps > 9999)) {
    throw new Error('nfse_aliquota_total_simples_obrigatoria');
  }
  if (d.descontoIncondicionadoCents !== undefined && (!Number.isSafeInteger(d.descontoIncondicionadoCents) ||
    d.descontoIncondicionadoCents < 0 || d.descontoIncondicionadoCents > d.servicoCents)) throw new Error('nfse_desconto_invalido');
  const id = identificadorDps(d);
  const doc = create({ version: '1.0', encoding: 'UTF-8' }).ele('DPS', { xmlns: NAMESPACE_NFSE, versao: '1.01' });
  const inf = doc.ele('infDPS', { Id: id });
  inf.ele('tpAmb').txt(d.ambiente === 'producao' ? '1' : '2');
  inf.ele('dhEmi').txt(d.emitidaEm.toISOString().replace(/\.\d{3}Z$/, '+00:00'));
  inf.ele('verAplic').txt('Barberdock_1.0');
  inf.ele('serie').txt(String(d.serie)); inf.ele('nDPS').txt(d.numero);
  inf.ele('dCompet').txt(d.competencia); inf.ele('tpEmit').txt('1');
  inf.ele('cLocEmi').txt(d.municipioEmissor);
  const prest = inf.ele('prest'); prest.ele('CNPJ').txt(d.cnpj);
  if (d.inscricaoMunicipal) prest.ele('IM').txt(d.inscricaoMunicipal);
  const reg = prest.ele('regTrib'); reg.ele('opSimpNac').txt(d.regime === 'mei' ? '2' : '3');
  if (d.regime === 'simples') reg.ele('regApTribSN').txt('1');
  reg.ele('regEspTrib').txt('0');
  if (d.tomador) {
    if (!/^(?:\d{11}|\d{14})$/.test(d.tomador.documento)) throw new Error('nfse_tomador_invalido');
    const toma = inf.ele('toma');
    toma.ele(d.tomador.documento.length === 11 ? 'CPF' : 'CNPJ').txt(d.tomador.documento);
    toma.ele('xNome').txt(d.tomador.nome);
  }
  const serv = inf.ele('serv'); serv.ele('locPrest').ele('cLocPrestacao').txt(d.municipioPrestacao);
  const codigo = serv.ele('cServ'); codigo.ele('cTribNac').txt(d.codigoNacional);
  if (d.codigoMunicipal) codigo.ele('cTribMun').txt(d.codigoMunicipal);
  codigo.ele('xDescServ').txt(d.descricao);
  if (d.nbs) codigo.ele('cNBS').txt(d.nbs);
  const valores = inf.ele('valores'); valores.ele('vServPrest').ele('vServ').txt(decimal(d.servicoCents));
  if (d.descontoIncondicionadoCents) valores.ele('vDescCondIncond').ele('vDescIncond').txt(decimal(d.descontoIncondicionadoCents));
  const trib = valores.ele('trib'); const mun = trib.ele('tribMun');
  mun.ele('tribISSQN').txt('1'); mun.ele('tpRetISSQN').txt('1');
  // RN E0625/E0631: SN com ISS pelo DAS e sem retenção não informa pAliq.
  const total = trib.ele('totTrib');
  if (d.regime === 'mei') total.ele('indTotTrib').txt('0');
  else total.ele('pTotTribSN').txt(decimal(d.aliquotaTotalSimplesBps!));
  const xml = doc.end({ prettyPrint: false });
  validarSchemaNfse(xml, 'DPS');
  return { id, xml };
}
