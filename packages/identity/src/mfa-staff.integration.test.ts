import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signUpOwner, resolveStaffSession, staffLogin, type StaffSession } from './staff.js';
import { codigoDoPasso, passoAgora, MfaError } from './mfa.js';
import {
  confirmarCadastroMfa,
  desligarMfa,
  estadoDoMfa,
  iniciarCadastroMfa,
  segundoFatorValido,
  definirExigenciaDeSegundoFator,
  exigeSegundoFator,
  verificarSegundoFator,
  VALIDADE_DO_SEGUNDO_FATOR_MINUTOS,
} from './mfa-staff.js';

/**
 * Segundo fator contra banco real.
 *
 * O algoritmo já tem teste puro em `mfa.test.ts`. O que só aparece aqui é o que
 * o banco guarda: que o segredo não fica em claro, que o código usado não vale
 * de novo, que o código de recuperação some depois de usado, e que a
 * conferência marca **a sessão** e não o usuário.
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

describeIfDb('segundo fator do gestor', () => {
  let sessao: StaffSession;

  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    process.env['STAFF_EMAIL_PEPPER'] = 'pepper-de-teste';
    // 32 bytes em base64, só para o teste. Em produção vem do ambiente.
    process.env['MFA_SECRET_KEY'] = Buffer.alloc(32, 7).toString('base64');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await admin.$executeRawUnsafe('TRUNCATE staff_directory CASCADE');
    const criado = await signUpOwner(CONTA);
    if (!criado.created) throw new Error('conta de teste não foi criada');
    sessao = criado.session;
  });

  const sessionId = async (): Promise<string> =>
    (await resolveStaffSession(sessao.token)).sessionId;

  const ligar = async (agora = new Date()) => {
    const inicio = await iniciarCadastroMfa({
      tenantId: sessao.tenantId,
      staffUserId: sessao.staffUserId,
      barbearia: CONTA.businessName,
    });
    const confirmado = await confirmarCadastroMfa({
      tenantId: sessao.tenantId,
      staffUserId: sessao.staffUserId,
      staffName: CONTA.name,
      codigo: codigoDoPasso(inicio.segredoBase32, passoAgora(agora)),
      now: agora,
    });
    return { ...inicio, ...confirmado };
  };

  it('o segredo é gravado cifrado, nunca em base32 legível', async () => {
    const inicio = await iniciarCadastroMfa({
      tenantId: sessao.tenantId,
      staffUserId: sessao.staffUserId,
      barbearia: CONTA.businessName,
    });

    const linhas = await admin.$queryRawUnsafe<{ totp_secret: string }[]>(
      `SELECT totp_secret FROM staff_users WHERE id = '${sessao.staffUserId}'`,
    );
    const guardado = linhas[0]?.totp_secret ?? '';

    expect(guardado).not.toContain(inicio.segredoBase32);
    // nonce.tag.dados — o formato do AES-256-GCM deste projeto.
    expect(guardado.split('.')).toHaveLength(3);
  });

  it('começar o cadastro não liga o segundo fator; confirmar liga', async () => {
    await iniciarCadastroMfa({
      tenantId: sessao.tenantId,
      staffUserId: sessao.staffUserId,
      barbearia: CONTA.businessName,
    });
    expect(await estadoDoMfa(sessao.tenantId, sessao.staffUserId)).toEqual({
      ativo: false,
      pendente: true,
    });

    await ligar();
    expect(await estadoDoMfa(sessao.tenantId, sessao.staffUserId)).toEqual({
      ativo: true,
      pendente: false,
    });
  });

  it('código errado não confirma o cadastro', async () => {
    await iniciarCadastroMfa({
      tenantId: sessao.tenantId,
      staffUserId: sessao.staffUserId,
      barbearia: CONTA.businessName,
    });

    await expect(
      confirmarCadastroMfa({
        tenantId: sessao.tenantId,
        staffUserId: sessao.staffUserId,
        staffName: CONTA.name,
        codigo: '000000',
        now: new Date(),
      }),
    ).rejects.toBeInstanceOf(MfaError);

    expect((await estadoDoMfa(sessao.tenantId, sessao.staffUserId)).ativo).toBe(false);
  });

  it('quem já confirmou não recomeça o cadastro sem provar o atual', async () => {
    await ligar();
    await expect(
      iniciarCadastroMfa({
        tenantId: sessao.tenantId,
        staffUserId: sessao.staffUserId,
        barbearia: CONTA.businessName,
      }),
    ).rejects.toMatchObject({ code: 'already_enabled' });
  });

  it('conferir marca a sessão, e só ela', async () => {
    const agora = new Date();
    const ligado = await ligar(agora);

    const outra = await staffLogin({ email: CONTA.email, password: CONTA.password });
    const idDaOutra = (await resolveStaffSession(outra.token)).sessionId;

    const depois = new Date(agora.getTime() + 60_000);
    await verificarSegundoFator({
      tenantId: sessao.tenantId,
      staffUserId: sessao.staffUserId,
      staffName: CONTA.name,
      sessionId: await sessionId(),
      codigo: codigoDoPasso(ligado.segredoBase32, passoAgora(depois)),
      now: depois,
    });

    expect((await resolveStaffSession(sessao.token)).mfaVerifiedAt).toBeInstanceOf(Date);
    // A outra sessão do mesmo gestor continua sem prova: a exigência é do
    // aparelho que está na frente do caixa, não da pessoa em abstrato.
    expect((await resolveStaffSession(outra.token)).mfaVerifiedAt).toBeNull();
    expect(idDaOutra).not.toBe(await sessionId());
  });

  it('o mesmo código não vale duas vezes na mesma janela', async () => {
    const agora = new Date();
    const ligado = await ligar(agora);

    const depois = new Date(agora.getTime() + 60_000);
    const codigo = codigoDoPasso(ligado.segredoBase32, passoAgora(depois));
    const id = await sessionId();

    await verificarSegundoFator({
      tenantId: sessao.tenantId,
      staffUserId: sessao.staffUserId,
      staffName: CONTA.name,
      sessionId: id,
      codigo,
      now: depois,
    });

    await expect(
      verificarSegundoFator({
        tenantId: sessao.tenantId,
        staffUserId: sessao.staffUserId,
        staffName: CONTA.name,
        sessionId: id,
        codigo,
        now: depois,
      }),
    ).rejects.toMatchObject({ code: 'invalid_code' });
  });

  it('código de recuperação serve uma vez e some do banco', async () => {
    const ligado = await ligar();
    const primeiro = ligado.codigosDeRecuperacao[0];
    if (!primeiro) throw new Error('nenhum código de recuperação foi gerado');

    const usado = await verificarSegundoFator({
      tenantId: sessao.tenantId,
      staffUserId: sessao.staffUserId,
      staffName: CONTA.name,
      sessionId: await sessionId(),
      codigo: primeiro,
      now: new Date(),
    });

    expect(usado.usouRecuperacao).toBe(true);
    expect(usado.restantes).toBe(ligado.codigosDeRecuperacao.length - 1);

    await expect(
      verificarSegundoFator({
        tenantId: sessao.tenantId,
        staffUserId: sessao.staffUserId,
        staffName: CONTA.name,
        sessionId: await sessionId(),
        codigo: primeiro,
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'invalid_code' });
  });

  it('os códigos de recuperação não ficam legíveis no banco', async () => {
    const ligado = await ligar();
    const linhas = await admin.$queryRawUnsafe<{ recovery_codes: string[] }[]>(
      `SELECT recovery_codes FROM staff_users WHERE id = '${sessao.staffUserId}'`,
    );
    const guardados = (linhas[0]?.recovery_codes ?? []).join(' ');

    for (const codigo of ligado.codigosDeRecuperacao) {
      expect(guardados).not.toContain(codigo.replace('-', ''));
      expect(guardados).not.toContain(codigo);
    }
    expect(guardados).toContain('scrypt$');
  });

  it('sem segundo fator ativo não há o que conferir', async () => {
    await expect(
      verificarSegundoFator({
        tenantId: sessao.tenantId,
        staffUserId: sessao.staffUserId,
        staffName: CONTA.name,
        sessionId: await sessionId(),
        codigo: '123456',
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'not_enabled' });
  });

  it('quem tem permissão de dinheiro não desliga o segundo fator', async () => {
    const agora = new Date();
    const ligado = await ligar(agora);
    const depois = new Date(agora.getTime() + 60_000);

    await expect(
      desligarMfa({
        tenantId: sessao.tenantId,
        staffUserId: sessao.staffUserId,
        staffName: CONTA.name,
        sessionId: await sessionId(),
        permissoes: ['finance.view'],
        exigidoNaBarbearia: true,
        codigo: codigoDoPasso(ligado.segredoBase32, passoAgora(depois)),
        now: depois,
      }),
    ).rejects.toMatchObject({ code: 'already_enabled' });

    expect((await estadoDoMfa(sessao.tenantId, sessao.staffUserId)).ativo).toBe(true);
  });

  it('quem não mexe em dinheiro desliga, provando o código', async () => {
    const agora = new Date();
    const ligado = await ligar(agora);
    const depois = new Date(agora.getTime() + 60_000);

    await desligarMfa({
      tenantId: sessao.tenantId,
      staffUserId: sessao.staffUserId,
      staffName: CONTA.name,
      sessionId: await sessionId(),
      permissoes: ['appointments.create'],
      exigidoNaBarbearia: true,
      codigo: codigoDoPasso(ligado.segredoBase32, passoAgora(depois)),
      now: depois,
    });

    expect(await estadoDoMfa(sessao.tenantId, sessao.staffUserId)).toEqual({
      ativo: false,
      pendente: false,
    });
    expect((await resolveStaffSession(sessao.token)).mfaVerifiedAt).toBeNull();
  });

  it('desligar sem o código não desliga', async () => {
    await ligar();
    await expect(
      desligarMfa({
        tenantId: sessao.tenantId,
        staffUserId: sessao.staffUserId,
        staffName: CONTA.name,
        sessionId: await sessionId(),
        permissoes: ['appointments.create'],
        exigidoNaBarbearia: true,
        codigo: '000000',
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'invalid_code' });

    expect((await estadoDoMfa(sessao.tenantId, sessao.staffUserId)).ativo).toBe(true);
  });

  it('o segundo fator de uma barbearia não é visível para a outra', async () => {
    await ligar();

    const outra = await signUpOwner({ ...CONTA, email: 'outro@rival.com.br', businessName: 'Rival' });
    if (!outra.created) throw new Error('segunda conta não foi criada');

    await expect(
      estadoDoMfa(outra.session.tenantId, sessao.staffUserId),
    ).rejects.toMatchObject({ code: 'not_enabled' });
  });

  // -- a trilha ---------------------------------------------------------------

  const trilha = async (): Promise<string[]> => {
    const linhas = await admin.$queryRawUnsafe<{ action: string }[]>(
      `SELECT action FROM audit_log WHERE tenant_id = '${sessao.tenantId}' ORDER BY id`,
    );
    return linhas.map((l) => l.action);
  };

  it('ligar o segundo fator fica na trilha', async () => {
    await ligar();
    expect(await trilha()).toContain('mfa.enabled');
  });

  it('o uso de código de recuperação fica na trilha, com quantos sobraram', async () => {
    /**
     * É o evento mais importante desta trilha. Os dois caminhos entram pelo
     * mesmo endpoint, e sem esta linha um código encontrado numa gaveta
     * destrancaria o caixa sem deixar rastro nenhum: o único sinal seria um
     * contador caindo de 8 para 7, que nenhuma tela mostra.
     */
    const ligado = await ligar();
    const primeiro = ligado.codigosDeRecuperacao[0];
    if (!primeiro) throw new Error('nenhum código de recuperação foi gerado');

    await verificarSegundoFator({
      tenantId: sessao.tenantId,
      staffUserId: sessao.staffUserId,
      staffName: CONTA.name,
      sessionId: await sessionId(),
      codigo: primeiro,
      now: new Date(),
    });

    const linhas = await admin.$queryRawUnsafe<{ action: string; after: unknown }[]>(
      `SELECT action, after FROM audit_log WHERE tenant_id = '${sessao.tenantId}'`,
    );
    const uso = linhas.find((l) => l.action === 'mfa.recovery_used');
    expect(uso?.after).toMatchObject({ restantes: 7 });
  });

  it('o código do aplicativo não vira evento de recuperação', async () => {
    // Se os dois caminhos gravassem a mesma coisa, a trilha deixaria de
    // responder a pergunta que ela existe para responder.
    const agora = new Date();
    const ligado = await ligar(agora);
    const depois = new Date(agora.getTime() + 60_000);

    await verificarSegundoFator({
      tenantId: sessao.tenantId,
      staffUserId: sessao.staffUserId,
      staffName: CONTA.name,
      sessionId: await sessionId(),
      codigo: codigoDoPasso(ligado.segredoBase32, passoAgora(depois)),
      now: depois,
    });

    expect(await trilha()).not.toContain('mfa.recovery_used');
  });

  it('desligar fica na trilha e derruba a prova de todas as sessões', async () => {
    const agora = new Date();
    const ligado = await ligar(agora);
    const depois = new Date(agora.getTime() + 60_000);

    const outra = await staffLogin({ email: CONTA.email, password: CONTA.password });
    const idDaOutra = (await resolveStaffSession(outra.token)).sessionId;

    // As duas sessões provam o segundo fator.
    await verificarSegundoFator({
      tenantId: sessao.tenantId, staffUserId: sessao.staffUserId, staffName: CONTA.name,
      sessionId: idDaOutra, codigo: codigoDoPasso(ligado.segredoBase32, passoAgora(depois)),
      now: depois,
    });

    const maisTarde = new Date(agora.getTime() + 120_000);
    await desligarMfa({
      tenantId: sessao.tenantId,
      staffUserId: sessao.staffUserId,
      staffName: CONTA.name,
      sessionId: await sessionId(),
      permissoes: ['appointments.create'],
      exigidoNaBarbearia: true,
      codigo: codigoDoPasso(ligado.segredoBase32, passoAgora(maisTarde)),
      now: maisTarde,
    });

    expect(await trilha()).toContain('mfa.disabled');
    // A prova da outra sessão também cai: senão, um cadastro novo a faria
    // valer de novo carregando prova feita contra o fator antigo.
    expect((await resolveStaffSession(outra.token)).mfaVerifiedAt).toBeNull();
  });

  // -- a janela ---------------------------------------------------------------

  it('a prova vence, e a tela e a guarda usam a mesma conta', async () => {
    /**
     * A `/security-review` achou o laço: a tela perguntava só se o campo era
     * nulo, e a guarda aplicava a janela. Passados trinta minutos, a tela dizia
     * "confirmado" e escondia o campo do código enquanto o caixa recusava e
     * mandava de volta para ela — sem saída a não ser deslogar.
     */
    const agora = new Date();
    expect(segundoFatorValido(agora, agora)).toBe(true);

    const noLimite = new Date(agora.getTime() + VALIDADE_DO_SEGUNDO_FATOR_MINUTOS * 60_000);
    expect(segundoFatorValido(agora, noLimite)).toBe(true);

    const passou = new Date(noLimite.getTime() + 1000);
    expect(segundoFatorValido(agora, passou)).toBe(false);

    // Nunca provado é sempre inválido — falha fechada.
    expect(segundoFatorValido(null, agora)).toBe(false);
  });

  describe('a exigência é decisão da barbearia (bloco 37)', () => {
    const exigirNaCasa = (exigir: boolean) =>
      definirExigenciaDeSegundoFator({
        tenantId: sessao.tenantId,
        staffUserId: sessao.staffUserId,
        staffName: CONTA.name,
        exigir,
      });

    it('nasce desligada', async () => {
      /**
       * O padrão é o inverso do que o produto fazia, e é escolha.
       *
       * Imposto, o segundo fator produzia o oposto do que queria: a barbearia
       * que instalava na terça e tentava abrir o caixa na quarta encontrava
       * "ative o segundo fator" sobre uma conta recém-criada, sem aplicativo
       * autenticador e com o cliente na cadeira — e passava a operar o balcão
       * na conta do dono, que é o que a regra existia para impedir.
       */
      expect((await resolveStaffSession(sessao.token)).exigeSegundoFatorNoDinheiro).toBe(false);
    });

    it('ligar vale para a sessão que já estava aberta', async () => {
      // O balcão fica logado o dia inteiro. Esperar o token vencer deixaria a
      // proteção sem efeito justamente no turno em que ela foi ligada.
      await exigirNaCasa(true);
      expect((await resolveStaffSession(sessao.token)).exigeSegundoFatorNoDinheiro).toBe(true);
    });

    it('a decisão é auditada nos dois sentidos, com quem decidiu', async () => {
      // "Quem tirou o segundo fator do financeiro?" é a pergunta que mais
      // importa das duas, e por isso as duas são registradas.
      await exigirNaCasa(true);
      await exigirNaCasa(false);

      const trilha = await admin.$queryRawUnsafe<
        { action: string; actor_name: string; before: unknown; after: unknown }[]
      >(
        `SELECT action::text AS action, actor_name, before, after FROM audit_log
          WHERE action::text LIKE 'mfa.policy%' ORDER BY created_at`,
      );
      expect(trilha.map((l) => l.action)).toEqual(['mfa.policy_enabled', 'mfa.policy_disabled']);
      expect(trilha[0]?.actor_name).toBe(CONTA.name);
      expect(trilha[1]?.before).toEqual({ exigir: true });
      expect(trilha[1]?.after).toEqual({ exigir: false });
    });

    it('a barbearia vizinha não muda a exigência desta', async () => {
      // A RLS separa barbearias, e o id do tenant não é segredo — ele viaja no
      // prefixo de todo token de gestor.
      const outra = await signUpOwner({
        ...CONTA,
        email: 'vizinha@outra.com.br',
        businessName: 'Barbearia Vizinha',
      });
      if (!outra.created) throw new Error('a conta da vizinha não foi criada');

      await definirExigenciaDeSegundoFator({
        tenantId: outra.session.tenantId,
        staffUserId: outra.session.staffUserId,
        staffName: 'Dona Vizinha',
        exigir: true,
      });

      expect((await resolveStaffSession(sessao.token)).exigeSegundoFatorNoDinheiro).toBe(false);
    });

    it('desligada, quem mexe em dinheiro deixa de ser obrigado', async () => {
      // A função que a guarda e a tela usam, nas duas direções. Uma tela que
      // dissesse "obrigatório" com a exigência desligada mandaria a pessoa
      // cadastrar TOTP para nada.
      expect(exigeSegundoFator(['finance.view'], false)).toBe(false);
      expect(exigeSegundoFator(['finance.view'], true)).toBe(true);
      expect(exigeSegundoFator(['appointments.create'], true)).toBe(false);
    });

    it('com a exigência desligada, quem mexe em dinheiro pode desligar o próprio', async () => {
      /**
       * Com a exigência ligada a recusa continua: quem tem acesso ao financeiro
       * não sai do segundo fator. Desligada, o TOTP é escolha da pessoa, e
       * trancá-la nele transformaria uma proteção adotada por conta própria em
       * armadilha.
       */
      const agora = new Date();
      const ligado = await ligar(agora);
      const depois = new Date(agora.getTime() + 60_000);

      await desligarMfa({
        tenantId: sessao.tenantId,
        staffUserId: sessao.staffUserId,
        staffName: CONTA.name,
        sessionId: await sessionId(),
        permissoes: ['finance.view'],
        exigidoNaBarbearia: false,
        codigo: codigoDoPasso(ligado.segredoBase32, passoAgora(depois)),
        now: depois,
      });

      expect((await estadoDoMfa(sessao.tenantId, sessao.staffUserId)).ativo).toBe(false);
    });
  });
});
