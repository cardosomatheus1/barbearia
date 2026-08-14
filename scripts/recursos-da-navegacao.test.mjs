import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * O código do recurso que o menu esconde é o mesmo do catálogo da plataforma.
 *
 * ## Por que este arquivo existe fora dos dois pacotes
 *
 * `apps/web/src/app/admin/secoes.ts` marca destinos com `recurso: 'fiscal'`, e
 * quem decide se aquele recurso existe é `packages/platform/src/recursos.ts`.
 * O web não depende de `@barbearia/platform` — e não vai passar a depender por
 * causa de um tipo: aquele pacote fala com o banco, e um `import` de valor
 * dentro do painel arrastaria o Prisma para o bundle.
 *
 * A alternativa seria copiar a união de códigos para dentro do web, que é a
 * lista paralela que `secoes.ts` já custou uma vez: os rótulos de campanha e as
 * seções do casco divergiram exatamente assim, cada lado coerente sozinho.
 *
 * Então a ligação é feita aqui, pelo texto dos dois arquivos. É a mesma forma
 * de `scripts/env-example.test.mjs`.
 *
 * ## O que se perde sem ela
 *
 * Nada fica vermelho quando o código está errado — é o pior formato. Um
 * `recurso: 'fiscall'` nunca aparece na lista que o servidor devolve, então
 * aquela tela some do menu **para sempre**, em toda barbearia, e o único
 * sintoma é alguém perguntando por que a nota fiscal não está no painel.
 */

const RAIZ = new URL('..', import.meta.url).pathname;

const catalogo = readFileSync(`${RAIZ}packages/platform/src/recursos.ts`, 'utf8');
const secoes = readFileSync(`${RAIZ}apps/web/src/app/admin/secoes.ts`, 'utf8');

/** `export const RECURSOS = ['fila', ...] as const;` */
function codigosDoCatalogo() {
  const linha = catalogo.match(/export const RECURSOS = \[([^\]]*)\]/);
  if (!linha) throw new Error('não achei RECURSOS em packages/platform/src/recursos.ts');
  return [...linha[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** `recurso: 'fiscal'` dentro do registro de navegação. */
function codigosDaNavegacao() {
  return [...secoes.matchAll(/recurso:\s*'([^']+)'/g)].map((m) => m[1]);
}

describe('recurso declarado na navegação', () => {
  it('a varredura enxerga os dois lados', () => {
    // Varredura que não acha nada passa verde por não ter olhado.
    expect(codigosDoCatalogo().length).toBeGreaterThan(0);
    expect(codigosDaNavegacao().length).toBeGreaterThan(0);
  });

  it('todo código do menu existe no catálogo da plataforma', () => {
    const conhecidos = new Set(codigosDoCatalogo());
    const desconhecidos = codigosDaNavegacao().filter((c) => !conhecidos.has(c));
    expect(
      desconhecidos,
      'código de recurso que a plataforma não conhece: a tela sumiria do menu de toda ' +
        'barbearia, e nada ficaria vermelho.',
    ).toEqual([]);
  });

  it('a conferência acusa um código inventado', () => {
    // Guarda que não fica vermelha não guarda nada.
    const conhecidos = new Set(codigosDoCatalogo());
    expect(conhecidos.has('fiscall')).toBe(false);
  });
});
