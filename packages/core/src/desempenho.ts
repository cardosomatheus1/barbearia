/**
 * Os números do barbeiro — SPEC §4.21.
 *
 * Puro, como todo `core`: entram os totais já contados, sai a leitura. O
 * "agora" e o calendário entram por parâmetro.
 *
 * A decisão que atravessa o arquivo: **um número sem referência não muda
 * comportamento**. "R$ 12.400" não diz nada; "82% da meta, e faltam 9 dias"
 * diz. Por isso quase tudo aqui devolve o número **e** a comparação — e por
 * isso o ritmo existe, que é a diferença entre uma meta que orienta e uma que
 * só cobra no dia 30.
 */

export interface Totais {
  readonly faturamentoCents: number;
  readonly atendimentos: number;
  /** Quantos saíram com o próximo horário já marcado. */
  readonly saiuComHorario: number;
}

/**
 * Ticket médio.
 *
 * Zero atendimentos devolve zero, não `NaN` nem `null`. É o primeiro dia do mês
 * do barbeiro novo, e a tela precisa mostrar um número — "—" no lugar de "R$
 * 0,00" só transferiria a decisão para a view.
 */
export function ticketMedio(totais: Totais): number {
  if (totais.atendimentos <= 0) return 0;
  return Math.round(totais.faturamentoCents / totais.atendimentos);
}

/**
 * `rebooking rate`: quantos saíram com o próximo horário marcado.
 *
 * A SPEC §4.21 a chama de "a métrica mais preditiva de retenção em barbearia" e
 * observa que quase ninguém mede. Ela é barata aqui porque o produto já sabe
 * tudo: basta perguntar se o cliente tem agendamento futuro no instante em que
 * o atendimento foi concluído.
 *
 * Em pontos percentuais inteiros, não fração — mesma razão dos pontos-base da
 * comissão: número redondo não acumula erro de arredondamento ao ser exibido, e
 * ninguém decide nada com a terceira casa decimal.
 */
export function taxaDeRetorno(totais: Totais): number {
  if (totais.atendimentos <= 0) return 0;
  return Math.round((totais.saiuComHorario / totais.atendimentos) * 100);
}

export interface Meta {
  readonly metaCents: number;
  readonly realizadoCents: number;
  /** Quantos dias do mês já passaram, contando hoje. */
  readonly diaDoMes: number;
  readonly diasNoMes: number;
}

export interface ProgressoDaMeta {
  readonly metaCents: number;
  readonly realizadoCents: number;
  /** Percentual inteiro do realizado sobre a meta. Passa de 100 quando bate. */
  readonly percentual: number;
  readonly faltamCents: number;
  /**
   * Quanto deveria ter faturado até hoje para chegar na meta no ritmo.
   *
   * É a informação que transforma meta em orientação. Sem ela, o barbeiro
   * descobre no dia 30 que estava atrás desde o dia 8.
   */
  readonly esperadoAteHojeCents: number;
  readonly noRitmo: boolean;
  /** Quanto falta por dia útil restante para bater. Zero quando já bateu. */
  readonly porDiaRestanteCents: number;
}

export function progressoDaMeta(meta: Meta): ProgressoDaMeta {
  const metaCents = Math.max(0, meta.metaCents);
  const realizadoCents = Math.max(0, meta.realizadoCents);
  const diasNoMes = Math.max(1, meta.diasNoMes);
  const diaDoMes = Math.min(Math.max(1, meta.diaDoMes), diasNoMes);

  const percentual = metaCents === 0 ? 0 : Math.round((realizadoCents / metaCents) * 100);
  const faltamCents = Math.max(0, metaCents - realizadoCents);

  const esperadoAteHojeCents = Math.round((metaCents * diaDoMes) / diasNoMes);
  const diasRestantes = diasNoMes - diaDoMes;

  return {
    metaCents,
    realizadoCents,
    percentual,
    faltamCents,
    esperadoAteHojeCents,
    noRitmo: realizadoCents >= esperadoAteHojeCents,
    /**
     * No último dia do mês, o que falta é tudo o que falta — dividir por zero
     * dia restante daria infinito, e "faltam ∞ por dia" não é uma frase.
     */
    porDiaRestanteCents:
      faltamCents === 0 ? 0 : Math.ceil(faltamCents / Math.max(1, diasRestantes)),
  };
}

/**
 * A frase da meta.
 *
 * Aqui, e não na tela, pelo mesmo motivo de `frasePosicao` na fila e de
 * `fraseDoIntervalo` no dia do barbeiro: é decisão de negócio disfarçada de
 * texto. O tom muda com o estado — cobrar quem já bateu é o jeito mais rápido
 * de fazer alguém parar de olhar a tela.
 */
export function fraseDaMeta(progresso: ProgressoDaMeta, dinheiro: (cents: number) => string): string {
  if (progresso.metaCents === 0) return 'Sem meta definida para este mês.';
  if (progresso.faltamCents === 0) return 'Meta batida. O que vier agora é a mais.';
  if (progresso.noRitmo) {
    return `No ritmo. Faltam ${dinheiro(progresso.faltamCents)} para bater.`;
  }
  return `Atrás do ritmo: ${dinheiro(progresso.porDiaRestanteCents)} por dia para alcançar.`;
}

/**
 * Como o mês se compara com o anterior.
 *
 * Comparação com o próprio passado, nunca com o colega. A SPEC §4.21 é explícita
 * sobre por quê: ranking entre barbeiros produz disputa por cliente bom, empurra
 * produto e faz recusar atendimento rápido. O barbeiro melhora contra ele mesmo.
 *
 * `null` quando não há mês anterior com o que comparar — e é diferente de zero:
 * "primeiro mês" e "caiu 100%" não são a mesma notícia.
 */
export function variacao(atualCents: number, anteriorCents: number): number | null {
  if (anteriorCents <= 0) return null;
  return Math.round(((atualCents - anteriorCents) / anteriorCents) * 100);
}
