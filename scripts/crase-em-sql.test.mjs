import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * Crase dentro de consulta SQL.
 *
 * `tx.$queryRaw` é um *tagged template*: a consulta inteira é delimitada por
 * crases. Uma crase no meio dela — quase sempre num comentário explicando a
 * decisão, no estilo do resto do repositório — **fecha o template**, e dali em
 * diante o TypeScript lê SQL como código. O erro que sai disso não ajuda:
 * `TS1005: ',' expected` apontando para uma linha de prosa.
 *
 * Aconteceu três vezes neste repositório, em três blocos diferentes, e as três
 * custaram uma volta de build para descobrir o mesmo. A regra é simples e não
 * custa nada: **dentro de uma consulta, comentário é `--` e não leva crase.**
 *
 * ## Como a detecção funciona, e por que as duas primeiras versões falharam
 *
 * A crase perdida **vira a crase de fechamento**. Não adianta procurá-la
 * "dentro" do corpo, porque para o compilador ela é o fim do corpo. O que a
 * denuncia é onde o fechamento cai: no repositório inteiro, uma consulta fecha
 * numa linha que só tem a crase. Se o fechamento aparece no meio de uma frase,
 * a frase estava dentro do SQL.
 *
 * A primeira versão procurava a crase logo depois de `$queryRaw` e não via
 * `$queryRaw<Linha[]>`, com o tipo no meio. A segunda lia só arquivos
 * rastreados, e não via o arquivo recém-escrito — que é justamente onde o
 * defeito nasce. Guarda que procura o padrão errado, ou no lugar errado, fica
 * verde por não ter olhado.
 */

const RAIZ = new URL('..', import.meta.url);

/**
 * Rastreados **e** os novos ainda não commitados.
 *
 * O filtro por caminho é feito aqui, e não no pathspec do git: `--others` com
 * glob de várias pastas não devolve o que se espera, e foi assim que a versão
 * anterior deixou de fora em silêncio exatamente o arquivo novo.
 */
const ARQUIVOS = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', 'packages', 'apps'],
  { encoding: 'utf8', cwd: RAIZ.pathname },
)
  .split('\n')
  .filter((caminho) => caminho.includes('/src/') && caminho.endsWith('.ts'));

const CHAMADA = /\$(?:query|execute)Raw(?:Unsafe)?/g;

/** A linha em que um índice do arquivo cai, contando de 1. */
const linhaDe = (fonte, indice) => fonte.slice(0, indice).split('\n').length;

/**
 * Percorre cada consulta e devolve onde ela fecha.
 *
 * `${...}` é respeitado com contador de profundidade: uma crase dentro de uma
 * interpolação pertence a outro template, não a esta consulta.
 */
function fechamentos(fonte) {
  const achados = [];

  for (const chamada of fonte.matchAll(CHAMADA)) {
    // `$queryRaw` citado dentro de um comentário não é uma consulta. Sem isto,
    // a varredura sai procurando o fechamento de um template que não existe e
    // acusa a prosa seguinte.
    const linhaDaChamada = (fonte.slice(0, chamada.index).split('\n').pop() ?? '').trim();
    if (linhaDaChamada.startsWith('*') || linhaDaChamada.startsWith('//')) continue;

    const abre = fonte.indexOf('`', chamada.index);
    if (abre === -1) continue;

    let profundidade = 0;
    let fecha = -1;

    for (let i = abre + 1; i < fonte.length; i += 1) {
      const c = fonte[i];
      if (c === '\\') {
        i += 1;
        continue;
      }
      if (c === '$' && fonte[i + 1] === '{') {
        profundidade += 1;
        i += 1;
        continue;
      }
      if (c === '}' && profundidade > 0) {
        profundidade -= 1;
        continue;
      }
      if (c === '`' && profundidade === 0) {
        fecha = i;
        break;
      }
    }

    achados.push({
      fecha,
      linha: linhaDe(fonte, fecha === -1 ? abre : fecha),
      // Consulta de uma linha só não tem onde esconder prosa; a regra do
      // fechamento limpo vale para as de várias linhas, que são as que levam
      // comentário.
      umaLinha: fecha !== -1 && linhaDe(fonte, abre) === linhaDe(fonte, fecha),
    });
  }

  return achados;
}

/**
 * O que denuncia a crase perdida.
 *
 * Não é "a linha do fechamento tem SQL" — fechar na última cláusula é estilo
 * legítimo e usado em dezenas de consultas aqui. É a linha do fechamento ser
 * **prosa**: comentário de SQL (`--`) ou continuação de bloco (`*`) antes da
 * crase. Essa é a assinatura exata do defeito, e nada mais.
 */
function fechamentoEmProsa(texto, coluna) {
  const antes = texto.slice(0, coluna);
  return /(^|\s)--/.test(antes) || /^\s*\*/.test(antes);
}

describe('crase dentro de consulta SQL', () => {
  it('a varredura encontra as consultas que deveria vigiar', () => {
    // Sem esta guarda, um padrão que deixasse de casar faria o teste abaixo
    // passar sobre zero consultas — que foi o que as duas primeiras versões
    // fizeram, cada uma por um motivo diferente.
    const total = ARQUIVOS.reduce(
      (soma, arquivo) => soma + fechamentos(readFileSync(new URL(arquivo, RAIZ), 'utf8')).length,
      0,
    );
    expect(total, 'nenhuma consulta encontrada — a varredura perdeu o alvo').toBeGreaterThan(80);
    /**
     * Teto folgado de propósito, e o motivo tem uma ressalva escrita.
     *
     * Ele apareceu numa execução em que havia um daemon do Docker rodando por
     * fora: este teste leva 0,2s sozinho, levou 8,4s ali e estourou o padrão de
     * 5s do vitest. Com a máquina livre o portão inteiro voltou a passar — ou
     * seja, **o gatilho foi contenção, não lentidão do teste**, e a mesma
     * execução derrubou um teste de banco que também não tinha defeito nenhum.
     *
     * O teto fica assim mesmo, e a diferença é qual garantia cada teste carrega.
     * Aqui o tempo não prova nada: a garantia é a **contagem** de consultas
     * varridas, e ela não muda com a carga da máquina — então limitar em 5s uma
     * leitura de quatrocentos arquivos é um limite arbitrário que só produz
     * vermelho falso em máquina ocupada ou em esteira lenta. Guarda que fica
     * vermelho à toa treina todo mundo a ignorar vermelho.
     *
     * Nos testes de banco a decisão foi a **oposta**: lá a duração carrega
     * sinal — uma consulta que ficou lenta é defeito de verdade —, e afrouxar o
     * teto esconderia regressão. Aquele ficou como estava.
     */
  }, 60_000);

  it('toda consulta fecha numa linha que só tem a crase', () => {
    const problemas = [];

    for (const arquivo of ARQUIVOS) {
      const fonte = readFileSync(new URL(arquivo, RAIZ), 'utf8');
      const linhas = fonte.split('\n');

      for (const { fecha, linha, umaLinha } of fechamentos(fonte)) {
        if (umaLinha) continue;
        if (fecha === -1) {
          problemas.push(`${arquivo}:${linha} — consulta sem fim`);
          continue;
        }
        const texto = linhas[linha - 1] ?? '';
        const coluna = fecha - (fonte.lastIndexOf('\n', fecha - 1) + 1);
        if (fechamentoEmProsa(texto, coluna)) {
          problemas.push(`${arquivo}:${linha} — ${texto.trim()}`);
        }
      }
    }

    expect(
      problemas,
      'crase dentro da consulta fecha o template; use comentário -- sem crase',
    ).toEqual([]);
    // Mesmo teto, e pelo mesmo motivo: os dois testes leem os mesmos arquivos.
  }, 60_000);
});
