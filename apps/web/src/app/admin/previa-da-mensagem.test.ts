import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * O que a tela promete que vai sair (blocos 92 e 96).
 *
 * ## O primeiro defeito, e por que ele voltou de outro jeito
 *
 * No bloco 92 as telas de automação e de campanha ofereciam um seletor de
 * **tipo** e, logo abaixo, todos os textos aprovados, com a frase *"é este o
 * texto que o cliente vai ler"* no singular. O seletor dizia "Convite de
 * retorno" e a caixa mostrava "Lembrete de 24 horas".
 *
 * A guarda daquele bloco cobrava casar por tipo. Ela estava certa enquanto
 * existia **um texto por tipo** — e essa premissa caiu no bloco 94, quando o
 * mesmo tipo passou a ter quantos textos a barbearia quisesse. A partir dali,
 * casar por tipo era o defeito: com três convites de retorno cadastrados, a
 * tela mostrava a prévia de um e o motor mandava o primeiro que a consulta
 * achasse.
 *
 * ## O que a guarda cobra agora
 *
 * Duas coisas, e as duas derivadas do fonte:
 *
 * 1. **A escolha é o texto, nunca o tipo.** Uma escolha desenhada sobre
 *    `TIPOS_DE_CAMPANHA` é uma escolha que não distingue os três convites de
 *    retorno — e é a linha mais curta de escrever, então é a que a próxima tela
 *    vai copiar.
 * 2. **Corpo mostrado é corpo preenchido.** `{{1}}` é vocabulário da Meta: lido
 *    no balcão, ele parece que falta alguma coisa, e a decisão que a tela pede
 *    é justamente sobre o que **não** falta.
 *
 * ## Por que precisa de guarda
 *
 * Nada fica vermelho por nenhum dos dois. Cada metade é coerente sozinha: o
 * seletor lista o que deve listar, a caixa mostra um corpo de verdade. O erro é
 * a **vizinhança** e o **vocabulário**, e nenhum dos dois tem teste de unidade.
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

const curto = (caminho: string) => caminho.slice(process.cwd().length + 1);

/**
 * Uma escolha desenhada sobre os tipos.
 *
 * A âncora é a constante do domínio, e não `name="tipo"`. Com o nome do campo,
 * a guarda acusava a tela de estoque — cujo "tipo" é entrada, venda ou perda —
 * e a de WhatsApp, cujo "tipo" é o do template sendo cadastrado. Nenhuma das
 * duas escolhe qual mensagem sai.
 */
const ESCOLHE_TIPO = /TIPOS_DE_CAMPANHA\.map\(/;

/** Um corpo de template desenhado como conteúdo: `>{algo.corpo}<`. */
const MOSTRA_CORPO = />\s*\{\s*\w+\.corpo\s*\}\s*</;

/** O corpo com as variáveis já preenchidas, que é como o cliente vai ler. */
const PREENCHE = /corpoComExemplos\(/;

describe('o que a tela promete que vai sair', () => {
  it('nenhuma tela escolhe a mensagem pelo tipo — a escolha é o texto', () => {
    /**
     * Escolher pelo tipo era certo enquanto havia um texto por tipo. Desde o
     * bloco 94 há quantos a barbearia quiser, e o tipo deixou de responder
     * "qual dos três vai sair?".
     */
    const culpadas = telas(RAIZ)
      .filter((caminho) => ESCOLHE_TIPO.test(semComentarios(readFileSync(caminho, 'utf8'))))
      .map(curto);

    expect(
      culpadas,
      'a tela escolhe a mensagem por tipo: ofereça os textos aprovados por id ' +
        '(`name="templateId"`), como a automação faz desde o bloco 94',
    ).toEqual([]);
  });

  it('toda tela que mostra um corpo mostra ele preenchido', () => {
    /**
     * A tela de WhatsApp mostra os dois — ali o texto cru é o artefato que se
     * escreve e que a Meta aprova. O que a guarda proíbe é mostrar **só** o
     * cru, que é o que as outras três faziam.
     */
    const cruas = telas(RAIZ)
      .filter((caminho) => {
        const fonte = semComentarios(readFileSync(caminho, 'utf8'));
        return MOSTRA_CORPO.test(fonte) && !PREENCHE.test(fonte);
      })
      .map(curto);

    expect(
      cruas,
      'a tela mostra o corpo com `{{1}}` na cara de quem opera: passe por ' +
        '`corpoComExemplos(tipo, corpo)`',
    ).toEqual([]);
  });

  it('quem oferece mandar mensagem só oferece texto de campanha', () => {
    /**
     * A ficha do cliente listava os **seis** textos aprovados com um botão
     * "Mandar" cada, incluindo confirmação e os dois lembretes. Os três falam
     * de um horário marcado, que quem recebe uma mensagem avulsa não tem — e o
     * domínio já os recusava desde o bloco 92. Eram três botões que só podiam
     * dar erro: §6 pergunta 1, botão que leva a lugar nenhum.
     *
     * A âncora é a ação, e não o nome do arquivo: a próxima tela que oferecer
     * este botão nasce cobrada.
     */
    const semFiltro = telas(RAIZ)
      .filter((caminho) => {
        const fonte = semComentarios(readFileSync(caminho, 'utf8'));
        /**
         * `TIPOS_DE_CAMPANHA` **em uso**, e não na linha de import: com o nome
         * solto, tirar o filtro e deixar o import passava verde — a guarda
         * media a presença da palavra, não a do recorte.
         */
        return /acaoMandarMensagem/.test(fonte) && !/TIPOS_DE_CAMPANHA\s+as/.test(fonte);
      })
      .map(curto);

    expect(
      semFiltro,
      'a tela oferece mandar mensagem sem recortar por `TIPOS_DE_CAMPANHA`: ' +
        'lembrete e confirmação falam de um horário que essa pessoa não tem',
    ).toEqual([]);
  });

  it('nenhuma tela escreve o próprio mapa de nomes de aviso', () => {
    /**
     * Havia **três** cópias de `NOME_DO_AVISO`, e as três divergiram: "Sua vez
     * na fila" em `packages/core`, "É a sua vez" na tela de avisos,
     * "Confirmação do agendamento" numa e "Confirmação" na outra. É a §6
     * pergunta 2 — a mesma coisa com nomes diferentes em telas do mesmo
     * produto —, e é a lista paralela que este repositório mais cataloga.
     *
     * O nome mora em `packages/core` e chega por `nomeDoAviso`.
     */
    const copias = telas(RAIZ)
      .filter((caminho) =>
        /const\s+NOME_DO_AVISO\s*[:=]/.test(semComentarios(readFileSync(caminho, 'utf8'))),
      )
      .map(curto);

    expect(
      copias,
      'a tela escreve o próprio mapa de nomes de aviso: use `nomeDoAviso` de `@barbearia/core`',
    ).toEqual([]);
  });

  it('quem mostra corpo preenchido não perdeu o corpo de vista', () => {
    /**
     * A outra metade, pelo motivo da guarda anterior: apagar a prévia inteira
     * passaria nas duas de cima, e a pergunta que estas telas existem para
     * responder — "o que vai sair?" — voltaria a não ter resposta.
     */
    const vazias = telas(RAIZ)
      .filter((caminho) => {
        const fonte = semComentarios(readFileSync(caminho, 'utf8'));
        return PREENCHE.test(fonte) && !/\.corpo\b/.test(fonte);
      })
      .map(curto);

    expect(vazias, 'a tela chama a prévia sem ter corpo nenhum para mostrar').toEqual([]);
  });
});
