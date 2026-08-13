/**
 * O ciclo individual de retorno e os sete segmentos (bloco 61, SPEC §4.4).
 *
 * > *"'Em risco' usa o **ciclo individual**, não um número fixo global. Cliente
 * > que corta a cada 45 dias não está em risco no dia 30; cliente que corta a
 * > cada 15 já está. Regra fixa de '60 dias sem voltar' — como fazem os
 * > concorrentes — dispara campanha errada para metade da base."*
 *
 * É a frase que decide este arquivo, e ela condena o que o produto já tinha: o
 * filtro `inativos` do bloco 57 pergunta "quem não vem há N dias", com o N
 * digitado no formulário. Ele continua existindo — é uma pergunta legítima —,
 * mas deixa de ser a única, e não é mais a que a retenção usa.
 *
 * ## Segmento é derivado, nunca coluna
 *
 * Mesma decisão do DRE, do saldo de estoque e do de fidelidade. A SPEC pede
 * *"recalculada por evento, não por batch noturno"*, e derivar na leitura é mais
 * forte que isso: não existe instante em que o rótulo esteja velho. Uma coluna
 * `segmento` estaria errada em todo minuto entre a visita e a varredura passar —
 * e é justamente aí que alguém abre a ficha.
 *
 * ## Por que mediana, e não média
 *
 * A média de intervalos é destruída por um único sumiço. Quem corta a cada 20
 * dias, some por oito meses e volta tem média de 60 e mediana de 20 — e a
 * mediana é quem ele é. O desvio ainda entra, mas sobre a mediana: é o que dá
 * folga a quem é irregular sem transformar um feriado em alarme.
 */

export const SEGMENTOS = [
  'novo',
  'ativo',
  'frequente',
  'vip',
  'em_risco',
  'perdido',
  'assinante',
] as const;
export type Segmento = (typeof SEGMENTOS)[number];

export const ROTULO_DO_SEGMENTO: Readonly<Record<Segmento, string>> = {
  novo: 'Novo',
  ativo: 'Ativo',
  frequente: 'Frequente',
  vip: 'VIP',
  em_risco: 'Em risco',
  perdido: 'Perdido',
  assinante: 'Assinante',
};

/**
 * O que cada segmento quer dizer, em português do balcão.
 *
 * A tela mostra isto ao lado do rótulo porque "Em risco" sozinho é uma acusação
 * sem critério: a recepção precisa poder responder "por que ele está em risco?"
 * sem abrir a documentação.
 */
export const EXPLICACAO_DO_SEGMENTO: Readonly<Record<Segmento, string>> = {
  novo: 'Veio uma vez. Ainda não dá para saber o ritmo dele.',
  ativo: 'Está voltando dentro do ritmo dele.',
  frequente: 'Volta mais rápido que a maioria da base.',
  vip: 'Está entre os que mais gastaram na casa.',
  em_risco: 'Passou do ritmo dele e ainda não voltou.',
  perdido: 'Passou do dobro do ritmo dele. Provavelmente foi para outro lugar.',
  assinante: 'Tem assinatura ativa.',
};

/** Quantas visitas são necessárias para existir um ciclo. */
export const VISITAS_PARA_TER_CICLO = 3;

export interface CicloDoCliente {
  /** A mediana dos intervalos entre visitas, em dias. */
  readonly medianaDias: number;
  /**
   * A folga, em dias, antes de a ausência virar risco.
   *
   * Desvio absoluto mediano, não desvio padrão: a mesma razão de a medida
   * central ser a mediana — um sumiço isolado infla o desvio padrão e daria
   * folga infinita justamente a quem já sumiu uma vez.
   */
  readonly folgaDias: number;
  readonly visitas: number;
}

const dias = (ms: number) => ms / 86_400_000;

function mediana(valores: readonly number[]): number {
  const ordenados = [...valores].sort((a, b) => a - b);
  const meio = Math.floor(ordenados.length / 2);
  if (ordenados.length === 0) return 0;
  if (ordenados.length % 2 === 1) return ordenados[meio] ?? 0;
  return ((ordenados[meio - 1] ?? 0) + (ordenados[meio] ?? 0)) / 2;
}

/**
 * O ritmo desta pessoa, a partir das visitas que ela de fato fez.
 *
 * Devolve nulo abaixo de três visitas: com duas há **um** intervalo, e um
 * intervalo não é um ritmo — chamar de ciclo o espaço entre a primeira e a
 * segunda vinda transformaria coincidência em regra, e a regra decide quem
 * recebe mensagem.
 *
 * As visitas entram **ordenadas ou não**: a função ordena. Depender da ordem do
 * chamador é o tipo de contrato que uma consulta nova quebra em silêncio.
 */
export function cicloDoCliente(visitas: readonly Date[]): CicloDoCliente | null {
  if (visitas.length < VISITAS_PARA_TER_CICLO) return null;

  const ordenadas = [...visitas].sort((a, b) => a.getTime() - b.getTime());
  const intervalos: number[] = [];
  for (let i = 1; i < ordenadas.length; i += 1) {
    const anterior = ordenadas[i - 1];
    const atual = ordenadas[i];
    if (!anterior || !atual) continue;
    intervalos.push(dias(atual.getTime() - anterior.getTime()));
  }
  if (intervalos.length === 0) return null;

  const centro = mediana(intervalos);
  const folga = mediana(intervalos.map((i) => Math.abs(i - centro)));

  return {
    medianaDias: Math.round(centro),
    /**
     * Piso de um dia na folga.
     *
     * Quem corta toda sexta tem desvio zero, e sem o piso ele viraria "em risco"
     * no sábado de manhã — no dia seguinte ao corte, por um atraso de horas.
     */
    folgaDias: Math.max(1, Math.round(folga)),
    visitas: visitas.length,
  };
}

export interface EntradaDoSegmento {
  readonly ciclo: CicloDoCliente | null;
  readonly ultimaVisita: Date | null;
  readonly agora: Date;
  readonly assinanteAtivo: boolean;
  readonly gastoTotalCents: number;
  /** A mediana do ciclo da base, para "frequente". Nula quando a base é pequena. */
  readonly medianaDaBaseDias: number | null;
  /** O corte do decil superior de gasto, para "VIP". Nulo quando a base é pequena. */
  readonly corteDeVipCents: number | null;
}

/**
 * Em qual segmento esta pessoa está **agora**.
 *
 * ## A ordem é a da consequência, não a da tabela
 *
 * A SPEC lista sete e uma pessoa cabe em vários: um assinante que sumiu é as
 * duas coisas. A ordem aqui responde *"o que a casa faz com ele hoje?"*, e a
 * resposta certa para quem sumiu é ir atrás — mesmo assinante, principalmente
 * assinante, porque ali existe uma mensalidade prestes a ser cancelada.
 *
 * Por isso perdido e em risco vêm **antes** de assinante, VIP e frequente. Um
 * VIP que não volta há três ciclos não é um VIP: é um VIP que a casa está
 * perdendo, e chamá-lo de VIP na tela esconde exatamente o que precisa ser
 * visto.
 */
export function segmentoDoCliente(entrada: EntradaDoSegmento): Segmento {
  const { ciclo, ultimaVisita, agora } = entrada;

  if (ultimaVisita === null) return 'novo';

  const ausente = dias(agora.getTime() - ultimaVisita.getTime());

  if (ciclo) {
    // Mais que o dobro do ritmo: a SPEC chama de perdido, e o nome é honesto.
    if (ausente > ciclo.medianaDias * 2) return 'perdido';
    // Passou do ritmo mais a folga dele. É o "média + desvio" da SPEC, com a
    // medida central trocada por mediana pela razão do cabeçalho.
    if (ausente > ciclo.medianaDias + ciclo.folgaDias) return 'em_risco';
  }

  if (entrada.assinanteAtivo) return 'assinante';

  if (entrada.corteDeVipCents !== null && entrada.gastoTotalCents >= entrada.corteDeVipCents) {
    return 'vip';
  }

  if (
    ciclo &&
    entrada.medianaDaBaseDias !== null &&
    ciclo.medianaDias < entrada.medianaDaBaseDias
  ) {
    return 'frequente';
  }

  /**
   * Uma visita só continua sendo "novo", mesmo dentro do prazo.
   *
   * Sem ciclo não há como dizer que ele "retornou dentro do esperado" — ele não
   * retornou ainda. Chamá-lo de ativo daria à tela um cliente estabelecido que
   * veio uma vez.
   */
  if (!ciclo) return 'novo';

  return 'ativo';
}

/**
 * A mediana dos ciclos da base, para decidir quem é "frequente".
 *
 * Nula abaixo de um mínimo: com cinco clientes com ciclo, a mediana é ruído, e
 * "volta mais rápido que a maioria" viraria uma frase sobre duas pessoas. Sem
 * ela, ninguém é frequente — que é o certo, porque a comparação não existe.
 */
export const BASE_MINIMA_PARA_COMPARAR = 10;

export function medianaDaBase(ciclos: readonly number[]): number | null {
  if (ciclos.length < BASE_MINIMA_PARA_COMPARAR) return null;
  return Math.round(mediana(ciclos));
}

/**
 * O corte do decil superior de gasto, para decidir quem é VIP.
 *
 * Decil e não valor fixo: "gastou mais de R$ 2.000" quer dizer coisas
 * diferentes numa barbearia de bairro e numa do centro, e o dono teria que
 * calibrar um número que ele não tem como estimar. O topo dos dez por cento é a
 * mesma frase nas duas.
 */
export function corteDeVip(gastos: readonly number[]): number | null {
  if (gastos.length < BASE_MINIMA_PARA_COMPARAR) return null;
  const ordenados = [...gastos].sort((a, b) => b - a);
  const indice = Math.max(0, Math.ceil(ordenados.length / 10) - 1);
  return ordenados[indice] ?? null;
}

/**
 * Os públicos de campanha, e o nome de cada um — aqui, e em nenhum outro lugar.
 *
 * Este mapa morava escrito à mão dentro da tela de campanhas **e** dentro de
 * `packages/crm`. Duas listas para o mesmo vocabulário é a que ninguém atualiza:
 * o bloco 61 acrescentou três públicos, e a tela teria continuado oferecendo os
 * quatro antigos com a API aceitando sete, sem nada ficar vermelho.
 *
 * É a mesma decisão do vocabulário de transição da fila (§6, pergunta 2): a
 * palavra que a recepção lê mora no domínio, e a tela a exibe.
 */
export const FILTROS_DE_CAMPANHA = [
  'inativos',
  'aniversariantes',
  'todos',
  'celula_fria',
  'em_risco',
  'perdido',
  'vip',
] as const;
export type FiltroDeCampanha = (typeof FILTROS_DE_CAMPANHA)[number];

export const ROTULO_DO_FILTRO: Readonly<Record<FiltroDeCampanha, string>> = {
  inativos: 'Quem sumiu',
  aniversariantes: 'Aniversariantes do mês',
  todos: 'Toda a base',
  celula_fria: 'Quem costuma vir naquele horário',
  em_risco: 'Passou do ritmo dele',
  perdido: 'Passou do dobro do ritmo dele',
  vip: 'Quem mais gasta na casa',
};

/**
 * Os três filtros que saem do segmento derivado, e não de uma condição em SQL.
 *
 * `novo`, `ativo`, `frequente` e `assinante` ficam de fora **de propósito**: são
 * estados em que a casa não precisa fazer nada, e mandar mensagem para quem está
 * voltando sozinho é como se queima o número da barbearia.
 */
export const SEGMENTO_DO_FILTRO: Readonly<Partial<Record<FiltroDeCampanha, Segmento>>> = {
  em_risco: 'em_risco',
  perdido: 'perdido',
  vip: 'vip',
};

/**
 * O que o campo "o número do filtro" quer dizer neste público.
 *
 * Vai **dentro da opção** e não numa dica abaixo, pela razão do bloco 56: uma
 * dica teria que listar os sete significados de uma vez e vira parágrafo que
 * ninguém lê. Nulo quando o público não usa número nenhum.
 */
export const NUMERO_DO_FILTRO: Readonly<Record<FiltroDeCampanha, string | null>> = {
  inativos: 'dias sem vir',
  aniversariantes: null,
  todos: null,
  celula_fria: 'a hora da célula',
  em_risco: null,
  perdido: null,
  vip: null,
};
