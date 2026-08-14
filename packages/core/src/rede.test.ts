import { describe, expect, it } from 'vitest';
import {
  MINIMO_PARA_COMPARAR_REDE,
  consolidar,
  meuLugarNaRede,
  type UnidadeDaRede,
} from './rede.js';

const unidade = (p: Partial<UnidadeDaRede> & { receitaCents: number }): UnidadeDaRede => ({
  tenantId: null,
  nome: null,
  eu: false,
  vendas: 10,
  atendimentos: 10,
  metaCents: null,
  ...p,
});

describe('indicadores consolidados da rede', () => {
  it('o ticket da rede é a soma sobre a contagem, nunca a média das médias', () => {
    /**
     * Duas unidades de R$ 30 por venda com uma venda cada, e uma de R$ 120 com
     * duas: a soma é 30+30+240 = 300 sobre 4 vendas = R$ 75. A média das médias
     * daria R$ 60 — ela pesa igual quem fez uma e quem fez duas.
     */
    const rede = consolidar([
      unidade({ receitaCents: 3000, vendas: 1 }),
      unidade({ receitaCents: 3000, vendas: 1 }),
      unidade({ receitaCents: 24000, vendas: 2 }),
    ]);
    expect(rede.receitaTotalCents).toBe(30000);
    expect(rede.vendasTotais).toBe(4);
    expect(rede.ticketMedioCents).toBe(7500);
  });

  it('unidade sem venda tem ticket null, nunca infinito', () => {
    // É o mês em que a franqueada abriu, e é quando a franqueadora abre a tela.
    const rede = consolidar([unidade({ receitaCents: 0, vendas: 0 })]);
    expect(rede.linhas[0]?.ticketMedioCents).toBeNull();
    expect(rede.ticketMedioCents).toBeNull();
  });

  it('a comparação usa mediana, e não média', () => {
    /**
     * Uma franqueada de shopping com o triplo do faturamento puxa a média para
     * cima e faz metade da rede parecer abaixo do normal. A mediana é quem a
     * rede é.
     */
    const rede = consolidar([
      unidade({ receitaCents: 10_000 }),
      unidade({ receitaCents: 12_000 }),
      unidade({ receitaCents: 14_000 }),
      unidade({ receitaCents: 200_000 }),
    ]);
    // Média seria 59.000; mediana é 13.000.
    expect(rede.medianaDaReceitaCents).toBe(13_000);
  });

  it('abaixo do mínimo a mediana é null, não um número', () => {
    // Com três, "a mediana da rede" é uma frase sobre duas empresas — e quem lê
    // deduz o número da vizinha por subtração.
    const poucas = Array.from({ length: MINIMO_PARA_COMPARAR_REDE - 1 }, (_, i) =>
      unidade({ receitaCents: 10_000 * (i + 1) }),
    );
    expect(consolidar(poucas).medianaDaReceitaCents).toBeNull();

    const bastante = [...poucas, unidade({ receitaCents: 40_000 })];
    expect(consolidar(bastante).medianaDaReceitaCents).not.toBeNull();
  });

  it('sem meta o progresso é null, e é diferente de zero por cento', () => {
    const rede = consolidar([
      unidade({ receitaCents: 50_000 }),
      unidade({ receitaCents: 50_000, metaCents: 100_000 }),
      unidade({ receitaCents: 120_000, metaCents: 100_000 }),
    ]);
    expect(rede.linhas[0]?.progressoBps).toBeNull();
    expect(rede.linhas[1]?.progressoBps).toBe(5000);
    expect(rede.linhas[2]?.progressoBps).toBe(12_000);
    // Só as duas com meta entram na conta de quem bateu.
    expect(rede.bateramAMeta).toBe(1);
  });

  it('rede inteira sem meta devolve null, e não "nenhuma bateu"', () => {
    // "0 de 5 bateram a meta" sobre uma rede em que ninguém combinou meta é a
    // tela acusando quem não foi cobrado de nada.
    expect(consolidar([unidade({ receitaCents: 50_000 })]).bateramAMeta).toBeNull();
  });

  it('a franqueada vê o próprio lugar, sem nome de ninguém', () => {
    const lista = [
      unidade({ receitaCents: 10_000 }),
      unidade({ receitaCents: 20_000 }),
      unidade({ receitaCents: 30_000, eu: true, tenantId: 't', nome: 'Dock Feira' }),
      unidade({ receitaCents: 40_000 }),
    ];
    const meu = meuLugarNaRede(lista);

    expect(meu?.minha.nome).toBe('Dock Feira');
    expect(meu?.medianaDaReceitaCents).toBe(25_000);
    // Duas das quatro faturam menos que ela.
    expect(meu?.percentil).toBe(50);

    // E nenhuma outra linha carrega identidade.
    expect(lista.filter((u) => !u.eu).every((u) => u.nome === null && u.tenantId === null)).toBe(
      true,
    );
  });

  it('sem a própria linha não há lugar na rede — e a resposta é nenhuma', () => {
    // Só acontece quando quem perguntou não é franqueada. Devolver a rede
    // inteira aqui seria o relatório nomeado saindo pela porta errada.
    expect(meuLugarNaRede([unidade({ receitaCents: 10_000 })])).toBeNull();
  });

  it('numa rede pequena a franqueada não recebe percentil', () => {
    const meu = meuLugarNaRede([
      unidade({ receitaCents: 10_000, eu: true }),
      unidade({ receitaCents: 20_000 }),
    ]);
    expect(meu?.percentil).toBeNull();
    expect(meu?.medianaDaReceitaCents).toBeNull();
    // Mas os próprios números ela vê sempre.
    expect(meu?.minha.receitaCents).toBe(10_000);
  });
});
