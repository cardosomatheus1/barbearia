import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeMessagingProvider, ConsoleMessagingProvider } from './messaging.js';
import {
  OTP_MAX_ATTEMPTS,
  OtpError,
  requestOtp,
  resolveSession,
  revokeSession,
  verifyOtp,
} from './otp.js';

/**
 * Autenticação do cliente, contra Postgres real.
 *
 * Cada regra do CLAUDE.md §2 tem teste próprio aqui. Uma defesa sem teste é uma
 * defesa que ninguém percebe quando some.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];

const TENANT = '11111111-1111-1111-1111-111111111111';
const RIVAL = '22222222-2222-2222-2222-222222222222';
const PHONE = '(71) 98888-7777';
const PHONE_E164 = '+5571988887777';

const AGORA = new Date('2026-08-01T12:00:00Z');

let admin: PrismaClient;
let messaging: FakeMessagingProvider;

const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

describeIfDb('OTP', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await admin.$executeRawUnsafe(
      `INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Domari'), ('${RIVAL}', 'Rival')`,
    );
    messaging = new FakeMessagingProvider();
  });

  const send = (overrides: Record<string, unknown> = {}) =>
    requestOtp(
      {
        tenantId: TENANT,
        establishmentName: 'Domari',
        phone: PHONE,
        name: 'Carlos Souza',
        now: AGORA,
        ...overrides,
      },
      messaging,
    );

  const codeFor = (phone = PHONE_E164): string => {
    const message = messaging.lastFor(phone);
    if (!message) throw new Error('nenhum código enviado');
    return message.code;
  };

  // -- envio -----------------------------------------------------------------

  it('envia código de 6 dígitos e normaliza o telefone', async () => {
    const result = await send();

    expect(result.expiresInSeconds).toBe(300);
    expect(messaging.sent).toHaveLength(1);
    expect(messaging.sent[0]?.phoneE164).toBe(PHONE_E164);
    expect(messaging.sent[0]?.code).toMatch(/^\d{6}$/);
  });

  it('não guarda o código em claro', async () => {
    await send();
    const rows = await admin.$queryRawUnsafe<{ code_hash: string }[]>(
      `SELECT code_hash FROM otp_challenges`,
    );
    expect(rows[0]?.code_hash).not.toBe(codeFor());
    expect(rows[0]?.code_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('responde igual para telefone conhecido e desconhecido', async () => {
    const desconhecido = await send({ phone: '71911112222' });
    await verifyOtp({ tenantId: TENANT, phone: '71911112222', code: codeFor('+5571911112222'), now: AGORA });

    const conhecido = await send({ phone: '71911112222', now: new Date(AGORA.getTime() + 60_000) });
    expect(conhecido.expiresInSeconds).toBe(desconhecido.expiresInSeconds);
  });

  it('recusa telefone inválido', async () => {
    await expect(send({ phone: 'abc' })).rejects.toMatchObject({ code: 'invalid_phone' });
    await expect(send({ phone: '20988887777' })).rejects.toMatchObject({ code: 'invalid_phone' });
  });

  // -- cooldown --------------------------------------------------------------

  it('exige espera antes de reenviar', async () => {
    await send();
    await expect(send({ now: new Date(AGORA.getTime() + 5_000) })).rejects.toMatchObject({
      code: 'resend_too_soon',
    });
  });

  it('cooldown cresce a cada reenvio', async () => {
    let t = AGORA.getTime();
    const primeiro = await send({ now: new Date(t) });
    expect(primeiro.resendAfterSeconds).toBe(30);

    t += 31_000;
    const segundo = await send({ now: new Date(t) });
    expect(segundo.resendAfterSeconds).toBe(60);

    t += 61_000;
    const terceiro = await send({ now: new Date(t) });
    expect(terceiro.resendAfterSeconds).toBe(120);
  });

  it('informa quanto falta para reenviar', async () => {
    await send();
    try {
      await send({ now: new Date(AGORA.getTime() + 10_000) });
      throw new Error('deveria ter recusado');
    } catch (error) {
      expect((error as OtpError).retryAfterSeconds).toBe(20);
    }
  });

  it('reenviar substitui o código anterior', async () => {
    await send();
    const antigo = codeFor();

    await send({ now: new Date(AGORA.getTime() + 31_000) });
    const novo = codeFor();
    expect(novo).not.toBe(antigo);

    // O código antigo deixa de valer — acumular códigos válidos multiplicaria
    // as chances de acerto por força bruta.
    await expect(
      verifyOtp({ tenantId: TENANT, phone: PHONE, code: antigo, now: AGORA }),
    ).rejects.toMatchObject({ code: 'code_mismatch' });
  });

  it('trava depois de muitos envios na janela', async () => {
    let t = AGORA.getTime();
    for (let i = 0; i < 6; i++) {
      await send({ now: new Date(t) });
      t += 310_000; // acima do maior cooldown, abaixo da janela de contagem
    }
    await expect(send({ now: new Date(t) })).rejects.toMatchObject({ code: 'too_many_sends' });
  });

  it('esperar a janela inteira zera a contagem', async () => {
    let t = AGORA.getTime();
    for (let i = 0; i < 6; i++) {
      await send({ now: new Date(t) });
      t += 310_000;
    }
    await expect(send({ now: new Date(t) })).rejects.toMatchObject({ code: 'too_many_sends' });

    // Uma hora depois do último envio, a contagem recomeça.
    const depois = await send({ now: new Date(t + 61 * 60_000) });
    expect(depois.resendAfterSeconds).toBe(30);
  });

  it('esperar o código expirar não zera a contagem de envios', async () => {
    // O teto seria trivial de burlar se bastasse esperar o TTL de 5 minutos.
    let t = AGORA.getTime();
    for (let i = 0; i < 6; i++) {
      await send({ now: new Date(t) });
      t += 310_000;
    }
    await expect(send({ now: new Date(t) })).rejects.toMatchObject({ code: 'too_many_sends' });
  });

  // -- verificação -----------------------------------------------------------

  it('código correto emite sessão e cria o cliente', async () => {
    await send();
    const session = await verifyOtp({
      tenantId: TENANT, phone: PHONE, code: codeFor(), now: AGORA,
    });

    expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.customerName).toBe('Carlos Souza');

    const rows = await admin.$queryRawUnsafe<{ phone_e164: string }[]>(
      `SELECT phone_e164 FROM customers`,
    );
    expect(rows[0]?.phone_e164).toBe(PHONE_E164);
  });

  it('não guarda o token em claro', async () => {
    await send();
    const session = await verifyOtp({ tenantId: TENANT, phone: PHONE, code: codeFor(), now: AGORA });

    const rows = await admin.$queryRawUnsafe<{ token_hash: string }[]>(
      `SELECT token_hash FROM customer_sessions`,
    );
    expect(rows[0]?.token_hash).not.toBe(session.token);
    expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('código não pode ser reusado', async () => {
    await send();
    const code = codeFor();
    await verifyOtp({ tenantId: TENANT, phone: PHONE, code, now: AGORA });

    await expect(
      verifyOtp({ tenantId: TENANT, phone: PHONE, code, now: AGORA }),
    ).rejects.toMatchObject({ code: 'no_challenge' });
  });

  it('código expirado é recusado', async () => {
    await send();
    await expect(
      verifyOtp({
        tenantId: TENANT, phone: PHONE, code: codeFor(),
        now: new Date(AGORA.getTime() + 6 * 60_000),
      }),
    ).rejects.toMatchObject({ code: 'no_challenge' });
  });

  it('esgotar as tentativas invalida o desafio', async () => {
    await send();
    const correto = codeFor();

    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
      await expect(
        verifyOtp({ tenantId: TENANT, phone: PHONE, code: '000000', now: AGORA }),
      ).rejects.toBeInstanceOf(OtpError);
    }

    // O contador precisa ter sobrevivido: se o rollback o desfizesse, o limite
    // não existiria.
    const rows = await admin.$queryRawUnsafe<{ attempts: number; consumed_at: Date | null }[]>(
      `SELECT attempts, consumed_at FROM otp_challenges`,
    );
    expect(rows[0]?.attempts).toBe(OTP_MAX_ATTEMPTS);
    expect(rows[0]?.consumed_at).not.toBeNull();

    // Nem o código certo vale depois disso: sem essa trava, pedir código novo
    // devolveria mais cinco chances sobre o mesmo alvo.
    await expect(
      verifyOtp({ tenantId: TENANT, phone: PHONE, code: correto, now: AGORA }),
    ).rejects.toMatchObject({ code: 'no_challenge' });
  });

  it('a mensagem de erro não distingue os motivos de recusa', async () => {
    await send();
    const mensagens = new Set<string>();

    for (const caso of [
      { phone: PHONE, code: '000000', now: AGORA },
      { phone: '71911112222', code: '000000', now: AGORA },
      { phone: PHONE, code: '111111', now: new Date(AGORA.getTime() + 6 * 60_000) },
    ]) {
      try {
        await verifyOtp({ tenantId: TENANT, ...caso });
      } catch (error) {
        mensagens.add((error as OtpError).message);
      }
    }
    expect(mensagens).toEqual(new Set(['Código inválido ou expirado']));
  });

  // -- sessão ----------------------------------------------------------------

  it('token válido resolve o cliente', async () => {
    await send();
    const session = await verifyOtp({ tenantId: TENANT, phone: PHONE, code: codeFor(), now: AGORA });

    const resolved = await resolveSession(TENANT, session.token);
    expect(resolved.customerId).toBe(session.customerId);
  });

  it('token de uma barbearia não vale em outra', async () => {
    await send();
    const session = await verifyOtp({ tenantId: TENANT, phone: PHONE, code: codeFor(), now: AGORA });

    await expect(resolveSession(RIVAL, session.token)).rejects.toMatchObject({
      code: 'invalid_session',
    });
  });

  it('token inventado é recusado', async () => {
    await expect(resolveSession(TENANT, 'token-falso')).rejects.toMatchObject({
      code: 'invalid_session',
    });
  });

  it('token revogado deixa de valer', async () => {
    await send();
    const session = await verifyOtp({ tenantId: TENANT, phone: PHONE, code: codeFor(), now: AGORA });
    const resolved = await resolveSession(TENANT, session.token);

    await revokeSession(TENANT, resolved.sessionId);
    await expect(resolveSession(TENANT, session.token)).rejects.toMatchObject({
      code: 'invalid_session',
    });
  });

  it('token expirado deixa de valer', async () => {
    await send();
    const session = await verifyOtp({ tenantId: TENANT, phone: PHONE, code: codeFor(), now: AGORA });

    await admin.$executeRawUnsafe(
      `UPDATE customer_sessions SET expires_at = now() - interval '1 day'`,
    );
    await expect(resolveSession(TENANT, session.token)).rejects.toMatchObject({
      code: 'invalid_session',
    });
  });

  it('tokens são distintos entre sessões', async () => {
    const tokens = new Set<string>();
    let t = AGORA.getTime();
    for (let i = 0; i < 3; i++) {
      await send({ now: new Date(t) });
      const session = await verifyOtp({
        tenantId: TENANT, phone: PHONE, code: codeFor(), now: new Date(t),
      });
      tokens.add(session.token);
      t += 400_000;
    }
    expect(tokens.size).toBe(3);
  });
});

describe('ConsoleMessagingProvider', () => {
  it('nunca imprime o código', async () => {
    const linhas: string[] = [];
    const provider = new ConsoleMessagingProvider((line) => linhas.push(line));

    await provider.sendOtp({
      phoneE164: '+5571988887777',
      code: '123456',
      establishmentName: 'Domari',
      ttlMinutes: 5,
    });

    // Log com código de uso único transforma acesso ao log em acesso à conta.
    expect(linhas.join('\n')).not.toContain('123456');
    expect(linhas.join('\n')).not.toContain('988887777');
  });
});

describeIfDb('OTP — proteções de dados', () => {
  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await admin.$executeRawUnsafe(
      `INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Domari')`,
    );
    messaging = new FakeMessagingProvider();
  });

  it('terceiro não renomeia cliente existente pedindo código', async () => {
    // A vítima entra e fica cadastrada com o próprio nome.
    await requestOtp(
      { tenantId: TENANT, establishmentName: 'Domari', phone: PHONE, name: 'Carlos Souza', now: AGORA },
      messaging,
    );
    const code = messaging.lastFor(PHONE_E164)?.code ?? '';
    await verifyOtp({ tenantId: TENANT, phone: PHONE, code, now: AGORA });

    // O atacante pede um código para o telefone dela, escolhendo o nome.
    const depois = new Date(AGORA.getTime() + 61 * 60_000);
    await requestOtp(
      { tenantId: TENANT, establishmentName: 'Domari', phone: PHONE, name: 'NOME INJETADO', now: depois },
      messaging,
    );

    // A vítima faz login de novo, com o próprio código.
    const novoCode = messaging.lastFor(PHONE_E164)?.code ?? '';
    const session = await verifyOtp({ tenantId: TENANT, phone: PHONE, code: novoCode, now: depois });

    expect(session.customerName).toBe('Carlos Souza');
    const rows = await admin.$queryRawUnsafe<{ name: string }[]>(`SELECT name FROM customers`);
    expect(rows[0]?.name).toBe('Carlos Souza');
  });

  it('cliente novo recebe o nome informado', async () => {
    await requestOtp(
      { tenantId: TENANT, establishmentName: 'Domari', phone: PHONE, name: 'Carlos Souza', now: AGORA },
      messaging,
    );
    const code = messaging.lastFor(PHONE_E164)?.code ?? '';
    const session = await verifyOtp({ tenantId: TENANT, phone: PHONE, code, now: AGORA });
    expect(session.customerName).toBe('Carlos Souza');
  });
});
