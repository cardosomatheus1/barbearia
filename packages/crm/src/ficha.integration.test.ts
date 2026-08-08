import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@barbearia/db';
import { PREFERENCIAS_VAZIAS, fichaEstaVazia } from '@barbearia/core';
import { FichaError, lerFicha, salvarPreferencias } from './ficha.js';

/**
 * A ficha do cliente contra Postgres real.
 *
 * O que se prova aqui: que a anotação de uma barbearia não vaza para a outra —
 * nem na leitura nem na escrita —, e que a linha do tempo diz a verdade sobre
 * quem faltou. Mock não prova nada sobre RLS.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];

const TENANT = '11111111-1111-1111-1111-111111111111';
const RIVAL = '22222222-2222-2222-2222-222222222222';
const LOCATION = 'aaaaaaaa-0000-0000-0000-000000000001';
const LOCAL_RIVAL = 'aaaaaaaa-0000-0000-0000-000000000002';
const RUAN = 'bbbbbbbb-0000-0000-0000-000000000001';
const CARLOS = 'cccccccc-0000-0000-0000-000000000001';
const BARBEIRO = 'dddddddd-0000-0000-0000-000000000001';
const CORTE = 'eeeeeeee-0000-0000-0000-000000000001';

let admin: PrismaClient;
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

async function exec(client: PrismaClient, sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await client.$executeRawUnsafe(parte);
  }
}

/** Um atendimento no passado, com serviço. */
async function visita(
  id: string,
  quando: string,
  status: string,
  precoCents = 6000,
): Promise<void> {
  const fim = new Date(new Date(quando).getTime() + 30 * 60_000).toISOString();
  await exec(admin, `
    INSERT INTO appointments
      (id, tenant_id, location_id, customer_id, professional_id,
       starts_at, ends_at, service_starts_at, service_ends_at, price_cents, status)
    VALUES ('${id}', '${TENANT}', '${LOCATION}', '${CARLOS}', '${RUAN}',
            '${quando}', '${fim}', '${quando}', '${fim}', ${precoCents}, '${status}');

    INSERT INTO appointment_services
      (appointment_id, service_id, tenant_id, position, price_cents, duration_minutes)
    VALUES ('${id}', '${CORTE}', '${TENANT}', 0, ${precoCents}, 30);
  `);
}

describeIfDb('a ficha do cliente', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await exec(admin, `
      INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Domari'), ('${RIVAL}', 'Rival');

      INSERT INTO locations (id, tenant_id, name, timezone) VALUES
        ('${LOCATION}', '${TENANT}', 'Matriz', 'America/Bahia'),
        ('${LOCAL_RIVAL}', '${RIVAL}', 'Rival', 'America/Bahia');

      INSERT INTO professionals (id, tenant_id, location_id, name, kind)
      VALUES ('${RUAN}', '${TENANT}', '${LOCATION}', 'Ruan', 'professional');

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes)
      VALUES ('${CORTE}', '${TENANT}', 'Corte degradê', 6000, 30);

      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777');

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role, professional_id)
      VALUES ('${BARBEIRO}', '${TENANT}', 'Ruan Barbeiro', 'ruan@domari.com.br',
              'x', 'professional', '${RUAN}');
    `);
  });

  const anotar = (preferencias: Parameters<typeof salvarPreferencias>[0]['preferencias']) =>
    salvarPreferencias({
      tenantId: TENANT,
      customerId: CARLOS,
      staffUserId: BARBEIRO,
      preferencias,
    });

  // -- preferências ------------------------------------------------------------

  it('cliente sem anotação devolve ficha em branco, não erro', async () => {
    // A tela do barbeiro abre com o cliente sentado. Um erro aqui seria uma
    // tela vermelha no momento mais errado possível.
    const ficha = await lerFicha(TENANT, CARLOS);

    expect(ficha.nome).toBe('Carlos Souza');
    expect(fichaEstaVazia(ficha.preferencias)).toBe(true);
    expect(ficha.anotadoPor).toBeNull();
  });

  it('a anotação volta com quem escreveu', async () => {
    // Ninguém confia numa anotação sem dono: "não usar navalha" escrito por
    // quem saiu há dois anos vale menos que o de ontem.
    await anotar({ ...PREFERENCIAS_VAZIAS, produtosEvitar: 'Álcool no pós-barba' });

    const ficha = await lerFicha(TENANT, CARLOS);
    expect(ficha.preferencias.produtosEvitar).toBe('Álcool no pós-barba');
    expect(ficha.anotadoPor).toBe('Ruan Barbeiro');
    expect(ficha.anotadoEm).not.toBeNull();
  });

  it('anotar duas vezes atualiza, não duplica', async () => {
    await anotar({ ...PREFERENCIAS_VAZIAS, topo: 'Tesoura' });
    await anotar({ ...PREFERENCIAS_VAZIAS, topo: 'Máquina 3' });

    const ficha = await lerFicha(TENANT, CARLOS);
    expect(ficha.preferencias.topo).toBe('Máquina 3');

    const linhas = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM customer_preferences WHERE customer_id = '${CARLOS}'`,
    );
    expect(Number(linhas[0]?.n)).toBe(1);
  });

  it('campo apagado volta a ser vazio, não string em branco', async () => {
    // Com `''` no banco, a ficha pareceria preenchida sem nada escrito nela.
    await anotar({ ...PREFERENCIAS_VAZIAS, topo: 'Tesoura' });
    await anotar({ ...PREFERENCIAS_VAZIAS, topo: '   ' });

    const ficha = await lerFicha(TENANT, CARLOS);
    expect(ficha.preferencias.topo).toBeNull();
    expect(fichaEstaVazia(ficha.preferencias)).toBe(true);
  });

  it('preferência de conversa fora do vocabulário é recusada', async () => {
    await expect(
      anotar({ ...PREFERENCIAS_VAZIAS, conversa: 'quieto' as never }),
    ).rejects.toMatchObject({ code: 'preferencia_invalida' });
  });

  // -- linha do tempo ----------------------------------------------------------

  it('a linha do tempo vem da visita mais recente para trás', async () => {
    await visita('f0000000-0000-0000-0000-000000000001', '2026-06-10T14:00:00Z', 'completed');
    await visita('f0000000-0000-0000-0000-000000000002', '2026-07-10T14:00:00Z', 'completed');

    const ficha = await lerFicha(TENANT, CARLOS);
    expect(ficha.linhaDoTempo.map((v) => v.quando.slice(0, 10))).toEqual([
      '2026-07-10',
      '2026-06-10',
    ]);
    expect(ficha.linhaDoTempo[0]?.servicos).toEqual(['Corte degradê']);
    expect(ficha.linhaDoTempo[0]?.profissional).toBe('Ruan');
  });

  it('falta e cancelamento aparecem na linha do tempo', async () => {
    /**
     * É a informação que muda o atendimento: quem faltou duas vezes seguidas
     * merece uma confirmação a mais. Mostrar só o que deu certo faria a tela
     * mentir por omissão.
     */
    await visita('f0000000-0000-0000-0000-000000000003', '2026-06-10T14:00:00Z', 'no_show');
    await visita('f0000000-0000-0000-0000-000000000004', '2026-07-10T14:00:00Z', 'cancelled_customer');

    const ficha = await lerFicha(TENANT, CARLOS);
    expect(ficha.linhaDoTempo.map((v) => v.status)).toEqual(['cancelled_customer', 'no_show']);
  });

  it('o que ainda vai acontecer não é linha do tempo', async () => {
    // Agendamento futuro é agenda, não histórico. Misturar os dois faria a
    // contagem de visitas incluir quem ainda não veio.
    await visita('f0000000-0000-0000-0000-000000000005', '2027-01-10T14:00:00Z', 'confirmed');

    const ficha = await lerFicha(TENANT, CARLOS);
    expect(ficha.linhaDoTempo).toHaveLength(0);
    expect(ficha.visitas).toBe(0);
  });

  it('só atendimento concluído conta como visita', async () => {
    await visita('f0000000-0000-0000-0000-000000000006', '2026-05-10T14:00:00Z', 'completed');
    await visita('f0000000-0000-0000-0000-000000000007', '2026-06-10T14:00:00Z', 'no_show');

    const ficha = await lerFicha(TENANT, CARLOS);
    expect(ficha.visitas).toBe(1);
    expect(ficha.desde?.slice(0, 10)).toBe('2026-05-10');
  });

  it('a linha do tempo tem teto', async () => {
    // A tela abre no celular com o cliente na cadeira; a vida inteira não cabe.
    for (let i = 0; i < 14; i += 1) {
      const dia = String(10 + i).padStart(2, '0');
      await visita(
        `f0000000-0000-0000-0000-0000000001${String(i).padStart(2, '0')}`,
        `2026-06-${dia}T14:00:00Z`,
        'completed',
      );
    }

    const ficha = await lerFicha(TENANT, CARLOS);
    expect(ficha.linhaDoTempo).toHaveLength(10);
    // O teto corta o passado, nunca o presente.
    expect(ficha.linhaDoTempo[0]?.quando.slice(0, 10)).toBe('2026-06-23');
    expect(ficha.visitas).toBe(14);
  });

  it('o telefone inteiro não sai na ficha', async () => {
    // A tela do barbeiro fica virada para o salão enquanto ele corta.
    const ficha = await lerFicha(TENANT, CARLOS);
    expect(ficha.telefoneFinal).toBe('7777');
    expect(JSON.stringify(ficha)).not.toContain('988887777');
  });

  // -- a parede entre barbearias -----------------------------------------------

  it('a ficha de um cliente não existe para a outra barbearia', async () => {
    await anotar({ ...PREFERENCIAS_VAZIAS, observacoes: 'segredo da casa' });

    await expect(lerFicha(RIVAL, CARLOS)).rejects.toMatchObject({
      code: 'cliente_nao_encontrado',
    });
  });

  it('a rival não escreve na ficha de um cliente da casa', async () => {
    /**
     * A chave estrangeira **não** protege: a checagem de integridade
     * referencial do Postgres ignora row security. O que recusa é o `SELECT`
     * sob RLS antes do `INSERT` — o mesmo padrão de `exigirDoTenant`.
     */
    await expect(
      salvarPreferencias({
        tenantId: RIVAL,
        customerId: CARLOS,
        staffUserId: BARBEIRO,
        preferencias: { ...PREFERENCIAS_VAZIAS, observacoes: 'anotação plantada' },
      }),
    ).rejects.toMatchObject({ code: 'cliente_nao_encontrado' });

    const linhas = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM customer_preferences`,
    );
    expect(Number(linhas[0]?.n)).toBe(0);
  });

  it('consulta sem filtro de tenant devolve zero linhas para a rival', async () => {
    // Quem filtra é a política, não o `WHERE` do repositório.
    await anotar({ ...PREFERENCIAS_VAZIAS, topo: 'Tesoura' });

    const daRival = await withTenant(RIVAL, async (tx) =>
      tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM customer_preferences`,
    );
    expect(Number(daRival[0]?.n)).toBe(0);
  });

  it('cliente inexistente responde igual a cliente de outra barbearia', async () => {
    // Distinguir os dois seria um oráculo: com uma conta grátis dava para
    // perguntar "este id existe na plataforma?".
    const inventado = '99999999-9999-9999-9999-999999999999';
    await expect(lerFicha(TENANT, inventado)).rejects.toBeInstanceOf(FichaError);
    await expect(lerFicha(RIVAL, CARLOS)).rejects.toBeInstanceOf(FichaError);
  });
});
