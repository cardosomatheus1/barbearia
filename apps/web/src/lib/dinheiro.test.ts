import { describe, expect, it } from 'vitest';
import { centavosDoCampo, reaisDoCampo } from './dinheiro';

describe('preço do formulário', () => {
  it('vírgula e ponto valem o mesmo — o teclado do celular dá vírgula', () => {
    expect(centavosDoCampo('49,90')).toBe(4990);
    expect(centavosDoCampo('49.90')).toBe(4990);
  });

  it('não perde centavo em ponto flutuante', () => {
    // `Number('49.90') * 100` dá 4989.999999999999. Este é o teste que fica
    // vermelho no dia em que alguém "simplificar" a conversão.
    expect(centavosDoCampo('49,90')).toBe(4990);
    expect(centavosDoCampo('0,07')).toBe(7);
    expect(centavosDoCampo('1234,56')).toBe(123456);
  });

  it('um dígito depois da vírgula são dezenas de centavo, não unidades', () => {
    expect(centavosDoCampo('49,9')).toBe(4990);
    expect(centavosDoCampo('7,5')).toBe(750);
  });

  it('sem centavos é preço redondo', () => {
    expect(centavosDoCampo('50')).toBe(5000);
    expect(centavosDoCampo('0')).toBe(0);
  });

  it('recusa o que não é preço em vez de gravar zero', () => {
    expect(centavosDoCampo('')).toBeNull();
    expect(centavosDoCampo('grátis')).toBeNull();
    expect(centavosDoCampo('-10')).toBeNull();
    expect(centavosDoCampo('R$ 49,90')).toBeNull();
    // Três casas não é dinheiro: silenciar arredondaria o preço do barbeiro.
    expect(centavosDoCampo('49,901')).toBeNull();
  });

  it('volta para o campo no formato em que foi digitado', () => {
    expect(reaisDoCampo(4990)).toBe('49,90');
    expect(reaisDoCampo(5000)).toBe('50,00');
    expect(reaisDoCampo(7)).toBe('0,07');
  });

  it('ida e volta não muda o preço', () => {
    for (const centavos of [0, 7, 990, 4990, 123456]) {
      expect(centavosDoCampo(reaisDoCampo(centavos))).toBe(centavos);
    }
  });
});
