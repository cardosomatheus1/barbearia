import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A prévia da mensagem sai do tipo escolhido, nunca da lista inteira (bloco 92).
 *
 * ## O defeito
 *
 * As telas de automação e de campanha ofereciam um seletor de tipo e, logo
 * abaixo, **todos** os textos aprovados, com a frase *"é este o texto que o
 * cliente vai ler"* no singular. Na tela de verdade o seletor dizia "Convite de
 * retorno — sem texto aprovado" e a caixa mostrava "Lembrete de 24 horas": a
 * tela afirmava que sairia um texto que aquela automação nunca manda.
 *
 * É a §6 pergunta 6 — duas telas que mostram o mesmo fato concordam — acontecendo
 * dentro de uma tela só, entre dois campos vizinhos.
 *
 * ## Por que precisa de guarda
 *
 * Nada ficava vermelho. Cada metade era coerente sozinha: o seletor listava os
 * tipos certos, a caixa listava os textos aprovados certos. O erro é a
 * **vizinhança**, e vizinhança não tem teste de unidade.
 *
 * E ele voltaria: mostrar a lista inteira é uma linha mais curta de escrever do
 * que casar por tipo, e a tela seguinte que precisar mostrar um template vai
 * começar copiando a que já existe — foi assim que a segunda cópia nasceu.
 */

const RAIZ = join(process.cwd(), 'src/app/admin');

/**
 * Tira comentário antes de varrer: sem isto a guarda reprova a **explicação**
 * do defeito, que cita o código errado para contar o que aconteceu. Guarda que
 * proíbe documentar o próprio motivo é guarda que alguém apaga.
 */
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

/**
 * Quem oferece a escolha do tipo é quem promete um texto.
 *
 * A âncora é a constante do domínio, e não `name="tipo"`. Com o nome do campo,
 * a guarda acusava a tela de estoque — cujo "tipo" é entrada, venda ou perda —
 * e a de WhatsApp, cujo "tipo" é o do template sendo cadastrado. Nenhuma das
 * duas promete "é este o texto que o cliente vai ler"; quem promete é quem
 * desenha uma escolha sobre `TIPOS_DE_CAMPANHA`.
 */
const ESCOLHE_TIPO = /TIPOS_DE_CAMPANHA\.map\(/;

/**
 * A lista inteira sendo desenhada. `textos` é o nome do arranjo de aprovados nas
 * duas telas; o que se proíbe é percorrê-lo para desenhar, e não tê-lo.
 */
const DESENHA_TODOS = /\btextos\.map\(/;

describe('a prévia da mensagem', () => {
  it('nenhuma tela que escolhe o tipo desenha a lista inteira de textos', () => {
    const culpadas = telas(RAIZ)
      .filter((caminho) => {
        const fonte = semComentarios(readFileSync(caminho, 'utf8'));
        return ESCOLHE_TIPO.test(fonte) && DESENHA_TODOS.test(fonte);
      })
      .map((caminho) => caminho.slice(process.cwd().length + 1));

    expect(
      culpadas,
      'a tela promete "é este o texto" ao lado de uma escolha de tipo, e desenha todos: ' +
        'case o texto por tipo (`textos.find((x) => x.tipo === t)`)',
    ).toEqual([]);
  });

  it('quem escolhe o tipo casa o texto por tipo', () => {
    /**
     * A outra metade. Sem ela, apagar a prévia inteira passaria na guarda de
     * cima — e a pergunta que esta tela existia para responder ("o que vai
     * sair?") voltaria a não ter resposta.
     */
    const semCasamento = telas(RAIZ)
      .filter((caminho) => {
        const fonte = semComentarios(readFileSync(caminho, 'utf8'));
        return ESCOLHE_TIPO.test(fonte) && !/\.tipo === /.test(fonte);
      })
      .map((caminho) => caminho.slice(process.cwd().length + 1));

    expect(
      semCasamento,
      'a tela escolhe um tipo de mensagem e não mostra o texto daquele tipo',
    ).toEqual([]);
  });
});
