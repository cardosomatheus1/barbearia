import { municipioReaproveitado } from './catalogo.js';
import type { ResultadoMunicipal } from './contrato.js';

// SP: Manual oficial 3.3.7, pp. 53/82, 1106 na operação F (consulta por RPS).
// ABRASF: manuais 1.00/2.01 e tabela de erros 2.04, E4/E89/E91.
// Aplicar somente às versões/padrões inspecionados. E92 é processamento,
// código local 0 é falha técnica; nenhum deles autoriza um primeiro envio.
const ABRASF = new Set(['Ginfes:ve100', 'BHISS:ve100', 'ISSRio:ve100', 'ISSCuritiba:ve100',
  'GISS:ve204', 'ISSNet:ve204', 'Coplan:ve201', 'WebIss:ve100', 'WebIss:ve202']);
export function rpsAusente(municipio: number, resposta: ResultadoMunicipal): boolean {
  if (resposta.erro || resposta.notas.length || !resposta.xmlRetorno || resposta.codigos.length === 0) return false;
  const m = municipioReaproveitado(String(municipio));
  const codigos = m?.padrao === 'ISSSaoPaulo' && m.versao === 've100' ? ['1106']
    : m && ABRASF.has(`${m.padrao}:${m.versao}`) ? ['E4', 'E89', 'E91'] : [];
  return resposta.codigos.every(c => codigos.includes(c));
}
