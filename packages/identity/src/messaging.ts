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

export interface StaffPasswordMessage {
  readonly phoneE164: string;
  readonly name: string;
  readonly establishmentName: string;
  readonly password: string;
}

export interface MessagingProvider {
  sendOtp(message: OtpMessage): Promise<void>;
  /**
   * A senha de primeiro acesso.
   *
   * **Não passa pela fila de trabalho**, ao contrário de todo o resto do bloco
   * 20. A fila é durável e o `payload` fica gravado até a limpeza: enfileirar a
   * senha em claro a transformaria num segredo em repouso, legível por qualquer
   * consulta à tabela `jobs` — que nem RLS tem, de propósito.
   *
   * Sai inline depois do commit, como o OTP, e pelo mesmo motivo: credencial
   * viva não se guarda para mandar depois.
   */
  sendStaffPassword(message: StaffPasswordMessage): Promise<void>;
}

/** Registra o que enviaria. Único provedor usado em teste e desenvolvimento. */
export class FakeMessagingProvider implements MessagingProvider {
  readonly sent: OtpMessage[] = [];
  readonly senhas: StaffPasswordMessage[] = [];
  /** Para provar que a conta sobrevive ao provedor fora do ar. */
  falharProxima = false;

  async sendOtp(message: OtpMessage): Promise<void> {
    this.derrubarSePedido();
    this.sent.push(message);
  }

  async sendStaffPassword(message: StaffPasswordMessage): Promise<void> {
    this.derrubarSePedido();
    this.senhas.push(message);
  }

  private derrubarSePedido(): void {
    if (this.falharProxima) {
      this.falharProxima = false;
      throw new Error('provedor indisponível');
    }
  }

  lastFor(phoneE164: string): OtpMessage | undefined {
    return [...this.sent].reverse().find((item) => item.phoneE164 === phoneE164);
  }

  clear(): void {
    this.sent.length = 0;
    this.senhas.length = 0;
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

  /** A senha também não aparece: log com credencial viva é credencial vazada. */
  async sendStaffPassword(message: StaffPasswordMessage): Promise<void> {
    this.log(
      `[senha] primeiro acesso enviado para ${maskPhone(message.phoneE164)} ` +
        `(${message.establishmentName})`,
    );
  }
}
