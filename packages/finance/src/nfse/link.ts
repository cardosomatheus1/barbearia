import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { chaveFiscal } from './cofre.js';
import { NfseError } from './erros.js';

interface AcessoDocumento { tenantId: string; locationId: string; invoiceId: string; expira: number }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function assinar(payload: string): Buffer {
  const chave = Buffer.from(hkdfSync('sha256', chaveFiscal(), Buffer.alloc(0), 'nfse-link-documento-v1', 32));
  return createHmac('sha256', chave).update(payload).digest();
}
export function tokenDoDocumento(p: Omit<AcessoDocumento, 'expira'>, agora = new Date()): string {
  if (![p.tenantId, p.locationId, p.invoiceId].every(id => UUID.test(id))) throw new Error('nfse_referencia_invalida');
  const dados: AcessoDocumento = { ...p, expira: Math.floor(agora.getTime() / 1000) + 30 * 86400 };
  const payload = Buffer.from(JSON.stringify(dados)).toString('base64url');
  return `${payload}.${assinar(payload).toString('base64url')}`;
}
export function verificarTokenDoDocumento(token: string, agora = new Date()): AcessoDocumento {
  try {
    const [payload, mac, sobra] = token.split('.');
    if (token.length > 1000 || !payload || !mac || sobra !== undefined || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{43}$/.test(mac)) throw new Error();
    const hash = Buffer.from(mac, 'base64url');
    if (hash.length !== 32 || !timingSafeEqual(hash, assinar(payload))) throw new Error();
    const dados = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AcessoDocumento;
    if (![dados.tenantId, dados.locationId, dados.invoiceId].every(id => typeof id === 'string' && UUID.test(id)) ||
      !Number.isSafeInteger(dados.expira) || dados.expira <= Math.floor(agora.getTime() / 1000)) throw new Error();
    return dados;
  } catch { throw new NfseError('nfse_link_invalido', 'Este link expirou ou não está disponível. Solicite uma nova via à barbearia.', 404); }
}
export function urlDoDocumento(p: Omit<AcessoDocumento, 'expira'>, agora = new Date()): string {
  const bruta = process.env['WEB_URL'];
  if (!bruta) throw new NfseError('nfse_url_ausente', 'O endereço do site precisa ser configurado.');
  const url = new URL(bruta);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' &&
    !(process.env['NODE_ENV'] !== 'production' && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw new NfseError('nfse_url_invalida', 'O endereço do site precisa ser conferido.');
  }
  return `${url.origin}/nota/${tokenDoDocumento(p, agora)}`;
}
