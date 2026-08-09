import { describe, expect, it } from 'vitest';
import {
  contarFalha,
  ERROS_ANTES_DA_ESPERA,
  esperaDeLogin,
  ESQUECER_APOS_SEGUNDOS,
  MAIOR_ESPERA_SEGUNDOS,
  PRIMEIRA_ESPERA_SEGUNDOS,
} from './login.js';

/**
 * A escada precisa de prova nos dois sentidos, como toda regra que pode barrar
 * gente legítima.
 *
 * Frouxa demais, adivinhar senha volta a ser barato. Apertada demais, errar a
 * senha duas vezes tranca a recepção no meio do sábado — e aí alguém desliga a
 * proteção, que é o pior dos dois mundos.
 */

const AGORA = new Date('2026-08-09T12:00:00Z');
const segundosAtras = (n: number) => new Date(AGORA.getTime() - n * 1000);

describe('espera depois de errar a senha', () => {
  it('não atrapalha quem errou pouco', () => {
    // Cinco tentativas livres: quem digita a senha errada no celular, com
    // pressa, não pode ser tratado como ataque.
    for (let falhas = 0; falhas <= ERROS_ANTES_DA_ESPERA; falhas++) {
      expect(esperaDeLogin({ falhas, ultimaFalhaEm: segundosAtras(1) }, AGORA)).toBe(0);
    }
  });

  it('a espera dobra a cada erro seguinte', () => {
    const espera = (falhas: number) =>
      esperaDeLogin({ falhas, ultimaFalhaEm: AGORA }, AGORA);

    expect(espera(ERROS_ANTES_DA_ESPERA + 1)).toBe(PRIMEIRA_ESPERA_SEGUNDOS);
    expect(espera(ERROS_ANTES_DA_ESPERA + 2)).toBe(PRIMEIRA_ESPERA_SEGUNDOS * 2);
    expect(espera(ERROS_ANTES_DA_ESPERA + 3)).toBe(PRIMEIRA_ESPERA_SEGUNDOS * 4);
  });

  it('para de crescer em meia hora', () => {
    /**
     * Sem teto, o vigésimo erro pediria mais de um ano — que é bloqueio
     * permanente com outro nome, e traz de volta a negação de serviço: bastaria
     * errar de propósito a senha do dono para trancá-lo fora do próprio
     * negócio.
     */
    const espera = esperaDeLogin({ falhas: 40, ultimaFalhaEm: AGORA }, AGORA);
    expect(espera).toBe(MAIOR_ESPERA_SEGUNDOS);
  });

  it('a espera escorre com o tempo, e libera sozinha', () => {
    const estado = { falhas: ERROS_ANTES_DA_ESPERA + 1, ultimaFalhaEm: segundosAtras(10) };
    expect(esperaDeLogin(estado, AGORA)).toBe(PRIMEIRA_ESPERA_SEGUNDOS - 10);

    const passou = { falhas: ERROS_ANTES_DA_ESPERA + 1, ultimaFalhaEm: segundosAtras(31) };
    expect(esperaDeLogin(passou, AGORA)).toBe(0);
  });

  it('quem nunca errou não espera, mesmo com contagem estranha', () => {
    // Defesa contra dado inconsistente: contagem sem data não pode virar
    // bloqueio, porque não há de quando descontar.
    expect(esperaDeLogin({ falhas: 99, ultimaFalhaEm: null }, AGORA)).toBe(0);
  });
});

describe('a contagem de erros', () => {
  it('cresce a cada erro seguido', () => {
    expect(contarFalha({ falhas: 0, ultimaFalhaEm: null }, AGORA)).toBe(1);
    expect(contarFalha({ falhas: 3, ultimaFalhaEm: segundosAtras(5) }, AGORA)).toBe(4);
  });

  it('esquece o que é velho, em vez de acumular por meses', () => {
    /**
     * Sem esquecimento, a contagem de alguém desastrado com a senha se acumula
     * ao longo de meses e a pessoa cai na escada sem nunca ter sido atacada —
     * e ninguém entende por quê.
     */
    const velho = { falhas: 4, ultimaFalhaEm: segundosAtras(ESQUECER_APOS_SEGUNDOS + 1) };
    expect(contarFalha(velho, AGORA)).toBe(1);
    expect(esperaDeLogin({ ...velho, falhas: 20 }, AGORA)).toBe(0);
  });

  it('não esquece um pouco antes da hora', () => {
    const quase = { falhas: 4, ultimaFalhaEm: segundosAtras(ESQUECER_APOS_SEGUNDOS - 60) };
    expect(contarFalha(quase, AGORA)).toBe(5);
  });
});
