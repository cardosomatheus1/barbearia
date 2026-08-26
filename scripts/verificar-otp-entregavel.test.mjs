import assert from 'node:assert/strict';
import test from 'node:test';
import { erroDaEntregaDeOtp, unidadesComOtp } from './verificar-otp-entregavel.mjs';

const recusa = (c) => erroDaEntregaDeOtp(c) !== null;

test('fora de produção o console passa, mesmo com OTP ligado', () => {
  assert.equal(recusa({ modo: 'console', producao: false, unidades: 3 }), false);
});

test('com a Meta configurada não há o que conferir', () => {
  assert.equal(recusa({ modo: 'meta', producao: true, unidades: 9 }), false);
});

test('console em produção passa quando ninguém exige OTP', () => {
  assert.equal(recusa({ modo: 'console', producao: true, unidades: 0 }), false);
});

test('console em produção recusa quando alguma unidade exige OTP', () => {
  const erro = erroDaEntregaDeOtp({ modo: 'console', producao: true, unidades: 2 });
  assert.ok(erro);
  // A frase precisa dizer **quantas** e **o que fazer**: "recusado" sozinho
  // manda alguém abrir o banco para descobrir o que a guarda já sabia.
  assert.match(erro, /2 unidade/);
  assert.match(erro, /IDENTITY_MESSAGING_MODO=meta/);
});

/**
 * Banco mudo fecha, e é a decisão que separa esta guarda de uma inútil.
 *
 * Sem resposta ela não sabe se alguém depende do OTP. Liberar aí seria escolher
 * o caso melhor justamente quando está cega — e um `psql` que falha por rede é
 * indistinguível de um que falha porque a coluna sumiu numa refatoração.
 */
test('sem resposta do banco, recusa em vez de supor que ninguém usa', () => {
  assert.equal(recusa({ modo: 'console', producao: true, unidades: null }), true);
});

test('modo com erro de digitação não vira console em silêncio', () => {
  const erro = erroDaEntregaDeOtp({ modo: 'consoel', producao: true, unidades: 0 });
  assert.match(erro ?? '', /inválido/);
});

/** `unidadesComOtp` devolve `null` quando o `psql` explode, e não propaga. */
test('falha ao consultar vira null, não exceção', () => {
  assert.equal(
    unidadesComOtp(() => {
      throw new Error('conexão recusada');
    }),
    null,
  );
  assert.equal(unidadesComOtp(() => 'não-é-número'), null);
  assert.equal(unidadesComOtp(() => ' 4 \n'), 4);
});
