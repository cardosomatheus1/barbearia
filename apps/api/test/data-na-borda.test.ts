import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diaISO } from '../src/common/data.js';

/**
 * Uma validação de data para a API inteira (bloco 105).
 *
 * ## O defeito que esta guarda impede
 *
 * `/^\d{4}-\d{2}-\d{2}$/` estava escrito à mão em dezenove schemas. A forma não
 * é o conteúdo: todos os dezenove aceitavam `2026-02-31`, e o caminho que grava
 * agendamento respondia **500** — `parseDate` lançava `RangeError` lá dentro e
 * nenhum controller daquele caminho o traduzia.
 *
 * Seria fácil consertar só o caminho que o relatório encontrou. A cópia número
 * vinte nasceria com o mesmo defeito, e nada ficaria vermelho — é a história de
 * `secoes.ts`, dos rótulos de campanha e do estado que ocupa uma venda.
 *
 * ## O que ela **não** vê
 *
 * Ela lê texto e procura o padrão. Uma data validada de outra forma — um regex
 * escrito diferente, um `split('-')` na mão — passa por ela. O limite fica
 * escrito aqui: guarda em que se confia mais do que ela alcança é pior que
 * guarda nenhuma.
 */

const RAIZ = join(process.cwd(), 'src');

function fontes(pasta: string): string[] {
  const achados: string[] = [];
  for (const nome of readdirSync(pasta)) {
    const caminho = join(pasta, nome);
    if (statSync(caminho).isDirectory()) achados.push(...fontes(caminho));
    else if (caminho.endsWith('.ts')) achados.push(caminho);
  }
  return achados;
}

/** Onde a validação mora. É o único arquivo que pode escrever o padrão. */
const CASA = join(RAIZ, 'common', 'data.ts');

describe('a data na borda da API', () => {
  it('a varredura encontra os arquivos que deveria vigiar', () => {
    expect(fontes(RAIZ).length).toBeGreaterThan(50);
  });

  it('nenhum schema escreve o próprio formato de data', () => {
    const culpados = fontes(RAIZ)
      .filter((caminho) => caminho !== CASA)
      .filter((caminho) => /\\d\{4\}-\\d\{2\}-\\d\{2\}/.test(readFileSync(caminho, 'utf8')))
      .map((caminho) => caminho.slice(process.cwd().length + 1));

    expect(culpados, 'um formato próprio aceita 2026-02-31 e vira 500').toEqual([]);
  });

  // -- o que a validação de fato recusa --------------------------------------

  it('aceita um dia que existe', () => {
    for (const dia of ['2026-08-19', '2024-02-29', '1900-01-01', '2100-12-31']) {
      expect(diaISO.safeParse(dia).success, dia).toBe(true);
    }
  });

  it('recusa dia que passa no formato e não existe no calendário', () => {
    /**
     * Os cinco chegavam a `parseDate` e voltavam como `RangeError` — 500 no
     * `POST /v1/b/:slug/appointments`, sem sessão, com uma requisição só.
     */
    for (const dia of ['2026-02-31', '2026-13-01', '2026-00-15', '2026-01-32', '0000-00-00']) {
      expect(diaISO.safeParse(dia).success, dia).toBe(false);
    }
  });

  it('recusa data fora do que o sistema representa', () => {
    /**
     * `9999-12-31` era 500 no `GET /availability`: o fim de janela soma um dia,
     * o ano vira 10000, e `Date` serializa como `+010000-01-01` — formato que o
     * Prisma recusa em parâmetro cru. Não é `RangeError`, então nem o `catch` do
     * controller de disponibilidade alcançava.
     */
    for (const dia of ['9999-12-31', '1899-12-31', '2101-01-01']) {
      expect(diaISO.safeParse(dia).success, dia).toBe(false);
    }
  });
});
