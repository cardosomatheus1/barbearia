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

/** As tabelas que têm `location_id` e são lidas por id em caminho de escrita. */
const COM_UNIDADE = [
  'orders',
  'order_charges',
  'appointments',
  'queue_entries',
  'cash_sessions',
  'professional_advances',
  'stock_movements',
  'fiscal_invoices',
  'waitlist_entries',
  'pricing_rules',
  'resource_pools',
];

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
  const re = /export async function (\w+)\(/g;
  let m;
  while ((m = re.exec(texto)) !== null) {
    const inicio = m.index;
    const seguinte = texto.indexOf('\nexport ', inicio + 1);
    achadas.push({
      nome: m[1],
      corpo: texto.slice(inicio, seguinte === -1 ? texto.length : seguinte),
      linha: texto.slice(0, inicio).split('\n').length,
    });
  }
  return achadas;
}

/** A função recebe a loja como entrada declarada? */
const recebeUnidade = (corpo) => /readonly locationId[?]?:\s*string/.test(corpo);

/** As consultas por id que barram, sem citar a coluna da loja. */
function leiturasQueBarram(corpo) {
  const achadas = [];
  const re = /`([^`]*?\bFROM\s+(\w+)\b[^`]*?WHERE[^`]*?\bid\s*=\s*\$\{[^`]*?)`/gis;
  let m;
  while ((m = re.exec(corpo)) !== null) {
    const [, sql, tabela] = m;
    if (!COM_UNIDADE.includes(tabela)) continue;
    if (/location_id/i.test(sql)) continue;

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
