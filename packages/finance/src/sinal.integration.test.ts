import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@barbearia/db';
import {
  SinalError,
  devolverSinal,
  registrarSinalRecebido,
  sinalDoAgendamento,
} from './sinal.js';

/**
 * O sinal recebido contra Postgres real (bloco 37).
 *
 * O que só o banco prova: que dois toques no "Recebi" não registram o dobro,
 * que a trilha é gravada na mesma transação do dinheiro, e que a barbearia
 * vizinha não enxerga nem move o sinal desta.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '37373737-1111-1111-1111-111111111111';
const RIVAL = '37373737-2222-2222-2222-222222222222';
const LOCATION = '37373737-aaaa-0000-0000-000000000001';
const FILIAL = '37373737-aaaa-0000-0000-000000000002';
const RUAN = '37373737-bbbb-0000-0000-000000000001';
const BRUNO = '37373737-bbbb-0000-0000-000000000002';
const CARLOS = '37373737-cccc-0000-0000-000000000001';
const STAFF = '37373737-ffff-0000-0000-000000000001';
const AGENDAMENTO = '37373737-dddd-0000-0000-000000000001';
const AGENDAMENTO_FILIAL = '37373737-dddd-0000-0000-000000000002';

const AGORA = new Date('2026-09-10T12:00:00Z');
const operador = { staffId: STAFF, staffName: 'Maria Recepção' };

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

/** Um agendamento com o sinal já exigido, no estado pedido. */
function agendamento(opcoes: {
  readonly exigidoCents: number;
  readonly status?: string;
  readonly canceladoHorasAntes?: number | null;
}): string {
  const { exigidoCents, status = 'pending', canceladoHorasAntes = null } = opcoes;
  // Amanhã, nunca hoje: um horário encostado no relógio da suíte torna o teste
  // instável sob carga.
  const comeca = new Date(AGORA.getTime() + 86_400_000);
  const cancelado =
    canceladoHorasAntes === null
      ? 'NULL'
      : `'${new Date(comeca.getTime() - canceladoHorasAntes * 3_600_000).toISOString()}'`;

  return `
    INSERT INTO appointments
      (id, tenant_id, location_id, customer_id, professional_id,
       starts_at, ends_at, service_starts_at, service_ends_at,
       status, deposit_required_cents, deposit_reason, cancelled_at)
    VALUES ('${AGENDAMENTO}', '${TENANT}', '${LOCATION}', '${CARLOS}', '${RUAN}',
            '${comeca.toISOString()}', '${new Date(comeca.getTime() + 1_800_000).toISOString()}',
            '${comeca.toISOString()}', '${new Date(comeca.getTime() + 1_800_000).toISOString()}',
            '${status}', ${exigidoCents},
            ${exigidoCents > 0 ? "'score'" : 'NULL'}, ${cancelado})`;
}

describeIfDb('o sinal recebido', () => {
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
      INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Domari'), ('${RIVAL}', 'Vizinha');

      INSERT INTO locations (id, tenant_id, name, timezone, deposit_refund_hours)
      VALUES ('${LOCATION}', '${TENANT}', 'Matriz', 'America/Bahia', 24),
             ('${FILIAL}', '${TENANT}', 'Filial', 'America/Bahia', 24);

      INSERT INTO professionals (id, tenant_id, location_id, name)
      VALUES ('${RUAN}', '${TENANT}', '${LOCATION}', 'Ruan'),
             ('${BRUNO}', '${TENANT}', '${FILIAL}', 'Bruno');

      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777');

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${STAFF}', '${TENANT}', 'Maria', 'maria@domari.com.br', 'x', 'receptionist');
    `);
  });

  const registrar = (valorCents: number) =>
    registrarSinalRecebido({
      tenantId: TENANT,
      locationId: LOCATION,
      appointmentId: AGENDAMENTO,
      valorCents,
      ...operador,
    });

  const trilha = () =>
    withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ action: string; actor_name: string }[]>`
        SELECT action::text AS action, actor_name FROM audit_log ORDER BY created_at
      `,
    );

  it('UUID de agendamento de outra unidade da mesma barbearia não move o sinal', async () => {
    const comeca = new Date(AGORA.getTime() + 2 * 86_400_000);
    await exec(`
      INSERT INTO appointments
        (id, tenant_id, location_id, customer_id, professional_id, starts_at, ends_at,
         service_starts_at, service_ends_at, status, deposit_required_cents, deposit_reason)
      VALUES ('${AGENDAMENTO_FILIAL}', '${TENANT}', '${FILIAL}', '${CARLOS}', '${BRUNO}',
              '${comeca.toISOString()}', '${new Date(comeca.getTime() + 1_800_000).toISOString()}',
              '${comeca.toISOString()}', '${new Date(comeca.getTime() + 1_800_000).toISOString()}',
              'pending', 2000, 'score')
    `);

    await expect(sinalDoAgendamento(TENANT, LOCATION, AGENDAMENTO_FILIAL)).rejects.toMatchObject({
      code: 'agendamento_nao_encontrado',
    });
    await expect(registrarSinalRecebido({
      tenantId: TENANT, locationId: LOCATION, appointmentId: AGENDAMENTO_FILIAL,
      valorCents: 2000, ...operador,
    })).rejects.toMatchObject({ code: 'agendamento_nao_encontrado' });
    expect((await sinalDoAgendamento(TENANT, FILIAL, AGENDAMENTO_FILIAL)).pagoCents).toBe(0);
  });

  it('registra o sinal e deixa rastro de quem disse que recebeu', async () => {
    await exec(agendamento({ exigidoCents: 2000 }));

    const depois = await registrar(2000);
    expect(depois).toMatchObject({ exigidoCents: 2000, pagoCents: 2000, motivo: 'score' });

    // Quem digita "recebi" é a única testemunha da entrada. Sem a trilha, a
    // pergunta do dia seguinte — "o cliente jurou que pagou" — não tem resposta.
    expect(await trilha()).toEqual([
      { action: 'deposit.received', actor_name: 'Maria Recepção' },
    ]);
  });

  it('o segundo toque não registra o dobro', async () => {
    await exec(agendamento({ exigidoCents: 2000 }));
    await registrar(2000);

    await expect(registrar(2000)).rejects.toThrow(SinalError);
    const atual = await sinalDoAgendamento(TENANT, LOCATION, AGENDAMENTO);
    expect(atual.pagoCents).toBe(2000);
    expect(await trilha()).toHaveLength(1);
  });

  it('recusa valor diferente do exigido', async () => {
    /**
     * Quem digita é quem confere o comprovante, e não há segunda pessoa olhando
     * um Pix que caiu no celular da recepção. Um campo livre deixaria "recebi
     * R$ 2" de um sinal de R$ 20 passar como quitação, e a diferença sumiria.
     */
    await exec(agendamento({ exigidoCents: 2000 }));
    await expect(registrar(200)).rejects.toMatchObject({
      code: 'valor_diferente_do_exigido',
    });
    expect((await sinalDoAgendamento(TENANT, LOCATION, AGENDAMENTO)).pagoCents).toBe(0);
  });

  it('não registra sinal em agendamento que não exige nenhum', async () => {
    await exec(agendamento({ exigidoCents: 0 }));
    await expect(registrar(2000)).rejects.toMatchObject({ code: 'sem_sinal_exigido' });
  });

  it('a barbearia vizinha não vê nem move este sinal', async () => {
    /**
     * A RLS separa barbearias, e o id do agendamento não é segredo — ele
     * aparece em link de confirmação e em suporte. Sem o recorte, bastaria o id
     * para a vizinha zerar o sinal desta.
     */
    await exec(agendamento({ exigidoCents: 2000 }));

    await expect(sinalDoAgendamento(RIVAL, LOCATION, AGENDAMENTO)).rejects.toMatchObject({
      code: 'agendamento_nao_encontrado',
    });
    await expect(
      registrarSinalRecebido({
        tenantId: RIVAL,
        locationId: LOCATION,
        appointmentId: AGENDAMENTO,
        valorCents: 2000,
        ...operador,
      }),
    ).rejects.toMatchObject({ code: 'agendamento_nao_encontrado' });
  });

  describe('o que a tela diz sobre devolver', () => {
    it('cancelou com antecedência: devolve', async () => {
      await exec(
        agendamento({ exigidoCents: 2000, status: 'cancelled_customer', canceladoHorasAntes: 48 }),
      );
      await registrar(2000);
      expect(await sinalDoAgendamento(TENANT, LOCATION, AGENDAMENTO)).toMatchObject({
        reembolso: 'devolver',
      });
    });

    it('cancelou em cima do prazo: retém', async () => {
      await exec(
        agendamento({ exigidoCents: 2000, status: 'cancelled_customer', canceladoHorasAntes: 2 }),
      );
      await registrar(2000);
      expect(await sinalDoAgendamento(TENANT, LOCATION, AGENDAMENTO)).toMatchObject({ reembolso: 'reter' });
    });

    it('a casa cancelou: devolve, mesmo em cima da hora', async () => {
      await exec(
        agendamento({ exigidoCents: 2000, status: 'cancelled_business', canceladoHorasAntes: 0 }),
      );
      await registrar(2000);
      expect(await sinalDoAgendamento(TENANT, LOCATION, AGENDAMENTO)).toMatchObject({
        reembolso: 'devolver',
      });
    });

    it('faltou sem avisar: retém — é o caso para o qual o sinal existe', async () => {
      await exec(agendamento({ exigidoCents: 2000, status: 'no_show' }));
      await registrar(2000);
      expect(await sinalDoAgendamento(TENANT, LOCATION, AGENDAMENTO)).toMatchObject({ reembolso: 'reter' });
    });

    it('cancelamento sem carimbo devolve, e não retém', async () => {
      // Agendamento anterior à migração 0039. Reter dinheiro por causa de um
      // registro que a casa não fez é cobrar pelo próprio buraco.
      await exec(
        agendamento({
          exigidoCents: 2000,
          status: 'cancelled_customer',
          canceladoHorasAntes: null,
        }),
      );
      await registrar(2000);
      const atual = await sinalDoAgendamento(TENANT, LOCATION, AGENDAMENTO);
      expect(atual.reembolso).toBe('devolver');
      expect(atual.porqueDoReembolso).toContain('registro');
    });

    it('enquanto o horário está de pé não há decisão de reembolso a mostrar', async () => {
      // Indicador que responde antes da pergunta é pior que indicador nenhum: a
      // recepção aprenderia a ler "devolver" num agendamento que vai acontecer.
      await exec(agendamento({ exigidoCents: 2000 }));
      await registrar(2000);
      expect(await sinalDoAgendamento(TENANT, LOCATION, AGENDAMENTO)).toMatchObject({
        reembolso: null,
        porqueDoReembolso: null,
      });
    });
  });

  it('o horário remarcado deixa de existir para o sinal', async () => {
    /**
     * Um sinal pago é um só, e ele segue o agendamento. Enquanto a linha antiga
     * carregava o valor, o id do primeiro e-mail de confirmação e o id do
     * horário atual devolviam **o mesmo dinheiro duas vezes** — cada uma com
     * sua entrada na trilha, e nada que as distinguisse de dois reembolsos
     * legítimos. Achado da `/security-review` do bloco 37.
     *
     * Aqui o estado é forjado direto no banco em vez de remarcar de verdade: o
     * que se prova é a leitura, e `rescheduleAppointment` mora em `scheduling`,
     * onde o outro lado da mesma regra tem o seu teste.
     */
    await exec(agendamento({ exigidoCents: 2000 }));
    await registrar(2000);
    await exec(`UPDATE appointments SET status = 'rescheduled', deposit_paid_cents = 0
                 WHERE id = '${AGENDAMENTO}'`);

    await expect(sinalDoAgendamento(TENANT, LOCATION, AGENDAMENTO)).rejects.toMatchObject({
      code: 'agendamento_nao_encontrado',
    });
    await expect(
      devolverSinal({
        tenantId: TENANT,
        locationId: LOCATION,
        appointmentId: AGENDAMENTO,
        valorCents: 0,
        ...operador,
      }),
    ).rejects.toMatchObject({ code: 'agendamento_nao_encontrado' });
  });

  describe('devolver', () => {
    it('zera o pago, mantém o exigido e audita', async () => {
      /**
       * Apagar os dois faria a devolução parecer que nunca houve sinal. O
       * exigido é o registro de que ele foi cobrado um dia, e é o que a trilha
       * cruza para contar a história inteira.
       */
      await exec(
        agendamento({ exigidoCents: 2000, status: 'cancelled_customer', canceladoHorasAntes: 48 }),
      );
      await registrar(2000);

      const depois = await devolverSinal({
        tenantId: TENANT,
        locationId: LOCATION,
        appointmentId: AGENDAMENTO,
        valorCents: 0,
        ...operador,
      });
      expect(depois).toMatchObject({ pagoCents: 0, exigidoCents: 2000 });
      expect((await trilha()).map((l) => l.action)).toEqual([
        'deposit.received',
        'deposit.refunded',
      ]);
    });

    it('não devolve o que não foi registrado', async () => {
      await exec(agendamento({ exigidoCents: 2000 }));
      await expect(
        devolverSinal({
          tenantId: TENANT,
          locationId: LOCATION,
          appointmentId: AGENDAMENTO,
          valorCents: 0,
          ...operador,
        }),
      ).rejects.toMatchObject({ code: 'sinal_nao_registrado' });
    });
  });
});
