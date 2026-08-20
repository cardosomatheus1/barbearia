/**
 * A coordenada da barbearia — SPEC §5.10, bloco 115.
 *
 * ## O defeito que este arquivo fecha
 *
 * `atualizarVitrine` delista toda unidade com `latitude`/`longitude` nulas, e
 * **nenhuma tela do produto escrevia essas colunas**: `saveBusiness` era o único
 * caminho e o formulário não tinha o campo; `criarUnidade` também não. Logo
 * `marketplace_listings` era sempre vazia — e as duas pontas do produto diziam
 * coisas opostas sobre isso: Configurações afirmava "sua barbearia aparece na
 * busca" enquanto `/buscar` respondia "nenhuma barbearia publicada ainda",
 * culpando a barbearia por algo que ela já tinha feito (§6, pergunta 6).
 *
 * Junto iam o botão "Como chegar" da página pública, o mapa da confirmação, o
 * `geo` do JSON-LD, o destaque patrocinado e a atribuição de receita — todos
 * dependem de uma listagem que não podia existir.
 *
 * ## Por que não um campo de latitude
 *
 * Porque ninguém preenche. Latitude e longitude cruas são o defeito de `blocks`
 * com outro nome: a coluna existiria, a tela teria o campo, e ele ficaria vazio
 * em toda barbearia — que é exatamente o estado de hoje, com mais trabalho.
 *
 * ## O que a pessoa realmente sabe fazer
 *
 * Colar o link do mapa. Todo mundo no Brasil sabe achar a própria barbearia no
 * Google Maps e copiar o endereço da barra — e esse endereço **já carrega a
 * coordenada**, em `@-12.9777,-38.5016`. Sem rede, sem credencial, sem provedor
 * contratado: o parsing é local.
 *
 * Para quem não colar, o centroide da capital do estado serve à busca por
 * cidade. Cidade fora da lista fica **sem** coordenada de propósito: coordenada
 * errada é pior que ausente, porque põe a barbearia no mapa no lugar errado, e
 * quem procura por raio recebe um resultado que não serve.
 *
 * `GeocodingProvider` existe para o dia em que houver emissor contratado — é o
 * precedente de `PaymentProvider`, `WhatsAppProvider` e `FiscalProvider`, e a
 * troca é de uma classe.
 */

/**
 * `Coordenada` mora em `marketplace.ts`, e é a mesma.
 *
 * Declarar uma segunda aqui compilou no `typecheck` e quebrou no `build`: o
 * barril reexporta os dois arquivos, e dois `Coordenada` são ambíguos. É a
 * convenção da constante nova num pacote com barril — confira se o nome já
 * existe —, e a de que `typecheck` e `build` não são a mesma conferência.
 */
import type { Coordenada } from './marketplace.js';

export type { Coordenada };

/**
 * Resolve um endereço em coordenada.
 *
 * Contrato, não implementação: quem sabe transformar "Rua Ceará, 120, Pituba,
 * Salvador" num ponto é um serviço contratado. O que mora aqui é a forma.
 */
export interface GeocodingProvider {
  /** `null` quando não dá para dizer — nunca um palpite. */
  resolver(endereco: {
    readonly rua: string | null;
    readonly cidade: string | null;
    readonly estado: string | null;
    readonly cep: string | null;
  }): Promise<Coordenada | null>;
}

/** Faixas do Brasil, com folga. Fora delas, o número não é daqui. */
const LATITUDE_MINIMA = -34;
const LATITUDE_MAXIMA = 6;
const LONGITUDE_MINIMA = -74;
const LONGITUDE_MAXIMA = -32;

export function ehCoordenadaDoBrasil(c: Coordenada): boolean {
  return (
    Number.isFinite(c.latitude) &&
    Number.isFinite(c.longitude) &&
    c.latitude >= LATITUDE_MINIMA &&
    c.latitude <= LATITUDE_MAXIMA &&
    c.longitude >= LONGITUDE_MINIMA &&
    c.longitude <= LONGITUDE_MAXIMA
  );
}

/**
 * A coordenada dentro de um link de mapa colado.
 *
 * Cobre as formas que o Google Maps produz — `@lat,lon,17z` da barra, `?q=` do
 * compartilhamento, `!3dlat!4dlon` do link longo — e o par cru, para quem já
 * tem o número. Devolve `null` para link encurtado (`maps.app.goo.gl`), que só
 * revela a coordenada depois de uma ida à rede: prometer que funciona e depois
 * falhar em silêncio seria pior que recusar na hora.
 *
 * Fora do Brasil vira `null` pelo mesmo motivo de sempre — um número que passa
 * na forma e erra no lugar põe a barbearia no mapa em outro continente.
 */
export function coordenadaDoLink(texto: string): Coordenada | null {
  const limpo = texto.trim();
  if (!limpo) return null;

  const candidatos: RegExp[] = [
    // A barra do Google Maps: .../@-12.9777,-38.5016,17z/...
    /@(-?\d+\.\d+),(-?\d+\.\d+)/,
    // O link longo: ...!3d-12.9777!4d-38.5016
    /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,
    // O compartilhamento e o par cru: ?q=-12.9777,-38.5016 ou "-12.9777, -38.5016"
    /(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/,
  ];

  for (const padrao of candidatos) {
    const casou = padrao.exec(limpo);
    if (!casou) continue;
    const coordenada = { latitude: Number(casou[1]), longitude: Number(casou[2]) };
    if (ehCoordenadaDoBrasil(coordenada)) return coordenada;
  }

  return null;
}

/**
 * O centro das capitais, para quem não colou link.
 *
 * Serve à busca por cidade — quem procura barbearia em Salvador encontra a de
 * Salvador —, e não à navegação: o ponto é o centro da capital, não a porta da
 * barbearia. A tela diz isso, porque um mapa que promete precisão e entrega o
 * centro da cidade é pior que um mapa que diz de onde veio o ponto.
 *
 * Só capitais, e é decisão: a coordenada de uma cidade que eu não sei situar
 * seria um chute com cara de dado. Cidade fora da lista fica sem coordenada, e
 * a tela pede o link do mapa — que é a resposta certa para ela de qualquer
 * forma.
 */
const CENTRO_DA_CAPITAL: Readonly<Record<string, Coordenada>> = {
  AC: { latitude: -9.9754, longitude: -67.8249 },
  AL: { latitude: -9.6498, longitude: -35.7089 },
  AM: { latitude: -3.119, longitude: -60.0217 },
  AP: { latitude: 0.0349, longitude: -51.0694 },
  BA: { latitude: -12.9777, longitude: -38.5016 },
  CE: { latitude: -3.7319, longitude: -38.5267 },
  DF: { latitude: -15.7939, longitude: -47.8828 },
  ES: { latitude: -20.3155, longitude: -40.3128 },
  GO: { latitude: -16.6869, longitude: -49.2648 },
  MA: { latitude: -2.5307, longitude: -44.3068 },
  MG: { latitude: -19.9167, longitude: -43.9345 },
  MS: { latitude: -20.4697, longitude: -54.6201 },
  MT: { latitude: -15.6014, longitude: -56.0979 },
  PA: { latitude: -1.4558, longitude: -48.5039 },
  PB: { latitude: -7.1195, longitude: -34.845 },
  PE: { latitude: -8.0476, longitude: -34.877 },
  PI: { latitude: -5.0892, longitude: -42.8019 },
  PR: { latitude: -25.4284, longitude: -49.2733 },
  RJ: { latitude: -22.9068, longitude: -43.1729 },
  RN: { latitude: -5.7945, longitude: -35.211 },
  RO: { latitude: -8.7612, longitude: -63.9004 },
  RR: { latitude: 2.8235, longitude: -60.6758 },
  RS: { latitude: -30.0346, longitude: -51.2177 },
  SC: { latitude: -27.5954, longitude: -48.548 },
  SE: { latitude: -10.9472, longitude: -37.0731 },
  SP: { latitude: -23.5505, longitude: -46.6333 },
  TO: { latitude: -10.1689, longitude: -48.3317 },
};

export function centroDaCapital(uf: string | null): Coordenada | null {
  if (!uf) return null;
  return CENTRO_DA_CAPITAL[uf.trim().toUpperCase()] ?? null;
}

/** De onde veio o ponto — a tela diz isso, porque a precisão é diferente. */
export type OrigemDaCoordenada = 'link' | 'capital';

export interface CoordenadaResolvida extends Coordenada {
  readonly origem: OrigemDaCoordenada;
}

/**
 * O ponto da barbearia, do mais preciso para o menos.
 *
 * O link colado vence sempre: ele é a porta da barbearia. Sem ele, o centro da
 * capital do estado — que serve para a casa **aparecer** numa busca por cidade,
 * e é dito na tela como aproximação.
 */
export function resolverCoordenada(entrada: {
  readonly linkDoMapa?: string | null;
  readonly estado?: string | null;
}): CoordenadaResolvida | null {
  const doLink = entrada.linkDoMapa ? coordenadaDoLink(entrada.linkDoMapa) : null;
  if (doLink) return { ...doLink, origem: 'link' };

  const daCapital = centroDaCapital(entrada.estado ?? null);
  if (daCapital) return { ...daCapital, origem: 'capital' };

  return null;
}
