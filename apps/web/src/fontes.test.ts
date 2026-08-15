import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * As fontes são arquivos do repositório, e o build não fala com a internet.
 *
 * `next/font/google` serve a fonte do nosso domínio — isso nunca foi o
 * problema. O que ele faz de errado é **baixar** os arquivos durante o
 * `next build`: a compilação passa a depender de a máquina que compila
 * alcançar `fonts.gstatic.com`, e numa rede que não alcança ela falha inteira,
 * depois de três tentativas por arquivo.
 *
 * Foi o que derrubou o build do contêiner no servidor, num commit que não
 * tocava em fonte nenhuma — e é o pior tipo de dependência: invisível no
 * desenvolvimento, porque a máquina de quem escreve sempre alcança, e fatal no
 * deploy. Sem esta guarda, o próximo `import` do pacote do Google traz o
 * defeito de volta, e ele não aparece aqui: aparece lá.
 */

const raiz = dirname(fileURLToPath(import.meta.url));

function fontesDeTypeScript(dir: string): readonly string[] {
  return readdirSync(dir).flatMap((nome) => {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) return fontesDeTypeScript(caminho);
    return /\.tsx?$/.test(nome) ? [caminho] : [];
  });
}

/**
 * Sem comentário: a frase que explica a regra cita o que a regra proíbe, e uma
 * guarda que reprova a própria explicação é guarda que alguém apaga — é a lição
 * da guarda de pureza do `core`. O que se procura é o `import`, não a menção.
 */
function semComentario(fonte: string): string {
  return fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('fontes da marca', () => {
  it('nenhuma tela busca fonte na internet durante o build', () => {
    const culpados = fontesDeTypeScript(raiz)
      .filter((caminho) =>
        /from '(next\/font\/google)'/.test(semComentario(readFileSync(caminho, 'utf8'))),
      )
      .map((caminho) => caminho.slice(raiz.length + 1));

    expect(culpados).toEqual([]);
  });

  it('os arquivos que o layout declara existem no repositório', () => {
    const layout = readFileSync(join(raiz, 'app', 'layout.tsx'), 'utf8');
    const declarados = [...layout.matchAll(/src: '(\.\.\/[^']+)'/g)].flatMap((achado) =>
      achado[1] === undefined ? [] : [achado[1]],
    );

    expect(declarados.length).toBeGreaterThan(0);
    for (const relativo of declarados) {
      expect(statSync(join(raiz, 'app', relativo)).size).toBeGreaterThan(0);
    }
  });
});
