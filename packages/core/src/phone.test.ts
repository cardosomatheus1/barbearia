import { describe, expect, it } from 'vitest';
import { InvalidPhoneError, maskPhone, normalizePhone, tryNormalizePhone } from './phone.js';

describe('normalizePhone — Brasil', () => {
  it('normaliza as formas que o cliente digita', () => {
    for (const input of [
      '71988887777',
      '(71) 98888-7777',
      '71 9 8888 7777',
      '+55 71 98888-7777',
      '5571988887777',
      '071988887777',
      '0055 71 98888 7777',
      ' 71.98888.7777 ',
    ]) {
      expect(normalizePhone(input)).toBe('+5571988887777');
    }
  });

  it('acrescenta o nono dígito em número antigo de oito', () => {
    // Aparece em base importada e em cliente que digita de memória.
    expect(normalizePhone('7188887777')).toBe('+5571988887777');
    expect(normalizePhone('(71) 8888-7777')).toBe('+5571988887777');
  });

  it('recusa fixo de oito dígitos que não é celular', () => {
    expect(() => normalizePhone('7132227777')).toThrow(InvalidPhoneError);
  });

  it('recusa DDD inexistente', () => {
    for (const ddd of ['20', '23', '25', '26', '29', '30', '36', '39', '52', '72', '78', '90']) {
      expect(() => normalizePhone(`${ddd}988887777`)).toThrow(InvalidPhoneError);
    }
  });

  it('aceita DDDs válidos com buraco na sequência', () => {
    expect(normalizePhone('71988887777')).toBe('+5571988887777');
    expect(normalizePhone('79988887777')).toBe('+5579988887777');
    expect(normalizePhone('11988887777')).toBe('+5511988887777');
  });

  it('recusa tamanho fora da faixa', () => {
    expect(() => normalizePhone('719888877')).toThrow(InvalidPhoneError);
    expect(() => normalizePhone('719888877771')).toThrow(InvalidPhoneError);
  });
});

describe('normalizePhone — outros países', () => {
  it('preserva número internacional explícito', () => {
    expect(normalizePhone('+1 415 555 2671')).toBe('+14155552671');
    expect(normalizePhone('+351 912 345 678')).toBe('+351912345678');
  });

  it('respeita país padrão diferente', () => {
    expect(normalizePhone('912345678', '351')).toBe('+351912345678');
  });
});

describe('normalizePhone — entrada hostil', () => {
  it('recusa vazio e caracteres inválidos', () => {
    for (const input of ['', '   ', 'abc', "71'; DROP TABLE customers--", '<script>', '+++']) {
      expect(() => normalizePhone(input)).toThrow(InvalidPhoneError);
    }
  });

  it('devolve o motivo sem lançar', () => {
    expect(tryNormalizePhone('abc')).toEqual({ ok: false, code: 'invalid_characters' });
    expect(tryNormalizePhone('71988887777')).toEqual({ ok: true, phone: '+5571988887777' });
  });

  it('resultado sempre casa com a constraint do banco', () => {
    const constraint = /^\+[1-9][0-9]{7,14}$/;
    for (const input of ['71988887777', '+1 415 555 2671', '(11) 98888-7777']) {
      expect(normalizePhone(input)).toMatch(constraint);
    }
  });

  it('é idempotente', () => {
    const once = normalizePhone('(71) 98888-7777');
    expect(normalizePhone(once)).toBe(once);
  });
});

describe('maskPhone', () => {
  it('esconde o miolo — telefone completo é dado pessoal', () => {
    // Preserva o comprimento: país, DDD e os quatro finais bastam para o
    // cliente reconhecer o próprio número sem que o log guarde o resto.
    expect(maskPhone('+5571988887777')).toBe('+55719****7777');
    expect(maskPhone('+14155552671')).toBe('+14155**2671');
  });

  it('não altera o comprimento', () => {
    for (const phone of ['+5571988887777', '+14155552671', '+351912345678']) {
      expect(maskPhone(phone)).toHaveLength(phone.length);
    }
  });
});
