import type { MotivoDoSinal } from '@barbearia/core';

/** Códigos estáveis de falha. A API os traduz para HTTP sem reinterpretar. */
export type BookingFailure =
  | 'unknown_location'
  | 'slot_not_available'
  | 'slot_taken'
  | 'idempotencia_conflitante'
  | 'hold_invalido'
  | 'appointment_not_found'
  | 'appointment_not_active'
  | 'hold_expired'
  | 'too_late'
  | 'too_many_reschedules'
  | 'already_started'
  /** Bloco 60: score baixo não marca sozinho em hora cheia. Só a recepção. */
  | 'score_no_pico';

/** Espelha o enum `appointment_source`. Valor fora da lista quebraria o INSERT
 *  com erro de banco em vez de recusa limpa. */
export type AppointmentSource =
  | 'website' | 'app' | 'whatsapp' | 'instagram' | 'google' | 'marketplace'
  | 'reception' | 'professional' | 'api' | 'recurrence' | 'waitlist';

/**
 * Os canais em que quem marca é **a casa**, e não o cliente sozinho.
 *
 * A SPEC §2.13 escreve *"só recepção"*, e a lista existe para que um canal novo
 * nasça do lado certo: quem for acrescentado sem pensar cai no lado do cliente,
 * que é o conservador — a regra vale, e alguém repara.
 *
 * `recurrence` entra porque a recorrência foi criada por alguém do balcão uma
 * vez e se repete sozinha; recusá-la faria a série morrer no meio sem que o
 * cliente tenha feito nada. `waitlist` entra porque a vaga foi **oferecida**
 * pela casa: convidar e depois recusar é o pior desfecho possível.
 */
export const PELO_BALCAO = new Set<AppointmentSource>(['reception', 'professional', 'recurrence', 'waitlist']);

/**
 * A recusa carrega o score e o limiar para o registro ser feito depois.
 *
 * Fora da transação, porque a transação voltou atrás: `registrarRecusaOnline`
 * abre a sua. Uma falha ao registrar não pode transformar uma recusa explicada
 * num erro genérico na tela de quem está com o telefone na mão.
 */
export class BookingRecusadoPorScore extends Error {
  readonly code = 'score_no_pico' as const;
  constructor(
    readonly score: number,
    readonly limiar: number,
    readonly comecaEm: Date,
  ) {
    super('Este horário só pode ser marcado pela recepção.');
    this.name = 'BookingRecusadoPorScore';
  }
}

export class BookingError extends Error {
  constructor(readonly code: BookingFailure, message: string) {
    super(message);
    this.name = 'BookingError';
  }
}

const EXCLUSION_VIOLATION = '23P01';
export const UNIQUE_VIOLATION = '23505';
const DEADLOCK = '40P01';
const SERIALIZATION_FAILURE = '40001';

/**
 * Duas pessoas disputando o mesmo horário — pelos **três** códigos que isso tem.
 *
 * A constraint de exclusão anti-overbooking recusa o segundo com `23P01`, e era
 * só isso que este código reconhecia. Mas o Postgres tem outro desfecho para a
 * mesma disputa, e ele é o comum quando três ou mais chegam juntos: cada
 * transação grava a própria entrada no índice GiST e **depois** espera o xid da
 * outra para saber se pode. Duas esperando uma pela outra é `40P01`; sob
 * `SERIALIZABLE` a mesma cena sai como `40001`.
 *
 * Seis `POST` simultâneos no mesmo horário devolviam `201` e **cinco `500`** —
 * "Erro interno" para quem só chegou em segundo lugar, e uma repetição que
 * sempre falha, porque o horário de fato acabou. O desfecho verdadeiro é o
 * mesmo nos três: quem ganhou gravou, e este pedido precisa reler a grade.
 *
 * A pergunta do produto é *"o horário ainda é meu?"*, e a resposta é não. Não
 * há ambiguidade a resolver: quem perdeu o deadlock foi abortado sem gravar
 * nada, e quem venceu segue para o commit.
 *
 * O `catch` envolve **uma** instrução — o `INSERT` do agendamento —, então não
 * há como um deadlock de outra origem entrar por aqui e virar "horário
 * ocupado".
 */
export function contencaoDeHorario(error: unknown): boolean {
  const code = pgCode(error);
  return code === EXCLUSION_VIOLATION || code === DEADLOCK || code === SERIALIZATION_FAILURE;
}

/**
 * Extrai o SQLSTATE do Postgres de um erro do Prisma.
 *
 * Consulta crua falha como `PrismaClientKnownRequestError` com `code: 'P2010'`
 * — o código do Prisma, não do banco. O SQLSTATE real fica em `meta.code`, e
 * como último recurso na mensagem. Ler só `error.code` devolveria sempre
 * 'P2010' e nenhuma violação seria reconhecida.
 */
export function pgCode(error: unknown): string | null {
  const meta = (error as { meta?: { code?: unknown } })?.meta;
  if (typeof meta?.code === 'string') return meta.code;

  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && !/^P\d+$/.test(code)) return code;

  const message = error instanceof Error ? error.message : '';
  return /Code: `(\w+)`/.exec(message)?.[1] ?? null;
}

export interface AppointmentRef {
  readonly id: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly serviceStartsAt: string;
  readonly serviceEndsAt: string;
  readonly professionalId: string;
  readonly status: string;
  readonly priceCents: number;
  /**
   * Sinal exigido na criação, em centavos. Zero quando não foi exigido.
   *
   * Congelado aqui e não recalculado na leitura: a política da unidade e o
   * histórico do cliente mudam, e o que ele combinou de pagar não muda com
   * eles. Ler de novo faria a recepção cobrar um valor e a tela mostrar outro.
   */
  readonly depositRequiredCents: number;
  /** Por que o sinal foi exigido. Nulo quando não foi. */
  readonly depositReason: MotivoDoSinal | null;
  /** Verdadeiro quando a chave de idempotência devolveu um registro já existente. */
  readonly deduplicated: boolean;
}

export interface CreateAppointmentRequest {
  readonly tenantId: string;
  readonly locationId: string;
  readonly professionalId: string;
  readonly serviceIds: readonly string[];
  /** Data local da unidade, YYYY-MM-DD. */
  readonly date: string;
  /** Início visível ao cliente, HH:mm local. */
  readonly start: string;
  readonly customerId?: string;
  readonly source?: AppointmentSource;
  readonly notes?: string;
  readonly idempotencyKey?: string;
  readonly holdId?: string;
  readonly now?: Date;
  /**
   * Marcação pelo balcão: sem antecedência mínima e sem janela máxima.
   *
   * Só quem já está autenticado como equipe pode passar isto — nunca vem do
   * corpo de uma requisição do cliente, senão a guarda de autoatendimento seria
   * desligada por quem ela existe para conter.
   */
  readonly atCounter?: boolean;
}

