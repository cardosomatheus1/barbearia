import { describe, expect, it } from 'vitest';
import { gerarDps, type DadosDps } from './dps.js';
import { validarSchemaNfse } from './schema.js';

const base: DadosDps = { ambiente: 'homologacao', cnpj: '12345678000195', municipioEmissor: '3550308',
  municipioPrestacao: '3550308', serie: 1, numero: '999999999999999',
  emitidaEm: new Date('2026-09-09T23:30:00-03:00'), competencia: '2026-09-09',
  regime: 'mei', codigoNacional: '060101', descricao: 'Corte & barba <completo>', servicoCents: 4901 };

describe('DPS 1.01 contra XSD oficial de julho/2026', () => {
  it.each(['mei', 'simples'] as const)('gera documento válido para %s sem alterar competência ou número de 15 dígitos', regime => {
    const d = gerarDps({ ...base, regime, aliquotaTotalSimplesBps: 650 });
    expect(d.id).toBe('DPS355030821234567800019500001999999999999999');
    expect(d.xml).toContain('<nDPS>999999999999999</nDPS>');
    expect(d.xml).toContain('<dCompet>2026-09-09</dCompet>');
    expect(d.xml).toContain('<vServ>49.01</vServ>');
    expect(d.xml).toContain('Corte &amp; barba &lt;completo&gt;');
    expect(d.xml).not.toContain('<pAliq>');
    expect(() => validarSchemaNfse(d.xml, 'DPS')).not.toThrow();
  });
  it('Simples com ISS fora do DAS usa regApTribSN 2 e tributos separados, sem alíquota municipal indevida', () => {
    const fora = { ...base, regime: 'simples' as const, issForaDas: true };
    expect(() => gerarDps(fora)).toThrow('nfse_tributos_aproximados_obrigatorios');
    const { xml } = gerarDps({ ...fora, tributosAproximadosBps: { federal: 600, estadual: 0, municipal: 500 } });
    expect(xml).toContain('<opSimpNac>3</opSimpNac><regApTribSN>2</regApTribSN>');
    expect(xml).toContain('<pTotTribFed>6.00</pTotTribFed>'); expect(xml).toContain('<pTotTribMun>5.00</pTotTribMun>');
    expect(xml).not.toContain('<pAliq>'); expect(xml).not.toContain('<pTotTribSN>');
    expect(() => gerarDps({ ...base, issForaDas: true })).toThrow('nfse_apuracao_iss_invalida');
  });
  it('XSD reprova documento sem informação obrigatória e com ordem trocada', () => {
    const { xml } = gerarDps(base);
    expect(() => validarSchemaNfse(xml.replace('<tpAmb>2</tpAmb>', ''), 'DPS')).toThrow();
    expect(() => validarSchemaNfse(xml.replace('<tribISSQN>1</tribISSQN><tpRetISSQN>1</tpRetISSQN>',
      '<tpRetISSQN>1</tpRetISSQN><tribISSQN>1</tribISSQN>'), 'DPS')).toThrow();
  });
  it('ME/EPP com tributos federais e ISS fora do DAS informa regApTribSN 3 e recusa combinação incoerente', () => {
    const dados: DadosDps & { federaisForaDas: boolean } = { ...base, regime: 'simples', issForaDas: true, federaisForaDas: true,
      tributosAproximadosBps: { federal: 1345, estadual: 0, municipal: 500 } };
    const { xml } = gerarDps(dados);
    expect(xml).toContain('<opSimpNac>3</opSimpNac><regApTribSN>3</regApTribSN>');
    expect(xml).toContain('<pTotTribFed>13.45</pTotTribFed>'); expect(xml).not.toContain('<pTotTribSN>');
    expect(xml).not.toContain('<pAliq>');
    expect(() => gerarDps({ ...dados, issForaDas: false })).toThrow('nfse_apuracao_iss_invalida');
    expect(() => gerarDps({ ...dados, regime: 'normal' })).toThrow('nfse_apuracao_iss_invalida');
  });
  it('não optante informa os três percentuais, sem campos exclusivos do Simples ou alíquota municipal indevida', () => {
    const { xml } = gerarDps({ ...base, regime: 'normal',
      tributosAproximadosBps: { federal: 1345, estadual: 0, municipal: 500 }, aliquotaTotalSimplesBps: 650 });
    expect(xml).toContain('<opSimpNac>1</opSimpNac>');
    expect(xml).toContain('<pTotTrib><pTotTribFed>13.45</pTotTribFed><pTotTribEst>0.00</pTotTribEst><pTotTribMun>5.00</pTotTribMun></pTotTrib>');
    for (const campo of ['regApTribSN', 'pTotTribSN', 'indTotTrib', 'pAliq']) expect(xml).not.toContain(`<${campo}>`);
    expect(() => validarSchemaNfse(xml, 'DPS')).not.toThrow();
  });
  it('não optante exige percentuais explícitos e recusa valores fora de 0 a 100%', () => {
    expect(() => gerarDps({ ...base, regime: 'normal' })).toThrow('nfse_tributos_aproximados_obrigatorios');
    for (const federal of [-1, 10001, 100.5, NaN]) {
      expect(() => gerarDps({ ...base, regime: 'normal', tributosAproximadosBps: { federal, estadual: 0, municipal: 500 } }))
        .toThrow('nfse_tributos_aproximados_obrigatorios');
    }
    expect(gerarDps({ ...base, regime: 'normal', tributosAproximadosBps: { federal: 10000, estadual: 0, municipal: 0 } }).xml)
      .toContain('<pTotTribFed>100.00</pTotTribFed>');
  });
  it('recusa série reservada ao emissor web e regime que o perfil ainda não trata', () => {
    expect(() => gerarDps({ ...base, serie: 70000 })).toThrow('nfse_dps_dados_invalidos');
    expect(() => gerarDps({ ...base, regime: 'salao_parceiro' as 'mei' })).toThrow('nfse_dps_dados_invalidos');
    expect(() => gerarDps({ ...base, regime: 'simples' })).toThrow('nfse_aliquota_total_simples_obrigatoria');
  });
  it('declara IBS/CBS para o destinatário identificado e valida o grupo no XSD oficial', () => {
    const { xml } = gerarDps({ ...base, regime: 'normal', nbs: '126021000', perfilIbsCbs: 'regular_presencial',
      tributosAproximadosBps: { federal: 1345, estadual: 0, municipal: 500 },
      tomador: { nome: 'Cliente do atendimento', documento: '52998224725' } });
    expect(xml).toContain('<IBSCBS><finNFSe>0</finNFSe><indFinal>1</indFinal><cIndOp>030101</cIndOp><indDest>0</indDest>');
    expect(xml).toContain('<CST>000</CST><cClassTrib>000001</cClassTrib>');
    expect(xml).not.toContain('<pCBS>');
    expect(() => validarSchemaNfse(xml, 'DPS')).not.toThrow();
  });
  it('recusa IBS/CBS antes de 2026, serviço incompatível e destinatário sem CPF válido', () => {
    const dados: DadosDps = { ...base, regime: 'normal', nbs: '126021000', perfilIbsCbs: 'regular_presencial',
      tributosAproximadosBps: { federal: 1345, estadual: 0, municipal: 500 } };
    for (const alteracao of [{ competencia: '2025-12-31' }, { codigoNacional: '060201' },
      { nbs: '126029000' }, { municipioPrestacao: '3304557' }, { regime: 'mei' as const }]) {
      expect(() => gerarDps({ ...dados, ...alteracao })).toThrow('nfse_ibscbs_perfil_invalido');
    }
    for (const tomador of [null, { nome: 'Cliente', documento: '12345678000195' },
      { nome: 'Cliente', documento: '52998224726' }, { nome: ' ', documento: '52998224725' }]) {
      expect(() => gerarDps({ ...dados, ...(tomador ? { tomador } : {}) })).toThrow('nfse_ibscbs_tomador_obrigatorio');
    }
  });
});
