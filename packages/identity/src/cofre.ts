import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * O cofre de segredos de ambiente (bloco 55).
 *
 * O segundo fator já cifrava o próprio segredo com AES-256-GCM desde o bloco
 * 33. O WhatsApp trouxe o segundo caso — o token de acesso da barbearia — e a
 * pergunta virou **qual chave**.
 *
 * A resposta é: uma por finalidade, nunca uma para tudo. É o precedente escrito
 * do webhook da Stripe, que tem segredo próprio porque ela gera um por
 * endereço, e a razão aqui é mais forte: com uma chave só, girar a do segundo
 * fator — operação normal de segurança — deixaria ilegível o token de WhatsApp
 * de todas as barbearias ao mesmo tempo, e o erro apareceria como "mensagem
 * parou de sair" dias depois.
 *
 * Mora em `identity` porque é onde a criptografia deste produto mora: `core`
 * não depende de nada, nem de `node:crypto`.
 */

export class CofreError extends Error {
  constructor(
    readonly variavel: string,
    message: string,
  ) {
    super(message);
    this.name = 'CofreError';
  }
}

/**
 * A chave, lida do ambiente, **falhando alto quando ausente**.
 *
 * Cair num padrão vazio faria o produto cifrar com uma chave conhecida e
 * continuar funcionando — que é o pior desfecho possível, porque nada fica
 * vermelho e o dado nasce desprotegido.
 */
function chaveDe(variavel: string): Buffer {
  const bruta = process.env[variavel];
  if (!bruta) {
    throw new CofreError(
      variavel,
      `${variavel} não definida. Sem ela este segredo não pode ser guardado com segurança.`,
    );
  }
  const chave = Buffer.from(bruta, 'base64');
  if (chave.length !== 32) {
    throw new CofreError(
      variavel,
      `${variavel} precisa ter 32 bytes em base64 (openssl rand -base64 32).`,
    );
  }
  return chave;
}

/** AES-256-GCM: cifra e autentica. O nonce vai junto, como manda o modo. */
export function cifrarCom(variavel: string, segredo: string): string {
  const nonce = randomBytes(12);
  const cifra = createCipheriv('aes-256-gcm', chaveDe(variavel), nonce);
  const dados = Buffer.concat([cifra.update(segredo, 'utf8'), cifra.final()]);
  return [nonce.toString('base64'), cifra.getAuthTag().toString('base64'), dados.toString('base64')]
    .join('.');
}

export function decifrarCom(variavel: string, guardado: string): string {
  const [nonce, tag, dados] = guardado.split('.');
  if (!nonce || !tag || !dados) {
    throw new CofreError(variavel, 'Segredo guardado está corrompido.');
  }
  const decifra = createDecipheriv('aes-256-gcm', chaveDe(variavel), Buffer.from(nonce, 'base64'));
  decifra.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([
    decifra.update(Buffer.from(dados, 'base64')),
    decifra.final(),
  ]).toString('utf8');
}
