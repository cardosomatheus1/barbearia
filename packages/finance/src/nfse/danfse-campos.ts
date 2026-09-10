import { readFileSync } from 'node:fs';
import { registro } from './transporte.js';

const municipios = JSON.parse(readFileSync(new URL('../../assets/danfse/municipios.json', import.meta.url), 'utf8')) as Record<string, { nome: string; uf: string }>;

export function campo(no: unknown, caminho: string): string {
  let valor = no;
  for (const parte of caminho.split('/')) valor = registro(valor)[parte];
  return typeof valor === 'string' ? valor : '';
}
export function rotulo(valor: string, opcoes: Readonly<Record<string, string>>): string { return opcoes[valor] ?? valor; }
export function localidade(ibge: string, nome = ''): string {
  const m = municipios[ibge];
  return m ? `${nome || m.nome} / ${m.uf}` : nome || ibge;
}
export function valorFiscal(valor: string, percentual = false): string {
  if (!valor) return '-';
  if (!/^\d+\.\d{2}$/.test(valor)) return valor;
  const [inteiro = '', fracao = ''] = valor.split('.');
  return `${percentual ? '' : 'R$ '}${inteiro.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${fracao}${percentual ? '%' : ''}`;
}
export function somarValores(...valores: string[]): string {
  if (valores.every(v => !v)) return '';
  const cents = valores.reduce((s, v) => s + (v ? BigInt(v.replace('.', '')) : 0n), 0n);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}
export function dataFiscal(valor: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}:\d{2}))?/.exec(valor);
  return m ? `${m[3]}/${m[2]}/${m[1]}${m[4] ? ` ${m[4]}` : ''}` : valor;
}
export function documentoFiscal(valor: string): string {
  if (/^\d{11}$/.test(valor)) return valor.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  if (/^[A-Z0-9]{12}\d{2}$/.test(valor)) return valor.replace(/^(.{2})(.{3})(.{3})(.{4})(.{2})$/, '$1.$2.$3/$4-$5');
  return valor;
}
export function tributosAproximadosDanfse(dps: unknown): string {
  const total = registro(registro(registro(dps)['valores'])['trib'])['totTrib'];
  const grupo = registro(total);
  const percentuais = Object.hasOwn(grupo, 'pTotTrib');
  const valores = registro(grupo[percentuais ? 'pTotTrib' : 'vTotTrib']);
  const prefixo = percentuais ? 'pTotTrib' : 'vTotTrib';
  const partes = [['Federais', 'Fed'], ['Estaduais', 'Est'], ['Municipais', 'Mun']].map(([nome, sufixo]) =>
    `${nome}: ${valorFiscal(campo(valores, prefixo + sufixo), percentuais)}`);
  const simples = campo(grupo, 'pTotTribSN');
  return `Totais Aproximados dos Tributos cfe. Lei nº 12.741/2012: ${partes.join('; ')}${simples ? ` | Total Simples Nacional: ${valorFiscal(simples, true)}` : ''}`;
}
