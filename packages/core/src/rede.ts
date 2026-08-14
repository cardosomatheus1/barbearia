/**
 * Indicadores consolidados de uma rede de franquia (bloco 77).
 *
 * ## O que este arquivo decide
 *
 * Como se compara uma franqueada com a rede, e o que cada lado tem direito de
 * ver. Não vai ao banco, não sabe o que é RLS, e é aqui que a conta mora —
 * porque a alternativa era escrevê-la dentro da função SQL, e regra de negócio
 * não mora em SQL.
 *
 * ## Duas leituras da mesma lista
 *
 * A **franqueadora** recebe a rede nomeada: é o trabalho dela, e o contrato de
 * franquia lhe dá a receita de cada unidade — royalty é percentual sobre venda.
 *
 * A **franqueada** recebe os próprios números e a mediana da rede, sem nome
 * nenhum. É o mesmo princípio do indicador do barbeiro (SPEC §4.21), que se
 * compara com o próprio passado e não com o colega — e aqui pesa mais, porque
 * as partes são empresas concorrentes entre si dentro da mesma marca.
 */

/**
 * Quantas franqueadas a rede precisa ter para a mediana significar alguma coisa.
 *
 * Com três, "a mediana da rede" é uma frase sobre duas empresas, e quem lê
 * consegue deduzir o número da vizinha por subtração. Abaixo do mínimo a
 * estatística é `null`, nunca um número — mesma regra do ciclo do cliente.
 */
export const MINIMO_PARA_COMPARAR_REDE = 4;

export interface UnidadeDaRede {
  /** Nulo quando quem pergunta é franqueada e a linha não é dela. */
  readonly tenantId: string | null;
  readonly nome: string | null;
  readonly eu: boolean;
  readonly receitaCents: number;
  readonly vendas: number;
  readonly atendimentos: number;
  readonly metaCents: number | null;
}

export interface LinhaDaRede extends UnidadeDaRede {
  /** Soma sobre contagem, nunca a média das fatias. */
  readonly ticketMedioCents: number | null;
  /**
   * Quanto da meta foi feito, em pontos-base. `null` quando não há meta — que é
   * diferente de zero por cento, e a tela mostra a diferença.
   */
  readonly progressoBps: number | null;
}

export interface Rede {
  readonly linhas: readonly LinhaDaRede[];
  readonly receitaTotalCents: number;
  readonly vendasTotais: number;
  /** Soma sobre contagem da rede inteira, nunca a média dos tickets. */
  readonly ticketMedioCents: number | null;
  /** `null` abaixo de `MINIMO_PARA_COMPARAR_REDE`. */
  readonly medianaDaReceitaCents: number | null;
  /** Quantas unidades bateram a meta. `null` quando nenhuma tem meta. */
  readonly bateramAMeta: number | null;
}

function ticket(receitaCents: number, vendas: number): number | null {
  // Divisão com denominador zero num relatório devolve `null`, nunca
  // `Infinity`: é o mês em que a unidade abriu, e é quando o dono abre a tela.
  if (vendas <= 0) return null;
  return Math.round(receitaCents / vendas);
}

/**
 * A mediana, e não a média.
 *
 * Uma franqueada de shopping com o triplo do faturamento puxa a média da rede
 * para cima e faz metade das unidades parecer abaixo do normal. A mediana é
 * quem a rede é — mesma decisão do ciclo do cliente no bloco 62.
 */
function mediana(valores: readonly number[]): number | null {
  if (valores.length === 0) return null;
  const ordenados = [...valores].sort((a, b) => a - b);
  const meio = Math.floor(ordenados.length / 2);
  if (ordenados.length % 2 === 1) return ordenados[meio] ?? null;
  const a = ordenados[meio - 1];
  const b = ordenados[meio];
  if (a === undefined || b === undefined) return null;
  return Math.round((a + b) / 2);
}

export function consolidar(unidades: readonly UnidadeDaRede[]): Rede {
  const linhas = unidades.map((u): LinhaDaRede => ({
    ...u,
    ticketMedioCents: ticket(u.receitaCents, u.vendas),
    progressoBps:
      u.metaCents && u.metaCents > 0
        ? Math.round((u.receitaCents * 10_000) / u.metaCents)
        : null,
  }));

  const receitaTotalCents = linhas.reduce((s, l) => s + l.receitaCents, 0);
  const vendasTotais = linhas.reduce((s, l) => s + l.vendas, 0);

  const comMeta = linhas.filter((l) => l.progressoBps !== null);

  return {
    linhas,
    receitaTotalCents,
    vendasTotais,
    ticketMedioCents: ticket(receitaTotalCents, vendasTotais),
    medianaDaReceitaCents:
      linhas.length >= MINIMO_PARA_COMPARAR_REDE
        ? mediana(linhas.map((l) => l.receitaCents))
        : null,
    bateramAMeta:
      comMeta.length === 0 ? null : comMeta.filter((l) => (l.progressoBps ?? 0) >= 10_000).length,
  };
}

export interface MeuLugarNaRede {
  readonly minha: LinhaDaRede;
  /** `null` abaixo do mínimo — e é diferente de "estou na mediana". */
  readonly medianaDaReceitaCents: number | null;
  /**
   * Em que ponto da rede ela está, de 0 a 100. `null` pelo mesmo motivo.
   *
   * Percentil e não posição: "você está acima de 70% da rede" não identifica
   * ninguém, e "3º de 8" convida a perguntar quem são os dois primeiros.
   */
  readonly percentil: number | null;
}

/**
 * O que a franqueada vê: os próprios números contra a rede, sem nomes.
 *
 * Devolve `null` quando a lista não tem a linha dela — o que só acontece se
 * quem perguntou não é franqueada, e aí a resposta certa é não ter resposta.
 */
export function meuLugarNaRede(unidades: readonly UnidadeDaRede[]): MeuLugarNaRede | null {
  const rede = consolidar(unidades);
  const minha = rede.linhas.find((l) => l.eu);
  if (!minha) return null;

  const bastante = rede.linhas.length >= MINIMO_PARA_COMPARAR_REDE;
  const abaixo = rede.linhas.filter((l) => l.receitaCents < minha.receitaCents).length;

  return {
    minha,
    medianaDaReceitaCents: rede.medianaDaReceitaCents,
    percentil: bastante ? Math.round((abaixo * 100) / rede.linhas.length) : null,
  };
}
