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

  it('mídia nunca estoura o recipiente', () => {
    expect(css).toMatch(/img,\s*video,\s*svg\s*\{[\s\S]*max-width: 100%/);
  });

  it('ação fixa respeita a área segura do aparelho', () => {
    // Sem isso o botão principal fica sob a barra de gestos do iPhone.
    expect(css).toContain('env(safe-area-inset-bottom');
  });

  it('exporta os pontos de quebra como custom property', () => {
    expect(css).toContain('--breakpoint-base: 360px');
    expect(css).toContain('--breakpoint-md: 768px');
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
