/**
 * Preço por faixa de horário (bloco 68, SPEC §4.20).
 *
 * > *"A IA **recomenda**, o administrador **aprova**."*
 *
 * Este arquivo é a metade que **aplica** a regra que alguém já aprovou. Ele não
 * decide preço sozinho, não lê ocupação e não tem entrada por onde um algoritmo
 * escreva: recebe as faixas cadastradas, o teto da marca e diz quanto custa
 * aquele horário.
 *
 * ## As quatro regras obrigatórias da SPEC, e onde cada uma mora
 *
 * 1. *"Nunca alterar preço automaticamente sem autorização configurada"* — o
 *    interruptor é da unidade e nasce desligado (migração 0066); sem ele as
 *    faixas nem chegam aqui.
 * 2. *"Preço mostrado ao cliente é travado no momento da reserva"* — é o motor
 *    que já congela `appointments.price_cents`, e este cálculo entra **antes**
 *    dele, no mesmo slot. Mudar a regra amanhã não mexe no que foi marcado hoje.
 * 3. *"Variação máxima configurável (default ±15%)"* — o teto é aplicado aqui, e
 *    ele apara a regra em vez de recusá-la: uma faixa de −40% cadastrada com
 *    teto de 15% desconta 15%, e não 40%.
 * 4. *"Assinante **nunca** paga surge pricing"* — o acréscimo é ignorado para
 *    quem assina; o desconto continua valendo, porque ele é benefício e não
 *    penalidade.
 */

export interface FaixaDePreco {
  readonly diaDaSemana: number;
  readonly inicioMinuto: number;
  readonly fimMinuto: number;
  /** Pontos-base inteiros: −1000 é −10%, +1000 é +10%. */
  readonly deltaBps: number;
}

/** O teto padrão da SPEC §4.20: ±15%. */
export const TETO_DE_VARIACAO_BPS = 1500;

export interface PrecoDoHorario {
  readonly precoCents: number;
  /** A variação de fato aplicada, já aparada pelo teto. Zero é "preço de tabela". */
  readonly deltaBps: number;
}

/**
 * Quanto custa este horário, a partir das faixas que a barbearia aprovou.
 *
 * A faixa é semiaberta — `[início, fim)` —, como todo intervalo deste produto:
 * uma regra que vai das 13h às 16h não pega o slot das 16h. E não há desempate
 * entre faixas porque não há sobreposição: a constraint de exclusão da migração
 * 0066 recusa a segunda faixa que encoste na primeira, e regra de desempate
 * sobre preço é como o cliente vê um valor na tela e outro na hora de pagar.
 */
export function precoDoHorario(params: {
  readonly precoBaseCents: number;
  readonly faixas: readonly FaixaDePreco[];
  readonly diaDaSemana: number;
  readonly minutoLocal: number;
  readonly assinante: boolean;
  readonly tetoBps: number;
}): PrecoDoHorario {
  const faixa = params.faixas.find(
    (f) =>
      f.diaDaSemana === params.diaDaSemana &&
      params.minutoLocal >= f.inicioMinuto &&
      params.minutoLocal < f.fimMinuto,
  );
  if (!faixa) return { precoCents: params.precoBaseCents, deltaBps: 0 };

  /**
   * Assinante nunca paga acréscimo — e continua ganhando desconto.
   *
   * *"Assinante **nunca** paga surge pricing; é benefício do clube."* Aparar
   * também o desconto seria ler a frase ao contrário: ela protege quem assina,
   * não a receita da casa. Quem paga mensalidade para ter previsibilidade não
   * pode descobrir num sábado que o corte dele subiu.
   */
  if (params.assinante && faixa.deltaBps > 0) {
    return { precoCents: params.precoBaseCents, deltaBps: 0 };
  }

  /**
   * O teto **apara**, não recusa.
   *
   * Recusar a regra faria a barbearia cadastrar −40%, salvar sem erro e não
   * entender por que nada mudou. Aparando, o efeito é o maior que a marca
   * aceita, e a tela mostra o número aplicado ao lado do cadastrado.
   */
  const teto = Math.abs(params.tetoBps);
  const delta = Math.max(-teto, Math.min(teto, faixa.deltaBps));

  /**
   * Arredondamento para centavo inteiro, como todo dinheiro deste código.
   *
   * `Math.round` e não truncamento: truncar sempre para baixo faria um
   * acréscimo de 10% sobre R$ 49,99 render um centavo a menos do que a regra
   * diz, em toda venda, para sempre.
   */
  return {
    precoCents: Math.round(params.precoBaseCents * (1 + delta / 10_000)),
    deltaBps: delta,
  };
}

/**
 * A recomendação — que é só isso, uma recomendação.
 *
 * > *"Sexta 17–20h está com 97% de ocupação há 8 semanas. Um reajuste de R$ 5
 * > nesse período geraria ~R$ 1.240/mês, considerando demanda constante."*
 *
 * Ela é **derivada** da ocupação medida e não é gravada em lugar nenhum: some no
 * instante em que deixa de ser verdade, como o DRE e o segmento do cliente. Uma
 * tabela de recomendações estaria errada em todo minuto entre a mudança do
 * movimento e a varredura passar — e é justamente aí que o dono abre a tela.
 *
 * "Considerando demanda constante" é a ressalva da própria SPEC, e a tela a
 * repete: subir preço muda a demanda, e este número não sabe disso.
 */
export interface RecomendacaoDePreco {
  readonly diaDaSemana: number;
  readonly hora: number;
  readonly ocupacaoBps: number;
  readonly deltaBps: number;
  /** Quanto renderia por mês, se a demanda não mudasse. */
  readonly ganhoMensalCents: number;
}

/** A partir de quanta ocupação vale recomendar acréscimo. */
export const OCUPACAO_PARA_ACRESCIMO_BPS = 9000;

export interface HoraMedida {
  readonly diaDaSemana: number;
  readonly hora: number;
  readonly ocupacaoBps: number | null;
  /** Atendimentos que aquela hora costuma receber por semana. */
  readonly atendimentosPorSemana: number;
}

/**
 * O que valeria a pena mexer, do maior ganho para o menor.
 *
 * ## Só acréscimo, e a ausência do desconto é a decisão
 *
 * A primeira versão também sugeria desconto para a hora fria, e o print da tela
 * mostrou o resultado: três cartões seguidos — domingo às 6h, às 7h e às 8h —
 * com o **mesmo** número, porque o ganho de um desconto não sai de lugar nenhum.
 * Quantas pessoas 15% a menos traria é o que este produto não sabe, e chutar
 * "uma por semana" é inventar número de marketing com cara de estatística.
 *
 * O ganho do acréscimo é aritmética sobre demanda **medida**: quem já vem
 * naquela hora passa a pagar mais. Isso se defende.
 *
 * A hora vazia continua tendo resposta no produto, e melhor que um desconto no
 * escuro: o insight do bloco 67 conta as vagas e o público, e o botão dele abre
 * a campanha — que é o que a SPEC §4.18 manda fazer com hora ociosa. E a faixa
 * de desconto continua cadastrável à mão, que é a decisão de quem conhece a
 * própria rua.
 *
 * Hora fechada tem ocupação nula e não entra de qualquer forma: é a célula mais
 * vermelha de um heatmap ingênuo, regra do bloco 57.
 */
export function recomendarPrecos(params: {
  readonly horas: readonly HoraMedida[];
  readonly ticketMedioCents: number;
  readonly tetoBps: number;
  readonly limite?: number;
}): readonly RecomendacaoDePreco[] {
  const teto = Math.abs(params.tetoBps);
  if (teto === 0 || params.ticketMedioCents <= 0) return [];

  const candidatas: RecomendacaoDePreco[] = [];
  for (const hora of params.horas) {
    if (hora.ocupacaoBps === null) continue;
    if (hora.atendimentosPorSemana <= 0) continue;

    if (hora.ocupacaoBps < OCUPACAO_PARA_ACRESCIMO_BPS) continue;

    /**
     * Quatro semanas de atendimentos medidos vezes a diferença de preço.
     *
     * Nada aqui supõe demanda nova: são as mesmas pessoas que já vêm, pagando a
     * diferença. É por isso que a tela pode escrever o número — e por isso ela
     * repete a ressalva da SPEC, *"considerando demanda constante"*: subir preço
     * muda a procura, e esta conta não sabe disso.
     */
    candidatas.push({
      diaDaSemana: hora.diaDaSemana,
      hora: hora.hora,
      ocupacaoBps: hora.ocupacaoBps,
      deltaBps: teto,
      ganhoMensalCents: Math.round(
        hora.atendimentosPorSemana * 4 * params.ticketMedioCents * (teto / 10_000),
      ),
    });
  }

  return candidatas
    .sort(
      (a, b) =>
        b.ganhoMensalCents - a.ganhoMensalCents ||
        a.diaDaSemana - b.diaDaSemana ||
        a.hora - b.hora,
    )
    .slice(0, params.limite ?? 3);
}

/**
 * Reparte o preço ajustado entre os serviços do agendamento.
 *
 * Sem isto o ajuste chegaria só a `appointments.price_cents`, e a comanda — que
 * nasce de `appointment_services` — cobraria o preço de tabela. O cliente veria
 * R$ 45 na tela e R$ 50 na hora de pagar, que é exatamente o defeito que a faixa
 * de preço existe para não produzir.
 *
 * A soma bate **ao centavo**, com a sobra no último, como o split do bloco 50: um
 * centavo a mais e o total do agendamento não fecha com a soma dos itens, e
 * quem descobre é a recepção com o cliente na frente.
 */
export function repartirPreco(
  base: ReadonlyMap<string, number>,
  totalAjustadoCents: number,
): ReadonlyMap<string, number> {
  const totalBase = [...base.values()].reduce((soma, v) => soma + v, 0);
  const repartido = new Map<string, number>();
  if (totalBase <= 0 || base.size === 0) return base;

  const chaves = [...base.keys()];
  let acumulado = 0;
  for (const [i, chave] of chaves.entries()) {
    const valor = base.get(chave) ?? 0;
    if (i === chaves.length - 1) {
      repartido.set(chave, totalAjustadoCents - acumulado);
      break;
    }
    const parte = Math.round((valor / totalBase) * totalAjustadoCents);
    repartido.set(chave, parte);
    acumulado += parte;
  }
  return repartido;
}
