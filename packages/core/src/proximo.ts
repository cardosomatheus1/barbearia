/**
 * O "próximo horário" do card do marketplace (bloco 71, SPEC §5.2).
 *
 * > ```
 * > Box Seis                      ⭐ 4,9 · 842 avaliações
 * > 1,2 km · Corte a partir de R$ 55,00
 * > Próximo horário: 17:40                       [ Agendar ]
 * > ```
 * >
 * > *"`Próximo horário` como elemento principal do card é o que diferencia de
 * > diretório."*
 *
 * ## O que este arquivo decide
 *
 * A escolha do horário e a frase que a tela escreve. Ele **não** calcula
 * disponibilidade: quem faz isso é o motor de sempre, o mesmo da página pública
 * e o mesmo que a gravação valida. Uma segunda noção de "horário livre" é a
 * agenda vendida duas vezes, e é a razão de este arquivo receber a grade pronta
 * em vez de olhar para a agenda.
 *
 * ## Por que dois dias, e não sete
 *
 * O card responde *"dá para ir agora?"*. Um "próximo horário: sexta que vem" não
 * ajuda ninguém a decidir entre duas barbearias — e custa, porque o motor roda
 * uma vez por casa da lista. Dois dias é o que sustenta as duas perguntas da
 * SPEC (*disponível hoje*, *disponível agora*) e ainda dá uma resposta útil para
 * quem busca às 21h, quando o dia já acabou e amanhã é a informação.
 */

/** Hoje e amanhã. A frase da tela depende deste número ser exatamente 2. */
export const DIAS_DO_PROXIMO_HORARIO = 2;

/**
 * Quanto tempo à frente ainda conta como *"agora"*.
 *
 * Uma hora e meia é o que separa "dá para ir agora" de "dá para ir hoje". Abaixo
 * disso o filtro passa a devolver quase nada — a antecedência mínima da
 * barbearia já come os primeiros minutos, e sobra uma janela em que ninguém tem
 * vaga —, e acima disso ele deixa de responder a pergunta e vira o filtro de
 * hoje com outro nome.
 */
export const JANELA_DO_AGORA_MINUTOS = 90;

export const DISPONIBILIDADES = ['qualquer', 'hoje', 'agora'] as const;
export type Disponibilidade = (typeof DISPONIBILIDADES)[number];

export const ROTULO_DA_DISPONIBILIDADE: Readonly<Record<Disponibilidade, string>> = {
  qualquer: 'Qualquer dia',
  hoje: 'Disponível hoje',
  agora: 'Disponível agora',
};

/** Um dia de grade, do jeito que o motor devolve. */
export interface DiaComHorarios {
  readonly date: string;
  readonly slots: readonly { readonly start: string; readonly startsAt: string }[];
}

export interface HorarioDaVitrine {
  /** O instante, para a tela não ter que refazer a conta de fuso. */
  readonly startsAt: string;
  /** `HH:MM` no fuso da unidade — o que a pessoa vê. */
  readonly hora: string;
  readonly hoje: boolean;
}

/**
 * O primeiro horário livre da grade, ou nulo.
 *
 * Descarta o que já passou mesmo com a grade vindo pronta: `agora` entra por
 * parâmetro em todo este código, e a grade foi calculada num instante que pode
 * não ser o mesmo — entre carregar a lista e montar o card cabe uma requisição
 * inteira. O motor já aplica a antecedência mínima; esta guarda é sobre o
 * relógio, não sobre a regra.
 */
export function proximoHorario(
  dias: readonly DiaComHorarios[],
  agora: Date,
  hojeNaUnidade: string,
): HorarioDaVitrine | null {
  const limite = agora.getTime();

  for (const dia of dias) {
    for (const slot of dia.slots) {
      if (new Date(slot.startsAt).getTime() < limite) continue;
      return { startsAt: slot.startsAt, hora: slot.start, hoje: dia.date === hojeNaUnidade };
    }
  }
  return null;
}

/**
 * A frase do card.
 *
 * "Amanhã" é literal porque a janela é de dois dias: com uma janela maior a
 * frase passaria a mentir num dia qualquer, sem nada ficar vermelho. É por isso
 * que `DIAS_DO_PROXIMO_HORARIO` é constante exportada e não um parâmetro solto.
 */
export function rotuloDoProximoHorario(horario: HorarioDaVitrine | null): string {
  if (!horario) return 'Sem horário hoje nem amanhã';
  return horario.hoje ? `Hoje, ${horario.hora}` : `Amanhã, ${horario.hora}`;
}

/**
 * Se o horário cabe na pergunta *"disponível agora"*.
 *
 * Um horário que já passou não conta — e ele não deveria chegar aqui, porque
 * `proximoHorario` o descarta. A guarda fica porque a função é exportada e a
 * próxima chamada pode não vir de lá.
 */
export function estaDisponivelAgora(
  horario: HorarioDaVitrine | null,
  agora: Date,
): boolean {
  if (!horario) return false;
  const minutos = (new Date(horario.startsAt).getTime() - agora.getTime()) / 60_000;
  return minutos >= 0 && minutos <= JANELA_DO_AGORA_MINUTOS;
}

/**
 * Se o card passa no filtro pedido.
 *
 * `qualquer` deixa passar **inclusive quem não tem horário nenhum**, e isso é
 * decisão: a barbearia que está com a agenda cheia continua sendo um resultado
 * legítimo de uma busca por barbearia. Escondê-la faria a lista encolher sem
 * ninguém ter pedido, e quem quer só quem tem vaga tem os outros dois filtros.
 */
export function passaNaDisponibilidade(
  horario: HorarioDaVitrine | null,
  disponibilidade: Disponibilidade,
  agora: Date,
): boolean {
  if (disponibilidade === 'qualquer') return true;
  if (disponibilidade === 'hoje') return horario !== null && horario.hoje;
  return estaDisponivelAgora(horario, agora);
}
