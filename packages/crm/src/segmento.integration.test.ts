import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { contarPorSegmento, segmentoDe, segmentosDaBase } from './segmento.js';

/**
 * O ciclo individual e os sete segmentos, contra Postgres real (bloco 61).
 *
 * O que só o banco prova: que o ciclo sai do histórico de verdade, que falta e
 * cancelamento não contam como visita, e que as duas estatísticas da base saem
 * de quem tem o dado — não de todo mundo.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '61616161-1111-1111-1111-111111111111';
const LOCATION = 'a6161616-0000-0000-0000-000000000001';
const RUAN = 'b6161616-0000-0000-0000-000000000001';
const GLEIDSON = 'b6161616-0000-0000-0000-000000000002';

const AGORA = new Date('2026-11-01T12:00:00Z');
let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

const idDoCliente = (n: number) => `c6161616-0000-0000-0000-${String(n).padStart(12, '0')}`;

/** Um cliente com visitas a cada `cadaDias`, a última há `ultimaHaDias`. */
async function cliente(
  n: number,
  opcoes: {
    quantas: number;
    cadaDias: number;
    ultimaHaDias: number;
    status?: 'completed' | 'no_show' | 'cancelled_customer';
    profissional?: string;
  },
): Promise<string> {
  const id = idDoCliente(n);
  const { quantas, cadaDias, ultimaHaDias, status = 'completed', profissional = RUAN } = opcoes;
  await exec(`
    INSERT INTO customers (id, tenant_id, name, phone_e164)
    VALUES ('${id}', '${TENANT}', 'Cliente ${n}', '+55719${String(10000000 + n).slice(-8)}')
  `);
  for (let i = 0; i < quantas; i += 1) {
    const diasAtras = ultimaHaDias + i * cadaDias;
    /**
     * Cada cliente ocupa um minuto diferente da hora.
     *
     * `appointments_no_overlap` recusa dois atendimentos sobrepostos na mesma
     * cadeira, e ela está certa: doze clientes com o mesmo ritmo cairiam todos
     * no mesmo instante.
     *
     * O passo é **maior que a duração** — um minuto não bastava, porque o
     * atendimento dura mais que isso e os vizinhos continuavam se sobrepondo.
     * Quinze minutos sobre dez de atendimento separa trinta clientes dentro do
     * mesmo dia, que é o que o ciclo mede.
     *
     * E para **trás**: para a frente, a última visita fica alguns minutos mais
     * nova e o `floor` dos dias sem vir cai um.
     */
    const quando = new Date(AGORA.getTime() - diasAtras * 86_400_000 - n * 15 * 60_000);
    const fim = new Date(quando.getTime() + 10 * 60_000);
    await exec(`
      INSERT INTO appointments
        (tenant_id, location_id, customer_id, professional_id,
         starts_at, ends_at, service_starts_at, service_ends_at, status)
      VALUES ('${TENANT}', '${LOCATION}', '${id}', '${profissional}',
              '${quando.toISOString()}', '${fim.toISOString()}',
              '${quando.toISOString()}', '${fim.toISOString()}', '${status}')
    `);
  }
  return id;
}

/** Uma comanda paga, para o cliente aparecer no decil de gasto. */
async function gastou(clienteId: string, cents: number): Promise<void> {
  await exec(`
    INSERT INTO orders (tenant_id, location_id, customer_id, status,
                        subtotal_cents, total_cents, closed_at)
    VALUES ('${TENANT}', '${LOCATION}', '${clienteId}', 'paid',
            ${cents}, ${cents}, now())
  `);
}

describeIfDb('segmentação automática', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await exec(`
      INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Domari');
      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('${LOCATION}', '${TENANT}', 'Matriz', 'America/Bahia');
      INSERT INTO professionals (id, tenant_id, location_id, name) VALUES
        ('${RUAN}', '${TENANT}', '${LOCATION}', 'Ruan'),
        ('${GLEIDSON}', '${TENANT}', '${LOCATION}', 'Gleidson');
    `);
  });

  it('o ciclo sai do histórico, e quem está no ritmo é ativo', async () => {
    const id = await cliente(1, { quantas: 5, cadaDias: 14, ultimaHaDias: 5 });

    const dele = await segmentoDe(TENANT, id, AGORA);
    expect(dele?.ciclo?.medianaDias).toBe(14);
    expect(dele?.segmento).toBe('ativo');
    expect(dele?.diasSemVir).toBe(5);
  });

  it('quem corta a cada 45 dias não está em risco no dia 30, e quem corta a cada 15 está', async () => {
    /**
     * A frase da SPEC §4.4 contra o banco. Uma regra fixa de sessenta dias
     * erraria os dois: acharia o primeiro em dia e o segundo também.
     */
    const devagar = await cliente(2, { quantas: 5, cadaDias: 45, ultimaHaDias: 30 });
    /**
     * Vinte e oito dias, e não trinta.
     *
     * Com ciclo de quinze, trinta é **exatamente** o dobro, e o corte de
     * "perdido" é `> 2×` — o caso ficaria em cima da linha, e um deslocamento
     * de minutos na semente o empurraria de um lado para o outro. A fronteira
     * em si é do teste unitário de `core`; aqui o que se quer provar é que o
     * ritmo individual decide, e vinte e oito dias está claramente dentro da
     * faixa de risco de quem corta a cada quinze.
     */
    const rapido = await cliente(3, {
      quantas: 5,
      cadaDias: 15,
      ultimaHaDias: 28,
      profissional: GLEIDSON,
    });

    expect((await segmentoDe(TENANT, devagar, AGORA))?.segmento).toBe('ativo');
    expect((await segmentoDe(TENANT, rapido, AGORA))?.segmento).toBe('em_risco');
  });

  it('falta e cancelamento não são visita', async () => {
    /**
     * Incluí-los daria um ciclo curto a quem marca e não aparece: a pessoa que
     * mais falta seria a que o produto classificaria como mais frequente.
     */
    const faltante = await cliente(4, {
      quantas: 6,
      cadaDias: 7,
      ultimaHaDias: 2,
      status: 'no_show',
    });

    const dele = await segmentoDe(TENANT, faltante, AGORA);
    expect(dele?.ciclo).toBeNull();
    expect(dele?.ultimaVisita).toBeNull();
    expect(dele?.segmento).toBe('novo');
  });

  it('duas visitas ainda é novo: um intervalo não é um ritmo', async () => {
    const id = await cliente(5, { quantas: 2, cadaDias: 20, ultimaHaDias: 3 });
    const dele = await segmentoDe(TENANT, id, AGORA);
    expect(dele?.ciclo).toBeNull();
    expect(dele?.segmento).toBe('novo');
  });

  it('base pequena não elege frequente nem VIP', async () => {
    /**
     * Com poucos clientes a mediana é ruído e "volta mais rápido que a maioria"
     * vira uma frase sobre duas pessoas. Ninguém é frequente — que é o certo,
     * porque a comparação não existe.
     */
    await cliente(6, { quantas: 5, cadaDias: 7, ultimaHaDias: 2 });
    await cliente(7, { quantas: 5, cadaDias: 40, ultimaHaDias: 5, profissional: GLEIDSON });

    const todos = await segmentosDaBase(TENANT, AGORA);
    expect(todos.every((c) => c.segmento !== 'frequente' && c.segmento !== 'vip')).toBe(true);
  });

  it('com base suficiente, quem volta mais rápido que a mediana é frequente', async () => {
    // Doze clientes lentos e um rápido: o rápido fica abaixo da mediana.
    for (let n = 10; n < 22; n += 1) {
      await cliente(n, {
        quantas: 4,
        cadaDias: 30,
        ultimaHaDias: 5 + (n % 3),
        profissional: n % 2 === 0 ? RUAN : GLEIDSON,
      });
    }
    const rapido = await cliente(30, { quantas: 4, cadaDias: 7, ultimaHaDias: 2 });

    const todos = await segmentosDaBase(TENANT, AGORA);
    expect(todos.find((c) => c.customerId === rapido)?.segmento).toBe('frequente');
    expect(contarPorSegmento(todos).frequente).toBeGreaterThan(0);
  });

  it('a mediana da base sai de quem tem ciclo, não de quem veio uma vez', async () => {
    /**
     * Onze clientes lentos, um rápido e **doze** que vieram uma vez só.
     *
     * Quem veio uma vez não tem ciclo, e contá-lo como ciclo zero puxaria a
     * mediana da base para perto de zero — aí ninguém volta "mais rápido que a
     * maioria", nem quem corta toda semana numa base que corta todo mês. A
     * mediana de nada não é zero: é ausência.
     */
    for (let n = 60; n < 71; n += 1) {
      await cliente(n, { quantas: 4, cadaDias: 30, ultimaHaDias: 5 });
    }
    const rapido = await cliente(71, { quantas: 4, cadaDias: 7, ultimaHaDias: 2 });
    for (let n = 72; n < 84; n += 1) {
      await cliente(n, { quantas: 1, cadaDias: 30, ultimaHaDias: 4 });
    }

    const todos = await segmentosDaBase(TENANT, AGORA);
    expect(todos.find((c) => c.customerId === rapido)?.segmento).toBe('frequente');
  });

  it('cliente anonimizado sai da base', async () => {
    /**
     * Ele pediu para ser esquecido, e segmento existe para decidir quem recebe
     * campanha. Mantê-lo na conta faria a pessoa continuar sendo alvo — e a
     * linha continua no banco de propósito, porque a venda fica.
     */
    const id = await cliente(9, { quantas: 5, cadaDias: 14, ultimaHaDias: 5 });
    // O tenant entra pelo `FROM`: a função o exige no contexto, e uma segunda
    // instrução para abri-lo poderia cair noutra conexão do pool.
    await exec(`
      SELECT anonimizar_cliente('${id}'::uuid, 'pedido do titular')
        FROM (SELECT set_config('app.tenant_id', '${TENANT}', false)) ctx
    `);

    expect(await segmentoDe(TENANT, id, AGORA)).toBeNull();
  });

  it('o decil de gasto sai de quem gastou, não de quem nunca comprou', async () => {
    /**
     * Vinte clientes: dez compraram, dez nunca compraram — cadastro importado,
     * gente que só marcou e não apareceu.
     *
     * Sobre os dez que compraram, o decil superior é **uma** pessoa. Contando
     * os dez zeros, a base vira vinte e o corte desce para o segundo colocado:
     * quem gastou R$ 900 viraria VIP por causa de dez pessoas que não gastaram
     * nada. Zero não é um gasto baixo — é a ausência do dado.
     */
    for (let n = 40; n < 60; n += 1) {
      await cliente(n, { quantas: 4, cadaDias: 30, ultimaHaDias: 5 });
    }
    for (let n = 40; n < 50; n += 1) {
      await gastou(idDoCliente(n), 100_000 - (n - 40) * 10_000);
    }

    const todos = await segmentosDaBase(TENANT, AGORA);
    expect(todos.find((c) => c.customerId === idDoCliente(40))?.segmento).toBe('vip');
    expect(todos.find((c) => c.customerId === idDoCliente(41))?.segmento).not.toBe('vip');
  });

  it('a barbearia vizinha não entra na conta', async () => {
    await cliente(8, { quantas: 5, cadaDias: 14, ultimaHaDias: 5 });
    const daVizinha = await segmentosDaBase('61616161-9999-9999-9999-999999999999', AGORA);
    expect(daVizinha).toHaveLength(0);
  });
});
