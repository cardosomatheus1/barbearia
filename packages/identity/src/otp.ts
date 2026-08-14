import { createHash, randomInt, randomBytes, timingSafeEqual } from 'node:crypto';
import { withTenant, type TransactionClient } from '@barbearia/db';
import { normalizePhone, InvalidPhoneError } from '@barbearia/core';
import type { MessagingProvider } from './messaging.js';

/**
 * Autenticação do cliente por código de uso único.
 *
 * Regras vindas do CLAUDE.md §2, todas com teste:
 *   6 dígitos · TTL de 5 min · no máximo 5 tentativas · invalidação no acerto
 *   cooldown progressivo no reenvio · resposta idêntica para telefone
 *   existente e inexistente.
 */

/**
 * Quanto tempo o desafio vencido ainda fica.
 *
 * Folga sobre a janela de cinco minutos — o cooldown do reenvio e a contagem de
 * tentativas leem a linha depois de ela expirar —, e curto o bastante para o
 * telefone em claro não virar base.
 */
const RETENCAO_DO_DESAFIO_DIAS = 7;

export const OTP_LENGTH = 6;
export const OTP_TTL_MINUTES = 5;
export const OTP_MAX_ATTEMPTS = 5;
export const SESSION_TTL_DAYS = 90;

/** Cooldown por número de envios seguidos, em segundos. */
const RESEND_COOLDOWN_SECONDS = [30, 60, 120, 300];
/** Teto de envios antes de exigir espera longa. */
const MAX_SENDS_PER_WINDOW = 6;
/**
 * Janela do contador de envios, em minutos.
 *
 * Separada do TTL do código de propósito: zerar a contagem quando o código
 * expira deixaria o teto trivial de burlar — bastaria esperar cinco minutos
 * entre cada pedido para gerar códigos indefinidamente.
 */
const SEND_WINDOW_MINUTES = 60;

export type OtpFailure =
  | 'invalid_phone'
  | 'resend_too_soon'
  | 'too_many_sends'
  | 'no_challenge'
  | 'code_expired'
  | 'too_many_attempts'
  | 'code_mismatch'
  | 'invalid_session';

export class OtpError extends Error {
  constructor(
    readonly code: OtpFailure,
    message: string,
    /** Segundos até poder tentar de novo, quando aplicável. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'OtpError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Código numérico com entropia criptográfica — `Math.random` não serve aqui. */
function generateCode(): string {
  const max = 10 ** OTP_LENGTH;
  return String(randomInt(0, max)).padStart(OTP_LENGTH, '0');
}

function cooldownFor(sendCount: number): number {
  const index = Math.min(sendCount, RESEND_COOLDOWN_SECONDS.length) - 1;
  return RESEND_COOLDOWN_SECONDS[Math.max(index, 0)] ?? 30;
}

/** Comparação em tempo constante: `===` vaza o prefixo correto pelo tempo. */
function codeMatches(candidate: string, storedHash: string): boolean {
  const a = Buffer.from(sha256(candidate), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface RequestOtpInput {
  readonly tenantId: string;
  readonly establishmentName: string;
  readonly phone: string;
  readonly name?: string;
  readonly now?: Date;
}

export interface RequestOtpResult {
  /** Sempre igual, exista ou não cadastro para o telefone. */
  readonly expiresInSeconds: number;
  readonly resendAfterSeconds: number;
}

/**
 * Envia (ou reenvia) o código.
 *
 * A resposta é idêntica para telefone conhecido e desconhecido: revelar a
 * diferença transformaria o endpoint em oráculo de existência de cadastro
 * (CLAUDE.md §2).
 */
export async function requestOtp(
  input: RequestOtpInput,
  messaging: MessagingProvider,
): Promise<RequestOtpResult> {
  let phone: string;
  try {
    phone = normalizePhone(input.phone);
  } catch (error) {
    if (error instanceof InvalidPhoneError) {
      throw new OtpError('invalid_phone', 'Por favor, digite o ddd e telefone');
    }
    throw error;
  }

  const now = input.now ?? new Date();

  const code = await withTenant(input.tenantId, async (tx) => {
    const existing = await tx.$queryRaw<
      { send_count: number; last_sent_at: Date; expires_at: Date }[]
    >`
      SELECT send_count, last_sent_at, expires_at
      FROM otp_challenges
      WHERE phone_e164 = ${phone}
      FOR UPDATE
    `;

    const current = existing[0];
    let sendCount = 1;

    if (current) {
      const elapsed = (now.getTime() - current.last_sent_at.getTime()) / 1000;
      const withinWindow = elapsed < SEND_WINDOW_MINUTES * 60;

      if (withinWindow) {
        const wait = cooldownFor(current.send_count);
        if (elapsed < wait) {
          throw new OtpError(
            'resend_too_soon',
            'Aguarde antes de pedir um novo código',
            Math.ceil(wait - elapsed),
          );
        }
        if (current.send_count >= MAX_SENDS_PER_WINDOW) {
          throw new OtpError(
            'too_many_sends',
            'Muitas tentativas. Tente novamente mais tarde.',
            Math.ceil(SEND_WINDOW_MINUTES * 60 - elapsed),
          );
        }
        sendCount = current.send_count + 1;
      }
    }

    const generated = generateCode();

    // Reenviar substitui o código anterior: acumular códigos válidos
    // multiplicaria as chances de acerto por força bruta.
    await tx.$executeRaw`
      INSERT INTO otp_challenges
        (tenant_id, phone_e164, code_hash, pending_name, expires_at, send_count,
         last_sent_at, attempts, consumed_at)
      VALUES (
        ${input.tenantId}::uuid, ${phone}, ${sha256(generated)},
        ${input.name ?? null},
        ${new Date(now.getTime() + OTP_TTL_MINUTES * 60_000)},
        ${sendCount}, ${now}, 0, NULL
      )
      ON CONFLICT (tenant_id, phone_e164) DO UPDATE SET
        code_hash = EXCLUDED.code_hash,
        pending_name = COALESCE(EXCLUDED.pending_name, otp_challenges.pending_name),
        expires_at = EXCLUDED.expires_at,
        send_count = EXCLUDED.send_count,
        last_sent_at = EXCLUDED.last_sent_at,
        attempts = 0,
        consumed_at = NULL
    `;

    return { generated, sendCount };
  });

  await messaging.sendOtp({
    phoneE164: phone,
    code: code.generated,
    establishmentName: input.establishmentName,
    ttlMinutes: OTP_TTL_MINUTES,
  });

  return {
    expiresInSeconds: OTP_TTL_MINUTES * 60,
    resendAfterSeconds: cooldownFor(code.sendCount),
  };
}

export interface VerifyOtpInput {
  readonly tenantId: string;
  readonly phone: string;
  readonly code: string;
  readonly userAgent?: string;
  readonly ip?: string;
  readonly now?: Date;
}

export interface Session {
  /** Token opaco. Só existe aqui e no cliente — o banco guarda o hash. */
  readonly token: string;
  readonly expiresAt: string;
  readonly customerId: string;
  readonly customerName: string;
}

/**
 * Confere o código e emite a sessão.
 *
 * No acerto: o desafio é consumido, o cliente é criado se não existir e a
 * sessão nasce. No erro: a tentativa é contada, e esgotar as tentativas invalida
 * o desafio inteiro.
 */
export async function verifyOtp(input: VerifyOtpInput): Promise<Session> {
  let phone: string;
  try {
    phone = normalizePhone(input.phone);
  } catch (error) {
    if (error instanceof InvalidPhoneError) {
      throw new OtpError('invalid_phone', 'Número inválido');
    }
    throw error;
  }

  const now = input.now ?? new Date();

  // Fase 1, em transação própria: incrementa a tentativa e devolve o desafio.
  //
  // O incremento **precisa** estar numa transação que confirma. Fazê-lo na
  // mesma transação que lança em caso de erro desfaz o contador junto com o
  // rollback — e o limite de tentativas deixa de existir, silenciosamente.
  const attempt = await withTenant(input.tenantId, async (tx) => {
    const rows = await tx.$queryRaw<
      { code_hash: string; pending_name: string | null; attempts: number; max_attempts: number }[]
    >`
      UPDATE otp_challenges
      SET attempts = attempts + 1
      WHERE phone_e164 = ${phone}
        AND consumed_at IS NULL
        AND expires_at > ${now}
        AND attempts < max_attempts
      RETURNING code_hash, pending_name, attempts, max_attempts
    `;
    return rows[0] ?? null;
  });

  if (!attempt) {
    // Inexistente, expirado, já usado ou com tentativas esgotadas — a resposta
    // é a mesma para os quatro casos.
    throw new OtpError('no_challenge', 'Código inválido ou expirado');
  }

  if (!codeMatches(input.code, attempt.code_hash)) {
    if (attempt.attempts >= attempt.max_attempts) {
      // Esgotou: invalida o desafio. Sem isso, pedir um código novo devolveria
      // mais cinco chances sobre o mesmo alvo.
      await withTenant(input.tenantId, async (tx) => {
        await tx.$executeRaw`
          UPDATE otp_challenges SET consumed_at = ${now} WHERE phone_e164 = ${phone}
        `;
      });
    }
    throw new OtpError('code_mismatch', 'Código inválido ou expirado');
  }

  // Fase 2: consome o desafio e emite a sessão.
  return withTenant(input.tenantId, async (tx) => {
    const consumed = await tx.$executeRaw`
      UPDATE otp_challenges SET consumed_at = ${now}
      WHERE phone_e164 = ${phone} AND consumed_at IS NULL
    `;
    // Outra requisição consumiu o mesmo código entre as duas fases.
    if (consumed === 0) throw new OtpError('no_challenge', 'Código inválido ou expirado');

    const name = attempt.pending_name ?? 'Cliente';
    // O nome vem de quem **pediu** o código, e pedir código não exige prova de
    // posse do número. Aplicá-lo a um cliente já existente deixaria um terceiro
    // renomear a vítima: bastaria pedir um código para o telefone dela com o
    // nome desejado e esperar o próximo login legítimo. Só vale na criação;
    // renomear exige rota autenticada.
    const customers = await tx.$queryRaw<{ id: string; name: string }[]>`
      INSERT INTO customers (tenant_id, name, phone_e164)
      VALUES (${input.tenantId}::uuid, ${name}, ${phone})
      ON CONFLICT (tenant_id, phone_e164) DO UPDATE
        SET updated_at = now()
      RETURNING id, name
    `;

    const customer = customers[0];
    if (!customer) throw new OtpError('no_challenge', 'Não foi possível concluir a validação');

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 86_400_000);

    await tx.$executeRaw`
      INSERT INTO customer_sessions
        (tenant_id, customer_id, token_hash, expires_at, user_agent, ip)
      VALUES (
        ${input.tenantId}::uuid, ${customer.id}::uuid, ${sha256(token)}, ${expiresAt},
        ${input.userAgent ?? null}, ${input.ip ?? null}::inet
      )
    `;

    return {
      token,
      expiresAt: expiresAt.toISOString(),
      customerId: customer.id,
      customerName: customer.name,
    };
  });
}

export interface AuthenticatedCustomer {
  readonly customerId: string;
  readonly customerName: string;
  readonly sessionId: string;
}

/**
 * Resolve o token de sessão.
 *
 * A busca é pelo hash, e o `tenant_id` da sessão precisa bater com o da
 * barbearia acessada: um token emitido por uma barbearia não pode valer em
 * outra, mesmo sendo do mesmo telefone.
 */
export async function resolveSession(
  tenantId: string,
  token: string,
  now: Date = new Date(),
): Promise<AuthenticatedCustomer> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.$queryRaw<
      { id: string; customer_id: string; name: string }[]
    >`
      SELECT s.id, s.customer_id, c.name
      FROM customer_sessions s
      JOIN customers c ON c.id = s.customer_id
      WHERE s.token_hash = ${sha256(token)}
        AND s.revoked_at IS NULL
        AND s.expires_at > ${now}
    `;

    const session = rows[0];
    if (!session) throw new OtpError('invalid_session', 'Sessão inválida ou expirada');

    // Gravação amortizada: atualizar a cada requisição colocaria uma escrita no
    // caminho quente e travaria a mesma linha em requisições concorrentes do
    // mesmo cliente. Granularidade de 5 minutos basta para o uso que o campo tem
    // — saber se a sessão está viva.
    await tx.$executeRaw`
      UPDATE customer_sessions SET last_used_at = ${now}
      WHERE id = ${session.id}::uuid
        AND (last_used_at IS NULL OR last_used_at < ${new Date(now.getTime() - 5 * 60_000)})
    `;

    return {
      customerId: session.customer_id,
      customerName: session.name,
      sessionId: session.id,
    };
  });
}

export async function revokeSession(tenantId: string, sessionId: string): Promise<void> {
  await withTenant(tenantId, async (tx: TransactionClient) => {
    await tx.$executeRaw`
      UPDATE customer_sessions SET revoked_at = now()
      WHERE id = ${sessionId}::uuid AND revoked_at IS NULL
    `;
  });
}

export interface GuestIdentity {
  readonly tenantId: string;
  readonly name: string;
  readonly phone: string;
}

/**
 * Resolve o cliente a partir de nome e celular, sem código.
 *
 * É o fluxo que o mercado pratica: escolher, informar nome e telefone,
 * confirmar. O sistema analisado agenda exatamente assim — o payload dele leva
 * o campo de código vazio.
 *
 * O que **não** acontece aqui: nenhuma sessão é emitida. Informar o telefone de
 * outra pessoa cria um agendamento em nome dela, mas não dá acesso ao histórico
 * dela nem permite cancelar o que já existe — isso continua exigindo o código.
 * É a mesma fronteira que o concorrente traça.
 */
export async function resolveGuestCustomer(input: GuestIdentity): Promise<{
  readonly customerId: string;
  readonly phoneE164: string;
}> {
  let phone: string;
  try {
    phone = normalizePhone(input.phone);
  } catch (error) {
    if (error instanceof InvalidPhoneError) {
      throw new OtpError('invalid_phone', 'Por favor, digite o ddd e telefone');
    }
    throw error;
  }

  const name = input.name.trim().replace(/ {2,}/g, ' ');

  return withTenant(input.tenantId, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO customers (tenant_id, name, phone_e164)
      VALUES (${input.tenantId}::uuid, ${name}, ${phone})
      ON CONFLICT (tenant_id, phone_e164) DO UPDATE SET updated_at = now()
      RETURNING id
    `;
    const customer = rows[0];
    if (!customer) throw new OtpError('no_challenge', 'Não foi possível identificar o cliente');
    return { customerId: customer.id, phoneE164: phone };
  });
}

/**
 * Apaga os desafios de OTP vencidos.
 *
 * ## O que ele guarda, e por que isso precisa de prazo
 *
 * `otp_challenges` tem `phone_e164` **em claro** e `pending_name` — o nome que a
 * pessoa digitou antes de confirmar. Cópia de dado pessoal **fora de
 * `customers`** vive com prazo escrito, como `imports.payload` e o texto anônimo
 * da recepção.
 *
 * A migração 0005 anunciou a faxina num comentário e ela nunca teve chamador. O
 * único apagamento morava dentro de `anonimizar_cliente`, condicionado ao
 * telefone do cadastro — logo, alcançava só quem **é** cliente com aquele número
 * naquele instante. Sobravam dois casos:
 *
 * - quem pediu o código, desistiu e nunca marcou nada. Não está em `customers`,
 *   então nenhum pedido de exclusão a alcança e a retenção de cinco anos não a
 *   enxerga;
 * - quem trocou de número: o desafio do número **antigo** ficava, com o nome
 *   verdadeiro. É o que o comentário da 0071 diz que não pode acontecer.
 *
 * Um dump da tabela é a lista de todo telefone que já tentou agendar em qualquer
 * barbearia da plataforma.
 *
 * ## Por que sete dias, e não zero
 *
 * O desafio vencido ainda serve por um instante: o cooldown progressivo do
 * reenvio e a contagem de tentativas leem a linha depois de ela expirar, e
 * apagar na hora daria reenvio livre a quem esgotou as cinco tentativas. Sete
 * dias é folga sobre a janela de cinco minutos, e curto o bastante para o dado
 * não virar base.
 *
 * Devolve quantas linhas saíram: varredura que não conta não prova que rodou.
 */
export async function expirarDesafiosDeOtp(entrada: {
  readonly tenantId: string;
  readonly agora?: Date;
}): Promise<number> {
  const agora = entrada.agora ?? new Date();
  const corte = new Date(agora.getTime() - RETENCAO_DO_DESAFIO_DIAS * 86_400_000);

  return withTenant(entrada.tenantId, async (tx) => {
    return tx.$executeRaw`
      DELETE FROM otp_challenges WHERE expires_at < ${corte}
    `;
  });
}
