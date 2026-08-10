import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * O que estes testes protegem.
 *
 * O middleware alinha `x-forwarded-host` com o `origin` para que a Server
 * Action sobreviva ao encaminhamento de porta. É um ajuste na conferência de
 * CSRF do Next, então o que precisa ficar vermelho quando alguém mexer não é
 * "funciona atrás do proxy" — é **para quem** ele funciona. Reescrever o
 * cabeçalho para origem não declarada transformaria a correção num buraco:
 * qualquer página da internet passaria a mandar formulário para o painel.
 *
 * A lista é lida no carregamento do módulo, porque em produção ela vem
 * congelada da construção. Daí `resetModules` e o import dinâmico a cada caso.
 */

const CABECALHO = 'x-forwarded-host';

async function rodar(
  declaradas: string | undefined,
  cabecalhos: Record<string, string>,
): Promise<{ reescrito: string | null; sobrescreve: boolean }> {
  vi.resetModules();
  if (declaradas === undefined) delete process.env['WEB_ORIGENS_DE_CONFIANCA'];
  else process.env['WEB_ORIGENS_DE_CONFIANCA'] = declaradas;

  const { middleware } = await import('./middleware');
  const { NextRequest } = await import('next/server');

  const resposta = middleware(
    new NextRequest('http://127.0.0.1:3001/admin/entrar', { method: 'POST', headers: cabecalhos }),
  );

  const sobrescritos = resposta.headers.get('x-middleware-override-headers') ?? '';
  return {
    reescrito: resposta.headers.get(`x-middleware-request-${CABECALHO}`),
    sobrescreve: sobrescritos.split(',').includes(CABECALHO),
  };
}

afterEach(() => {
  delete process.env['WEB_ORIGENS_DE_CONFIANCA'];
});

describe('middleware de origem encaminhada', () => {
  it('alinha o host encaminhado com a origem declarada', async () => {
    const { reescrito, sobrescreve } = await rodar('nome-3001.app.github.dev', {
      origin: 'https://nome-3001.app.github.dev',
    });

    expect(sobrescreve).toBe(true);
    expect(reescrito).toBe('nome-3001.app.github.dev');
  });

  it('origem não declarada passa intacta, e o Next recusa como antes', async () => {
    const { reescrito, sobrescreve } = await rodar('nome-3001.app.github.dev', {
      origin: 'https://atacante.exemplo',
    });

    expect(sobrescreve).toBe(false);
    expect(reescrito).toBeNull();
  });

  it('sem lista declarada, nenhuma origem é reescrita', async () => {
    const { sobrescreve } = await rodar(undefined, { origin: 'https://nome-3001.app.github.dev' });
    expect(sobrescreve).toBe(false);
  });

  it('lista vazia não vira uma entrada que casa com requisição sem origem', async () => {
    const { sobrescreve } = await rodar('', {});
    expect(sobrescreve).toBe(false);
  });

  it('origem malformada não derruba a requisição — só não é reescrita', async () => {
    const { sobrescreve } = await rodar('nome-3001.app.github.dev', { origin: 'nao-e-uma-url' });
    expect(sobrescreve).toBe(false);
  });

  it('a porta faz parte da identidade: mesmo host em outra porta não passa', async () => {
    // `origin` compara host **com porta**. Aceitar `exemplo.br:9999` porque
    // `exemplo.br:3001` foi declarado liberaria um vizinho na mesma máquina.
    const { sobrescreve } = await rodar('exemplo.br:3001', { origin: 'http://exemplo.br:9999' });
    expect(sobrescreve).toBe(false);
  });
});
