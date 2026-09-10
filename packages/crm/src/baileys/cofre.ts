import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

function chave(): Buffer {
  const raw = process.env['WHATSAPP_TOKEN_KEY'];
  if (!raw || !/^[A-Za-z0-9+/]{43}=$/.test(raw) || Buffer.from(raw, 'base64').length !== 32) {
    throw new Error('WHATSAPP_TOKEN_KEY precisa conter 32 bytes em base64');
  }
  return Buffer.from(hkdfSync('sha256', Buffer.from(raw, 'base64'), Buffer.alloc(0), 'barberdock-baileys-v1', 32));
}

/** AAD impede que uma credencial cifrada seja transplantada para outra sessão. */
export function cifrarBaileys(valor: string, escopo: string): string {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', chave(), iv);
  cipher.setAAD(Buffer.from(escopo));
  return Buffer.concat([iv, cipher.update(valor, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
}

export function decifrarBaileys(valor: string, escopo: string): string {
  try {
    const buf = Buffer.from(valor, 'base64'); if (buf.length < 28) throw new Error();
    const cipher = createDecipheriv('aes-256-gcm', chave(), buf.subarray(0, 12));
    cipher.setAAD(Buffer.from(escopo)); cipher.setAuthTag(buf.subarray(-16));
    return Buffer.concat([cipher.update(buf.subarray(12, -16)), cipher.final()]).toString('utf8');
  } catch { throw new Error('baileys_credencial_invalida'); }
}

export function hashBaileys(valor: string): string {
  return createHmac('sha256', chave()).update(valor).digest('hex');
}

/** Buffer.toJSON roda antes do replacer; restaura Buffer e Uint8Array igualmente. */
export function serializarBaileys(valor: unknown): string {
  return JSON.stringify(valor, (_key, v: unknown) => {
    if (v instanceof Uint8Array) return { tipo: 'bytes', base64: Buffer.from(v).toString('base64') };
    if (v && typeof v === 'object' && 'type' in v && v.type === 'Buffer' && 'data' in v && Array.isArray(v.data)) {
      return { tipo: 'bytes', base64: Buffer.from(v.data as number[]).toString('base64') };
    }
    return v;
  });
}

export function desserializarBaileys(valor: string): unknown {
  return JSON.parse(valor, (_key, v: unknown) => {
    if (v && typeof v === 'object' && 'tipo' in v && v.tipo === 'bytes' && 'base64' in v && typeof v.base64 === 'string') {
      return Buffer.from(v.base64, 'base64');
    }
    return v;
  }) as unknown;
}
