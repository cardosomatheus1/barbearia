import { describe, expect, it, vi } from 'vitest';
import { verificarTurnstile } from './turnstile.js';

const ENV = {
  NODE_ENV: 'production',
  TURNSTILE_SECRET_KEY: 'segredo-de-teste',
  TURNSTILE_HOSTNAMES: 'barberdock.example,www.barberdock.example',
} as NodeJS.ProcessEnv;

const resposta = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Turnstile server-side', () => {
  it('permite desenvolvimento local sem configuração', async () => {
    await expect(verificarTurnstile({ action: 'signup', env: { NODE_ENV: 'development' } })).resolves.toEqual({
      ok: true,
      ignorado: true,
    });
  });

  it('falha fechado em produção sem segredo', async () => {
    await expect(verificarTurnstile({ action: 'signup', env: { NODE_ENV: 'production' } })).resolves.toEqual({
      ok: false,
      code: 'configuracao_ausente',
    });
  });

  it('recusa token ausente ou grande demais sem chamar o provedor', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(verificarTurnstile({ action: 'signup', env: ENV, fetcher })).resolves.toEqual({ ok: false, code: 'token_invalido' });
    await expect(verificarTurnstile({ token: 'x'.repeat(2049), action: 'signup', env: ENV, fetcher })).resolves.toEqual({ ok: false, code: 'token_invalido' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('envia segredo/token/ip por POST e bloqueia redirect', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('error');
      const body = init?.body as URLSearchParams;
      expect(body.get('secret')).toBe('segredo-de-teste');
      expect(body.get('response')).toBe('token-ok');
      expect(body.get('remoteip')).toBe('203.0.113.7');
      return resposta({ success: true, hostname: 'barberdock.example', action: 'signup' });
    });
    await expect(verificarTurnstile({ token: 'token-ok', ip: '203.0.113.7', action: 'signup', env: ENV, fetcher })).resolves.toEqual({ ok: true, ignorado: false });
  });

  it('recusa action e hostname que não pertencem a esta porta', async () => {
    const actionErrada = vi.fn<typeof fetch>(async () => resposta({ success: true, hostname: 'barberdock.example', action: 'login' }));
    const hostErrado = vi.fn<typeof fetch>(async () => resposta({ success: true, hostname: 'evil.example', action: 'signup' }));
    await expect(verificarTurnstile({ token: 't', action: 'signup', env: ENV, fetcher: actionErrada })).resolves.toEqual({ ok: false, code: 'token_invalido' });
    await expect(verificarTurnstile({ token: 't', action: 'signup', env: ENV, fetcher: hostErrado })).resolves.toEqual({ ok: false, code: 'token_invalido' });
  });

  it('degrada falha de rede/HTTP/JSON como indisponibilidade, sem liberar cadastro', async () => {
    const rede = vi.fn<typeof fetch>(async () => { throw new Error('token-secreto-nao-deve-vazar'); });
    const http = vi.fn<typeof fetch>(async () => resposta({}, 503));
    const json = vi.fn<typeof fetch>(async () => new Response('não-json', { status: 200 }));
    for (const fetcher of [rede, http, json]) {
      await expect(verificarTurnstile({ token: 't', action: 'signup', env: ENV, fetcher })).resolves.toEqual({ ok: false, code: 'provedor_indisponivel' });
    }
  });
});
