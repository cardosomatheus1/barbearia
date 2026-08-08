import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import { hashPassword, verifyPassword } from './password.js';

/**
 * Segundo fator para quem mexe em dinheiro.
 *
 * O `CLAUDE.md` exige MFA para papéis com permissão `finance.*` desde o bloco
 * 12, e havia um teste impedindo qualquer rota de exigir uma dessas antes de o
 * segundo fator existir. Este arquivo é o que destranca o bloco do caixa.
 *
 * **TOTP (RFC 6238) implementado aqui, sem dependência nova.** É a mesma
 * decisão da senha: `node:crypto` tem HMAC, e o algoritmo cabe em cinquenta
 * linhas. Uma biblioteca a mais para isso seria superfície de suprimento em
 * troca de conveniência — e o `CLAUDE.md` pede motivo declarado para cada
 * dependência.
 *
 * Três decisões que merecem explicação:
 *
 * 1. **O segredo é guardado cifrado**, com chave de ambiente que falha alto se
 *    faltar. Segredo TOTP em claro no banco significa que um vazamento de dump
 *    entrega o segundo fator junto com o primeiro — e aí ele não é um segundo
 *    fator, é enfeite.
 *
 * 2. **Código usado não vale de novo.** TOTP é válido por trinta segundos, e
 *    sem registrar o passo já consumido o mesmo código serve duas vezes na
 *    mesma janela. Quem olha por cima do ombro no balcão tem trinta segundos.
 *
 * 3. **Códigos de recuperação existem.** Sem eles, celular perdido tranca o
 *    dono para fora do próprio caixa, e o desfecho real é a barbearia desligar
 *    o MFA — ou pedir para alguém mexer no banco.
 */

const DIGITOS = 6;
const PASSO_SEGUNDOS = 30;
/** Uma janela para trás e uma para frente: relógio de celular derrapa. */
const TOLERANCIA_DE_PASSOS = 1;

const ALFABETO_BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export class MfaError extends Error {
  constructor(
    readonly code: 'mfa_key_missing' | 'invalid_code' | 'already_enabled' | 'not_enabled',
    message: string,
  ) {
    super(message);
    this.name = 'MfaError';
  }
}

/**
 * A chave que cifra os segredos. Sem padrão, de propósito.
 *
 * Um padrão fraco em silêncio seria pior que a ausência: o sistema subiria
 * funcionando e todo segredo estaria cifrado com uma chave pública no
 * repositório. Falhar alto é o comportamento correto (CLAUDE.md §2).
 */
function chaveDeCifra(): Buffer {
  const bruta = process.env['MFA_SECRET_KEY'];
  if (!bruta) {
    throw new MfaError(
      'mfa_key_missing',
      'MFA_SECRET_KEY não definida. Sem ela o segundo fator não pode ser guardado com segurança.',
    );
  }
  const chave = Buffer.from(bruta, 'base64');
  if (chave.length !== 32) {
    throw new MfaError(
      'mfa_key_missing',
      'MFA_SECRET_KEY precisa ter 32 bytes em base64 (openssl rand -base64 32).',
    );
  }
  return chave;
}

/** AES-256-GCM: cifra e autentica. O nonce vai junto, como manda o modo. */
export function cifrarSegredo(segredo: string): string {
  const chave = chaveDeCifra();
  const nonce = randomBytes(12);
  const cifra = createCipheriv('aes-256-gcm', chave, nonce);
  const dados = Buffer.concat([cifra.update(segredo, 'utf8'), cifra.final()]);
  return [nonce.toString('base64'), cifra.getAuthTag().toString('base64'), dados.toString('base64')]
    .join('.');
}

export function decifrarSegredo(guardado: string): string {
  const chave = chaveDeCifra();
  const [nonce, tag, dados] = guardado.split('.');
  if (!nonce || !tag || !dados) {
    throw new MfaError('not_enabled', 'Segredo de segundo fator corrompido.');
  }
  const decifra = createDecipheriv('aes-256-gcm', chave, Buffer.from(nonce, 'base64'));
  decifra.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([
    decifra.update(Buffer.from(dados, 'base64')),
    decifra.final(),
  ]).toString('utf8');
}

/** Base32 sem preenchimento, que é o que os aplicativos autenticadores leem. */
export function paraBase32(bytes: Buffer): string {
  let bits = 0;
  let valor = 0;
  let saida = '';

  for (const byte of bytes) {
    valor = (valor << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      saida += ALFABETO_BASE32[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) saida += ALFABETO_BASE32[(valor << (5 - bits)) & 31];
  return saida;
}

export function deBase32(texto: string): Buffer {
  let bits = 0;
  let valor = 0;
  const bytes: number[] = [];

  for (const caractere of texto.toUpperCase().replace(/=+$/, '')) {
    const indice = ALFABETO_BASE32.indexOf(caractere);
    if (indice === -1) continue;
    valor = (valor << 5) | indice;
    bits += 5;
    if (bits >= 8) {
      bytes.push((valor >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Segredo novo: 20 bytes, que é o tamanho que a RFC 4226 recomenda para SHA-1. */
export function novoSegredo(): string {
  return paraBase32(randomBytes(20));
}

/** O código de um passo específico. Puro: o relógio entra por parâmetro. */
export function codigoDoPasso(segredoBase32: string, passo: number): string {
  const contador = Buffer.alloc(8);
  contador.writeUInt32BE(Math.floor(passo / 2 ** 32), 0);
  contador.writeUInt32BE(passo >>> 0, 4);

  const digest = createHmac('sha1', deBase32(segredoBase32)).update(contador).digest();
  // Truncamento dinâmico da RFC 4226 §5.3.
  const deslocamento = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binario =
    (((digest[deslocamento] ?? 0) & 0x7f) << 24) |
    (((digest[deslocamento + 1] ?? 0) & 0xff) << 16) |
    (((digest[deslocamento + 2] ?? 0) & 0xff) << 8) |
    ((digest[deslocamento + 3] ?? 0) & 0xff);

  return String(binario % 10 ** DIGITOS).padStart(DIGITOS, '0');
}

export const passoAgora = (now: Date): number =>
  Math.floor(now.getTime() / 1000 / PASSO_SEGUNDOS);

/**
 * Confere o código e devolve o passo que ele consumiu.
 *
 * Devolver o passo é o que permite a quem chama gravar "este já foi usado" — sem
 * isso, o mesmo código vale as duas vezes que couberem na janela de trinta
 * segundos, e quem espiou o visor no balcão tem meio minuto para reusar.
 *
 * A comparação é `timingSafeEqual`: comparar código com `===` vaza, pelo tempo,
 * quantos dígitos iniciais estavam certos.
 */
export function conferirCodigo(params: {
  readonly segredoBase32: string;
  readonly codigo: string;
  readonly now: Date;
  /** Último passo já consumido por esta conta, se houver. */
  readonly ultimoPasso?: number | null;
}): { readonly valido: boolean; readonly passo: number | null } {
  const informado = params.codigo.replace(/\D/g, '');
  if (informado.length !== DIGITOS) return { valido: false, passo: null };

  const atual = passoAgora(params.now);

  for (let delta = -TOLERANCIA_DE_PASSOS; delta <= TOLERANCIA_DE_PASSOS; delta += 1) {
    const passo = atual + delta;
    if (params.ultimoPasso != null && passo <= params.ultimoPasso) continue;

    const esperado = codigoDoPasso(params.segredoBase32, passo);
    const a = Buffer.from(esperado);
    const b = Buffer.from(informado);
    if (a.length === b.length && timingSafeEqual(a, b)) return { valido: true, passo };
  }

  return { valido: false, passo: null };
}

/**
 * O endereço que o aplicativo autenticador lê no QR Code.
 *
 * O rótulo leva o nome da barbearia porque o dono pode administrar mais de uma,
 * e "Barbearia" sem qualificação vira três entradas idênticas no celular dele.
 */
export function uriDoAutenticador(params: {
  readonly segredoBase32: string;
  readonly email: string;
  readonly barbearia: string;
}): string {
  const rotulo = encodeURIComponent(`${params.barbearia}:${params.email}`);
  const emissor = encodeURIComponent(params.barbearia);
  return (
    `otpauth://totp/${rotulo}?secret=${params.segredoBase32}` +
    `&issuer=${emissor}&algorithm=SHA1&digits=${DIGITOS}&period=${PASSO_SEGUNDOS}`
  );
}

// -- Códigos de recuperação ---------------------------------------------------

const QUANTOS_DE_RECUPERACAO = 8;
/** Sem 0/O e 1/l: quem lê em voz alta ou anota no papel confunde os dois. */
const ALFABETO_RECUPERACAO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function gerarCodigosDeRecuperacao(): string[] {
  return Array.from({ length: QUANTOS_DE_RECUPERACAO }, () => {
    let codigo = '';
    for (let i = 0; i < 10; i += 1) {
      codigo += ALFABETO_RECUPERACAO[randomInt(ALFABETO_RECUPERACAO.length)];
    }
    return `${codigo.slice(0, 5)}-${codigo.slice(5)}`;
  });
}

/**
 * Guardados com o mesmo scrypt da senha.
 *
 * São credenciais de acesso ao dinheiro, e o cálculo é o mesmo: se o banco
 * vazar, um código em claro é um segundo fator inútil.
 */
export function hashDosCodigos(codigos: readonly string[]): Promise<string[]> {
  return Promise.all(codigos.map((codigo) => hashPassword(normalizarCodigo(codigo))));
}

export const normalizarCodigo = (codigo: string): string =>
  codigo.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Acha qual código de recuperação foi usado, ou `null`.
 *
 * Devolve o índice para quem chama poder **queimar aquele código**: código de
 * recuperação que continua valendo depois de usado é senha permanente escrita
 * num papel.
 */
export async function acharCodigoDeRecuperacao(
  informado: string,
  hashes: readonly string[],
): Promise<number | null> {
  const limpo = normalizarCodigo(informado);
  if (limpo.length < 8) return null;

  for (const [indice, hash] of hashes.entries()) {
    // `.valid`, não o objeto: `verifyPassword` devolve `{ valid, needsRehash }`,
    // e um `if` sobre o objeto é sempre verdadeiro. A primeira versão disto
    // aceitava **qualquer texto** como código de recuperação — bypass completo
    // do segundo fator, com o primeiro já vencido. O teste pegou.
    const { valid } = await verifyPassword(limpo, hash);
    if (valid) return indice;
  }
  return null;
}
