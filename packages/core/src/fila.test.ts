import { describe, expect, it } from 'vitest';
import {
  custoDoEncaixe,
  duracaoEsperada,
  estimarFila,
  frasePosicao,
  type AtendenteNaFila,
} from './fila.js';

const atendente = (
  professionalId: string,
  livreEmMinutos: number,
  proximoMarcadoEmMinutos: number | null = null,
): AtendenteNaFila => ({ professionalId, livreEmMinutos, proximoMarcadoEmMinutos });

describe('fila presencial', () => {
  it('quem chega primeiro pega a cadeira que liberar primeiro', () => {
    const lugares = estimarFila({
      fila: [
        { id: 'a', professionalId: null, duracaoMinutos: 30 },
        { id: 'b', professionalId: null, duracaoMinutos: 30 },
      ],
      atendentes: [atendente('ruan', 10), atendente('gleidson', 0)],
    });

    expect(lugares[0]).toMatchObject({ id: 'a', professionalId: 'gleidson', esperaMinutos: 0 });
    expect(lugares[1]).toMatchObject({ id: 'b', professionalId: 'ruan', esperaMinutos: 10 });
  });

  it('a segunda pessoa da mesma cadeira espera a primeira terminar', () => {
    const lugares = estimarFila({
      fila: [
        { id: 'a', professionalId: 'ruan', duracaoMinutos: 30 },
        { id: 'b', professionalId: 'ruan', duracaoMinutos: 20 },
      ],
      atendentes: [atendente('ruan', 5)],
    });

    expect(lugares[0]?.esperaMinutos).toBe(5);
    // 5 de espera + 30 do corte de quem estava na frente.
    expect(lugares[1]?.esperaMinutos).toBe(35);
  });

  it('quem aceita qualquer um passa na frente de quem espera um barbeiro só', () => {
    // É o que acontece no salão, e é o que evita cadeira parada. Bloquear para
    // "respeitar a fila" deixaria Gleidson sem fazer nada enquanto Bruno corta.
    const lugares = estimarFila({
      fila: [
        { id: 'espera-ruan', professionalId: 'ruan', duracaoMinutos: 30 },
        { id: 'tanto-faz', professionalId: null, duracaoMinutos: 30 },
      ],
      atendentes: [atendente('ruan', 40), atendente('gleidson', 0)],
    });

    expect(lugares[0]).toMatchObject({ professionalId: 'ruan', esperaMinutos: 40 });
    expect(lugares[1]).toMatchObject({ professionalId: 'gleidson', esperaMinutos: 0 });
    // E a posição continua sendo a de chegada: quem esperou mais não vira o 2º.
    expect(lugares.map((l) => l.posicao)).toEqual([1, 2]);
  });

  it('preferir alguém que não está atendendo hoje não vira espera infinita', () => {
    const lugares = estimarFila({
      fila: [{ id: 'a', professionalId: 'de-folga', duracaoMinutos: 30 }],
      atendentes: [atendente('ruan', 0)],
    });

    expect(lugares[0]).toMatchObject({
      professionalId: null,
      esperaMinutos: null,
      atrasaMarcado: false,
    });
    const primeiro = lugares[0];
    expect(primeiro).toBeDefined();
    if (primeiro) expect(frasePosicao(primeiro)).toContain('recepção');
  });

  it('avisa quando o encaixe passa por cima de quem marcou', () => {
    const lugares = estimarFila({
      fila: [{ id: 'a', professionalId: 'ruan', duracaoMinutos: 30 }],
      // Livre agora, mas com cliente marcado daqui a 20 minutos.
      atendentes: [atendente('ruan', 0, 20)],
    });

    expect(lugares[0]?.atrasaMarcado).toBe(true);
  });

  it('não avisa quando o atendimento termina exatamente na hora do marcado', () => {
    // Intervalo semiaberto: encostar não é sobrepor (CLAUDE.md).
    const lugares = estimarFila({
      fila: [{ id: 'a', professionalId: 'ruan', duracaoMinutos: 20 }],
      atendentes: [atendente('ruan', 0, 20)],
    });

    expect(lugares[0]?.atrasaMarcado).toBe(false);
  });

  it('o segundo da fila herda o atraso que o primeiro criou', () => {
    const lugares = estimarFila({
      fila: [
        { id: 'a', professionalId: 'ruan', duracaoMinutos: 30 },
        { id: 'b', professionalId: 'ruan', duracaoMinutos: 30 },
      ],
      atendentes: [atendente('ruan', 0, 45)],
    });

    // O primeiro cabe (30 < 45); o segundo termina em 60 e não cabe.
    expect(lugares[0]?.atrasaMarcado).toBe(false);
    expect(lugares[1]?.atrasaMarcado).toBe(true);
  });

  it('fila vazia não inventa lugar', () => {
    expect(estimarFila({ fila: [], atendentes: [atendente('ruan', 0)] })).toEqual([]);
  });

  it('não muda a lista que recebeu', () => {
    const atendentes = [atendente('ruan', 0)];
    estimarFila({ fila: [{ id: 'a', professionalId: null, duracaoMinutos: 30 }], atendentes });
    expect(atendentes[0]?.livreEmMinutos).toBe(0);
  });
});

describe('custo do encaixe', () => {
  it('cadeira livre sem ninguém marcado depois sempre cabe', () => {
    const custos = custoDoEncaixe({
      atendentes: [atendente('ruan', 0, null)],
      duracaoMinutos: 60,
    });

    expect(custos[0]).toMatchObject({ cabe: true, sobraMinutos: null, invadeMinutos: 0 });
  });

  it('cadeira livre com pouco tempo até o próximo marcado não cabe, e diz quanto falta', () => {
    // É este número que a recepção não tinha: "livre" e "cabe" são coisas
    // diferentes, e é a diferença entre elas que atrasa o dia inteiro.
    const custos = custoDoEncaixe({
      atendentes: [atendente('ruan', 0, 15)],
      duracaoMinutos: 30,
    });

    expect(custos[0]).toMatchObject({ cabe: false, sobraMinutos: 0, invadeMinutos: 15 });
  });

  it('diz quanto sobra quando cabe, para a recepção saber se dá para o próximo também', () => {
    const custos = custoDoEncaixe({
      atendentes: [atendente('ruan', 0, 50)],
      duracaoMinutos: 30,
    });

    expect(custos[0]).toMatchObject({ cabe: true, sobraMinutos: 20, invadeMinutos: 0 });
  });

  it('conta a partir de quando a cadeira libera, não de agora', () => {
    const custos = custoDoEncaixe({
      atendentes: [atendente('ruan', 20, 40)],
      duracaoMinutos: 30,
    });

    // Começa em 20, termina em 50, e o marcado é 40.
    expect(custos[0]).toMatchObject({ cabe: false, invadeMinutos: 10 });
  });
});

describe('duração esperada', () => {
  it('sem histórico usa a cadastrada', () => {
    expect(
      duracaoEsperada({ cadastradaMinutos: 30, mediaRealMinutos: null, amostras: 0 }),
    ).toBe(30);
  });

  it('com poucas amostras ainda usa a cadastrada', () => {
    // Um atendimento medido não é média — e três dias atípicos virariam a
    // estimativa de todo mundo.
    expect(
      duracaoEsperada({ cadastradaMinutos: 30, mediaRealMinutos: 45, amostras: 3 }),
    ).toBe(30);
  });

  it('com histórico suficiente usa a duração real, que é o ponto', () => {
    expect(
      duracaoEsperada({ cadastradaMinutos: 30, mediaRealMinutos: 40, amostras: 12 }),
    ).toBe(40);
  });

  it('um "concluir" tocado três horas depois não joga a fila para três horas', () => {
    // `completed_at` é preenchido quando alguém toca o botão, e recepção
    // movimentada toca tarde. Sem teto, esse registro sozinho contaminaria a
    // estimativa de todo mundo na fila.
    expect(
      duracaoEsperada({ cadastradaMinutos: 30, mediaRealMinutos: 180, amostras: 20 }),
    ).toBe(60);
  });

  it('média absurdamente baixa também não passa', () => {
    expect(
      duracaoEsperada({ cadastradaMinutos: 30, mediaRealMinutos: 2, amostras: 20 }),
    ).toBe(15);
  });

  it('nunca devolve zero, que faria a fila inteira começar agora', () => {
    expect(
      duracaoEsperada({ cadastradaMinutos: 1, mediaRealMinutos: 0.2, amostras: 20 }),
    ).toBeGreaterThanOrEqual(1);
  });
});

describe('frase da posição', () => {
  it('o primeiro da fila ouve o que a SPEC pede', () => {
    expect(frasePosicao({ posicao: 1, esperaMinutos: 0 })).toBe('Você é o próximo.');
  });

  it('primeiro da fila com espera longa não recebe "você é o próximo"', () => {
    // Ele é o primeiro, mas o barbeiro ainda tem 40 minutos de corte pela
    // frente. Dizer "você é o próximo" aqui é a promessa que gera reclamação.
    expect(frasePosicao({ posicao: 1, esperaMinutos: 40 })).toContain('uma hora');
  });

  it('nunca promete minuto exato', () => {
    for (const minutos of [7, 12, 22, 45, 90]) {
      expect(frasePosicao({ posicao: 3, esperaMinutos: minutos })).not.toMatch(
        new RegExp(`\\b${minutos}\\b`),
      );
    }
  });
});
