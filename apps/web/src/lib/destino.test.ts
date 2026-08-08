import { describe, expect, it } from 'vitest';
import { destinoSeguro } from './destino';

const PADRAO = '/domari/meus-agendamentos';

describe('destino do login', () => {
  it('aceita caminho interno da própria barbearia', () => {
    expect(destinoSeguro('/domari/meus-agendamentos/abc/remarcar', 'domari')).toBe(
      '/domari/meus-agendamentos/abc/remarcar',
    );
  });

  it('recusa URL absoluta', () => {
    // O ataque que isto fecha: link no domínio verdadeiro da barbearia levando
    // a uma cópia da tela de login, onde o código de 6 dígitos é colhido.
    expect(destinoSeguro('https://evil.example/domari/entrar', 'domari')).toBe(PADRAO);
  });

  it('recusa caminho relativo de protocolo', () => {
    // `//host` não parece externo à primeira vista, mas o navegador o trata
    // como outro site.
    expect(destinoSeguro('//evil.example/domari/x', 'domari')).toBe(PADRAO);
  });

  it('recusa caminho de outra barbearia', () => {
    expect(destinoSeguro('/rival/meus-agendamentos', 'domari')).toBe(PADRAO);
  });

  it('recusa slug que apenas começa igual', () => {
    // `/domari-falso/...` passa por um `startsWith('/domari')` ingênuo.
    expect(destinoSeguro('/domari-falso/entrar', 'domari')).toBe(PADRAO);
  });

  it('cai no padrão quando não vem nada', () => {
    expect(destinoSeguro(null, 'domari')).toBe(PADRAO);
    expect(destinoSeguro('', 'domari')).toBe(PADRAO);
    expect(destinoSeguro(undefined, 'domari')).toBe(PADRAO);
  });
});
