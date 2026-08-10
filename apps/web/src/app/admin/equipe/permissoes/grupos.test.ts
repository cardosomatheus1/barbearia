import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSOES } from '@barbearia/core';

/**
 * Toda permissão do catálogo aparece na tela que as concede.
 *
 * O `TEXTO` já é `Record<Permissao, string>`, então esquecer o rótulo não
 * compila. `GRUPOS` é outra história: ele monta as seções por prefixo, e
 * permissão com prefixo novo — `security.` foi a primeira — cai fora de todos
 * eles **sem nada ficar vermelho**. O resultado é uma permissão que existe, que
 * a API exige, e que o dono não tem por onde conceder nem tirar.
 *
 * É a mesma classe de defeito de `lgpd` e `plano` no trilho (`CLAUDE.md` §6):
 * registro num lugar, lista escrita à mão em outro, e as duas divergindo em
 * silêncio.
 */

const TELA = join(process.cwd(), 'src/app/admin/equipe/permissoes/page.tsx');

/**
 * O corpo de `GRUPOS`, sem os comentários.
 *
 * Sem tirá-los, a explicação de por que `security.mfa_policy` mora no grupo do
 * dinheiro contaria como se ela estivesse listada — e o teste passaria por ler
 * a justificativa, não a regra.
 */
function grupos(): string {
  const fonte = readFileSync(TELA, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const inicio = fonte.indexOf('const GRUPOS');
  expect(inicio, 'GRUPOS não foi encontrado na tela').toBeGreaterThan(-1);
  return fonte.slice(inicio, fonte.indexOf('\n];', inicio));
}

describe('a tela que concede permissões', () => {
  it('cobre o catálogo inteiro, prefixo por prefixo', () => {
    const corpo = grupos();

    const foraDeTodos = PERMISSOES.filter((permissao) => {
      // Ou o prefixo dela está num `startsWith`, ou o nome inteiro está escrito.
      const prefixo = `${permissao.split('.')[0]}.`;
      return !corpo.includes(`startsWith('${prefixo}')`) && !corpo.includes(`'${permissao}'`);
    });

    expect(
      foraDeTodos,
      `permissão que nenhum grupo da tela alcança: ${foraDeTodos.join(', ')}`,
    ).toEqual([]);
  });
});
