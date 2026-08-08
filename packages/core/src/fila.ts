/**
 * Fila presencial — quem chegou sem hora marcada.
 *
 * A SPEC (Parte 2 §2.10) trata a fila como **outro objeto**, não como um
 * agendamento improvisado, e é isso que este arquivo modela. Duas frases dela
 * governam tudo o que está aqui:
 *
 * > A estimativa vem da duração real média (não da cadastrada) dos atendimentos
 * > em curso e da fila à frente.
 *
 * > Walk-in nunca sobrescreve agendamento confirmado. O sistema encaixa walk-in
 * > apenas em buraco real, e mostra ao recepcionista quanto tempo existe até o
 * > próximo agendado.
 *
 * Lógica pura: sem banco, sem rede, sem relógio. Tudo aqui é **minuto a partir
 * de agora** — deslocamento, não hora do dia. A fila não pergunta "que horas
 * são", pergunta "em quanto tempo", e essa é a única unidade em que a conta
 * fecha sem depender de fuso.
 */

/** Em quantos minutos cada profissional fica livre. Zero é "livre agora". */
export interface AtendenteNaFila {
  readonly professionalId: string;
  readonly livreEmMinutos: number;
  /**
   * Minutos até o próximo agendamento **marcado** dele, ou `null` se não houver.
   *
   * É o teto do que a fila pode consumir dessa cadeira sem atrasar quem marcou.
   */
  readonly proximoMarcadoEmMinutos: number | null;
}

export interface PedidoNaFila {
  readonly id: string;
  /** Preferência de profissional. `null` é "qualquer um". */
  readonly professionalId: string | null;
  readonly duracaoMinutos: number;
}

export interface LugarNaFila {
  readonly id: string;
  /** Posição geral, começando em 1, na ordem de chegada. */
  readonly posicao: number;
  /** Quem vai atender, resolvido agora. `null` quando ninguém pode. */
  readonly professionalId: string | null;
  /** Em quantos minutos começa. `null` quando não há quem atenda. */
  readonly esperaMinutos: number | null;
  /**
   * O atendimento invade o horário de quem marcou.
   *
   * Não impede nada — a recepção pode ter um motivo —, mas precisa aparecer.
   * Encaixar às cegas em cima de quem marcou é exatamente o que transforma
   * "atendo por ordem de chegada" em cliente marcado esperando.
   */
  readonly atrasaMarcado: boolean;
}

/**
 * Distribui a fila entre as cadeiras.
 *
 * Ordem de chegada, mas **não** fila única: cada pessoa só entra na cadeira que
 * pode atendê-la. Quem pediu o Bruno espera o Bruno; quem aceita qualquer um
 * pega quem liberar primeiro — inclusive passando na frente, porque é o que
 * acontece de fato no salão e porque bloquear deixaria uma cadeira parada.
 *
 * O que a estimativa devolve para quem esperava o Bruno já contém esse efeito.
 * A alternativa — fila estritamente única — produz o número que a barbearia
 * mais odeia ouvir explicação: "por que aquele entrou antes de mim?".
 */
export function estimarFila(params: {
  /** Em ordem de chegada. */
  readonly fila: readonly PedidoNaFila[];
  readonly atendentes: readonly AtendenteNaFila[];
}): readonly LugarNaFila[] {
  // Cópia local: a função é pura e não mexe no que recebeu.
  const livreEm = new Map(params.atendentes.map((a) => [a.professionalId, a.livreEmMinutos]));
  const proximoMarcado = new Map(
    params.atendentes.map((a) => [a.professionalId, a.proximoMarcadoEmMinutos]),
  );

  return params.fila.map((pedido, indice) => {
    const elegiveis = params.atendentes.filter(
      (a) => pedido.professionalId === null || a.professionalId === pedido.professionalId,
    );

    let escolhido: string | null = null;
    let inicio = Number.POSITIVE_INFINITY;
    for (const atendente of elegiveis) {
      const quando = livreEm.get(atendente.professionalId) ?? 0;
      // Empate resolve pela ordem recebida, que é estável: sem isso a mesma
      // fila produziria atribuições diferentes entre duas leituras da tela.
      if (quando < inicio) {
        inicio = quando;
        escolhido = atendente.professionalId;
      }
    }

    if (escolhido === null) {
      // Preferiu alguém que não está atendendo hoje. Some da conta em vez de
      // virar espera infinita: a tela precisa dizer "escolha outro", não "3 h".
      return {
        id: pedido.id,
        posicao: indice + 1,
        professionalId: null,
        esperaMinutos: null,
        atrasaMarcado: false,
      };
    }

    const fim = inicio + pedido.duracaoMinutos;
    const marcado = proximoMarcado.get(escolhido) ?? null;
    livreEm.set(escolhido, fim);

    return {
      id: pedido.id,
      posicao: indice + 1,
      professionalId: escolhido,
      esperaMinutos: inicio,
      atrasaMarcado: marcado !== null && fim > marcado,
    };
  });
}

/** O que a recepção vê antes de decidir a cadeira. */
export interface CustoDoEncaixe {
  readonly professionalId: string;
  readonly livreEmMinutos: number;
  readonly cabe: boolean;
  /** Minutos que sobram até o próximo marcado. `null` quando não há próximo. */
  readonly sobraMinutos: number | null;
  /** Quanto o atendimento passaria do próximo marcado. `0` quando cabe. */
  readonly invadeMinutos: number;
}

/**
 * Quanto custa encaixar alguém agora, por cadeira.
 *
 * O número que importa não é "está livre?" — é **quanto tempo existe até o
 * próximo marcado**. Uma cadeira livre com quinze minutos até o próximo cliente
 * não comporta um corte de trinta, e é assim que a barbearia começa o dia
 * quinze minutos atrasada e termina uma hora.
 *
 * Não decide por ninguém: devolve o custo de cada opção e deixa a recepção
 * escolher, porque às vezes o certo é encaixar mesmo assim e avisar o próximo.
 */
export function custoDoEncaixe(params: {
  readonly atendentes: readonly AtendenteNaFila[];
  readonly duracaoMinutos: number;
}): readonly CustoDoEncaixe[] {
  return params.atendentes.map((atendente) => {
    const fim = atendente.livreEmMinutos + params.duracaoMinutos;
    const marcado = atendente.proximoMarcadoEmMinutos;

    if (marcado === null) {
      return {
        professionalId: atendente.professionalId,
        livreEmMinutos: atendente.livreEmMinutos,
        cabe: true,
        sobraMinutos: null,
        invadeMinutos: 0,
      };
    }

    return {
      professionalId: atendente.professionalId,
      livreEmMinutos: atendente.livreEmMinutos,
      cabe: fim <= marcado,
      sobraMinutos: Math.max(0, marcado - fim),
      invadeMinutos: Math.max(0, fim - marcado),
    };
  });
}

/**
 * Quantos minutos esperar de um serviço, para efeito de fila.
 *
 * A SPEC pede a **duração real média, não a cadastrada**, e está certa: o corte
 * que o catálogo diz durar 30 minutos leva 40 na cadeira daquele barbeiro, e é
 * o número de 40 que faz a estimativa bater.
 *
 * Duas defesas, e as duas existem por uma falha concreta e provável:
 *
 * - **Amostra mínima.** Um único atendimento medido não é média. Com dois ou
 *   três registros, um dia atípico vira a estimativa de todo mundo.
 * - **Teto e piso em torno da cadastrada.** `completed_at` é preenchido quando
 *   alguém toca o botão, e o botão é tocado tarde: recepção movimentada
 *   "conclui" o atendimento das 14h às 17h. Sem limite, esse registro só
 *   sozinho jogaria a fila para três horas de espera. O limite não conserta o
 *   dado ruim — impede que ele contamine a conta enquanto ninguém percebe.
 */
export const AMOSTRAS_MINIMAS = 5;
const PISO = 0.5;
const TETO = 2;

export function duracaoEsperada(params: {
  readonly cadastradaMinutos: number;
  readonly mediaRealMinutos: number | null;
  readonly amostras: number;
  readonly amostrasMinimas?: number;
}): number {
  const minimo = params.amostrasMinimas ?? AMOSTRAS_MINIMAS;
  if (params.mediaRealMinutos === null || params.amostras < minimo) {
    return params.cadastradaMinutos;
  }

  const limitada = Math.min(
    Math.max(params.mediaRealMinutos, params.cadastradaMinutos * PISO),
    params.cadastradaMinutos * TETO,
  );
  return Math.max(1, Math.round(limitada));
}

/**
 * O que dizer a quem está esperando.
 *
 * A SPEC pede "Você é o próximo" para a posição 1. As outras faixas existem
 * porque minuto exato numa fila é promessa que a barbearia não controla: o
 * cliente que leu "12 min" e esperou 20 não perdoa, e o que leu "cerca de 15"
 * e esperou 20 nem lembra.
 */
export function frasePosicao(lugar: {
  readonly posicao: number;
  readonly esperaMinutos: number | null;
}): string {
  if (lugar.esperaMinutos === null) return 'Fale com a recepção para escolher outro profissional.';
  if (lugar.posicao === 1 && lugar.esperaMinutos <= 5) return 'Você é o próximo.';
  if (lugar.esperaMinutos <= 5) return 'Quase lá — menos de 5 minutos.';
  if (lugar.esperaMinutos <= 15) return 'Cerca de 15 minutos de espera.';
  if (lugar.esperaMinutos <= 30) return 'Cerca de meia hora de espera.';
  if (lugar.esperaMinutos <= 60) return 'Cerca de uma hora de espera.';
  return 'Mais de uma hora de espera.';
}
