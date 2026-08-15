/**
 * O endereço de volta da Meta, escrito **uma vez**.
 *
 * Ele aparece nas duas pontas da mesma viagem: na ida, dentro do
 * `dialog/oauth`, e na volta, junto do código que vai ser trocado por token. A
 * Meta compara os dois **byte a byte** e recusa a troca quando diferem.
 *
 * Escrito nos dois lugares, seria a lista paralela de sempre — e esta tem um
 * agravante: a divergência não falha na ida. Ela falha só na volta, depois de a
 * pessoa ter autorizado na Meta, e chega à tela como "a Meta recusou a
 * conexão", que é a frase que não diz nada sobre o que fazer.
 */
export const ENDERECO_PUBLICO = process.env['WEB_URL'] ?? 'http://localhost:3001';

export const VOLTA_DA_META = `${ENDERECO_PUBLICO}/admin/whatsapp/conectado`;
