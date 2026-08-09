/**
 * Alertas de negócio (SPEC Parte 5 §5.12).
 *
 * A SPEC é explícita sobre isto, e o argumento dela é bom o bastante para
 * merecer estar no código: **um bug que derruba a conversão em 30% não aciona
 * alerta de CPU, e é muito mais grave**. O monitoramento de infraestrutura
 * responde "o servidor está de pé"; nenhuma dessas perguntas é a que importa
 * para uma barbearia que parou de receber agendamento porque a página quebrou.
 *
 * As regras moram aqui — puras, sem banco, sem relógio próprio — porque é onde
 * dá para provar cada uma delas. Quem coleta os números e quem dispara o aviso
 * são outros; um alerta que só existe dentro do coletor não tem como ser
 * testado sem inventar um Postgres.
 *
 * ## As três decisões que separam alerta de ruído
 *
 * **Comparação é com o mesmo dia da semana, nunca com ontem.** Segunda contra
 * domingo é queda de 60% em qualquer barbearia saudável do Brasil. Alertar
 * nisso é ensinar todo mundo a ignorar o alerta na terceira semana.
 *
 * **Volume baixo não alerta.** Uma barbearia de duas cadeiras faz três
 * agendamentos numa terça fraca; cair para um é −67% e não significa nada. Sem
 * um piso de amostra, o produto manda susto para quem menos tem tempo de
 * apurar.
 *
 * **Alerta diz o que fazer, ou não serve.** Cada regra devolve uma frase em
 * português com o número, a referência e para onde olhar. "Conversão caiu" às
 * três da manhã não ajuda ninguém.
 */

/**
 * Nome próprio porque o `validador` já tem uma `Severidade`, e as duas são
 * coisas diferentes: lá é sobre um cadastro que impede publicar, aqui é sobre
 * acordar alguém de madrugada. Unificá-las faria uma das duas ganhar um valor
 * que não significa nada nela.
 */
export type SeveridadeDeAlerta = 'aviso' | 'critico';

export interface Alerta {
  /** Identificador estável da regra. É por ele que se silencia ou se agrupa. */
  readonly regra: string;
  readonly severidade: SeveridadeDeAlerta;
  /** O que aconteceu e o que olhar, em português. */
  readonly frase: string;
  /** O número medido e aquele com que ele foi comparado. */
  readonly valor: number;
  readonly referencia: number;
}

/**
 * Nenhum alerta é uma resposta legítima — e a mais comum.
 *
 * `VeredictoDeAlerta` e não `Veredito` pelo mesmo motivo da severidade: a
 * importação de base já usa `Veredito` para o destino de uma linha de planilha.
 */
export type VeredictoDeAlerta = Alerta | null;

const pct = (n: number): string => `${Math.round(n * 100)}%`;

/**
 * Queda no volume de agendamento de uma barbearia.
 *
 * O sinal que a SPEC pede por tenant: a casa que parou de receber agendamento
 * sem ter parado de funcionar. A causa costuma ser do nosso lado — página
 * pública quebrada, grade sem horário por jornada apagada sem querer, slug
 * trocado —, e é o tipo de defeito que ninguém reporta: o cliente não liga para
 * a barbearia dizendo "seu site não abre", ele vai no concorrente.
 */
export function volumeDeAgendamentoCaiu(entrada: {
  readonly hoje: number;
  /** Mesmo dia da semana anterior. Comparar com ontem não é comparação. */
  readonly mesmoDiaSemanaPassada: number;
  /** Abaixo disto a variação não é sinal. */
  readonly minimoParaComparar?: number;
  /** Queda proporcional que dispara. 0.5 = metade. */
  readonly quedaCritica?: number;
  readonly quedaDeAviso?: number;
}): VeredictoDeAlerta {
  const {
    hoje,
    mesmoDiaSemanaPassada: base,
    minimoParaComparar = 8,
    quedaCritica = 0.6,
    quedaDeAviso = 0.35,
  } = entrada;

  // Sem base não há queda: barbearia que abriu esta semana não regrediu.
  if (base < minimoParaComparar) return null;

  const queda = (base - hoje) / base;
  if (queda < quedaDeAviso) return null;

  const severidade: SeveridadeDeAlerta = queda >= quedaCritica ? 'critico' : 'aviso';
  return {
    regra: 'agendamento.volume_caiu',
    severidade,
    frase:
      `Agendamentos caíram ${pct(queda)} contra o mesmo dia da semana passada ` +
      `(${hoje} contra ${base}). Confira se a página pública abre e se a grade tem horário livre.`,
    valor: hoje,
    referencia: base,
  };
}

/**
 * Conversão da página pública: quem abriu contra quem marcou.
 *
 * É o número que a SPEC cita primeiro, e o motivo é que ele cai **antes** de
 * qualquer métrica de infraestrutura acusar qualquer coisa. Um botão que parou
 * de responder mantém CPU, memória e latência exatamente onde estavam.
 */
export function conversaoDespencou(entrada: {
  readonly visitas: number;
  readonly agendamentos: number;
  /** A taxa que a barbearia costuma ter, medida em janela longa. */
  readonly taxaHabitual: number;
  readonly minimoDeVisitas?: number;
  readonly quedaCritica?: number;
  readonly quedaDeAviso?: number;
}): VeredictoDeAlerta {
  const {
    visitas,
    agendamentos,
    taxaHabitual,
    minimoDeVisitas = 50,
    quedaCritica = 0.5,
    quedaDeAviso = 0.3,
  } = entrada;

  // Vinte visitas e nenhuma marcação é terça-feira, não incidente.
  if (visitas < minimoDeVisitas) return null;
  if (taxaHabitual <= 0) return null;

  const taxa = agendamentos / visitas;
  const queda = (taxaHabitual - taxa) / taxaHabitual;
  if (queda < quedaDeAviso) return null;

  return {
    regra: 'conversao.despencou',
    severidade: queda >= quedaCritica ? 'critico' : 'aviso',
    frase:
      `Conversão em ${pct(taxa)} contra ${pct(taxaHabitual)} de costume ` +
      `(${agendamentos} de ${visitas} visitas). Abra o fluxo de agendamento e vá até o fim.`,
    valor: taxa,
    referencia: taxaHabitual,
  };
}

/**
 * Fila de trabalho travada.
 *
 * O que trava aqui não é abstrato: é o lembrete de 24h que não sai, e a falta
 * que ele derruba. A fila pode estar **crescendo** sem estar travada — sábado de
 * manhã enche —, então o sinal não é o tamanho: é a **idade da tarefa mais
 * antiga**. Fila grande com tarefa nova é movimento; fila pequena com tarefa de
 * uma hora é worker morto.
 */
export function filaTravada(entrada: {
  readonly pendentes: number;
  readonly idadeDaMaisAntigaMinutos: number;
  readonly avisoMinutos?: number;
  readonly criticoMinutos?: number;
}): VeredictoDeAlerta {
  const {
    pendentes,
    idadeDaMaisAntigaMinutos: idade,
    avisoMinutos = 15,
    criticoMinutos = 60,
  } = entrada;

  if (pendentes === 0) return null;
  if (idade < avisoMinutos) return null;

  const severidade: SeveridadeDeAlerta = idade >= criticoMinutos ? 'critico' : 'aviso';
  return {
    regra: 'fila.travada',
    severidade,
    frase:
      `${pendentes} tarefa(s) na fila, a mais antiga parada há ${idade} min. ` +
      'O worker pode ter caído — sem ele, lembrete não sai e falta não é marcada.',
    valor: idade,
    referencia: avisoMinutos,
  };
}

/**
 * Erro de gravação de agendamento.
 *
 * Diferente das outras três: não compara com nada. Recusa por horário ocupado é
 * comportamento correto e frequente; **falha** de gravação não deveria existir.
 * Uma proporção pequena já é sinal, e por isso o piso aqui é de amostra, não de
 * variação.
 */
export function agendamentoFalhando(entrada: {
  readonly tentativas: number;
  /** Só erro interno. Recusa por regra de negócio não entra. */
  readonly falhas: number;
  readonly minimoDeTentativas?: number;
  readonly proporcaoDeAviso?: number;
  readonly proporcaoCritica?: number;
}): VeredictoDeAlerta {
  const {
    tentativas,
    falhas,
    minimoDeTentativas = 20,
    proporcaoDeAviso = 0.02,
    proporcaoCritica = 0.1,
  } = entrada;

  if (tentativas < minimoDeTentativas) return null;

  const proporcao = falhas / tentativas;
  if (proporcao < proporcaoDeAviso) return null;

  return {
    regra: 'agendamento.falhando',
    severidade: proporcao >= proporcaoCritica ? 'critico' : 'aviso',
    frase:
      `${falhas} de ${tentativas} tentativas de agendamento falharam (${pct(proporcao)}). ` +
      'Recusa por horário ocupado não conta aqui — isto é erro nosso.',
    valor: proporcao,
    referencia: proporcaoDeAviso,
  };
}

/**
 * O que o coletor entrega para ser avaliado de uma vez.
 *
 * Cada campo é opcional porque nem toda medida existe em toda janela: uma
 * barbearia sem visita registrada não tem conversão para comparar, e regra sem
 * dado precisa ficar em silêncio em vez de inventar zero.
 */
export interface Medidas {
  readonly volume?: Parameters<typeof volumeDeAgendamentoCaiu>[0];
  readonly conversao?: Parameters<typeof conversaoDespencou>[0];
  readonly fila?: Parameters<typeof filaTravada>[0];
  readonly agendamento?: Parameters<typeof agendamentoFalhando>[0];
}

/**
 * Avalia tudo e devolve só o que disparou, do mais grave para o menos.
 *
 * A ordenação existe porque alerta chega em lote e quem lê para de ler: o que
 * derruba receita precisa estar na primeira linha.
 */
export function avaliar(medidas: Medidas): readonly Alerta[] {
  const disparados: Alerta[] = [];

  const talvez = (a: VeredictoDeAlerta): void => {
    if (a) disparados.push(a);
  };

  if (medidas.volume) talvez(volumeDeAgendamentoCaiu(medidas.volume));
  if (medidas.conversao) talvez(conversaoDespencou(medidas.conversao));
  if (medidas.fila) talvez(filaTravada(medidas.fila));
  if (medidas.agendamento) talvez(agendamentoFalhando(medidas.agendamento));

  return disparados.sort((a, b) => {
    if (a.severidade === b.severidade) return a.regra.localeCompare(b.regra);
    return a.severidade === 'critico' ? -1 : 1;
  });
}
