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
 * `@Exige(...)`, a conferência explícita `pode(..., 'x')` / `podeTudo(...)`, e
 * o **mapa do domínio** que a rota indexa.
 *
 * A segunda existe porque `@Exige` é **conjuntivo**: uma rota que decide por
 * ação — cancelar, dentro de `attendance` — não pode declarar a permissão no
 * decorador sem trancar quem só faz as outras ações. É o desenho de
 * `metrica.controller.ts`, que decide uma métrica de cada vez.
 *
 * A terceira nasceu quando aquele `if` sobre o nome da ação virou
 * `PERMISSAO_DA_ACAO[body.action]` — porque escrito à mão ele cobria `cancel` e
 * deixava `no_show` passar. O literal saiu de `apps/api` e a varredura, que só
 * lia ali, passou a chamar `appointments.cancel` de letra morta: guarda cega
 * para o conserto que a tornou desnecessária. O mapa só conta se algum
 * controller o **indexa** — senão um mapa esquecido ressuscitaria a permissão
 * que a guarda existe para enterrar.
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

  /**
   * E o mapa do domínio que algum controller indexa.
   *
   * `Record<..., Permissao>` é o tipo que diz "isto aqui é uma decisão de
   * permissão por caso": ele é total, o compilador cobra o caso novo, e é
   * exatamente por isso que ele substituiu o `if` escrito à mão.
   */
  const fonteDaApi = arquivos
    .map((f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'))
    .join('\n');

  const doCore = execFileSync('git', ['ls-files', 'packages/core/src'], {
    cwd: RAIZ,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f.endsWith('.ts') && !f.includes('.test.'));

  for (const arquivo of doCore) {
    const texto = readFileSync(new URL(`../${arquivo}`, import.meta.url), 'utf8');
    for (const m of texto.matchAll(
      /export const (\w+):[^=]*Record<[^>]*,\s*Permissao>[>\s]*=\s*\{([\s\S]*?)\n\};/g,
    )) {
      if (!new RegExp(`\\b${m[1]}\\s*\\[`).test(fonteDaApi)) continue;
      for (const p of m[2].matchAll(/['"]([a-z_]+\.[a-z_]+)['"]/g)) achadas.add(p[1]);
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
    // Pelo mapa do domínio: `PERMISSAO_DA_ACAO[body.action]` no controller do
    // painel. Foi `pode(..., 'appointments.cancel')` até o mapa substituir o
    // `if` que deixava `no_show` passar por baixo.
    expect(tem.has('appointments.cancel')).toBe(true);
    expect(tem.has('customers.view')).toBe(true); // pelas duas
  });
});
