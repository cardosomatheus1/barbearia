import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from './middleware.js';
import config from '../next.config.mjs';

/**
 * Os cabeçalhos de segurança da tela.
 *
 * Eles moram em dois arquivos por um motivo escrito — a CSP leva nonce por
 * requisição e o resto é fixo —, e é exatamente por isso que precisam de teste:
 * cabeçalho de segurança some sem nada quebrar, e nenhuma tela fica diferente
 * no dia em que a política deixar de sair.
 */

const pedir = (caminho: string) => middleware(new NextRequest(`https://exemplo.com${caminho}`));

describe('a política de conteúdo da tela', () => {
  it('leva nonce, e o mesmo nonce vai para o Next encontrar', () => {
    const resposta = pedir('/domari');
    const csp = resposta.headers.get('content-security-policy') ?? '';

    const achado = /'nonce-([a-zA-Z0-9+/]+)'/.exec(csp);
    expect(achado, 'a política saiu sem nonce').not.toBeNull();

    /**
     * O Next só põe o nonce nos scripts dele se o encontrar **na requisição**.
     * Sem esta ponte a política sai correta e a página fica em branco — que é o
     * defeito mais caro possível: ele aparece só depois do deploy, e só no
     * navegador.
     */
    expect(resposta.headers.get('x-middleware-request-x-nonce')).toBe(achado?.[1]);
  });

  it('cada resposta tem o seu', () => {
    // Nonce repetido é o mesmo que não ter nonce: quem injeta uma vez descobre
    // o valor e o reusa.
    const um = pedir('/domari').headers.get('content-security-policy');
    const outro = pedir('/domari').headers.get('content-security-policy');
    expect(um).not.toBe(outro);
  });

  it('não abre exceção para script embutido', () => {
    const csp = pedir('/admin/dia').headers.get('content-security-policy') ?? '';
    const scripts = csp.split('; ').find((d) => d.startsWith('script-src')) ?? '';

    // `'unsafe-inline'` em `script-src` é o que a política inteira existe para
    // evitar; o nonce é o que permite viver sem ele.
    expect(scripts).not.toContain('unsafe-inline');
    expect(scripts).not.toContain('unsafe-eval');
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('nenhuma rota abre exceção para terceiro — nem a da Meta', () => {
    /**
     * A licença da Meta existiu entre os blocos 83 e 86, para o SDK que a tela
     * de conexão rodava no navegador. O SDK não funcionava no celular e foi
     * trocado por redirecionamento, que é navegação comum — e a exceção saiu
     * junto.
     *
     * Este teste é o que impede alguém de reabri-la sem perceber: hoje não há
     * script de terceiro em rota nenhuma, e é assim que se quer.
     */
    for (const caminho of ['/domari', '/admin/dia', '/admin/whatsapp', '/admin/campanhas']) {
      const csp = pedir(caminho).headers.get('content-security-policy') ?? '';
      expect(csp, caminho).not.toContain('facebook');
      expect(csp, caminho).toContain("connect-src 'self'");
    }
  });

  it('a foto que a barbearia cadastra continua carregando', () => {
    /**
     * `img-src` é a única diretiva larga, e é decisão de produto: a foto do
     * corte é um endereço `https://` digitado no cadastro. Fechá-la em `'self'`
     * apagaria as imagens da página pública — e apagaria em silêncio, porque
     * imagem bloqueada por CSP não derruba nada.
     */
    const csp = pedir('/domari').headers.get('content-security-policy') ?? '';
    expect(csp).toContain('img-src');
    expect(csp.split('; ').find((d) => d.startsWith('img-src'))).toContain('https:');
  });
});

describe('os cabeçalhos fixos', () => {
  const paraRota = async (caminho: string): Promise<Record<string, string>> => {
    // `headers` é opcional no tipo do Next, e o `vitest` não faz typecheck —
    // sem esta guarda o portão reprova onde a suíte passava.
    if (!config.headers) throw new Error('o next.config parou de declarar cabeçalhos');
    const regras = await config.headers();
    const casa = regras.filter((r) =>
      new RegExp(`^${r.source.replace(/\/:caminho\*$/, '(/.*)?')}$`).test(caminho),
    );
    return Object.fromEntries(casa.flatMap((r) => r.headers.map((h) => [h.key, h.value])));
  };

  it('toda tela recusa quadro, adivinhação de tipo e HTTP', async () => {
    for (const caminho of ['/domari', '/admin/dia', '/plataforma']) {
      const cabecalhos = await paraRota(caminho);
      expect(cabecalhos['X-Frame-Options'], caminho).toBe('DENY');
      expect(cabecalhos['X-Content-Type-Options'], caminho).toBe('nosniff');
      expect(cabecalhos['Strict-Transport-Security'], caminho).toContain('max-age=31536000');
    }
  });

  it('a URL do painel não sai no referrer, e só ela precisa disso', async () => {
    /**
     * Toda URL de `/admin` e de `/plataforma` carrega id de cliente, de comanda
     * ou de barbearia. A da página pública carrega o slug, que é justamente o
     * que a barbearia quer que se saiba.
     *
     * As três regras são **excludentes** de propósito: o Next aplica todas as
     * que casam, então uma regra ampla no fim reescreveria o referrer fechado
     * das duas de cima. Este teste é o que pega essa reescrita.
     */
    expect((await paraRota('/admin/cliente/abc'))['Referrer-Policy']).toBe('no-referrer');
    expect((await paraRota('/plataforma/faturas'))['Referrer-Policy']).toBe('no-referrer');
    expect((await paraRota('/domari'))['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
  });
});
