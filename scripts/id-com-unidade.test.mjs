import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Função que **recebe** `locationId` e lê por id sem usá-lo.
 *
 * A RLS separa barbearias e não separa lojas dentro de uma. Oito defeitos da
 * varredura de multiunidade eram a mesma linha: `WHERE id = $1` numa tabela que
 * tem `location_id`, dentro de uma função que já tinha a loja na mão. O pior
 * deles fechava a comanda da matriz com o dinheiro caindo na gaveta da filial.
 *
 * ## O corte: entrada declarada, e a leitura que barra
 *
 * `locationId` precisa ser **parâmetro** da função, não coluna lida da linha.
 * Essa distinção é a que separa o legítimo do defeituoso: `cancelAppointment` e
 * `applyAttendance` *derivam* a unidade do agendamento e por isso não podem
 * filtrar por ela; `fecharComanda` a recebia e escolhia não usar.
 *
 * E só a consulta que **barra** conta — a que é seguida de um `throw` ou de uma
 * recusa. `UPDATE` por id depois de a leitura ter conferido a loja é o padrão
 * certo, e acusá-lo produziria falso positivo em todo caminho bem escrito.
 *
 * A isenção é conquistada: cite `location_id` na consulta e o teste sai do
 * caminho. Uma lista de arquivos isentos seria a lista que ninguém revisa — e é
 * a classe de defeito que este repositório já nomeou duas vezes.
 */

const RAIZ = new URL('..', import.meta.url).pathname;

/**
 * As tabelas que têm `location_id`, **derivadas das migrações**.
 *
 * A primeira versão trazia onze escritas à mão, e a revisão de segurança contou
 * as que faltavam: `commission_closures` — que este mesmo bloco acabou de dotar
 * da coluna —, `financial_accounts`, `bills`, `cash_movements`,
 * `stock_transfers`, `club_subscriptions`. Era a lista escrita ao lado que a
 * docstring acima diz não querer, dentro da guarda que existe para eliminá-la.
 *
 * O SQL é a fonte da verdade do schema neste projeto, então a pergunta vai a
 * ele: tabela que ganha `location_id` numa migração nova nasce vigiada.
 */
function tabelasComUnidade() {
  const migracoes = execFileSync('git', ['ls-files', 'packages/db/migrations'], {
    cwd: RAIZ,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f.endsWith('.sql'));

  const achadas = new Set();
  for (const arquivo of migracoes) {
    const sql = readFileSync(new URL(`../${arquivo}`, import.meta.url), 'utf8');

    // `CREATE TABLE x (... location_id ...)`
    for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(([\s\S]*?)\n\);/gi)) {
      if (/\blocation_id\b/i.test(m[2])) achadas.add(m[1].toLowerCase());
    }
    // `ALTER TABLE x ADD COLUMN [IF NOT EXISTS] location_id`
    for (const m of sql.matchAll(
      /ALTER TABLE (\w+)[\s\S]{0,80}?ADD COLUMN (?:IF NOT EXISTS )?location_id\b/gi,
    )) {
      achadas.add(m[1].toLowerCase());
    }
  }
  return achadas;
}

const COM_UNIDADE = tabelasComUnidade();

function fontes() {
  return execFileSync('git', ['ls-files', 'packages', 'apps'], {
    cwd: RAIZ,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => !f.includes('/dist/'))
    .filter((f) => !f.includes('.test.') && !f.includes('.integration.'));
}

/**
 * Recorta cada função exportada com o próprio corpo.
 *
 * Ancorar em `export async function` e ir até a próxima declaração de topo é
 * grosseiro e suficiente: o que se quer saber é se **aquela** função declara
 * `locationId` e faz uma leitura que barra sem citar a coluna.
 */
function funcoes(texto) {
  const achadas = [];
  const re = /^(?:export )?(?:async )?function (\w+)\(/gm;
  let m;
  while ((m = re.exec(texto)) !== null) {
    const inicio = m.index;
    // Até a próxima declaração de topo, exportada ou não: `carregar` mora
    // antes do primeiro `export` de `comanda.ts` e ficava fora de toda fatia —
    // justamente a função cujo `WHERE id = $1` motivou esta guarda.
    const seguinte = texto.slice(inicio + 1).search(/\n(?:export )?(?:async )?function /);
    achadas.push({
      nome: m[1],
      corpo: texto.slice(inicio, seguinte === -1 ? texto.length : inicio + 1 + seguinte),
      linha: texto.slice(0, inicio).split('\n').length,
    });
  }
  return achadas;
}

/**
 * A função recebe a loja como entrada declarada?
 *
 * Nomeada (`readonly locationId: string`) **ou** posicional
 * (`locationId: string`) — `estoque.ts` é escrito da segunda forma, e a primeira
 * versão desta guarda não via nenhuma das suas quatro funções.
 */
const recebeUnidade = (corpo) =>
  /(?:readonly )?locationId[?]?:\s*string/.test(corpo.slice(0, corpo.indexOf('{', corpo.indexOf('('))+2000));

/**
 * As tabelas que **já foram lidas com a loja** antes, nesta mesma função.
 *
 * Depois que a leitura de entrada conferiu a unidade, o `UPDATE` por id e a
 * subconsulta que relê a mesma linha são o padrão certo — acusá-los produziria
 * falso positivo em todo caminho bem escrito. `seatQueueEntry` é o exemplo: ela
 * filtra `q.location_id` na trava de entrada e relê `joined_at` por id lá
 * embaixo.
 */
function jaConferidas(corpo) {
  const conferidas = new Set();
  for (const m of corpo.matchAll(/`([^`]*)`/gs)) {
    const sql = m[1];
    const onde = sql.search(/\bWHERE\b/i);
    if (onde === -1) continue;
    if (!/location_id\s*=/i.test(sql.slice(onde))) continue;
    // Todas as tabelas da consulta, não a primeira: a subconsulta de serviços
    // aparece antes de `FROM queue_entries` e roubava a atribuição.
    for (const t of sql.matchAll(/\b(?:FROM|UPDATE|JOIN)\s+(\w+)/gi)) {
      conferidas.add(t[1].toLowerCase());
    }
  }
  return conferidas;
}

/** As consultas por id que barram, sem citar a coluna da loja. */
function leiturasQueBarram(corpo) {
  const conferidas = jaConferidas(corpo);
  const achadas = [];
  /**
   * O template **inteiro**, e não um recorte preguiçoso.
   *
   * A primeira versão parava no primeiro `id = ${`, então o `AND p.location_id`
   * que vinha depois ficava fora da string conferida — a guarda acusava a
   * própria consulta que o conserto tinha escrito.
   */
  const re = /`([^`]*)`/gs;
  let m;
  while ((m = re.exec(corpo)) !== null) {
    const sql = m[1];
    if (!/\bWHERE\b/i.test(sql)) continue;
    if (!/\bid\s*=\s*\$\{/.test(sql)) continue;

    /**
     * Só **leitura**. O `UPDATE ... WHERE id = $1` que vem depois de a leitura
     * ter conferido a loja é o padrão certo, e acusá-lo reprovaria todo caminho
     * bem escrito — inclusive o que este bloco acabou de consertar.
     *
     * Quem decide é o `SELECT`; o `UPDATE` executa a decisão.
     */
    if (!/^\s*SELECT\b/i.test(sql.replace(/^[\s\n]*(--[^\n]*\n)*/, ''))) continue;

    // A tabela vigiada da consulta, e não a primeira que aparece: uma
    // subconsulta pode citar outra antes dela.
    const tabelas = [...sql.matchAll(/\b(?:FROM|UPDATE)\s+(\w+)/gi)].map((t) =>
      t[1].toLowerCase(),
    );
    const tabela = tabelas.find((t) => COM_UNIDADE.has(t));
    if (!tabela) continue;
    if (conferidas.has(tabela)) continue;
    /**
     * A isenção é a coluna **no `WHERE`**, não em qualquer lugar da consulta.
     *
     * Testando a string inteira, `SELECT status, location_id FROM x WHERE id = $1`
     * ficava isento sem filtrar nada — e era literalmente a forma do
     * `cancelarVale` antes do conserto.
     */
    const where = sql.slice(sql.search(/\bWHERE\b/i));
    if (/location_id/i.test(where)) continue;

    // Só conta a leitura que decide: um `throw` ou uma recusa logo depois.
    const depois = corpo.slice(m.index, m.index + 900);
    if (!/throw new |recusar\(/.test(depois)) continue;

    achadas.push(tabela);
  }
  return achadas;
}

function acusadas() {
  const fora = [];
  for (const arquivo of fontes()) {
    const texto = readFileSync(new URL(`../${arquivo}`, import.meta.url), 'utf8');
    for (const { nome, corpo, linha } of funcoes(texto)) {
      if (!recebeUnidade(corpo)) continue;
      for (const tabela of leiturasQueBarram(corpo)) {
        fora.push(`${arquivo}:${linha} ${nome} lê ${tabela} por id sem a loja`);
      }
    }
  }
  return fora;
}

describe('id conferido contra a unidade', () => {
  it('nenhuma função com locationId barra por id sem usar a loja', () => {
    expect(acusadas()).toEqual([]);
  });

  /**
   * A varredura consegue ficar vermelha?
   *
   * Guarda que não acha nada por engano — recorte errado, regex que não casa —
   * devolve verde sobre o defeito que ela existe para pegar. Já aconteceu aqui
   * com `update-de-unidade-com-where`, que passou verde sobre a própria linha
   * que a motivou.
   */
  it('acusa a leitura que barra sem a loja', () => {
    const corpo = `export async function fechar(params: {
      readonly tenantId: string;
      readonly locationId: string;
    }) {
      const linhas = await tx.$queryRaw\`
        SELECT id FROM orders WHERE id = \${params.orderId}::uuid
      \`;
      if (!linhas[0]) throw new ComandaError('x', 'y');
    }`;
    expect(recebeUnidade(corpo)).toBe(true);
    expect(leiturasQueBarram(corpo)).toEqual(['orders']);
  });

  it('não acusa quem já cita a loja', () => {
    const corpo = `export async function fechar(params: {
      readonly locationId: string;
    }) {
      const linhas = await tx.$queryRaw\`
        SELECT id FROM orders
         WHERE id = \${params.orderId}::uuid
           AND location_id = \${params.locationId}::uuid
      \`;
      if (!linhas[0]) throw new ComandaError('x', 'y');
    }`;
    expect(leiturasQueBarram(corpo)).toEqual([]);
  });

  it('não acusa quem deriva a loja da própria linha', () => {
    // Sem `locationId` na assinatura, a função não tem como filtrar — é o caso
    // de `cancelAppointment`, que descobre a unidade lendo o agendamento.
    const corpo = `export async function cancelar(params: {
      readonly tenantId: string;
      readonly appointmentId: string;
    }) {
      const linhas = await tx.$queryRaw\`
        SELECT location_id FROM appointments WHERE id = \${params.appointmentId}::uuid
      \`;
      if (!linhas[0]) throw new BookingError('x', 'y');
    }`;
    expect(recebeUnidade(corpo)).toBe(false);
  });
});
