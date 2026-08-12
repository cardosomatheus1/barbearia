import { describe, expect, it } from 'vitest';
import { comissaoDoPeriodo, type LancamentoDeComissao } from './comissao.js';
import {
  aplicarModeloDaAssinatura,
  fraseDaSimulacao,
  rentabilidadeDoAssinante,
  simularModelosDaAssinatura,
  type LancamentoNoPeriodo,
} from './comissao-da-assinatura.js';

/**
 * Comissão sobre assinatura (bloco 48, SPEC §3.4).
 *
 * O conflito que a SPEC chama de "o que mais gera na prática" é aritmético, e os
 * testes deste arquivo são a aritmética: o assinante paga R$ 149 e corta quatro
 * vezes a R$ 60, com 40% de comissão.
 *
 *   Por uso   → 4 × R$ 24 = R$ 96
 *   Rateio    → 40% de R$ 149 = R$ 59,60
 *   Híbrido   → teto de 60% de R$ 149 = R$ 89,40
 */

const RUAN = 'p-1';
const BRUNO = 'p-2';
const ASSINATURA = 's-1';
const MENSALIDADE = 14_900;

const uso = (
  n: number,
  extra: Partial<LancamentoNoPeriodo> = {},
): LancamentoNoPeriodo => ({
  itemId: `i-${n}`,
  professionalId: RUAN,
  regraId: 'r-corte',
  modo: 'percent',
  valor: 4000,
  faixas: [],
  baseCents: 6000,
  sinal: 1,
  assinaturaId: ASSINATURA,
  mensalidadeCents: MENSALIDADE,
  ...extra,
});

const soma = (lancamentos: readonly LancamentoDeComissao[]): number =>
  comissaoDoPeriodo(lancamentos).reduce((s, c) => s + c.comissaoCents, 0);

const quatroCortes = [uso(1), uso(2), uso(3), uso(4)];

describe('os três modelos de comissão sobre assinatura', () => {
  it('por uso paga sobre o preço de tabela, e pode passar da mensalidade', () => {
    /**
     * É o comportamento anterior ao bloco 48 e o padrão do produto: desde o
     * bloco 45 o item pago pelo plano mantém o preço de tabela.
     *
     * Oito cortes num mês custam R$ 192 numa mensalidade de R$ 149. Não é caso
     * de laboratório: é o assinante que aprendeu que o plano compensa, e é
     * exatamente o que a SPEC pede que o dono veja **antes** de escolher.
     */
    expect(soma(aplicarModeloDaAssinatura(quatroCortes, { modo: 'por_uso', tetoBps: 6000 })))
      .toBe(9600);

    const oito = Array.from({ length: 8 }, (_, i) => uso(i + 1));
    expect(soma(aplicarModeloDaAssinatura(oito, { modo: 'por_uso', tetoBps: 6000 })))
      .toBeGreaterThan(MENSALIDADE);
  });

  it('rateio não cresce com o uso: cortar doze vezes custa o mesmo que cortar quatro', () => {
    /**
     * É a propriedade que dá nome ao modelo — a casa nunca paga mais do que
     * recebeu, quantas vezes o assinante venha.
     *
     * O total é 40% de R$ 149 **a menos do arredondamento**, e a diferença é
     * decisão de projeto, não descuido: a comissão é arredondada **por
     * lançamento** em todo o produto, porque cada lançamento pode ter regra
     * própria — Ruan a 40% e Bruno a 50% na mesma mensalidade. Distribuir um
     * total já arredondado exigiria uma segunda maneira de calcular comissão, e
     * duas fontes de verdade para o mesmo número é o defeito que a SPEC §3.5
     * proíbe em letras para o split.
     *
     * O que a divisão garante exatamente é a **base**: ela soma a mensalidade
     * ao centavo, e é isso que o teste seguinte prende. A sobra fica com a casa,
     * nunca contra ela.
     */
    const teto = 5960;
    const quatro = soma(aplicarModeloDaAssinatura(quatroCortes, { modo: 'rateio', tetoBps: 6000 }));
    expect(quatro).toBe(teto);

    const doze = Array.from({ length: 12 }, (_, i) => uso(i + 1));
    const comDoze = soma(aplicarModeloDaAssinatura(doze, { modo: 'rateio', tetoBps: 6000 }));
    expect(comDoze).toBeLessThanOrEqual(teto);
    expect(teto - comDoze).toBeLessThan(doze.length);
  });

  it('o rateio soma exatamente a mensalidade, com a sobra da divisão no fim', () => {
    /**
     * R$ 149 dividido por três dá 4966,66… — e a soma de três arredondamentos
     * daria 14 899 ou 14 901. A conta do mês não fecharia com o extrato de
     * ninguém por um centavo, que é o tipo de erro que ninguém consegue
     * explicar no balcão.
     */
    const tres = [uso(1), uso(2), uso(3)];
    const aplicados = aplicarModeloDaAssinatura(tres, { modo: 'rateio', tetoBps: 6000 });
    expect(aplicados.reduce((s, l) => s + l.baseCents, 0)).toBe(MENSALIDADE);
  });

  it('rateio divide entre quem atendeu, na proporção dos atendimentos', () => {
    // Ruan atendeu três vezes, Bruno uma: Ruan leva três quartos da mensalidade.
    const mistos = [uso(1), uso(2), uso(3), uso(4, { professionalId: BRUNO })];
    const aplicados = aplicarModeloDaAssinatura(mistos, { modo: 'rateio', tetoBps: 6000 });
    const porProfissional = comissaoDoPeriodo(aplicados);

    const ruan = porProfissional.find((c) => c.professionalId === RUAN);
    const bruno = porProfissional.find((c) => c.professionalId === BRUNO);
    expect(ruan?.baseCents).toBe(11_175);
    expect(bruno?.baseCents).toBe(3725);
  });

  it('híbrido paga por uso enquanto couber no teto', () => {
    // Dois cortes rendem R$ 48, abaixo do teto de R$ 89,40: nada muda.
    const dois = [uso(1), uso(2)];
    expect(soma(aplicarModeloDaAssinatura(dois, { modo: 'hibrido', tetoBps: 6000 })))
      .toBe(4800);
  });

  it('híbrido corta no teto quando o assinante usa muito', () => {
    // Quatro cortes renderiam R$ 96; o teto de 60% de R$ 149 é R$ 89,40.
    const total = soma(aplicarModeloDaAssinatura(quatroCortes, { modo: 'hibrido', tetoBps: 6000 }));
    expect(total).toBeLessThanOrEqual(8940);
    expect(total).toBeGreaterThan(8900);
  });

  it('o teto encolhe todo mundo na mesma proporção, não zera o último', () => {
    /**
     * Com o corte no último, o barbeiro que atendeu no dia 28 receberia zero por
     * um limite que os colegas gastaram — e a conta dele dependeria da ordem em
     * que os outros trabalharam.
     */
    const mistos = [uso(1), uso(2), uso(3), uso(4, { professionalId: BRUNO })];
    const porProfissional = comissaoDoPeriodo(
      aplicarModeloDaAssinatura(mistos, { modo: 'hibrido', tetoBps: 6000 }),
    );
    expect(porProfissional.find((c) => c.professionalId === BRUNO)?.comissaoCents)
      .toBeGreaterThan(0);
  });

  it('lançamento que não é de assinatura passa intacto em qualquer modelo', () => {
    /**
     * O produto vendido no balcão e o corte de quem não assina não podem ser
     * tocados pelo modelo do clube. Sem isto, ligar o rateio mudaria a comissão
     * da casa inteira.
     */
    const avulso: LancamentoNoPeriodo = {
      itemId: 'i-avulso', professionalId: RUAN, regraId: 'r-corte', modo: 'percent',
      valor: 4000, faixas: [], baseCents: 6000, sinal: 1,
    };
    for (const modo of ['por_uso', 'rateio', 'hibrido'] as const) {
      const aplicados = aplicarModeloDaAssinatura([avulso, ...quatroCortes], { modo, tetoBps: 6000 });
      expect(aplicados.find((l) => l.itemId === 'i-avulso')?.baseCents).toBe(6000);
    }
  });

  it('estorno mantém a base original e não conta como atendimento no rateio', () => {
    /**
     * Um corte desfeito não dá direito a fatia da mensalidade — contá-lo
     * diluiria a fatia de quem atendeu de verdade. E a base do estorno é a do
     * lançamento que ele anula: recalcular faria a devolução não bater com o
     * que foi lançado.
     */
    const comEstorno = [uso(1), uso(2), uso(3, { sinal: -1 as const })];
    const aplicados = aplicarModeloDaAssinatura(comEstorno, { modo: 'rateio', tetoBps: 6000 });

    const estorno = aplicados.find((l) => l.sinal === -1);
    expect(estorno?.baseCents).toBe(6000);

    const positivos = aplicados.filter((l) => l.sinal === 1);
    expect(positivos.reduce((s, l) => s + l.baseCents, 0)).toBe(MENSALIDADE);
  });

  it('duas assinaturas não misturam mensalidade', () => {
    const outra = uso(9, { assinaturaId: 's-2', mensalidadeCents: 8900 });
    const aplicados = aplicarModeloDaAssinatura([uso(1), uso(2), outra], {
      modo: 'rateio', tetoBps: 6000,
    });
    expect(aplicados.find((l) => l.itemId === 'i-9')?.baseCents).toBe(8900);
  });
});

describe('a simulação dos três modelos', () => {
  it('mostra os três lado a lado sobre os mesmos dados', () => {
    const simulacao = simularModelosDaAssinatura({
      lancamentos: quatroCortes, tetoBps: 6000, emUso: 'por_uso',
    });

    expect(simulacao.receitaCents).toBe(MENSALIDADE);
    expect(simulacao.atendimentos).toBe(4);
    expect(simulacao.modelos.map((m) => m.comissaoCents)).toEqual([9600, 5960, 8940]);
  });

  it('a receita conta a mensalidade de quem foi atendido, não o MRR inteiro', () => {
    /**
     * Somar quem não veio inflaria a sobra e faria o modelo por uso parecer
     * barato. O assinante que não aparece é lucro e já está no MRR do painel;
     * aqui a pergunta é quanto custa entregar o que foi usado.
     */
    const duasAssinaturas = [uso(1), uso(2, { assinaturaId: 's-2', mensalidadeCents: 8900 })];
    const simulacao = simularModelosDaAssinatura({
      lancamentos: duasAssinaturas, tetoBps: 6000, emUso: 'por_uso',
    });
    expect(simulacao.receitaCents).toBe(MENSALIDADE + 8900);
  });

  it('a frase diz quanto o modelo em uso custou a mais', () => {
    const simulacao = simularModelosDaAssinatura({
      lancamentos: quatroCortes, tetoBps: 6000, emUso: 'por_uso',
    });
    // R$ 96 − R$ 59,60 = R$ 36,40.
    expect(fraseDaSimulacao(simulacao)).toContain('36,40');
  });

  it('sem atendimento pago por plano, a frase não inventa comparação', () => {
    const simulacao = simularModelosDaAssinatura({
      lancamentos: [], tetoBps: 6000, emUso: 'por_uso',
    });
    expect(simulacao.receitaCents).toBe(0);
    expect(fraseDaSimulacao(simulacao)).toContain('não há o que comparar');
  });

  it('quando o modelo em uso já é o mais barato, a frase diz isso', () => {
    const simulacao = simularModelosDaAssinatura({
      lancamentos: quatroCortes, tetoBps: 6000, emUso: 'rateio',
    });
    expect(fraseDaSimulacao(simulacao)).toContain('menos custou');
  });
});

describe('a rentabilidade de um assinante', () => {
  it('a margem desconta comissão e insumo da mensalidade', () => {
    const conta = rentabilidadeDoAssinante({
      assinaturaId: ASSINATURA,
      mensalidadeCents: MENSALIDADE,
      usos: [{ valorCents: 6000 }, { valorCents: 6000 }, { valorCents: 6000 }],
      comissaoCents: 5960,
      insumoCents: 900,
    });

    expect(conta.valorEntregueCents).toBe(18_000);
    expect(conta.margemCents).toBe(14_900 - 5960 - 900);
  });

  it('margem negativa é resultado possível, e é o que a tela existe para mostrar', () => {
    /**
     * *"Sem essa tela, o dono descobre que o clube dá prejuízo seis meses
     * depois."* Prejuízo aqui não é necessariamente erro — um plano que enche a
     * terça pode valer a pena. O que não pode é o dono não saber.
     */
    const conta = rentabilidadeDoAssinante({
      assinaturaId: ASSINATURA,
      mensalidadeCents: MENSALIDADE,
      usos: Array.from({ length: 8 }, () => ({ valorCents: 6000 })),
      comissaoCents: 19_200,
      insumoCents: 2400,
    });
    expect(conta.margemCents).toBeLessThan(0);
  });
});
