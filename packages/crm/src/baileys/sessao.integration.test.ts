import { PrismaClient } from '@prisma/client';
import { withTenant } from '@barbearia/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adquirirSessao, armazenamentoDeAuth, comPosse, desconectarBaileys, renovarSessao,
  selecionarCanal, solicitarConexaoBaileys, situacaoBaileys } from './sessao.js';

const TENANT = '63111111-1111-1111-1111-111111111111';
const RIVAL = '63222222-2222-2222-2222-222222222222';
const LOCATION = '63111111-0000-0000-0000-000000000001';
const STAFF = '63111111-0000-0000-0000-000000000002';
const OTHER_LOCATION = '63222222-0000-0000-0000-000000000001';
const ator = { tenantId: TENANT, locationId: LOCATION, staffId: STAFF, staffName: 'Operadora sintetica' };
const describeDb = process.env['SEED_DATABASE_URL'] && process.env['APP_DATABASE_URL'] ? describe : describe.skip;
let admin: PrismaClient;
describeDb('sessão Baileys com RLS e posse concorrente', () => {
  beforeAll(() => { admin = new PrismaClient({ datasources: { db: { url: process.env['SEED_DATABASE_URL'] ?? '' } } }); });
  afterAll(async () => { await admin?.$disconnect(); });
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(async () => {
    vi.stubEnv('BAILEYS_HABILITADO', '1'); vi.stubEnv('WHATSAPP_TOKEN_KEY', Buffer.alloc(32, 30).toString('base64'));
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await admin.$executeRaw`INSERT INTO tenants(id, name) VALUES (${TENANT}::uuid, 'Sintetica'), (${RIVAL}::uuid, 'Vizinha')`;
    await admin.$executeRaw`INSERT INTO locations(id, tenant_id, name) VALUES
      (${LOCATION}::uuid, ${TENANT}::uuid, 'Matriz'), (${OTHER_LOCATION}::uuid, ${RIVAL}::uuid, 'Vizinha')`;
    await admin.$executeRaw`INSERT INTO staff_users(id, tenant_id, name, email, password_hash, role)
      VALUES (${STAFF}::uuid, ${TENANT}::uuid, 'Operadora', 'sintetica@example.invalid', 'x', 'owner')`;
    await selecionarCanal({ ...ator, canal: 'baileys' });
    await solicitarConexaoBaileys({ ...ator, novoQr: true });
  });
  async function possuir() {
    const p = await adquirirSessao(ator); if (!p) throw new Error('fixture sem posse'); return p;
  }
  it('só um worker possui a sessão e processo antigo perde permissão após retomada', async () => {
    const concorrentes = await Promise.all([adquirirSessao(ator), adquirirSessao(ator)]);
    expect(concorrentes.filter(Boolean)).toHaveLength(1);
    const p = concorrentes.find(p => p !== null); if (!p) throw new Error('sem posse');
    expect(await renovarSessao(p)).toBe(true);
    await admin.$executeRaw`UPDATE whatsapp_baileys_sessions SET lease_until = now() - interval '1 second'`;
    expect(await renovarSessao(p)).toBe(false);
    const nova = await possuir(); expect(nova.ownerToken).not.toBe(p.ownerToken);
    await expect(comPosse(p, async () => true)).rejects.toMatchObject({ code: 'baileys_posse_perdida' });
    expect(await comPosse(nova, async () => true)).toBe(true);
  });
  it('auth fica cifrada, lê e exclui chaves e desfaz todo lote inválido', async () => {
    const p = await possuir(); const store = armazenamentoDeAuth(p);
    await store.gravar({ creds: { main: { secret: 'segredo-sintetico', bytes: Buffer.from([0, 12, 255]) } } });
    expect((await store.ler('creds', ['main']))['main']).toEqual({ secret: 'segredo-sintetico', bytes: Buffer.from([0, 12, 255]) });
    const raw = await admin.$queryRaw<{ cipher: string }[]>`SELECT cipher FROM whatsapp_baileys_auth`;
    expect(raw[0]?.cipher).not.toContain('segredo');
    await expect(store.gravar({ session: { boa: { ok: true }, ['x'.repeat(513)]: { ok: false } } })).rejects.toThrow();
    expect(await store.ler('session', ['boa'])).toEqual({});
    await store.gravar({ creds: { main: null } });
    expect(await store.ler('creds', ['main'])).toEqual({});
  });
  it('vizinho não lê tabelas sem filtro e não altera conexão alheia', async () => {
    expect(await withTenant(RIVAL, tx => tx.$queryRaw`SELECT * FROM whatsapp_baileys_sessions`)).toEqual([]);
    expect(await withTenant(RIVAL, tx => tx.$queryRaw`SELECT * FROM whatsapp_channels`)).toEqual([]);
    await expect(selecionarCanal({ ...ator, locationId: OTHER_LOCATION, canal: 'baileys' })).rejects.toMatchObject({ status: 403 });
    await expect(withTenant(TENANT, tx => tx.$executeRaw`INSERT INTO whatsapp_baileys_sessions(tenant_id,location_id)
      VALUES (${TENANT}::uuid,${OTHER_LOCATION}::uuid)`)).rejects.toThrow();
  });
  it('desconexão apaga credenciais e impede gravação por callback atrasado', async () => {
    const p = await possuir(); const store = armazenamentoDeAuth(p);
    await store.gravar({ creds: { main: { registered: true } } });
    await desconectarBaileys(ator);
    expect((await situacaoBaileys(ator)).estado).toBe('desconectado');
    expect(await renovarSessao(p)).toBe(false);
    await expect(store.gravar({ creds: { main: { registered: true } } })).rejects.toMatchObject({ code: 'baileys_posse_perdida' });
    expect(await withTenant(TENANT, tx => tx.$queryRaw`SELECT * FROM whatsapp_baileys_auth`)).toEqual([]);
    await expect(solicitarConexaoBaileys({ ...ator, novoQr: false })).rejects.toMatchObject({ code: 'baileys_precisa_qr' });
  });
  it('trocar para Meta pausa o socket mas permite retomar sessão salva depois', async () => {
    const p = await possuir(); await armazenamentoDeAuth(p).gravar({ creds: { main: { registered: true } } });
    await selecionarCanal({ ...ator, canal: 'meta' }); expect(await renovarSessao(p)).toBe(false);
    expect(await adquirirSessao(ator)).toBeNull();
    await selecionarCanal({ ...ator, canal: 'baileys' });
    await solicitarConexaoBaileys({ ...ator, novoQr: false });
    expect((await possuir()).generation).toBe(p.generation);
  });
});
