import { describe, expect, it } from 'vitest';
import { perfilIbsCbsCompativel } from './fiscal-ibscbs.js';

describe('enquadramento IBS/CBS de barbearia', () => {
  const p = { perfil: 'regular_presencial', regime: 'normal', codigoNacional: '060101', nbs: '126021000' };
  it('exige escolha explícita e serviço/NBS compatíveis', () => {
    expect(perfilIbsCbsCompativel(p)).toBe(true);
    for (const alteracao of [{ perfil: null }, { perfil: 'isento' }, { nbs: null },
      { nbs: '126029000' }, { codigoNacional: '060201' }, { regime: 'simples' }, { regime: 'mei' }]) {
      expect(perfilIbsCbsCompativel({ ...p, ...alteracao })).toBe(false);
    }
  });
});
