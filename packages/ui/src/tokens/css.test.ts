import { describe, expect, it } from 'vitest';
import { emitCss } from './css.js';
import { dark, light } from './tokens.js';

describe('emitCss', () => {
  const css = emitCss();

  it('exporta toda cor de cada tema como custom property', () => {
    for (const value of Object.values(dark)) expect(css).toContain(value);
    for (const value of Object.values(light)) expect(css).toContain(value);
  });

  it('converte camelCase em kebab-case', () => {
    expect(css).toContain('--color-text-primary:');
    expect(css).toContain('--color-surface-raised:');
    expect(css).toContain('--color-text-on-accent:');
  });

  it('define anel de foco visível', () => {
    expect(css).toMatch(/focus-visible\s*\{[^}]*outline:\s*2px solid var\(--color-focus\)/);
  });

  it('respeita prefers-reduced-motion', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('nunca zera o outline sem substituir', () => {
    // `outline: none` solto é o jeito clássico de tornar um formulário
    // inoperável para quem navega por teclado.
    expect(css).not.toMatch(/outline:\s*(none|0)\s*;/);
  });

  it('inclui o estilo dos componentes — token sem componente não pinta nada', () => {
    expect(css).toContain('.ui-button');
    expect(css).toContain('.ui-field__input');
    expect(css).toContain('.ui-skip-link');
  });

  it('todo alvo de toque respeita o mínimo', () => {
    expect(css).toMatch(/\.ui-button\s*\{[\s\S]*min-height: var\(--size-touch\)/);
    expect(css).toMatch(/\.ui-field__input\s*\{[\s\S]*min-height: var\(--size-touch\)/);
  });

  it('campo e controle não têm piso de min-content', () => {
    /**
     * Item de grade e de flex tem piso de `min-content`, e o `min-content` de
     * um `<select>` é a opção mais comprida que ele guarda. Sem `min-width: 0`
     * o dado é quem decide a largura da tela: um nome de barbearia comprido
     * fazia a coluna nascer com 391px dentro de 360, e a página rolava de
     * lado com a medição dizendo "ok".
     */
    expect(css).toMatch(/\.ui-field\s*\{[^}]*min-width: 0/);
    expect(css).toMatch(/\.ui-field__input\s*\{[\s\S]*?min-width: 0/);
  });

  it('toda media query de layout é mobile-first', () => {
    // `max-width` significa "desfazer o que fiz para telas grandes", o que
    // inverte a ordem de trabalho e deixa o celular — o aparelho em que o
    // cliente realmente agenda — como caso excepcional.
    const queries = [...css.matchAll(/@media\s*\(([^)]+)\)/g)].map((m) => m[1] ?? '');
    const layout = queries.filter((q) => !q.startsWith('prefers-'));

    expect(layout.length).toBeGreaterThan(0);
    for (const query of layout) {
      expect(query, `media query não é min-width: "${query}"`).toContain('min-width');
    }
  });

  it('impede rolagem horizontal da página', () => {
    expect(css).toMatch(/html,\s*body\s*\{[\s\S]*overflow-x: hidden/);
  });

  it('o recipiente que rola é bloco contentor, senão o conteúdo escapa dele', () => {
    // `overflow` não segura descendente `position: absolute` cujo bloco
    // contentor está fora — e todo `.ui-visually-hidden` é um. Um rótulo de
    // leitor de tela dentro de uma tabela larga era posicionado contra a
    // página, na coordenada que ele tem dentro da tabela, e fazia a página
    // rolar de lado. Sem `position` aqui, `.ui-scroll-x` não resolve o
    // problema que existe para resolver.
    expect(css).toMatch(/\.ui-scroll-x\s*\{[\s\S]*?position: relative[\s\S]*?\}/);
  });

  it('mídia nunca estoura o recipiente', () => {
    expect(css).toMatch(/img,\s*video,\s*svg\s*\{[\s\S]*max-width: 100%/);
  });

  it('ação fixa respeita a área segura do aparelho', () => {
    // Sem isso o botão principal fica sob a barra de gestos do iPhone.
    expect(css).toContain('env(safe-area-inset-bottom');
  });

  it('a ação fixa não soma o recuo do container que carrega dentro', () => {
    // Com os dois recuos, a ação principal fica mais estreita que o conteúdo
    // acima dela — desalinho no elemento mais importante da tela.
    expect(css).toMatch(/\.ui-sticky-action > \.ui-container\s*\{[\s\S]*?padding-inline: 0/);
  });

  it('exporta os pontos de quebra como custom property', () => {
    expect(css).toContain('--breakpoint-base: 360px');
    expect(css).toContain('--breakpoint-md: 768px');
  });

  it('botão não herda sublinhado quando é um link', () => {
    expect(css).toMatch(/\.ui-button\s*\{[\s\S]*text-decoration: none/);
  });

  it('declara color-scheme nos dois temas', () => {
    expect(css).toContain('color-scheme: dark');
    expect(css).toContain('color-scheme: light');
  });

  it('o corpo pinta fundo e cor explicitamente', () => {
    expect(css).toMatch(/body\s*\{[\s\S]*background: var\(--color-surface\)/);
    expect(css).toMatch(/body\s*\{[\s\S]*color: var\(--color-text-primary\)/);
  });
});
