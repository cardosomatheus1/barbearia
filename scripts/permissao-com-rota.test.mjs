import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PERMISSOES, PERMISSOES_SEM_ROTA } from '../packages/core/dist/index.js';

/**
 * Toda permissão do catálogo é exercida por alguma rota — ou está marcada.
 *
 * `finance.export` e `appointments.cancel` estavam no catálogo sem nenhuma rota
 * pedindo. A segunda é a pior das duas: o cabeçalho da tela de permissões usa
 * **ela** como exemplo do que a tela veio resolver — *"tirar
 * `appointments.cancel` da recepção era um `DELETE` no banco de produção"* — e
 * desmarcá-la não impedia cancelamento nenhum, porque cancelar passa por
 * `POST /appointments/:id/attendance` sob `appointments.attend`.
 *
 * É um controle de segurança que o dono acredita ter configurado. Pior que
 * ausente: a caixa está lá, ele desmarca, e continua sendo cancelável.
 *
 * ## Os dois sentidos
 *
 * Permissão sem rota tem que estar em `PERMISSOES_SEM_ROTA` — e permissão que
 * **ganhou** rota tem que sair de lá. Só o primeiro sentido deixaria a lista
 * crescer e nunca encolher, que é como uma lista de exceções vira a lista que
 * ninguém revisa.
 *
 * ## O que conta como exercer
 *
 * `@Exige(...)` e a conferência explícita `pode(..., 'x')` / `podeTudo(...)`.
 * A segunda existe porque `@Exige` é **conjuntivo**: uma rota que decide por
 * ação — cancelar, dentro de `attendance` — não pode declarar a permissão no
 * decorador sem trancar quem só faz as outras ações. É o desenho de
 * `metrica.controller.ts`, que decide uma métrica de cada vez.
 */

const RAIZ = new URL('..', import.meta.url).pathname;

function exercidas() {
  const arquivos = execFileSync('git', ['ls-files', 'apps/api/src'], {
    cwd: RAIZ,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f.endsWith('.ts'));

  const achadas = new Set();
  for (const arquivo of arquivos) {
    const texto = readFileSync(new URL(`../${arquivo}`, import.meta.url), 'utf8');

    for (const m of texto.matchAll(/@Exige\(([^)]*)\)/g)) {
      for (const p of m[1].matchAll(/['"]([a-z_]+\.[a-z_]+)['"]/g)) achadas.add(p[1]);
    }
    // A conferência explícita, para a rota que decide por ação.
    for (const m of texto.matchAll(/pode(?:Tudo)?\([^;]{0,160}?['"]([a-z_]+\.[a-z_]+)['"]/g)) {
      achadas.add(m[1]);
    }
  }
  return achadas;
}

describe('permissão do catálogo tem rota, ou está marcada', () => {
  it('nenhuma permissão é letra morta sem estar declarada como tal', () => {
    const tem = exercidas();
    const mortas = PERMISSOES.filter((p) => !tem.has(p) && !PERMISSOES_SEM_ROTA.includes(p));

    expect(
      mortas,
      'permissão no catálogo que nenhuma rota exige: dê rota a ela ou marque em PERMISSOES_SEM_ROTA',
    ).toEqual([]);
  });

  it('permissão que ganhou rota sai da lista de marcadas', () => {
    const tem = exercidas();
    const ressuscitadas = PERMISSOES_SEM_ROTA.filter((p) => tem.has(p));

    expect(
      ressuscitadas,
      'esta permissão já tem rota: tire de PERMISSOES_SEM_ROTA para a tela parar de marcá-la',
    ).toEqual([]);
  });

  it('a varredura enxerga as duas formas de exercer', () => {
    // Sem este caso, um recorte que só lesse `@Exige` acusaria toda permissão
    // decidida por ação — e a saída fácil seria pô-las na lista de marcadas,
    // que é o contrário do que a guarda quer.
    const tem = exercidas();
    expect(tem.has('cashier.open')).toBe(true); // por `@Exige`
    expect(tem.has('appointments.cancel')).toBe(true); // por `pode(...)`
    expect(tem.has('customers.view')).toBe(true); // pelas duas
  });
});
