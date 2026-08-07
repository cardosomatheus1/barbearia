import type { Minutes } from './time.js';
import type { BufferPolicy, ComboRule, Service } from './types.js';

export interface ResolvedDuration {
  /** Tempo visível ao cliente: execução dos serviços, sem buffers. */
  readonly serviceMinutes: Minutes;
  /** Tempo ocupado na agenda: execução + buffers. */
  readonly occupiedMinutes: Minutes;
  /** Buffer aplicado antes da execução. */
  readonly bufferBefore: Minutes;
  /** Buffer aplicado depois da execução. */
  readonly bufferAfter: Minutes;
  /** Combo aplicado, quando o conjunto escolhido casou com uma regra. */
  readonly appliedComboId: string | null;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  if (left.size !== a.length) return false; // duplicata: não é conjunto
  for (const item of b) {
    if (!left.has(item)) return false;
  }
  return true;
}

/**
 * Escolhe a regra de combo que casa exatamente com os serviços selecionados.
 * Havendo mais de uma, vence a de menor duração declarada (melhor para o cliente).
 */
function findCombo(
  serviceIds: readonly string[],
  rules: readonly ComboRule[],
): ComboRule | null {
  let best: ComboRule | null = null;
  for (const rule of rules) {
    if (!sameSet(serviceIds, rule.componentServiceIds)) continue;
    if (best === null || rule.declaredDurationMinutes < best.declaredDurationMinutes) {
      best = rule;
    }
  }
  return best;
}

/**
 * Resolve quanto tempo o conjunto de serviços ocupa na agenda.
 *
 * Duas decisões deliberadas, ambas divergindo do que o sistema analisado faz:
 *
 * 1. **Buffer externo por padrão.** A SPEC v1 dizia `Σ(buffer_before + duração +
 *    buffer_after)`, o que cobraria uma limpeza entre o corte e a barba do mesmo
 *    cliente. Na prática há um preparo no início e uma limpeza no fim. Usa-se o
 *    maior buffer entre os serviços escolhidos, não o do primeiro — se algum
 *    serviço exige 10 min de limpeza, o bloco inteiro precisa deles.
 *
 * 2. **Combo só encurta se declarado.** Sem regra explícita, a duração é a soma.
 *    Nunca se infere que "Corte + Barba" leva menos que Corte mais Barba.
 */
export function resolveDuration(
  services: readonly Service[],
  options: {
    readonly comboRules?: readonly ComboRule[];
    readonly bufferPolicy?: BufferPolicy;
  } = {},
): ResolvedDuration {
  if (services.length === 0) {
    throw new RangeError('Nenhum serviço selecionado');
  }
  for (const service of services) {
    if (!Number.isInteger(service.durationMinutes) || service.durationMinutes <= 0) {
      throw new RangeError(`Serviço "${service.id}" com duração inválida: ${service.durationMinutes}`);
    }
  }

  const policy = options.bufferPolicy ?? 'outer';
  const rules = options.comboRules ?? [];

  const combo = findCombo(
    services.map((s) => s.id),
    rules,
  );

  const rawServiceMinutes = services.reduce((total, s) => total + s.durationMinutes, 0);
  const serviceMinutes = combo ? combo.declaredDurationMinutes : rawServiceMinutes;

  let bufferBefore: Minutes;
  let bufferAfter: Minutes;

  if (policy === 'perService') {
    bufferBefore = services.reduce((total, s) => total + s.bufferBeforeMinutes, 0);
    bufferAfter = services.reduce((total, s) => total + s.bufferAfterMinutes, 0);
  } else {
    bufferBefore = Math.max(...services.map((s) => s.bufferBeforeMinutes));
    bufferAfter = Math.max(...services.map((s) => s.bufferAfterMinutes));
  }

  return {
    serviceMinutes,
    occupiedMinutes: bufferBefore + serviceMinutes + bufferAfter,
    bufferBefore,
    bufferAfter,
    appliedComboId: combo?.id ?? null,
  };
}
