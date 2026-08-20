import { describe, expect, it } from 'vitest';
import {
  centroDaCapital,
  coordenadaDoLink,
  ehCoordenadaDoBrasil,
  resolverCoordenada,
} from './geo.js';

/**
 * A coordenada da barbearia (bloco 115).
 *
 * Sem ela `marketplace_listings` é sempre vazia, e as duas pontas do produto
 * dizem coisas opostas: Configurações afirma "sua barbearia aparece na busca" e
 * `/buscar` responde "nenhuma barbearia publicada ainda".
 */

describe('o link do mapa que a pessoa cola', () => {
  it('acha a coordenada na barra do Google Maps', () => {
    expect(
      coordenadaDoLink(
        'https://www.google.com/maps/place/Barbearia/@-12.9777,-38.5016,17z/data=!3m1',
      ),
    ).toEqual({ latitude: -12.9777, longitude: -38.5016 });
  });

  it('acha no link longo, que traz o ponto em !3d!4d', () => {
    expect(
      coordenadaDoLink('https://www.google.com/maps/place/X/data=!4m5!3m4!1s0x0!8m2!3d-23.5505!4d-46.6333'),
    ).toEqual({ latitude: -23.5505, longitude: -46.6333 });
  });

  it('aceita o par cru, para quem já tem o número', () => {
    expect(coordenadaDoLink('-8.0476, -34.8770')).toEqual({
      latitude: -8.0476,
      longitude: -34.877,
    });
  });

  it('recusa o link encurtado em vez de prometer e falhar depois', () => {
    /**
     * `maps.app.goo.gl` só revela a coordenada depois de uma ida à rede. Aceitar
     * aqui e falhar em silêncio na gravação seria a tela dizendo "salvo" sobre
     * uma barbearia que continua fora da busca — que é exatamente o estado que
     * este bloco existe para acabar.
     */
    expect(coordenadaDoLink('https://maps.app.goo.gl/abc123')).toBeNull();
  });

  it('recusa coordenada de fora do Brasil', () => {
    // Passa na forma e erra no lugar: põe a barbearia noutro continente, e
    // quem busca por raio recebe um resultado que não serve.
    expect(coordenadaDoLink('https://maps.google.com/@48.8584,2.2945,17z')).toBeNull();
    expect(ehCoordenadaDoBrasil({ latitude: 48.8584, longitude: 2.2945 })).toBe(false);
  });

  it('texto sem coordenada nenhuma é nulo, não zero', () => {
    expect(coordenadaDoLink('')).toBeNull();
    expect(coordenadaDoLink('minha barbearia fica na pituba')).toBeNull();
    // Zero-zero é o Golfo da Guiné: número válido, lugar errado.
    expect(coordenadaDoLink('0,0')).toBeNull();
  });
});

describe('o centro da capital, para quem não colou link', () => {
  it('conhece as vinte e sete', () => {
    const ufs = ['AC','AL','AM','AP','BA','CE','DF','ES','GO','MA','MG','MS','MT','PA','PB','PE','PI','PR','RJ','RN','RO','RR','RS','SC','SE','SP','TO'];
    for (const uf of ufs) {
      const centro = centroDaCapital(uf);
      expect(centro, uf).not.toBeNull();
      expect(ehCoordenadaDoBrasil(centro!), uf).toBe(true);
    }
  });

  it('aceita a UF em minúscula e com espaço, que é como se digita', () => {
    expect(centroDaCapital(' ba ')).toEqual(centroDaCapital('BA'));
  });

  it('UF que não existe é nulo — nunca um chute', () => {
    expect(centroDaCapital('XX')).toBeNull();
    expect(centroDaCapital(null)).toBeNull();
  });
});

describe('qual ponto vale', () => {
  it('o link vence a capital: ele é a porta da barbearia', () => {
    const resolvida = resolverCoordenada({
      linkDoMapa: 'https://maps.google.com/@-12.9500,-38.4000,17z',
      estado: 'BA',
    });
    expect(resolvida).toMatchObject({ latitude: -12.95, origem: 'link' });
  });

  it('sem link, a capital do estado — e a tela sabe que é aproximação', () => {
    expect(resolverCoordenada({ estado: 'PE' })).toMatchObject({
      latitude: -8.0476,
      origem: 'capital',
    });
  });

  it('sem link e sem UF, nada — e é isso que tira a casa da busca', () => {
    // Coordenada errada é pior que ausente: ela põe a barbearia no mapa no
    // lugar errado, e quem procura por raio recebe o que não serve.
    expect(resolverCoordenada({})).toBeNull();
    expect(resolverCoordenada({ linkDoMapa: 'não é link', estado: null })).toBeNull();
  });
});
