import { describe, expect, it } from 'vitest';
import {
  COBERTURA_ALVO_DIAS,
  SEMANAS_COM_MOVIMENTO_MINIMAS,
  oQueVaiAcabar,
  preverConsumo,
  type ConsumoMedido,
} from './consumo.js';

/**
 * Previsão de consumo e sugestão de compra (bloco 69, SPEC §4.19).
 *
 * O exemplo da SPEC é uma frase só — *"a pomada X deve acabar em ~9 dias pelo
 * consumo das últimas 8 semanas"* — e ela esconde três decisões: de onde sai a
 * taxa, o que fazer quando não há ritmo, e para que lado arredondar. São as três
 * que estes testes prendem.
 */

const medido = (parcial: Partial<ConsumoMedido> = {}): ConsumoMedido => ({
  produtoId: 'pomada',
  nome: 'Pomada modeladora',
  saldo: 10,
  saidasNaJanela: 56,
  semanasComSaida: 8,
  ...parcial,
});

describe('quanto tempo o que está na prateleira dura', () => {
  it('a taxa sai da janela inteira, não das semanas em que houve saída', () => {
    /**
     * 56 saídas em 8 semanas é uma por dia; com 10 na prateleira, dez dias.
     *
     * Dividir só pelas semanas com movimento responde "quanto sai quando sai", e
     * a pergunta é "quanto sai por dia" — um produto que vende três numa semana
     * e zero nas outras sete dura muito mais do que a primeira conta diria.
     */
    expect(preverConsumo(medido()).diasAteAcabar).toBe(10);
    expect(preverConsumo(medido()).porDia).toBe(1);
  });

  it('a taxa não muda quando o produto sai em rajada', () => {
    /**
     * A asserção acima passava **com e sem** a regra: a semente vendia nas oito
     * semanas, e aí as duas contas coincidem. O que separa é o produto que sai
     * em rajada — 28 unidades concentradas em quatro semanas —, e ele dura o
     * dobro do que a conta ingênua diria.
     */
    const emRajada = preverConsumo(medido({ saidasNaJanela: 28, semanasComSaida: 4, saldo: 14 }));
    expect(emRajada.porDia).toBe(0.5);
    expect(emRajada.diasAteAcabar).toBe(28);
  });

  it('o prazo arredonda para baixo', () => {
    // "Acaba em 9 dias" quando acaba em 9,7 faz a compra sair um dia antes; o
    // contrário faz a barbearia descobrir a falta com a cliente na cadeira.
    expect(preverConsumo(medido({ saldo: 9, saidasNaJanela: 56 })).diasAteAcabar).toBe(9);
    expect(preverConsumo(medido({ saldo: 10, saidasNaJanela: 60 })).diasAteAcabar).toBe(9);
  });

  it('produto sem saída nenhuma não vira "nunca acaba"', () => {
    /**
     * `null`, nunca infinito. Numa lista ordenada por urgência o infinito desce
     * para o fim com cara de boa notícia, e o que ele quer dizer é que ninguém
     * sabe.
     */
    const previsao = preverConsumo(medido({ saidasNaJanela: 0, semanasComSaida: 0 }));
    expect(previsao.diasAteAcabar).toBeNull();
    expect(previsao.comprar).toBe(0);
  });

  it('uma semana de movimento não é um ritmo', () => {
    /**
     * Um pedido grande de uma cliente viraria "consumo semanal", e a sugestão
     * mandaria comprar doze potes de uma pomada que sai um por mês. É o mesmo
     * critério de `VISITAS_PARA_TER_CICLO`: um dado não é um ritmo.
     */
    const previsao = preverConsumo(
      medido({ saidasNaJanela: 12, semanasComSaida: SEMANAS_COM_MOVIMENTO_MINIMAS - 1 }),
    );
    expect(previsao.diasAteAcabar).toBeNull();
  });
});

describe('quanto comprar', () => {
  it('cobre a janela alvo descontando o que já existe', () => {
    // Uma por dia, trinta dias de cobertura, dez na prateleira: vinte.
    expect(preverConsumo(medido()).comprar).toBe(COBERTURA_ALVO_DIAS - 10);
  });

  it('quem já tem estoque para o mês não recebe sugestão', () => {
    // Sugerir compra sobre o que já está coberto é a lista que se aprende a
    // ignorar — e o dinheiro parado na prateleira é dinheiro parado.
    expect(preverConsumo(medido({ saldo: 40 })).comprar).toBe(0);
  });

  it('a sugestão é sempre unidade inteira, para cima', () => {
    // Ninguém compra 3,4 potes de pomada, e arredondar para baixo deixa o mês
    // faltando o último dia.
    const previsao = preverConsumo(medido({ saidasNaJanela: 20, saldo: 0 }));
    expect(previsao.comprar).toBe(Math.ceil((20 / 56) * COBERTURA_ALVO_DIAS));
    expect(Number.isInteger(previsao.comprar)).toBe(true);
  });
});

describe('a lista do que vai acabar', () => {
  const previsao = (nome: string, dias: number | null) => ({
    produtoId: nome,
    nome,
    saldo: 1,
    porDia: 1,
    diasAteAcabar: dias,
    comprar: 1,
  });

  it('vem do mais urgente para o menos', () => {
    const lista = oQueVaiAcabar([previsao('Cera', 20), previsao('Pomada', 3)], 30);
    expect(lista.map((p) => p.nome)).toEqual(['Pomada', 'Cera']);
  });

  it('quem não tem previsão fica de fora, e não no fim', () => {
    /**
     * Numa lista ordenada por urgência, "não sei" com cara de "está tranquilo" é
     * pior que a ausência: o dono lê a lista inteira e conclui que o estoque
     * está saudável.
     */
    const lista = oQueVaiAcabar([previsao('Sem histórico', null), previsao('Pomada', 3)], 30);
    expect(lista.map((p) => p.nome)).toEqual(['Pomada']);
  });

  it('o que dura mais que a janela pedida não entra', () => {
    expect(oQueVaiAcabar([previsao('Cera', 45)], 30)).toHaveLength(0);
  });

  it('empate desempata por nome, não pela ordem da consulta', () => {
    // Sem desempate estável a tela troca de ordem entre dois carregamentos sem
    // nada ter mudado.
    const numaOrdem = oQueVaiAcabar([previsao('Zinco', 5), previsao('Argila', 5)], 30);
    const naOutra = oQueVaiAcabar([previsao('Argila', 5), previsao('Zinco', 5)], 30);
    expect(numaOrdem.map((p) => p.nome)).toEqual(naOutra.map((p) => p.nome));
    expect(numaOrdem[0]?.nome).toBe('Argila');
  });
});
