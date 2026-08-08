import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveStaffSession,
  revokeStaffSession,
  signUpOwner,
  slugify,
  StaffError,
  staffLogin,
} from './staff.js';

/**
 * Conta de gestor, contra Postgres real.
 *
 * O que se prova aqui e não dá para provar com mock: que o próprio role da
 * aplicação cria o próprio tenant sob RLS, que uma barbearia não enxerga a
 * conta da outra, e que o índice de login não guarda e-mail em claro.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];

let admin: PrismaClient;

const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const CONTA = {
  name: 'Matheus Cardoso',
  email: 'matheus@domari.com.br',
  password: 'senha-bem-comprida',
  phone: '(71) 98888-7777',
  businessName: 'Domari Barber Club',
};

describeIfDb('conta de gestor', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    process.env['STAFF_EMAIL_PEPPER'] = 'pepper-de-teste';
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await admin.$executeRawUnsafe('TRUNCATE staff_directory CASCADE');
  });

  // -- cadastro --------------------------------------------------------------

  /** Cadastra e devolve a sessão, falhando alto se o e-mail já existia. */
  async function cadastrar(conta = CONTA) {
    const resultado = await signUpOwner(conta);
    if (!resultado.created) throw new Error('e-mail já cadastrado');
    return resultado.session;
  }

  it('cria a barbearia inteira numa transação, sem bypass de RLS', async () => {
    const sessao = await cadastrar();

    expect(sessao.slug).toBe('domari-barber-club');
    expect(sessao.role).toBe('owner');
    expect(sessao.token.startsWith(`${sessao.tenantId}.`)).toBe(true);

    // A unidade nasce junto: barbearia sem unidade não tem agenda.
    const unidades = await admin.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*) FROM locations WHERE tenant_id = '${sessao.tenantId}'`,
    );
    expect(Number(unidades[0]?.count)).toBe(1);
  });

  it('não guarda o e-mail em claro no índice entre tenants', async () => {
    // O índice não tem RLS por natureza; é a lista de donos da plataforma. Se
    // guardasse endereço, um dump entregaria a base de clientes do SaaS.
    await cadastrar();

    const linhas = await admin.$queryRawUnsafe<{ email_key: string }[]>(
      'SELECT email_key FROM staff_directory',
    );
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.email_key).not.toContain('matheus');
    expect(linhas[0]?.email_key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('nunca grava a senha, só o hash com parâmetros', async () => {
    await cadastrar();

    const linhas = await admin.$queryRawUnsafe<{ password_hash: string }[]>(
      'SELECT password_hash FROM staff_users',
    );
    expect(linhas[0]?.password_hash).not.toContain(CONTA.password);
    expect(linhas[0]?.password_hash).toMatch(/^scrypt\$\d+\$/);
  });

  it('e-mail já cadastrado não vira erro nem cria barbearia', async () => {
    // Recusar com código próprio seria oráculo de quem é dono na plataforma —
    // a mesma lista que o HMAC do índice existe para proteger.
    await cadastrar();

    const segundo = await signUpOwner({ ...CONTA, businessName: 'Outra' });
    expect(segundo.created).toBe(false);

    const tenants = await admin.$queryRawUnsafe<{ count: bigint }[]>(
      'SELECT count(*) FROM tenants',
    );
    expect(Number(tenants[0]?.count)).toBe(1);
  });

  it('resolve conflito de slug sem colidir', async () => {
    const um = await cadastrar();
    const dois = await cadastrar({
      ...CONTA,
      email: 'outro@domari.com.br',
      businessName: 'Domari Barber Club',
    });

    expect(um.slug).toBe('domari-barber-club');
    expect(dois.slug).toBe('domari-barber-club-2');
  });

  it('recusa senha curta antes de tocar no banco', async () => {
    await expect(signUpOwner({ ...CONTA, password: 'curta' })).rejects.toMatchObject({
      code: 'weak_password',
    });

    const tenants = await admin.$queryRawUnsafe<{ count: bigint }[]>(
      'SELECT count(*) FROM tenants',
    );
    expect(Number(tenants[0]?.count)).toBe(0);
  });

  it('recusa celular malformado', async () => {
    await expect(signUpOwner({ ...CONTA, phone: '123' })).rejects.toMatchObject({
      code: 'invalid_phone',
    });
  });

  // -- login -----------------------------------------------------------------

  it('entra com e-mail e senha', async () => {
    const criado = await cadastrar();
    const entrou = await staffLogin({ email: CONTA.email, password: CONTA.password });

    expect(entrou.tenantId).toBe(criado.tenantId);
    expect(entrou.slug).toBe('domari-barber-club');
    // Token novo a cada login: reaproveitar faria logout num aparelho derrubar
    // a sessão do outro sem aviso.
    expect(entrou.token).not.toBe(criado.token);
  });

  it('ignora caixa e espaço no e-mail', async () => {
    await cadastrar();
    const entrou = await staffLogin({
      email: '  MATHEUS@Domari.com.BR ',
      password: CONTA.password,
    });
    expect(entrou.role).toBe('owner');
  });

  it('recusa senha errada e conta inexistente do mesmo jeito', async () => {
    await cadastrar();

    const erros: string[] = [];
    for (const tentativa of [
      { email: CONTA.email, password: 'errada-mas-comprida' },
      { email: 'ninguem@lugar.nenhum', password: 'errada-mas-comprida' },
    ]) {
      try {
        await staffLogin(tentativa);
        throw new Error('deveria ter recusado');
      } catch (error) {
        if (!(error instanceof StaffError)) throw error;
        erros.push(`${error.code}|${error.message}`);
      }
    }

    // Distinguir transformaria o login em oráculo de "este e-mail é cliente".
    expect(erros[0]).toBe(erros[1]);
  });

  it('conta desativada não entra', async () => {
    await cadastrar();
    await admin.$executeRawUnsafe('UPDATE staff_users SET active = false');

    await expect(
      staffLogin({ email: CONTA.email, password: CONTA.password }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
  });

  // -- sessão ----------------------------------------------------------------

  it('resolve a sessão e devolve o tenant certo', async () => {
    const criado = await cadastrar();
    const sessao = await resolveStaffSession(criado.token);

    expect(sessao.tenantId).toBe(criado.tenantId);
    expect(sessao.name).toBe(CONTA.name);
    expect(sessao.role).toBe('owner');
  });

  it('token de uma barbearia não vale na outra', async () => {
    const um = await cadastrar();
    const dois = await cadastrar({
      ...CONTA,
      email: 'rival@rival.com',
      businessName: 'Rival',
    });

    // Trocar o prefixo do tenant é a tentativa óbvia. A RLS do tenant vizinho
    // não enxerga a sessão, e o hash não existe lá.
    const forjado = `${dois.tenantId}.${um.token.split('.')[1]}`;
    await expect(resolveStaffSession(forjado)).rejects.toMatchObject({
      code: 'invalid_session',
    });
  });

  it('recusa token malformado sem consultar o banco', async () => {
    for (const ruim of ['', 'sem-ponto', 'nao-uuid.abcdefghijklmnopqrstuvwxyz123456', '.']) {
      await expect(resolveStaffSession(ruim)).rejects.toMatchObject({
        code: 'invalid_session',
      });
    }
  });

  it('sessão revogada deixa de valer', async () => {
    const criado = await cadastrar();
    const sessao = await resolveStaffSession(criado.token);

    await revokeStaffSession(criado.tenantId, sessao.sessionId);

    await expect(resolveStaffSession(criado.token)).rejects.toMatchObject({
      code: 'invalid_session',
    });
  });

  it('sessão expirada deixa de valer', async () => {
    const criado = await cadastrar();
    await admin.$executeRawUnsafe(
      "UPDATE staff_sessions SET expires_at = now() - interval '1 minute'",
    );

    await expect(resolveStaffSession(criado.token)).rejects.toMatchObject({
      code: 'invalid_session',
    });
  });

  it('uma barbearia não enxerga o gestor da outra', async () => {
    const um = await cadastrar();
    await cadastrar({ ...CONTA, email: 'rival@rival.com', businessName: 'Rival' });

    // Consulta sem filtro nenhum, com o tenant da primeira fixado: quem filtra
    // é a política, e ela precisa devolver só uma linha.
    const { withTenant } = await import('@barbearia/db');
    const vistos = await withTenant(um.tenantId, async (tx) =>
      tx.$queryRaw<{ id: string }[]>`SELECT id FROM staff_users`,
    );
    expect(vistos).toHaveLength(1);
  });
});

describe('slug', () => {
  it('sai do nome da barbearia sem acento nem símbolo', () => {
    expect(slugify('Domari Barber Club')).toBe('domari-barber-club');
    expect(slugify('Barbearia São João & Cia.')).toBe('barbearia-sao-joao-cia');
  });

  it('não começa nem termina com hífen', () => {
    expect(slugify('  ---Barbearia---  ')).toBe('barbearia');
  });

  it('nunca fica vazio a ponto de virar URL quebrada', () => {
    // Nome só com símbolo existe. O chamador substitui por 'barbearia'.
    expect(slugify('!!!')).toBe('');
  });
});
