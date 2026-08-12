import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PERMISSOES } from '@barbearia/core';

const AQUI = dirname(fileURLToPath(import.meta.url));

/**
 * A guarda contra a permissão que existe e não tem caixa.
 *
 * A tela agrupa por **prefixo**, e é isso que faz uma permissão nova aparecer
 * sozinha — desde que o prefixo dela caiba em algum grupo. Quando não cabe, a
 * caixa não existe: a permissão fica no catálogo, é cobrada pela API, e a única
 * forma de concedê-la é um `UPDATE` no banco de produção.
 *
 * Aconteceu de verdade. `feedback.view` e `feedback.manage` entraram no bloco
 * 40, não casaram com nenhum prefixo e ficaram **três blocos** invisíveis, com
 * a tela e a suíte verdes o tempo todo. É o mesmo defeito que `lgpd` e `plano`
 * tiveram no CSS do casco — lista escrita à mão que envelhece em silêncio —, e
 * a correção é a mesma: derivar do catálogo em vez de conferir de memória.
 *
 * Lê o arquivo em vez de importar a constante porque `page.tsx` é um componente
 * de servidor: importá-lo puxaria `next/navigation` e a sessão junto.
 */
describe('toda permissão do catálogo tem caixa na tela', () => {
  const fonte = readFileSync(join(AQUI, 'page.tsx'), 'utf8');

  /** Os prefixos e nomes exatos que os filtros de `GRUPOS` aceitam. */
  const cobertos = (): ((permissao: string) => boolean)[] => {
    const regras: ((permissao: string) => boolean)[] = [];
    for (const [, prefixo] of fonte.matchAll(/startsWith\('([a-z_]+\.)'\)/g)) {
      regras.push((p) => p.startsWith(prefixo!));
    }
    for (const [, exata] of fonte.matchAll(/p === '([a-z_]+\.[a-z_]+)'/g)) {
      regras.push((p) => p === exata);
    }
    return regras;
  };

  it('nenhuma permissão fica fora de todos os grupos', () => {
    const regras = cobertos();
    const orfas = PERMISSOES.filter((p) => !regras.some((cabe) => cabe(p)));

    expect(
      orfas,
      `permissão sem caixa na tela de permissões: ${orfas.join(', ')}`,
    ).toEqual([]);
  });

  it('toda permissão tem uma frase em português', () => {
    // Sem a frase, a caixa apareceria com o nome técnico — e `commission.view_all`
    // e `commission.view_own` diferem por uma palavra em inglês e por quem briga
    // na barbearia.
    const semTexto = PERMISSOES.filter((p) => !fonte.includes(`'${p}':`));
    expect(semTexto, `permissão sem rótulo: ${semTexto.join(', ')}`).toEqual([]);
  });
});
