import { readFileSync, accessSync, constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { NfseError } from '../nfse/erros.js';

export interface MunicipioReaproveitado {
  readonly codigo: number; readonly nome: string; readonly uf: string; readonly padrao: string;
  readonly homologacao: boolean; readonly producao: boolean;
  readonly versao: string;
}
// Gerado pelo próprio motor C# com a mesma fonte fixada usada no executável.
const MUNICIPIOS = JSON.parse(readFileSync(new URL('../../assets/nfse-municipal/municipios.json', import.meta.url), 'utf8')) as MunicipioReaproveitado[];
export function municipioReaproveitado(codigo: string): MunicipioReaproveitado | null {
  return MUNICIPIOS.find(m => String(m.codigo) === codigo) ?? null;
}
export function exigirMunicipioReaproveitado(codigo: string, ambiente: 'homologacao' | 'producao'): MunicipioReaproveitado {
  const municipio = municipioReaproveitado(codigo);
  if (!municipio?.[ambiente]) throw new NfseError('nfse_municipal_sem_suporte',
    'Este município ainda não tem integração municipal disponível neste ambiente. Utilize o portal da prefeitura.');
  return municipio;
}
export function executavelMunicipal(): string {
  const bin = process.env['FISCAL_MUNICIPAL_BIN'];
  if (!bin || !isAbsolute(bin)) throw new NfseError('nfse_municipal_indisponivel', 'A plataforma precisa habilitar o emissor municipal.');
  try { accessSync(bin, constants.X_OK); }
  catch { throw new NfseError('nfse_municipal_indisponivel', 'O emissor municipal não está disponível nesta instalação.'); }
  return bin;
}
