import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Crase dentro de script inline, e por que ela merece guarda própria.
 *
 * O produto já tinha esta cicatriz duas vezes: dentro de consulta SQL, onde a
 * crase fecha o tagged template do Prisma, e dentro de CSS servido por template
 * literal. Nas duas o erro sai como **sintaxe em cima de uma linha de prosa**,
 * que é caro de ler porque o compilador aponta para o lugar errado.
 *
 * Aconteceu a terceira vez no bloco 84, num comentário do script do Embedded
 * Signup: `message` e `dados` escritos com crase, dentro do `__html` que é uma
 * template string. Três `TS1005` apontando para uma frase em português.
 *
 * A guarda é simples porque o caso é simples: dentro de um `dangerouslySetInnerHTML`
 * com template literal, nenhuma crase além das duas que o abrem e o fecham.
 */

const RAIZ = new URL('../apps/web/src', import.meta.url).pathname;

function arquivos(dir) {
  const achados = [];
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) achados.push(...arquivos(caminho));
    else if (nome.endsWith('.tsx') || nome.endsWith('.ts')) achados.push(caminho);
  }
  return achados;
}

describe('crase dentro de script inline', () => {
  it('nenhum script embutido tem crase no meio', () => {
    const culpados = [];

    for (const caminho of arquivos(RAIZ)) {
      const fonte = readFileSync(caminho, 'utf8');
      // O corpo de `__html: ` até a crase que o fecha, sem gula.
      for (const achado of fonte.matchAll(/__html:\s*`([\s\S]*?)`\s*[,}]/g)) {
        const corpo = achado[1] ?? '';
        if (corpo.includes('`')) {
          culpados.push(caminho.replace(RAIZ, 'apps/web/src'));
        }
      }
    }

    expect(
      culpados,
      'crase no meio de um script inline fecha o template literal, e o erro sai ' +
        'como sintaxe de TypeScript em cima de uma linha de prosa',
    ).toEqual([]);
  });
});
