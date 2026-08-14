/**
 * A busca do marketplace (bloco 70, SPEC §5.2).
 *
 * > *"Barbearias perto de mim."*
 * > *"Filtros: distância · preço · avaliação · disponível hoje · disponível
 * > agora · serviço · profissional · assinatura · acessibilidade."*
 *
 * ## O que este arquivo decide, e o que ele não decide
 *
 * Ele decide **distância, corte e ordem** — a aritmética da busca. Não vai ao
 * banco, não sabe o que é uma barbearia e não conhece nenhum dos filtros que
 * dependem de agenda: *"disponível hoje"* e *"disponível agora"* exigem rodar o
 * motor de disponibilidade em lote, que é o bloco 71 e a razão de ele existir
 * separado.
 *
 * ## Distância é haversine, não Postgis
 *
 * O produto não tem extensão geográfica instalada, e a conta que ele precisa é
 * "quantos quilômetros daqui até lá" sobre uma cidade — onde a curvatura da
 * Terra muda o resultado em metros. Haversine resolve com duas colunas
 * `numeric` que já existem desde o bloco 7, e sem uma dependência nova de
 * infraestrutura.
 *
 * Quando a busca passar de uma cidade para o país inteiro, a resposta é índice
 * geográfico — e aí o motivo estará medido, que é como este repositório troca
 * de ferramenta.
 */

/** Raio da Terra em quilômetros. */
const RAIO_DA_TERRA_KM = 6371;

const RADIANOS = Math.PI / 180;

export interface Coordenada {
  readonly latitude: number;
  readonly longitude: number;
}

/**
 * A distância em linha reta entre dois pontos, em quilômetros.
 *
 * Linha reta, e a tela diz isso: "1,2 km" num mapa urbano é sempre menos que o
 * caminho a pé. Prometer distância de rota exigiria um serviço de rotas, e um
 * número de rota errado é pior que um número de régua honesto.
 */
export function distanciaKm(de: Coordenada, ate: Coordenada): number {
  const dLat = (ate.latitude - de.latitude) * RADIANOS;
  const dLon = (ate.longitude - de.longitude) * RADIANOS;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(de.latitude * RADIANOS) *
      Math.cos(ate.latitude * RADIANOS) *
      Math.sin(dLon / 2) ** 2;
  return RAIO_DA_TERRA_KM * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * O raio padrão da busca, em quilômetros.
 *
 * Cinco quilômetros é o que uma pessoa considera "perto" para cortar cabelo numa
 * cidade brasileira — ela não atravessa a cidade por um corte, e é justamente
 * isso que separa marketplace de diretório.
 */
export const RAIO_PADRAO_KM = 5;

/** Teto do raio pedido. Sem ele, "500 km" varre o país e devolve ruído. */
export const RAIO_MAXIMO_KM = 50;

/** Quantos resultados uma busca devolve. */
export const RESULTADOS_POR_BUSCA = 20;

export const ORDENS_DA_BUSCA = ['distancia', 'nota', 'preco'] as const;
export type OrdemDaBusca = (typeof ORDENS_DA_BUSCA)[number];

export const ROTULO_DA_ORDEM: Readonly<Record<OrdemDaBusca, string>> = {
  distancia: 'Mais perto',
  nota: 'Melhor avaliada',
  preco: 'Menor preço',
};

export interface FiltroDaBusca {
  readonly de: Coordenada;
  readonly raioKm: number;
  readonly ordem: OrdemDaBusca;
  /** Piso de nota, em pontos-base. Nulo é "tanto faz". */
  readonly notaMinimaBps: number | null;
  /** Teto de preço de entrada, em centavos. Nulo é "tanto faz". */
  readonly precoMaximoCents: number | null;
  /** Comodidades exigidas, todas elas. Vazio é "tanto faz". */
  readonly comodidades: readonly string[];
  readonly somenteComClube: boolean;
}

export interface BarbeariaNaVitrine {
  readonly slug: string;
  readonly nome: string;
  readonly cidade: string | null;
  readonly estado: string | null;
  readonly latitude: number;
  readonly longitude: number;
  readonly fotoUrl: string | null;
  readonly precoDeCents: number | null;
  readonly notaBps: number | null;
  readonly avaliacoes: number;
  readonly comodidades: readonly string[];
  readonly temClube: boolean;
}

export interface ResultadoDaBusca extends BarbeariaNaVitrine {
  readonly distanciaKm: number;
}

/**
 * O que a busca precisa saber e a tela **não** pode ver (bloco 71).
 *
 * `tenantId`, `locationId` e o serviço do piso de preço existem para o lote de
 * disponibilidade abrir a agenda de cada casa. Eles ficam num tipo separado, e
 * a rota pública faz a projeção à mão, porque a alternativa é a que este
 * repositório já cobrou uma vez: *"duas telas com públicos diferentes lendo o
 * mesmo objeto fazem todo campo novo chegar ao cliente sem ninguém decidir
 * isso"*. Aqui os públicos são a plataforma e a internet inteira.
 */
export interface CasaParaAgenda {
  readonly tenantId: string;
  readonly locationId: string;
  readonly precoServicoId: string | null;
}

/**
 * Recorta e ordena o que a consulta trouxe.
 *
 * A consulta faz o recorte grosseiro por caixa de coordenadas — o que o índice
 * alcança —, e aqui entra a distância exata e o resto dos filtros. Fazer os dois
 * no SQL espalharia a regra por uma consulta que nenhum teste puro alcança;
 * fazer os dois aqui traria a cidade inteira para dentro do processo.
 */
export function filtrarBusca<T extends BarbeariaNaVitrine>(
  candidatas: readonly T[],
  filtro: FiltroDaBusca,
  limite: number = RESULTADOS_POR_BUSCA,
): readonly (T & { readonly distanciaKm: number })[] {
  const raio = Math.min(Math.max(0, filtro.raioKm), RAIO_MAXIMO_KM);

  const dentro: (T & { readonly distanciaKm: number })[] = [];
  for (const casa of candidatas) {
    const km = distanciaKm(filtro.de, casa);
    if (km > raio) continue;

    /**
     * Nota **nula não passa** no filtro de nota, e é diferente de nota baixa.
     *
     * Quem ainda não tem avaliação suficiente não é ruim — é desconhecido. Mas
     * quem pediu "só 4 estrelas para cima" está dizendo que quer garantia, e
     * entregar o desconhecido ali é responder outra pergunta.
     */
    if (filtro.notaMinimaBps !== null) {
      if (casa.notaBps === null || casa.notaBps < filtro.notaMinimaBps) continue;
    }

    /**
     * Preço nulo **passa** no filtro de preço, ao contrário da nota.
     *
     * A assimetria é de propósito: sem preço cadastrado a casa não é "cara", é
     * desconhecida — e o filtro de preço é um teto, não uma exigência. Excluí-la
     * puniria a barbearia que ainda não cadastrou o catálogo, que é justamente
     * quem mais precisa aparecer.
     */
    if (filtro.precoMaximoCents !== null && casa.precoDeCents !== null) {
      if (casa.precoDeCents > filtro.precoMaximoCents) continue;
    }

    // Todas as comodidades pedidas, não qualquer uma: quem filtrou por
    // acessibilidade **e** estacionamento precisa das duas.
    if (filtro.comodidades.some((c) => !casa.comodidades.includes(c))) continue;
    if (filtro.somenteComClube && !casa.temClube) continue;

    dentro.push({ ...casa, distanciaKm: km });
  }

  return dentro.sort(comparador(filtro.ordem)).slice(0, limite);
}

/**
 * A ordem pedida, com **distância como desempate sempre**.
 *
 * Duas barbearias com nota 4,9 num raio de cinco quilômetros são empate
 * frequente, e sem desempate estável a lista troca de ordem entre dois
 * carregamentos sem nada ter mudado. Desempatar pela mais perto é a resposta que
 * a pessoa daria se perguntassem a ela.
 */
function comparador(ordem: OrdemDaBusca): (a: ResultadoDaBusca, b: ResultadoDaBusca) => number {
  const porDistancia = (a: ResultadoDaBusca, b: ResultadoDaBusca) =>
    a.distanciaKm - b.distanciaKm || a.slug.localeCompare(b.slug, 'pt-BR');

  if (ordem === 'nota') {
    /**
     * Sem nota vai para o fim, e não para o começo.
     *
     * Qualquer sentinela abaixo de 100 serve — a nota em pontos-base começa em
     * 100 por `CHECK`. O que não serve é deixar o `undefined` entrar na
     * subtração: `NaN` como resultado de comparador produz ordem indefinida, e
     * a lista passa a mudar entre dois carregamentos sem nada ter mudado.
     */
    return (a, b) => (b.notaBps ?? -1) - (a.notaBps ?? -1) || porDistancia(a, b);
  }
  if (ordem === 'preco') {
    // Sem preço vai para o fim de "menor preço" pelo mesmo motivo: um `null`
    // tratado como zero seria a casa mais barata da lista sem ter preço nenhum.
    return (a, b) =>
      (a.precoDeCents ?? Number.MAX_SAFE_INTEGER) - (b.precoDeCents ?? Number.MAX_SAFE_INTEGER) ||
      porDistancia(a, b);
  }
  return porDistancia;
}

/**
 * A caixa de coordenadas que contém o círculo do raio.
 *
 * É o recorte que o índice alcança: comparar duas colunas com quatro números é
 * uma varredura de índice, e haversine dentro do `WHERE` é uma conta por linha
 * sobre a tabela inteira. A caixa traz um pouco mais que o círculo — os cantos —
 * e `filtrarBusca` corta o excesso com a distância exata.
 */
export function caixaDaBusca(de: Coordenada, raioKm: number): {
  readonly latMin: number;
  readonly latMax: number;
  readonly lonMin: number;
  readonly lonMax: number;
} {
  const raio = Math.min(Math.max(0, raioKm), RAIO_MAXIMO_KM);
  const grausDeLat = raio / 111.32;
  /**
   * Um grau de longitude encolhe conforme se sobe para os polos.
   *
   * No equador vale os mesmos 111 km da latitude; em Porto Alegre, 80. Usar o
   * valor do equador em toda parte faria a caixa do sul do país ser estreita
   * demais e **perder** barbearias dentro do raio — um resultado ausente que
   * ninguém investiga, porque a lista parece completa.
   */
  const cosseno = Math.max(0.01, Math.cos(de.latitude * RADIANOS));
  const grausDeLon = raio / (111.32 * cosseno);

  return {
    latMin: de.latitude - grausDeLat,
    latMax: de.latitude + grausDeLat,
    lonMin: de.longitude - grausDeLon,
    lonMax: de.longitude + grausDeLon,
  };
}

/**
 * Por que a barbearia contesta uma comissão de cliente novo (revisão de
 * segurança do bloco 80).
 *
 * Lista fechada, e é a mesma decisão da contestação de avaliação: texto livre
 * viraria "não gostei", e "não gostei" é evasão de cem por cento da receita
 * indistinguível de discordância legítima. Os cinco descrevem coisas que ou
 * aconteceram ou não aconteceram, e é isso que torna a renúncia auditável.
 *
 * A nota escrita continua existindo, e continua obrigatória — ela só não
 * atravessa para o painel da plataforma, porque é texto sobre um cliente e a
 * plataforma é operadora, não controladora.
 */
export const MOTIVOS_DA_CONTESTACAO_DE_COMISSAO = [
  'ja_era_cliente',
  'veio_por_outro_canal',
  'nao_compareceu',
  'venda_desfeita',
  'cadastro_errado',
] as const;

export type MotivoDaContestacaoDeComissao =
  (typeof MOTIVOS_DA_CONTESTACAO_DE_COMISSAO)[number];

export const ROTULO_DO_MOTIVO_DE_COMISSAO: Readonly<
  Record<MotivoDaContestacaoDeComissao, string>
> = {
  ja_era_cliente: 'Já era cliente antes do marketplace',
  veio_por_outro_canal: 'Veio por indicação ou anúncio nosso',
  nao_compareceu: 'O atendimento não aconteceu',
  venda_desfeita: 'A venda foi cancelada ou estornada',
  cadastro_errado: 'Cadastro duplicado ou trocado',
};

const MOTIVOS_DE_COMISSAO: ReadonlySet<string> = new Set(
  MOTIVOS_DA_CONTESTACAO_DE_COMISSAO,
);

export function ehMotivoDeComissao(v: string): v is MotivoDaContestacaoDeComissao {
  return MOTIVOS_DE_COMISSAO.has(v);
}
