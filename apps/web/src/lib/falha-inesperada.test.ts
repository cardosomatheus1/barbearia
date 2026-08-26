import { afterEach, describe, expect, it, vi } from 'vitest';
import { ehControleDeFluxoDoNext, registrarFalhaInesperada } from './falha-inesperada';

/** O erro que `redirect()` lança: o Next o reconhece pelo `digest`. */
const comoRedirect = () => Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/admin;307;' });
const comoNotFound = () => Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_NOT_FOUND' });

afterEach(() => vi.restoreAllMocks());

describe('o controle de fluxo do Next', () => {
  /**
   * A parte que, se sair errada, é pior que o defeito que o arquivo conserta.
   *
   * `redirect()` e `notFound()` funcionam **lançando**. Um `catch` que os
   * tratasse como falha transformaria todo redirecionamento do produto em página
   * de erro — e falharia justamente nos caminhos felizes, onde ninguém procura.
   */
  it('reconhece redirect e notFound, e não os chama de falha', () => {
    expect(ehControleDeFluxoDoNext(comoRedirect())).toBe(true);
    expect(ehControleDeFluxoDoNext(comoNotFound())).toBe(true);
    expect(registrarFalhaInesperada('teste', comoRedirect())).toBe(false);
    expect(registrarFalhaInesperada('teste', comoNotFound())).toBe(false);
  });

  it('não confunde erro comum com controle de fluxo', () => {
    expect(ehControleDeFluxoDoNext(new TypeError('Invalid URL'))).toBe(false);
    expect(ehControleDeFluxoDoNext(null)).toBe(false);
    expect(ehControleDeFluxoDoNext({ digest: 42 })).toBe(false);
  });
});

describe('o registro da falha', () => {
  it('escreve onde foi e o stack, que é o que faltava no log', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const erro = new TypeError('Invalid URL');
    expect(registrarFalhaInesperada('GET /admin/whatsapp/conectado', erro)).toBe(true);
    const escrito = log.mock.calls[0]?.[0] as string;
    expect(escrito).toContain('GET /admin/whatsapp/conectado');
    expect(escrito).toContain('Invalid URL');
    // O stack é o ponto do exercício: sem ele o log diz o tipo do erro e não a linha.
    expect(escrito).toContain('falha-inesperada.test');
  });

  it('sobrevive ao que não é Error', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(registrarFalhaInesperada('teste', 'só uma string')).toBe(true);
    expect(log.mock.calls[0]?.[0]).toContain('só uma string');
  });
});
