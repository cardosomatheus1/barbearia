import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  atribuicoesDaBarbearia,
  atribuirDaBarbearia,
  contestarAtribuicao,
  emitirComissaoDoMarketplace,
} from './atribuicao.js';

/**
 * A comissão do marketplace contra Postgres real (bloco 72, SPEC §5.2).
 *
 * O que só o banco prova: que a promessa **negativa** é cumprida — cliente que
 * a barbearia já tinha nunca gera comissão —, que a origem do cliente é
 * congelada, que um cliente gera comissão uma vez só para sempre, e que emitir
 * a fatura duas vezes não cobra duas vezes.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const CASA = '72707070-1111-1111-1111-111111111111';
const LOCAL = '72aaaaaa-0000-0000-0000-000000000001';
const RUAN = '72bbbbbb-0000-0000-0000-000000000001';
const CORTE = '72eeeeee-0000-0000-0000-000000000001';

const NOVO = '72cccccc-0000-0000-0000-000000000001';
const DA_CASA = '72cccccc-0000-0000-0000-000000000002';
const IMPORTADO = '72cccccc-0000-0000-0000-000000000003';

/** 20/08/2026, quinta-feira. */
const AGORA = new Date('2026-08-20T16:00:00Z');

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

/** Um atendimento concluído, com a origem e as datas que o caso exige. */
async function atendimento(opcoes: {
  readonly id: string;
  readonly customerId: string;
  readonly source: string;
  readonly criadoEm: Date;
  readonly quando: Date;
}): Promise<void> {
  await exec(`
    INSERT INTO appointments
      (id, tenant_id, location_id, professional_id, customer_id, status, source,
       starts_at, ends_at, service_starts_at, service_ends_at, price_cents, created_at)
    VALUES
      ('${opcoes.id}', '${CASA}', '${LOCAL}', '${RUAN}', '${opcoes.customerId}',
       'completed', '${opcoes.source}',
       '${opcoes.quando.toISOString()}', '${new Date(opcoes.quando.getTime() + 30 * 60_000).toISOString()}',
       '${opcoes.quando.toISOString()}', '${new Date(opcoes.quando.getTime() + 30 * 60_000).toISOString()}',
       5500, '${opcoes.criadoEm.toISOString()}')
  `);
}

describeIfDb('a comissão do marketplace', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  }, 30_000);

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await exec(`
      INSERT INTO tenants (id, name, published_at)
      VALUES ('${CASA}', 'Barbearia do Bloco 72', now());

      INSERT INTO tenant_slugs (tenant_id, slug, is_primary)
      VALUES ('${CASA}', 'bloco-72', true);

      -- Vinte por cento sobre cliente novo, que é a referência da SPEC §5.2.
      UPDATE tenant_platform SET marketplace_fee_bps = 2000 WHERE tenant_id = '${CASA}';

      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('${LOCAL}', '${CASA}', 'Matriz', 'America/Bahia');

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes)
      VALUES ('${CORTE}', '${CASA}', 'Corte', 5500, 30);

      INSERT INTO professionals (id, tenant_id, location_id, name, kind)
      VALUES ('${RUAN}', '${CASA}', '${LOCAL}', 'Ruan', 'professional');

      INSERT INTO customers (id, tenant_id, name, phone_e164, created_at) VALUES
        ('${NOVO}', '${CASA}', 'Carlos Novo', '+5571988880001', '${AGORA.toISOString()}'),
        ('${DA_CASA}', '${CASA}', 'Cliente da Casa', '+5571988880002', '${AGORA.toISOString()}'),
        ('${IMPORTADO}', '${CASA}', 'Veio na Planilha', '+5571988880003', '2024-01-10T12:00:00Z')
    `);
  }, 30_000);

  it('cliente novo que veio pela busca gera comissão sobre o valor do atendimento', async () => {
    await atendimento({
      id: '72dddddd-0000-0000-0000-000000000001',
      customerId: NOVO,
      source: 'marketplace',
      criadoEm: AGORA,
      quando: AGORA,
    });

    expect(await atribuirDaBarbearia(CASA, AGORA)).toBe(1);

    const linhas = await atribuicoesDaBarbearia(CASA);
    expect(linhas).toHaveLength(1);
    // 20% de R$ 55,00.
    expect(linhas[0]?.feeCents).toBe(1100);
    expect(linhas[0]?.baseCents).toBe(5500);
    expect(linhas[0]?.status).toBe('pendente');
  });

  it('quem já era da casa nunca gera, mesmo agendando pelo marketplace', async () => {
    /**
     * A promessa comercial do produto inteiro: *"cobrar sobre base própria é a
     * principal fonte de revolta contra Fresha e Booksy"*. Aqui o cliente já
     * tinha um atendimento pela recepção, e o segundo — pelo marketplace — não
     * pode virar cobrança.
     */
    await atendimento({
      id: '72dddddd-0000-0000-0000-000000000010',
      customerId: DA_CASA,
      source: 'reception',
      criadoEm: new Date(AGORA.getTime() - 10 * 86_400_000),
      quando: new Date(AGORA.getTime() - 10 * 86_400_000),
    });
    await atendimento({
      id: '72dddddd-0000-0000-0000-000000000011',
      customerId: DA_CASA,
      source: 'marketplace',
      criadoEm: AGORA,
      quando: AGORA,
    });

    expect(await atribuirDaBarbearia(CASA, AGORA)).toBe(0);
    expect(await atribuicoesDaBarbearia(CASA)).toEqual([]);
  });

  it('ficha antiga da base importada também não gera', async () => {
    // Nunca agendou, nunca abriu comanda — e mesmo assim já era da barbearia,
    // porque veio na planilha do sistema antigo. É a ponta da janela.
    await atendimento({
      id: '72dddddd-0000-0000-0000-000000000020',
      customerId: IMPORTADO,
      source: 'marketplace',
      criadoEm: AGORA,
      quando: AGORA,
    });

    expect(await atribuirDaBarbearia(CASA, AGORA)).toBe(0);
  });

  it('um cliente gera comissão uma vez só, para sempre', async () => {
    /**
     * A plataforma cobra pelo cliente que trouxe, não pelo agendamento. Quem
     * voltou é receita da barbearia — e quem garante isso é o índice único, não
     * a boa vontade da varredura.
     */
    await atendimento({
      id: '72dddddd-0000-0000-0000-000000000030',
      customerId: NOVO,
      source: 'marketplace',
      criadoEm: AGORA,
      quando: AGORA,
    });
    await atribuirDaBarbearia(CASA, AGORA);

    const depois = new Date(AGORA.getTime() + 7 * 86_400_000);
    await atendimento({
      id: '72dddddd-0000-0000-0000-000000000031',
      customerId: NOVO,
      source: 'marketplace',
      criadoEm: depois,
      quando: depois,
    });

    expect(await atribuirDaBarbearia(CASA, depois)).toBe(0);
    expect(await atribuicoesDaBarbearia(CASA)).toHaveLength(1);
  });

  it('a origem do cliente é carimbada e depois congelada', async () => {
    await atendimento({
      id: '72dddddd-0000-0000-0000-000000000040',
      customerId: NOVO,
      source: 'marketplace',
      criadoEm: AGORA,
      quando: AGORA,
    });
    await atribuirDaBarbearia(CASA, AGORA);

    const origem = await admin.$queryRawUnsafe<{ via: string | null }[]>(
      `SELECT acquired_via::text AS via FROM customers WHERE id = '${NOVO}'`,
    );
    expect(origem[0]?.via).toBe('marketplace');

    // Reescrevê-la seria a barbearia decidindo o que paga.
    await expect(
      admin.$executeRawUnsafe(
        `UPDATE customers SET acquired_via = 'website' WHERE id = '${NOVO}'`,
      ),
    ).rejects.toThrow(/congelada/);
  });

  it('alíquota zero não gera linha nenhuma, e é como toda barbearia nasce', async () => {
    await exec(`UPDATE tenant_platform SET marketplace_fee_bps = 0 WHERE tenant_id = '${CASA}'`);
    await atendimento({
      id: '72dddddd-0000-0000-0000-000000000050',
      customerId: NOVO,
      source: 'marketplace',
      criadoEm: AGORA,
      quando: AGORA,
    });

    expect(await atribuirDaBarbearia(CASA, AGORA)).toBe(0);
  });

  it('a fatura do mês fechado cobra uma vez, e a segunda emissão não cobra de novo', async () => {
    /**
     * A régua é reentrante de propósito: ela roda a cada volta do laço. Um
     * `SELECT` antes do `INSERT` teria janela que cobra a barbearia duas vezes
     * pelo mesmo mês — a lição de `club_invoices` no bloco 50.
     */
    const julho = new Date('2026-07-15T14:00:00Z');
    await exec(`
      -- A ficha nasce junto com o agendamento, que e o caso real de quem chega
      -- pela busca. Sem isso o agendamento seria anterior ao proprio cadastro e
      -- a janela o recusaria — por um defeito da semente, nao da regra.
      UPDATE customers SET created_at = '${julho.toISOString()}' WHERE id = '${NOVO}';

      INSERT INTO plans (code, name, price_cents) VALUES ('pro', 'Pro', 19900)
      ON CONFLICT (code) DO NOTHING;

      -- Status active explicito: o padrao da coluna e trialing, e a CHECK exige
      -- trial_ends_at junto. A semente que erra isso reprova por um motivo que
      -- nao tem nada a ver com a regra sob teste.
      INSERT INTO subscriptions (tenant_id, plan_code, price_cents, status, period_start, period_end)
      VALUES ('${CASA}', 'pro', 19900, 'active', '2026-07-01T00:00:00Z', '2026-08-01T00:00:00Z')
      ON CONFLICT (tenant_id) DO UPDATE SET plan_code = 'pro'
    `);
    await atendimento({
      id: '72dddddd-0000-0000-0000-000000000060',
      customerId: NOVO,
      source: 'marketplace',
      criadoEm: julho,
      quando: julho,
    });
    await atribuirDaBarbearia(CASA, julho);

    const primeira = await emitirComissaoDoMarketplace({ tenantId: CASA, agora: AGORA });
    expect(primeira?.valorCents).toBe(1100);

    const segunda = await emitirComissaoDoMarketplace({ tenantId: CASA, agora: AGORA });
    expect(segunda).toBeNull();

    const faturas = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM invoices WHERE kind = 'marketplace'`,
    );
    expect(Number(faturas[0]?.n ?? 0)).toBe(1);

    const linhas = await atribuicoesDaBarbearia(CASA);
    expect(linhas[0]?.status).toBe('faturada');
  });

  it('contestar sem motivo escrito é recusado', async () => {
    /**
     * Contestar renuncia a uma cobrança de forma **permanente**: o índice único
     * faz aquele cliente nunca mais gerar comissão. Sem motivo, um laço de
     * cliques sobre a lista é evasão de cem por cento da receita, e nada a
     * distingue de discordância legítima. Achado da `/security-review`.
     */
    await atendimento({
      id: '72dddddd-0000-0000-0000-000000000080',
      customerId: NOVO,
      source: 'marketplace',
      criadoEm: AGORA,
      quando: AGORA,
    });
    await atribuirDaBarbearia(CASA, AGORA);
    const [linha] = await atribuicoesDaBarbearia(CASA);

    await expect(
      contestarAtribuicao({
        tenantId: CASA,
        staffUserId: null as unknown as string,
        staffNome: 'Dono',
        atribuicaoId: linha!.id,
        categoria: 'ja_era_cliente', motivo: 'erro',
      }),
    ).rejects.toThrow(/motivo/i);
  });

  it('remarcar não apaga a comissão', async () => {
    /**
     * `rescheduleAppointment` deixa a linha antiga com `status = 'rescheduled'`
     * e cria a nova. Contando a antiga como "agendamento anterior", o balcão
     * apagava a comissão remarcando o horário um minuto antes de concluí-lo —
     * sem rastro, com uma permissão que a recepção já tem, e indistinguível de
     * trabalho legítimo. Achado da `/security-review`.
     */
    await exec(`
      INSERT INTO appointments
        (id, tenant_id, location_id, professional_id, customer_id, status, source,
         starts_at, ends_at, service_starts_at, service_ends_at, price_cents, created_at)
      VALUES
        ('72dddddd-0000-0000-0000-000000000090', '${CASA}', '${LOCAL}', '${RUAN}', '${NOVO}',
         'rescheduled', 'marketplace',
         '${AGORA.toISOString()}', '${new Date(AGORA.getTime() + 1_800_000).toISOString()}',
         '${AGORA.toISOString()}', '${new Date(AGORA.getTime() + 1_800_000).toISOString()}',
         5500, '${AGORA.toISOString()}')
    `);
    await atendimento({
      id: '72dddddd-0000-0000-0000-000000000091',
      customerId: NOVO,
      source: 'marketplace',
      criadoEm: new Date(AGORA.getTime() + 60_000),
      quando: new Date(AGORA.getTime() + 86_400_000),
    });

    expect(await atribuirDaBarbearia(CASA, new Date(AGORA.getTime() + 2 * 86_400_000))).toBe(1);
  });

  it('contestar cancela o estado, e a linha continua existindo', async () => {
    // Sem `DELETE` na tabela: o que a casa contesta precisa continuar existindo
    // para a conversa ter documento, e o cliente contestado não volta a gerar
    // comissão numa varredura seguinte.
    await atendimento({
      id: '72dddddd-0000-0000-0000-000000000070',
      customerId: NOVO,
      source: 'marketplace',
      criadoEm: AGORA,
      quando: AGORA,
    });
    await atribuirDaBarbearia(CASA, AGORA);

    const [linha] = await atribuicoesDaBarbearia(CASA);
    expect(
      await contestarAtribuicao({
        tenantId: CASA,
        staffUserId: null as unknown as string,
        staffNome: 'Dono',
        atribuicaoId: linha!.id,
        categoria: 'ja_era_cliente', motivo: 'já era meu cliente há dois anos',
      }),
    ).toBe(true);

    const depois = await atribuicoesDaBarbearia(CASA);
    expect(depois[0]?.status).toBe('cancelada');

    // E ela não renasce.
    expect(await atribuirDaBarbearia(CASA, new Date(AGORA.getTime() + 86_400_000))).toBe(0);
  });
});
