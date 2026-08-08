import { describe, expect, it } from 'vitest';
import { SERVICE_TEMPLATES, validateCombos } from './templates.js';

describe('templates sugeridos', () => {
  it('nenhum combo do template promete menos tempo que as partes', () => {
    // É o defeito D4 na origem: o concorrente declarou 40 minutos para um par
    // que soma 45, e a agenda dele nasceu devendo 5 minutos por cliente.
    const chaves = SERVICE_TEMPLATES.map((t) => ({
      key: t.key,
      durationMinutes: t.durationMinutes,
      priceCents: t.priceCents,
      ...(t.componentKeys ? { componentKeys: t.componentKeys } : {}),
    }));
    expect(validateCombos(chaves)).toEqual([]);
  });

  it('todo serviço tem buffer de limpeza', () => {
    // Buffer zero é o que produz agenda que só funciona no papel.
    for (const template of SERVICE_TEMPLATES) {
      expect(template.bufferAfterMinutes).toBeGreaterThan(0);
    }
  });

  it('toda duração é positiva e múltipla de 5', () => {
    // Grade de barbearia trabalha em múltiplos de 5; 23 minutos vira slot torto.
    for (const template of SERVICE_TEMPLATES) {
      expect(template.durationMinutes).toBeGreaterThan(0);
      expect(template.durationMinutes % 5).toBe(0);
    }
  });

  it('as chaves não se repetem', () => {
    const chaves = SERVICE_TEMPLATES.map((t) => t.key);
    expect(new Set(chaves).size).toBe(chaves.length);
  });

  it('todo componente de combo existe no próprio template', () => {
    const chaves = new Set(SERVICE_TEMPLATES.map((t) => t.key));
    for (const template of SERVICE_TEMPLATES) {
      for (const componente of template.componentKeys ?? []) {
        expect(chaves.has(componente)).toBe(true);
      }
    }
  });
});

describe('validação de combo depois da edição', () => {
  const partes = [
    { key: 'corte', durationMinutes: 30, priceCents: 4500 },
    { key: 'barba', durationMinutes: 25, priceCents: 3500 },
  ];

  it('aponta combo mais curto que a soma das partes', () => {
    const problemas = validateCombos([
      ...partes,
      { key: 'combo', durationMinutes: 40, priceCents: 7000, componentKeys: ['corte', 'barba'] },
    ]);
    expect(problemas).toContainEqual({
      key: 'combo',
      problem: 'combo_shorter_than_parts',
      declared: 40,
      actual: 55,
    });
  });

  it('aponta combo que não sai mais barato', () => {
    // Combo que não economiza não é combo: quem o escolhe paga a mais achando
    // que economizou.
    const problemas = validateCombos([
      ...partes,
      { key: 'combo', durationMinutes: 55, priceCents: 8000, componentKeys: ['corte', 'barba'] },
    ]);
    expect(problemas.map((p) => p.problem)).toContain('combo_not_cheaper');
  });

  it('aceita combo coerente', () => {
    const problemas = validateCombos([
      ...partes,
      { key: 'combo', durationMinutes: 55, priceCents: 7000, componentKeys: ['corte', 'barba'] },
    ]);
    expect(problemas).toEqual([]);
  });

  it('aceita combo mais longo que a soma — buffer entre as partes é legítimo', () => {
    const problemas = validateCombos([
      ...partes,
      { key: 'combo', durationMinutes: 60, priceCents: 7000, componentKeys: ['corte', 'barba'] },
    ]);
    expect(problemas).toEqual([]);
  });

  it('aponta componente que a barbearia apagou depois', () => {
    // Apagar "barba" e deixar o combo apontando para ela é o caminho comum de
    // voltar a ter cardápio incoerente.
    const problemas = validateCombos([
      { key: 'corte', durationMinutes: 30, priceCents: 4500 },
      { key: 'combo', durationMinutes: 55, priceCents: 7000, componentKeys: ['corte', 'barba'] },
    ]);
    expect(problemas.map((p) => p.problem)).toEqual(['unknown_component']);
  });

  it('serviço sem componentes não é combo e não é checado', () => {
    expect(validateCombos(partes)).toEqual([]);
  });
});
