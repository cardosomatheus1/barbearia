import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Um rótulo aponta para **um** campo.
 *
 * ## O que quebra, e por que ninguém percebe
 *
 * `htmlFor` casa com `id`, e `id` é único no **documento** — não no formulário.
 * Quando uma tela ganha o segundo formulário com os mesmos campos (o de criar e
 * o de editar, o de cima e o do rodapé), todo `id="nome"` literal vira o mesmo
 * `id` duas vezes: o navegador resolve os dois para o primeiro, e clicar no
 * rótulo do segundo formulário foca o campo do primeiro.
 *
 * Salvar continua certo, porque quem carrega o valor é o `name` e o dono do
 * `name` é o `<form>`. Por isso o defeito é invisível para quem usa mouse e
 * clica direto no campo — ele só aparece para quem clica no rótulo, e para quem
 * navega por teclado, que é justamente quem depende do rótulo estar certo.
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
 * Ela lê o fonte. Um componente escrito uma vez e desenhado dez vezes aparece
 * uma vez aqui, então uma lista que repetisse campos por linha passaria verde
 * com dez `id` iguais no navegador. Isso foi verificado quebrando de propósito,
 * e não é conserto pendente: enxergar aquilo exigiria renderizar a tela, e nada
 * neste arquivo renderiza React.
 *
 * O que ela pega é a regressão que de fato acontece — a segunda cópia do
 * formulário, escrita à mão com `id="nome"` literal.
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
      'o mesmo id de campo aparece duas vezes na tela: clicar no rótulo de um formulário foca o ' +
        'campo do outro. Dê um id próprio a cada campo, ou derive-o de quem o desenha',
    ).toEqual([]);
  });
});
