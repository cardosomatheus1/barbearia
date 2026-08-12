/**
 * Split de pagamento (bloco 49, SPEC §3.5).
 *
 * ```
 * Pagamento           R$ 100,00
 * ├── Barbearia       R$  55,00
 * ├── Profissional    R$  40,00
 * └── Plataforma      R$   5,00
 * ```
 *
 * ## A frase que decide o desenho inteiro
 *
 * *"Split é **derivado da comissão**, nunca configurado em paralelo — duas
 * fontes de verdade para o mesmo número é bug garantido."*
 *
 * Por isso este arquivo não tem nenhuma alíquota de profissional. O que ele
 * recebe é a **comissão já calculada** por `comissaoPorItem` — a mesma função
 * que a margem por serviço usa desde o bloco 44 — e o que ele faz é repartir o
 * pagamento em três, garantindo que a soma seja exata.
 *
 * ## Por que a comissão do split é a do item, e não a do período
 *
 * Faixa progressiva depende do acumulado do mês, e o split acontece no
 * **instante do pagamento**: não existe "a comissão deste corte" numa regra
 * progressiva até o mês fechar. `comissaoPorItem` já resolveu essa tensão uma
 * vez, rateando a comissão da regra pelo peso da base de cada lançamento, e a
 * escolha está escrita lá.
 *
 * A consequência é honesta e precisa ser dita: num mês em que a faixa sobe, o
 * que foi repassado na hora fica **abaixo** do que o fechamento apura. A
 * diferença é acerto no fechamento, não erro de split — e é por isso que o
 * fechamento continua sendo a fonte do que o barbeiro recebe no mês.
 *
 * ## A barbearia é a residual, e é ela que absorve a taxa do adquirente
 *
 * O adquirente cobra antes de repartir. Se a plataforma e o profissional
 * recebessem sobre o bruto e a casa ficasse com o resto **menos** a taxa, a
 * conta poderia ficar negativa — e a casa descobriria isso no extrato. Aqui a
 * casa é quem sobra: ela recebe o pagamento menos as outras duas partes, e é
 * dela a decisão de absorver ou ratear a taxa, que já existe desde o bloco 36.
 */

export const PARTES_DO_SPLIT = ['barbearia', 'profissional', 'plataforma'] as const;
export type ParteDoSplit = (typeof PARTES_DO_SPLIT)[number];

export const ROTULO_DA_PARTE: Readonly<Record<ParteDoSplit, string>> = {
  barbearia: 'Barbearia',
  profissional: 'Profissional',
  plataforma: 'Plataforma',
};

export interface FatiaDoSplit {
  readonly parte: ParteDoSplit;
  /** Preenchido só quando a parte é de um profissional. */
  readonly professionalId?: string | undefined;
  readonly valorCents: number;
}

export type SplitFailure =
  | 'valor_invalido'
  | 'comissao_maior_que_o_pagamento'
  | 'aliquota_invalida';

export interface DecisaoDoSplit {
  readonly fatias: readonly FatiaDoSplit[];
  readonly recusa?: SplitFailure;
}

/**
 * Reparte um pagamento entre a casa, quem atendeu e a plataforma.
 *
 * A ordem dos cálculos é decisão, não acaso:
 *
 * 1. **A plataforma primeiro**, sobre o valor cheio. É a receita contratada, e
 *    ela não pode variar com quantos barbeiros atenderam a mesma comanda.
 * 2. **Os profissionais depois**, com a comissão que já foi calculada.
 * 3. **A casa por último**, com o que sobrou.
 *
 * Inverter a ordem — a casa levando um percentual e o resto sendo repartido —
 * faria a comissão do barbeiro depender do que sobrou, que é exatamente a
 * "segunda fonte de verdade" que a SPEC proíbe.
 */
export function calcularSplit(params: {
  readonly pagamentoCents: number;
  /** A comissão já apurada de cada profissional nesta venda. */
  readonly comissoes: readonly { readonly professionalId: string; readonly valorCents: number }[];
  readonly plataformaBps: number;
}): DecisaoDoSplit {
  if (!Number.isInteger(params.pagamentoCents) || params.pagamentoCents <= 0) {
    return { fatias: [], recusa: 'valor_invalido' };
  }
  if (
    !Number.isInteger(params.plataformaBps)
    || params.plataformaBps < 0
    || params.plataformaBps > 3000
  ) {
    return { fatias: [], recusa: 'aliquota_invalida' };
  }

  const daPlataforma = Math.round((params.pagamentoCents * params.plataformaBps) / 10_000);

  /**
   * Comissão de valor não positivo não vira fatia.
   *
   * Um repasse de zero centavos é uma chamada ao adquirente que ele recusa, e
   * uma linha no extrato do barbeiro dizendo que ele recebeu nada — que é pior
   * que não ter linha. Comissão negativa (estorno) não é split: ela é acerto no
   * fechamento, porque o dinheiro desta venda já foi.
   */
  const doProfissional = params.comissoes.filter((c) => c.valorCents > 0);
  const somaDasComissoes = doProfissional.reduce((soma, c) => soma + c.valorCents, 0);

  if (daPlataforma + somaDasComissoes > params.pagamentoCents) {
    /**
     * A casa ficaria devendo, e o adquirente recusaria a chamada inteira.
     *
     * Acontece de verdade: comissão de 100% num serviço, ou uma comanda paga
     * pela metade em dinheiro e metade no Pix — a comissão é da venda inteira e
     * o pagamento é só de um pedaço. Quem chama decide o que fazer; o que este
     * arquivo não faz é inventar um número que feche.
     */
    return { fatias: [], recusa: 'comissao_maior_que_o_pagamento' };
  }

  const daCasa = params.pagamentoCents - daPlataforma - somaDasComissoes;

  const fatias: FatiaDoSplit[] = [];
  if (daPlataforma > 0) fatias.push({ parte: 'plataforma', valorCents: daPlataforma });
  for (const comissao of doProfissional) {
    fatias.push({
      parte: 'profissional',
      professionalId: comissao.professionalId,
      valorCents: comissao.valorCents,
    });
  }
  // A casa entra mesmo com zero: é ela que responde "para onde foi o resto", e
  // uma comanda sem a linha dela parece split incompleto para quem lê.
  fatias.push({ parte: 'barbearia', valorCents: daCasa });

  return { fatias };
}

/**
 * A soma das fatias é o pagamento?
 *
 * Existe como função e não como comentário porque é a invariante que o
 * adquirente cobra: um centavo a mais e ele recusa a chamada inteira; um a
 * menos e o troco fica preso na conta da plataforma para sempre. É conferida
 * antes de gravar e há `CHECK` no banco atrás dela.
 */
export function splitFecha(
  pagamentoCents: number,
  fatias: readonly FatiaDoSplit[],
): boolean {
  return fatias.reduce((soma, f) => soma + f.valorCents, 0) === pagamentoCents;
}

/**
 * O que a barbearia recebe de fato, depois da taxa do adquirente.
 *
 * Separado do split porque são duas perguntas: o split diz **para quem** o
 * adquirente manda; isto diz **quanto entra na conta da casa**. A taxa sai do
 * pedaço da casa porque é ela a residual — e é ela quem já decidia, desde o
 * bloco 36, se absorve ou rateia.
 */
export function liquidoDaCasa(params: {
  readonly fatias: readonly FatiaDoSplit[];
  readonly taxaDoAdquirenteCents: number;
}): number {
  const daCasa = params.fatias
    .filter((f) => f.parte === 'barbearia')
    .reduce((soma, f) => soma + f.valorCents, 0);
  return daCasa - params.taxaDoAdquirenteCents;
}

export const ESTADOS_DO_SPLIT = [
  'pendente',
  'retido',
  'liquidado',
  'falhou',
  'estornado',
] as const;
export type EstadoDoSplit = (typeof ESTADOS_DO_SPLIT)[number];

/**
 * O que cada estado quer dizer para quem lê a tela.
 *
 * Em `core` como todo vocabulário de transição (§6 do CLAUDE.md): o balcão, o
 * extrato do barbeiro e o painel da plataforma leem os mesmos três estados, e
 * três textos diferentes é como "retido" vira "não pagaram o Ruan".
 */
export const ROTULO_DO_SPLIT: Readonly<Record<EstadoDoSplit, string>> = {
  pendente: 'A repassar',
  retido: 'Ficou com a casa',
  liquidado: 'Repassado',
  falhou: 'Falhou no repasse',
  estornado: 'Estornado',
};

export const EXPLICACAO_DO_SPLIT: Readonly<Record<EstadoDoSplit, string>> = {
  pendente: 'O adquirente ainda não transferiu esta parte.',
  retido:
    'O profissional ainda não tem cadastro aprovado no adquirente, então o valor caiu inteiro na '
    + 'conta da barbearia. A comissão dele é paga no fechamento, como sempre foi.',
  liquidado: 'O adquirente transferiu para a conta desta parte.',
  falhou: 'O adquirente recusou a transferência. O valor continua com a barbearia.',
  estornado: 'A venda foi estornada e esta parte foi desfeita.',
};

/** Estados em que o dinheiro **não** foi para a conta da parte. */
export const ESTADOS_QUE_FICARAM_NA_CASA: readonly EstadoDoSplit[] = [
  'retido',
  'falhou',
  'estornado',
];
