import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  agendasApertadas,
  apagarFaixaDePreco,
  criarFaixaDePreco,
  faixasDaUnidade,
} from './ocupacao.js';

/**
 * A leitura de agenda apertada contra Postgres real (bloco 67, SPEC §4.19).
 *
 * > *"João está com 97% de ocupação há 6 semanas e recusou 14 pedidos de
 * > horário."*
 *
 * O que só o banco prova: que o denominador é a **jornada cadastrada** com as
 * pausas descontadas — e não "horas × dias", que erra em toda barbearia que
 * fecha na segunda —, que "recusou um pedido" é a lista de espera com
 * preferência por aquela cadeira, e que a cadeira sem grade devolve zero em vez
 * de infinito.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '67676767-1111-1111-1111-111111111111';
const VIZINHA = '67676767-2222-2222-2222-222222222222';
const LOCAL = '67aaaaaa-0000-0000-0000-000000000001';
const LOCAL_VIZINHA = '67aaaaaa-0000-0000-0000-000000000002';
const JOAO = '67bbbbbb-0000-0000-0000-000000000001';
const RUAN = '67bbbbbb-0000-0000-0000-000000000002';
const CLIENTE = '67cccccc-0000-0000-0000-000000000001';
const DONO = '67eeeeee-0000-0000-0000-000000000001';

const AGORA = new Date('2026-08-12T12:00:00Z');

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

/**
 * Uma jornada de oito horas com uma hora de almoço, em todos os dias da semana.
 *
 * Oito semanas × sete dias × 420 minutos úteis = 23.520 minutos de capacidade,
 * que é o denominador que os testes abaixo conferem.
 */
function jornada(profissional: string, comPausa: boolean): string {
  const pausa = comPausa ? `'[{"start":720,"end":780}]'::jsonb` : `'[]'::jsonb`;
  return [0, 1, 2, 3, 4, 5, 6]
    .map(
      (d) => `INSERT INTO work_schedules (tenant_id, professional_id, weekday,
                                          start_minute, end_minute, breaks)
               VALUES ('${TENANT}', '${profissional}', ${d}, 480, 960, ${pausa})`,
    )
    .join(';');
}

/** Um atendimento de `minutos` a `diasAtras` dias, na cadeira pedida. */
function atendimento(id: string, profissional: string, diasAtras: number, minutos: number): string {
  const comeca = new Date(AGORA.getTime() - diasAtras * 86_400_000);
  const termina = new Date(comeca.getTime() + minutos * 60_000);
  return `INSERT INTO appointments
            (id, tenant_id, location_id, customer_id, professional_id,
             starts_at, ends_at, service_starts_at, service_ends_at, status)
          VALUES ('${id}', '${TENANT}', '${LOCAL}', '${CLIENTE}', '${profissional}',
                  '${comeca.toISOString()}', '${termina.toISOString()}',
                  '${comeca.toISOString()}', '${termina.toISOString()}', 'completed')`;
}

/** Alguém que não achou horário e entrou na lista de espera. */
function espera(profissional: string | null, diasAtras: number): string {
  const quando = new Date(AGORA.getTime() - diasAtras * 86_400_000);
  const dia = quando.toISOString().slice(0, 10);
  return `INSERT INTO waitlist_entries
            (tenant_id, location_id, customer_id, professional_id,
             wanted_from, wanted_to, window_start_minute, window_end_minute,
             duration_minutes, joined_at)
          VALUES ('${TENANT}', '${LOCAL}', '${CLIENTE}',
                  ${profissional ? `'${profissional}'` : 'NULL'},
                  '${dia}', '${dia}', 480, 1200, 30, '${quando.toISOString()}')`;
}

const ler = (corteBps = 7500) =>
  agendasApertadas({ tenantId: TENANT, locationId: LOCAL, agora: AGORA, corteBps });

const idDe = (n: number) => `67dddddd-0000-0000-0000-${String(n).padStart(12, '0')}`;

describeIfDb('a agenda que não está dando conta', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await exec(`
      TRUNCATE tenants CASCADE;

      INSERT INTO tenants (id, name) VALUES
        ('${TENANT}', 'Domari'), ('${VIZINHA}', 'Vizinha');

      INSERT INTO locations (id, tenant_id, name, timezone) VALUES
        ('${LOCAL}', '${TENANT}', 'Centro', 'America/Bahia'),
        ('${LOCAL_VIZINHA}', '${VIZINHA}', 'Outra', 'America/Bahia');

      INSERT INTO professionals (id, tenant_id, location_id, name) VALUES
        ('${JOAO}', '${TENANT}', '${LOCAL}', 'João'),
        ('${RUAN}', '${TENANT}', '${LOCAL}', 'Ruan');

      INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
        ('${CLIENTE}', '${TENANT}', 'Carlos', '+5571988887777');

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${DONO}', '${TENANT}', 'Matheus', 'dono@domari.com.br', 'x', 'owner')
    `);
  });

  it('a pausa cadastrada sai do denominador', async () => {
    /**
     * Oito horas com uma hora de almoço são sete horas de capacidade. Sem
     * descontar a pausa, quem atende o dia inteiro apareceria com 87% em vez de
     * 100% — e nunca cruzaria o corte que decide o insight.
     *
     * A prova é comparar as duas cadeiras com **o mesmo** volume vendido: só a
     * pausa as separa.
     */
    await exec([jornada(JOAO, true), jornada(RUAN, false)].join(';'));
    const vendas = [];
    for (let i = 1; i <= 40; i += 1) {
      vendas.push(atendimento(idDe(i), JOAO, i, 480));
      vendas.push(atendimento(idDe(100 + i), RUAN, i, 480));
    }
    await exec(vendas.join(';'));

    const agendas = await ler(0);
    const joao = agendas.find((a) => a.nome === 'João');
    const ruan = agendas.find((a) => a.nome === 'Ruan');
    expect(joao?.ocupacaoBps).toBeGreaterThan(ruan?.ocupacaoBps ?? 0);
  });

  it('só entra quem passou do corte', async () => {
    // Ocupação alta é o que define "apertada"; devolver a equipe inteira faria o
    // corte virar responsabilidade de quem chama, em cada chamador.
    await exec([jornada(JOAO, false), jornada(RUAN, false)].join(';'));
    const vendas = [];
    for (let i = 1; i <= 50; i += 1) vendas.push(atendimento(idDe(i), JOAO, i, 480));
    await exec(vendas.join(';'));

    const nomes = (await ler(7500)).map((a) => a.nome);
    expect(nomes).toContain('João');
    expect(nomes).not.toContain('Ruan');
  });

  it('pedido sem preferência não conta para ninguém', async () => {
    /**
     * *"Recusou 14 pedidos"* é uma frase sobre uma cadeira. Quem pediu "qualquer
     * barbeiro" não estava sendo recusado por João — contá-lo somaria o mesmo
     * pedido a todo mundo e inflaria o impacto que ordena o painel.
     */
    await exec(jornada(JOAO, false));
    await exec(
      [espera(JOAO, 3), espera(JOAO, 5), espera(null, 7), espera(null, 9)].join(';'),
    );

    const agendas = await ler(0);
    expect(agendas.find((a) => a.nome === 'João')?.pedidosSemVaga).toBe(2);
    /**
     * E **zero** para quem não foi pedido.
     *
     * A asserção sobre João sozinha passava com e sem o filtro: o `GROUP BY`
     * já joga a preferência nula num grupo que não casa com profissional
     * nenhum. O que o teste precisa impedir é o espalhamento — o mesmo pedido
     * somado a toda a equipe, inflando o impacto que ordena o painel.
     */
    expect(agendas.find((a) => a.nome === 'Ruan')?.pedidosSemVaga).toBe(0);
  });

  it('pedido de antes da janela não conta', async () => {
    // A janela é a mesma do heatmap: dois lugares do produto dizendo "a agenda
    // de João está cheia" sobre janelas diferentes é a mesma pergunta com duas
    // respostas.
    await exec(jornada(JOAO, false));
    await exec([espera(JOAO, 3), espera(JOAO, 90)].join(';'));

    const [joao] = await ler(0);
    expect(joao?.pedidosSemVaga).toBe(1);
  });

  it('cadeira sem jornada cadastrada devolve zero, nunca infinito', async () => {
    /**
     * A cadeira recém-contratada tem denominador zero. "Ocupação de ∞%"
     * apareceria justamente no dia em que o dono contrata alguém, que é quando
     * ele abre o painel.
     */
    await exec(atendimento(idDe(1), JOAO, 2, 480));
    const agendas = await ler(0);
    expect(agendas.find((a) => a.nome === 'João')?.ocupacaoBps).toBe(0);
  });

  // -- faixas de preço entre lojas (bloco 68) --------------------------------

  const OUTRA_LOJA = '67aaaaaa-0000-0000-0000-000000000003';

  it('o gerente de uma loja não apaga a faixa da outra', async () => {
    /**
     * O ataque, executado. A RLS separa barbearias e **não** separa lojas dentro
     * de uma: sem o filtro por `location_id` no domínio, um `DELETE` com o id
     * alheio derruba o preço da matriz — a mesma falha que a revisão do bloco 58
     * achou no estoque, e que a deste bloco achou aqui.
     *
     * O id ser UUID não conserta: `staff_locations` vazio significa "todas", e
     * todo gerente enxerga os ids de todas as lojas até alguém escopá-lo.
     */
    await exec(`
      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('${OUTRA_LOJA}', '${TENANT}', 'Filial', 'America/Bahia')
    `);
    await criarFaixaDePreco({
      tenantId: TENANT,
      locationId: LOCAL,
      staffUserId: DONO,
      diaDaSemana: 2,
      inicioMinuto: 780,
      fimMinuto: 960,
      deltaBps: -1000,
    });
    const [daMatriz] = (await faixasDaUnidade(TENANT, LOCAL)).faixas;

    // O gerente da filial manda o id da matriz.
    expect(await apagarFaixaDePreco(TENANT, OUTRA_LOJA, daMatriz!.id)).toBe(false);
    expect((await faixasDaUnidade(TENANT, LOCAL)).faixas).toHaveLength(1);

    // E na própria loja ele apaga.
    expect(await apagarFaixaDePreco(TENANT, LOCAL, daMatriz!.id)).toBe(true);
  });

  it('faixa que encosta noutra é recusada sem derrubar a transação', async () => {
    /**
     * A violação de exclusão **não** é tratada com `catch` dentro da transação:
     * no Postgres ela aborta e toda instrução seguinte é recusada. A condição vai
     * na própria instrução, e o índice fica como última linha de defesa.
     */
    const nova = (inicio: number, fim: number) =>
      criarFaixaDePreco({
        tenantId: TENANT,
        locationId: LOCAL,
        staffUserId: DONO,
        diaDaSemana: 2,
        inicioMinuto: inicio,
        fimMinuto: fim,
        deltaBps: -1000,
      });

    expect(await nova(780, 960)).toBe(true);
    expect(await nova(900, 1020)).toBe(false);
    // Encostar não é sobrepor: `[início, fim)`.
    expect(await nova(960, 1080)).toBe(true);
  });

  it('a barbearia vizinha não entra na conta desta', async () => {
    await exec(jornada(JOAO, false));
    const agendas = await ler(0);
    expect(agendas.map((a) => a.nome).sort()).toEqual(['João', 'Ruan']);
  });
});
