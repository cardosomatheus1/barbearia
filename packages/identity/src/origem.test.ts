import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { carimbarOrigem, conferirOrigem } from './origem.js';

const ANTES = process.env['MARKETPLACE_ORIGIN_SECRET'];
const AGORA = new Date('2026-08-20T12:00:00Z');

describe('o carimbo de "veio pela busca"', () => {
  beforeAll(() => {
    process.env['MARKETPLACE_ORIGIN_SECRET'] = 'segredo-de-teste-0123456789abcdef';
  });

  afterAll(() => {
    if (ANTES === undefined) delete process.env['MARKETPLACE_ORIGIN_SECRET'];
    else process.env['MARKETPLACE_ORIGIN_SECRET'] = ANTES;
  });

  it('o que o servidor assina, o servidor aceita', () => {
    expect(conferirOrigem(carimbarOrigem('domari', AGORA), 'domari', AGORA)).toBe(true);
  });

  it('o carimbo de uma barbearia não vale na outra', () => {
    /**
     * Sem o slug dentro da assinatura, o carimbo tirado da busca de uma casa
     * valeria na página de qualquer outra — e a comissão sairia da barbearia
     * errada, que é a única coisa pior que não cobrar.
     */
    expect(conferirOrigem(carimbarOrigem('domari', AGORA), 'vizinha', AGORA)).toBe(false);
  });

  it('não se forja sem o segredo', () => {
    // A versão anterior gravava a palavra "marketplace" no cookie, e um curl
    // mandava o rótulo direto no corpo. Achado da revisão do bloco 72.
    expect(conferirOrigem('marketplace', 'domari', AGORA)).toBe(false);
    expect(conferirOrigem(`${AGORA.getTime()}.qualquercoisa`, 'domari', AGORA)).toBe(false);
  });

  it('vence, e as duas pontas contam', () => {
    const carimbo = carimbarOrigem('domari', AGORA);
    const trintaEUmDias = new Date(AGORA.getTime() + 31 * 86_400_000);
    const antesDeExistir = new Date(AGORA.getTime() - 86_400_000);

    expect(conferirOrigem(carimbo, 'domari', trintaEUmDias)).toBe(false);
    // Carimbo do futuro é relógio adulterado, não navegação.
    expect(conferirOrigem(carimbo, 'domari', antesDeExistir)).toBe(false);
  });

  it('entrada malformada é "não veio pela busca", nunca exceção', () => {
    // Cookie velho, lixo guardado pelo navegador, robô: nada disso é ataque a
    // ser anunciado, e um 500 aqui quebraria o agendamento de quem só queria
    // marcar um corte.
    for (const lixo of ['', '.', 'a.b.c', 'abc.def', `${Number.NaN}.x`]) {
      expect(conferirOrigem(lixo, 'domari', AGORA), lixo).toBe(false);
    }
  });

  it('sem o segredo no ambiente, falha alto', () => {
    /**
     * Nunca um padrão fraco em silêncio: com segredo vazio a assinatura seria
     * previsível, e o carimbo voltaria a ser a palavra "marketplace" com passos
     * a mais. É a postura de `STAFF_EMAIL_PEPPER` e de `MFA_SECRET_KEY`.
     */
    const guardado = process.env['MARKETPLACE_ORIGIN_SECRET'];
    delete process.env['MARKETPLACE_ORIGIN_SECRET'];
    expect(() => carimbarOrigem('domari', AGORA)).toThrow(/MARKETPLACE_ORIGIN_SECRET/);
    process.env['MARKETPLACE_ORIGIN_SECRET'] = guardado;
  });
});
