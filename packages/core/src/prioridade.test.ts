import { describe, expect, it } from 'vitest';
import {
  MINUTOS_DE_JANELA_EXCLUSIVA,
  PESO_DA_ADERENCIA,
  PESO_DA_ASSINATURA,
  PESO_DA_CONFIABILIDADE,
  PESO_DA_ORDEM,
  PESO_DA_RECORRENCIA,
  VISITAS_PARA_RECORRENCIA_CHEIA,
  aderencia,
  fimDaJanelaExclusiva,
  ofertaAberta,
  ordenarPorPrioridade,
  type CandidatoNaFila,
} from './prioridade.js';

const AGORA = new Date('2026-09-07T12:00:00Z');

/** Um candidato mediano: pediu a manhã inteira, veio poucas vezes, score alto. */
const base = (extra: Partial<CandidatoNaFila> = {}): CandidatoNaFila => ({
  id: 'a',
  janelaPedida: { start: 8 * 60, end: 12 * 60 },
  visitas: 0,
  assinante: false,
  confiabilidade: 100,
  entrouEm: AGORA,
  ...extra,
});

const ordem = (candidatos: readonly CandidatoNaFila[], duracao = 30) =>
  ordenarPorPrioridade(candidatos, duracao).map((p) => p.id);

describe('os pesos são os da SPEC', () => {
  it('somam exatamente um', () => {
    // Se algum termo for reescalado sem os outros, a fórmula deixa de ser a do
    // contrato — e o score de ontem não compara mais com o de hoje.
    const soma =
      PESO_DA_ADERENCIA +
      PESO_DA_RECORRENCIA +
      PESO_DA_ASSINATURA +
      PESO_DA_CONFIABILIDADE +
      PESO_DA_ORDEM;
    expect(soma).toBeCloseTo(1, 10);
  });

  it('a aderência pesa mais que qualquer outro termo', () => {
    // É a decisão de produto da SPEC: o que mais importa é a vaga servir para a
    // pessoa. Antiguidade e fidelidade desempatam; elas não decidem.
    for (const outro of [
      PESO_DA_RECORRENCIA,
      PESO_DA_ASSINATURA,
      PESO_DA_CONFIABILIDADE,
      PESO_DA_ORDEM,
    ]) {
      expect(PESO_DA_ADERENCIA).toBeGreaterThan(outro);
    }
  });
});

describe('aderência', () => {
  it('quem pediu uma janela apertada acerta mais que quem pediu a manhã toda', () => {
    /**
     * Quem pediu "das 9h às 10h" pediu **aquilo**; quem pediu "das 8h ao
     * meio-dia" aceitaria qualquer coisa da manhã. Diante da mesma vaga das 9h,
     * a primeira é quem mais quer aquele horário.
     */
    const apertada = aderencia({ start: 9 * 60, end: 10 * 60 }, 30);
    const larga = aderencia({ start: 8 * 60, end: 12 * 60 }, 30);
    expect(apertada).toBeGreaterThan(larga);
  });

  it('janela do tamanho exato do serviço acerta em cheio', () => {
    expect(aderencia({ start: 9 * 60, end: 9 * 60 + 30 }, 30)).toBe(1);
  });

  it('nunca passa de um, mesmo com vaga maior que a janela', () => {
    // Não acontece — `vagaServe` filtra antes —, mas um valor acima de 1 aqui
    // faria a aderência sozinha superar a soma de todos os outros termos.
    expect(aderencia({ start: 9 * 60, end: 9 * 60 + 10 }, 30)).toBe(1);
  });

  it('janela vazia ou serviço de duração zero valem zero', () => {
    expect(aderencia({ start: 600, end: 600 }, 30)).toBe(0);
    expect(aderencia({ start: 8 * 60, end: 12 * 60 }, 0)).toBe(0);
  });
});

describe('a ordem da fila', () => {
  it('entre pedidos iguais, quem chegou primeiro vem primeiro', () => {
    const cedo = base({ id: 'cedo', entrouEm: new Date('2026-09-01T10:00:00Z') });
    const tarde = base({ id: 'tarde', entrouEm: new Date('2026-09-05T10:00:00Z') });
    expect(ordem([tarde, cedo])).toEqual(['cedo', 'tarde']);
  });

  it('quem pediu a janela certa passa na frente de quem chegou antes', () => {
    /**
     * É o desenho da SPEC, e vale escrever por que: a fila por ordem de chegada
     * pura entrega a vaga das 9h a quem aceitava qualquer hora, e deixa sem
     * horário quem só pode às 9h. As duas pessoas ficam mal atendidas de uma
     * vez.
     */
    const antigoEVago = base({
      id: 'antigo',
      janelaPedida: { start: 8 * 60, end: 20 * 60 },
      entrouEm: new Date('2026-09-01T10:00:00Z'),
    });
    const novoEPreciso = base({
      id: 'novo',
      janelaPedida: { start: 9 * 60, end: 9 * 60 + 30 },
      entrouEm: new Date('2026-09-06T10:00:00Z'),
    });
    expect(ordem([antigoEVago, novoEPreciso])).toEqual(['novo', 'antigo']);
  });

  it('o cliente da casa passa na frente de quem nunca veio, tudo mais igual', () => {
    const daCasa = base({ id: 'daCasa', visitas: VISITAS_PARA_RECORRENCIA_CHEIA });
    const novo = base({ id: 'novo', visitas: 0 });
    expect(ordem([novo, daCasa])).toEqual(['daCasa', 'novo']);
  });

  it('acima do teto, mais visitas não compram mais posição', () => {
    // Senão a fila vira ranking de antiguidade, e quem vem há dez anos leva
    // toda vaga que abrir.
    const doze = ordenarPorPrioridade(
      [base({ id: 'doze', visitas: VISITAS_PARA_RECORRENCIA_CHEIA })],
      30,
    );
    const quarenta = ordenarPorPrioridade([base({ id: 'quarenta', visitas: 40 })], 30);
    expect(doze[0]?.score).toBeCloseTo(quarenta[0]?.score ?? -1, 10);
  });

  it('quem falta muito perde posição para quem não falta', () => {
    const bom = base({ id: 'bom', confiabilidade: 100 });
    const ruim = base({ id: 'ruim', confiabilidade: 0 });
    expect(ordem([ruim, bom])).toEqual(['bom', 'ruim']);
  });

  it('mas a confiabilidade sozinha não vence a aderência', () => {
    /**
     * O peso diz isso, e o teste prende: quem só pode às 9h e falta às vezes
     * continua na frente de quem aceita a semana inteira e nunca faltou. A vaga
     * é das 9h — dá-la a quem tem doze alternativas seria desperdiçar as duas
     * chances.
     */
    const preciso = base({
      id: 'preciso',
      janelaPedida: { start: 9 * 60, end: 9 * 60 + 30 },
      confiabilidade: 40,
    });
    const impecavel = base({
      id: 'impecavel',
      janelaPedida: { start: 8 * 60, end: 20 * 60 },
      confiabilidade: 100,
    });
    expect(ordem([impecavel, preciso])).toEqual(['preciso', 'impecavel']);
  });

  it('assinante ainda não muda nada, porque assinatura não existe', () => {
    /**
     * O termo vale zero para todo mundo até o bloco 45, e é de propósito:
     * constante para todos, ele não altera a ordem de ninguém, e no dia em que
     * a assinatura existir passa a valer o que a SPEC diz sem retocar os outros
     * pesos.
     *
     * Este teste é o que prova que o termo **está ligado** e esperando dado —
     * não que ele foi esquecido. Quando o bloco 45 chegar, ele fica vermelho e
     * cobra a decisão.
     */
    const assinante = ordenarPorPrioridade([base({ id: 'a', assinante: true })], 30);
    const comum = ordenarPorPrioridade([base({ id: 'a', assinante: false })], 30);
    expect(assinante[0]?.parcelas.assinatura).toBe(1);
    expect(comum[0]?.parcelas.assinatura).toBe(0);
    // E a diferença é exatamente o peso da SPEC, esperando o dado.
    expect((assinante[0]?.score ?? 0) - (comum[0]?.score ?? 0)).toBeCloseTo(
      PESO_DA_ASSINATURA,
      10,
    );
  });

  it('a ordem é estável: o mesmo conjunto sai igual toda vez', () => {
    // Sem desempate final, dois candidatos idênticos sairiam em ordem
    // indefinida — e a mesma vaga seria oferecida a pessoas diferentes a cada
    // recarga da tela.
    const iguais = [
      base({ id: 'b', entrouEm: new Date('2026-09-02T10:00:00Z') }),
      base({ id: 'a', entrouEm: new Date('2026-09-01T10:00:00Z') }),
      base({ id: 'c', entrouEm: new Date('2026-09-03T10:00:00Z') }),
    ];
    expect(ordem(iguais)).toEqual(ordem([...iguais].reverse()));
  });

  it('lista vazia devolve lista vazia', () => {
    expect(ordenarPorPrioridade([], 30)).toEqual([]);
  });

  it('um candidato só fica em primeiro, sem divisão por zero', () => {
    const um = ordenarPorPrioridade([base({ id: 'unico' })], 30);
    expect(um).toHaveLength(1);
    expect(Number.isFinite(um[0]?.score)).toBe(true);
  });
});

describe('a janela exclusiva', () => {
  it('dura os dez minutos da SPEC', () => {
    const fim = fimDaJanelaExclusiva(AGORA);
    expect(fim.getTime() - AGORA.getTime()).toBe(MINUTOS_DE_JANELA_EXCLUSIVA * 60_000);
  });

  it('vence no minuto dez, não depois', () => {
    // Semiaberto, como todo intervalo deste produto. Um segundo de tolerância
    // seria um segundo em que duas pessoas podem marcar o mesmo horário.
    const venceEm = fimDaJanelaExclusiva(AGORA);
    const umPoucoAntes = new Date(venceEm.getTime() - 1);

    expect(ofertaAberta({ estado: 'aberta', venceEm }, umPoucoAntes)).toBe(true);
    expect(ofertaAberta({ estado: 'aberta', venceEm }, venceEm)).toBe(false);
  });

  it('oferta já respondida não vale mais, mesmo dentro do prazo', () => {
    const venceEm = fimDaJanelaExclusiva(AGORA);
    for (const estado of ['aceita', 'vencida', 'cancelada'] as const) {
      expect(ofertaAberta({ estado, venceEm }, AGORA)).toBe(false);
    }
  });
});
