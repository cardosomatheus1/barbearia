import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTenant } from '@barbearia/db';

/**
 * Conta as derivações de senha, sem substituir nenhuma.
 *
 * O scrypt real continua rodando — o embrulho só passa adiante e soma. Mocar a
 * derivação aqui seria mocar exatamente o que se quer provar; o que se quer
 * provar é **quantas vezes** ela roda em cada caminho da porta, e isso é
 * contável e determinístico, ao contrário de cronometrar duas respostas e
 * torcer para a máquina estar calma.
 */
const derivacoes = vi.hoisted(() => ({ total: 0 }));

vi.mock('@barbearia/identity', async (original) => {
  const real = await original<typeof import('@barbearia/identity')>();
  return {
    ...real,
    hashPassword: (...args: Parameters<typeof real.hashPassword>) => {
      derivacoes.total += 1;
      return real.hashPassword(...args);
    },
    verifyPassword: (...args: Parameters<typeof real.verifyPassword>) => {
      derivacoes.total += 1;
      return real.verifyPassword(...args);
    },
  };
});
import {
  bloquearBarbearia,
  bloqueioDaBarbearia,
  criarAdminDaPlataforma,
  reconfigurarAdminDaPlataforma,
  desbloquearBarbearia,
  entrarNaPlataforma,
  listarBarbearias,
  listarPlanos,
  PlataformaError,
  resolverSessaoDaPlataforma,
  sairDaPlataforma,
  trilhaDaPlataforma,
} from './plataforma.js';
import { mudarPlanoDaAssinatura } from './assinatura.js';

/**
 * A camada de plataforma contra Postgres real.
 *
 * O teste que importa aqui não é "a lista lista". É que a existência de um
 * caminho que **vê todas as barbearias** não abriu caminho para uma barbearia
 * ver a outra. As duas coisas convivem no mesmo banco e no mesmo role, e mock
 * não prova nada sobre política de RLS.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const DOMARI = '26262626-1111-1111-1111-111111111111';
const RIVAL = '26262626-2222-2222-2222-222222222222';

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

describeIfDb('camada de plataforma', () => {
  beforeAll(() => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    process.env['STAFF_EMAIL_PEPPER'] = 'pepper-de-teste';
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await admin.$executeRawUnsafe('TRUNCATE platform_admins CASCADE');
    await admin.$executeRawUnsafe('DELETE FROM platform_audit');
    await exec(`
      INSERT INTO tenants (id, name) VALUES ('${DOMARI}', 'Domari'), ('${RIVAL}', 'Rival');
      INSERT INTO tenant_slugs (slug, tenant_id, is_primary) VALUES
        ('domari', '${DOMARI}', true), ('rival', '${RIVAL}', true);
      INSERT INTO customers (tenant_id, name, phone_e164) VALUES
        ('${DOMARI}', 'Carlos da Domari', '+5571900002611'),
        ('${RIVAL}', 'Zé da Rival', '+5571900002612');
    `);
  });

  const comAdmin = async () =>
    criarAdminDaPlataforma({ nome: 'Suporte', email: 'suporte@plataforma.com', senha: 'senha-bem-comprida' });

  // -- o que a plataforma vê --------------------------------------------------

  it('lista todas as barbearias, que é o ponto dela existir', async () => {
    const lista = await listarBarbearias();

    expect(lista.map((b) => b.nome).sort()).toEqual(['Domari', 'Rival']);
    expect(lista.find((b) => b.nome === 'Domari')?.slug).toBe('domari');
  });

  it('mas continua sem enxergar cliente de ninguém', async () => {
    // A prova de que a camada nova não é uma porta: com o tenant da Domari
    // fixado, uma consulta sem filtro a `customers` devolve só o dela — mesmo
    // depois de a plataforma ter lido as duas barbearias.
    await listarBarbearias();

    const daDomari = await withTenant(DOMARI, async (tx) =>
      tx.$queryRaw<{ name: string }[]>`SELECT name FROM customers`,
    );

    expect(daDomari.map((c) => c.name)).toEqual(['Carlos da Domari']);
  });

  it('a barbearia nova entra na lista sem a plataforma pedir', async () => {
    await exec(`INSERT INTO tenants (name) VALUES ('Recém-aberta')`);

    expect((await listarBarbearias()).map((b) => b.nome)).toContain('Recém-aberta');
  });

  // -- planos -----------------------------------------------------------------

  it('as quatro faixas da SPEC estão no catálogo, com preço em centavos', async () => {
    // Os três planos inventados do bloco 24 saíram de oferta no 27, quando as
    // faixas de verdade (SPEC §9) chegaram. Eles continuam existindo para quem
    // estivesse neles — o que a lista devolve é a **oferta**.
    const planos = await listarPlanos();

    expect(planos.map((p) => p.code)).toEqual(['enterprise', 'starter', 'pro', 'business']);
    // A âncora do §2.4: o Pro disputa a barbearia de duas cadeiras na faixa
    // R$ 79–110.
    expect(planos.find((p) => p.code === 'pro')?.priceCents).toBe(9900);
    // `null` é ilimitado, e é diferente de zero — que seria um plano onde
    // ninguém pode trabalhar.
    expect(planos.find((p) => p.code === 'enterprise')?.maxChairs).toBeNull();
  });

  it('trocar de plano deixa rastro com o de onde e o para onde', async () => {
    const { id: adminId } = await comAdmin();
    await mudarPlanoDaAssinatura({ adminId, tenantId: DOMARI, planoCode: 'starter' });
    await mudarPlanoDaAssinatura({ adminId, tenantId: DOMARI, planoCode: 'business' });

    const trilha = await trilhaDaPlataforma();
    const trocas = trilha.filter((e) => e.acao === 'tenant.plan_changed');

    expect(trocas).toHaveLength(2);
    // A mais recente primeiro: a trilha é lida de cima para baixo.
    expect(trocas[0]?.detalhe).toMatchObject({ de: 'starter', para: 'business' });
    expect(trocas[1]?.detalhe).toMatchObject({ de: 'pro', para: 'starter' });
  });

  it('plano que não é mais oferecido não recebe barbearia nova', async () => {
    const { id: adminId } = await comAdmin();

    // Os do bloco 24 são o caso real disto: desativados, não apagados.
    await expect(
      mudarPlanoDaAssinatura({ adminId, tenantId: DOMARI, planoCode: 'cortesia' }),
    ).rejects.toThrow(PlataformaError);
  });

  it('plano inexistente é recusado com código próprio', async () => {
    const { id: adminId } = await comAdmin();

    await expect(
      mudarPlanoDaAssinatura({ adminId, tenantId: DOMARI, planoCode: 'inventado' }),
    ).rejects.toMatchObject({ code: 'unknown_plan' });
  });

  // -- bloqueio ---------------------------------------------------------------

  it('bloquear exige motivo, e o motivo fica guardado', async () => {
    const { id: adminId } = await comAdmin();

    await expect(
      bloquearBarbearia({ adminId, tenantId: DOMARI, motivo: '   ' }),
    ).rejects.toMatchObject({ code: 'reason_required' });

    await bloquearBarbearia({ adminId, tenantId: DOMARI, motivo: 'inadimplente há 60 dias' });

    const estado = await bloqueioDaBarbearia(DOMARI);
    expect(estado).toEqual({ bloqueada: true, motivo: 'inadimplente há 60 dias' });
  });

  it('bloquear duas vezes não troca a data do primeiro bloqueio', async () => {
    const { id: adminId } = await comAdmin();
    await bloquearBarbearia({ adminId, tenantId: DOMARI, motivo: 'primeiro motivo' });

    // É a data que o suporte usa para contar prazo. Reescrevê-la num clique
    // repetido apagaria a informação mais importante do bloqueio.
    await expect(
      bloquearBarbearia({ adminId, tenantId: DOMARI, motivo: 'segundo motivo' }),
    ).rejects.toMatchObject({ code: 'not_blockable' });

    expect((await bloqueioDaBarbearia(DOMARI)).motivo).toBe('primeiro motivo');
  });

  it('bloquear uma não bloqueia a outra', async () => {
    const { id: adminId } = await comAdmin();
    await bloquearBarbearia({ adminId, tenantId: DOMARI, motivo: 'inadimplente' });

    expect((await bloqueioDaBarbearia(RIVAL)).bloqueada).toBe(false);
  });

  it('desbloquear limpa data e motivo juntos', async () => {
    const { id: adminId } = await comAdmin();
    await bloquearBarbearia({ adminId, tenantId: DOMARI, motivo: 'engano' });
    await desbloquearBarbearia({ adminId, tenantId: DOMARI });

    expect(await bloqueioDaBarbearia(DOMARI)).toEqual({ bloqueada: false, motivo: null });
    // Desbloquear o que já está ativo não é operação: sem isto, um clique
    // repetido geraria uma linha de trilha dizendo que algo mudou quando nada
    // mudou.
    await expect(desbloquearBarbearia({ adminId, tenantId: DOMARI })).rejects.toMatchObject({
      code: 'not_blocked',
    });
  });

  it('bloqueio e desbloqueio aparecem na trilha, com quem fez', async () => {
    const { id: adminId } = await comAdmin();
    await bloquearBarbearia({ adminId, tenantId: DOMARI, motivo: 'inadimplente' });
    await desbloquearBarbearia({ adminId, tenantId: DOMARI });

    const acoes = (await trilhaDaPlataforma()).map((e) => e.acao);
    expect(acoes).toContain('tenant.blocked');
    expect(acoes).toContain('tenant.unblocked');
    expect((await trilhaDaPlataforma())[0]?.adminNome).toBe('Suporte');
  });

  // -- a porta ----------------------------------------------------------------

  it('entra com a senha certa e a sessão resolve', async () => {
    await comAdmin();
    const sessao = await entrarNaPlataforma({
      email: 'suporte@plataforma.com',
      senha: 'senha-bem-comprida',
    });

    expect(sessao.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await resolverSessaoDaPlataforma(sessao.token)).nome).toBe('Suporte');
  });

  it('trocar a senha derruba as sessões abertas, e a nova senha entra', async () => {
    /**
     * `password_hash` nunca recebia `UPDATE` em lugar nenhum do repositório, e
     * `disabled_at` era **lido** no login e escrito por ninguém: a conta que
     * bloqueia qualquer barbearia e entra na conta de qualquer dono não tinha
     * rotação de senha nem desligamento. Criar de novo é recusado por e-mail
     * repetido, então a única saída era `UPDATE` à mão.
     *
     * As sessões caem junto pela mesma razão do painel da barbearia: quem
     * roubou a sessão continuaria dentro depois da troca, e trocar a senha é
     * justamente o que a pessoa faz quando desconfia.
     */
    await comAdmin();
    const antiga = await entrarNaPlataforma({
      email: 'suporte@plataforma.com',
      senha: 'senha-bem-comprida',
    });
    expect((await resolverSessaoDaPlataforma(antiga.token)).nome).toBe('Suporte');

    const feito = await reconfigurarAdminDaPlataforma({
      email: 'suporte@plataforma.com',
      senha: 'outra-senha-bem-comprida',
    });
    expect(feito.sessoesRevogadas).toBeGreaterThan(0);

    await expect(resolverSessaoDaPlataforma(antiga.token)).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await expect(
      entrarNaPlataforma({ email: 'suporte@plataforma.com', senha: 'senha-bem-comprida' }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });

    const nova = await entrarNaPlataforma({
      email: 'suporte@plataforma.com',
      senha: 'outra-senha-bem-comprida',
    });
    expect((await resolverSessaoDaPlataforma(nova.token)).nome).toBe('Suporte');
  });

  it('desligar a conta fecha a porta, e religar a reabre', async () => {
    // Uma conta desligada com sessão viva é uma conta ligada.
    await comAdmin();
    const viva = await entrarNaPlataforma({
      email: 'suporte@plataforma.com',
      senha: 'senha-bem-comprida',
    });

    await reconfigurarAdminDaPlataforma({ email: 'suporte@plataforma.com', desligar: true });

    await expect(resolverSessaoDaPlataforma(viva.token)).rejects.toBeTruthy();
    await expect(
      entrarNaPlataforma({ email: 'suporte@plataforma.com', senha: 'senha-bem-comprida' }),
    ).rejects.toBeTruthy();

    await reconfigurarAdminDaPlataforma({ email: 'suporte@plataforma.com', desligar: false });
    const depois = await entrarNaPlataforma({
      email: 'suporte@plataforma.com',
      senha: 'senha-bem-comprida',
    });
    expect((await resolverSessaoDaPlataforma(depois.token)).nome).toBe('Suporte');
  });

  it('reconfigurar conta que não existe é recusado', async () => {
    await expect(
      reconfigurarAdminDaPlataforma({ email: 'ninguem@x.com', desligar: true }),
    ).rejects.toMatchObject({ code: 'unknown_admin' });
  });

  it('e-mail inexistente e senha errada devolvem exatamente a mesma coisa', async () => {
    await comAdmin();

    const semConta = await entrarNaPlataforma({ email: 'ninguem@x.com', senha: 'qualquer-senha-longa' })
      .then(() => null)
      .catch((e: PlataformaError) => e.code);
    const senhaErrada = await entrarNaPlataforma({
      email: 'suporte@plataforma.com',
      senha: 'senha-errada-porem-longa',
    })
      .then(() => null)
      .catch((e: PlataformaError) => e.code);

    // Distinguir os dois é dizer "este e-mail existe" para quem está tentando.
    expect(semConta).toBe('invalid_credentials');
    expect(senhaErrada).toBe('invalid_credentials');
  });

  it('e custam a mesma derivação de senha, que é o que iguala o tempo', async () => {
    await comAdmin();

    derivacoes.total = 0;
    await entrarNaPlataforma({ email: 'ninguem@x.com', senha: 'qualquer-senha-longa' }).catch(
      () => undefined,
    );
    const semConta = derivacoes.total;

    derivacoes.total = 0;
    await entrarNaPlataforma({
      email: 'suporte@plataforma.com',
      senha: 'senha-errada-porem-longa',
    }).catch(() => undefined);
    const senhaErrada = derivacoes.total;

    // Responder o mesmo código em tempos diferentes continua sendo responder
    // coisas diferentes. A primeira versão gastava duas derivações no caminho
    // sem conta — o dobro do tempo dizia "este e-mail não existe".
    expect(semConta).toBe(1);
    expect(senhaErrada).toBe(1);
  });

  it('conta desligada não entra, e também não se distingue de senha errada', async () => {
    await comAdmin();
    await admin.$executeRawUnsafe(`UPDATE platform_admins SET disabled_at = now()`);

    await expect(
      entrarNaPlataforma({ email: 'suporte@plataforma.com', senha: 'senha-bem-comprida' }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
  });

  it('o e-mail não fica em claro no banco', async () => {
    await comAdmin();

    const linhas = await admin.$queryRaw<{ email_key: string }[]>`SELECT email_key FROM platform_admins`;
    // Mesma decisão de `staff_directory`, pelo mesmo motivo: a tabela não tem
    // isolamento, e e-mail em claro ali é dado pessoal exposto a qualquer
    // consulta que escape.
    expect(linhas[0]?.email_key).not.toContain('suporte@');
    expect(linhas[0]?.email_key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('o token não fica em claro no banco, e sair o invalida', async () => {
    await comAdmin();
    const sessao = await entrarNaPlataforma({
      email: 'suporte@plataforma.com',
      senha: 'senha-bem-comprida',
    });

    const guardado = await admin.$queryRaw<{ token_hash: string }[]>`SELECT token_hash FROM platform_sessions`;
    expect(guardado[0]?.token_hash).not.toBe(sessao.token);

    await sairDaPlataforma(sessao.token);
    await expect(resolverSessaoDaPlataforma(sessao.token)).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });

  it('sessão vencida não resolve', async () => {
    await comAdmin();
    const sessao = await entrarNaPlataforma({
      email: 'suporte@plataforma.com',
      senha: 'senha-bem-comprida',
    });

    const depois = new Date(sessao.expiraEm.getTime() + 1000);
    await expect(resolverSessaoDaPlataforma(sessao.token, depois)).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });

  it('desligar a conta derruba a sessão que já estava aberta', async () => {
    await comAdmin();
    const sessao = await entrarNaPlataforma({
      email: 'suporte@plataforma.com',
      senha: 'senha-bem-comprida',
    });
    await admin.$executeRawUnsafe(`UPDATE platform_admins SET disabled_at = now()`);

    // Sem isto, desligar alguém só valeria no próximo login — que pode ser
    // nunca, porque a sessão dura oito horas e ele já está dentro.
    await expect(resolverSessaoDaPlataforma(sessao.token)).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });

  it('senha curta é recusada na criação', async () => {
    await expect(
      criarAdminDaPlataforma({ nome: 'Fraco', email: 'fraco@x.com', senha: 'curta' }),
    ).rejects.toMatchObject({ code: 'weak_password' });
  });

  it('o mesmo e-mail não vira duas contas', async () => {
    await comAdmin();
    await expect(comAdmin()).rejects.toMatchObject({ code: 'email_taken' });
  });
});
