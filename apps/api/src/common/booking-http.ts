import { BookingError, BookingRecusadoPorScore, type BookingFailure } from '@barbearia/scheduling';
import { DomainError } from './errors.js';

/**
 * A recusa do motor de reserva, traduzida para HTTP **uma vez só**.
 *
 * Cinco superfícies chamam `createAppointment` e `rescheduleAppointment` — a
 * agenda do painel, o quadro do dia, a oferta de vaga, a porta do cliente e a
 * API pública — e cada uma escrevia a própria tradução. As cinco discordavam:
 * `slot_taken` era 409 em três, 400 numa e **500** na API pública, que não
 * traduzia nada e deixava a recusa cair no tratador genérico.
 *
 * 500 sobre "esse horário acabou de ser marcado" é o pior dos cinco: o
 * integrador lê "erro interno", retenta o mesmo horário, e o monitoramento
 * conta como falha de infraestrutura o produto funcionando. É a §6 pergunta 6
 * — duas telas que mostram o mesmo fato concordam — aplicada a duas portas da
 * mesma API.
 *
 * ## O mapa é `Record<BookingFailure, number>`, e não `Record<string, number>`
 *
 * Com a chave larga, a recusa nova nasce com o padrão de quem escreveu o `??` —
 * e foi assim que `score_no_pico` ficou fora dos quatro mapas. Com a união, o
 * compilador cobra a resposta no dia em que o motor ganhar a décima primeira.
 */
export const STATUS_DA_RESERVA: Readonly<Record<BookingFailure, number>> = {
  unknown_location: 404,
  slot_not_available: 409,
  slot_taken: 409,
  appointment_not_found: 404,
  appointment_not_active: 409,
  hold_expired: 409,
  /**
   * 409, não 403: a regra é sobre o estado do agendamento no tempo, não sobre
   * quem está pedindo. O mesmo cliente podia ontem e não pode agora.
   */
  too_late: 409,
  too_many_reschedules: 409,
  already_started: 409,
  /**
   * 409, e não 403 (bloco 60).
   *
   * 403 é "você não tem acesso a isto", e a pessoa **tem**: ela pode ser
   * atendida, pelo balcão, naquela mesma hora. O que não cabe é marcar sozinha
   * numa hora cheia — um conflito com o estado, que é o que 409 diz. A mensagem
   * nunca cita score: ele é interno por regra da SPEC §2.13.
   */
  score_no_pico: 409,
};

/**
 * O código que **sai** da API não nomeia o mecanismo.
 *
 * A regra é do bloco 60 e vinha sendo cumprida num lugar só: a ação da web
 * trocava `score_no_pico` por `so_recepcao` antes de escrever na URL, porque
 * `?erro=score_no_pico` fica no histórico do navegador, no autocompletar e em
 * qualquer referrer — o número não vazava, a existência do julgamento vazava.
 *
 * Este bloco levou a tradução da recusa para quatro superfícies novas, entre
 * elas a **API com chave**, onde antes ela saía como 500 genérico. Sanear na
 * última tela seria a quinta cópia da mesma decisão, e a chave de API não passa
 * por tela nenhuma: com `appointments.create` sozinho — o máximo que uma chave
 * carrega, porque dinheiro não vira escopo — o integrador classificaria a base
 * em "recusado por confiabilidade" contra "aceito", varrendo telefones contra
 * um horário de pico.
 *
 * O código interno continua inteiro no log e na linha que a recusa gravou; o
 * que muda é o que atravessa a rede. Achado da `/security-review` deste bloco.
 */
const CODIGO_QUE_SAI: Readonly<Partial<Record<BookingFailure, string>>> = {
  score_no_pico: 'so_recepcao',
};

/**
 * Traduz a recusa se ela for do motor, e volta calada se não for.
 *
 * Não relança o erro alheio de propósito: cada controller tem os erros do
 * próprio assunto para tratar, e um tradutor que relançasse obrigaria a
 * chamada dele a ser sempre a última — que é o contrário do que se quer, já
 * que a recusa do motor é a mais específica das duas.
 */
export function traduzirReserva(erro: unknown): void {
  if (erro instanceof BookingRecusadoPorScore) {
    throw new DomainError(
      CODIGO_QUE_SAI[erro.code] ?? erro.code,
      STATUS_DA_RESERVA[erro.code],
      erro.message,
    );
  }
  if (erro instanceof BookingError) {
    throw new DomainError(
      CODIGO_QUE_SAI[erro.code] ?? erro.code,
      STATUS_DA_RESERVA[erro.code] ?? 400,
      erro.message,
    );
  }
}
