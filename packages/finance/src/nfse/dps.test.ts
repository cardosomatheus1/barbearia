import { describe, expect, it } from 'vitest';
import { gerarDps, type DadosDps } from './dps.js';
import { validarSchemaNfse } from './schema.js';

const base: DadosDps = { ambiente: 'homologacao', cnpj: '12345678000195', municipioEmissor: '3550308',
  municipioPrestacao: '3550308', serie: 1, numero: '999999999999999',
  emitidaEm: new Date('2026-09-09T23:30:00-03:00'), competencia: '2026-09-09',
  regime: 'mei', codigoNacional: '060101', descricao: 'Corte & barba <completo>', servicoCents: 4901 };

describe('DPS 1.01 contra XSD oficial com ajuste documentado de série', () => {
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
  it('XSD reprova documento sem informação obrigatória e com ordem trocada', () => {
    const { xml } = gerarDps(base);
    expect(() => validarSchemaNfse(xml.replace('<tpAmb>2</tpAmb>', ''), 'DPS')).toThrow();
    expect(() => validarSchemaNfse(xml.replace('<tribISSQN>1</tribISSQN><tpRetISSQN>1</tpRetISSQN>',
      '<tpRetISSQN>1</tpRetISSQN><tribISSQN>1</tribISSQN>'), 'DPS')).toThrow();
  });
  it('recusa série reservada ao emissor web e regime que o perfil ainda não trata', () => {
    expect(() => gerarDps({ ...base, serie: 70000 })).toThrow('nfse_dps_dados_invalidos');
    expect(() => gerarDps({ ...base, regime: 'salao_parceiro' as 'mei' })).toThrow('nfse_dps_dados_invalidos');
    expect(() => gerarDps({ ...base, regime: 'simples' })).toThrow('nfse_aliquota_total_simples_obrigatoria');
  });
});
