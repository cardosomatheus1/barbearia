import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PAPEIS, PERMISSOES, permissoesPadrao } from '@barbearia/core';
import { withTenant } from '@barbearia/db';
import {
  changeOwnPassword,
  changeStaffRole,
  createStaffUser,
  listStaff,
  definirPermissoesDoPapel,
  permissionsByRole,
  convidarProfissional,
  definirUnidadesDoOperador,
  resetStaffPassword,
  setStaffActive,
  unidadesPorOperador,
} from './team.js';
import { FakeMessagingProvider } from './messaging.js';
import { resolveStaffSession, signUpOwner, staffLogin } from './staff.js';
import { ACOES_DE_GESTAO, listAudit } from './audit.js';

/**
 * Contas de equipe e permissões, contra Postgres real.
 *
 * O que se prova aqui: que o papel decide de fato, que a trilha registra quem
 * mudou o quê, e que desligar alguém tira essa pessoa de dentro do sistema no
 * mesmo instante — não quando o token expirar.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];

let admin: PrismaClient;

const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const DONO = {
  name: 'Matheus Cardoso',
  email: 'dono@domari.com.br',
  password: 'senha-bem-comprida',
  phone: '(71) 98888-7777',
  businessName: 'Domari Barber Club',
};

describeIfDb('equipe e permissões', () => {
  const messaging = new FakeMessagingProvider();

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
    messaging.clear();
  });

  async function abrirBarbearia() {
    const criado = await signUpOwner(DONO);
    if (!criado.created) throw new Error('a barbearia deveria ter sido criada');
    return criado.session;
  }

  const ator = (sessao: { staffUserId: string; name: string }) => ({
    id: sessao.staffUserId,
    name: sessao.name,
  });

  // -- catálogo --------------------------------------------------------------

  it('o catálogo do banco é o mesmo do código', async () => {
    // A CHECK de `role_permissions` repete a lista de propósito — é ela que
    // impede permissão inventada numa correção manual. Duas listas separadas
    // que ninguém compara é como uma envelhece em silêncio.
    const linhas = await admin.$queryRawUnsafe<{ def: string }[]>(`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'role_permissions_conhecida'
    `);
    const definicao = linhas[0]?.def ?? '';
    expect(definicao, 'a CHECK não foi encontrada').not.toBe('');

    for (const permissao of PERMISSOES) {
      expect(definicao, `${permissao} não está na CHECK do banco`).toContain(`'${permissao}'`);
    }
    // E o contrário: nada na CHECK que o código não conheça.
    const noBanco = [...definicao.matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]);
    for (const permissao of noBanco) {
      expect(PERMISSOES as readonly string[], `${permissao} está no banco e não no código`)
        .toContain(permissao);
    }
  });

  it('a barbearia nasce com o padrão de fábrica', async () => {
    // Sem a semente no cadastro, nem o dono consegue abrir o próprio painel.
    const sessao = await abrirBarbearia();
    const mapa = await permissionsByRole(sessao.tenantId);

    for (const papel of PAPEIS) {
      expect([...(mapa[papel] ?? [])].sort(), papel).toEqual([...permissoesPadrao(papel)].sort());
    }
  });

  // -- a sessão carrega o que pode ------------------------------------------

  it('a sessão do dono carrega todas as permissões', async () => {
    const sessao = await abrirBarbearia();
    const resolvida = await resolveStaffSession(sessao.token);
    expect([...resolvida.permissions].sort()).toEqual([...PERMISSOES].sort());
  });

  it('a recepcionista não recebe team.manage nem finance', async () => {
    // É o incidente que este bloco existe para impedir: quem só marca presença
    // não pode receber a chave do faturamento junto.
    const dono = await abrirBarbearia();
    const { senhaInicial } = await createStaffUser({
      messaging,
      tenantId: dono.tenantId,
      actor: ator(dono),
      name: 'Maria Recepção',
      email: 'maria@domari.com.br',
      role: 'receptionist',
    });

    const dela = await staffLogin({ email: 'maria@domari.com.br', password: senhaInicial });
    const resolvida = await resolveStaffSession(dela.token);

    expect(resolvida.permissions).toContain('appointments.attend');
    expect(resolvida.permissions).not.toContain('team.manage');
    expect(resolvida.permissions).not.toContain('finance.view');
    expect(resolvida.permissions).not.toContain('customers.export');
  });

  it('tirar a permissão do papel tira de quem já está logado', async () => {
    // O sentido de guardar permissão no banco: mudar não é deploy. E a sessão
    // resolve o papel a cada requisição, então não fica valendo a foto antiga.
    const dono = await abrirBarbearia();
    const { senhaInicial } = await createStaffUser({
      messaging,
      tenantId: dono.tenantId,
      actor: ator(dono),
      name: 'Maria Recepção',
      email: 'maria@domari.com.br',
      role: 'receptionist',
    });
    const dela = await staffLogin({ email: 'maria@domari.com.br', password: senhaInicial });

    expect((await resolveStaffSession(dela.token)).permissions).toContain('appointments.cancel');

    await withTenant(dono.tenantId, async (tx) => {
      await tx.$executeRawUnsafe(
        `DELETE FROM role_permissions WHERE role = 'receptionist' AND permission = 'appointments.cancel'`,
      );
    });

    expect((await resolveStaffSession(dela.token)).permissions).not.toContain(
      'appointments.cancel',
    );
  });

  // -- primeiro acesso -------------------------------------------------------

  it('a conta nova nasce obrigada a trocar a senha', async () => {
    const dono = await abrirBarbearia();
    const { senhaInicial } = await createStaffUser({
      messaging,
      tenantId: dono.tenantId,
      actor: ator(dono),
      name: 'Maria Recepção',
      email: 'maria@domari.com.br',
      role: 'receptionist',
    });

    // Gerada, não escolhida por terceiro, e longa o bastante para não ser
    // adivinhada enquanto está no papel em cima do balcão.
    expect(senhaInicial.length).toBeGreaterThanOrEqual(12);

    const dela = await staffLogin({ email: 'maria@domari.com.br', password: senhaInicial });
    expect((await resolveStaffSession(dela.token)).mustChangePassword).toBe(true);

    await changeOwnPassword({
      tenantId: dela.tenantId,
      staffUserId: dela.staffUserId,
      sessionId: (await resolveStaffSession(dela.token)).sessionId,
      currentPassword: senhaInicial,
      newPassword: 'a-senha-que-ela-escolheu',
    });

    expect((await resolveStaffSession(dela.token)).mustChangePassword).toBe(false);
  });

  it('trocar a senha exige a atual', async () => {
    // Quem chega ao navegador aberto de outra pessoa não pode ficar com a conta.
    const dono = await abrirBarbearia();
    const resolvida = await resolveStaffSession(dono.token);

    await expect(
      changeOwnPassword({
        tenantId: dono.tenantId,
        staffUserId: dono.staffUserId,
        sessionId: resolvida.sessionId,
        currentPassword: 'chute-errado-mesmo',
        newPassword: 'outra-senha-comprida',
      }),
    ).rejects.toMatchObject({ code: 'invalid_credentials' });
  });

  it('a senha nova não pode ser a antiga nem curta demais', async () => {
    const dono = await abrirBarbearia();
    const resolvida = await resolveStaffSession(dono.token);

    for (const nova of [DONO.password, 'curta']) {
      await expect(
        changeOwnPassword({
          tenantId: dono.tenantId,
          staffUserId: dono.staffUserId,
          sessionId: resolvida.sessionId,
          currentPassword: DONO.password,
          newPassword: nova,
        }),
        nova,
      ).rejects.toMatchObject({ code: 'weak_password' });
    }
  });

  // -- o dono é protegido ----------------------------------------------------

  it('não dá para criar um segundo dono, promover a dono nem desligar o dono', async () => {
    // Seriam três caminhos para a mesma coisa: a única conta com team.manage se
    // trancando para fora da própria barbearia, sem volta pela aplicação.
    const dono = await abrirBarbearia();

    await expect(
      createStaffUser({
      messaging,
        tenantId: dono.tenantId,
        actor: ator(dono),
        name: 'Sócio',
        email: 'socio@domari.com.br',
        role: 'owner',
      }),
    ).rejects.toMatchObject({ code: 'owner_protected' });

    await expect(
      setStaffActive({
        tenantId: dono.tenantId,
        actor: ator(dono),
        staffUserId: dono.staffUserId,
        active: false,
      }),
    ).rejects.toMatchObject({ code: 'owner_protected' });

    await expect(
      changeStaffRole({
        tenantId: dono.tenantId,
        actor: ator(dono),
        staffUserId: dono.staffUserId,
        role: 'receptionist',
      }),
    ).rejects.toMatchObject({ code: 'owner_protected' });
  });

  it('recusa e-mail que já tem conta na plataforma', async () => {
    const dono = await abrirBarbearia();
    await expect(
      createStaffUser({
      messaging,
        tenantId: dono.tenantId,
        actor: ator(dono),
        name: 'Outro',
        email: DONO.email,
        role: 'receptionist',
      }),
    ).rejects.toMatchObject({ code: 'email_taken' });
  });

  // -- desligar --------------------------------------------------------------

  it('desligar alguém derruba a sessão dela no mesmo instante', async () => {
    // Sem isto, quem acabou de ser demitido continua com o balcão aberto no
    // navegador até o token expirar — que é exatamente a hora em que ele não
    // deveria mais estar lá.
    const dono = await abrirBarbearia();
    const { member, senhaInicial } = await createStaffUser({
      messaging,
      tenantId: dono.tenantId,
      actor: ator(dono),
      name: 'Maria Recepção',
      email: 'maria@domari.com.br',
      role: 'receptionist',
    });
    const dela = await staffLogin({ email: 'maria@domari.com.br', password: senhaInicial });
    await expect(resolveStaffSession(dela.token)).resolves.toBeDefined();

    await setStaffActive({
      tenantId: dono.tenantId,
      actor: ator(dono),
      staffUserId: member.id,
      active: false,
    });

    await expect(resolveStaffSession(dela.token)).rejects.toMatchObject({
      code: 'invalid_session',
    });
  });

  it('reemitir a senha também derruba as sessões abertas', async () => {
    const dono = await abrirBarbearia();
    const { member, senhaInicial } = await createStaffUser({
      messaging,
      tenantId: dono.tenantId,
      actor: ator(dono),
      name: 'Maria Recepção',
      email: 'maria@domari.com.br',
      role: 'receptionist',
    });
    const dela = await staffLogin({ email: 'maria@domari.com.br', password: senhaInicial });

    const nova = await resetStaffPassword({
      messaging,
      tenantId: dono.tenantId,
      actor: ator(dono),
      staffUserId: member.id,
    });
    expect(nova.senhaInicial).not.toBe(senhaInicial);

    await expect(resolveStaffSession(dela.token)).rejects.toMatchObject({
      code: 'invalid_session',
    });
  });

  // -- a senha entregue por mensagem -----------------------------------------

  it('quem tem celular recebe a senha de primeiro acesso por mensagem', async () => {
    // A lacuna do bloco 13: a senha era gerada, mostrada uma vez e o dono a lia
    // em voz alta. Agora ela também sai pelo canal.
    const dono = await abrirBarbearia();
    const criado = await createStaffUser({
      messaging,
      tenantId: dono.tenantId,
      actor: ator(dono),
      name: 'Maria Recepção',
      email: 'maria@domari.com.br',
      phone: '(71) 97777-6666',
      role: 'receptionist',
    });

    expect(criado.entrega).toBe('enviada');
    expect(messaging.senhas).toHaveLength(1);
    expect(messaging.senhas[0]).toMatchObject({
      phoneE164: '+5571977776666',
      password: criado.senhaInicial,
      establishmentName: DONO.businessName,
    });
  });

  it('sem celular cadastrado a senha continua saindo só na resposta', async () => {
    const dono = await abrirBarbearia();
    const criado = await createStaffUser({
      messaging,
      tenantId: dono.tenantId,
      actor: ator(dono),
      name: 'Maria Recepção',
      email: 'maria@domari.com.br',
      role: 'receptionist',
    });

    expect(criado.entrega).toBe('sem_telefone');
    expect(criado.senhaInicial).toHaveLength(14);
    expect(messaging.senhas).toHaveLength(0);
  });

  it('provedor fora do ar não impede a contratação', async () => {
    // A conta é o que importa; a mensagem é conveniência. Falhar aqui deixaria
    // o dono sem conseguir contratar porque o WhatsApp caiu.
    const dono = await abrirBarbearia();
    messaging.falharProxima = true;

    const criado = await createStaffUser({
      messaging,
      tenantId: dono.tenantId,
      actor: ator(dono),
      name: 'Maria Recepção',
      email: 'maria@domari.com.br',
      phone: '(71) 97777-6666',
      role: 'receptionist',
    });

    expect(criado.entrega).toBe('falhou');
    // E a conta funciona: a senha da resposta continua sendo a da conta.
    const dela = await staffLogin({
      email: 'maria@domari.com.br',
      password: criado.senhaInicial,
    });
    expect(dela.token).toBeTruthy();
  });

  it('o registro do envio guarda o telefone mascarado, nunca a senha', async () => {
    const dono = await abrirBarbearia();
    const criado = await createStaffUser({
      messaging,
      tenantId: dono.tenantId,
      actor: ator(dono),
      name: 'Maria Recepção',
      email: 'maria@domari.com.br',
      phone: '(71) 97777-6666',
      role: 'receptionist',
    });

    const linhas = await withTenant(dono.tenantId, async (tx) =>
      tx.$queryRaw<{ kind: string; phone_masked: string; staff_user_id: string }[]>`
        SELECT kind::text, phone_masked, staff_user_id FROM notifications
      `,
    );
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.kind).toBe('senha_de_acesso');
    expect(linhas[0]?.staff_user_id).toBe(criado.member.id);
    expect(linhas[0]?.phone_masked).not.toContain('977776666');
    // O que nunca pode estar lá: a credencial viva.
    expect(JSON.stringify(linhas)).not.toContain(criado.senhaInicial);
  });

  it('reemitir a senha manda a nova, não a antiga', async () => {
    const dono = await abrirBarbearia();
    const criado = await createStaffUser({
      messaging,
      tenantId: dono.tenantId,
      actor: ator(dono),
      name: 'Maria Recepção',
      email: 'maria@domari.com.br',
      phone: '(71) 97777-6666',
      role: 'receptionist',
    });

    const nova = await resetStaffPassword({
      messaging,
      tenantId: dono.tenantId,
      actor: ator(dono),
      staffUserId: criado.member.id,
    });

    expect(nova.entrega).toBe('enviada');
    expect(messaging.senhas).toHaveLength(2);
    expect(messaging.senhas[1]?.password).toBe(nova.senhaInicial);
    expect(messaging.senhas[1]?.password).not.toBe(criado.senhaInicial);
  });

  // -- trilha ----------------------------------------------------------------

  it('registra quem criou a conta e quem mudou o papel, com antes e depois', async () => {
    const dono = await abrirBarbearia();
    const { member } = await createStaffUser({
      messaging,
      tenantId: dono.tenantId,
      actor: ator(dono),
      name: 'Maria Recepção',
      email: 'maria@domari.com.br',
      role: 'receptionist',
      ip: '189.1.2.3',
    });

    await changeStaffRole({
      tenantId: dono.tenantId,
      actor: ator(dono),
      staffUserId: member.id,
      role: 'manager',
    });

    const eventos = await withTenant(dono.tenantId, (tx) => listAudit(tx, { acoes: ACOES_DE_GESTAO }));
    expect(eventos.map((e) => e.action)).toEqual(['staff.role_changed', 'staff.created']);

    const mudanca = eventos[0];
    expect(mudanca?.actorName).toBe(DONO.name);
    // Saber que mudou sem saber de quê para quê não fecha investigação nenhuma.
    expect(mudanca?.before).toEqual({ role: 'receptionist' });
    expect(mudanca?.after).toEqual({ role: 'manager' });
  });

  /**
   * A trilha diz **em quem** o evento mexeu (bloco 104).
   *
   * Ela promete "quem mexeu em quê" e respondia só o quem: catorze das noventa
   * e duas frases terminam em "de"/"do"/"da" — "reemitiu a senha de", "exportou
   * os dados de" — esperando um nome que a tela nunca recebia. Inclusive nos
   * eventos que a LGPD exige registrar.
   *
   * O nome é resolvido na **leitura** e não gravado: `audit_log` é append-only
   * e a anonimização não o alcança, então guardá-lo lá seria uma segunda cópia
   * de dado pessoal onde a exclusão não chega.
   */
  it('o evento diz o nome de quem sofreu a ação, resolvido na leitura', async () => {
    const dono = await abrirBarbearia();
    const { member } = await createStaffUser({
      messaging,
      tenantId: dono.tenantId,
      actor: ator(dono),
      name: 'Maria Recepção',
      email: `maria${Date.now()}@domari.com.br`,
      role: 'receptionist',
    });

    await changeStaffRole({
      tenantId: dono.tenantId, actor: ator(dono), staffUserId: member.id, role: 'manager',
    });

    const eventos = await withTenant(dono.tenantId, (tx) => listAudit(tx, { acoes: ACOES_DE_GESTAO }));
    const mudanca = eventos.find((e) => e.action === 'staff.role_changed');

    expect(mudanca?.actorName).toBe(DONO.name);
    expect(mudanca?.alvoNome).toBe('Maria Recepção');
  });

  it('a trilha nunca guarda senha nem hash', async () => {
    const dono = await abrirBarbearia();
    const { senhaInicial } = await createStaffUser({
      messaging,
      tenantId: dono.tenantId,
      actor: ator(dono),
      name: 'Maria Recepção',
      email: 'maria@domari.com.br',
      role: 'receptionist',
    });

    const eventos = await withTenant(dono.tenantId, (tx) => listAudit(tx, { acoes: ACOES_DE_GESTAO }));
    const texto = JSON.stringify(eventos);
    expect(texto).not.toContain(senhaInicial);
    expect(texto).not.toContain('scrypt$');
  });

  it('a aplicação não consegue apagar nem reescrever a trilha', async () => {
    // Append-only é permissão do banco, não convenção: trilha que a aplicação
    // reescreve não prova nada, e quem chega ao role apagaria o próprio rastro.
    const dono = await abrirBarbearia();
    await createStaffUser({
      messaging,
      tenantId: dono.tenantId,
      actor: ator(dono),
      name: 'Maria Recepção',
      email: 'maria@domari.com.br',
      role: 'receptionist',
    });

    await expect(
      withTenant(dono.tenantId, (tx) => tx.$executeRawUnsafe('DELETE FROM audit_log')),
    ).rejects.toThrow();

    await expect(
      withTenant(dono.tenantId, (tx) =>
        tx.$executeRawUnsafe(`UPDATE audit_log SET action = 'mentira'`),
      ),
    ).rejects.toThrow();
  });

  // -- isolamento ------------------------------------------------------------

  it('a equipe de uma barbearia não aparece na outra', async () => {
    const dono = await abrirBarbearia();
    await createStaffUser({
      messaging,
      tenantId: dono.tenantId,
      actor: ator(dono),
      name: 'Maria Recepção',
      email: 'maria@domari.com.br',
      role: 'receptionist',
    });

    const rival = await signUpOwner({
      ...DONO,
      email: 'rival@rival.com.br',
      businessName: 'Rival Barbearia',
    });
    if (!rival.created) throw new Error('a rival deveria ter sido criada');

    const equipe = await listStaff(rival.session.tenantId);
    expect(equipe.map((m) => m.email)).toEqual(['rival@rival.com.br']);

    // Nem com o id em mãos: a RLS não enxerga a linha.
    const daOutra = (await listStaff(dono.tenantId)).find((m) => m.role === 'receptionist');
    expect(daOutra).toBeDefined();
    await expect(
      setStaffActive({
        tenantId: rival.session.tenantId,
        actor: ator(rival.session),
        staffUserId: daOutra?.id ?? '',
        active: false,
      }),
    ).rejects.toMatchObject({ code: 'staff_not_found' });
  });
  // -- o convite do barbeiro ---------------------------------------------------

  /** Cria uma cadeira no cadastro, como o onboarding faz. */
  async function cadeira(tenantId: string, nome = 'Ruan', kind = 'professional'): Promise<string> {
    const linhas = await admin.$queryRawUnsafe<{ id: string; loc: string }[]>(`
      WITH unidade AS (SELECT id FROM locations WHERE tenant_id = '${tenantId}' LIMIT 1)
      INSERT INTO professionals (tenant_id, location_id, name, kind)
      SELECT '${tenantId}', unidade.id, '${nome}', '${kind}'::professional_kind FROM unidade
      RETURNING id, location_id AS loc
    `);
    const id = linhas[0]?.id;
    if (!id) throw new Error('não deu para criar a cadeira');
    return id;
  }

  it('convidar liga a cadeira à conta e manda a senha', async () => {
    /**
     * A lacuna do bloco 12: `professional_id` tinha coluna, chave estrangeira e
     * recorte de agenda — e nada a preenchia. O barbeiro entrava com a conta do
     * dono, que é o incidente que aquele bloco existia para impedir.
     */
    const dono = await abrirBarbearia();
    const ruan = await cadeira(dono.tenantId);

    const convidado = await convidarProfissional({
      messaging,
      tenantId: dono.tenantId,
      actor: ator(dono),
      professionalId: ruan,
      email: 'ruan@domari.com.br',
      phone: '(71) 96666-5555',
    });

    expect(convidado.member.role).toBe('professional');
    expect(convidado.member.professionalId).toBe(ruan);
    expect(convidado.member.name).toBe('Ruan');
    expect(convidado.entrega).toBe('enviada');
    expect(messaging.senhas[0]?.password).toBe(convidado.senhaInicial);

    // Ele entra, e a sessão dele resolve para a própria cadeira.
    const dele = await staffLogin({
      email: 'ruan@domari.com.br',
      password: convidado.senhaInicial,
    });
    expect((await resolveStaffSession(dele.token)).professionalId).toBe(ruan);
  });

  it('o telefone fica na cadeira, para o reenvio não pedir de novo', async () => {
    const dono = await abrirBarbearia();
    const ruan = await cadeira(dono.tenantId);

    await convidarProfissional({
      messaging,
      tenantId: dono.tenantId,
      actor: ator(dono),
      professionalId: ruan,
      email: 'ruan@domari.com.br',
      phone: '(71) 96666-5555',
    });

    const linhas = await admin.$queryRawUnsafe<{ phone_e164: string }[]>(
      `SELECT phone_e164 FROM professionals WHERE id = '${ruan}'`,
    );
    expect(linhas[0]?.phone_e164).toBe('+5571966665555');
  });

  it('a mesma cadeira não recebe dois convites', async () => {
    // Duas contas na mesma cadeira veriam a mesma agenda como "minha", e a
    // comissão — que sai de `professional_id` — teria dois donos.
    const dono = await abrirBarbearia();
    const ruan = await cadeira(dono.tenantId);

    const convidar = (email: string) =>
      convidarProfissional({
        messaging,
        tenantId: dono.tenantId,
        actor: ator(dono),
        professionalId: ruan,
        email,
      });

    await convidar('ruan@domari.com.br');
    await expect(convidar('outro@domari.com.br')).rejects.toMatchObject({
      code: 'professional_already_invited',
    });
  });

  it('agenda de recurso não é pessoa e não recebe convite', async () => {
    /**
     * O defeito D12 do sistema analisado: duas das quatro "agendas" eram contas
     * de balcão com jornada 08:00–23:00. Mandar senha para "Cadeira 2" cria uma
     * conta que ninguém usa e que ninguém desliga.
     */
    const dono = await abrirBarbearia();
    const balcao = await cadeira(dono.tenantId, 'Cadeira 2', 'resource_only');

    await expect(
      convidarProfissional({
        messaging,
        tenantId: dono.tenantId,
        actor: ator(dono),
        professionalId: balcao,
        email: 'cadeira2@domari.com.br',
      }),
    ).rejects.toMatchObject({ code: 'professional_not_found' });
  });

  it('a cadeira de outra barbearia não existe para quem convida', async () => {
    /**
     * A chave estrangeira **não** protege: a checagem de integridade
     * referencial ignora row security. O que recusa é o `SELECT` sob RLS antes
     * de gravar — sem ele, o dono da rival criaria uma conta na barbearia dele
     * apontando para a cadeira da casa, e leria a agenda alheia.
     */
    const dono = await abrirBarbearia();
    const ruan = await cadeira(dono.tenantId);

    const rival = await signUpOwner({
      ...DONO,
      email: 'rival@rival.com.br',
      businessName: 'Rival Barbearia',
    });
    if (!rival.created) throw new Error('a rival deveria ter sido criada');

    await expect(
      convidarProfissional({
        messaging,
        tenantId: rival.session.tenantId,
        actor: ator(rival.session),
        professionalId: ruan,
        email: 'espiao@rival.com.br',
      }),
    ).rejects.toMatchObject({ code: 'professional_not_found' });
  });

  it('o convite registra na trilha quem criou a conta', async () => {
    const dono = await abrirBarbearia();
    const ruan = await cadeira(dono.tenantId);

    const convidado = await convidarProfissional({
      messaging,
      tenantId: dono.tenantId,
      actor: ator(dono),
      professionalId: ruan,
      email: 'ruan@domari.com.br',
    });

    const eventos = await withTenant(dono.tenantId, (tx) => listAudit(tx, { acoes: ACOES_DE_GESTAO }));
    const criacao = eventos.find(
      (linha) => linha.action === 'staff.created' && linha.entityId === convidado.member.id,
    );
    expect(criacao?.actorName).toBe(DONO.name);
  });

  // -- editar as permissões de um papel (bloco 30) ---------------------------

  it('o dono redefine o que a recepção pode, e vale na sessão seguinte', async () => {
    const dono = await abrirBarbearia();
    const { senhaInicial } = await createStaffUser({
      messaging,
      tenantId: dono.tenantId,
      actor: ator(dono),
      name: 'Bianca',
      email: `bianca${Date.now()}@teste.com`,
      role: 'receptionist',
    });
    const membros = await listStaff(dono.tenantId);
    const bianca = membros.find((m) => m.name === 'Bianca');

    await definirPermissoesDoPapel({
      tenantId: dono.tenantId,
      papel: 'receptionist',
      permissoes: ['appointments.view', 'customers.view'],
      actor: ator(dono),
    });

    const sessao = await staffLogin({ email: bianca!.email, password: senhaInicial });
    const resolvida = await resolveStaffSession(sessao.token);
    expect([...resolvida.permissions].sort()).toEqual(['appointments.view', 'customers.view']);
  });

  it('mandar a mesma lista duas vezes dá o mesmo resultado', async () => {
    // A tela manda o conjunto inteiro, não um diff — então repetir é o caso
    // comum (duas abas, um duplo toque), não a exceção.
    const dono = await abrirBarbearia();
    const lista = ['appointments.view', 'appointments.create'];

    await definirPermissoesDoPapel({
      tenantId: dono.tenantId, papel: 'professional', permissoes: lista, actor: ator(dono),
    });
    await definirPermissoesDoPapel({
      tenantId: dono.tenantId, papel: 'professional', permissoes: lista, actor: ator(dono),
    });

    const mapa = await permissionsByRole(dono.tenantId);
    expect([...(mapa['professional'] ?? [])].sort()).toEqual([...lista].sort());
  });

  it('lista repetida não vira permissão duplicada', async () => {
    const dono = await abrirBarbearia();
    await definirPermissoesDoPapel({
      tenantId: dono.tenantId,
      papel: 'manager',
      permissoes: ['appointments.view', 'appointments.view', 'appointments.view'],
      actor: ator(dono),
    });
    const mapa = await permissionsByRole(dono.tenantId);
    expect(mapa['manager']).toEqual(['appointments.view']);
  });

  /**
   * A recusa que impede a barbearia de ficar sem dono.
   *
   * Sem ela, um clique tira `team.manage` de quem poderia devolvê-la — e o
   * estado só sai com acesso ao banco de produção.
   */
  it('o papel do dono não se edita', async () => {
    const dono = await abrirBarbearia();
    await expect(
      definirPermissoesDoPapel({
        tenantId: dono.tenantId, papel: 'owner', permissoes: [], actor: ator(dono),
      }),
    ).rejects.toMatchObject({ code: 'owner_protected' });

    const mapa = await permissionsByRole(dono.tenantId);
    expect([...(mapa['owner'] ?? [])].sort()).toEqual([...PERMISSOES].sort());
  });

  it('permissão fora do catálogo é recusada antes de chegar ao banco', async () => {
    const dono = await abrirBarbearia();
    await expect(
      definirPermissoesDoPapel({
        tenantId: dono.tenantId,
        papel: 'manager',
        permissoes: ['appointments.view', 'finance.tudo'],
        actor: ator(dono),
      }),
    ).rejects.toMatchObject({ code: 'unknown_permission' });

    // E nada foi gravado no caminho: a recusa vem antes de qualquer escrita.
    const mapa = await permissionsByRole(dono.tenantId);
    expect([...(mapa['manager'] ?? [])].sort()).toEqual([...permissoesPadrao('manager')].sort());
  });

  it('a mudança fica na trilha, com antes e depois', async () => {
    // "Quem deu acesso ao caixa para essa pessoa?" é a primeira pergunta depois
    // de um incidente, e a resposta não pode ser o estado atual da tabela.
    const dono = await abrirBarbearia();
    await definirPermissoesDoPapel({
      tenantId: dono.tenantId,
      papel: 'receptionist',
      permissoes: ['appointments.view', 'cashier.open', 'finance.view'],
      actor: ator(dono),
    });

    const trilha = await withTenant(dono.tenantId, (tx) =>
      tx.$queryRaw<{ action: string; actor_name: string; before: unknown; after: unknown }[]>`
        SELECT action, actor_name, before, after FROM audit_log
         WHERE action = 'permissions.changed'
      `,
    );
    expect(trilha).toHaveLength(1);
    expect(trilha[0]?.actor_name).toBe(dono.name);
    expect((trilha[0]?.before as { permissoes: string[] }).permissoes).toContain('appointments.create');
    expect((trilha[0]?.after as { permissoes: string[] }).permissoes).toContain('finance.view');
  });

  it('tirar tudo de um papel é permitido, e deixa a conta sem alcance', async () => {
    // Recusar seria inventar uma regra que ninguém pediu. O que **não** se
    // permite é fazer isso com o dono, e essa é a recusa que importa.
    const dono = await abrirBarbearia();
    await definirPermissoesDoPapel({
      tenantId: dono.tenantId, papel: 'receptionist', permissoes: [], actor: ator(dono),
    });
    const mapa = await permissionsByRole(dono.tenantId);
    expect(mapa['receptionist']).toEqual([]);
  });

  /**
   * A quarta recusa, e a que só importa no futuro que este bloco cria.
   *
   * Hoje só o dono tem `team.manage`, e o dono já tem tudo — então nenhuma
   * concessão dele excede o que ele possui. Mas a premissa do bloco é que
   * `role_permissions` é **editável**: no dia em que o dono delegar
   * `team.manage` a um gerente, esse gerente se concederia
   * `finance.view_profit` e `customers.export` num clique.
   *
   * É o mesmo raciocínio que já protege `resetStaffPassword`,
   * `changeStaffRole` e `setStaffActive` — escrito lá desde o bloco 21, e que
   * faltava justamente na rota mais poderosa das quatro.
   */
  it('quem edita permissão não concede o que não tem', async () => {
    const dono = await abrirBarbearia();

    // O dono delega a gestão de equipe ao gerente. É o cenário inteiro.
    await definirPermissoesDoPapel({
      tenantId: dono.tenantId,
      papel: 'manager',
      permissoes: ['appointments.view', 'customers.view', 'team.manage'],
      actor: ator(dono),
    });

    const { senhaInicial } = await createStaffUser({
      messaging,
      tenantId: dono.tenantId,
      actor: ator(dono),
      name: 'Gerente',
      email: `gerente${Date.now()}@teste.com`,
      role: 'manager',
    });
    const membros = await listStaff(dono.tenantId);
    const gerente = membros.find((m) => m.name === 'Gerente');
    await staffLogin({ email: gerente!.email, password: senhaInicial });

    const comoGerente = { id: gerente!.id, name: 'Gerente' };

    // O que ele tem, ele passa adiante.
    await definirPermissoesDoPapel({
      tenantId: dono.tenantId,
      papel: 'receptionist',
      permissoes: ['appointments.view', 'customers.view'],
      actor: comoGerente,
    });

    // O que ele não tem, não.
    await expect(
      definirPermissoesDoPapel({
        tenantId: dono.tenantId,
        papel: 'receptionist',
        permissoes: ['appointments.view', 'finance.view_profit'],
        actor: comoGerente,
      }),
    ).rejects.toMatchObject({ code: 'cannot_grant' });

    // E nem para si mesmo, que é o caminho direto da escalada.
    await expect(
      definirPermissoesDoPapel({
        tenantId: dono.tenantId,
        papel: 'manager',
        permissoes: ['team.manage', 'customers.export'],
        actor: comoGerente,
      }),
    ).rejects.toMatchObject({ code: 'cannot_grant' });

    // A recusa não gravou nada pelo caminho.
    const mapa = await permissionsByRole(dono.tenantId);
    expect([...(mapa['receptionist'] ?? [])].sort()).toEqual(['appointments.view', 'customers.view']);
    expect(mapa['manager']).toContain('team.manage');
  });

  /**
   * A guarda de escalada nas **quatro** portas (bloco 104).
   *
   * `recusarPapelAcimaDoAtor` é a proteção contra tomada de conta em uma
   * requisição, e tinha **zero** testes: apagar as três chamadas deixava a
   * suíte de `identity` e o e2e da API verdes. As únicas asserções de
   * `cannot_grant` exercitavam `definirPermissoesDoPapel` e
   * `definirUnidadesDoOperador`, que são outras funções.
   *
   * `setStaffActive` era a quarta porta e não chamava a guarda — só protegia o
   * dono —, enquanto três comentários deste arquivo afirmavam que ela protegia
   * como as outras. Ali o estrago não é ganho de permissão: é desligar o
   * gerente e derrubar as sessões dele no meio do expediente.
   *
   * A semente satisfaz **tudo menos** a regra sob teste: o gerente tem
   * `team.manage` de verdade, está ativo, e o alvo existe. O que separa é só o
   * alcance do papel.
   */
  it('quem tem team.manage não alcança papel acima do dele, nas quatro portas', async () => {
    const dono = await abrirBarbearia();

    // O dono delega gestão de equipe à recepção. É a configuração que o bloco
    // 30 passou a suportar, e é onde a escalada nasce.
    await definirPermissoesDoPapel({
      tenantId: dono.tenantId,
      papel: 'receptionist',
      permissoes: ['appointments.view', 'customers.view', 'team.manage'],
      actor: ator(dono),
    });

    const { senhaInicial } = await createStaffUser({
      messaging,
      tenantId: dono.tenantId,
      actor: ator(dono),
      name: 'Recepcao',
      email: `recepcao${Date.now()}@teste.com`,
      role: 'receptionist',
    });
    await createStaffUser({
      messaging,
      tenantId: dono.tenantId,
      actor: ator(dono),
      name: 'Gerente',
      email: `gerente${Date.now()}@teste.com`,
      role: 'manager',
    });

    const membros = await listStaff(dono.tenantId);
    const recepcao = membros.find((m) => m.name === 'Recepcao');
    const gerente = membros.find((m) => m.name === 'Gerente');
    await staffLogin({ email: recepcao!.email, password: senhaInicial });
    const comoRecepcao = { id: recepcao!.id, name: 'Recepcao' };

    // 1. Promover a si mesma — o caminho mais curto da escalada.
    await expect(
      changeStaffRole({
        tenantId: dono.tenantId, actor: comoRecepcao, staffUserId: recepcao!.id, role: 'manager',
      }),
    ).rejects.toMatchObject({ code: 'cannot_grant' });

    // 2. Criar uma conta acima dela e entrar por ela.
    await expect(
      createStaffUser({
        messaging,
        tenantId: dono.tenantId,
        actor: comoRecepcao,
        name: 'Atalho',
        email: `atalho${Date.now()}@teste.com`,
        role: 'manager',
      }),
    ).rejects.toMatchObject({ code: 'cannot_grant' });

    // 3. Reemitir a senha do gerente e entrar como ele.
    await expect(
      resetStaffPassword({
        messaging, tenantId: dono.tenantId, actor: comoRecepcao, staffUserId: gerente!.id,
      }),
    ).rejects.toMatchObject({ code: 'cannot_grant' });

    // 4. Desligar o gerente — não é ganho de permissão, é derrubar a operação
    //    dele: a mesma transação revoga as sessões abertas.
    await expect(
      setStaffActive({
        tenantId: dono.tenantId, actor: comoRecepcao, staffUserId: gerente!.id, active: false,
      }),
    ).rejects.toMatchObject({ code: 'cannot_grant' });

    // Nada aconteceu por nenhum dos quatro caminhos.
    const depois = await listStaff(dono.tenantId);
    expect(depois.find((m) => m.name === 'Recepcao')?.role).toBe('receptionist');
    expect(depois.find((m) => m.name === 'Gerente')?.active).toBe(true);
    expect(depois.find((m) => m.name === 'Atalho')).toBeUndefined();
  });

  it('o que está dentro do alcance dela continua funcionando', async () => {
    /**
     * O outro lado, e sem ele o caso acima passaria com a guarda recusando
     * tudo — que seria um defeito pior, porque trancaria quem administra.
     */
    const dono = await abrirBarbearia();
    /**
     * O gerente **de fábrica**, mais `team.manage` — e não uma lista curta.
     *
     * A primeira versão deste caso dava três permissões a ele e mandava criar
     * uma recepcionista: recusado, corretamente, porque o papel de recepção tem
     * `appointments.create` e o gerente empobrecido não tinha. O suspeito era o
     * teste, não a guarda — quem alcança tem que alcançar de verdade.
     */
    await definirPermissoesDoPapel({
      tenantId: dono.tenantId,
      papel: 'manager',
      permissoes: [...new Set([...permissoesPadrao('manager'), 'team.manage'])],
      actor: ator(dono),
    });

    const { senhaInicial } = await createStaffUser({
      messaging, tenantId: dono.tenantId, actor: ator(dono),
      name: 'Gerente', email: `ger${Date.now()}@teste.com`, role: 'manager',
    });
    const membros = await listStaff(dono.tenantId);
    const gerente = membros.find((m) => m.name === 'Gerente');
    await staffLogin({ email: gerente!.email, password: senhaInicial });
    const comoGerente = { id: gerente!.id, name: 'Gerente' };

    // `receptionist` não tem nada que o gerente não tenha: ele alcança.
    const nova = await createStaffUser({
      messaging, tenantId: dono.tenantId, actor: comoGerente,
      name: 'Nova', email: `nova${Date.now()}@teste.com`, role: 'receptionist',
    });
    expect(nova.senhaInicial).toBeTruthy();

    const comNova = await listStaff(dono.tenantId);
    const alvo = comNova.find((m) => m.name === 'Nova');
    await setStaffActive({
      tenantId: dono.tenantId, actor: comoGerente, staffUserId: alvo!.id, active: false,
    });
    const fim = await listStaff(dono.tenantId);
    expect(fim.find((m) => m.name === 'Nova')?.active).toBe(false);
  });

  it('o dono continua concedendo tudo, porque tudo é o que ele tem', async () => {
    const dono = await abrirBarbearia();
    await definirPermissoesDoPapel({
      tenantId: dono.tenantId,
      papel: 'manager',
      permissoes: [...PERMISSOES],
      actor: ator(dono),
    });
    const mapa = await permissionsByRole(dono.tenantId);
    expect([...(mapa['manager'] ?? [])].sort()).toEqual([...PERMISSOES].sort());
  });

  // -- unidades da equipe (bloco 58) -----------------------------------------

  /** A segunda loja, que nenhuma barbearia tem até alguém abrir uma. */
  async function abrirFilial(tenantId: string): Promise<string> {
    const linhas = await admin.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO locations (tenant_id, name, timezone)
       VALUES ($1::uuid, 'Filial Pituba', 'America/Bahia') RETURNING id`,
      tenantId,
    );
    const filial = linhas[0]?.id;
    if (!filial) throw new Error('a filial deveria ter sido criada');
    return filial;
  }

  it('lista vazia é o padrão e significa todas as unidades', async () => {
    const sessao = await abrirBarbearia();
    expect(await unidadesPorOperador(sessao.tenantId)).toEqual({});
  });

  it('escopar alguém a uma unidade derruba a escolha das sessões abertas dessa pessoa', async () => {
    /**
     * Tirar o gerente da filial e deixá-lo com a filial selecionada no
     * navegador é tirar no papel e não tirar de fato — é o mesmo motivo de
     * `setStaffActive` revogar sessão.
     */
    const dono = await abrirBarbearia();
    const filial = await abrirFilial(dono.tenantId);
    const criado = await createStaffUser({
      tenantId: dono.tenantId, actor: ator(dono), name: 'Vitória',
      email: 'vi@domari.com.br', role: 'manager', messaging,
    });
    const sessao = await staffLogin({ email: 'vi@domari.com.br', password: criado.senhaInicial });
    await admin.$executeRawUnsafe(
      `UPDATE staff_sessions SET location_id = $1::uuid WHERE staff_user_id = $2::uuid`,
      filial,
      criado.member.id,
    );

    await definirUnidadesDoOperador({
      tenantId: dono.tenantId, actor: ator(dono),
      staffUserId: criado.member.id, unidades: [filial],
    });

    const depois = await resolveStaffSession(sessao.token);
    expect(depois.unidadeEscolhidaId).toBeNull();
    expect(depois.unidadesAutorizadas).toEqual([filial]);
  });

  it('o dono opera todas as unidades, e isso não se edita', async () => {
    // É a única conta que não pode ficar trancada para fora do próprio negócio.
    // Escopá-lo a uma loja faria vinte rotas do painel devolverem 404 para ele.
    const dono = await abrirBarbearia();
    const filial = await abrirFilial(dono.tenantId);
    await expect(
      definirUnidadesDoOperador({
        tenantId: dono.tenantId, actor: ator(dono),
        staffUserId: dono.staffUserId, unidades: [filial],
      }),
    ).rejects.toMatchObject({ code: 'owner_protected' });
  });

  it('quem administra só uma unidade não se promove a todas', async () => {
    /**
     * Achado da `/security-review` do bloco 58: um `team.manage` escopado à
     * filial chamava esta rota sobre a própria conta com lista vazia — que
     * significa "todas" — e passava a operar a rede inteira no toque seguinte.
     * O seletor recusava a matriz; a rota que **alimenta** o seletor a entregava.
     */
    const dono = await abrirBarbearia();
    const filial = await abrirFilial(dono.tenantId);
    const gerente = await createStaffUser({
      tenantId: dono.tenantId, actor: ator(dono), name: 'Vitória',
      email: 'vi@domari.com.br', role: 'manager', messaging,
    });
    await definirUnidadesDoOperador({
      tenantId: dono.tenantId, actor: ator(dono),
      staffUserId: gerente.member.id, unidades: [filial],
    });

    const dela = { id: gerente.member.id, name: 'Vitória' };
    await expect(
      definirUnidadesDoOperador({
        tenantId: dono.tenantId, actor: dela,
        staffUserId: gerente.member.id, unidades: [],
      }),
    ).rejects.toMatchObject({ code: 'cannot_grant' });

    // Nem a matriz, que ela não administra.
    const matriz = await admin.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM locations WHERE tenant_id = $1::uuid AND id <> $2::uuid`,
      dono.tenantId,
      filial,
    );
    await expect(
      definirUnidadesDoOperador({
        tenantId: dono.tenantId, actor: dela,
        staffUserId: gerente.member.id, unidades: [matriz[0]?.id ?? filial],
      }),
    ).rejects.toMatchObject({ code: 'cannot_grant' });
  });

  it('a unidade da barbearia vizinha é recusada, apesar de a chave estrangeira aceitá-la', async () => {
    const primeira = await abrirBarbearia();
    const segunda = await signUpOwner({
      ...DONO, email: 'dono@vizinha.com.br', businessName: 'Vizinha Barber',
    });
    if (!segunda.created) throw new Error('a vizinha deveria ter sido criada');
    const deles = await abrirFilial(segunda.session.tenantId);

    const criado = await createStaffUser({
      tenantId: primeira.tenantId, actor: ator(primeira), name: 'Vitória',
      email: 'vi@domari.com.br', role: 'manager', messaging,
    });

    await expect(
      definirUnidadesDoOperador({
        tenantId: primeira.tenantId, actor: ator(primeira),
        staffUserId: criado.member.id, unidades: [deles],
      }),
    ).rejects.toMatchObject({ code: 'unknown_location' });
  });

  it('a trilha registra quantas unidades, nunca quais', async () => {
    // Uma lista de uuid em `audit_log` não responde nada a quem lê a trilha —
    // é a mesma decisão do `{ tinha: true }` do CPF no bloco 54.
    const dono = await abrirBarbearia();
    const filial = await abrirFilial(dono.tenantId);
    const criado = await createStaffUser({
      tenantId: dono.tenantId, actor: ator(dono), name: 'Vitória',
      email: 'vi@domari.com.br', role: 'manager', messaging,
    });
    await definirUnidadesDoOperador({
      tenantId: dono.tenantId, actor: ator(dono),
      staffUserId: criado.member.id, unidades: [filial],
    });

    const eventos = await withTenant(dono.tenantId, (tx) =>
      listAudit(tx, { acoes: ['team.locations_changed'] }),
    );
    expect(eventos).toHaveLength(1);
    expect(JSON.stringify(eventos[0]?.after)).not.toContain(filial);
  });

  it('a permissão de uma barbearia não alcança a outra', async () => {
    const primeira = await abrirBarbearia();
    const segunda = await signUpOwner({
      ...DONO,
      email: 'dono@vizinha.com.br',
      businessName: 'Vizinha Barber',
    });
    if (!segunda.created) throw new Error('a vizinha deveria ter sido criada');

    await definirPermissoesDoPapel({
      tenantId: primeira.tenantId, papel: 'receptionist', permissoes: [], actor: ator(primeira),
    });

    const daSegunda = await permissionsByRole(segunda.session.tenantId);
    expect([...(daSegunda['receptionist'] ?? [])].sort()).toEqual(
      [...permissoesPadrao('receptionist')].sort(),
    );
  });
});
