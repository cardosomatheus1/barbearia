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

/** A Meta pode ter aceitado a mensagem mesmo quando a conexão cai antes do wamid. */
export class MessagingDeliveryUnknownError extends Error {
  constructor(mensagem = 'não foi possível confirmar a entrega da mensagem de identidade') {
    super(mensagem);
    this.name = 'MessagingDeliveryUnknownError';
  }
}

export interface MetaIdentityMessagingConfig {
  readonly phoneNumberId: string;
  readonly accessToken: string;
  readonly otpTemplate: string;
  readonly staffTemplate: string;
  readonly language?: string;
  readonly timeoutMs?: number;
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

  private recusarProducao(): void {
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error(
        'identity_messaging_not_configured: ConsoleMessagingProvider é proibido em produção',
      );
    }
  }

  async sendOtp(message: OtpMessage): Promise<void> {
    this.recusarProducao();
    this.log(
      `[otp] código enviado para ${maskPhone(message.phoneE164)} ` +
        `(${message.establishmentName}, expira em ${message.ttlMinutes} min)`,
    );
  }

  /** A senha também não aparece: log com credencial viva é credencial vazada. */
  async sendStaffPassword(message: StaffPasswordMessage): Promise<void> {
    this.recusarProducao();
    this.log(
      `[senha] primeiro acesso enviado para ${maskPhone(message.phoneE164)} ` +
        `(${message.establishmentName})`,
    );
  }
}

/**
 * Canal de identidade da própria plataforma via WhatsApp Cloud API.
 *
 * É separado do WhatsApp de CRM de cada barbearia: login não pode depender de
 * o estabelecimento ter conectado a própria WABA. Os dois templates são do
 * tipo AUTHENTICATION com botão OTP/copy-code e ficam aprovados na WABA da
 * plataforma Barberdock.
 */
export class MetaIdentityMessagingProvider implements MessagingProvider {
  private readonly language: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: MetaIdentityMessagingConfig,
    private readonly buscar: typeof fetch = fetch,
  ) {
    this.language = config.language?.trim() || 'pt_BR';
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async sendOtp(message: OtpMessage): Promise<void> {
    await this.enviarCodigo(message.phoneE164, this.config.otpTemplate, message.code);
  }

  async sendStaffPassword(message: StaffPasswordMessage): Promise<void> {
    await this.enviarCodigo(message.phoneE164, this.config.staffTemplate, message.password);
  }

  private async enviarCodigo(para: string, template: string, codigo: string): Promise<void> {
    const controlador = new AbortController();
    const timer = setTimeout(() => controlador.abort(), this.timeoutMs);
    let resposta: Response;
    try {
      resposta = await this.buscar(
        `https://graph.facebook.com/v21.0/${this.config.phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.config.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: para,
            type: 'template',
            template: {
              name: template,
              language: { code: this.language },
              components: [
                {
                  type: 'body',
                  parameters: [{ type: 'text', text: codigo }],
                },
                {
                  type: 'button',
                  sub_type: 'url',
                  index: '0',
                  parameters: [{ type: 'text', text: codigo }],
                },
              ],
            },
          }),
          signal: controlador.signal,
        },
      );
    } catch (erro) {
      throw new MessagingDeliveryUnknownError(
        erro instanceof Error && erro.name === 'AbortError'
          ? 'timeout ao enviar mensagem de identidade para a Meta'
          : 'a conexão com a Meta terminou antes de confirmar a mensagem de identidade',
      );
    } finally {
      clearTimeout(timer);
    }

    let corpo: unknown = null;
    try {
      corpo = await resposta.json();
    } catch {
      // O status HTTP ainda distingue recusa definitiva de um 2xx ambíguo.
    }

    if (!resposta.ok) {
      const meta = corpo as { error?: { code?: number; message?: string } } | null;
      const codigoMeta = meta?.error?.code;
      const detalhe = meta?.error?.message?.slice(0, 240);
      throw new Error(
        `Meta recusou mensagem de identidade (HTTP ${resposta.status}` +
          `${codigoMeta === undefined ? '' : `, code ${codigoMeta}`})` +
          `${detalhe ? `: ${detalhe}` : ''}`,
      );
    }

    const wamid = (corpo as { messages?: { id?: string }[] } | null)?.messages?.[0]?.id;
    if (!wamid) {
      throw new MessagingDeliveryUnknownError(
        'a Meta respondeu sucesso sem wamid para a mensagem de identidade',
      );
    }
  }
}

export type IdentityMessagingMode = 'console' | 'meta';

/**
 * Em produção sem provedor: falha **no uso**, nunca no boot.
 *
 * A fábrica lançava quando o modo era `console` em produção, e o `useFactory`
 * do `app.module` a chama na subida — então a API não subia. Isso era coerente
 * enquanto o preflight recusava `console` antes de chegar aqui; deixou de ser
 * quando a recusa passou a ser derivada do banco, e o resultado foi um deploy
 * que passou no portão e derrubou a API. É a mesma lição do Turnstile, na outra
 * ponta: guarda que empurra a quebra para a frente quebra na frente do cliente.
 *
 * Console em produção **não** é o caminho, e por isso este provider não escreve
 * no log e segue: ele recusa, alto, com a frase que diz o que configurar.
 *
 * - **Senha de primeiro acesso:** `entregarSenha` já trata falha do provedor —
 *   grava `falhou` e devolve o estado para a tela, que mostra a senha. A conta é
 *   criada do mesmo jeito.
 * - **OTP:** falha visível para quem pediu, e nos logs. É pior que entregar, e
 *   muito melhor que o `ConsoleMessagingProvider` fingindo sucesso enquanto o
 *   cliente espera um código que está no log do contêiner.
 */
export class MensageriaPendenteProvider implements MessagingProvider {
  private recusar(): never {
    throw new Error(
      'IDENTITY_MESSAGING_MODO=console em produção: a mensagem não foi enviada. ' +
        'Configure IDENTITY_MESSAGING_MODO=meta com a WABA central para entregar ' +
        'OTP e senha de primeiro acesso.',
    );
  }

  // Os parâmetros entram nomeados com `_` para casar com a interface: sem eles
  // o tipo da classe declara zero argumentos, e o compilador recusa qualquer
  // chamador — inclusive o teste. O `vitest` não veria, porque roda por esbuild.
  async sendOtp(_message: OtpMessage): Promise<void> {
    this.recusar();
  }

  async sendStaffPassword(_message: StaffPasswordMessage): Promise<void> {
    this.recusar();
  }
}

/** Seleciona o provider sem permitir que produção caia silenciosamente no console. */
export function identityMessagingProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  buscar: typeof fetch = fetch,
): MessagingProvider {
  const mode = (env['IDENTITY_MESSAGING_MODO'] ?? 'console').trim();
  if (mode === 'console') {
    // Produção não ganha o provider de console: ele imprime e devolve sucesso,
    // e sucesso falso é o desfecho que não se pode ter numa porta de entrada.
    if (env['NODE_ENV'] === 'production') return new MensageriaPendenteProvider();
    return new ConsoleMessagingProvider();
  }
  if (mode !== 'meta') {
    throw new Error(`IDENTITY_MESSAGING_MODO inválido: ${mode}. Use console ou meta.`);
  }

  const phoneNumberId = (env['IDENTITY_WHATSAPP_PHONE_NUMBER_ID'] ?? '').trim();
  const accessToken = (env['IDENTITY_WHATSAPP_ACCESS_TOKEN'] ?? '').trim();
  const otpTemplate = (env['IDENTITY_WHATSAPP_OTP_TEMPLATE'] ?? '').trim();
  const staffTemplate = (env['IDENTITY_WHATSAPP_STAFF_TEMPLATE'] ?? '').trim();
  const faltantes = [
    ['IDENTITY_WHATSAPP_PHONE_NUMBER_ID', phoneNumberId],
    ['IDENTITY_WHATSAPP_ACCESS_TOKEN', accessToken],
    ['IDENTITY_WHATSAPP_OTP_TEMPLATE', otpTemplate],
    ['IDENTITY_WHATSAPP_STAFF_TEMPLATE', staffTemplate],
  ].filter(([, valor]) => !valor).map(([nome]) => nome);
  if (faltantes.length > 0) {
    throw new Error(`mensageria de identidade Meta incompleta: ${faltantes.join(', ')}`);
  }
  if (!/^[0-9]+$/.test(phoneNumberId)) {
    throw new Error('IDENTITY_WHATSAPP_PHONE_NUMBER_ID deve ser numérico');
  }
  for (const [nome, template] of [
    ['IDENTITY_WHATSAPP_OTP_TEMPLATE', otpTemplate],
    ['IDENTITY_WHATSAPP_STAFF_TEMPLATE', staffTemplate],
  ] as const) {
    if (!/^[a-z0-9_]+$/.test(template)) throw new Error(`${nome} tem nome de template inválido`);
  }

  return new MetaIdentityMessagingProvider(
    {
      phoneNumberId,
      accessToken,
      otpTemplate,
      staffTemplate,
      language: (env['IDENTITY_WHATSAPP_LANGUAGE'] ?? '').trim() || 'pt_BR',
    },
    buscar,
  );
}
