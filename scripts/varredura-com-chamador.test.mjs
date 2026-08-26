import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Toda varredura e toda atribuição têm chamador no worker (bloco 108).
 *
 * ## O defeito
 *
 * `atribuirReceita` — a função que preenche "a única coluna que importa numa
 * campanha" — era chamada **só de dentro de `campanha.enviar`**, e naquele
 * instante nenhuma venda pode ter fechado depois do envio, porque a mensagem
 * acabou de sair. `campanha.enviar` é tarefa de uma vez só e não se reprograma:
 * a receita atribuída ficava em R$ 0,00 até alguém despachar a **próxima**
 * campanha. Para quem roda uma por mês, o número que decide se marketing vale a
 * pena era zero por um mês.
 *
 * A irmã dela, `atribuirObjetivos`, sempre esteve certa — mora na varredura de
 * hora em hora. As duas fazem a mesma coisa para mecanismos diferentes, e a
 * diferença entre elas não estava escrita em lugar nenhum.
 *
 * ## Por que uma guarda e não só o conserto
 *
 * É a terceira vez que este repositório encontra função exportada sem chamador
 * de verdade: a varredura da vitrine (bloco 70) foi escrita, exportada e nunca
 * chamada, e o cabeçalho da migração afirmava o contrário. *"Varredura prometida
 * num comentário tem chamador e tem teste, ou é comentário."*
 *
 * ## O que ela **não** vê
 *
 * Ela confere que o nome aparece no worker — não que ele seja chamado no lugar
 * certo, nem com a frequência certa. Uma função chamada dentro de um `if` morto
 * passa por ela. O que ela impede é o caso que de fato aconteceu duas vezes: a
 * função existir e o processo que deveria chamá-la não a mencionar.
 */

const RAIZ = process.cwd();

/**
 * Os **dois** lugares que disparam trabalho de fundo.
 *
 * `apps/worker/src/main.ts` monta o processo e injeta o `Contexto`;
 * `packages/jobs/src/worker.ts` é o despachante de tarefas e o laço periódico.
 * Uma varredura pode legitimamente ser chamada de qualquer um dos dois — olhar
 * só o primeiro acusava `varrerRetornos`, que é chamada pelo segundo desde que
 * existe. Guarda que acusa o certo é guarda que alguém desliga.
 */
const DISPARADORES = [
  readFileSync(join(RAIZ, 'apps/worker/src/main.ts'), 'utf8'),
  readFileSync(join(RAIZ, 'packages/jobs/src/worker.ts'), 'utf8'),
].join('\n');

/**
 * Os prefixos que nomeiam trabalho de fundo, e o que **não** basta o prefixo.
 *
 * Eram três, e faltava `limpar`: `limparUsoAntigo` — que poda o contador de
 * vazão da API pública — ficou sem chamador nenhum desde o bloco 78, com o
 * comentário dizendo "roda na varredura" e esta guarda passando verde ao lado.
 * Lista paralela dentro da guarda que existe para pegar lista paralela.
 *
 * Acrescentar o verbo sozinho, porém, fez a guarda acusar `limparFalhasDeLogin`
 * — que tem dois chamadores e **não é** trabalho de fundo: ela roda no login
 * bem-sucedido, para quem provou saber a senha não continuar de castigo. É o
 * caso que o cabeçalho deste arquivo adverte: guarda que acusa o certo é guarda
 * que alguém desliga.
 *
 * O que separa os dois não é o verbo, é a **assinatura**. Varredura recebe um
 * instante (`agora`, `antesDe`, um `Date`) e nenhum id de entidade: ela age
 * sobre o que o relógio deixou para trás. `limparFalhasDeLogin(emailKey)` age
 * sobre uma conta, a pedido de alguém. Por isso o prefixo é o primeiro filtro e
 * o `Date` na assinatura é o segundo.
 */
const PREFIXOS = ['varrer', 'atribuir', 'expirar', 'limpar', 'vencer', 'apurar'];

function fontes(pasta) {
  const achados = [];
  for (const nome of readdirSync(pasta)) {
    const caminho = join(pasta, nome);
    if (statSync(caminho).isDirectory()) {
      if (nome === 'node_modules' || nome === 'dist') continue;
      achados.push(...fontes(caminho));
    } else if (nome.endsWith('.ts') && !nome.includes('.test.')) {
      achados.push(caminho);
    }
  }
  return achados;
}

function exportadas() {
  const nomes = new Set();
  for (const caminho of fontes(join(RAIZ, 'packages'))) {
    const fonte = readFileSync(caminho, 'utf8');
    for (const achado of fonte.matchAll(/export async function (\w+)\s*\(([^)]*)\)/g)) {
      const nome = achado[1];
      const parametros = achado[2] ?? '';
      if (!PREFIXOS.some((p) => nome.startsWith(p))) continue;
      // O segundo filtro: recebe um instante, e não um id de entidade.
      if (!/\bDate\b|\bagora\b|\bantesDe\b/.test(parametros)) continue;
      nomes.add(nome);
    }
  }
  return [...nomes].sort();
}

describe('a varredura que ninguém chama', () => {
  it('a busca encontra as funções que deveria vigiar', () => {
    const nomes = exportadas();
    expect(nomes.length).toBeGreaterThan(3);
    expect(nomes).toContain('atribuirReceita');
    expect(nomes).toContain('atribuirObjetivos');
  });

  /**
   * As órfãs conhecidas, com motivo e destino escritos.
   *
   * Uma lista de exceções é o lugar mais perigoso de um teste, e por isso cada
   * linha aqui tem que dizer **por que** e **até quando**.
   *
   * Ela nasceu com uma — `varrerVitrine`, achada por esta guarda no bloco 108 —
   * e está **vazia** desde o 110, que a ligou ao laço periódico. Quem
   * acrescentar uma linha aqui está adiando; quem tirar uma entregou.
   */
  const CONHECIDAS = new Set([]);

  it('toda varredura e atribuição é mencionada por quem dispara trabalho de fundo', () => {
    const orfas = exportadas()
      .filter((nome) => !DISPARADORES.includes(nome))
      .filter((nome) => !CONHECIDAS.has(nome));
    expect(orfas, 'função de fundo sem chamador é comentário, não código').toEqual([]);
  });

  it('a lista de conhecidas não guarda quem já tem chamador', () => {
    /**
     * A exceção que deixou de ser necessária tem que sair, senão ela vira a
     * linha que ninguém revisa — e a próxima órfã de mesmo nome passaria por
     * baixo dela.
     */
    const resolvidas = [...CONHECIDAS].filter((nome) => DISPARADORES.includes(nome));
    expect(resolvidas, 'exceção obsoleta: esta função já é chamada').toEqual([]);
  });
});
