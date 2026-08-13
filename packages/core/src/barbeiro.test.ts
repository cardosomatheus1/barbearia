import { describe, expect, it } from 'vitest';
import {
  ESPECIALIDADES,
  ehEspecialidade,
  frasedasEspecialidades,
  ROTULO_DA_ESPECIALIDADE,
  slugDoBarbeiro,
} from './barbeiro.js';

describe('o endereço público do barbeiro', () => {
  it('sai do nome, sem acento e sem pontuação', () => {
    expect(slugDoBarbeiro('João Silva')).toBe('joao-silva');
    expect(slugDoBarbeiro('Ruan  D\'Ávila')).toBe('ruan-d-avila');
  });

  it('recusa o que não vira endereço legível', () => {
    // O `CHECK` do banco exige de 3 a 60: devolver algo fora disso empurraria
    // para lá uma recusa que dá para explicar aqui.
    expect(slugDoBarbeiro('!!')).toBeNull();
    expect(slugDoBarbeiro('  ')).toBeNull();
  });

  it('não termina em hífen depois do corte', () => {
    const longo = slugDoBarbeiro(`${'a'.repeat(59)} silva`);
    expect(longo).not.toMatch(/-$/);
    expect((longo ?? '').length).toBeLessThanOrEqual(60);
  });
});

describe('as especialidades', () => {
  it('a frase segue a ordem da lista, nunca a do banco', () => {
    /**
     * O array vem do Postgres na ordem em que alguém marcou as caixas, e ela
     * mudaria a cada edição sem nada ter mudado de verdade. A ordem é do
     * domínio — mesma razão de nunca sair de `Object.entries`.
     */
    expect(frasedasEspecialidades(['barba', 'fade'])).toBe('Fade · Barba');
    expect(frasedasEspecialidades(['fade', 'barba'])).toBe('Fade · Barba');
  });

  it('ignora o que não está na lista fechada', () => {
    expect(ehEspecialidade('fade')).toBe(true);
    expect(ehEspecialidade('Fade')).toBe(false);
    expect(ehEspecialidade('corte na régua')).toBe(false);
  });

  it('toda especialidade tem rótulo, e o teste deriva da lista', () => {
    // Lista escrita ao lado seria a que ninguém atualiza: o bloco que
    // acrescentasse uma especialidade deixaria a tela sem a frase dela.
    for (const e of ESPECIALIDADES) {
      expect(ROTULO_DA_ESPECIALIDADE[e], e).toBeTruthy();
    }
  });
});
