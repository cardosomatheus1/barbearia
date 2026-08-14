import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cancelarDestaque, destaquesDaCidade, venderDestaque } from './destaque.js';
import { atualizarVitrine } from './vitrine.js';
import {
  atribuicoesDaBarbearia,
  contestacoesNaPlataforma,
  contestarAtribuicao,
  reverterContestacao,
} from './atribuicao.js';

/**
 * Destaque pago e revisão de contestação contra Postgres real (bloco 75).
 *
 * O que só o banco prova: que os lugares são **escassos de verdade** — a
 * constraint de exclusão recusa o segundo anúncio no mesmo lugar da mesma
 * cidade —, que cancelar libera o lugar na hora, e que a plataforma consegue
 * ver e reverter o que a barbearia contestou.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const CASA = '75707070-1111-1111-1111-111111111111';
const VIZINHA = '75707070-2222-2222-2222-222222222222';
const LOCAL = '75aaaaaa-0000-0000-0000-000000000001';
const LOCAL_VIZINHA = '75aaaaaa-0000-0000-0000-000000000002';
const ADMIN = '75dddddd-0000-0000-0000-000000000001';

const DE = new Date('2026-09-01T00:00:00Z');
const ATE = new Date('2026-10-01T00:00:00Z');
const DENTRO = new Date('2026-09-15T12:00:00Z');

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

describeIfDb('destaque pago na busca', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  }, 30_000);

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await admin.$executeRawUnsafe('TRUNCATE platform_admins CASCADE');
    await exec(`
      INSERT INTO tenants (id, name, published_at) VALUES
        ('${CASA}', 'Barbearia do Bloco 75', now()),
        ('${VIZINHA}', 'Barbearia Vizinha', now());

      INSERT INTO tenant_slugs (tenant_id, slug, is_primary) VALUES
        ('${CASA}', 'bloco-75', true),
        ('${VIZINHA}', 'vizinha-75', true);

      INSERT INTO locations (id, tenant_id, name, timezone, city, state, latitude, longitude)
      VALUES
        ('${LOCAL}', '${CASA}', 'Matriz', 'America/Bahia', 'Salvador', 'BA', -12.9899, -38.4767),
        ('${LOCAL_VIZINHA}', '${VIZINHA}', 'Deles', 'America/Bahia', 'Salvador', 'BA',
         -12.9909, -38.4767);

      INSERT INTO plans (code, name, price_cents) VALUES ('pro', 'Pro', 19900)
      ON CONFLICT (code) DO NOTHING;

      -- A assinatura nasce por gatilho junto de tenants, como tenant_platform:
      -- inseri-la aqui viola a chave, e a semente e que estava errada.
      UPDATE subscriptions SET plan_code = 'pro', price_cents = 19900, status = 'active'
       WHERE tenant_id IN ('${CASA}', '${VIZINHA}');

      INSERT INTO platform_admins (id, email_key, name, password_hash, role)
      VALUES ('${ADMIN}', 'super-75', 'Super', 'x', 'operator')
    `);
  }, 30_000);

  it('vender um destaque emite fatura própria com o preço do período', async () => {
    /**
     * Documento próprio e não somado à mensalidade: uma fatura de assinatura
     * dizendo R$ 469,00 sobre um plano de R$ 199,00 obriga a barbearia a
     * acreditar na diferença.
     */
    const { valorCents } = await venderDestaque({
      adminId: ADMIN, tenantId: CASA, locationId: LOCAL, lugar: 1, de: DE, ate: ATE,
    });

    // Trinta dias a R$ 9,00.
    expect(valorCents).toBe(30 * 900);

    const faturas = await admin.$queryRawUnsafe<{ amount_cents: number }[]>(
      `SELECT amount_cents FROM invoices WHERE kind = 'ad'`,
    );
    expect(faturas).toHaveLength(1);
    expect(Number(faturas[0]?.amount_cents)).toBe(valorCents);
  });

  it('dois anúncios não ocupam o mesmo lugar da mesma cidade ao mesmo tempo', async () => {
    /**
     * A escassez é o produto: com cinquenta destaques em Salvador, destaque
     * deixa de valer alguma coisa. Quem garante isso é a constraint de
     * exclusão, não um contador na aplicação — que teria corrida entre duas
     * vendas simultâneas.
     */
    await venderDestaque({
      adminId: ADMIN, tenantId: CASA, locationId: LOCAL, lugar: 1, de: DE, ate: ATE,
    });

    await expect(
      venderDestaque({
        adminId: ADMIN, tenantId: VIZINHA, locationId: LOCAL_VIZINHA, lugar: 1,
        de: new Date('2026-09-15T00:00:00Z'), ate: new Date('2026-10-15T00:00:00Z'),
      }),
    ).rejects.toThrow();

    // O lugar 2 da mesma cidade continua livre.
    const outro = await venderDestaque({
      adminId: ADMIN, tenantId: VIZINHA, locationId: LOCAL_VIZINHA, lugar: 2, de: DE, ate: ATE,
    });
    expect(outro.id).toBeTruthy();
  });

  it('a busca vê quem está em destaque hoje, na ordem dos lugares', async () => {
    await atualizarVitrine({ tenantId: CASA, locationId: LOCAL, agora: DENTRO });
    await atualizarVitrine({ tenantId: VIZINHA, locationId: LOCAL_VIZINHA, agora: DENTRO });

    await venderDestaque({
      adminId: ADMIN, tenantId: VIZINHA, locationId: LOCAL_VIZINHA, lugar: 2, de: DE, ate: ATE,
    });
    await venderDestaque({
      adminId: ADMIN, tenantId: CASA, locationId: LOCAL, lugar: 1, de: DE, ate: ATE,
    });

    /**
     * A chave é a **unidade**, não o slug: numa rede as lojas carregam o
     * mesmo slug, e casar por ele promoveria a loja errada da mesma
     * barbearia. A vizinha foi vendida primeiro e comprou o lugar 2 — se a
     * ordem fosse a da consulta em vez da dos lugares, ela viria na frente.
     */
    const pagos = await destaquesDaCidade('Salvador', 'BA', DENTRO);
    expect(pagos).toEqual([
      { locationId: LOCAL, lugar: 1 },
      { locationId: LOCAL_VIZINHA, lugar: 2 },
    ]);
  });

  it('fora do período o destaque não aparece', async () => {
    // Semiaberto `[início, fim)`: o dia do fim já não é destaque, como todo
    // intervalo deste código.
    await atualizarVitrine({ tenantId: CASA, locationId: LOCAL, agora: DENTRO });
    await venderDestaque({
      adminId: ADMIN, tenantId: CASA, locationId: LOCAL, lugar: 1, de: DE, ate: ATE,
    });

    expect(await destaquesDaCidade('Salvador', 'BA', new Date('2026-08-31T12:00:00Z'))).toEqual([]);
    expect(await destaquesDaCidade('Salvador', 'BA', ATE)).toEqual([]);
  });

  it('barbearia bloqueada não é vendida, nem tendo comprado destaque', async () => {
    // Quem não está pagando a plataforma não é vendida por ela — a mesma
    // condição da vitrine desde o bloco 70.
    await atualizarVitrine({ tenantId: CASA, locationId: LOCAL, agora: DENTRO });
    await venderDestaque({
      adminId: ADMIN, tenantId: CASA, locationId: LOCAL, lugar: 1, de: DE, ate: ATE,
    });
    await exec(
      `UPDATE tenant_platform SET blocked_at = now(), blocked_reason = 'inadimplente'
        WHERE tenant_id = '${CASA}'`,
    );

    expect(await destaquesDaCidade('Salvador', 'BA', DENTRO)).toEqual([]);
  });

  it('cancelar libera o lugar na hora, e exige motivo escrito', async () => {
    const { id } = await venderDestaque({
      adminId: ADMIN, tenantId: CASA, locationId: LOCAL, lugar: 1, de: DE, ate: ATE,
    });

    await expect(
      cancelarDestaque({ adminId: ADMIN, anuncioId: id, motivo: 'erro' }),
    ).rejects.toThrow(/motivo/i);

    await cancelarDestaque({
      adminId: ADMIN, anuncioId: id, motivo: 'vendido por engano para a unidade errada',
    });

    // O lugar volta a ser vendável no mesmo período.
    const outro = await venderDestaque({
      adminId: ADMIN, tenantId: VIZINHA, locationId: LOCAL_VIZINHA, lugar: 1, de: DE, ate: ATE,
    });
    expect(outro.id).toBeTruthy();
  });

  it('o lugar fora da faixa é recusado antes de qualquer ida ao banco', async () => {
    await expect(
      venderDestaque({
        adminId: ADMIN, tenantId: CASA, locationId: LOCAL, lugar: 9, de: DE, ate: ATE,
      }),
    ).rejects.toThrow(/lugar/i);
  });
});

describeIfDb('a plataforma revisa o que a barbearia contestou', () => {
  const CLIENTE = '75cccccc-0000-0000-0000-000000000001';
  const RUAN = '75bbbbbb-0000-0000-0000-000000000001';
  const DONO = '75dddddd-0000-0000-0000-000000000009';
  const AGENDA = '75eeeeee-0000-0000-0000-000000000001';
  const AGORA = new Date('2026-08-20T16:00:00Z');

  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  }, 30_000);

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await admin.$executeRawUnsafe('TRUNCATE platform_admins CASCADE');
    await exec(`
      INSERT INTO tenants (id, name) VALUES ('${CASA}', 'Barbearia do Bloco 75');

      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('${LOCAL}', '${CASA}', 'Matriz', 'America/Bahia');

      INSERT INTO professionals (id, tenant_id, location_id, name, kind)
      VALUES ('${RUAN}', '${CASA}', '${LOCAL}', 'Ruan', 'professional');

      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('${CLIENTE}', '${CASA}', 'Carlos', '+5571988887777');

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${DONO}', '${CASA}', 'Matheus', 'dono@bloco75.com.br', 'x', 'owner');

      INSERT INTO platform_admins (id, email_key, name, password_hash, role)
      VALUES ('${ADMIN}', 'super-75b', 'Super', 'x', 'operator');

      INSERT INTO appointments
        (id, tenant_id, location_id, professional_id, customer_id, status, source,
         starts_at, ends_at, service_starts_at, service_ends_at, price_cents)
      VALUES ('${AGENDA}', '${CASA}', '${LOCAL}', '${RUAN}', '${CLIENTE}', 'completed', 'marketplace',
              '2026-08-10T12:00:00Z', '2026-08-10T12:30:00Z',
              '2026-08-10T12:00:00Z', '2026-08-10T12:30:00Z', 5500);

      INSERT INTO marketplace_attributions
        (tenant_id, customer_id, appointment_id, base_cents, fee_bps, fee_cents, attributed_at)
      VALUES ('${CASA}', '${CLIENTE}', '${AGENDA}', 5500, 2000, 1100, now())
    `);
  }, 30_000);

  it('a plataforma vê a contestação, e o nome do cliente não sai', async () => {
    /**
     * Fecha a lacuna do bloco 72. O nome do cliente fica de fora de propósito:
     * a barbearia precisa dele para conferir a conta, e para a plataforma a
     * pergunta é *"esta renúncia se explica?"* — quem responde isso é o motivo
     * escrito, não quem é a pessoa.
     */
    const [linha] = await atribuicoesDaBarbearia(CASA);
    await contestarAtribuicao({
      tenantId: CASA, staffUserId: DONO, staffNome: 'Matheus',
      atribuicaoId: linha!.id, motivo: 'já era meu cliente há dois anos',
    });

    const vistas = await contestacoesNaPlataforma();
    expect(vistas).toHaveLength(1);
    expect(vistas[0]?.motivo).toBe('já era meu cliente há dois anos');
    expect(JSON.stringify(vistas[0])).not.toContain('Carlos');
  });

  it('reverter devolve a linha para pendente, nunca para faturada', async () => {
    /**
     * Faturada apontaria para uma fatura cujo valor nunca a incluiu — o defeito
     * que a revisão do bloco 72 achou. Pendente entra na emissão do mês
     * seguinte pelo caminho normal.
     */
    const [linha] = await atribuicoesDaBarbearia(CASA);
    await contestarAtribuicao({
      tenantId: CASA, staffUserId: DONO, staffNome: 'Matheus',
      atribuicaoId: linha!.id, motivo: 'contestação indevida de teste',
    });

    await reverterContestacao({
      adminId: ADMIN, atribuicaoId: linha!.id, motivo: 'o cliente é novo, veio pela busca',
    });

    const depois = await atribuicoesDaBarbearia(CASA);
    expect(depois[0]?.status).toBe('pendente');
    // O que a barbearia escreveu fica: apagar deixaria o registro contando só
    // o lado de quem reverteu.
    const guardado = await admin.$queryRawUnsafe<{ contested_reason: string | null }[]>(
      `SELECT contested_reason FROM marketplace_attributions`,
    );
    expect(guardado[0]?.contested_reason).toBe('contestação indevida de teste');
  });

  it('reverter exige motivo escrito, como contestar', async () => {
    const [linha] = await atribuicoesDaBarbearia(CASA);
    await contestarAtribuicao({
      tenantId: CASA, staffUserId: DONO, staffNome: 'Matheus',
      atribuicaoId: linha!.id, motivo: 'contestação de teste para reverter',
    });

    await expect(
      reverterContestacao({ adminId: ADMIN, atribuicaoId: linha!.id, motivo: 'não' }),
    ).rejects.toThrow(/motivo/i);
  });

  it('reverter o que não está contestado não faz nada', async () => {
    const [linha] = await atribuicoesDaBarbearia(CASA);
    await expect(
      reverterContestacao({
        adminId: ADMIN, atribuicaoId: linha!.id, motivo: 'tentativa sobre linha pendente',
      }),
    ).rejects.toThrow(/não encontrada/i);
    expect(AGORA.getUTCFullYear()).toBe(2026);
  });
});
