import {
  aplicarFaixas,
  porCento,
  type FaixaDeComissao,
  type LancamentoDeComissao,
} from './comissao.js';

/**
 * Comissão sobre assinatura (bloco 48, SPEC §3.4).
 *
 * *"É o ponto que mais gera conflito na prática."* A frase é da SPEC, e o
 * conflito é aritmético. O assinante paga R$ 149 e corta quatro vezes no mês:
 *
 * | Modelo | O que a casa paga | O que a casa recebe |
 * |---|---|---|
 * | Por uso, 40% sobre R$ 60 | R$ 96 | R$ 149 |
 * | Por uso, com o assinante entusiasmado (8 cortes) | R$ 192 | R$ 149 |
 * | Rateio da mensalidade, 40% | R$ 59,60 | R$ 149 |
 * | Híbrido, teto de 60% | R$ 89,40 | R$ 149 |
 *
 * A linha do meio é o que mata o clube, e ela não aparece no primeiro mês —
 * aparece quando o assinante aprende que o plano compensa. É por isso que a
 * SPEC pede a **simulação sobre os dados reais do dono** antes de ele escolher:
 * a diferença entre os três modelos não é opinião, é o número dele.
 *
 * ## Por que a conta mora aqui e não no lançamento
 *
 * Rateio e híbrido dependem do **acumulado do período** — quantos atendimentos
 * aquela assinatura teve no mês. Nenhum dos dois se sabe na hora da venda,
 * exatamente como a faixa progressiva. O lançamento guarda de qual assinatura
 * veio e por quanto ela foi vendida; quem aplica o modelo é este arquivo.
 */

export const MODOS_DA_ASSINATURA = ['por_uso', 'rateio', 'hibrido'] as const;
export type ModoDaAssinatura = (typeof MODOS_DA_ASSINATURA)[number];

export const ROTULO_DO_MODO_DA_ASSINATURA: Readonly<Record<ModoDaAssinatura, string>> = {
  por_uso: 'Por atendimento',
  rateio: 'Rateio da mensalidade',
  hibrido: 'Por atendimento, com teto',
};

/**
 * O que cada modelo significa para quem lê a tela.
 *
 * Em `core` e não escrito na tela pelo mesmo motivo do vocabulário de transição
 * (§6 do CLAUDE.md): o dono decide com esta frase, a simulação a repete e o
 * extrato do barbeiro precisa dizer a mesma coisa. Três textos para o mesmo
 * modelo é como a conversa no balcão vira discussão.
 */
export const EXPLICACAO_DO_MODO_DA_ASSINATURA: Readonly<Record<ModoDaAssinatura, string>> = {
  por_uso:
    'O barbeiro ganha a cada atendimento, sobre o preço de tabela do serviço. '
    + 'É o mais simples de explicar — e o único que pode custar mais que a mensalidade.',
  rateio:
    'A mensalidade é dividida entre quem atendeu no mês, na proporção dos atendimentos. '
    + 'A casa nunca paga mais do que recebeu, e quem atendeu mais leva mais.',
  hibrido:
    'Ganha por atendimento, mas o total daquele assinante não passa do teto da mensalidade. '
    + 'Protege a margem sem mudar a conta de quem corta pouco.',
};

/** Um lançamento que veio de um atendimento pago pelo plano. */
export interface LancamentoDaAssinatura extends LancamentoDeComissao {
  readonly assinaturaId: string;
  /** A mensalidade congelada no lançamento. */
  readonly mensalidadeCents: number;
}

export type LancamentoNoPeriodo = LancamentoDeComissao & {
  readonly assinaturaId?: string | undefined;
  readonly mensalidadeCents?: number | undefined;
};

const daAssinatura = (l: LancamentoNoPeriodo): l is LancamentoDaAssinatura =>
  typeof l.assinaturaId === 'string' && typeof l.mensalidadeCents === 'number';

/**
 * Reescreve a base dos lançamentos de assinatura conforme o modelo escolhido.
 *
 * Devolve lançamentos comuns, para que `comissaoDoPeriodo` — que já sabe somar
 * percentual, valor fixo e faixa progressiva — continue sendo o único lugar que
 * fecha a conta. Um segundo somador aqui seria a segunda fonte de verdade que a
 * SPEC §3.5 proíbe para o split, e pela mesma razão.
 *
 * `por_uso` devolve os lançamentos intactos: é o comportamento anterior, e a
 * ausência de transformação é o que o torna auditável.
 */
export function aplicarModeloDaAssinatura(
  lancamentos: readonly LancamentoNoPeriodo[],
  config: { readonly modo: ModoDaAssinatura; readonly tetoBps: number },
): readonly LancamentoDeComissao[] {
  if (config.modo === 'por_uso') return lancamentos;

  const deAssinatura = lancamentos.filter(daAssinatura);
  if (deAssinatura.length === 0) return lancamentos;

  const outros = lancamentos.filter((l) => !daAssinatura(l));

  if (config.modo === 'rateio') {
    return [...outros, ...ratearMensalidades(deAssinatura)];
  }

  return [...outros, ...limitarAoTeto(deAssinatura, config.tetoBps)];
}

/**
 * Rateio: a mensalidade vira a base, repartida entre os atendimentos.
 *
 * *"A mensalidade é distribuída entre os profissionais que atenderam no mês,
 * proporcional aos atendimentos."* Cada lançamento fica com
 * `mensalidade ÷ atendimentos daquela assinatura no período`, e a regra de
 * comissão do profissional incide sobre isso como incidiria sobre qualquer
 * base.
 *
 * O total é a mensalidade **exata**, com a sobra da divisão indo para o último
 * lançamento — como todo rateio deste código. Distribuir por arredondamento
 * simples faria a soma das partes diferir do todo em centavos, e a conta do mês
 * não fecharia com o extrato de ninguém.
 *
 * Estorno entra com sinal negativo e **não** conta como atendimento: um corte
 * que foi desfeito não dá direito a fatia da mensalidade, e contá-lo diluiria a
 * fatia de quem atendeu de verdade.
 */
function ratearMensalidades(
  lancamentos: readonly LancamentoDaAssinatura[],
): readonly LancamentoDeComissao[] {
  const porAssinatura = new Map<string, LancamentoDaAssinatura[]>();
  for (const l of lancamentos) {
    const lista = porAssinatura.get(l.assinaturaId) ?? [];
    lista.push(l);
    porAssinatura.set(l.assinaturaId, lista);
  }

  const saida: LancamentoDeComissao[] = [];

  for (const lista of porAssinatura.values()) {
    const positivos = lista.filter((l) => l.sinal === 1);
    const estornos = lista.filter((l) => l.sinal === -1);

    // Estorno mantém a base original: ele desfaz exatamente o que foi feito, e
    // recalcular faria a devolução não bater com o lançamento que ela anula.
    saida.push(...estornos);

    if (positivos.length === 0) continue;

    const mensalidade = positivos[0]?.mensalidadeCents ?? 0;
    const fatia = Math.floor(mensalidade / positivos.length);
    const sobra = mensalidade - fatia * positivos.length;

    positivos.forEach((l, i) => {
      saida.push({ ...l, baseCents: fatia + (i === positivos.length - 1 ? sobra : 0) });
    });
  }

  return saida;
}

/**
 * Híbrido: por uso, com teto na fração da mensalidade.
 *
 * O teto é sobre a **comissão**, não sobre a base — é assim que o dono pensa a
 * regra ("não quero pagar mais que 60% do que o assinante me paga"). Como a
 * comissão é derivada da base, o teto vira um fator que encolhe as bases
 * daquela assinatura na mesma proporção.
 *
 * Encolher proporcionalmente e não cortar o último atendimento é escolha: com o
 * corte, o barbeiro que atendeu no dia 28 receberia zero por um limite que os
 * colegas gastaram — e a conta dele dependeria da ordem em que os outros
 * trabalharam, que é o mesmo defeito que o rateio da faixa progressiva evita.
 */
function limitarAoTeto(
  lancamentos: readonly LancamentoDaAssinatura[],
  tetoBps: number,
): readonly LancamentoDeComissao[] {
  const porAssinatura = new Map<string, LancamentoDaAssinatura[]>();
  for (const l of lancamentos) {
    const lista = porAssinatura.get(l.assinaturaId) ?? [];
    lista.push(l);
    porAssinatura.set(l.assinaturaId, lista);
  }

  const saida: LancamentoDeComissao[] = [];

  for (const lista of porAssinatura.values()) {
    const mensalidade = lista[0]?.mensalidadeCents ?? 0;
    const teto = porCento(mensalidade, tetoBps);
    const bruta = comissaoDeUmGrupo(lista);

    if (bruta <= teto || bruta === 0) {
      saida.push(...lista);
      continue;
    }

    /**
     * O fator é aplicado à base, e a divisão inteira arredonda para baixo.
     *
     * Para baixo de propósito: o teto é uma promessa ao dono de que a casa não
     * paga mais que aquilo, e um arredondamento para cima o quebraria por
     * centavos — que é o bastante para o número da tela não bater com o
     * extrato.
     */
    for (const l of lista) {
      saida.push({ ...l, baseCents: Math.floor((l.baseCents * teto) / bruta) });
    }
  }

  return saida;
}

/** A comissão que um conjunto de lançamentos produziria, sem teto. */
function comissaoDeUmGrupo(lancamentos: readonly LancamentoDeComissao[]): number {
  let direta = 0;
  const porRegra = new Map<string, { base: number; faixas: readonly FaixaDeComissao[] }>();

  for (const l of lancamentos) {
    const base = l.baseCents * l.sinal;
    if (l.modo === 'percent') direta += porCento(base, l.valor);
    else if (l.modo === 'fixed') direta += l.valor * l.sinal;
    else {
      const acumulado = porRegra.get(l.regraId) ?? { base: 0, faixas: l.faixas };
      acumulado.base += base;
      porRegra.set(l.regraId, acumulado);
    }
  }

  let total = direta;
  for (const { base, faixas } of porRegra.values()) total += aplicarFaixas(faixas, base);
  return total;
}

// ---------------------------------------------------------------------------
// A simulação
// ---------------------------------------------------------------------------

export interface ResultadoDoModelo {
  readonly modo: ModoDaAssinatura;
  /** O que a casa pagaria de comissão sobre os atendimentos do plano. */
  readonly comissaoCents: number;
  /** O que sobra da mensalidade depois da comissão. */
  readonly sobraCents: number;
  /** A comissão como fração do que entrou, em pontos-base. */
  readonly pesoBps: number;
}

export interface SimulacaoDaAssinatura {
  /** A mensalidade somada das assinaturas que tiveram atendimento no período. */
  readonly receitaCents: number;
  readonly atendimentos: number;
  readonly modelos: readonly ResultadoDoModelo[];
  /** O modelo em uso hoje. */
  readonly emUso: ModoDaAssinatura;
}

/**
 * A simulação dos três modelos sobre os dados reais (SPEC §3.4).
 *
 * *"O sistema precisa mostrar ao dono, antes de ele escolher, a simulação dos
 * três sobre os dados reais dele."* — e a frase importa: a simulação sobre
 * exemplo de manual convence de qualquer coisa. Sobre o mês que ele acabou de
 * fechar, a diferença entre R$ 96 e R$ 59 tem nome e cara.
 *
 * A receita é a mensalidade das assinaturas **que tiveram atendimento** no
 * período, e não o MRR inteiro. Somar quem não veio inflaria a sobra e faria o
 * modelo por uso parecer barato — o assinante que não aparece é lucro, e ele já
 * está no MRR do painel; aqui a pergunta é outra: *quanto custa entregar o que
 * foi usado*.
 */
export function simularModelosDaAssinatura(params: {
  readonly lancamentos: readonly LancamentoNoPeriodo[];
  readonly tetoBps: number;
  readonly emUso: ModoDaAssinatura;
}): SimulacaoDaAssinatura {
  const deAssinatura = params.lancamentos.filter(daAssinatura);

  const mensalidadePorAssinatura = new Map<string, number>();
  for (const l of deAssinatura) mensalidadePorAssinatura.set(l.assinaturaId, l.mensalidadeCents);
  const receitaCents = [...mensalidadePorAssinatura.values()].reduce((s, v) => s + v, 0);

  const modelos = MODOS_DA_ASSINATURA.map((modo) => {
    const aplicados = aplicarModeloDaAssinatura(deAssinatura, { modo, tetoBps: params.tetoBps });
    const comissaoCents = comissaoDeUmGrupo(aplicados);
    return {
      modo,
      comissaoCents,
      sobraCents: receitaCents - comissaoCents,
      pesoBps: receitaCents > 0 ? Math.round((comissaoCents * 10_000) / receitaCents) : 0,
    };
  });

  return {
    receitaCents,
    atendimentos: deAssinatura.filter((l) => l.sinal === 1).length,
    modelos,
    emUso: params.emUso,
  };
}

/**
 * O que a simulação diz em uma frase.
 *
 * Existe porque três números lado a lado não são uma decisão: o dono precisa
 * ouvir "no mês passado, o modelo que você usa custou R$ X a mais". Sem a
 * comparação explícita, a tela vira mais um quadro bonito de onde não sai nada
 * — que é justamente o que a SPEC recusa quando fala do heatmap.
 */
export function fraseDaSimulacao(simulacao: SimulacaoDaAssinatura): string {
  if (simulacao.atendimentos === 0) {
    return 'Nenhum atendimento pago por plano neste período — não há o que comparar ainda.';
  }

  const atual = simulacao.modelos.find((m) => m.modo === simulacao.emUso);
  const maisBarato = [...simulacao.modelos].sort((a, b) => a.comissaoCents - b.comissaoCents)[0];
  if (!atual || !maisBarato) return '';

  if (maisBarato.modo === atual.modo) {
    return `O modelo que você usa é o que menos custou neste período, entre os três.`;
  }

  const diferenca = atual.comissaoCents - maisBarato.comissaoCents;
  return (
    `Neste período, ${ROTULO_DO_MODO_DA_ASSINATURA[atual.modo].toLowerCase()} custou `
    + `R$ ${(diferenca / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })} a mais `
    + `que ${ROTULO_DO_MODO_DA_ASSINATURA[maisBarato.modo].toLowerCase()}.`
  );
}

/**
 * A assinatura dá lucro?
 *
 * A conta que a SPEC §4.6 pede em letras: *"sem essa tela, o dono descobre que o
 * clube dá prejuízo seis meses depois"*. O bloco 45 entregou a metade que não
 * depende de nada — quantos usos o plano paga. Esta é a outra: o que **de fato**
 * aconteceu, com a comissão real do modelo escolhido.
 *
 * Prejuízo aqui não é necessariamente erro: um plano que dá pouco lucro por
 * assinante e enche a agenda de terça pode valer a pena. O que não pode é o dono
 * não saber.
 */
export interface RentabilidadeDoAssinante {
  readonly assinaturaId: string;
  readonly mensalidadeCents: number;
  readonly usos: number;
  readonly valorEntregueCents: number;
  readonly comissaoCents: number;
  readonly insumoCents: number;
  readonly margemCents: number;
}

export function rentabilidadeDoAssinante(params: {
  readonly assinaturaId: string;
  readonly mensalidadeCents: number;
  readonly usos: readonly { readonly valorCents: number }[];
  readonly comissaoCents: number;
  readonly insumoCents: number;
}): RentabilidadeDoAssinante {
  const valorEntregueCents = params.usos.reduce((soma, u) => soma + u.valorCents, 0);
  return {
    assinaturaId: params.assinaturaId,
    mensalidadeCents: params.mensalidadeCents,
    usos: params.usos.length,
    valorEntregueCents,
    comissaoCents: params.comissaoCents,
    insumoCents: params.insumoCents,
    margemCents: params.mensalidadeCents - params.comissaoCents - params.insumoCents,
  };
}
