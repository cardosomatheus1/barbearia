import { describe, expect, it } from 'vitest';
import { escolhaValida, mascararTelefone } from './conflitos';

describe('conflitos da importação', () => {
  it('aceita somente as duas decisões do domínio', () => {
    expect(escolhaValida('anterior')).toBe(true);
    expect(escolhaValida('linha')).toBe(true);
    expect(escolhaValida('ambos')).toBe(false);
  });

  it('não devolve o telefone inteiro para a ilha', () => {
    expect(mascararTelefone('+5571988887777')).toBe('•••• 7777');
    expect(mascararTelefone('+55')).toBe('••••');
  });
});
