import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reais } from '../lib/dinheiro.js';

/**
 * O dinheiro tem **um** formato no produto inteiro (bloco 101).
 *
 * ## O defeito
 *
 * Vinte e três telas declaravam cada uma o seu `const reais`, em quatro formas
 * diferentes. Onze delas usavam `reaisDoCampo` — cuja própria documentação diz
 * que é *"o formato que volta para o campo de edição"* — para **exibir**.
 *
 * O resultado aparecia lado a lado na mesma tela: `R$ 32432,00` num indicador
 * de Retenção e `R$ 1.848,00` no gráfico logo abaixo. O primeiro obriga a
 * contar dígitos, e número que se conta com o dedo é número em que ninguém
 * confia de relance — numa tela cuja função é decidir em cima dele.
 *
 * ## Por que precisa de guarda
 *
 * Um formatador local é uma linha a mais de escrever e some no meio de um
 * arquivo de mil linhas. Foi assim que quatro formatos conviveram sem nada
 * ficar vermelho: cada tela, sozinha, era coerente.
 */

const RAIZ = join(process.cwd(), 'src/app');

function semComentarios(fonte: string): string {
  return fonte.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '').replace(/^\s*\/\/.*$/gm, '');
}

function fontes(pasta: string): string[] {
  const achados: string[] = [];
  for (const nome of readdirSync(pasta)) {
    const caminho = join(pasta, nome);
    if (statSync(caminho).isDirectory()) achados.push(...fontes(caminho));
    else if (/\.tsx?$/.test(nome) && !nome.endsWith('.test.ts')) achados.push(caminho);
  }
  return achados;
}

const curto = (caminho: string) => caminho.slice(process.cwd().length + 1);

describe('o dinheiro na tela', () => {
  it('nenhuma tela declara o próprio formatador de reais', () => {
    /**
     * A âncora é `const <nome> = (centavos: number...` — a forma que todas as
     * vinte e três tinham. Um formatador com outro nome e outra forma escapa,
     * e é o preço de uma guarda que lê texto; o que ela impede é a cópia, que é
     * como as vinte e três nasceram.
     */
    const culpadas = fontes(RAIZ)
      .filter((caminho) => {
        const fonte = semComentarios(readFileSync(caminho, 'utf8'));
        return /const\s+\w*[Rr]eais\w*\s*=\s*\(centavos/.test(fonte);
      })
      .map(curto)
      // A linha do tempo arredonda de propósito, e o motivo está escrito nela:
      // rótulo direto num gráfico, onde o que se lê é a ordem de grandeza.
      .filter((caminho) => !caminho.endsWith('metricas/linha-do-tempo.tsx'));

    expect(
      culpadas,
      'a tela declara o próprio formatador: use `reais` de `@/lib/dinheiro`',
    ).toEqual([]);
  });

  it('nenhuma tela usa o formato do campo de edição para exibir', () => {
    /**
     * `reaisDoCampo` existe para **voltar para o input** — sem separador de
     * milhar, que é o que um campo de edição precisa. Usá-lo para exibir é o
     * que produziu `R$ 32432,00`.
     *
     * Formulário pode: ali ele está certo. A âncora é o `R$ ` colado nele, que
     * é a marca de quem estava exibindo.
     */
    const exibindo = fontes(RAIZ)
      .filter((caminho) => /R\$ \$\{reaisDoCampo/.test(semComentarios(readFileSync(caminho, 'utf8'))))
      .map(curto);

    expect(
      exibindo,
      '`reaisDoCampo` é o formato do campo de edição: para exibir, use `reais`',
    ).toEqual([]);
  });

  it('o formato tem separador de milhar e o sinal antes do símbolo', () => {
    expect(reais(3_243_200)).toBe('R$ 32.432,00');
    expect(reais(184_800)).toBe('R$ 1.848,00');
    expect(reais(0)).toBe('R$ 0,00');
    expect(reais(99)).toBe('R$ 0,99');
    // `R$ -500,00` põe o sinal no meio do valor e some na leitura de uma coluna.
    expect(reais(-50_000)).toBe('−R$ 500,00');
  });
});
