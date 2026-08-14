import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TETO_POR_MINUTO } from '@barbearia/core';
import { autenticarChave, chavesDaCasa, criarChave, revogarChave } from './apikey.js';

/**
 * Chave de API contra Postgres real (bloco 78).
 *
 * O que só o banco prova: que o segredo não fica em lugar nenhum, que a chave da
 * vizinha não é encontrada de dentro da barbearia, que o teto é **por chave** e
 * vale entre processos, e que dinheiro não entra num escopo.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const CASA = '78787878-1111-1111-1111-111111111111';
const VIZINHA = '78787878-2222-2222-2222-222222222222';
const DONO = '78787878-d000-0000-0000-000000000001';

const TODAS = [
  'appointments.view',
  'appointments.create',
  'customers.view',
  'team.manage',
] as const;

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

const AGORA = new Date('2026-10-05T14:30:20Z');

describeIfDb('chave de API', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    process.env['API_KEY_PEPPER'] = 'pepper-de-teste-0123456789';
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await exec(`
      INSERT INTO tenants (id, name) VALUES
        ('${CASA}', 'Barbearia Dock'), ('${VIZINHA}', 'Casa Vizinha');

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${DONO}', '${CASA}', 'Matheus', 'dono@dock.com.br', 'x', 'owner')
    `);
  });

  const criar = (escopos: readonly string[] = ['appointments.view']) =>
    criarChave({
      tenantId: CASA,
      staffId: DONO,
      staffName: 'Matheus',
      nome: 'Integração do site',
      escopos,
      escoposDoAtor: [...TODAS],
    });

  it('o segredo existe uma vez, e o banco guarda só o HMAC', async () => {
    const { chave, prefixo } = await criar();

    expect(chave.startsWith('bd_')).toBe(true);
    expect(chave).toContain(`${prefixo}.`);

    const [linha] = await admin.$queryRawUnsafe<{ secret_hmac: string }[]>(
      `SELECT secret_hmac FROM api_keys WHERE prefix = '${prefixo}'`,
    );
    const segredo = chave.split('.')[1] ?? '';
    expect(segredo.length).toBeGreaterThan(30);
    expect(linha?.secret_hmac).not.toContain(segredo);

    // E a listagem nunca traz o segredo.
    const listadas = await chavesDaCasa(CASA);
    expect(JSON.stringify(listadas)).not.toContain(segredo);
  });

  it('a chave certa autentica; a errada, a de outra casa e a inventada não', async () => {
    const { chave } = await criar();
    const boa = await autenticarChave(chave, AGORA);
    expect(boa.ok && boa.chave.tenantId).toBe(CASA);

    const [prefixo = '', segredo = ''] = chave.replace('bd_', '').split('.');
    const trocado = `bd_${prefixo}.${segredo.slice(0, -1)}X`;
    expect(await autenticarChave(trocado, AGORA)).toEqual({ ok: false, recusa: 'invalida' });

    expect(await autenticarChave('bd_000000000000.qualquercoisaqueseja1234567890', AGORA)).toEqual({
      ok: false,
      recusa: 'invalida',
    });
    expect(await autenticarChave('sem-formato', AGORA)).toEqual({ ok: false, recusa: 'invalida' });
  });

  it('o uso é carimbado — e "nunca usada" na tela quer dizer nunca usada', async () => {
    /**
     * O `UPDATE` direto alcançava zero linhas em silêncio: a autenticação roda
     * sem tenant, e a política de escrita de `api_keys` exige um. A coluna
     * ficava nula para sempre, e a tela afirmava "nunca usada" sobre a chave
     * que estava sendo usada naquele instante — a única pista de uso do produto
     * dizendo o contrário da verdade, justamente na tela em que alguém decide
     * qual chave revogar depois de um vazamento.
     */
    const { prefixo, chave } = await criar();

    const [antes] = await admin.$queryRawUnsafe<{ last_used_at: Date | null }[]>(
      `SELECT last_used_at FROM api_keys WHERE prefix = '${prefixo}'`,
    );
    expect(antes?.last_used_at).toBeNull();

    expect((await autenticarChave(chave, AGORA)).ok).toBe(true);

    const [depois] = await admin.$queryRawUnsafe<{ last_used_at: Date | null }[]>(
      `SELECT last_used_at FROM api_keys WHERE prefix = '${prefixo}'`,
    );
    expect(depois?.last_used_at).not.toBeNull();
    expect(depois?.last_used_at?.toISOString()).toBe(AGORA.toISOString());

    expect((await chavesDaCasa(CASA))[0]?.usadaEm).not.toBeNull();
  });

  it('a chave da vizinha não é vista nem revogada de dentro da barbearia', async () => {
    /**
     * A leitura sem tenant existe porque a autenticação acontece antes de haver
     * tenant no contexto. **Com** tenant, a política separa as barbearias — e a
     * consulta roda sem filtro de propósito.
     */
    await exec(`
      INSERT INTO api_keys (tenant_id, name, prefix, secret_hmac, scopes)
      VALUES ('${VIZINHA}', 'Da vizinha', 'abcabcabcabc', 'x', ARRAY['appointments.view'])
    `);

    expect((await chavesDaCasa(CASA)).map((c) => c.prefixo)).not.toContain('abcabcabcabc');

    const daVizinha = await admin.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM api_keys WHERE prefix = 'abcabcabcabc'`,
    );
    await expect(
      revogarChave({
        tenantId: CASA,
        staffId: DONO,
        staffName: 'Matheus',
        chaveId: daVizinha[0]?.id ?? '',
        motivo: 'sabotagem da vizinha',
      }),
    ).rejects.toThrow(/não encontrada/i);
  });

  it('revogada responde revogada, e não continua funcionando', async () => {
    const { id, chave } = await criar();
    expect((await autenticarChave(chave, AGORA)).ok).toBe(true);

    await revogarChave({
      tenantId: CASA,
      staffId: DONO,
      staffName: 'Matheus',
      chaveId: id,
      motivo: 'integração desligada',
    });

    expect(await autenticarChave(chave, AGORA)).toEqual({ ok: false, recusa: 'revogada' });
  });

  it('o teto é por chave e por minuto, e vira no minuto seguinte', async () => {
    const { chave } = await criar();

    for (let i = 0; i < TETO_POR_MINUTO; i += 1) {
      const r = await autenticarChave(chave, AGORA);
      expect(r.ok, `a chamada ${i + 1} devia passar`).toBe(true);
    }
    expect(await autenticarChave(chave, AGORA)).toEqual({ ok: false, recusa: 'excedeu' });

    // Vinte segundos depois ainda é o mesmo minuto.
    expect(await autenticarChave(chave, new Date(AGORA.getTime() + 20_000))).toEqual({
      ok: false,
      recusa: 'excedeu',
    });
    // No minuto seguinte a cota é outra.
    expect((await autenticarChave(chave, new Date(AGORA.getTime() + 60_000))).ok).toBe(true);
  });

  it('chave inválida não gasta a cota da chave de ninguém', async () => {
    /**
     * A cota é conferida **depois** do segredo, de propósito: contar chamada de
     * chave inválida deixaria qualquer um esgotar a cota de uma chave alheia
     * mandando o prefixo dela com segredo errado.
     */
    const { chave } = await criar();
    const [prefixo = ''] = chave.replace('bd_', '').split('.');

    for (let i = 0; i < 50; i += 1) {
      await autenticarChave(`bd_${prefixo}.segredoerradomasdotamanhocerto123456`, AGORA);
    }

    const [uso] = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM api_key_usage`,
    );
    expect(Number(uso?.n)).toBe(0);
    expect((await autenticarChave(chave, AGORA)).ok).toBe(true);
  });

  it('dinheiro não entra num escopo, e o domínio recusa antes do banco', async () => {
    await expect(criar(['appointments.view', 'finance.view'])).rejects.toThrow(/escopo/i);
    await expect(criar(['cashier.withdraw'])).rejects.toThrow(/escopo/i);
    await expect(criar(['commission.view_all'])).rejects.toThrow(/escopo/i);
    // E a exportação da base, que é ato de LGPD e não integração.
    await expect(criar(['customers.export'])).rejects.toThrow(/escopo/i);
    await expect(criar([])).rejects.toThrow(/escopo/i);
    await expect(criar(['inventado.demais'])).rejects.toThrow(/escopo/i);
  });

  it('ninguém dá a uma chave a permissão que não tem', async () => {
    /**
     * O que o ator tem sai do **banco**, nunca do formulário. Sem isso, criar
     * uma chave seria o caminho curto para se dar a permissão que o papel não
     * tem — o defeito que o bloco 30 fechou para papéis.
     */
    await expect(
      criarChave({
        tenantId: CASA,
        staffId: DONO,
        staffName: 'Matheus',
        nome: 'Ampla demais',
        escopos: ['settings.manage'],
        escoposDoAtor: ['appointments.view'],
      }),
    ).rejects.toThrow(/não tem/i);
  });

  it('a trilha registra a chave e o escopo, nunca o segredo', async () => {
    const { chave, prefixo } = await criar(['appointments.view', 'appointments.create']);
    const segredo = chave.split('.')[1] ?? '';

    const [linha] = await admin.$queryRawUnsafe<{ action: string; after: unknown }[]>(
      `SELECT action, after FROM audit_log WHERE action = 'api_key.created'`,
    );
    expect(linha?.action).toBe('api_key.created');
    const registrado = JSON.stringify(linha?.after);
    expect(registrado).toContain(prefixo);
    expect(registrado).toContain('appointments.create');
    expect(registrado).not.toContain(segredo);
  });

  it('sem `API_KEY_PEPPER` a emissão falha alto, e não cai num padrão fraco', async () => {
    const antes = process.env['API_KEY_PEPPER'];
    delete process.env['API_KEY_PEPPER'];
    try {
      await expect(criar()).rejects.toThrow(/API_KEY_PEPPER/);
    } finally {
      process.env['API_KEY_PEPPER'] = antes;
    }
  });
});
