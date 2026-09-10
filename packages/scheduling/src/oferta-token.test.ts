import { afterEach, expect, it, vi } from 'vitest';
import { cifrarTokenDaOferta, decifrarTokenDaOferta } from './oferta-token.js';
afterEach(()=>vi.unstubAllEnvs());
it('a cifra não pode ser transplantada entre tenants, ofertas ou chaves',()=>{
  vi.stubEnv('WHATSAPP_TOKEN_KEY',Buffer.alloc(32,19).toString('base64'));
  const cifra=cifrarTokenDaOferta('convite-sintetico','tenant-a','oferta-a');
  expect(decifrarTokenDaOferta(cifra,'tenant-a','oferta-a')).toBe('convite-sintetico');
  expect(()=>decifrarTokenDaOferta(cifra,'tenant-b','oferta-a')).toThrow();
  expect(()=>decifrarTokenDaOferta(cifra,'tenant-a','oferta-b')).toThrow();
  vi.stubEnv('WHATSAPP_TOKEN_KEY',Buffer.alloc(32,20).toString('base64'));
  expect(()=>decifrarTokenDaOferta(cifra,'tenant-a','oferta-a')).toThrow();
});
