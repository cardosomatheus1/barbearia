import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Todo `@Param` passa por um pipe de validação (bloco 113).
 *
 * O id vem da URL — entrada externa como qualquer outra — e desce até
 * `${id}::uuid` numa consulta. Sem pipe, um id torto vira **500 "Erro
 * interno"** sobre um erro de quem digitou: o certo é 400 com motivo, e o
 * `CLAUDE.md` chama isso de defeito de borda, sempre.
 *
 * Havia exatamente um em toda a API — `DELETE /franquia/padrao/:itemId` — e ele
 * só apareceu porque alguém foi procurar. Varredura e não conserto local: o
 * próximo `@Param` nasce cobrado.
 */

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('@Param da API', () => {
  const arquivos = execFileSync('git', ['ls-files', 'apps/api/src'], {
    cwd: raiz,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((caminho) => /\.controller\.ts$/.test(caminho));

  it('a varredura acha os controllers — sem isso ela não prova nada', () => {
    expect(arquivos.length).toBeGreaterThan(5);
  });

  it('todo @Param declara um pipe', () => {
    const semPipe = [];

    for (const caminho of arquivos) {
      const fonte = readFileSync(join(raiz, caminho), 'utf8');
      for (const casamento of fonte.matchAll(/@Param\(([^)]*)\)/g)) {
        // Um argumento só é o nome do parâmetro sem pipe nenhum. Com pipe, há
        // vírgula: `@Param('id', new ZodValidationPipe(...))`.
        if (casamento[1].includes(',')) continue;
        const linha = fonte.slice(0, casamento.index).split('\n').length;
        semPipe.push(`${caminho}:${linha}`);
      }
    }

    expect(
      semPipe,
      'id torto nestes vira 500 sobre entrada externa, em vez de 400 com motivo',
    ).toEqual([]);
  });
});
