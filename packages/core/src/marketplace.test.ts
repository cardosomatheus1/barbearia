import { describe, expect, it } from 'vitest';
import {
  RAIO_MAXIMO_KM,
  caixaDaBusca,
  distanciaKm,
  filtrarBusca,
  type BarbeariaNaVitrine,
  type FiltroDaBusca,
} from './marketplace.js';

/**
 * A busca do marketplace (bloco 70, SPEC §5.2).
 *
 * Três decisões carregam o bloco e são o que estes testes prendem: o que
 * acontece com quem **não tem** nota ou preço, a ordem quando há empate, e a
 * caixa de coordenadas não perder ninguém que está dentro do raio.
 */

/** Salvador, Rio Vermelho. */
const AQUI = { latitude: -12.9899, longitude: -38.4767 };

const casa = (parcial: Partial<BarbeariaNaVitrine> = {}): BarbeariaNaVitrine => ({
  slug: 'domari',
  nome: 'Domari Barber Club',
  cidade: 'Salvador',
  estado: 'BA',
  latitude: AQUI.latitude,
  longitude: AQUI.longitude,
  fotoUrl: null,
  precoDeCents: 5500,
  notaBps: 490,
  avaliacoes: 842,
  comodidades: [],
  temClube: false,
  ...parcial,
});

const filtro = (parcial: Partial<FiltroDaBusca> = {}): FiltroDaBusca => ({
  de: AQUI,
  raioKm: 5,
  ordem: 'distancia',
  notaMinimaBps: null,
  precoMaximoCents: null,
  comodidades: [],
  somenteComClube: false,
  ...parcial,
});

/** Move um ponto `km` para o norte. Um grau de latitude vale ~111,32 km. */
const aoNorte = (km: number) => ({ latitude: AQUI.latitude + km / 111.32, longitude: AQUI.longitude });

describe('a distância é de régua, e é honesta', () => {
  it('a mesma coordenada dá zero', () => {
    expect(distanciaKm(AQUI, AQUI)).toBe(0);
  });

  it('um grau de latitude vale cerca de 111 km', () => {
    // O número não é escolhido: é a definição do meridiano, e errá-lo faria toda
    // distância da tela sair com escala errada sem nada parecer quebrado.
    const km = distanciaKm(AQUI, { ...AQUI, latitude: AQUI.latitude + 1 });
    expect(km).toBeGreaterThan(110);
    expect(km).toBeLessThan(112);
  });
});

describe('o raio corta, e tem teto', () => {
  it('quem está fora do raio não entra', () => {
    const perto = casa({ slug: 'perto', ...aoNorte(2) });
    const longe = casa({ slug: 'longe', ...aoNorte(20) });
    const achadas = filtrarBusca([perto, longe], filtro({ raioKm: 5 }));
    expect(achadas.map((r) => r.slug)).toEqual(['perto']);
  });

  it('raio absurdo é aparado no teto, não obedecido', () => {
    /**
     * "500 km" varre o país e devolve ruído — e uma busca de marketplace que
     * responde com barbearias de outro estado é um diretório, não uma busca.
     */
    const muitoLonge = casa({ slug: 'outro-estado', ...aoNorte(RAIO_MAXIMO_KM + 10) });
    expect(filtrarBusca([muitoLonge], filtro({ raioKm: 500 }))).toHaveLength(0);
  });
});

describe('quem não tem nota e quem não tem preço', () => {
  it('sem nota **não** passa no filtro de nota', () => {
    /**
     * Quem ainda não tem avaliação suficiente não é ruim — é desconhecido. Mas
     * quem pediu "4 estrelas para cima" está pedindo garantia, e entregar o
     * desconhecido ali é responder outra pergunta.
     */
    const nova = casa({ slug: 'nova', notaBps: null, avaliacoes: 1 });
    expect(filtrarBusca([nova], filtro({ notaMinimaBps: 400 }))).toHaveLength(0);
    expect(filtrarBusca([nova], filtro())).toHaveLength(1);
  });

  it('sem preço **passa** no filtro de preço', () => {
    /**
     * A assimetria é de propósito: sem catálogo a casa não é cara, é
     * desconhecida — e o filtro de preço é um teto, não uma exigência. Excluí-la
     * puniria justamente quem mais precisa aparecer.
     */
    const semCatalogo = casa({ slug: 'sem-catalogo', precoDeCents: null });
    expect(filtrarBusca([semCatalogo], filtro({ precoMaximoCents: 4000 }))).toHaveLength(1);
  });

  it('preço acima do teto não entra', () => {
    const cara = casa({ slug: 'cara', precoDeCents: 9000 });
    expect(filtrarBusca([cara], filtro({ precoMaximoCents: 5000 }))).toHaveLength(0);
  });
});

describe('comodidades e clube', () => {
  it('exige **todas** as comodidades pedidas, não qualquer uma', () => {
    // Quem filtrou por acessibilidade e estacionamento precisa das duas — uma
    // busca que devolve só metade do pedido é a que faz a pessoa ir até a porta.
    const so = casa({ slug: 'so-um', comodidades: ['acessivel'] });
    const ambos = casa({ slug: 'ambos', comodidades: ['acessivel', 'estacionamento'] });
    const achadas = filtrarBusca([so, ambos], filtro({ comodidades: ['acessivel', 'estacionamento'] }));
    expect(achadas.map((r) => r.slug)).toEqual(['ambos']);
  });

  it('o filtro de clube recorta quem assina', () => {
    const com = casa({ slug: 'com-clube', temClube: true });
    const sem = casa({ slug: 'sem-clube', temClube: false });
    const achadas = filtrarBusca([com, sem], filtro({ somenteComClube: true }));
    expect(achadas.map((r) => r.slug)).toEqual(['com-clube']);
  });
});

describe('a ordem, e o que fazer com o nulo dentro dela', () => {
  it('por nota, quem não tem nota vai para o fim', () => {
    /**
     * `null` ordenado como zero jogaria a casa nova para o topo de "melhor
     * avaliada" — o contrário do que a ordem promete.
     */
    const boa = casa({ slug: 'boa', notaBps: 480, ...aoNorte(3) });
    const nova = casa({ slug: 'nova', notaBps: null, ...aoNorte(1) });
    const achadas = filtrarBusca([nova, boa], filtro({ ordem: 'nota' }));
    expect(achadas.map((r) => r.slug)).toEqual(['boa', 'nova']);
  });

  it('por preço, quem não tem preço vai para o fim', () => {
    // Um `null` tratado como zero seria a casa mais barata da lista sem ter
    // preço nenhum.
    const barata = casa({ slug: 'barata', precoDeCents: 3000, ...aoNorte(3) });
    const semPreco = casa({ slug: 'sem-preco', precoDeCents: null, ...aoNorte(1) });
    const achadas = filtrarBusca([semPreco, barata], filtro({ ordem: 'preco' }));
    expect(achadas.map((r) => r.slug)).toEqual(['barata', 'sem-preco']);
  });

  it('empate desempata pela mais perto, e depois por um campo estável', () => {
    /**
     * Duas notas 4,9 num raio de cinco quilômetros é empate frequente. Sem
     * desempate estável a lista troca de ordem entre dois carregamentos sem nada
     * ter mudado, e quem busca deixa de confiar nela.
     */
    const longe = casa({ slug: 'z-longe', notaBps: 490, ...aoNorte(4) });
    const perto = casa({ slug: 'a-perto', notaBps: 490, ...aoNorte(1) });
    const numaOrdem = filtrarBusca([longe, perto], filtro({ ordem: 'nota' }));
    const naOutra = filtrarBusca([perto, longe], filtro({ ordem: 'nota' }));
    expect(numaOrdem.map((r) => r.slug)).toEqual(['a-perto', 'z-longe']);
    expect(naOutra.map((r) => r.slug)).toEqual(numaOrdem.map((r) => r.slug));
  });

  it('a lista tem teto', () => {
    const muitas = Array.from({ length: 40 }, (_, i) =>
      casa({ slug: `casa-${i}`, ...aoNorte(i / 20) }),
    );
    expect(filtrarBusca(muitas, filtro()).length).toBeLessThanOrEqual(20);
  });
});

describe('a caixa de coordenadas não pode perder ninguém do raio', () => {
  it('contém o ponto na borda do raio, ao norte e a leste', () => {
    /**
     * A caixa é o recorte que o índice alcança, e o erro perigoso dela é ser
     * **estreita demais**: uma barbearia dentro do raio que a consulta nem traz
     * é um resultado ausente que ninguém investiga, porque a lista parece
     * completa.
     */
    const caixa = caixaDaBusca(AQUI, 5);
    const norte = aoNorte(4.9);
    expect(norte.latitude).toBeLessThanOrEqual(caixa.latMax);

    const leste = {
      latitude: AQUI.latitude,
      longitude: AQUI.longitude + 4.9 / (111.32 * Math.cos((AQUI.latitude * Math.PI) / 180)),
    };
    expect(leste.longitude).toBeLessThanOrEqual(caixa.lonMax);
    expect(distanciaKm(AQUI, leste)).toBeLessThan(5);
  });

  it('a caixa é mais larga em longitude longe do equador', () => {
    /**
     * Um grau de longitude encolhe conforme se sobe para os polos: no equador
     * vale 111 km, em Porto Alegre 80. Usar o valor do equador em toda parte
     * faria a caixa do sul do país perder barbearias dentro do raio.
     */
    const noEquador = caixaDaBusca({ latitude: 0, longitude: -38 }, 5);
    const noSul = caixaDaBusca({ latitude: -30, longitude: -51 }, 5);
    const larguraEquador = noEquador.lonMax - noEquador.lonMin;
    const larguraSul = noSul.lonMax - noSul.lonMin;
    expect(larguraSul).toBeGreaterThan(larguraEquador);
  });

  it('o teto do raio vale para a caixa também', () => {
    // Senão a consulta varreria o país antes de o corte exato acontecer.
    const enorme = caixaDaBusca(AQUI, 500);
    const noTeto = caixaDaBusca(AQUI, RAIO_MAXIMO_KM);
    expect(enorme.latMax).toBe(noTeto.latMax);
  });
});
