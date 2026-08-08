import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PAPEIS, PERMISSOES, permissoesPadrao } from '@barbearia/core';
import { withTenant } from '@barbearia/db';
import {
  changeOwnPassword,
  changeStaffRole,
  createStaffUser,
  listStaff,
  permissionsByRole,
  convidarProfissional,
  resetStaffPassword,
  setStaffActive,
} from './team.js';
import { FakeMessagingProvider } from './messaging.js';
import { resolveStaffSession, signUpOwner, staffLogin } from './staff.js';
import { listAudit } from './audit.js';

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

    const eventos = await withTenant(dono.tenantId, (tx) => listAudit(tx));
    expect(eventos.map((e) => e.action)).toEqual(['staff.role_changed', 'staff.created']);

    const mudanca = eventos[0];
    expect(mudanca?.actorName).toBe(DONO.name);
    // Saber que mudou sem saber de quê para quê não fecha investigação nenhuma.
    expect(mudanca?.before).toEqual({ role: 'receptionist' });
    expect(mudanca?.after).toEqual({ role: 'manager' });
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

    const eventos = await withTenant(dono.tenantId, (tx) => listAudit(tx));
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

    const eventos = await withTenant(dono.tenantId, (tx) => listAudit(tx));
    const criacao = eventos.find(
      (linha) => linha.action === 'staff.created' && linha.entityId === convidado.member.id,
    );
    expect(criacao?.actorName).toBe(DONO.name);
  });
});
