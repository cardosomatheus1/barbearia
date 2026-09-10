import { afterEach, describe, expect, it, vi } from 'vitest';
import { cabecalhosDoVisitante } from './proxy-confiavel';
import { fetchComTimeout } from './fetch-com-timeout';
const { incoming } = vi.hoisted(() => ({ incoming: vi.fn() }));
vi.mock('next/headers', () => ({ headers: incoming }));
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); incoming.mockReset(); });
describe('IP do visitante no SSR', () => {
  it('preserva visitantes distintos só com origem autenticada e só para a API', async () => {
    const secret = 'chave-interna-de-teste-0123456789abcdef';
    vi.stubEnv('INTERNAL_PROXY_SECRET', secret);
    vi.stubEnv('API_URL', 'http://api:3000');
    for (const ip of ['192.0.2.1', '192.0.2.2']) {
      incoming.mockResolvedValue(new Headers({ 'x-barberdock-proxy-key': secret, 'x-barberdock-client-ip': ip }));
      expect(await cabecalhosDoVisitante('http://api:3000/v1/b/demo')).toEqual({
        'x-barberdock-proxy-key': secret, 'x-barberdock-client-ip': ip,
      });
      expect(await cabecalhosDoVisitante('https://outro.example')).toEqual({});
    }
  });
  it('não encaminha IP forjado, lista de IPs nem segredo durante build', async () => {
    const secret = 'chave-interna-de-teste-0123456789abcdef';
    vi.stubEnv('INTERNAL_PROXY_SECRET', secret);
    vi.stubEnv('API_URL', 'http://api:3000');
    for (const [key, ip] of [['forjada', '192.0.2.1'], [secret, '192.0.2.1, 192.0.2.2']]) {
      incoming.mockResolvedValue(new Headers({ 'x-barberdock-proxy-key': key!, 'x-barberdock-client-ip': ip! }));
      expect(await cabecalhosDoVisitante('http://api:3000/v1/b/demo')).toEqual({});
    }
    incoming.mockRejectedValue(new Error('sem requisição'));
    expect(await cabecalhosDoVisitante('http://api:3000/v1/b/demo')).toEqual({});
  });
  it('encaminhar o IP não apaga a autorização de um objeto Request', async () => {
    const secret = 'chave-interna-de-teste-0123456789abcdef';
    vi.stubEnv('INTERNAL_PROXY_SECRET', secret);
    vi.stubEnv('API_URL', 'http://api:3000');
    incoming.mockResolvedValue(new Headers({ 'x-barberdock-proxy-key': secret, 'x-barberdock-client-ip': '192.0.2.1' }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    const req = new Request('http://api:3000/v1/admin/me', { headers: { authorization: 'Bearer token-de-teste' } });
    await fetchComTimeout(req);
    const forwarded = new Headers(fetchSpy.mock.calls[0]?.[1]?.headers);
    expect(forwarded.get('authorization')).toBe('Bearer token-de-teste');
    expect(forwarded.get('x-barberdock-client-ip')).toBe('192.0.2.1');
    await fetchComTimeout(req, { headers: { authorization: 'Bearer substituto' } });
    expect(new Headers(fetchSpy.mock.calls[1]?.[1]?.headers).get('authorization')).toBe('Bearer substituto');
  });
});
