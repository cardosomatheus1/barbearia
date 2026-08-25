import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Test-only: expande o índice de CSS do R10 na mesma ordem da cascata. */
export function lerCssGlobal(): string {
  const aqui = dirname(fileURLToPath(import.meta.url));
  const indice = readFileSync(join(aqui, 'globals.css'), 'utf8');
  const arquivos = [...indice.matchAll(/@import\s+['"](\.\/styles\/[^'"]+\.css)['"]\s*;/g)]
    .map((m) => normalize(join(aqui, m[1] ?? '')));

  if (arquivos.length === 0) throw new Error('globals.css não declara fragmentos');
  return arquivos.map((arquivo) => readFileSync(arquivo, 'utf8')).join('\n');
}
