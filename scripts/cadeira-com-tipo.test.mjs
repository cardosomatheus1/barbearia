import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Consulta que usa `professionals` como **capacidade** filtra o tipo da cadeira.
 *
 * `professionals` guarda quatro coisas: quem atende (`professional`), o balcão
 * da recepção (`counter`), a sala ou o lavatório (`resource_only`) e quem
 * atende fora (`external`). Só o primeiro é cadeira para efeito de ocupação — e
 * é a ocupação que decide se o cliente paga sinal, se o preço sobe no sábado e
 * quais horas viram campanha de hora fria.
 *
 * Sete consultas do produto escreviam `AND p.kind = 'professional'` à mão e duas
 * esqueceram, as duas em `ocupacao.ts`. O defeito estava **inalcançável** até o
 * bloco 114: a borda recusava cadastrar `counter` e `resource_only` porque o
 * `z.enum` da tela não batia com o enum do banco. Consertar a borda tornou o
 * outro exploitável — que é a forma como este repositório costuma descobrir que
 * tinha dois defeitos, e não um.
 *
 * ## O corte: contagem escopada por unidade, ou jornada
 *
 * "Capacidade" não é uma palavra que apareça no SQL, então o teste pergunta pelo
 * formato. Contar linhas de `professionals` **daquela unidade** responde "quantas
 * cadeiras tem"; juntar `work_schedules` responde "quantos minutos elas abrem".
 * As duas são denominador, e as duas erram do mesmo jeito.
 *
 * Fica de fora quem **menciona** `kind` de qualquer forma: quem seleciona a
 * coluna decide em código (`validador.ts`), e quem filtra por um conjunto
 * diferente decidiu de propósito — `repository.ts` aceita `external`, porque
 * quem atende fora recebe reserva.
 *
 * Uma lista de arquivos isentos seria a lista que ninguém revisa. Aqui a isenção
 * é **conquistada**: cite `kind` e o teste sai do caminho.
 */

const RAIZ = new URL('..', import.meta.url).pathname;

function fontes() {
  const saida = execFileSync('git', ['ls-files', 'packages', 'apps'], {
    cwd: RAIZ,
    encoding: 'utf8',
  });
  return saida
    .split('\n')
    .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
    .filter((f) => !f.includes('/dist/'))
    .filter((f) => !f.includes('.test.') && !f.includes('.integration.'));
}

/** Cada template literal do arquivo que consulta `professionals`. */
function consultas(texto) {
  const achadas = [];
  const re = /`([^`]*\bFROM\s+professionals\b[^`]*)`/gis;
  let m;
  while ((m = re.exec(texto)) !== null) {
    achadas.push({ sql: m[1], linha: texto.slice(0, m.index).split('\n').length });
  }
  return achadas;
}

/** Esta consulta usa a tabela como denominador? */
function ehCapacidade(sql) {
  const contaCadeiras =
    /count\s*\([^)]*\)[\s\S]{0,300}?FROM\s+professionals/i.test(sql) &&
    /\blocation_id\b/i.test(sql);
  const somaJornada = /\bwork_schedules\b/i.test(sql);
  return contaCadeiras || somaJornada;
}

function acusadas() {
  const fora = [];
  for (const arquivo of fontes()) {
    const texto = readFileSync(new URL(`../${arquivo}`, import.meta.url), 'utf8');
    for (const { sql, linha } of consultas(texto)) {
      if (!ehCapacidade(sql)) continue;
      if (/\bkind\b/i.test(sql)) continue;
      fora.push(`${arquivo}:${linha}`);
    }
  }
  return fora;
}

describe('capacidade sai do tipo da cadeira', () => {
  it('nenhuma consulta conta o balcão e a sala como cadeira', () => {
    expect(acusadas()).toEqual([]);
  });

  /**
   * O teste consegue ficar vermelho?
   *
   * Uma varredura que não acha nada por engano — recorte errado, caminho errado,
   * regex que não casa — devolve verde sobre o defeito que ela existe para pegar.
   * Já aconteceu aqui: `update-de-unidade-com-where` passou verde sobre a própria
   * linha que motivou o teste, porque o `git ls-files` com `**` casava sete
   * arquivos de trezentos e setenta e três.
   */
  it('acusa a consulta de capacidade sem filtro de tipo', () => {
    const sql = `
      SELECT count(*)::int AS total FROM professionals
       WHERE location_id = $1::uuid AND active
    `;
    expect(ehCapacidade(sql)).toBe(true);
    expect(/\bkind\b/i.test(sql)).toBe(false);
  });

  it('não acusa quem decide o tipo em código', () => {
    const sql = `
      SELECT p.id, p.kind::text AS kind,
             (SELECT array_agg(ws.end_minute) FROM work_schedules ws
               WHERE ws.professional_id = p.id) AS minutos
        FROM professionals p WHERE p.active
    `;
    expect(ehCapacidade(sql)).toBe(true);
    expect(/\bkind\b/i.test(sql)).toBe(true);
  });
});
