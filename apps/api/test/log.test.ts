import { describe, expect, it } from 'vitest';

import { idDaRequisicao, montarLinha, rotaGenerica, semConsulta } from '../src/common/log.js';

/**
 * O teste do log é sobre vazamento, não sobre formato.
 *
 * A linha bonita não custa nada; o telefone que entra nela custa uma
 * notificação à ANPD. Cada caso aqui é uma URL de verdade do produto.
 */

describe('a consulta nunca entra no log', () => {
  it.each([
    ['/v1/auth/otp?phone=%2B5571988887777', '/v1/auth/otp'],
    ['/v1/admin/customers?q=Maria%20Aparecida', '/v1/admin/customers'],
    ['/v1/b/barbearia-x/availability?serviceIds=a,b&dateFrom=2026-08-09', '/v1/b/barbearia-x/availability'],
    ['/v1/admin/state#token=abc', '/v1/admin/state'],
  ])('%s', (url, esperado) => {
    expect(semConsulta(url)).toBe(esperado);
  });

  it('a linha montada não carrega nada da consulta', () => {
    const linha = montarLinha({
      metodo: 'POST',
      url: '/v1/auth/otp?phone=%2B5571988887777&code=445566',
      status: 200,
      duracaoMs: 12.7,
      requisicaoId: 'abc',
    });

    const texto = JSON.stringify(linha);
    expect(texto).not.toContain('988887777');
    expect(texto).not.toContain('445566');
    expect(linha.rota).toBe('/v1/auth/otp');
  });
});

describe('identificador some da rota', () => {
  it('UUID vira :id — é credencial de comprovante, não número de série', () => {
    expect(rotaGenerica('/v1/b/x/appointments/0a912b0e-cd32-4ebb-8e36-6aa7f2c569bf/cancel')).toBe(
      '/v1/b/x/appointments/:id/cancel',
    );
  });

  it('ULID vira :id', () => {
    expect(rotaGenerica('/v1/admin/orders/01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(
      '/v1/admin/orders/:id',
    );
  });

  it('sequência longa de dígitos vira :n', () => {
    // Telefone que escapou para o caminho é o caso que isto existe para pegar.
    expect(rotaGenerica('/v1/b/x/fila/5571988887777')).toBe('/v1/b/x/fila/:n');
  });

  it('o slug fica — ele é público e é o que agrupa por barbearia', () => {
    expect(rotaGenerica('/v1/b/barbearia-do-ze/availability')).toBe(
      '/v1/b/barbearia-do-ze/availability',
    );
  });

  it('duas chamadas do mesmo endpoint colapsam na mesma rota', () => {
    // É isto que faz "quantas vezes /appointments/:id falhou hoje" ter
    // resposta. Sem colapsar, são quatro mil rotas de uma chamada cada.
    const a = rotaGenerica('/v1/b/x/appointments/0a912b0e-cd32-4ebb-8e36-6aa7f2c569bf');
    const b = rotaGenerica('/v1/b/x/appointments/7f3e1d99-1111-4222-8333-444455556666');

    expect(a).toBe(b);
  });
});

describe('nível vem do status', () => {
  it.each([
    [200, 'info'],
    [404, 'aviso'],
    [429, 'aviso'],
    [500, 'erro'],
  ])('%i -> %s', (status, nivel) => {
    expect(montarLinha({ metodo: 'GET', url: '/x', status, duracaoMs: 1, requisicaoId: 'r' }).nivel)
      .toBe(nivel);
  });
});

describe('identificador da requisição', () => {
  const sortear = () => 'sorteado';

  it('aceita o do proxy quando ele é são', () => {
    expect(idDaRequisicao('abc-123_XYZ.9', sortear)).toBe('abc-123_XYZ.9');
  });

  it('recusa quebra de linha — é assim que se forja entrada no agregador', () => {
    expect(idDaRequisicao('abc\nnivel=info rota=/admin', sortear)).toBe('sorteado');
  });

  it('recusa o que é grande demais', () => {
    expect(idDaRequisicao('a'.repeat(65), sortear)).toBe('sorteado');
  });

  it.each([[undefined], [''], ['  '], ['tem espaço'], ['acentuação']])(
    'sorteia quando o cabeçalho não serve (%s)',
    (bruto) => {
      expect(idDaRequisicao(bruto, sortear)).toBe('sorteado');
    },
  );

  it('com o cabeçalho repetido, fica o primeiro', () => {
    expect(idDaRequisicao(['primeiro', 'segundo'], sortear)).toBe('primeiro');
  });
});
