import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request, Response, NextFunction } from 'express';

/** Só Caddy e Next conhecem a chave; X-Forwarded-For público nunca decide a cota. */
export function proxyConfiavel(req: Request, _res: Response, next: NextFunction): void {
  const expected = process.env['INTERNAL_PROXY_SECRET'] ?? '';
  const provided = req.headers['x-barberdock-proxy-key'];
  const ip = req.headers['x-barberdock-client-ip'];
  const authenticated = expected.length >= 32 && typeof provided === 'string' &&
    Buffer.byteLength(provided) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  const address = authenticated && typeof ip === 'string' && isIP(ip) ? ip : req.socket.remoteAddress;
  Object.defineProperty(req, 'ip', { configurable: true, value: address });
  delete req.headers['x-barberdock-proxy-key'];
  next();
}
