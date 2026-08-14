import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ESCOPOS_DISPONIVEIS, PERMISSOES_DE_DINHEIRO } from '@barbearia/core';

/**
 * A API pública, conferida por derivação (bloco 78).
 *
 * Estas guardas existem porque as três camadas que proíbem dinheiro numa chave
 * — a borda, o domínio e o `CHECK` do banco — só valem enquanto disserem a
 * mesma coisa. Uma permissão de dinheiro nova entra em `PERMISSOES_DE_DINHEIRO`
 * e o `CHECK` continua citando `finance.`/`cashier.` à mão: se as duas
 * divergirem, é aqui que fica vermelho.
 */

const RAIZ = new URL('../src/publica', import.meta.url).pathname;
const MIGRACAO = new URL(
  '../../../packages/db/migrations/0075_api_publica.sql',
  import.meta.url,
).pathname;

describe('a porta da API pública', () => {
  it('o `CHECK` do banco cobre toda permissão de dinheiro do catálogo', () => {
    /**
     * O `CHECK` não chama código, então ele repete a regra — e repetição é o
     * que diverge. Esta asserção percorre `PERMISSOES_DE_DINHEIRO` e confere
     * que cada uma cai numa das duas formas que o banco reconhece.
     */
    const sql = readFileSync(MIGRACAO, 'utf8');
    const bloco = sql.slice(
      sql.indexOf('api_keys_sem_dinheiro'),
      sql.indexOf('CREATE UNIQUE INDEX api_keys_prefixo'),
    );

    for (const permissao of PERMISSOES_DE_DINHEIRO) {
      const porPrefixo =
        (permissao.startsWith('finance.') || permissao.startsWith('cashier.')) &&
        bloco.includes('(finance|cashier)');
      const porNome = bloco.includes(`'${permissao}'`);

      expect(
        porPrefixo || porNome,
        `${permissao} não é barrada pelo CHECK de api_keys — a chave de API poderia carregá-la`,
      ).toBe(true);
    }
  });

  it('nenhuma permissão de dinheiro é oferecida como escopo', () => {
    for (const proibida of PERMISSOES_DE_DINHEIRO) {
      expect(ESCOPOS_DISPONIVEIS).not.toContain(proibida);
    }
  });

  it('toda rota da API pública declara escopo', () => {
    /**
     * A mesma varredura do painel, e pela mesma razão: rota sem declaração é
     * recusada em tempo de execução, mas descobrir isso em produção é caro. Um
     * `@Get` novo sem `@Escopo` fica vermelho aqui.
     */
    const controllers = readdirSync(RAIZ).filter((f) => f.endsWith('.controller.ts'));
    expect(controllers.length).toBeGreaterThan(0);

    for (const arquivo of controllers) {
      const texto = readFileSync(join(RAIZ, arquivo), 'utf8');
      const linhas = texto.split('\n');

      linhas.forEach((linha, i) => {
        const rota = /^\s*@(Get|Post|Put|Patch|Delete)\(/.exec(linha);
        if (!rota) return;

        // O `@Escopo` vem imediatamente antes, numa linha só — como o `@Exige`.
        const anterior = linhas[i - 1] ?? '';
        expect(
          anterior.includes('@Escopo('),
          `${arquivo}:${i + 1} — ${rota[1]} sem @Escopo na linha de cima`,
        ).toBe(true);
      });
    }
  });
});
