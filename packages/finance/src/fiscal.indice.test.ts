import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ESTADOS_EM_VOO, ESTADOS_QUE_OCUPAM_A_VENDA } from '@barbearia/core';

/**
 * O filtro da aplicação e o índice parcial dizem a mesma coisa.
 *
 * Esta é uma regra escrita do projeto, e ela foi quebrada neste mesmo bloco:
 * `cancelando` estava no índice `fiscal_invoices_uma_viva_por_comanda` e faltava
 * na lista que o domínio consulta antes de gravar. O efeito não era só um erro
 * feio — pedir nota enquanto um cancelamento estava em voo passava por toda a
 * validação, chegava ao `INSERT` e morria na constraint. No caminho automático
 * isso acontece **dentro** de `fecharComanda`, que roda na transação do webhook
 * do Pix: a exceção desfaz o pagamento inteiro por um motivo que não é de
 * pagamento.
 *
 * O teste lê a migração porque é lá que a garantia mora. Comparar a lista de
 * `core` com outra lista escrita à mão em TypeScript provaria que duas cópias
 * concordam entre si e continuaria cega para o banco, que é a terceira.
 */

/**
 * Duas migrações, porque o índice da fila foi refeito.
 *
 * A 0094 recriou `fiscal_invoices_em_curso_idx` para incluir `cancelando`: ler
 * só a 0056 faria esta guarda comparar a constante de hoje com o índice de
 * ontem — e concluir que divergem quando quem mudou foi ela, de propósito.
 */
const MIGRACAO = [
  readFileSync(join(import.meta.dirname, '../../db/migrations/0056_fiscal.sql'), 'utf8'),
  readFileSync(join(import.meta.dirname, '../../db/migrations/0094_nota_em_voo.sql'), 'utf8'),
].join('\n');

/** Os estados dentro do `WHERE status IN (...)` de um índice parcial. */
function estadosDoIndice(indice = 'fiscal_invoices_uma_viva_por_comanda'): string[] {
  const semComentario = MIGRACAO.replace(/\/\*[\s\S]*?\*\//g, '');
  // A **última** definição, não a primeira: um índice recriado numa migração
  // posterior é o que vale no banco, e casar a primeira compararia com o
  // desenho de ontem.
  const todos = [
    ...semComentario.matchAll(
      new RegExp(`INDEX (?:IF NOT EXISTS )?${indice}[\\s\\S]*?WHERE status IN \\(([^)]*)\\)`, 'g'),
    ),
  ];
  const trecho = todos[todos.length - 1];
  if (!trecho?.[1]) throw new Error(`índice ${indice} não encontrado`);
  return trecho[1]
    .split(',')
    .map((parte) => parte.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);
}

describe('nota viva por comanda', () => {
  it('o índice parcial cobre exatamente os estados que o domínio recusa', () => {
    expect([...estadosDoIndice()].sort()).toEqual([...ESTADOS_QUE_OCUPAM_A_VENDA].sort());
  });

  it('a varredura da prefeitura cobre exatamente os estados em voo', () => {
    // Em voo e não "não terminais": `cancelando` é o estado que a emissão não
    // alcança, e era justamente o que ficava preso para sempre.
    expect([...estadosDoIndice('fiscal_invoices_em_curso_idx')].sort()).toEqual(
      [...ESTADOS_EM_VOO].sort(),
    );
  });

  it('nenhuma consulta escreve a própria lista de estados', () => {
    // O `IN ('pendente', ...)` literal é justamente o que divergiu, e as duas
    // listas deste arquivo se parecem o bastante para que a cópia errada não
    // chame atenção na revisão. Nenhuma delas mora aqui: as duas vêm de `core`.
    // Todos os módulos de fiscal, não só `fiscal.ts`: ele virou barril quando o
    // arquivo foi partido, e uma guarda que lê o barril passa a olhar para um
    // `export *` — verde sobre um lugar onde consulta nenhuma mora.
    const codigo = readdirSync(import.meta.dirname)
      .filter((nome) => /^fiscal[-.].*\.ts$/.test(nome) && !nome.includes('.test.'))
      .map((nome) => readFileSync(join(import.meta.dirname, nome), 'utf8'))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(codigo).not.toMatch(/status\s*(::text)?\s+IN\s*\(/i);
    expect(codigo).toContain('ESTADOS_QUE_OCUPAM_A_VENDA');
    expect(codigo).toContain('ESTADOS_EM_VOO');
  });
});
