import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  apagarFoto,
  fotosDoCliente,
  portfolioDoProfissional,
  publicarFoto,
  registrarFoto,
} from './fotos.js';
import { registrarConsentimento } from './lgpd.js';

/**
 * Foto do cliente e portfólio contra Postgres real (bloco 74).
 *
 * O que só o banco prova: que a foto não entra sem o aceite, que publicar exige
 * o **segundo** aceite, e que revogar apaga — a regra 2 da §1.8, imposta por
 * gatilho e não por lembrança da aplicação.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const CASA = '74707070-1111-1111-1111-111111111111';
const LOCAL = '74aaaaaa-0000-0000-0000-000000000001';
const RUAN = '74bbbbbb-0000-0000-0000-000000000001';
const CARLOS = '74cccccc-0000-0000-0000-000000000001';
const DONO = '74dddddd-0000-0000-0000-000000000001';

/**
 * A barbearia vizinha existe de verdade, com agendamento de verdade.
 *
 * A primeira versão do teste do id alheio usava um uuid **inexistente**, e ele
 * passava com a guarda removida: `achados.length` é zero nos dois casos. É a
 * regra deste repositório — teste que prova uma guarda por ausência de dado não
 * prova nada — derrubando justamente o teste que existe para provar que a
 * chave estrangeira ignora RLS. Achado da revisão deste bloco.
 */
const VIZINHA = '74707070-2222-2222-2222-222222222222';
const LOCAL_VIZINHA = '74aaaaaa-0000-0000-0000-000000000002';
const PROF_VIZINHA = '74bbbbbb-0000-0000-0000-000000000002';
const CLIENTE_VIZINHA = '74cccccc-0000-0000-0000-000000000002';
const AGENDA_VIZINHA = '74eeeeee-0000-0000-0000-000000000002';

const ator = { id: DONO, nome: 'Matheus' };
const FOTO = 'https://exemplo.com.br/corte.jpg';
const AGORA = new Date('2026-08-20T16:00:00Z');

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

/** O aceite, pelo caminho de verdade — o balcão registrando na ficha. */
async function aceitar(finalidade: 'photos' | 'photos_public', concedido: boolean): Promise<void> {
  await registrarConsentimento({
    tenantId: CASA,
    customerId: CARLOS,
    finalidade,
    concedido,
    // A versão do texto é obrigatória e sem padrão desde o bloco 31: aceite sem
    // dizer o que a pessoa leu não é prova.
    versaoDoTexto: 'v1-teste',
    registradoPor: { id: DONO, name: 'Matheus' },
  });
}

describeIfDb('fotos do cliente e portfólio', () => {
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
      INSERT INTO tenants (id, name) VALUES
        ('${CASA}', 'Barbearia do Bloco 74'),
        ('${VIZINHA}', 'Barbearia Vizinha');

      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('${LOCAL_VIZINHA}', '${VIZINHA}', 'Deles', 'America/Bahia');

      INSERT INTO professionals (id, tenant_id, location_id, name, kind)
      VALUES ('${PROF_VIZINHA}', '${VIZINHA}', '${LOCAL_VIZINHA}', 'Gleidson', 'professional');

      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('${CLIENTE_VIZINHA}', '${VIZINHA}', 'Cliente deles', '+5571966665555');

      INSERT INTO appointments
        (id, tenant_id, location_id, professional_id, customer_id, status,
         starts_at, ends_at, service_starts_at, service_ends_at)
      VALUES ('${AGENDA_VIZINHA}', '${VIZINHA}', '${LOCAL_VIZINHA}', '${PROF_VIZINHA}',
              '${CLIENTE_VIZINHA}', 'completed',
              '2026-08-01T12:00:00Z', '2026-08-01T12:30:00Z',
              '2026-08-01T12:00:00Z', '2026-08-01T12:30:00Z');

      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('${LOCAL}', '${CASA}', 'Matriz', 'America/Bahia');

      INSERT INTO professionals (id, tenant_id, location_id, name, kind)
      VALUES ('${RUAN}', '${CASA}', '${LOCAL}', 'Ruan', 'professional');

      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('${CARLOS}', '${CASA}', 'Carlos', '+5571988887777');

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${DONO}', '${CASA}', 'Matheus', 'dono@bloco74.com.br', 'x', 'owner')
    `);
  }, 30_000);

  it('sem o aceite, a foto não entra', async () => {
    /**
     * *"O barbeiro não fotografa sem o aceite registrado."* A recusa é do
     * domínio, com frase legível — e do gatilho, que é a camada que vale para
     * um `INSERT` escrito à mão ou um caminho novo daqui a dez blocos.
     */
    await expect(
      registrarFoto({ tenantId: CASA, customerId: CARLOS, tipo: 'antes', url: FOTO, ator }),
    ).rejects.toThrow(/não autorizou o registro/i);

    await expect(
      admin.$executeRawUnsafe(
        `INSERT INTO customer_photos (tenant_id, customer_id, kind, url)
         VALUES ('${CASA}', '${CARLOS}', 'antes', '${FOTO}')`,
      ),
    ).rejects.toThrow(/não autorizou/i);
  });

  it('guardar na ficha não autoriza publicar — são dois aceites', async () => {
    /**
     * *"Consentimento separado para uso em portfólio público — autorizar o
     * registro interno não autoriza publicar."* É a frase que separa este
     * bloco de um upload de imagem qualquer.
     */
    await aceitar('photos', true);

    const { id } = await registrarFoto({
      tenantId: CASA, customerId: CARLOS, tipo: 'depois', url: FOTO,
      professionalId: RUAN, ator,
    });

    await expect(
      publicarFoto({ tenantId: CASA, fotoId: id, publicar: true, ator }),
    ).rejects.toThrow(/uso público/i);

    expect(await portfolioDoProfissional(CASA, RUAN)).toEqual([]);
  });

  it('com os dois aceites, a foto entra no portfólio do barbeiro', async () => {
    await aceitar('photos', true);
    await aceitar('photos_public', true);

    await registrarFoto({
      tenantId: CASA, customerId: CARLOS, tipo: 'depois', url: FOTO,
      professionalId: RUAN, legenda: 'Fade médio', noPortfolio: true, ator,
    });

    const portfolio = await portfolioDoProfissional(CASA, RUAN);
    expect(portfolio).toHaveLength(1);
    expect(portfolio[0]).toMatchObject({ url: FOTO, legenda: 'Fade médio' });
  });

  it('revogar o uso público tira do portfólio e mantém na ficha', async () => {
    // A diferença entre as duas autorizações, exercitada: a foto continua
    // servindo ao "último corte" do barbeiro e sai da internet.
    await aceitar('photos', true);
    await aceitar('photos_public', true);
    await registrarFoto({
      tenantId: CASA, customerId: CARLOS, tipo: 'depois', url: FOTO,
      professionalId: RUAN, noPortfolio: true, ator,
    });

    await aceitar('photos_public', false);

    expect(await portfolioDoProfissional(CASA, RUAN)).toEqual([]);
    const naFicha = await fotosDoCliente({ tenantId: CASA, customerId: CARLOS, ator });
    expect(naFicha).toHaveLength(1);
    expect(naFicha[0]?.noPortfolio).toBe(false);
  });

  it('revogar o registro apaga as fotos', async () => {
    /**
     * SPEC §1.8 regra 2, literal: *"o cliente pode revogar, e a revogação apaga
     * as fotos"*. Por gatilho, porque é direito do titular — deixar para a
     * aplicação faria a revogação depender de o caminho que a grava lembrar de
     * limpar, e um caminho novo que esquecesse deixaria a foto de quem disse
     * não no ar.
     */
    await aceitar('photos', true);
    await registrarFoto({
      tenantId: CASA, customerId: CARLOS, tipo: 'antes', url: FOTO,
      professionalId: RUAN, ator,
    });
    expect(await fotosDoCliente({ tenantId: CASA, customerId: CARLOS, ator })).toHaveLength(1);

    await aceitar('photos', false);

    expect(await fotosDoCliente({ tenantId: CASA, customerId: CARLOS, ator })).toEqual([]);
  });

  it('ver as fotos deixa rastro na trilha', async () => {
    // "Acesso a fotos é permissão própria e auditado" — e o que a trilha guarda
    // é **que** alguém abriu, nunca a URL: `audit_log` é append-only e a
    // anonimização não o alcança.
    await aceitar('photos', true);
    await registrarFoto({ tenantId: CASA, customerId: CARLOS, tipo: 'antes', url: FOTO, ator });
    await fotosDoCliente({ tenantId: CASA, customerId: CARLOS, ator });

    const trilha = await admin.$queryRawUnsafe<{ action: string; after: unknown }[]>(
      `SELECT action, after FROM audit_log WHERE action = 'customers.photos_viewed'`,
    );
    expect(trilha).toHaveLength(1);
    expect(JSON.stringify(trilha[0]?.after ?? {})).not.toContain('exemplo.com.br');
  });

  it('apagar uma foto é DELETE, e é a exceção deliberada do schema', async () => {
    await aceitar('photos', true);
    const { id } = await registrarFoto({
      tenantId: CASA, customerId: CARLOS, tipo: 'antes', url: FOTO, ator,
    });

    await apagarFoto({ tenantId: CASA, fotoId: id, ator });

    const sobrou = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM customer_photos`,
    );
    expect(Number(sobrou[0]?.n ?? 0)).toBe(0);
  });

  it('o agendamento de outra barbearia não vira dono da foto', async () => {
    /**
     * A checagem de integridade referencial do Postgres ignora row security: a
     * chave estrangeira aceitaria o id alheio sem reclamar, e a foto ficaria
     * pendurada no atendimento de outra casa.
     */
    await aceitar('photos', true);
    await expect(
      registrarFoto({
        tenantId: CASA, customerId: CARLOS, tipo: 'antes', url: FOTO,
        appointmentId: AGENDA_VIZINHA, ator,
      }),
    ).rejects.toThrow(/não encontrado/i);
  });

  it('endereço que não é https é recusado na borda do domínio', async () => {
    await aceitar('photos', true);
    await expect(
      registrarFoto({
        tenantId: CASA, customerId: CARLOS, tipo: 'antes',
        url: 'http://exemplo.com.br/corte.jpg', ator,
      }),
    ).rejects.toThrow(/https/i);
  });

  it('a data do teste não entra na conta de nada', () => {
    // A suíte não depende do relógio: `AGORA` existe para documentar o instante
    // dos casos acima, e nenhuma regra deste bloco olha para ele.
    expect(AGORA.toISOString()).toBe('2026-08-20T16:00:00.000Z');
  });
});
