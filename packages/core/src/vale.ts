/**
 * Vale / adiantamento ao profissional (bloco 52, SPEC §3.10).
 *
 * *"Adiantamento ao profissional, descontado da comissão do período. Também
 * presente no incumbente e usado de verdade."*
 *
 * ## O vale é empréstimo, não despesa
 *
 * O dinheiro sai da gaveta na quarta e volta como desconto no fechamento do mês.
 * Por isso ele **não** entra no DRE como custo: o custo é a comissão inteira, e
 * o vale só muda por onde ela é paga. Lançá-lo como despesa contaria o mesmo
 * dinheiro duas vezes — uma quando saiu, outra quando a comissão fechou.
 */

export const ESTADOS_DO_VALE = ['aberto', 'descontado', 'cancelado'] as const;
export type EstadoDoVale = (typeof ESTADOS_DO_VALE)[number];

export const ROTULO_DO_VALE: Readonly<Record<EstadoDoVale, string>> = {
  aberto: 'A descontar',
  descontado: 'Descontado',
  cancelado: 'Cancelado',
};

export type ValeFailure =
  | 'valor_invalido'
  | 'motivo_obrigatorio'
  | 'vale_maior_que_a_comissao'
  | 'vale_nao_aberto';

/**
 * Dá para adiantar este valor?
 *
 * O teto é **o que ele já fez no período aberto**, menos o que já pegou. Não é
 * conservadorismo: o vale ou é descontado inteiro no fechamento ou não é, e não
 * existe consumo parcial. Adiantar mais do que a comissão acumulada produziria
 * um fechamento que paga zero e deixa a diferença sem mecanismo nenhum de
 * cobrança — a barbearia descobriria a perda meses depois, quando o barbeiro já
 * tivesse saído.
 *
 * O número entra na mensagem porque a pergunta seguinte do balcão é sempre
 * *"então até quanto dá?"*, e uma recusa sem o teto obriga a tentar por
 * aproximação.
 */
export function podeAdiantar(params: {
  readonly valorCents: number;
  /** Comissão acumulada no período aberto, já com estornos. */
  readonly comissaoAcumuladaCents: number;
  /** Soma dos vales ainda não descontados. */
  readonly jaAdiantadoCents: number;
}): ValeFailure | null {
  if (!Number.isInteger(params.valorCents) || params.valorCents <= 0) return 'valor_invalido';
  if (params.valorCents > disponivelParaAdiantar(params)) return 'vale_maior_que_a_comissao';
  return null;
}

export function disponivelParaAdiantar(params: {
  readonly comissaoAcumuladaCents: number;
  readonly jaAdiantadoCents: number;
}): number {
  return Math.max(0, params.comissaoAcumuladaCents - params.jaAdiantadoCents);
}

/**
 * O que sobra para o profissional no acerto.
 *
 * Nunca negativo: o vale é limitado pela comissão acumulada na hora de conceder,
 * mas um estorno lançado **depois** pode derrubar a comissão abaixo do que já
 * foi adiantado. Nesse caso o acerto é zero e a diferença fica registrada — e é
 * ela que a tela do fechamento precisa mostrar, porque é a conversa que o dono
 * vai ter.
 */
export function acertoDoProfissional(params: {
  readonly comissaoCents: number;
  readonly valeCents: number;
}): { readonly liquidoCents: number; readonly aindaDeveCents: number } {
  const liquido = params.comissaoCents - params.valeCents;
  return {
    liquidoCents: Math.max(0, liquido),
    aindaDeveCents: Math.max(0, -liquido),
  };
}

export function validarMotivoDoVale(motivo: string | null | undefined): ValeFailure | null {
  // Motivo é opcional ao conceder — "vale" já diz o que é — e obrigatório ao
  // cancelar, que é dinheiro que saiu e voltou sem passar pela folha.
  if (motivo !== null && motivo !== undefined && motivo.trim().length > 0
      && motivo.trim().length < 3) {
    return 'motivo_obrigatorio';
  }
  return null;
}

// ---------------------------------------------------------------------------
// O estorno de uma venda
// ---------------------------------------------------------------------------

export type EstornoFailure =
  | 'venda_nao_encontrada'
  | 'venda_nao_paga'
  | 'ja_estornada'
  | 'motivo_obrigatorio'
  | 'periodo_fechado';

/**
 * Dá para desfazer esta venda?
 *
 * Só a venda **paga** se estorna: a aberta se cancela e a cancelada nunca
 * cobrou ninguém. Estornar a segunda seria devolver dinheiro que não entrou.
 *
 * O motivo é obrigatório e tem piso: "por que devolveram os R$ 90 do sábado?" é
 * a pergunta que chega na segunda-feira, e um campo vazio a deixa sem resposta
 * para sempre — a venda estornada é imutável depois.
 */
export function podeEstornar(params: {
  readonly estado: 'open' | 'paid' | 'cancelled' | 'refunded';
  readonly motivo: string;
}): EstornoFailure | null {
  if (params.estado === 'refunded') return 'ja_estornada';
  if (params.estado !== 'paid') return 'venda_nao_paga';
  if (params.motivo.trim().length < 3) return 'motivo_obrigatorio';
  return null;
}
