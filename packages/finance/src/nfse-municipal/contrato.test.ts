import { describe, expect, it } from 'vitest';
import { rpsAusente } from './ausencia.js';
import { lerResultadoMunicipal } from './ponte.js';
import type { ResultadoMunicipal } from './contrato.js';
const resposta = (codigos: string[]): ResultadoMunicipal => ({ sucesso: false, erro: null, codigos,
  xmlEnvio: '', xmlRetorno: '<RetornoConsulta/>', protocolo: null, lote: null, notas: [] });

describe('contrato do motor municipal reutilizado', () => {
  it('ausência documentada permite apenas a consulta inicial, com o padrão correspondente', () => {
    expect(rpsAusente(3550308, resposta(['1106']))).toBe(true);
    expect(rpsAusente(3106200, resposta(['E4']))).toBe(true);
    expect(rpsAusente(3550308, resposta(['E4']))).toBe(false);
    expect(rpsAusente(3106200, resposta(['1106']))).toBe(false);
  });
  it.each([['E92'], ['0'], ['E4', 'E92'], ['E4', 'E10'], [], ['E212']].map(codigos => ({ codigos })))('não confunde processamento, falha ou código desconhecido com ausência: $codigos', ({ codigos }) => {
    expect(rpsAusente(3106200, resposta(codigos))).toBe(false);
  });
  it('exige corpo de resposta e ausência de falha técnica', () => {
    expect(rpsAusente(3550308, { ...resposta(['1106']), xmlRetorno: '' })).toBe(false);
    expect(rpsAusente(3550308, { ...resposta(['1106']), erro: 'nfse_municipal_confirmacao_pendente' })).toBe(false);
  });
  it('retorno técnico permanece distinguível da recusa fiscal', () => {
    expect(lerResultadoMunicipal({ ...resposta([]), erro: 'nfse_municipal_confirmacao_pendente' }).erro).toBe('nfse_municipal_confirmacao_pendente');
    expect(() => lerResultadoMunicipal({ ...resposta([]), erro: 'conteúdo privado' })).toThrow();
  });
  it('não aceita cabeçalhos injetados nem resultado de nota sem identidade fiscal', () => {
    expect(() => lerResultadoMunicipal({ ...resposta([]), requisicao: { url: 'https://example.invalid', metodo: 'POST',
      corpoBase64: '', cabecalhos: { Authorization: ['valor\r\nHost: interno'] }, cabecalhosConteudo: {} } })).toThrow();
    expect(() => lerResultadoMunicipal({ ...resposta([]), notas: [{ numero: '1', xml: '<nota/>' }] })).toThrow();
  });
});
