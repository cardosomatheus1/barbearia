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
    { name: 'short', ttl: envInt('RATE_LIMIT_SHORT_TTL_MS', 10_000), limit: envInt('RATE_LIMIT_SHORT', 20) },
    { name: 'long', ttl: envInt('RATE_LIMIT_LONG_TTL_MS', 60_000), limit: envInt('RATE_LIMIT_LONG', 120) },
  ];
}
