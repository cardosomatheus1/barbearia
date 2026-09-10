import { headers } from 'next/headers';
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export async function cabecalhosDoVisitante(input: Parameters<typeof fetch>[0]): Promise<Record<string, string>> {
  const secret = process.env['INTERNAL_PROXY_SECRET'] ?? '';
  const api = process.env['API_URL'] ?? 'http://127.0.0.1:3000';
  const url = input instanceof Request ? input.url : String(input);
  if (secret.length < 32 || new URL(url, api).origin !== new URL(api).origin) return {};
  try {
    const incoming = await headers();
    const key = incoming.get('x-barberdock-proxy-key') ?? '';
    const ip = incoming.get('x-barberdock-client-ip') ?? '';
    if (!isIP(ip) || Buffer.byteLength(key) !== Buffer.byteLength(secret) ||
      !timingSafeEqual(Buffer.from(key), Buffer.from(secret))) return {};
    return { 'x-barberdock-proxy-key': secret, 'x-barberdock-client-ip': ip };
  } catch {
    // Build e tarefas sem requisição não têm identidade de visitante.
    return {};
  }
}
