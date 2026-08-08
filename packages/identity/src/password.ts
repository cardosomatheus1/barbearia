import {
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

/**
 * Senha do gestor.
 *
 * **scrypt**, do próprio Node, e não uma biblioteca nova. Ele é KDF de memória
 * dura — o custo de um ataque cresce em RAM, não só em CPU, que é o que torna
 * GPU e ASIC ineficientes. Argon2id seria a escolha de manual, mas entra como
 * dependência nativa compilada; scrypt entrega a mesma classe de proteção sem
 * ampliar a superfície de build (CLAUDE.md §4).
 *
 * O hash guarda os parâmetros junto:
 *
 *     scrypt$N$r$p$salt$derivada
 *
 * Sem isso, subir o custo invalidaria toda senha já cadastrada. Com isso, hash
 * antigo continua verificável e é regravado no próximo login bem-sucedido.
 */

/**
 * `promisify` perde a sobrecarga com opções — o tipo resultante aceita três
 * argumentos e o custo cairia silenciosamente no padrão do Node (N=16384 sem
 * `maxmem` ajustado). Envolver à mão preserva a assinatura que interessa.
 */
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (erro, chave) => {
      if (erro) reject(erro);
      else resolve(chave);
    });
  });
}

/**
 * ~64 MiB e ~100 ms por verificação nesta máquina.
 *
 * O número existe para tornar a tentativa em massa cara. Baixá-lo "porque o
 * login ficou lento" é desfazer a única defesa contra vazamento de banco.
 */
const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** `maxmem` precisa acompanhar N·r·128 com folga, senão o scrypt recusa. */
const MAX_MEM = 256 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, {
    N,
    r: R,
    p: P,
    maxmem: MAX_MEM,
  });

  return ['scrypt', N, R, P, salt.toString('base64'), derived.toString('base64')].join('$');
}

export interface PasswordCheck {
  readonly valid: boolean;
  /** Verdadeiro quando o hash foi gerado com custo menor que o atual. */
  readonly needsRehash: boolean;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<PasswordCheck> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return { valid: false, needsRehash: false };

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4] ?? '', 'base64');
  const expected = Buffer.from(parts[5] ?? '', 'base64');

  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return { valid: false, needsRehash: false };
  }
  // Um hash forjado com N absurdo faria o processo travar tentando alocar. O
  // teto é o mesmo `maxmem` que a geração usa.
  if (n > N * 4 || n < 2 || r < 1 || p < 1 || expected.length === 0) {
    return { valid: false, needsRehash: false };
  }

  const derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
    N: n,
    r,
    p,
    maxmem: MAX_MEM,
  });

  // Comparação em tempo constante: `===` vaza o tamanho do prefixo correto.
  const valid = derived.length === expected.length && timingSafeEqual(derived, expected);
  return { valid, needsRehash: valid && n < N };
}

/**
 * Chave de busca do e-mail, para o índice entre tenants.
 *
 * HMAC e não hash simples: sem segredo, qualquer um com o dump testaria e-mails
 * conhecidos contra a tabela e descobriria quem é cliente da plataforma. Com
 * segredo, o dump sozinho não responde nada.
 *
 * O e-mail entra normalizado — `NFKC` e minúsculas — senão `Joao@x.com` e
 * `joao@x.com` gerariam chaves diferentes e o mesmo dono teria duas contas.
 */
export function emailKey(email: string, pepper: string): string {
  if (!pepper) {
    throw new Error('STAFF_EMAIL_PEPPER não configurado — o índice de login ficaria em claro');
  }
  return createHmac('sha256', pepper)
    .update(email.normalize('NFKC').trim().toLowerCase())
    .digest('hex');
}
