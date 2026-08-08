import { describe, expect, it } from 'vitest';
import { jsonLdScript } from './json-ld';

/**
 * O JSON-LD é o único ponto do sistema que injeta HTML sem o escape do React.
 * O que se prova aqui é que nada vindo do cadastro consegue sair do `<script>`.
 */
describe('JSON-LD dentro de <script>', () => {
  it('não deixa fechar a tag', () => {
    // O ataque: um nome de barbearia com `</script><script>…`. Antes do cadastro
    // aberto isso era teórico, porque só entrava por SQL.
    const saida = jsonLdScript({ name: '</script><script>alert(1)</script>' });

    expect(saida).not.toContain('</script>');
    expect(saida).not.toContain('<script');
    expect(saida).toContain('\\u003c');
  });

  it('escapa `<`, `>` e `&` em qualquer profundidade', () => {
    const saida = jsonLdScript({
      address: { streetAddress: 'Rua <b>' },
      lista: [{ description: 'a & b' }],
    });

    expect(saida).not.toMatch(/[<>&]/);
  });

  it('escapa os separadores de linha que quebram literal de string', () => {
    const saida = jsonLdScript({ name: 'a b c' });
    expect(saida).toContain('\\u2028');
    expect(saida).toContain('\\u2029');
  });

  it('continua sendo JSON válido e com o mesmo conteúdo', () => {
    // O escape não pode custar o significado: o Google precisa ler o mesmo
    // texto que a barbearia digitou.
    const original = {
      name: 'Barbearia <do> Zé & Cia',
      address: { streetAddress: 'Rua 7 de Setembro, 500' },
    };
    expect(JSON.parse(jsonLdScript(original))).toEqual(original);
  });

  it('preserva acento e emoji', () => {
    const original = { name: 'Cabelo & Barba — açaí 💈' };
    expect(JSON.parse(jsonLdScript(original))).toEqual(original);
  });
});
