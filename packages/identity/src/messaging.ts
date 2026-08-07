import { maskPhone } from '@barbearia/core';

/**
 * Envio de mensagem ao cliente.
 *
 * Abstração porque o provedor muda e porque teste não pode depender de rede
 * (CLAUDE.md §4). O WhatsApp oficial exige número verificado e aprovação de
 * template — bloqueio de fornecedor, não de código —, então o `fake` é o que
 * roda em desenvolvimento e em CI.
 */

export interface OtpMessage {
  readonly phoneE164: string;
  readonly code: string;
  readonly establishmentName: string;
  readonly ttlMinutes: number;
}

export interface MessagingProvider {
  sendOtp(message: OtpMessage): Promise<void>;
}

/** Registra o que enviaria. Único provedor usado em teste e desenvolvimento. */
export class FakeMessagingProvider implements MessagingProvider {
  readonly sent: OtpMessage[] = [];

  async sendOtp(message: OtpMessage): Promise<void> {
    this.sent.push(message);
  }

  lastFor(phoneE164: string): OtpMessage | undefined {
    return [...this.sent].reverse().find((item) => item.phoneE164 === phoneE164);
  }

  clear(): void {
    this.sent.length = 0;
  }
}

/**
 * Provedor de desenvolvimento que imprime no log.
 *
 * O código **não** aparece: log com código de uso único transforma acesso ao
 * log em acesso à conta. Quem precisa do código em desenvolvimento usa o
 * `FakeMessagingProvider`, que o mantém em memória.
 */
export class ConsoleMessagingProvider implements MessagingProvider {
  constructor(private readonly log: (message: string) => void = console.log) {}

  async sendOtp(message: OtpMessage): Promise<void> {
    this.log(
      `[otp] código enviado para ${maskPhone(message.phoneE164)} ` +
        `(${message.establishmentName}, expira em ${message.ttlMinutes} min)`,
    );
  }
}
