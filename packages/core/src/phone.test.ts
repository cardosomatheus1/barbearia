import { describe, expect, it } from 'vitest';
import {
  InvalidPhoneError,
  maskPhone,
  normalizeBusinessPhone,
  normalizePhone,
  tryNormalizeBusinessPhone,
  tryNormalizePhone,
} from './phone.js';

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

describe('normalizeBusinessPhone — o telefone da barbearia', () => {
  it('aceita fixo, que é o que metade das barbearias tem', () => {
    /**
     * O motivo é concreto: a página pública desenha um botão de ligar, e
     * recusar fixo obrigaria o dono a publicar o celular pessoal ou a não
     * publicar número nenhum.
     */
    expect(normalizeBusinessPhone('(71) 3333-4444')).toBe('+557133334444');
    expect(normalizeBusinessPhone('71 2555 1000')).toBe('+557125551000');
    expect(normalizeBusinessPhone('+55 11 4004-0001')).toBe('+551140040001');
    // 5 é faixa rara e legítima; deixá-la de fora recusaria número de verdade.
    expect(normalizeBusinessPhone('(11) 5555-1234')).toBe('+551155551234');
  });

  it('continua aceitando celular, com e sem o nono dígito', () => {
    expect(normalizeBusinessPhone('(71) 98888-7777')).toBe('+5571988887777');
    expect(normalizeBusinessPhone('71 8888-7777')).toBe('+5571988887777');
  });

  it('o telefone do cliente continua recusando fixo', () => {
    // São duas funções e não um parâmetro porque a diferença é de propósito: o
    // do cliente recebe o código de acesso, e fixo não recebe.
    expect(tryNormalizePhone('(71) 3333-4444')).toEqual({
      ok: false,
      code: 'invalid_br_subscriber',
    });
  });

  it('erro que não é "não é celular" continua sendo erro', () => {
    // A segunda passada só reexamina o que foi recusado por não ser celular.
    // Sem isso, DDD inexistente entraria pela porta do fixo.
    expect(tryNormalizeBusinessPhone('(23) 3333-4444')).toEqual({
      ok: false,
      code: 'invalid_br_area_code',
    });
    expect(tryNormalizeBusinessPhone('713333')).toEqual({ ok: false, code: 'too_short' });
    expect(tryNormalizeBusinessPhone('abc')).toEqual({ ok: false, code: 'invalid_characters' });
    expect(tryNormalizeBusinessPhone('')).toEqual({ ok: false, code: 'empty' });
  });

  it('recusa o que não é nem fixo nem celular', () => {
    // Oito dígitos com DDD válido, começando em 1: não é faixa de celular
    // (6789) nem de fixo (2345). Tem o tamanho certo e não existe.
    expect(tryNormalizeBusinessPhone('(71) 1234-5678')).toEqual({
      ok: false,
      code: 'invalid_br_subscriber',
    });
  });

  it('o que sai daqui cabe no CHECK do banco', () => {
    // `locations_phone_format` é `^\\+[1-9][0-9]{7,14}$`. Foi ele que devolveu
    // 500 quando a borda não normalizava — o teste existe para que a borda e a
    // constraint não voltem a discordar.
    const doBanco = /^\+[1-9][0-9]{7,14}$/;
    for (const entrada of ['(71) 3333-4444', '(71) 98888-7777', '+1 415 555 2671']) {
      const saida = normalizeBusinessPhone(entrada);
      expect(doBanco.test(saida), `${entrada} -> ${saida}`).toBe(true);
    }
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
