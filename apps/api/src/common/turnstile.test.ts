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

  /**
   * O interruptor de provedor não contratado, e o motivo de ele existir.
   *
   * Sem esta saída, tirar a exigência do preflight moveria a quebra do deploy
   * para o runtime — `/admin/criar-conta` responderia 403 a todo mundo, porque
   * `verificarTurnstile` falha fechado em produção. A pendência assumida tem
   * que abrir a porta de verdade, não adiar o erro.
   */
  it('BOT_PROTECTION_MODO=nenhum abre a porta mesmo em produção e sem chave', async () => {
    const nunca = vi.fn<typeof fetch>(async () => { throw new Error('não deveria chamar a Cloudflare'); });
    const env = { NODE_ENV: 'production', BOT_PROTECTION_MODO: 'nenhum' } as NodeJS.ProcessEnv;
    await expect(verificarTurnstile({ token: 't', action: 'signup', env, fetcher: nunca })).resolves.toEqual({
      ok: true,
      ignorado: true,
    });
    expect(nunca).not.toHaveBeenCalled();
  });

  /**
   * `nehum` escrito errado não pode virar "sem proteção".
   *
   * É o precedente de `PSP_MODO`: lido com tolerância, um valor desconhecido
   * abriria a porta de cadastro por um typo e ninguém descobriria — o oposto do
   * que um interruptor existe para fazer.
   */
  it('BOT_PROTECTION_MODO desconhecido derruba, em vez de virar "sem proteção"', async () => {
    const env = { NODE_ENV: 'production', BOT_PROTECTION_MODO: 'nehum' } as NodeJS.ProcessEnv;
    await expect(
      verificarTurnstile({ token: 't', action: 'signup', env, fetcher: vi.fn<typeof fetch>() }),
    ).rejects.toThrow(/BOT_PROTECTION_MODO inválido/);
  });

  /** O padrão continua exigindo: quem não escreve nada não perde a proteção. */
  it('sem a variável, o comportamento é o de antes', async () => {
    const env = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
    await expect(
      verificarTurnstile({ token: 't', action: 'signup', env, fetcher: vi.fn<typeof fetch>() }),
    ).resolves.toEqual({ ok: false, code: 'configuracao_ausente' });
  });
});
