import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { perfilPublicoDoBarbeiro } from './barbeiro.js';
import { getPublicProfile } from './profile.js';

/**
 * A página pública do barbeiro contra Postgres real (bloco 73, SPEC §5.2).
 *
 * O que só o banco prova: que o perfil só existe com os três interruptores
 * ligados, que a nota é a mesma da casa e some abaixo do mínimo, e que a página
 * da barbearia passa a linkar quem tem perfil — e continua levando ao
 * agendamento quem não tem.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const CASA = '73707070-1111-1111-1111-111111111111';
const LOCAL = '73aaaaaa-0000-0000-0000-000000000001';
const JOAO = '73bbbbbb-0000-0000-0000-000000000001';
const SEM_PERFIL = '73bbbbbb-0000-0000-0000-000000000002';
const CLIENTE = '73cccccc-0000-0000-0000-000000000001';
const AGORA = new Date('2026-08-20T16:00:00Z');

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

describeIfDb('a página pública do barbeiro', () => {
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
      VALUES ('${CASA}', 'Barbearia do Bloco 73', now());

      INSERT INTO tenant_slugs (tenant_id, slug, is_primary)
      VALUES ('${CASA}', 'bloco-73', true);

      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('${LOCAL}', '${CASA}', 'Matriz', 'America/Bahia');

      INSERT INTO professionals
        (id, tenant_id, location_id, name, kind, public_profile, public_slug, specialties)
      VALUES
        ('${JOAO}', '${CASA}', '${LOCAL}', 'João Silva', 'professional', true, 'joao-silva',
         ARRAY['fade', 'barba']),
        -- Com endereco e SEM perfil ligado, de proposito: com public_slug nulo
        -- a consulta nao acharia a linha de qualquer jeito, e o teste passaria
        -- sem exercitar a guarda que ele existe para provar. Foi assim na
        -- primeira versao — desligar public_profile do WHERE nao deixava nada
        -- vermelho.
        ('${SEM_PERFIL}', '${CASA}', '${LOCAL}', 'Gleidson', 'professional', false, 'gleidson',
         ARRAY[]::text[]);

      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('${CLIENTE}', '${CASA}', 'Carlos', '+5571988887777')
    `);
  }, 30_000);

  it('o perfil sai com nome, especialidades e a contagem de atendimentos', async () => {
    await exec(`
      INSERT INTO appointments
        (tenant_id, location_id, professional_id, customer_id, status,
         starts_at, ends_at, service_starts_at, service_ends_at)
      SELECT '${CASA}', '${LOCAL}', '${JOAO}', '${CLIENTE}', 'completed',
             d, d + interval '30 minutes', d, d + interval '30 minutes'
        FROM generate_series(
               timestamptz '2026-08-01 12:00Z', timestamptz '2026-08-03 12:00Z',
               interval '1 day') AS d
    `);

    const perfil = await perfilPublicoDoBarbeiro(CASA, 'joao-silva', AGORA);
    expect(perfil?.nome).toBe('João Silva');
    expect(perfil?.especialidades).toEqual(['fade', 'barba']);
    expect(perfil?.atendimentos).toBe(3);
  });

  it('perfil desligado não existe, e quem saiu da casa também não', async () => {
    /**
     * Um perfil no ar para quem saiu da barbearia é o pior link que este
     * produto pode ter: a página continua indexada, o cliente clica em
     * "Agendar com João" e descobre no balcão que o João não trabalha mais ali.
     */
    expect(await perfilPublicoDoBarbeiro(CASA, 'gleidson', AGORA)).toBeNull();

    await exec(`UPDATE professionals SET active = false WHERE id = '${JOAO}'`);
    expect(await perfilPublicoDoBarbeiro(CASA, 'joao-silva', AGORA)).toBeNull();
  });

  it('a nota é a pública, com o mesmo mínimo da casa', async () => {
    // Uma avaliação só: abaixo do mínimo, a nota não sai — "5,0 de uma
    // avaliação é ruído estatístico com cara de excelência". A contagem sai.
    await exec(`
      INSERT INTO reviews (tenant_id, customer_id, professional_id, rating)
      VALUES ('${CASA}', '${CLIENTE}', '${JOAO}', 5)
    `);

    const perfil = await perfilPublicoDoBarbeiro(CASA, 'joao-silva', AGORA);
    expect(perfil?.notaBps).toBeNull();
    expect(perfil?.avaliacoes).toBe(1);
  });

  it('unidade fechada tira a página do ar', async () => {
    /**
     * Fechar uma filial não desliga quem trabalhava nela. Sem a junção com
     * `locations`, os barbeiros dela ficavam com página indexada e um botão
     * "Agendar com X" que funciona — e ninguém notaria, porque a página da casa
     * lista só a unidade mais antiga. Achado da `/security-review` do bloco 73.
     */
    await exec(`UPDATE locations SET active = false WHERE id = '${LOCAL}'`);
    expect(await perfilPublicoDoBarbeiro(CASA, 'joao-silva', AGORA)).toBeNull();
  });

  it('a nota do colega não entra na do barbeiro', async () => {
    // `reviews.professional_id` decide de quem é a nota 1, e é congelado desde
    // o bloco 46. Sem o filtro, a média da casa apareceria na página de todos.
    await exec(`
      INSERT INTO reviews (tenant_id, customer_id, professional_id, rating) VALUES
        ('${CASA}', '${CLIENTE}', '${JOAO}', 5),
        ('${CASA}', '${CLIENTE}', '${JOAO}', 5),
        ('${CASA}', '${CLIENTE}', '${JOAO}', 4),
        ('${CASA}', '${CLIENTE}', '${SEM_PERFIL}', 1),
        ('${CASA}', '${CLIENTE}', '${SEM_PERFIL}', 1)
    `);

    const perfil = await perfilPublicoDoBarbeiro(CASA, 'joao-silva', AGORA);
    expect(perfil?.avaliacoes).toBe(3);
    /**
     * (5 + 5 + 4) / 3 = 4,666… e a nota deste produto tem **uma** casa desde o
     * bloco 43: `media` arredonda para 4,7. A primeira versão desta expectativa
     * dizia 467, e o suspeito era o código — não era: a precisão de uma casa é
     * decisão daquele bloco, e a página do barbeiro segue a da casa para as
     * duas não discordarem sobre a mesma pessoa.
     */
    expect(perfil?.notaBps).toBe(470);
  });

  it('a página da casa aponta para quem tem perfil, e só para esses', async () => {
    /**
     * O cartão do profissional levava a `/{slug}/p/{id}`, um endereço que nunca
     * existiu — caminho de ida sem chegada na tela em que a decisão acontece
     * (§6, pergunta 1). Quem não tem perfil continua levando ao agendamento.
     */
    const casa = await getPublicProfile(CASA, 'bloco-73', AGORA);
    const joao = casa?.professionals.find((p) => p.id === JOAO);
    const outro = casa?.professionals.find((p) => p.id === SEM_PERFIL);

    expect(joao?.perfilPublico).toBe('joao-silva');
    expect(outro?.perfilPublico).toBeNull();
  });
});
