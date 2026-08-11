import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@barbearia/db';
import { ConfiancaError, definirConfianca } from './confianca.js';

/**
 * O override do score contra Postgres real (bloco 37).
 *
 * O que só o banco prova: que o motivo escrito é cobrado de verdade, que a
 * trilha entra na mesma transação da mudança, e que a barbearia vizinha não
 * mexe no score de um cliente que não é dela — o que aqui importa mais que o
 * normal, porque o número decide se a pessoa paga adiantado.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '37373737-cc11-1111-1111-111111111111';
const RIVAL = '37373737-cc22-2222-2222-222222222222';
const CARLOS = '37373737-cccc-0000-0000-000000000011';
const STAFF = '37373737-ffff-0000-0000-000000000011';

const gerente = { staffId: STAFF, staffName: 'Bruno Gerente' };
const MOTIVO = 'faltou por internação, comprovada na recepção';

let admin: PrismaClient;

describeIfDb('o override do score', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await admin.$executeRawUnsafe(`
      INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Domari'), ('${RIVAL}', 'Vizinha')
    `);
    await admin.$executeRawUnsafe(`
      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777')
    `);
    await admin.$executeRawUnsafe(`
      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${STAFF}', '${TENANT}', 'Bruno', 'bruno@domari.com.br', 'x', 'manager')
    `);
  });

  const ajustar = (score: number | null, motivo = MOTIVO) =>
    definirConfianca({ tenantId: TENANT, customerId: CARLOS, score, motivo, ...gerente });

  const trilha = () =>
    withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ action: string; actor_name: string; before: unknown; after: unknown }[]>`
        SELECT action::text AS action, actor_name, before, after
          FROM audit_log ORDER BY created_at
      `,
    );

  it('grava o score, o motivo e quem decidiu', async () => {
    const gravado = await ajustar(100);
    expect(gravado.score).toBe(100);
    expect(gravado.motivo).toBe(MOTIVO);
    expect(gravado.quando).not.toBeNull();

    const linhas = await trilha();
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({
      action: 'customer.reliability_override',
      actor_name: 'Bruno Gerente',
    });
    // O `before` é o que permite responder "quem tirou este cliente do sinal?"
    // seis meses depois, quando o número já mudou de novo.
    expect(linhas[0]?.before).toEqual({ score: null });
  });

  it('sem motivo escrito não grava nada', async () => {
    /**
     * A SPEC §2.13 pede "justificativa auditada", e as duas palavras trabalham
     * diferente: a trilha guarda quem, o motivo guarda por quê. "ok" cabe num
     * campo obrigatório e não explica nada.
     */
    await expect(ajustar(100, 'ok')).rejects.toMatchObject({ code: 'motivo_curto' });

    const linhas = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ reliability_override: number | null }[]>`
        SELECT reliability_override FROM customers WHERE id = ${CARLOS}::uuid
      `,
    );
    expect(linhas[0]?.reliability_override).toBeNull();
    expect(await trilha()).toHaveLength(0);
  });

  it('recusa score fora da escala', async () => {
    await expect(ajustar(120)).rejects.toMatchObject({ code: 'score_invalido' });
    await expect(ajustar(-1)).rejects.toMatchObject({ code: 'score_invalido' });
  });

  it('devolver o cliente à fórmula também exige motivo e também é auditado', async () => {
    // Tirar alguém do override é uma decisão sobre dinheiro tanto quanto
    // colocá-lo: quem estava dispensado do sinal volta a pagá-lo.
    await ajustar(100);
    const removido = await ajustar(null, 'histórico normalizado, volta para a régua padrão');
    expect(removido.score).toBeNull();

    const linhas = await trilha();
    expect(linhas).toHaveLength(2);
    expect(linhas[1]?.before).toEqual({ score: 100 });
    expect(linhas[1]?.after).toMatchObject({ score: null });
  });

  it('a barbearia vizinha não mexe no score de um cliente que não é dela', async () => {
    /**
     * O id do cliente não é segredo — ele aparece em link de ficha e em
     * suporte. Sem o recorte da RLS, bastaria o id para a vizinha dispensar do
     * sinal um cliente desta barbearia, ou trancá-lo em 0.
     */
    await expect(
      definirConfianca({
        tenantId: RIVAL,
        customerId: CARLOS,
        score: 0,
        motivo: 'quero que ele pague sinal na concorrente',
        ...gerente,
      }),
    ).rejects.toBeInstanceOf(ConfiancaError);

    const linhas = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ reliability_override: number | null }[]>`
        SELECT reliability_override FROM customers WHERE id = ${CARLOS}::uuid
      `,
    );
    expect(linhas[0]?.reliability_override).toBeNull();
  });
});
