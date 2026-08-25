import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

/**
 * R10 — lê o CSS global exatamente na ordem em que o navegador o recebe.
 *
 * `globals.css` virou um índice de `@import` locais. As guardas antigas não
 * podem voltar a olhar só o índice, porque isso faria uma regra desaparecer dos
 * testes sem desaparecer da aplicação. Esta função é a fonte única dos scripts
 * de verificação que precisam enxergar o conjunto.
 */
export function arquivosCssDoApp(raiz = process.cwd()) {
  const indice = join(raiz, 'apps/web/src/app/globals.css');
  const fonte = readFileSync(indice, 'utf8');
  const base = dirname(indice);
  const imports = [...fonte.matchAll(/@import\s+['"](\.\/styles\/[^'"]+\.css)['"]\s*;/g)]
    .map((m) => normalize(join(base, m[1])));

  if (imports.length === 0) {
    throw new Error('globals.css não declara nenhum fragmento de superfície');
  }
  return imports;
}

export function lerCssDoApp(raiz = process.cwd()) {
  return arquivosCssDoApp(raiz)
    .map((arquivo) => readFileSync(arquivo, 'utf8'))
    .join('\n');
}
