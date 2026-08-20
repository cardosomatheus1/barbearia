import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A tela não reescreve uma união que o domínio já tem.
 *
 * `apps/web/src/lib/admin-api.ts` declarava vinte uniões com o **mesmo nome** de
 * uma do `packages/core`. São duas declarações independentes: nada liga uma à
 * outra, nem o nome igual o `tsc` confere. Duas já tinham divergido quando esta
 * guarda nasceu:
 *
 * - `FormaDePagamento` tinha oito valores aqui e dez lá, com o comentário
 *   *"espelha `FORMAS_DE_PAGAMENTO` do core"* logo acima. O cliente do clube
 *   fechava a conta e a linha de pagamento mostrava a palavra `assinatura`,
 *   minúscula, ao lado de "Dinheiro" e "Débito".
 * - `EstadoDaNota` tinha cinco e o domínio tem seis: faltava `cancelando`.
 *
 * A divergência é silenciosa por construção. O sintoma aparece na tela, semanas
 * depois, e sempre como um valor cru ou um estado que some.
 *
 * ## O recorte
 *
 * Só nomes que **existem nos dois lados**. Uma união que só a tela tem é dela —
 * `PeriodoPainel` e `AlertaDeEstoque` podem ser conceitos de apresentação. O que
 * a guarda proíbe é a segunda declaração do mesmo nome.
 */

const RAIZ = new URL('..', import.meta.url).pathname;

const arquivos = (pasta) =>
  execFileSync('git', ['ls-files', pasta], { cwd: RAIZ, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.endsWith('.ts') && !f.includes('.test.'));

const ler = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

/** Os nomes que o domínio exporta como tipo. */
function doDominio() {
  const nomes = new Set();
  for (const f of arquivos('packages/core/src')) {
    for (const m of ler(f).matchAll(/export type (\w+)\s*=/g)) nomes.add(m[1]);
  }
  return nomes;
}

/** Os nomes que a tela **declara** — `export type X =`, não `export type { X }`. */
function declaradosNaTela() {
  const achados = [];
  for (const f of arquivos('apps/web/src')) {
    const texto = ler(f);
    for (const m of texto.matchAll(/export type (\w+)\s*=\s*(?!\{)/g)) {
      achados.push([m[1], f]);
    }
  }
  return achados;
}

describe('a tela não redeclara união do domínio', () => {
  it('nenhum nome do core é reescrito em apps/web', () => {
    const dominio = doDominio();
    const repetidos = declaradosNaTela()
      .filter(([nome]) => dominio.has(nome))
      .map(([nome, f]) => `${f} · ${nome}`);

    expect(
      repetidos,
      'esta união já existe em packages/core: reexporte com `export type { X }` em vez de ' +
        'reescrever os valores — duas declarações do mesmo nome divergem em silêncio',
    ).toEqual([]);
  });

  it('a varredura enxerga as duas formas', () => {
    // Sem este caso, um regex que casasse a reexportação junto devolveria
    // "tudo repetido" e alguém desligaria a guarda inteira.
    const declara = /export type (\w+)\s*=\s*(?!\{)/;
    expect(declara.test("export type Papel = 'owner' | 'manager';")).toBe(true);
    expect(declara.test("export type { FormaDePagamento };")).toBe(false);
    expect(doDominio().size, 'o core precisa exportar tipos para a guarda valer').toBeGreaterThan(20);
  });
});
