/**
 * Financeiro: contas a pagar e a receber (bloco 51, SPEC §3.10).
 *
 * *"Módulos: caixa · contas a pagar · contas a receber · transferências ·
 * conciliação · categorias financeiras · centros de custo · DRE gerencial"*
 *
 * ## Uma direção, não duas tabelas
 *
 * "A pagar" e "a receber" têm a mesma forma — vencimento, valor, categoria,
 * quem, pago ou não. O que muda é o sentido, e é isso que `direcao` carrega.
 * Duas tabelas iguais significam duas consultas para "o que vence esta semana"
 * e dois lugares para esquecer de mexer no bloco seguinte.
 *
 * ## Vencido é derivado, nunca coluna
 *
 * Uma coluna `vencida` estaria errada todo minuto entre a virada do dia e a
 * varredura passar — e é justamente aí que alguém abre a tela para ver o que
 * atrasou. É a mesma decisão da publicação de avaliação no bloco 43.
 */

export const DIRECOES_DA_CONTA = ['pagar', 'receber'] as const;
export type DirecaoDaConta = (typeof DIRECOES_DA_CONTA)[number];

export const ROTULO_DA_DIRECAO: Readonly<Record<DirecaoDaConta, string>> = {
  pagar: 'A pagar',
  receber: 'A receber',
};

export const ESTADOS_DA_CONTA = ['aberta', 'paga', 'cancelada'] as const;
export type EstadoDaConta = (typeof ESTADOS_DA_CONTA)[number];

export const ROTULO_DO_ESTADO_DA_CONTA: Readonly<Record<EstadoDaConta, string>> = {
  aberta: 'Em aberto',
  paga: 'Paga',
  cancelada: 'Cancelada',
};

export interface ContaDoFinanceiro {
  readonly estado: EstadoDaConta;
  /** `YYYY-MM-DD`, no calendário da unidade. */
  readonly vencimentoEm: string;
}

/**
 * A conta está vencida?
 *
 * Derivada do dia, e o dia é o **da unidade** — não o instante do processo. Às
 * 22h de Salvador o UTC já virou, e uma conta que vence hoje apareceria como
 * vencida para quem ainda está trabalhando.
 */
export function contaVencida(conta: ContaDoFinanceiro, hojeNaUnidade: string): boolean {
  return conta.estado === 'aberta' && conta.vencimentoEm < hojeNaUnidade;
}

/** Quantos dias faltam (ou passaram, em negativo). */
export function diasAteVencer(vencimentoEm: string, hojeNaUnidade: string): number {
  const de = Date.parse(`${hojeNaUnidade}T00:00:00Z`);
  const ate = Date.parse(`${vencimentoEm}T00:00:00Z`);
  return Math.round((ate - de) / 86_400_000);
}

/**
 * O que a linha diz sobre o prazo, em uma frase.
 *
 * Em `core` e não escrita na tela, como todo vocabulário deste produto: a mesma
 * conta aparece na lista do financeiro e no alerta do painel, e "vence amanhã"
 * num lugar com "1 dia" no outro é o tipo de diferença que faz o dono achar que
 * são duas coisas.
 */
export function fraseDoPrazo(vencimentoEm: string, hojeNaUnidade: string): string {
  const dias = diasAteVencer(vencimentoEm, hojeNaUnidade);
  if (dias < -1) return `Venceu há ${Math.abs(dias)} dias`;
  if (dias === -1) return 'Venceu ontem';
  if (dias === 0) return 'Vence hoje';
  if (dias === 1) return 'Vence amanhã';
  return `Vence em ${dias} dias`;
}

export type ContaFailure =
  | 'valor_invalido'
  | 'descricao_obrigatoria'
  | 'vencimento_invalido'
  | 'conta_nao_aberta'
  | 'valor_pago_invalido';

/**
 * Dá para quitar esta conta com este valor?
 *
 * O valor pago pode ser **diferente** do valor da conta, e isso é o caso comum:
 * o fornecedor deu desconto por pagamento antecipado, ou cobrou juros pelo
 * atraso. O que não pode é ser zero ou negativo — aí não é pagamento.
 *
 * Pagamento parcial **não existe** aqui de propósito. Ele exigiria saldo por
 * conta, e o produto passaria a ter dois lugares que respondem "quanto ainda
 * devo": a conta e o razão. Quem paga metade lança duas contas, que é o que a
 * barbearia já faz no caderno.
 */
export function podeQuitar(params: {
  readonly estado: EstadoDaConta;
  readonly valorPagoCents: number;
}): ContaFailure | null {
  if (params.estado !== 'aberta') return 'conta_nao_aberta';
  if (!Number.isInteger(params.valorPagoCents) || params.valorPagoCents <= 0) {
    return 'valor_pago_invalido';
  }
  return null;
}

export function validarConta(params: {
  readonly descricao: string;
  readonly valorCents: number;
  readonly vencimentoEm: string;
}): ContaFailure | null {
  if (params.descricao.trim().length < 2) return 'descricao_obrigatoria';
  if (!Number.isInteger(params.valorCents) || params.valorCents <= 0) return 'valor_invalido';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(params.vencimentoEm)) return 'vencimento_invalido';
  return null;
}

export interface ResumoDoFinanceiro {
  readonly aPagarCents: number;
  readonly aReceberCents: number;
  readonly vencidoAPagarCents: number;
  readonly vencidoAReceberCents: number;
  /** O que sobra se tudo o que está em aberto for pago e recebido. */
  readonly saldoProjetadoCents: number;
}

/**
 * O resumo que abre a tela.
 *
 * `saldoProjetado` é a subtração, e ela existe porque é a pergunta que o dono
 * faz de verdade: *"se eu pagar tudo que devo e receber tudo que me devem, sobra
 * quanto?"*. Mostrar as duas colunas sem a diferença deixa a conta para ele
 * fazer de cabeça, e é exatamente a conta que ele erra.
 */
export function resumoDoFinanceiro(
  contas: readonly (ContaDoFinanceiro & {
    readonly direcao: DirecaoDaConta;
    readonly valorCents: number;
  })[],
  hojeNaUnidade: string,
): ResumoDoFinanceiro {
  const abertas = contas.filter((c) => c.estado === 'aberta');

  const somar = (
    direcao: DirecaoDaConta,
    filtro: (c: (typeof abertas)[number]) => boolean = () => true,
  ) =>
    abertas
      .filter((c) => c.direcao === direcao && filtro(c))
      .reduce((soma, c) => soma + c.valorCents, 0);

  const aPagarCents = somar('pagar');
  const aReceberCents = somar('receber');

  return {
    aPagarCents,
    aReceberCents,
    vencidoAPagarCents: somar('pagar', (c) => contaVencida(c, hojeNaUnidade)),
    vencidoAReceberCents: somar('receber', (c) => contaVencida(c, hojeNaUnidade)),
    saldoProjetadoCents: aReceberCents - aPagarCents,
  };
}

// ---------------------------------------------------------------------------
// O limite de fiado
// ---------------------------------------------------------------------------

/**
 * O teto de crédito que a casa dá a um cliente.
 *
 * A coluna existe desde o bloco 18 e **nascia em zero sem nenhuma tela que a
 * escrevesse**: toda venda fiada era recusada por estourar um limite que ninguém
 * conseguia levantar. Era o defeito de `blocks` outra vez, e custava uma
 * funcionalidade que a SPEC §3.10 marca como *"obrigatória para migrar"* do
 * incumbente.
 *
 * O teto do teto é decisão de produto: cinquenta mil reais de fiado numa
 * barbearia é erro de digitação, e o dia em que não for, a conversa é outra.
 */
export const LIMITE_MAXIMO_DE_FIADO_CENTS = 5_000_000;

export function validarLimiteDeFiado(centavos: number): ContaFailure | null {
  if (
    !Number.isInteger(centavos)
    || centavos < 0
    || centavos > LIMITE_MAXIMO_DE_FIADO_CENTS
  ) {
    return 'valor_invalido';
  }
  return null;
}
