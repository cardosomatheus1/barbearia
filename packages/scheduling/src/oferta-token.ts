import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

function chave(): Buffer {
  const raw=process.env['WHATSAPP_TOKEN_KEY'];
  if (!raw || !/^[A-Za-z0-9+/]{43}=$/.test(raw) || Buffer.from(raw,'base64').length!==32) {
    throw new Error('WHATSAPP_TOKEN_KEY precisa conter 32 bytes em base64 para recuperar convites');
  }
  return Buffer.from(hkdfSync('sha256',Buffer.from(raw,'base64'),Buffer.alloc(0),'barberdock-oferta-entrega-v1',32));
}
export function cifrarTokenDaOferta(token:string,tenantId:string,ofertaId:string):string {
  const iv=randomBytes(12);const c=createCipheriv('aes-256-gcm',chave(),iv);
  c.setAAD(Buffer.from(`${tenantId}:${ofertaId}`));
  return Buffer.concat([iv,c.update(token,'utf8'),c.final(),c.getAuthTag()]).toString('base64');
}
export function decifrarTokenDaOferta(cifra:string,tenantId:string,ofertaId:string):string {
  try {
    const b=Buffer.from(cifra,'base64');if(b.length<28)throw new Error();
    const c=createDecipheriv('aes-256-gcm',chave(),b.subarray(0,12));
    c.setAAD(Buffer.from(`${tenantId}:${ofertaId}`));c.setAuthTag(b.subarray(-16));
    return Buffer.concat([c.update(b.subarray(12,-16)),c.final()]).toString('utf8');
  } catch { throw new Error('oferta_token_de_entrega_invalido'); }
}
