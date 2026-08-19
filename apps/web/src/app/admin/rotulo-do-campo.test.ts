import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Um rótulo aponta para **um** campo (bloco 93).
 *
 * ## O que a guarda existe para pegar
 *
 * `htmlFor` casa com `id`, e `id` é único no documento inteiro — não no
 * formulário. Quando um formulário passa a ser desenhado uma vez por linha da
 * lista, todo `id="nome"` literal vira o mesmo `id` repetido N vezes: o
 * navegador resolve todos para o primeiro, e clicar no rótulo da terceira
 * automação foca o campo da primeira. A tela continua salvando certo, porque o
 * `name` é do formulário; o que quebra é a única coisa que ninguém testa —
 * clicar no rótulo, e o teclado, que é como quem não usa mouse chega ao campo.
 *
 * A tela de automações passou a ter um formulário por automação mais o de
 * criar. A saída é o prefixo (`a-${id}-nome`), que é o desenho da tela de
 * pacotes; esta guarda é o que cobra o prefixo na próxima.
 *
 * ## Por que só o `id` que é alvo de `htmlFor`
 *
 * `id` também serve a `aria-labelledby`, e ali repetir é legítimo: o onboarding
 * usa `id="t"` no título de cada passo, e os passos são ramos exclusivos — só um
 * existe no documento por vez. Reprovar aquilo seria reprovar o certo, que é o
 * que faz alguém desligar a guarda.
 *
 * ## O que ela **não** vê, escrito para ninguém confiar demais
 *
 * Ela lê o fonte, e um componente escrito uma vez e desenhado dez vezes aparece
 * uma vez aqui. Se o prefixo desta tela for removido — `campo` passando a
 * devolver o nome cru —, o `id` continua sendo expressão e a guarda fica verde
 * sobre dez campos com o mesmo `id` no navegador. Isso foi verificado quebrando
 * de propósito, e não é conserto pendente: para enxergar aquilo seria preciso
 * renderizar a tela, e nada aqui renderiza React.
 *
 * O que ela pega é a regressão que de fato acontece — a segunda cópia do
 * formulário, escrita à mão dentro da linha com `id="nome"` literal, que é
 * exatamente o caminho curto que este bloco não seguiu.
 */

const RAIZ = join(process.cwd(), 'src/app/admin');

/** Guarda que proíbe documentar o próprio motivo é guarda que alguém apaga. */
function semComentarios(fonte: string): string {
  return fonte.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '').replace(/^\s*\/\/.*$/gm, '');
}

function telas(pasta: string): string[] {
  const achados: string[] = [];
  for (const nome of readdirSync(pasta)) {
    const caminho = join(pasta, nome);
    if (statSync(caminho).isDirectory()) achados.push(...telas(caminho));
    else if (nome.endsWith('.tsx')) achados.push(caminho);
  }
  return achados;
}

describe('o rótulo do campo', () => {
  it('nenhuma tela repete um id que algum rótulo aponta', () => {
    const culpadas: string[] = [];

    for (const caminho of telas(RAIZ)) {
      const fonte = semComentarios(readFileSync(caminho, 'utf8'));
      const rotulados = new Set([...fonte.matchAll(/\bhtmlFor="([^"]+)"/g)].map((m) => m[1]));
      const ids = [...fonte.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);

      const repetidos = [
        ...new Set(ids.filter((i) => rotulados.has(i) && ids.filter((o) => o === i).length > 1)),
      ].sort();

      if (repetidos.length > 0) {
        culpadas.push(`${caminho.slice(process.cwd().length + 1)}: ${repetidos.join(', ')}`);
      }
    }

    expect(
      culpadas,
      'o mesmo id de campo aparece duas vezes na tela: clicar no rótulo de uma linha foca o ' +
        'campo de outra. Prefixe o id por linha, como em pacotes (`a-${id}-nome`)',
    ).toEqual([]);
  });
});
