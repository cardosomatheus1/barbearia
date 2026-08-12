import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ESTADOS_NAO_TERMINAIS, ESTADOS_QUE_OCUPAM_A_VENDA } from '@barbearia/core';

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

const MIGRACAO = readFileSync(
  join(import.meta.dirname, '../../db/migrations/0056_fiscal.sql'),
  'utf8',
);

/** Os estados dentro do `WHERE status IN (...)` de um índice parcial. */
function estadosDoIndice(indice = 'fiscal_invoices_uma_viva_por_comanda'): string[] {
  const semComentario = MIGRACAO.replace(/\/\*[\s\S]*?\*\//g, '');
  const trecho = semComentario.match(
    new RegExp(`INDEX ${indice}[\\s\\S]*?WHERE status IN \\(([^)]*)\\)`),
  );
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

  it('a varredura da prefeitura cobre exatamente os estados não terminais', () => {
    expect([...estadosDoIndice('fiscal_invoices_em_curso_idx')].sort()).toEqual(
      [...ESTADOS_NAO_TERMINAIS].sort(),
    );
  });

  it('nenhuma consulta escreve a própria lista de estados', () => {
    // O `IN ('pendente', ...)` literal é justamente o que divergiu, e as duas
    // listas deste arquivo se parecem o bastante para que a cópia errada não
    // chame atenção na revisão. Nenhuma delas mora aqui: as duas vêm de `core`.
    const codigo = readFileSync(join(import.meta.dirname, 'fiscal.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(codigo).not.toMatch(/status\s*(::text)?\s+IN\s*\(/i);
    expect(codigo).toContain('ESTADOS_QUE_OCUPAM_A_VENDA');
    expect(codigo).toContain('ESTADOS_NAO_TERMINAIS');
  });
});
