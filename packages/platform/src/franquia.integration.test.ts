import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  casasDaFranquia,
  criarFranquia,
  entrarNaFranquia,
  franquiasNaPlataforma,
  sairDaFranquia,
} from './franquia.js';

/**
 * Montar uma franquia, do lado da plataforma (bloco 76).
 *
 * O que só o banco prova: que a permissão de publicar nasce junto da
 * franqueadora e de mais ninguém, que a franqueadora não sai, e que a barbearia
 * que já é de uma rede não entra na segunda.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const ADMIN = 'aa767676-0000-0000-0000-000000000001';
const DONA = '76767676-1111-1111-1111-11111111aaaa';
const FILHA = '76767676-2222-2222-2222-22222222aaaa';
const AVULSA = '76767676-3333-3333-3333-33333333aaaa';

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

describeIfDb('montar uma franquia', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await admin.$executeRawUnsafe('TRUNCATE franchises CASCADE');
    await admin.$executeRawUnsafe('TRUNCATE platform_admins CASCADE');
    await exec(`
      INSERT INTO tenants (id, name) VALUES
        ('${DONA}', 'Barbearia Dock'),
        ('${FILHA}', 'Dock Feira'),
        ('${AVULSA}', 'Casa Avulsa');

      INSERT INTO platform_admins (id, name, email_key, password_hash, role)
      VALUES ('${ADMIN}', 'Super', 'chave-76', 'x', 'operator')
    `);
  });

  it('a franqueadora nasce com a permissão de publicar, e as outras não', async () => {
    /**
     * `franchise.manage` não entra em papel nenhum por omissão: a barbearia
     * comum não é franqueadora, e uma permissão que nasce concedida na base
     * inteira é permissão que ninguém decidiu dar. A plataforma concede no
     * único instante em que se sabe — o de marcar a barbearia como franqueadora.
     */
    const { id } = await criarFranquia({
      adminId: ADMIN,
      nome: 'Rede Dock',
      franqueadoraTenantId: DONA,
    });
    await entrarNaFranquia({ adminId: ADMIN, franquiaId: id, tenantId: FILHA });

    const linhas = await admin.$queryRawUnsafe<{ tenant_id: string }[]>(
      `SELECT tenant_id FROM role_permissions WHERE permission = 'franchise.manage'`,
    );
    expect(linhas.map((l) => l.tenant_id)).toEqual([DONA]);
  });

  it('quem entra depois entra como franqueada, e o papel não é escolhível', async () => {
    const { id } = await criarFranquia({
      adminId: ADMIN,
      nome: 'Rede Dock',
      franqueadoraTenantId: DONA,
    });
    await entrarNaFranquia({ adminId: ADMIN, franquiaId: id, tenantId: FILHA });

    const casas = await casasDaFranquia(id);
    expect(casas.map((c) => [c.nome, c.papel])).toEqual([
      ['Barbearia Dock', 'franqueadora'],
      ['Dock Feira', 'franqueada'],
    ]);
  });

  it('uma barbearia não é de duas franquias', async () => {
    // Duas seriam dois cardápios padrão sobre o mesmo catálogo, e a pergunta
    // "qual é o preço de referência deste corte?" passaria a ter duas respostas.
    const primeira = await criarFranquia({
      adminId: ADMIN,
      nome: 'Rede Dock',
      franqueadoraTenantId: DONA,
    });
    const segunda = await criarFranquia({
      adminId: ADMIN,
      nome: 'Rede Vizinha',
      franqueadoraTenantId: AVULSA,
    });

    await entrarNaFranquia({ adminId: ADMIN, franquiaId: primeira.id, tenantId: FILHA });
    await expect(
      entrarNaFranquia({ adminId: ADMIN, franquiaId: segunda.id, tenantId: FILHA }),
    ).rejects.toThrow(/já é de uma franquia/i);
  });

  it('a franqueada sai; a franqueadora não', async () => {
    /**
     * Sem a franqueadora a rede fica com um cardápio que ninguém publica — e a
     * franqueada continuaria lendo um padrão congelado para sempre. Dissolver a
     * rede é outra operação, e ela não existe.
     */
    const { id } = await criarFranquia({
      adminId: ADMIN,
      nome: 'Rede Dock',
      franqueadoraTenantId: DONA,
    });
    await entrarNaFranquia({ adminId: ADMIN, franquiaId: id, tenantId: FILHA });

    await sairDaFranquia({ adminId: ADMIN, tenantId: FILHA });
    expect((await casasDaFranquia(id)).map((c) => c.papel)).toEqual(['franqueadora']);

    await expect(sairDaFranquia({ adminId: ADMIN, tenantId: DONA })).rejects.toThrow(
      /não sai/i,
    );
  });

  it('a lista da plataforma conta franqueadas e itens do padrão', async () => {
    const { id } = await criarFranquia({
      adminId: ADMIN,
      nome: 'Rede Dock',
      franqueadoraTenantId: DONA,
    });
    await entrarNaFranquia({ adminId: ADMIN, franquiaId: id, tenantId: FILHA });
    await exec(`
      INSERT INTO franchise_services (franchise_id, name, reference_price_cents, duration_minutes)
      VALUES ('${id}', 'Corte', 5500, 30), ('${id}', 'Barba', 3500, 20)
    `);

    const lista = await franquiasNaPlataforma();
    expect(lista).toHaveLength(1);
    expect(lista[0]?.nome).toBe('Rede Dock');
    expect(lista[0]?.franqueadora).toBe('Barbearia Dock');
    expect(lista[0]?.franqueadas).toBe(1);
    expect(lista[0]?.itensNoPadrao).toBe(2);
  });

  it('sair da rede deixa o catálogo de pé', async () => {
    /**
     * O corte que a franqueada vende há dois anos não some porque um contrato
     * acabou: `appointment_services` aponta para `services.id`, e apagar levaria
     * o passado junto. O que muda é a leitura do padrão, que passa a devolver
     * vazio.
     */
    const { id } = await criarFranquia({
      adminId: ADMIN,
      nome: 'Rede Dock',
      franqueadoraTenantId: DONA,
    });
    await entrarNaFranquia({ adminId: ADMIN, franquiaId: id, tenantId: FILHA });
    await exec(`
      INSERT INTO franchise_services (id, franchise_id, name, reference_price_cents, duration_minutes)
      VALUES ('76767676-9999-9999-9999-999999999999', '${id}', 'Corte', 5500, 30);

      INSERT INTO services (tenant_id, name, price_cents, duration_minutes,
                            franchise_service_id, adopted_at)
      VALUES ('${FILHA}', 'Corte', 4500, 30,
              '76767676-9999-9999-9999-999999999999', now())
    `);

    await sairDaFranquia({ adminId: ADMIN, tenantId: FILHA });

    const [servico] = await admin.$queryRawUnsafe<{ active: boolean; price_cents: number }[]>(
      `SELECT active, price_cents FROM services WHERE tenant_id = '${FILHA}'`,
    );
    expect(servico?.active).toBe(true);
    expect(Number(servico?.price_cents)).toBe(4500);
  });
});
