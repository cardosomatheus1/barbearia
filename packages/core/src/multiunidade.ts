/**
 * Multiunidade (bloco 58, SPEC §1.1 e §1.3).
 *
 * O produto sempre teve `locations` e sempre operou como se houvesse uma. Este
 * arquivo escreve o que muda quando há duas — e o que **não** muda.
 *
 * ## A pergunta que a seleção responde
 *
 * "Em qual loja eu estou agora?" O balcão precisa de uma resposta única: caixa,
 * comanda e agenda são de uma unidade, e uma tela que somasse duas faria a
 * recepção fechar o caixa da loja errada.
 *
 * O relatório é o oposto: o dono quer as duas juntas. Por isso `TODAS` é um
 * valor legítimo da seleção **de leitura**, e nunca da seleção de operação.
 */

/** A escolha de leitura: uma unidade, ou o consolidado. */
export const TODAS_AS_UNIDADES = 'todas' as const;
export type EscolhaDeUnidade = string | typeof TODAS_AS_UNIDADES;

export function ehConsolidado(escolha: EscolhaDeUnidade): boolean {
  return escolha === TODAS_AS_UNIDADES;
}

export interface UnidadeNaSelecao {
  readonly id: string;
  readonly nome: string;
  readonly ativa: boolean;
}

export type FalhaDaSelecao = 'sem_unidade' | 'unidade_desconhecida' | 'unidade_fechada';

export const EXPLICACAO_DA_SELECAO: Readonly<Record<FalhaDaSelecao, string>> = {
  sem_unidade: 'Sua conta não está ligada a nenhuma unidade. Fale com quem administra.',
  unidade_desconhecida: 'Esta unidade não existe ou não é sua.',
  unidade_fechada: 'Esta unidade está fechada. Escolha outra.',
};

/**
 * Qual unidade a sessão está operando.
 *
 * A lista de autorizadas vazia significa **todas** — é o caso do dono e de toda
 * barbearia de uma loja só. Negar por omissão trancaria a equipe inteira para
 * fora no dia da migração, e o que a pessoa *pode fazer* continua saindo das
 * permissões: isto decide apenas *onde*.
 *
 * Sem escolha, cai na primeira aberta. É o comportamento que o produto sempre
 * teve — `primaryLocation` — e mantê-lo é o que faz a barbearia de uma unidade
 * não notar que este bloco existiu.
 */
export function resolverUnidade(params: {
  readonly escolhida: string | null;
  readonly disponiveis: readonly UnidadeNaSelecao[];
  /** Vazio significa "todas". */
  readonly autorizadas: readonly string[];
}): { readonly unidade: UnidadeNaSelecao } | { readonly falha: FalhaDaSelecao } {
  const podeVer = (id: string) =>
    params.autorizadas.length === 0 || params.autorizadas.includes(id);

  const minhas = params.disponiveis.filter((u) => podeVer(u.id));
  const abertas = minhas.filter((u) => u.ativa);

  if (minhas.length === 0) return { falha: 'sem_unidade' };

  if (params.escolhida) {
    const achada = minhas.find((u) => u.id === params.escolhida);
    if (!achada) return { falha: 'unidade_desconhecida' };
    /**
     * A loja fechada não é escolhível, mas o histórico dela é legível.
     *
     * Operar numa unidade fechada abriria caixa e venderia numa loja que não
     * existe mais. Ler o relatório dela é outra coisa, e passa pelo consolidado.
     */
    if (!achada.ativa) return { falha: 'unidade_fechada' };
    return { unidade: achada };
  }

  const primeira = abertas[0];
  if (!primeira) return { falha: 'unidade_fechada' };
  return { unidade: primeira };
}

/** Quem pode escolher entre duas ou mais vê o seletor; quem tem uma, não. */
export function precisaEscolher(disponiveis: readonly UnidadeNaSelecao[]): boolean {
  return disponiveis.filter((u) => u.ativa).length > 1;
}

// ---------------------------------------------------------------------------
// A transferência de estoque
// ---------------------------------------------------------------------------

export type FalhaDaTransferencia =
  | 'mesma_unidade'
  | 'quantidade_invalida'
  | 'saldo_insuficiente'
  | 'unidade_fechada';

export const EXPLICACAO_DA_TRANSFERENCIA: Readonly<Record<FalhaDaTransferencia, string>> = {
  mesma_unidade: 'Escolha duas unidades diferentes.',
  quantidade_invalida: 'A quantidade precisa ser maior que zero.',
  saldo_insuficiente: 'A unidade de origem não tem essa quantidade.',
  unidade_fechada: 'Não dá para movimentar estoque de uma unidade fechada.',
};

/**
 * A transferência é possível?
 *
 * O saldo é conferido **aqui e no banco**: aqui para a mensagem ser útil, lá
 * porque a leitura que decide a gravação precisa travar a linha — e uma
 * cláusula de trava é perdível numa reescrita. É o mesmo par do consumo de
 * pacote no bloco 42.
 */
export function validarTransferencia(params: {
  readonly origemId: string;
  readonly destinoId: string;
  readonly quantidade: number;
  readonly saldoNaOrigem: number;
  readonly origemAberta: boolean;
  readonly destinoAberta: boolean;
}): FalhaDaTransferencia | null {
  if (params.origemId === params.destinoId) return 'mesma_unidade';
  if (!Number.isInteger(params.quantidade) || params.quantidade <= 0) {
    return 'quantidade_invalida';
  }
  if (!params.origemAberta || !params.destinoAberta) return 'unidade_fechada';
  if (params.quantidade > params.saldoNaOrigem) return 'saldo_insuficiente';
  return null;
}
