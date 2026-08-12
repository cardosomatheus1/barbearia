import { describe, expect, it } from 'vitest';
import {
  EXPLICACAO_DA_SELECAO,
  EXPLICACAO_DA_TRANSFERENCIA,
  TODAS_AS_UNIDADES,
  ehConsolidado,
  precisaEscolher,
  resolverUnidade,
  validarTransferencia,
} from './multiunidade.js';

/**
 * Multiunidade (bloco 58).
 *
 * O que estes testes prendem é o que muda quando há duas lojas — e, tão
 * importante quanto, o que **não** muda quando há uma.
 */

const MATRIZ = { id: 'a', nome: 'Matriz', ativa: true };
const FILIAL = { id: 'b', nome: 'Filial', ativa: true };
const FECHADA = { id: 'c', nome: 'Antiga', ativa: false };

describe('qual unidade a sessão opera', () => {
  it('sem escolha, cai na primeira aberta — como sempre foi', () => {
    /**
     * É o comportamento de `primaryLocation`, que vinte rotas usavam. Mantê-lo
     * é o que faz a barbearia de uma unidade não notar que este bloco existiu.
     */
    const r = resolverUnidade({ escolhida: null, disponiveis: [MATRIZ, FILIAL], autorizadas: [] });
    expect(r).toEqual({ unidade: MATRIZ });
  });

  it('lista de autorizadas vazia significa todas', () => {
    // É o caso do dono, e o de toda barbearia existente no dia da migração:
    // negar por omissão trancaria a equipe inteira para fora.
    const r = resolverUnidade({ escolhida: 'b', disponiveis: [MATRIZ, FILIAL], autorizadas: [] });
    expect(r).toEqual({ unidade: FILIAL });
  });

  it('quem é de uma loja não escolhe a outra', () => {
    const r = resolverUnidade({
      escolhida: 'b',
      disponiveis: [MATRIZ, FILIAL],
      autorizadas: ['a'],
    });
    expect(r).toEqual({ falha: 'unidade_desconhecida' });
  });

  it('quem é de uma loja cai nela sem escolher', () => {
    const r = resolverUnidade({
      escolhida: null,
      disponiveis: [MATRIZ, FILIAL],
      autorizadas: ['b'],
    });
    expect(r).toEqual({ unidade: FILIAL });
  });

  it('unidade fechada não é operável', () => {
    /**
     * Operar numa loja fechada abriria caixa e venderia numa unidade que não
     * existe mais. Ler o histórico dela é outra coisa, e passa pelo
     * consolidado.
     */
    const r = resolverUnidade({
      escolhida: 'c',
      disponiveis: [MATRIZ, FECHADA],
      autorizadas: [],
    });
    expect(r).toEqual({ falha: 'unidade_fechada' });
  });

  it('sem nenhuma unidade autorizada, a conta não opera', () => {
    const r = resolverUnidade({ escolhida: null, disponiveis: [MATRIZ], autorizadas: ['z'] });
    expect(r).toEqual({ falha: 'sem_unidade' });
  });

  it('todas as falhas têm texto para a tela', () => {
    for (const falha of ['sem_unidade', 'unidade_desconhecida', 'unidade_fechada'] as const) {
      expect(EXPLICACAO_DA_SELECAO[falha]).toBeTruthy();
    }
  });

  it('o seletor só aparece com mais de uma loja aberta', () => {
    // Um seletor de um item só é ruído numa tela que a recepção usa o dia
    // inteiro.
    expect(precisaEscolher([MATRIZ])).toBe(false);
    expect(precisaEscolher([MATRIZ, FECHADA])).toBe(false);
    expect(precisaEscolher([MATRIZ, FILIAL])).toBe(true);
  });

  it('o consolidado é escolha de leitura, e se reconhece', () => {
    expect(ehConsolidado(TODAS_AS_UNIDADES)).toBe(true);
    expect(ehConsolidado('a')).toBe(false);
  });
});

describe('a transferência de estoque', () => {
  const base = {
    origemId: 'a',
    destinoId: 'b',
    quantidade: 3,
    saldoNaOrigem: 10,
    origemAberta: true,
    destinoAberta: true,
  };

  it('a transferência normal passa', () => {
    expect(validarTransferencia(base)).toBeNull();
  });

  it('da loja para ela mesma não é transferência', () => {
    /**
     * Aceitar produziria dois movimentos que se anulam e uma linha que não
     * explica nada — e um caminho para "acertar" saldo sem passar pelo ajuste,
     * que exige motivo escrito desde o bloco 47.
     */
    expect(validarTransferencia({ ...base, destinoId: 'a' })).toBe('mesma_unidade');
  });

  it('não se transfere mais do que a origem tem', () => {
    expect(validarTransferencia({ ...base, quantidade: 11 })).toBe('saldo_insuficiente');
    // A borda exata passa: dez de dez é esvaziar a loja, e é legítimo.
    expect(validarTransferencia({ ...base, quantidade: 10 })).toBeNull();
  });

  it('quantidade zero, negativa ou quebrada é recusada', () => {
    expect(validarTransferencia({ ...base, quantidade: 0 })).toBe('quantidade_invalida');
    expect(validarTransferencia({ ...base, quantidade: -1 })).toBe('quantidade_invalida');
    expect(validarTransferencia({ ...base, quantidade: 1.5 })).toBe('quantidade_invalida');
  });

  it('loja fechada não movimenta estoque, nem de um lado nem do outro', () => {
    expect(validarTransferencia({ ...base, origemAberta: false })).toBe('unidade_fechada');
    expect(validarTransferencia({ ...base, destinoAberta: false })).toBe('unidade_fechada');
  });

  it('todas as falhas têm texto para a tela', () => {
    for (const falha of [
      'mesma_unidade',
      'quantidade_invalida',
      'saldo_insuficiente',
      'unidade_fechada',
    ] as const) {
      expect(EXPLICACAO_DA_TRANSFERENCIA[falha]).toBeTruthy();
    }
  });
});
