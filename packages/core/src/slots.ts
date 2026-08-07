import type { Minutes, TimeRange } from './time.js';
import type { SlotStrategy } from './types.js';

export const DEFAULT_GRANULARITY: Record<SlotStrategy, Minutes> = {
  anchored: 5,
  grid: 15,
};

/**
 * Gera os minutos de início candidatos dentro de uma janela livre.
 *
 * A diferença entre as estratégias está inteiramente aqui.
 *
 * Numa janela livre de 09:20–11:00 para um serviço de 20 min:
 *
 *   anchored (passo 5)  → 09:20, 09:25, 09:30, ... 10:40
 *   grid     (passo 15) → 09:30, 09:45, 10:00, ... 10:30
 *
 * A grade fixa descarta os 10 minutos entre 09:20 e 09:30 — eles nunca serão
 * vendidos. Numa jornada de 9 horas isso custa cerca de dois atendimentos por
 * profissional por dia (SPEC Parte 2 §2.4).
 */
export function generateStarts(
  window: TimeRange,
  occupiedMinutes: Minutes,
  step: Minutes,
  strategy: SlotStrategy,
): Minutes[] {
  if (occupiedMinutes <= 0) throw new RangeError(`Duração inválida: ${occupiedMinutes}`);
  if (step <= 0) throw new RangeError(`Passo inválido: ${step}`);

  const latestStart = window.end - occupiedMinutes;
  if (latestStart < window.start) return [];

  const first =
    strategy === 'grid'
      ? Math.ceil(window.start / step) * step
      : window.start;

  const starts: Minutes[] = [];
  for (let start = first; start <= latestStart; start += step) {
    starts.push(start);
  }

  // Slot de cauda: o passo raramente cai exatamente no último início que cabe.
  // Sem isso, o fim da janela é desperdiçado do mesmo jeito que a grade fixa
  // desperdiça o começo — numa jornada até 18:00 com passo 15 e serviço de 20
  // min, o último slot seria 17:30 e os 10 minutos até 17:40 morreriam.
  // Só se aplica ao modo ancorado: em `grid` a grade rígida é o comportamento
  // desejado.
  if (strategy === 'anchored' && starts.at(-1) !== latestStart) {
    starts.push(latestStart);
  }

  return starts;
}
