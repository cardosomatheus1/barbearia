import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Toda migração é aditiva — e é **isso** que faz o rollback existir.
 *
 * ## O que este teste protege, e não é o schema
 *
 * A pergunta do dia do deploy não é "como desfaço a migração". É: *a versão
 * anterior do aplicativo continua funcionando contra o banco novo?* Se sim, o
 * rollback é `docker run` da imagem anterior — trinta segundos, sem tocar em
 * dado. Se não, é restaurar backup, e aí toda venda entre o deploy e a volta
 * está perdida.
 *
 * As cinco formas abaixo são exatamente as que quebram a versão anterior:
 *
 * | O que | Por que quebra quem está no ar |
 * |---|---|
 * | `DROP TABLE` / `DROP COLUMN` | o `SELECT` da versão anterior deixa de existir, e o dado foi junto |
 * | `RENAME` | idem, sem nem a desculpa de ter apagado algo |
 * | `ALTER COLUMN ... TYPE` | o valor muda de forma debaixo de quem já o lê |
 * | `SET NOT NULL` | todo `INSERT` da versão anterior que omitia a coluna passa a falhar |
 *
 * `DROP CONSTRAINT` **não** está na lista, e é decisão: afrouxar uma regra não
 * quebra quem já obedecia a ela. Apertar quebraria — e é por isso que
 * `SET NOT NULL` está.
 *
 * ## Por que varredura, e não disciplina
 *
 * A convenção "migração é aditiva" está escrita no `CLAUDE.md` desde o começo e
 * foi cumprida em 82 arquivos. Escrita, ela vale enquanto alguém lembrar; aqui
 * ela passa a valer porque o portão cobra — e o custo de descobrir que não vale
 * é um deploy sem volta.
 */

const RAIZ = join(import.meta.dirname, '..', '..', '..');

const MIGRACOES = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'packages/db/migrations'], {
  encoding: 'utf8',
  cwd: RAIZ,
})
  .split('\n')
  .filter((caminho) => caminho.endsWith('.sql'));

/**
 * O que quebra a versão anterior, com o nome pelo qual se procura.
 *
 * `IF EXISTS` não isenta: apagar uma coluna que existe é o caso que importa, e
 * a variante com guarda é a mesma destruição escrita com mais cuidado.
 */
const DESTRUTIVAS = [
  ['DROP TABLE', /\bDROP\s+TABLE\b/i],
  ['DROP COLUMN', /\bDROP\s+COLUMN\b/i],
  ['RENAME', /\bRENAME\s+(TO|COLUMN)\b/i],
  ['ALTER COLUMN ... TYPE', /\bALTER\s+COLUMN\s+\w+\s+(SET\s+DATA\s+)?TYPE\b/i],
  ['SET NOT NULL', /\bSET\s+NOT\s+NULL\b/i],
];

/** Comentário não é instrução: a prosa explica o que **não** se faz. */
function semComentarios(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((linha) => !linha.trim().startsWith('--'))
    .join('\n');
}

describe('migração aditiva', () => {
  it('a varredura enxerga as 82 migrações', () => {
    // Uma varredura que não acha arquivo passa verde por não ter olhado, que é
    // o pior formato de guarda que existe.
    expect(MIGRACOES.length).toBeGreaterThan(70);
  });

  it('nenhuma migração quebra a versão anterior do aplicativo', () => {
    const achados = [];
    for (const caminho of MIGRACOES) {
      const sql = semComentarios(readFileSync(new URL(`../../../${caminho}`, import.meta.url), 'utf8'));
      for (const [nome, padrao] of DESTRUTIVAS) {
        if (padrao.test(sql)) achados.push(`${caminho} — ${nome}`);
      }
    }

    expect(
      achados,
      'migração destrutiva: a versão anterior do aplicativo para de funcionar contra o banco novo, ' +
        'e o rollback deixa de ser "sobe a imagem anterior" para virar "restaura backup e perde o que veio depois". ' +
        'Se for mesmo necessário, é operação de duas fases em dois deploys.',
    ).toEqual([]);
    /**
     * Gancho com folga, e não é tolerância a lentidão.
     *
     * Sozinha, a varredura das 83 migrações leva 200 ms. Dentro do `pnpm
     * verify` ela disputa disco com dez suítes em paralelo e passou de 17 s —
     * estourando os 5 s do padrão e reprovando o portão por um conteúdo que
     * está certo. É o mesmo caso de `env-example.test.mjs` e o mesmo conserto:
     * o que se mede aqui é o texto das migrações, nunca o relógio.
     */
  }, 60_000);

  it('a varredura acusa cada uma das formas destrutivas', () => {
    /**
     * Guarda que não fica vermelha não guarda nada, e este teste é barato
     * porque a varredura é uma função de texto.
     */
    const exemplos = [
      'ALTER TABLE orders DROP COLUMN total_cents;',
      'DROP TABLE customers;',
      'ALTER TABLE orders RENAME COLUMN total_cents TO total;',
      'ALTER TABLE orders ALTER COLUMN total_cents TYPE bigint;',
      'ALTER TABLE orders ALTER COLUMN customer_id SET NOT NULL;',
    ];
    for (const exemplo of exemplos) {
      const pegou = DESTRUTIVAS.some(([, padrao]) => padrao.test(semComentarios(exemplo)));
      expect(pegou, `passou batido: ${exemplo}`).toBe(true);
    }

    // E o que é aditivo continua passando — senão a guarda vira um "não mexa".
    const aditivas = [
      'ALTER TABLE orders ADD COLUMN fee_cents integer;',
      'ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_conhecida;',
      'CREATE INDEX orders_business_day ON orders (business_day);',
    ];
    for (const exemplo of aditivas) {
      const pegou = DESTRUTIVAS.some(([, padrao]) => padrao.test(semComentarios(exemplo)));
      expect(pegou, `acusou o que é aditivo: ${exemplo}`).toBe(false);
    }
  });
});
