import { describe, expect, it } from 'vitest';
import { destinoDoBalcao, destinoSeguro } from './destino';

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

describe('destino do balcão', () => {
  it('aceita as duas telas que movem atendimento', () => {
    expect(destinoDoBalcao('/admin/dia')).toBe('/admin/dia');
    expect(destinoDoBalcao('/admin/meu-dia')).toBe('/admin/meu-dia');
  });

  it('preserva o filtro de onde a pessoa saiu', () => {
    // A recepção não pode perder o lugar na lista a cada toque.
    expect(destinoDoBalcao('/admin/dia?d=2026-09-10&p=ruan')).toBe('/admin/dia?d=2026-09-10&p=ruan');
  });

  it('recusa URL absoluta', () => {
    expect(destinoDoBalcao('https://evil.example/admin/dia')).toBe('/admin/dia');
  });

  it('recusa caminho relativo de protocolo', () => {
    // `//host` não parece externo à primeira vista; o navegador discorda.
    expect(destinoDoBalcao('//evil.example')).toBe('/admin/dia');
  });

  it('recusa prefixo parecido', () => {
    /**
     * `/admin/diabolico` começa com `/admin/dia` e não é `/admin/dia`. Sem
     * exigir o fim exato ou o `?`, a lista fechada deixaria passar qualquer
     * rota que começasse igual.
     */
    expect(destinoDoBalcao('/admin/diabolico')).toBe('/admin/dia');
    expect(destinoDoBalcao('/admin/meu-diario')).toBe('/admin/dia');
  });

  it('recusa outra tela do painel', () => {
    // Não é sobre segurança de destino externo: é sobre a ação devolver a
    // pessoa a uma tela que não sabe o que ela acabou de fazer.
    expect(destinoDoBalcao('/admin/caixa')).toBe('/admin/dia');
  });

  it('campo vazio cai no padrão', () => {
    expect(destinoDoBalcao('')).toBe('/admin/dia');
  });
});
