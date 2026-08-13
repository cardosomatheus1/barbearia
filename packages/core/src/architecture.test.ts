import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guardas de arquitetura (CLAUDE.md §4).
 *
 * A regra "core não depende de nada" só vale se quebrá-la falhar o build. Sem
 * isso, a primeira pressa adiciona um cliente de banco aqui e a lógica de
 * negócio deixa de ser testável sem infraestrutura.
 */

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');

function sourceFiles(): string[] {
  return readdirSync(here)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => join(here, name));
}

describe('arquitetura — packages/core', () => {
  it('não declara nenhuma dependência de runtime', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies ?? {}).toEqual({});
  });

  it('importa apenas caminhos relativos — sem banco, sem rede, sem framework', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)) {
        const specifier = match[1]!;
        if (!specifier.startsWith('.')) {
          offenders.push(`${file.slice(packageRoot.length + 1)} -> ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('não lê relógio nem sorteia — o motor precisa ser determinístico', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      /**
       * Comentário fora **antes** de varrer.
       *
       * Sem isto a guarda reprova a **explicação** do motivo: o comentário que
       * diz "um `new Date()` aqui tornaria o resultado impossível de testar" é
       * exatamente a frase que documenta a regra, e ela contém o padrão
       * proibido. Guarda que proíbe documentar o próprio motivo é guarda que
       * alguém apaga — é a mesma lição de `vocabulario.test.ts`.
       */
      const source = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      // `zone.ts` é a fronteira de fuso: recebe o instante por parâmetro e usa
      // Intl para converter. Ele não pode chamar Date.now() nem new Date() sem
      // argumento, mas legitimamente manipula Date.
      const forbidden = [/\bDate\.now\s*\(/, /\bMath\.random\s*\(/, /\bnew Date\s*\(\s*\)/];
      for (const pattern of forbidden) {
        if (pattern.test(source)) {
          offenders.push(`${file.slice(packageRoot.length + 1)} usa ${pattern.source}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
