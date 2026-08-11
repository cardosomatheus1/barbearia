import { describe, expect, it } from 'vitest';
import { BASE_DE_FALTAS, faltasDoLimiar, limiarDeFaltas } from './sinal';

/**
 * A tradução entre o que a tela pergunta e o que o motor aplica (bloco 37).
 *
 * O motor decide por score; a tela pergunta "de quem falta quantas vezes em dez
 * você quer sinal?". Se as duas direções discordarem, o dono escolhe 4 e a
 * barbearia cobra de quem faltou 3 — sem nada ficar vermelho.
 */

describe('faltas em dez e o limiar do score', () => {
  it('ida e volta devolvem o mesmo número', () => {
    for (let n = 1; n <= BASE_DE_FALTAS; n += 1) {
      expect(faltasDoLimiar(limiarDeFaltas(n))).toBe(n);
    }
  });

  it('o padrão do banco significa metade das vezes', () => {
    // A migração 0039 nasce com 60, que é o número da SPEC §2.13. A tela precisa
    // dizer o que ele quer dizer — e "5 em 10" é o que ele quer dizer.
    expect(faltasDoLimiar(60)).toBe(5);
  });

  it('o corte é estrito, e é quem falta a partir de n que paga', () => {
    /**
     * O motor cobra quando `score < limiar`. Com dez agendamentos e `f` faltas o
     * score é `100 − 10f`. Aqui se prova que escolher 4 cobra de quem faltou 4 e
     * não de quem faltou 3 — o erro de um degrau é invisível na tela e visível
     * no balcão.
     */
    const limiar = limiarDeFaltas(4);
    const scoreCom = (faltas: number) => 100 - 10 * faltas;

    expect(scoreCom(3) < limiar).toBe(false);
    expect(scoreCom(4) < limiar).toBe(true);
  });

  it('valor fora da escala não vira limiar absurdo', () => {
    // Campo numérico é entrada externa: o `min`/`max` do HTML não vale nada.
    expect(faltasDoLimiar(limiarDeFaltas(0))).toBe(1);
    expect(faltasDoLimiar(limiarDeFaltas(999))).toBe(BASE_DE_FALTAS);
  });
});
