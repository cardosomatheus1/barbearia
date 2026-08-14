import { describe, expect, it } from 'vitest';
import { comDestaques, LUGARES_EM_DESTAQUE, precoDoDestaque } from './destaque.js';

const casa = (locationId: string) => ({ locationId });

describe('destaque na busca', () => {
  it('o patrocinado vai para cima e sai da lista orgânica', () => {
    /**
     * Aparecer duas vezes faria a busca de uma cidade pequena virar a mesma
     * casa três vezes seguidas — e o que se comprou foi posição, não repetição.
     */
    const lista = comDestaques(
      [casa('a'), casa('b'), casa('c')],
      [{ locationId: 'b', lugar: 1 }],
    );

    expect(lista.map((r) => r.casa.locationId)).toEqual(['b', 'a', 'c']);
    expect(lista.filter((r) => r.patrocinado).map((r) => r.casa.locationId)).toEqual(['b']);
  });

  it('a ordem entre patrocinados é a dos lugares comprados', () => {
    // Não a da consulta: sem isso a lista trocaria entre dois carregamentos sem
    // nada ter mudado, e o que a barbearia comprou deixaria de ser o que recebe.
    const lista = comDestaques(
      [casa('a'), casa('b'), casa('c')],
      [
        { locationId: 'c', lugar: 2 },
        { locationId: 'a', lugar: 1 },
      ],
    );

    expect(lista.map((r) => r.casa.locationId)).toEqual(['a', 'c', 'b']);
  });

  it('quem não passou nos filtros não aparece, mesmo tendo pago', () => {
    /**
     * O destaque compra posição **entre resultados válidos**, não o direito de
     * contrariar o que a pessoa pediu. Quem comprou e não tem vaga hoje não
     * aparece numa busca por "disponível hoje" — senão o primeiro card da lista
     * seria justamente o que menos serve a quem está lendo.
     */
    const lista = comDestaques([casa('a')], [{ locationId: 'fora-do-filtro', lugar: 1 }]);

    expect(lista.map((r) => r.casa.locationId)).toEqual(['a']);
    expect(lista.every((r) => !r.patrocinado)).toBe(true);
  });

  it('a mesma unidade comprada duas vezes não duplica', () => {
    const lista = comDestaques(
      [casa('a'), casa('b')],
      [
        { locationId: 'a', lugar: 1 },
        { locationId: 'a', lugar: 2 },
      ],
    );
    expect(lista.map((r) => r.casa.locationId)).toEqual(['a', 'b']);
  });

  it('sem patrocínio a lista é a orgânica, na mesma ordem', () => {
    const lista = comDestaques([casa('a'), casa('b')], []);
    expect(lista.map((r) => r.casa.locationId)).toEqual(['a', 'b']);
    expect(lista.every((r) => !r.patrocinado)).toBe(true);
  });

  it('o preço é por dia, e período vazio não custa nada', () => {
    expect(precoDoDestaque(30)).toBe(30 * 900);
    expect(precoDoDestaque(0)).toBe(0);
    expect(precoDoDestaque(-5)).toBe(0);
  });

  it('a escassez é um número, e ele é pequeno de propósito', () => {
    // Com cinquenta lugares, destaque deixa de valer alguma coisa — para quem
    // compra e para quem busca. O banco cita o mesmo teto numa `CHECK`.
    expect(LUGARES_EM_DESTAQUE).toBe(3);
  });
});
