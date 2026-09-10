// Formação oficial TSIdDPS/TSIdNFSe: só a inscrição federal admite letras.
export const ID_DPS_NFSE = /^DPS[0-9]{7}(?:1[0-9]{14}|2[A-Z0-9]{12}[0-9]{2})[0-9]{20}$/;
export const CHAVE_NFSE = /^[0-9]{8}(?:1[0-9]{14}|2[A-Z0-9]{12}[0-9]{2})[0-9]{27}$/;
export const idNotaNfseValido = (id: string): boolean => id.startsWith('NFS') && CHAVE_NFSE.test(id.slice(3));
export const idPedidoCancelamentoValido = (id: string): boolean =>
  id.startsWith('PRE') && id.endsWith('101101') && CHAVE_NFSE.test(id.slice(3, -6));
export const idCancelamentoValido = (id: string): boolean =>
  id.startsWith('EVT') && id.endsWith('101101001') && CHAVE_NFSE.test(id.slice(3, -9));

export function caminhoNfsePermitido(caminho: string): boolean {
  if (caminho === '/nfse' || /^\/parametros_municipais\/\d{7}\/convenio$/.test(caminho)) return true;
  if (caminho.startsWith('/dps/')) return ID_DPS_NFSE.test(caminho.slice(5));
  const partes = caminho.split('/');
  return partes[0] === '' && partes[1] === 'nfse' && CHAVE_NFSE.test(partes[2] ?? '') &&
    (partes.length === 3 || (partes[3] === 'eventos' && (partes.length === 4 ||
      (partes.length === 6 && /^\d{6}$/.test(partes[4] ?? '') && /^\d{1,3}$/.test(partes[5] ?? '')))));
}
