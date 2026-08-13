import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { churnDaBase, churnDe } from './churn.js';

/**
 * Os sete sinais de churn contra Postgres real (bloco 62, SPEC §4.5).
 *
 * O que só o banco prova: que cada sinal sai da consulta que diz sair, que o
 * barbeiro habitual é o que mais atendeu e não o do último corte, e que o ticket
 * "de agora" e o "de antes" recortam as visitas certas.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '62626262-1111-1111-1111-111111111111';
const LOCAL = 'a6262626-0000-0000-0000-000000000001';
const JOAO = 'b6262626-0000-0000-0000-000000000001';
const RUAN = 'b6262626-0000-0000-0000-000000000002';

const AGORA = new Date('2026-11-01T12:00:00Z');
let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

const idDoCliente = (n: number) => `c6262626-0000-0000-0000-${String(n).padStart(12, '0')}`;

async function cliente(n: number, nome = `Cliente ${n}`): Promise<string> {
  const id = idDoCliente(n);
  await exec(`
    INSERT INTO customers (id, tenant_id, name, phone_e164)
    VALUES ('${id}', '${TENANT}', '${nome}', '+55719${String(20000000 + n).slice(-8)}')
  `);
  return id;
}

/**
 * Uma visita, com hora derivada do cliente para não se sobrepor à do vizinho.
 *
 * `appointments_no_overlap` recusa dois atendimentos sobrepostos na mesma
 * cadeira, e ela está certa — a semente é que precisa caber.
 */
async function visita(
  clienteN: number,
  diasAtras: number,
  opcoes: {
    profissional?: string;
    status?: string;
    precoCents?: number;
  } = {},
): Promise<void> {
  const { profissional = JOAO, status = 'completed', precoCents = 5000 } = opcoes;
  const quando = new Date(
    AGORA.getTime() - diasAtras * 86_400_000 - clienteN * 20 * 60_000,
  );
  const fim = new Date(quando.getTime() + 10 * 60_000);
  await exec(`
    INSERT INTO appointments
      (tenant_id, location_id, customer_id, professional_id, price_cents,
       starts_at, ends_at, service_starts_at, service_ends_at, status)
    VALUES ('${TENANT}', '${LOCAL}', '${idDoCliente(clienteN)}', '${profissional}', ${precoCents},
            '${quando.toISOString()}', '${fim.toISOString()}',
            '${quando.toISOString()}', '${fim.toISOString()}', '${status}')
  `);
}

/** Quatro visitas em ritmo constante, a última há `ultimaHaDias`. */
async function ritmo(
  clienteN: number,
  cadaDias: number,
  ultimaHaDias: number,
  opcoes: { profissional?: string; precoCents?: number } = {},
): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await visita(clienteN, ultimaHaDias + i * cadaDias, opcoes);
  }
}

describeIfDb('o risco de abandono', () => {
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
      VALUES ('${LOCAL}', '${TENANT}', 'Matriz', 'America/Bahia');
      INSERT INTO professionals (id, tenant_id, location_id, name) VALUES
        ('${JOAO}', '${TENANT}', '${LOCAL}', 'João'),
        ('${RUAN}', '${TENANT}', '${LOCAL}', 'Ruan');
    `);
  });

  it('quem passou do ritmo aparece com o motivo escrito', async () => {
    /**
     * A frase da SPEC contra o banco: *"normalmente retorna a cada 21 dias ·
     * está há 45 dias sem retornar"*. O dono precisa poder repetir isso ao
     * cliente, e por isso ela sai do domínio já pronta.
     */
    await cliente(1, 'Carlos Souza');
    await ritmo(1, 21, 45);

    const dele = await churnDe(TENANT, idDoCliente(1), AGORA);
    expect(dele?.risco).toBeGreaterThan(50);
    const frase = dele?.motivos.find((m) => m.sinal === 'atraso_no_ciclo')?.frase ?? '';
    expect(frase).toContain('21 dias');
    expect(frase).toContain('45 dias');
  });

  it('quem tem horário marcado não recebe o sinal de "sem próximo"', async () => {
    await cliente(2);
    await ritmo(2, 21, 5);
    // Um horário no futuro, ainda pendente.
    await visita(2, -7, { status: 'pending' });

    const dele = await churnDe(TENANT, idDoCliente(2), AGORA);
    expect(dele?.motivos.find((m) => m.sinal === 'sem_proximo')).toBeUndefined();

    // E o vizinho sem nada marcado recebe.
    await cliente(3);
    await ritmo(3, 21, 5);
    const outro = await churnDe(TENANT, idDoCliente(3), AGORA);
    expect(outro?.motivos.find((m) => m.sinal === 'sem_proximo')).toBeDefined();
  });

  it('horário pendente que já passou não conta como "tem próximo"', async () => {
    /**
     * É o caso que o `> agora` da consulta existe para pegar, e sem ele nada
     * ficava vermelho: uma marcação de três semanas atrás que ninguém fechou
     * continua `pending` no banco para sempre.
     *
     * Ela não é um horário marcado — é um esquecimento do balcão —, e contá-la
     * faria o produto dizer "tem próximo" sobre quem não vai voltar. O sinal
     * sumiria exatamente de quem mais precisa dele.
     */
    await cliente(17);
    await ritmo(17, 21, 45);
    await visita(17, 20, { status: 'pending' });

    const dele = await churnDe(TENANT, idDoCliente(17), AGORA);
    expect(dele?.motivos.find((m) => m.sinal === 'sem_proximo')).toBeDefined();
  });

  it('o barbeiro habitual é o que mais atendeu, não o do último corte', async () => {
    /**
     * Quem foi atendido três vezes por João e uma por Ruan tem João como
     * barbeiro de sempre, mesmo que a última tenha sido com Ruan. É a diferença
     * entre um sinal e uma coincidência — e é ela que decide se a saída de
     * alguém da equipe entra na explicação.
     */
    await cliente(4);
    await visita(4, 80, { profissional: JOAO });
    await visita(4, 60, { profissional: JOAO });
    await visita(4, 40, { profissional: JOAO });
    await visita(4, 20, { profissional: RUAN });
    await exec(`UPDATE professionals SET active = false WHERE id = '${JOAO}'`);

    const dele = await churnDe(TENANT, idDoCliente(4), AGORA);
    const motivo = dele?.motivos.find((m) => m.sinal === 'barbeiro_saiu');
    expect(motivo?.frase).toContain('João');
  });

  it('barbeiro que continua na equipe não vira sinal', async () => {
    await cliente(5);
    await ritmo(5, 21, 45);
    const dele = await churnDe(TENANT, idDoCliente(5), AGORA);
    expect(dele?.motivos.find((m) => m.sinal === 'barbeiro_saiu')).toBeUndefined();
  });

  it('a falta no último horário conta, e a de meses atrás não', async () => {
    // O sinal da SPEC é "cancelamento recente". Uma falta de um ano atrás,
    // seguida de quatro cortes, não diz nada sobre a volta desta pessoa.
    await cliente(6);
    await ritmo(6, 21, 45);
    await visita(6, 300, { status: 'no_show' });
    const antigo = await churnDe(TENANT, idDoCliente(6), AGORA);
    expect(antigo?.motivos.find((m) => m.sinal === 'cancelou')).toBeUndefined();

    await cliente(7);
    await ritmo(7, 21, 45);
    await visita(7, 3, { status: 'no_show' });
    const recente = await churnDe(TENANT, idDoCliente(7), AGORA);
    expect(recente?.motivos.find((m) => m.sinal === 'cancelou')).toBeDefined();
  });

  it('a nota baixa mais recente entra na explicação', async () => {
    await cliente(8);
    await ritmo(8, 21, 10);
    await exec(`
      INSERT INTO reviews (tenant_id, customer_id, professional_id, rating, created_at)
      VALUES ('${TENANT}', '${idDoCliente(8)}', '${JOAO}', 5, now() - interval '90 days');
      INSERT INTO reviews (tenant_id, customer_id, professional_id, rating, created_at)
      VALUES ('${TENANT}', '${idDoCliente(8)}', '${JOAO}', 2, now() - interval '5 days')
    `);

    const dele = await churnDe(TENANT, idDoCliente(8), AGORA);
    expect(dele?.motivos.find((m) => m.sinal === 'nota_baixa')?.frase).toContain('nota 2');
  });

  it('o ticket de agora é comparado com o de antes, não com o de sempre', async () => {
    /**
     * Três visitas recentes contra as anteriores. Somar tudo numa média só
     * esconderia justamente a queda, que é o sinal — e é ela que diz que a
     * pessoa passou a levar só o corte.
     */
    await cliente(9);
    for (let i = 0; i < 3; i += 1) await visita(9, 120 + i * 21, { precoCents: 10000 });
    for (let i = 0; i < 3; i += 1) await visita(9, 10 + i * 21, { precoCents: 4000 });

    const dele = await churnDe(TENANT, idDoCliente(9), AGORA);
    expect(dele?.motivos.find((m) => m.sinal === 'ticket_caindo')?.frase).toContain('60%');
  });

  it('assinatura ativa desconta o risco de quem sumiu', async () => {
    await cliente(10);
    await ritmo(10, 21, 45);
    await cliente(11);
    await ritmo(11, 21, 45);
    await exec(`
      INSERT INTO club_plans (id, tenant_id, name, price_cents)
      VALUES ('d6262626-0000-0000-0000-000000000001', '${TENANT}', 'Premium', 14900);
      INSERT INTO club_subscriptions (tenant_id, customer_id, plan_id, status, price_cents, started_at)
      VALUES ('${TENANT}', '${idDoCliente(11)}', 'd6262626-0000-0000-0000-000000000001',
              'ativa', 14900, now() - interval '40 days')
    `);

    const solto = await churnDe(TENANT, idDoCliente(10), AGORA);
    const assinante = await churnDe(TENANT, idDoCliente(11), AGORA);
    expect(assinante?.risco).toBeLessThan(solto?.risco ?? 0);
    // E continua na lista: é dele que a casa mais precisa saber.
    expect(assinante?.risco).toBeGreaterThan(0);
  });

  it('quem não tem ritmo fica de fora da lista, em vez de entrar com risco zero', async () => {
    /**
     * "Risco 0" sobre quem veio uma vez é uma afirmação que o produto não tem
     * como fazer. Numa lista ordenada por risco ele desce para o fim como se
     * fosse boa notícia, e o dono lê a lista inteira concluindo que a base está
     * saudável — quando metade dela é gente sobre a qual não se sabe nada.
     */
    await cliente(12);
    await visita(12, 30);

    const todos = await churnDaBase(TENANT, AGORA);
    expect(todos.find((c) => c.customerId === idDoCliente(12))).toBeUndefined();
  });

  it('a lista vem do maior risco para o menor', async () => {
    await cliente(13);
    await ritmo(13, 21, 5); // no ritmo
    await cliente(14);
    await ritmo(14, 21, 40); // atrasado

    const todos = await churnDaBase(TENANT, AGORA);
    const riscos = todos.map((c) => c.risco);
    expect(riscos).toEqual([...riscos].sort((a, b) => b - a));
    expect(todos[0]?.customerId).toBe(idDoCliente(14));
  });

  it('nenhum valor em reais sai na resposta', async () => {
    /**
     * O ticket é lido para decidir se caiu, e o que sai é a porcentagem. Os
     * centavos são `finance.view`: devolvê-los aqui seria o faturamento por
     * cliente saindo de uma rota de retenção, que é o defeito que a revisão do
     * bloco 54 achou na rota da nota fiscal.
     */
    await cliente(15);
    for (let i = 0; i < 3; i += 1) await visita(15, 120 + i * 21, { precoCents: 12345 });
    for (let i = 0; i < 3; i += 1) await visita(15, 10 + i * 21, { precoCents: 4000 });

    const dele = await churnDe(TENANT, idDoCliente(15), AGORA);
    expect(JSON.stringify(dele)).not.toContain('12345');
    expect(Object.keys(dele ?? {}).some((k) => k.toLowerCase().includes('cents'))).toBe(false);
  });

  it('a barbearia vizinha não entra na conta', async () => {
    await cliente(16);
    await ritmo(16, 21, 45);
    const daVizinha = await churnDaBase('62626262-9999-9999-9999-999999999999', AGORA);
    expect(daVizinha).toHaveLength(0);
  });
});
