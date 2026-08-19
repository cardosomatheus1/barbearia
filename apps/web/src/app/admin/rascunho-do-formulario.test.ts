import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * O formulário não perde o que foi digitado (bloco 98).
 *
 * ## O defeito
 *
 * A recusa voltava com a frase certa e o formulário **vazio**: quem montou um
 * público de sete campos recomeçava do zero por causa de um número que faltava.
 * Perder o trabalho de quem já acertou seis dos sete é o jeito mais rápido de a
 * pessoa desistir da tela — e é o oposto do que uma mensagem de erro serve para
 * fazer.
 *
 * ## Por que precisa de guarda
 *
 * O conserto tem **duas metades em arquivos diferentes**: a ação guarda uma
 * lista de campos, e a tela lê cada um deles no `defaultValue`. Um campo novo
 * entra na tela e ninguém lembra da lista da ação — e o defeito volta para
 * aquele campo só, que é a forma mais difícil de notar.
 *
 * A guarda casa as duas metades: todo `name` que a tela repõe precisa estar na
 * lista que a ação guarda, e vice-versa.
 */

const RAIZ = join(process.cwd(), 'src/app/admin');

function semComentarios(fonte: string): string {
  return fonte.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '').replace(/^\s*\/\/.*$/gm, '');
}

const acoes = semComentarios(readFileSync(join(RAIZ, 'acoes.ts'), 'utf8'));

/** Os campos que uma ação guarda, lidos da própria constante. */
function camposDaAcao(constante: string): readonly string[] {
  const bloco = new RegExp(`const ${constante} = \\[([\\s\\S]*?)\\] as const;`).exec(acoes);
  if (!bloco?.[1]) throw new Error(`não achei ${constante} em acoes.ts`);
  return [...bloco[1].matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
}

/**
 * Os campos que a tela repõe **do rascunho**.
 *
 * A âncora é `rascunho['x']` dentro do mesmo elemento, e não a presença de um
 * `defaultValue` qualquer: um `defaultValue="7"` fixo tem valor padrão e
 * continua perdendo o que a pessoa digitou. A primeira versão desta guarda
 * olhava só o `defaultValue` e passava verde sobre exatamente esse caso — o
 * teste medindo a presença do atributo, não a do conserto.
 *
 * Campo escondido fica de fora: ele não é digitado por ninguém.
 */
function camposRepostos(caminho: string): readonly string[] {
  const fonte = semComentarios(readFileSync(join(RAIZ, caminho), 'utf8'));
  const achados = new Set<string>();
  for (const elemento of fonte.matchAll(/<(?:input|select|textarea)\b[^>]*>/g)) {
    const texto = elemento[0];
    if (/type="hidden"/.test(texto)) continue;
    const nome = /name="([^"]+)"/.exec(texto);
    if (!nome?.[1]) continue;
    if (!texto.includes(`rascunho['${nome[1]}']`)) continue;
    achados.add(nome[1]);
  }
  return [...achados].sort();
}

describe('o formulário não perde o que foi digitado', () => {
  const telas = [
    { tela: 'campanhas/page.tsx', constante: 'CAMPOS_DA_CAMPANHA' },
    { tela: 'automacoes/page.tsx', constante: 'CAMPOS_DA_AUTOMACAO' },
  ] as const;

  for (const { tela, constante } of telas) {
    it(`${tela}: todo campo que a tela repõe está na lista que a ação guarda`, () => {
      const repostos = camposRepostos(tela);
      const guardados = camposDaAcao(constante);
      const esquecidos = repostos.filter((c) => !guardados.includes(c));

      expect(
        esquecidos,
        `estes campos voltam vazios depois de uma recusa: acrescente-os a ${constante}`,
      ).toEqual([]);
    });

    it(`${tela}: a ação não guarda campo que a tela não repõe`, () => {
      /**
       * A outra metade. Guardar um campo que ninguém lê é cookie escrito à toa
       * — e, pior, é a lista dizendo que aquele campo está coberto quando não
       * está.
       */
      const repostos = camposRepostos(tela);
      const guardados = camposDaAcao(constante);
      const sobrando = guardados.filter((c) => !repostos.includes(c));

      expect(
        sobrando,
        `${constante} guarda campos que a tela não repõe — ou reponha, ou tire da lista`,
      ).toEqual([]);
    });
  }
});
