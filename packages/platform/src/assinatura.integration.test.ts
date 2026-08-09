import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@barbearia/db';
import {
  assinaturaDaBarbearia,
  assinaturas,
  cancelarAssinatura,
  mudarPlanoDaAssinatura,
  PlataformaError,
  reativarAssinatura,
  recursoLigado,
  recursosDaBarbearia,
} from './index.js';

/**
 * A assinatura contra Postgres real.
 *
 * O teto de cadeiras tem prova em SQL na migração 0029. O que **esta** suíte
 * acrescenta é o outro lado: que o caminho da aplicação esbarra nele de
 * verdade, e que o erro chega como recusa e não como quinhentos. Uma regra que
 * só o `psql` conhece é uma regra que a tela não sabe explicar.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const DOMARI = '27272727-aaaa-1111-1111-111111111111';
const RIVAL = '27272727-bbbb-2222-2222-222222222222';
const LOCAL = 'a7272727-0000-0000-0000-000000000001';
const ADMIN = 'd7272727-0000-0000-0000-000000000001';

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

/** Cadastra uma cadeira pelo caminho que o produto usa: dentro do tenant. */
const contratar = (tenantId: string, nome: string) =>
  withTenant(tenantId, (tx) =>
    tx.$executeRaw`
      INSERT INTO professionals (tenant_id, location_id, name, kind)
      VALUES (${tenantId}::uuid, ${LOCAL}::uuid, ${nome}, 'professional')
    `,
  );

describeIfDb('assinatura da barbearia', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await admin.$executeRawUnsafe('TRUNCATE platform_admins CASCADE');
    await admin.$executeRawUnsafe('TRUNCATE platform_audit');

    await exec(`
      INSERT INTO platform_admins (id, email_key, name, password_hash)
      VALUES ('${ADMIN}', 'chave-27', 'Super', 'hash');

      INSERT INTO tenants (id, name) VALUES ('${DOMARI}', 'Domari'), ('${RIVAL}', 'Rival');

      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('${LOCAL}', '${DOMARI}', 'Matriz', 'America/Bahia');
    `);
  });

  // -- o que nasce com a barbearia --------------------------------------------

  it('nasce em teste, no plano padrão, com o preço de tabela congelado', async () => {
    const assinatura = await assinaturaDaBarbearia(DOMARI);

    expect(assinatura).toMatchObject({
      planoCode: 'pro',
      estado: 'trialing',
      precoCents: 9900,
      tetoDeCadeiras: 5,
      cadeirasEmUso: 0,
    });
    expect(assinatura?.testeAte).toBeInstanceOf(Date);
  });

  it('e o reajuste da tabela não alcança quem já contratou', async () => {
    // Mesma decisão da comissão: o lançamento guarda a regra copiada.
    await exec(`UPDATE plans SET price_cents = 14900 WHERE code = 'pro'`);
    try {
      expect((await assinaturaDaBarbearia(DOMARI))?.precoCents).toBe(9900);
    } finally {
      await exec(`UPDATE plans SET price_cents = 9900 WHERE code = 'pro'`);
    }
  });

  // -- o teto de cadeiras, pelo caminho da aplicação --------------------------

  it('a sexta cadeira é recusada num plano de cinco', async () => {
    for (let i = 1; i <= 5; i++) await contratar(DOMARI, `Barbeiro ${i}`);
    expect((await assinaturaDaBarbearia(DOMARI))?.cadeirasEmUso).toBe(5);

    // A recusa vem do gatilho, e chega como erro do banco — que é o ponto: não
    // existe caminho de cadastro que passe ao lado dela.
    await expect(contratar(DOMARI, 'Sexto')).rejects.toThrow();
    expect((await assinaturaDaBarbearia(DOMARI))?.cadeirasEmUso).toBe(5);
  });

  it('o teto é por barbearia, não da plataforma', async () => {
    for (let i = 1; i <= 5; i++) await contratar(DOMARI, `Barbeiro ${i}`);

    await exec(`
      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('a7272727-0000-0000-0000-000000000002', '${RIVAL}', 'Centro', 'America/Bahia')
    `);
    await withTenant(RIVAL, (tx) =>
      tx.$executeRaw`
        INSERT INTO professionals (tenant_id, location_id, name, kind)
        VALUES (${RIVAL}::uuid, 'a7272727-0000-0000-0000-000000000002'::uuid, 'Outro', 'professional')
      `,
    );

    expect((await assinaturaDaBarbearia(RIVAL))?.cadeirasEmUso).toBe(1);
  });

  it('subir de plano libera a cadeira seguinte', async () => {
    for (let i = 1; i <= 5; i++) await contratar(DOMARI, `Barbeiro ${i}`);
    await expect(contratar(DOMARI, 'Sexto')).rejects.toThrow();

    await mudarPlanoDaAssinatura({ adminId: ADMIN, tenantId: DOMARI, planoCode: 'business' });

    await contratar(DOMARI, 'Sexto');
    expect((await assinaturaDaBarbearia(DOMARI))?.cadeirasEmUso).toBe(6);
  });

  it('e descer para um plano menor que a equipe é recusado com o que fazer', async () => {
    // O gatilho guarda a porta de entrada de cadeira, não a de saída de plano:
    // sem esta checagem a barbearia ficaria com seis cadeiras num plano de
    // cinco sem violar nenhum INSERT.
    await mudarPlanoDaAssinatura({ adminId: ADMIN, tenantId: DOMARI, planoCode: 'business' });
    for (let i = 1; i <= 6; i++) await contratar(DOMARI, `Barbeiro ${i}`);

    const erro = await mudarPlanoDaAssinatura({
      adminId: ADMIN,
      tenantId: DOMARI,
      planoCode: 'pro',
    })
      .then(() => null)
      .catch((e: PlataformaError) => e);

    expect(erro).toBeInstanceOf(PlataformaError);
    expect((erro as PlataformaError).code).toBe('chairs_exceed_plan');
    expect((erro as PlataformaError).message).toMatch(/desligue/i);
    expect((await assinaturaDaBarbearia(DOMARI))?.planoCode).toBe('business');
  });

  it('plano sem teto declarado não recusa ninguém', async () => {
    await exec(`UPDATE subscriptions SET plan_code = 'enterprise' WHERE tenant_id = '${DOMARI}'`);
    for (let i = 1; i <= 12; i++) await contratar(DOMARI, `Barbeiro ${i}`);

    expect((await assinaturaDaBarbearia(DOMARI))?.tetoDeCadeiras).toBeNull();
    expect((await assinaturaDaBarbearia(DOMARI))?.cadeirasEmUso).toBe(12);
  });

  // -- o plano decide o que a barbearia tem ----------------------------------

  it('o Pro inclui os três recursos e o Starter não inclui nenhum', async () => {
    // É o que faz o plano de cima ter argumento e o de baixo ter limite.
    expect(await recursoLigado(DOMARI, 'fila')).toBe(true);
    expect(await recursoLigado(DOMARI, 'avisos')).toBe(true);

    await mudarPlanoDaAssinatura({ adminId: ADMIN, tenantId: DOMARI, planoCode: 'starter' });

    expect(await recursoLigado(DOMARI, 'fila')).toBe(false);
    expect(await recursoLigado(DOMARI, 'importacao')).toBe(false);
    expect(await recursoLigado(DOMARI, 'avisos')).toBe(false);
  });

  it('e a exceção da conta vence o plano, nos dois sentidos', async () => {
    // É como o suporte dá cortesia sem mexer no plano, e como tira um recurso
    // de quem está abusando dele sem rebaixar a conta inteira.
    await mudarPlanoDaAssinatura({ adminId: ADMIN, tenantId: DOMARI, planoCode: 'starter' });
    await exec(`
      INSERT INTO tenant_features (tenant_id, flag_code, enabled)
      VALUES ('${DOMARI}', 'fila', true)
    `);
    expect(await recursoLigado(DOMARI, 'fila')).toBe(true);

    await exec(`
      UPDATE subscriptions SET plan_code = 'pro' WHERE tenant_id = '${DOMARI}';
      UPDATE tenant_features SET enabled = false WHERE tenant_id = '${DOMARI}' AND flag_code = 'fila'
    `);
    expect(await recursoLigado(DOMARI, 'fila')).toBe(false);
  });

  it('a tela sabe distinguir o que vem do plano do que é cortesia', async () => {
    await mudarPlanoDaAssinatura({ adminId: ADMIN, tenantId: DOMARI, planoCode: 'starter' });
    await exec(`
      INSERT INTO tenant_features (tenant_id, flag_code, enabled)
      VALUES ('${DOMARI}', 'fila', true)
    `);

    const recursos = await recursosDaBarbearia(DOMARI);
    const fila = recursos.find((r) => r.code === 'fila');

    // Ligado, mas não porque o plano paga por ele. Sem essa distinção a tela
    // deixaria parecer que o Starter inclui fila.
    expect(fila).toMatchObject({ ligado: true, proprio: true, noPlano: false });
  });

  // -- mudar de plano ---------------------------------------------------------

  it('trocar de plano recopia o preço e deixa rastro do de-para', async () => {
    await mudarPlanoDaAssinatura({ adminId: ADMIN, tenantId: DOMARI, planoCode: 'business' });

    expect(await assinaturaDaBarbearia(DOMARI)).toMatchObject({
      planoCode: 'business',
      precoCents: 24900,
    });

    const trilha = await admin.$queryRawUnsafe<{ detail: Record<string, unknown> }[]>(
      `SELECT detail FROM platform_audit WHERE action = 'tenant.plan_changed'`,
    );
    expect(trilha[0]?.detail).toMatchObject({
      de: 'pro',
      para: 'business',
      dePrecoCents: 9900,
      paraPrecoCents: 24900,
    });
  });

  it('o espelho do bloco 24 segue a assinatura em vez de competir com ela', async () => {
    // Duas fontes discordando sobre o plano de uma barbearia é a discussão que
    // ninguém consegue encerrar.
    await mudarPlanoDaAssinatura({ adminId: ADMIN, tenantId: DOMARI, planoCode: 'business' });

    const espelho = await admin.$queryRawUnsafe<{ code: string }[]>(
      `SELECT p.code FROM tenant_platform tp JOIN plans p ON p.id = tp.plan_id
        WHERE tp.tenant_id = '${DOMARI}'`,
    );
    expect(espelho[0]?.code).toBe('business');
  });

  it('plano fora de oferta não recebe barbearia nova', async () => {
    await expect(
      mudarPlanoDaAssinatura({ adminId: ADMIN, tenantId: DOMARI, planoCode: 'cortesia' }),
    ).rejects.toMatchObject({ code: 'inactive_plan' });
  });

  // -- cancelar ---------------------------------------------------------------

  it('cancelar não tira do ar, e exige motivo', async () => {
    // Cortar no dia do pedido é cobrar por um mês e entregar meio.
    await expect(
      cancelarAssinatura({ adminId: ADMIN, tenantId: DOMARI, motivo: ' ' }),
    ).rejects.toMatchObject({ code: 'reason_required' });

    await cancelarAssinatura({ adminId: ADMIN, tenantId: DOMARI, motivo: 'fechou as portas' });

    expect((await assinaturaDaBarbearia(DOMARI))?.estado).toBe('canceled');

    const bloqueio = await admin.$queryRawUnsafe<{ blocked_at: Date | null }[]>(
      `SELECT blocked_at FROM tenant_platform WHERE tenant_id = '${DOMARI}'`,
    );
    expect(bloqueio[0]?.blocked_at).toBeNull();
  });

  it('cancelar duas vezes é recusado, e reativar volta a valer', async () => {
    await cancelarAssinatura({ adminId: ADMIN, tenantId: DOMARI, motivo: 'fechou' });
    await expect(
      cancelarAssinatura({ adminId: ADMIN, tenantId: DOMARI, motivo: 'de novo' }),
    ).rejects.toMatchObject({ code: 'not_cancelable' });

    await reativarAssinatura({ adminId: ADMIN, tenantId: DOMARI });
    const assinatura = await assinaturaDaBarbearia(DOMARI);
    expect(assinatura?.estado).toBe('active');
    expect(assinatura?.canceladaEm).toBeNull();
  });

  it('a lista traz todas as barbearias, ordenadas por quem vence primeiro', async () => {
    // É a ordem que a régua do bloco 28 vai consumir: quem vence antes é quem
    // precisa de decisão antes.
    await exec(`
      UPDATE subscriptions SET period_end = now() + interval '40 days' WHERE tenant_id = '${DOMARI}'
    `);
    const lista = await assinaturas();
    expect(lista).toHaveLength(2);
    expect(lista[0]?.tenantId).toBe(RIVAL);
  });
});
