import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Toda métrica do catálogo tem quem a responda, e uma tela que a mostre.
 *
 * `margem_por_servico` esteve no catálogo, na tela e no seletor do assistente
 * enquanto `medir` devolvia `{ total: null }` para ela de propósito — "quem as
 * compõe é a borda", dizia o comentário — e a borda compunha duas das três. O
 * dono clicava em "Qual serviço dá a maior margem?" e recebia **`—`**, sobre um
 * número que a tela de Estoque já mostrava.
 *
 * Indicador que nunca preenche é pior que indicador ausente: ele ocupa espaço
 * prometendo uma resposta que não vem, e quem opera aprende a não olhar.
 *
 * O `tela` entra junto porque a SPEC §4.15 pede o link para onde o número pode
 * ser **conferido**, e é isso que impede o assistente de virar oráculo — dois
 * apontavam para `/admin/financeiro`, que desde o bloco 103 se chama Contas e
 * não mostra faturamento nenhum.
 */

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');

const catalogo = readFileSync(join(raiz, 'packages/core/src/metrica.ts'), 'utf8');
const borda = readFileSync(join(raiz, 'apps/api/src/admin/metrica.controller.ts'), 'utf8');
const motor = readFileSync(join(raiz, 'packages/finance/src/metrica.ts'), 'utf8');

const metricas = [...catalogo.matchAll(/^    chave: '([^']+)',$/gm)].map((m) => m[1]);
const telas = [...catalogo.matchAll(/^    tela: '([^']+)',$/gm)].map((m) => m[1]);

describe('catálogo de métricas', () => {
  it('a varredura acha o catálogo — sem isso ela não prova nada', () => {
    expect(metricas.length).toBeGreaterThanOrEqual(8);
    expect(telas.length).toBe(metricas.length);
  });

  it('toda métrica é respondida pelo motor ou composta pela borda', () => {
    /**
     * O motor responde o que ele mesmo mede; a borda compõe o que mora em
     * outro pacote. Uma métrica que não aparece em nenhum dos dois é a que
     * devolve `—` para sempre.
     */
    const semResposta = metricas.filter(
      (chave) => !borda.includes(`'${chave}'`) && !motor.includes(`'${chave}'`),
    );

    expect(
      semResposta,
      'estas estão no catálogo e ninguém as calcula: a tela responde "—" para sempre',
    ).toEqual([]);
  });

  it('toda métrica aponta para uma tela que existe', () => {
    const inexistentes = telas.filter((tela) => {
      const caminho = join(raiz, 'apps/web/src/app', tela.replace(/^\//, ''), 'page.tsx');
      try {
        readFileSync(caminho);
        return false;
      } catch {
        return true;
      }
    });

    expect(inexistentes, 'estas telas não existem').toEqual([]);
  });
});
