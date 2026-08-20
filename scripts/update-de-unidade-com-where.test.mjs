import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Todo `UPDATE locations` diz **qual** unidade (bloco 111).
 *
 * A RLS separa barbearias e não separa lojas dentro de uma. Um `UPDATE
 * locations SET ...` sem `WHERE` alcança a rede inteira da barbearia do
 * contexto — e o gerente escopado a uma filial reescreve a matriz com um clique
 * no formulário da tela dele.
 *
 * Aconteceu em sete lugares ao mesmo tempo: o cadastro da empresa, os meios de
 * pagamento, a janela de cancelamento, os dois limiares de score, o sinal e o
 * interruptor do marketplace. A filial de Rio Branco passava a se chamar como a
 * matriz, no fuso da matriz — e `orders.business_day` sai desse fuso, então o
 * dia da venda dela ficava errado.
 *
 * Varredura e não lista escrita: o oitavo `UPDATE` nasce cobrado. É a mesma
 * decisão da guarda de cascata do bloco 92 e da de permissão em rota.
 */

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Consultas dentro de arquivo de teste ficam de fora.
 *
 * Semente de teste escreve com o admin, fora de `withTenant`, e ali o alvo é o
 * banco descartável inteiro — exigir `WHERE` seria reprovar o certo, que é o
 * jeito mais rápido de alguém desligar a guarda.
 */
function fontesDeProducao() {
  const saida = execFileSync(
    'git',
    // `packages/*/src/**/*.ts` casa **sete** arquivos, não trezentos: no
    // pathspec do git, `**` só vale entre barras e `*` não atravessa `/`. A
    // primeira versão desta guarda passou verde sobre um `UPDATE` sem `WHERE`
    // porque nem chegava a ler o arquivo — é o caso que o segundo teste deste
    // arquivo existe para pegar, e que só apareceu ao quebrar de propósito.
    ['ls-files', 'packages', 'apps'],
    { cwd: raiz, encoding: 'utf8' },
  );
  return saida
    .split('\n')
    .filter(Boolean)
    .filter((caminho) => /\.ts$/.test(caminho))
    .filter((caminho) => !/\.test\.ts$/.test(caminho))
    .filter((caminho) => !/\/dist\//.test(caminho));
}

/** O trecho a partir de `UPDATE locations` até o fim daquela instrução. */
function atualizacoesDeUnidade(fonte) {
  const achados = [];
  const marca = /UPDATE\s+locations\b/gi;
  let casamento;
  while ((casamento = marca.exec(fonte)) !== null) {
    // O fim da instrução é a crase que fecha o template, ou o `;` que a encerra
    // dentro dele — o que vier primeiro.
    const resto = fonte.slice(casamento.index);
    const fim = resto.search(/`|;/);
    achados.push({
      indice: casamento.index,
      instrucao: fim === -1 ? resto : resto.slice(0, fim),
    });
  }
  return achados;
}

describe('UPDATE em locations', () => {
  it('sempre diz qual unidade — a RLS não separa lojas', () => {
    const semWhere = [];

    for (const caminho of fontesDeProducao()) {
      const fonte = readFileSync(join(raiz, caminho), 'utf8');
      if (!/UPDATE\s+locations/i.test(fonte)) continue;

      for (const { indice, instrucao } of atualizacoesDeUnidade(fonte)) {
        if (/\bWHERE\b/i.test(instrucao)) continue;
        const linha = fonte.slice(0, indice).split('\n').length;
        semWhere.push(`${caminho}:${linha}`);
      }
    }

    expect(semWhere, 'UPDATE locations sem WHERE alcança a rede inteira').toEqual([]);
  });

  it('a varredura enxerga um UPDATE sem WHERE quando existe um', () => {
    // Guarda em que se confia mais do que ela alcança é pior que guarda nenhuma:
    // este caso prova que o casamento acima não passa por vacuidade.
    const falso = 'await tx.$executeRaw`UPDATE locations SET cover_url = ${url}`;';
    const [primeiro] = atualizacoesDeUnidade(falso);
    expect(primeiro).toBeDefined();
    expect(/\bWHERE\b/i.test(primeiro.instrucao)).toBe(false);
  });
});
