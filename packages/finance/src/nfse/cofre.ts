import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function chaveFiscal(): Buffer {
  const valor = process.env['FISCAL_SECRET_KEY'];
  if (!valor || !/^[A-Za-z0-9+/]{43}=$/.test(valor)) throw new Error('FISCAL_SECRET_KEY precisa de 32 bytes em base64');
  const chave = Buffer.from(valor, 'base64');
  if (chave.length !== 32 || chave.toString('base64') !== valor) throw new Error('FISCAL_SECRET_KEY invalida');
  return chave;
}

/** AAD impede mover um certificado/documento cifrado para outra loja ou finalidade. */
export function cifrarFiscal(conteudo: string, escopo: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', chaveFiscal(), nonce);
  cipher.setAAD(Buffer.from(`nfse:v1:${escopo}`));
  const dados = Buffer.concat([cipher.update(conteudo, 'utf8'), cipher.final()]);
  return ['v1', nonce.toString('base64'), cipher.getAuthTag().toString('base64'), dados.toString('base64')].join('.');
}

export function decifrarFiscal(conteudo: string, escopo: string): string {
  const chave = chaveFiscal();
  try {
    const [versao, iv, mac, body, sobra] = conteudo.split('.');
    if (versao !== 'v1' || !iv || !mac || !body || sobra !== undefined) throw new Error();
    const nonce = Buffer.from(iv, 'base64'); const tag = Buffer.from(mac, 'base64'); const dados = Buffer.from(body, 'base64');
    if (nonce.length !== 12 || tag.length !== 16 || nonce.toString('base64') !== iv ||
      tag.toString('base64') !== mac || dados.toString('base64') !== body) throw new Error();
    const cipher = createDecipheriv('aes-256-gcm', chave, nonce);
    cipher.setAAD(Buffer.from(`nfse:v1:${escopo}`)); cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(dados), cipher.final()]).toString('utf8');
  } catch { throw new Error('nfse_cofre_invalido'); }
}
