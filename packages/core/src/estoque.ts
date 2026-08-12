/**
 * Produtos, estoque, ficha técnica e margem de contribuição (bloco 44,
 * SPEC §3.7 e §3.8).
 *
 * ## Estoque é saldo derivado, nunca campo editado
 *
 * A SPEC escreve isso em uma linha, e é a decisão que dá nome ao bloco: *"Toda
 * movimentação é imutável e auditada. Estoque é **saldo derivado** do
 * movimento, nunca campo editado direto."*
 *
 * Um contador `estoque = 12` responde "quantos tem" e nada mais. A pergunta que
 * chega no balcão é outra — *"por que só tem 12 se eu comprei 20?"* —, e ela só
 * tem resposta se cada entrada, venda, consumo e perda for uma linha. É a mesma
 * decisão do razão do cliente, do extrato de fidelidade e de `package_uses`.
 *
 * ## Revenda e consumo interno são coisas diferentes
 *
 * A pomada que o cliente leva baixa **na venda**; o shampoo que o barbeiro usa
 * baixa **por ficha técnica**, quando o serviço é executado. Sem a distinção não
 * existe margem real: o shampoo viraria receita zero e custo nenhum, e o corte
 * pareceria render mais do que rende.
 *
 * ## O custo é congelado no movimento
 *
 * A pomada comprada a R$ 12 em janeiro e a R$ 18 em março não é a mesma pomada
 * para efeito de CMV. Recalcular a margem de janeiro com o preço de março faria
 * o resultado do mês mudar depois de fechado — é o mesmo raciocínio da regra de
 * comissão copiada no lançamento e da taxa do adquirente congelada na venda.
 */

export const TIPOS_DE_PRODUTO = ['resale', 'internal'] as const;
export type TipoDeProduto = (typeof TIPOS_DE_PRODUTO)[number];

export const ROTULO_DO_TIPO_DE_PRODUTO: Readonly<Record<TipoDeProduto, string>> = {
  resale: 'Vende para o cliente',
  internal: 'Usa no atendimento',
};

/** A lista da SPEC §3.7, e nada além dela. */
export const TIPOS_DE_MOVIMENTO_DE_ESTOQUE = [
  'entrada',
  'saida',
  'venda',
  'consumo',
  'perda',
  'ajuste',
  'transferencia',
] as const;
export type TipoDeMovimentoDeEstoque = (typeof TIPOS_DE_MOVIMENTO_DE_ESTOQUE)[number];

export const ROTULO_DO_MOVIMENTO_DE_ESTOQUE: Readonly<Record<TipoDeMovimentoDeEstoque, string>> = {
  entrada: 'Entrada',
  saida: 'Saída',
  venda: 'Venda',
  consumo: 'Consumo no atendimento',
  perda: 'Perda',
  ajuste: 'Ajuste de contagem',
  transferencia: 'Transferência',
};

/**
 * Quais movimentos somam e quais subtraem.
 *
 * `ajuste` e `transferencia` são os dois que andam nos dois sentidos, e por isso
 * guardam a quantidade **com sinal**. Os outros cinco têm direção fixa: uma
 * "perda de −3" seria uma perda que aumenta o estoque, e a única leitura
 * possível disso é erro de digitação.
 */
export const MOVIMENTO_DE_ESTOQUE_COM_SINAL_LIVRE: readonly TipoDeMovimentoDeEstoque[] = ['ajuste', 'transferencia'];

export const DIRECAO_DO_MOVIMENTO_DE_ESTOQUE: Readonly<Record<TipoDeMovimentoDeEstoque, 1 | -1 | 0>> = {
  entrada: 1,
  saida: -1,
  venda: -1,
  consumo: -1,
  perda: -1,
  ajuste: 0,
  transferencia: 0,
};

export interface MovimentoDeEstoque {
  readonly tipo: TipoDeMovimentoDeEstoque;
  /** Sempre positiva, exceto em `ajuste` e `transferencia`. */
  readonly quantidade: number;
}

/**
 * Quanto o movimento muda o saldo.
 *
 * A conta é feita aqui e não no banco porque é regra de negócio: o dia em que
 * `transferencia` deixar de ser neutra para a unidade de origem, a mudança é de
 * uma linha, num arquivo sem banco e sem rede.
 */
export function efeitoNoSaldo(movimento: MovimentoDeEstoque): number {
  const direcao = DIRECAO_DO_MOVIMENTO_DE_ESTOQUE[movimento.tipo];
  if (direcao === 0) return movimento.quantidade;
  return direcao * Math.abs(movimento.quantidade);
}

export function saldoDoProduto(movimentos: readonly MovimentoDeEstoque[]): number {
  return movimentos.reduce((soma, m) => soma + efeitoNoSaldo(m), 0);
}

export type RecusaDoMovimento =
  | 'quantidade_invalida'
  | 'sinal_invalido'
  | 'saldo_insuficiente'
  | 'motivo_obrigatorio';

/**
 * Este movimento pode ser gravado?
 *
 * **Saldo negativo é recusado**, e é decisão: um estoque em −3 significa que
 * alguém vendeu o que não existe, e o número que sai dali contamina o CMV do mês
 * inteiro. A barbearia que encontrou três a mais na gaveta registra `ajuste`, que
 * é a operação escrita para isso — e que exige motivo.
 *
 * `perda` e `ajuste` exigem motivo escrito pelo mesmo raciocínio do override de
 * confiabilidade: são as duas em que o número muda sem nota fiscal nem venda, e
 * "sumiu" não é registro de nada.
 */
export function validarMovimento(params: {
  readonly tipo: TipoDeMovimentoDeEstoque;
  readonly quantidade: number;
  readonly saldoAtual: number;
  readonly motivo?: string | null;
}): RecusaDoMovimento | null {
  if (!Number.isInteger(params.quantidade) || params.quantidade === 0) {
    return 'quantidade_invalida';
  }
  if (!MOVIMENTO_DE_ESTOQUE_COM_SINAL_LIVRE.includes(params.tipo) && params.quantidade < 0) {
    return 'sinal_invalido';
  }
  if ((params.tipo === 'perda' || params.tipo === 'ajuste') && !params.motivo?.trim()) {
    return 'motivo_obrigatorio';
  }

  const depois = params.saldoAtual + efeitoNoSaldo({ tipo: params.tipo, quantidade: params.quantidade });
  if (depois < 0) return 'saldo_insuficiente';

  return null;
}

// ---------------------------------------------------------------------------
// Alertas (SPEC §3.7)
// ---------------------------------------------------------------------------

export const DIAS_QUE_AVISAM_VENCIMENTO = 30;

export interface ProdutoEmEstoque {
  readonly id: string;
  readonly nome: string;
  readonly tipo: TipoDeProduto;
  readonly saldo: number;
  readonly minimo: number;
  readonly venceEm: Date | null;
  readonly custoCents: number;
  readonly precoCents: number | null;
}

export const ALERTAS_DE_ESTOQUE = ['abaixo_do_minimo', 'sem_estoque', 'vencendo', 'vencido'] as const;
export type AlertaDeEstoque = (typeof ALERTAS_DE_ESTOQUE)[number];

export const ROTULO_DO_ALERTA: Readonly<Record<AlertaDeEstoque, string>> = {
  sem_estoque: 'Acabou',
  abaixo_do_minimo: 'Abaixo do mínimo',
  vencido: 'Vencido',
  vencendo: 'Vence em breve',
};

/**
 * O que está errado com este produto agora.
 *
 * Ordenado por gravidade, e o primeiro é o que a tela mostra: "acabou" e
 * "abaixo do mínimo" ao mesmo tempo são a mesma notícia, e mostrar as duas faz a
 * lista de alertas ficar duas vezes maior sem dizer nada a mais.
 *
 * `vencido` vem antes de `sem_estoque` de propósito: um vidro vencido na
 * prateleira é um problema **agora**, e vai para o lixo — enquanto "acabou" só
 * atrapalha na próxima venda.
 */
export function alertasDoProduto(
  produto: ProdutoEmEstoque,
  agora: Date,
): readonly AlertaDeEstoque[] {
  const achados: AlertaDeEstoque[] = [];

  if (produto.venceEm && produto.venceEm <= agora && produto.saldo > 0) {
    achados.push('vencido');
  } else if (
    produto.venceEm &&
    produto.saldo > 0 &&
    produto.venceEm.getTime() - agora.getTime() <= DIAS_QUE_AVISAM_VENCIMENTO * 86_400_000
  ) {
    achados.push('vencendo');
  }

  if (produto.saldo <= 0) achados.push('sem_estoque');
  else if (produto.minimo > 0 && produto.saldo <= produto.minimo) achados.push('abaixo_do_minimo');

  return achados;
}

/** Quanto comprar para voltar ao mínimo, com uma folga de uma vez o mínimo. */
export function sugestaoDeCompra(produto: ProdutoEmEstoque): number {
  if (produto.minimo <= 0) return 0;
  const alvo = produto.minimo * 2;
  return Math.max(0, alvo - produto.saldo);
}

// ---------------------------------------------------------------------------
// Ficha técnica e CMV (SPEC §3.8)
// ---------------------------------------------------------------------------

export interface ItemDaFicha {
  readonly produtoId: string;
  readonly nome: string;
  readonly quantidade: number;
  readonly custoUnitarioCents: number;
}

/**
 * Quanto os insumos de um serviço custam.
 *
 * Arredondado para cima, e é de propósito: meio centavo por atendimento some no
 * relatório do dia e reaparece como diferença na conciliação do ano. Errar para
 * mais no custo é errar para menos na margem — que é o lado seguro de errar
 * quando o número decide preço.
 */
export function custoDaFicha(itens: readonly ItemDaFicha[]): number {
  return itens.reduce((soma, item) => soma + Math.ceil(item.quantidade * item.custoUnitarioCents), 0);
}

export interface DecomposicaoDaMargem {
  readonly precoCents: number;
  readonly comissaoCents: number;
  readonly insumosCents: number;
  readonly taxaCents: number;
  readonly custoVariavelCents: number;
  readonly margemCents: number;
  /** Em pontos-base inteiros: 5170 = 51,7%. Nunca fração. */
  readonly margemBps: number;
}

/**
 * A decomposição da SPEC §3.8 — o número que nenhum concorrente analisado mostra.
 *
 * ```
 * Corte                        R$ 60,00
 * Comissão (40%)              −R$ 24,00
 * Consumíveis (ficha técnica) −R$  3,00
 * Taxa de pagamento           −R$  2,00
 * Margem de contribuição       R$ 31,00  (51,7%)
 * ```
 *
 * Os três custos já existiam separados no produto e nunca tinham sido somados:
 * a comissão vem do lançamento (com a regra congelada), a taxa vem de
 * `orders.fee_cents` (congelada na venda), e o insumo é o que este bloco traz.
 *
 * **Margem sobre receita zero é nula, não 100%.** Um corte de cortesia tem
 * margem negativa em reais e percentual nenhum — dividir por zero devolveria
 * infinito, e a tela mostraria "∞%" no serviço que a casa deu de graça.
 */
export function margemDeContribuicao(params: {
  readonly precoCents: number;
  readonly comissaoCents: number;
  readonly insumosCents: number;
  readonly taxaCents: number;
}): DecomposicaoDaMargem {
  const custoVariavelCents = params.comissaoCents + params.insumosCents + params.taxaCents;
  const margemCents = params.precoCents - custoVariavelCents;

  return {
    precoCents: params.precoCents,
    comissaoCents: params.comissaoCents,
    insumosCents: params.insumosCents,
    taxaCents: params.taxaCents,
    custoVariavelCents,
    margemCents,
    margemBps:
      params.precoCents > 0 ? Math.round((margemCents / params.precoCents) * 10_000) : 0,
  };
}

/**
 * O insight que a SPEC nomeia: o serviço caro que rende menos que o barato.
 *
 * Compara por margem **em reais**, não por percentual: o que paga a conta de luz
 * é o dinheiro que sobra, e um serviço de R$ 20 com 80% de margem deixa R$ 16 —
 * menos que um de R$ 60 com 40%, que deixa R$ 24.
 */
export function ordenarPorMargem<T extends { readonly margemCents: number }>(
  linhas: readonly T[],
): readonly T[] {
  return [...linhas].sort((a, b) => b.margemCents - a.margemCents);
}

/** "R$ 31,00 de margem (51,7%)" — o formato que a tela repete. */
export function frasePorcentagem(bps: number): string {
  return `${(bps / 100).toFixed(1).replace('.', ',')}%`;
}
