/**
 * Previsão de consumo e sugestão de compra (bloco 69, SPEC §4.19).
 *
 * > *"A pomada X deve acabar em ~9 dias pelo consumo das últimas 8 semanas.
 * > `[ Comprar 12 unidades ]`"*
 *
 * ## O que muda em relação à sugestão que já existia
 *
 * `sugestaoDeCompra` (bloco 44) responde "quanto falta para voltar ao mínimo",
 * e o mínimo é um número que alguém digitou uma vez e nunca mais revisitou —
 * exatamente o campo que envelhece em silêncio. Aqui a conta sai do **consumo
 * medido**: quantas unidades saíram por semana nas últimas oito, o que resta, e
 * quanto tempo isso dura.
 *
 * As duas convivem, e é de propósito: o mínimo é a decisão de quem conhece o
 * fornecedor — *"nunca deixo faltar menos de seis"* —, e a previsão é o que o
 * movimento diz. Quando as duas apontam, a maior manda.
 *
 * ## "Não dá para dizer" é diferente de "nunca acaba"
 *
 * Produto que não teve saída nenhuma na janela devolve `null`, nunca infinito. A
 * lista ordenada por urgência colocaria o infinito no fim com cara de boa
 * notícia — e o que ele quer dizer é que ninguém sabe.
 */

/**
 * Oito semanas, o mesmo número do heatmap e do insight.
 *
 * Menos que isso e uma semana atípica — feriado, promoção, o barbeiro de férias
 * — move a previsão inteira. Dois lugares do produto dizendo "o consumo das
 * últimas semanas" sobre janelas diferentes é a mesma pergunta com duas
 * respostas.
 */
export const JANELA_DO_CONSUMO_SEMANAS = 8;

/** Para quantos dias a compra sugerida deve durar. */
export const COBERTURA_ALVO_DIAS = 30;

/**
 * Quantas semanas precisam ter movimento para a média valer.
 *
 * Com uma semana só, um pedido grande de uma cliente vira "consumo semanal" e a
 * sugestão manda comprar doze potes de uma pomada que sai um por mês. É o mesmo
 * critério de `VISITAS_PARA_TER_CICLO`: um dado não é um ritmo.
 */
export const SEMANAS_COM_MOVIMENTO_MINIMAS = 3;

export interface ConsumoMedido {
  readonly produtoId: string;
  readonly nome: string;
  readonly saldo: number;
  /** Unidades que **saíram** na janela — venda, consumo interno e perda. */
  readonly saidasNaJanela: number;
  /** Em quantas semanas distintas houve saída. Abaixo do mínimo, não há ritmo. */
  readonly semanasComSaida: number;
}

export interface PrevisaoDoProduto {
  readonly produtoId: string;
  readonly nome: string;
  readonly saldo: number;
  /** Unidades por dia, derivado da janela inteira. */
  readonly porDia: number;
  /** Nulo quando não há ritmo, ou quando ainda não há saída nenhuma. */
  readonly diasAteAcabar: number | null;
  /** Quanto comprar para cobrir a janela alvo. Zero quando já cobre. */
  readonly comprar: number;
}

/**
 * Quanto tempo o que está na prateleira ainda dura, e quanto comprar.
 *
 * O relógio **não** entra aqui: a janela já foi recortada por quem leu o banco,
 * e o que chega é a contagem. Uma função que lê `Date` para prever consumo é
 * exatamente o teste que passa hoje e falha depois de amanhã.
 */
export function preverConsumo(medido: ConsumoMedido): PrevisaoDoProduto {
  const semRitmo: PrevisaoDoProduto = {
    produtoId: medido.produtoId,
    nome: medido.nome,
    saldo: medido.saldo,
    porDia: 0,
    diasAteAcabar: null,
    comprar: 0,
  };

  if (medido.saidasNaJanela <= 0) return semRitmo;
  if (medido.semanasComSaida < SEMANAS_COM_MOVIMENTO_MINIMAS) return semRitmo;

  /**
   * O divisor é a **janela inteira**, não as semanas em que houve saída.
   *
   * Dividir só pelas semanas com movimento responde "quanto sai quando sai", e a
   * pergunta é "quanto sai por dia". Um produto que vende três numa semana e
   * zero nas outras sete dura muito mais do que a primeira conta diria — e a
   * sugestão mandaria comprar oito vezes o necessário.
   */
  const porDia = medido.saidasNaJanela / (JANELA_DO_CONSUMO_SEMANAS * 7);

  /**
   * Arredondado para baixo, e é o lado seguro.
   *
   * "Acaba em 9 dias" quando na verdade acaba em 9,7 faz a compra sair um dia
   * antes; o contrário faz a barbearia descobrir a falta com a cliente na
   * cadeira. Errar para menos no prazo é errar para mais na antecedência.
   */
  const diasAteAcabar = Math.max(0, Math.floor(medido.saldo / porDia));

  /**
   * A compra cobre a janela alvo **descontando o que já existe**, e é sempre
   * unidade inteira para cima: ninguém compra 3,4 potes de pomada.
   */
  const precisa = porDia * COBERTURA_ALVO_DIAS;
  const comprar = Math.max(0, Math.ceil(precisa - medido.saldo));

  return {
    produtoId: medido.produtoId,
    nome: medido.nome,
    saldo: medido.saldo,
    porDia,
    diasAteAcabar,
    comprar,
  };
}

/**
 * O que vai acabar antes de `dias`, do mais urgente para o menos.
 *
 * Quem não tem previsão fica **de fora**, e não no fim: numa lista ordenada por
 * urgência, "não sei" com cara de "está tranquilo" é pior que a ausência — o
 * dono lê a lista inteira e conclui que o estoque está saudável.
 */
export function oQueVaiAcabar(
  previsoes: readonly PrevisaoDoProduto[],
  dias: number,
): readonly PrevisaoDoProduto[] {
  return previsoes
    .filter((p) => p.diasAteAcabar !== null && p.diasAteAcabar <= dias)
    .sort(
      (a, b) =>
        (a.diasAteAcabar ?? 0) - (b.diasAteAcabar ?? 0) || a.nome.localeCompare(b.nome, 'pt-BR'),
    );
}
