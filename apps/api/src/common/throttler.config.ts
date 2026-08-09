import type { ThrottlerModuleOptions } from '@nestjs/throttler';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Limite de requisições por IP.
 *
 * `/availability` é o endpoint mais caro da API e o mais fácil de abusar: sem
 * teto, um laço de datas e serviços vira negação de serviço barata
 * (CLAUDE.md §2). Os valores são folgados para uso legítimo — um cliente
 * navegando pelo calendário faz alguns pedidos por minuto.
 *
 * Configurável por ambiente para que a suíte possa exercitar o limite de
 * propósito em vez de esbarrar nele por acidente.
 */
export function throttlerConfig(): ThrottlerModuleOptions {
  return [
    { name: NOMES_DOS_LIMITES[0], ttl: envInt('RATE_LIMIT_SHORT_TTL_MS', 10_000), limit: envInt('RATE_LIMIT_SHORT', 20) },
    { name: NOMES_DOS_LIMITES[1], ttl: envInt('RATE_LIMIT_LONG_TTL_MS', 60_000), limit: envInt('RATE_LIMIT_LONG', 120) },
  ];
}

/** Os limitadores configurados, na ordem em que o módulo os registra. */
export const NOMES_DOS_LIMITES = ['short', 'long'] as const;

/**
 * O mapa que `@SkipThrottle` precisa receber para isentar uma rota de verdade.
 *
 * `@SkipThrottle()` sem argumento significa `{ default: true }` — e isenta
 * **só** o limitador chamado `default`. Como os nossos se chamam `short` e
 * `long`, o decorador nu não isentava nada, e a sonda de saúde ficava sujeita
 * ao teto como qualquer rota. O balanceador que consulta `/health` de segundo
 * em segundo levaria 429 em vinte segundos, e o orquestrador mataria um
 * processo saudável achando que ele caiu.
 *
 * Derivado da mesma lista que configura o módulo, e não copiado à mão: um
 * limitador novo passa a ser isentado sozinho. Há teste que confere os dois
 * lados.
 */
export const FORA_DO_LIMITE: Readonly<Record<string, boolean>> = Object.fromEntries(
  NOMES_DOS_LIMITES.map((nome) => [nome, true]),
);
