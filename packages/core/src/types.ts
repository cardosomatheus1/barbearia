import type { Minutes, TimeRange } from './time.js';

/**
 * Estratégia de geração de slots.
 *
 * - `anchored` (default): o primeiro slot nasce no início da janela livre — ou
 *   seja, colado no fim do atendimento anterior — e os seguintes avançam pela
 *   granularidade. Não há grade fixa, então não sobra buraco morto.
 * - `grid`: grade fixa alinhada à meia-noite (09:00, 09:15, 09:30…), como fazem
 *   os sistemas legados. Mantido porque parte das barbearias prefere horário
 *   "redondo" para o cliente memorizar.
 *
 * SPEC Parte 2 §2.4.
 */
export type SlotStrategy = 'anchored' | 'grid';

/**
 * Como os buffers se combinam quando o cliente escolhe vários serviços na mesma
 * visita.
 *
 * - `outer` (default): um preparo no início e uma limpeza no fim do bloco todo.
 *   Corresponde à realidade — não se limpa a estação entre o corte e a barba do
 *   mesmo cliente.
 * - `perService`: soma o buffer de cada serviço. Usar quando os serviços exigem
 *   troca de estação ou higienização entre etapas.
 */
export type BufferPolicy = 'outer' | 'perService';

export interface ResourceRequirement {
  readonly resourceType: string;
  readonly quantity: number;
}

export interface Service {
  readonly id: string;
  readonly durationMinutes: Minutes;
  readonly bufferBeforeMinutes: Minutes;
  readonly bufferAfterMinutes: Minutes;
  readonly requiredResources?: readonly ResourceRequirement[];
}

/**
 * Combo com duração declarada menor que a soma das partes.
 *
 * A duração precisa ser declarada explicitamente — nunca inferida. Foi a
 * ausência dessa trava que produziu, no sistema analisado,
 * "Cabelo + Barba + Sobrancelha = 30 min" por R$ 94 (SPEC §2.2, defeito D4).
 * O validador de catálogo (SPEC Parte 5 §5.7) rejeita combos implausíveis.
 */
export interface ComboRule {
  readonly id: string;
  readonly componentServiceIds: readonly string[];
  readonly declaredDurationMinutes: Minutes;
}

/** Agenda de um profissional num dia específico, já resolvida. */
export interface ProfessionalDay {
  readonly professionalId: string;
  /** Jornada do dia (jornada semanal já sobreposta pelas exceções da data). */
  readonly working: readonly TimeRange[];
  /** Intervalos: almoço, descanso fixo. */
  readonly breaks?: readonly TimeRange[];
  /** Agendamentos existentes, já incluindo os buffers ocupados. */
  readonly busy?: readonly TimeRange[];
  /** Bloqueios pontuais. */
  readonly blocks?: readonly TimeRange[];
  /** Quantos atendimentos o profissional já tem no dia. */
  readonly appointmentCount?: number;
  /** Teto de atendimentos por dia. */
  readonly dailyLimit?: number;
  /** Preço específico do profissional para o conjunto de serviços escolhido. */
  readonly price?: number;
}

/** Capacidade e ocupação de um tipo de recurso na unidade. */
export interface ResourcePool {
  readonly resourceType: string;
  readonly capacity: number;
  readonly busy?: readonly TimeRange[];
}

export interface AvailabilityQuery {
  /** Data no fuso da unidade, formato YYYY-MM-DD. Não participa do cálculo,
   *  é devolvida junto do resultado para o chamador. */
  readonly date: string;
  readonly services: readonly Service[];
  readonly professionals: readonly ProfessionalDay[];
  readonly comboRules?: readonly ComboRule[];
  readonly resourcePools?: readonly ResourcePool[];
  readonly strategy?: SlotStrategy;
  readonly bufferPolicy?: BufferPolicy;
  /** Passo entre slots candidatos. Default 5 (anchored) / 15 (grid). */
  readonly granularityMinutes?: Minutes;
  /**
   * Minuto local a partir do qual é permitido agendar neste dia.
   * O chamador calcula como `agora + antecedência mínima` quando a data é hoje,
   * e omite quando é data futura. O motor nunca lê o relógio — é função pura.
   */
  readonly earliestStartMinute?: Minutes;
}

export interface Slot {
  /** Início visível ao cliente — não inclui o buffer de preparo. */
  readonly start: string;
  /** Fim visível ao cliente — não inclui o buffer de limpeza. */
  readonly end: string;
  /**
   * Início real da ocupação na agenda, incluindo o buffer de preparo.
   * Com `bufferBefore` zero é igual a `start`; é o par de `occupiedEnd` e o que
   * de fato vai para `appointments.starts_at`.
   */
  readonly occupiedStart: string;
  /** Fim real da ocupação na agenda, incluindo buffers. */
  readonly occupiedEnd: string;
  readonly professionalId: string;
  readonly price?: number;
}

/** Motivo pelo qual um dia não tem nenhum horário. Resolve o defeito D3. */
export type UnavailableReason =
  | 'closed'
  | 'fully_booked'
  | 'no_qualified_professional'
  | 'resource_unavailable'
  | 'past_cutoff'
  | 'daily_limit_reached';

export interface AvailabilityResult {
  readonly date: string;
  readonly totalDurationMinutes: Minutes;
  readonly serviceDurationMinutes: Minutes;
  readonly granularityMinutes: Minutes;
  readonly strategy: SlotStrategy;
  readonly slots: readonly Slot[];
  /** `null` quando há slots. Preenchido quando a lista vem vazia. */
  readonly unavailableReason: UnavailableReason | null;
  /** Verdadeiro quando faz sentido oferecer entrada na lista de espera. */
  readonly waitlistAvailable: boolean;
}
