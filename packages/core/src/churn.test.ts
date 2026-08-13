import { describe, expect, it } from 'vitest';
import {
  DESCONTO_DE_ASSINANTE,
  faixaDeChurn,
  PESO_DO_ATRASO_NO_CICLO,
  riscoDeChurn,
  SINAIS_DE_CHURN,
  type SinaisDeChurn,
} from './churn.js';

/**
 * O churn score e a explicação (bloco 62, SPEC §4.5).
 *
 * O que estes testes protegem não é a aritmética: é a promessa de que o número e
 * a explicação saem da **mesma** conta. Um score que discordasse da lista de
 * motivos seria pior que score nenhum, porque tem cara de resposta.
 */

const semNada: SinaisDeChurn = {
  ritmo: { medianaDias: 21, folgaDias: 3 },
  diasSemVir: 5,
  ultimaNota: null,
  temAgendamentoFuturo: true,
  barbeiroHabitualSaiu: false,
  nomeDoBarbeiroHabitual: null,
  cancelouRecentemente: false,
  assinaturaVencida: false,
  assinaturaAtiva: false,
  ticketRecenteCents: null,
  ticketAnteriorCents: null,
};

describe('o risco de abandono', () => {
  it('quem está dentro do próprio ritmo não deve nada', () => {
    // Vinte e cinco dias com ciclo de vinte e um e folga de três: passou por
    // um dia. Dentro da folga, o produto não tem o que dizer.
    const dele = riscoDeChurn({ ...semNada, diasSemVir: 24 });
    expect(dele.risco).toBe(0);
    expect(dele.motivos).toEqual([]);
    expect(dele.temBase).toBe(true);
  });

  it('sem ritmo o risco é zero e o produto diz que não sabe', () => {
    /**
     * A diferença entre "risco zero" e "não dá para dizer" é a razão de
     * `temBase` existir. Quem veio uma vez pode estar indo embora ou pode voltar
     * semana que vem, e um número baixo afirmaria a segunda coisa — numa lista
     * ordenada por risco ele desce para o fim como se fosse boa notícia.
     */
    const dele = riscoDeChurn({ ...semNada, ritmo: null });
    expect(dele.temBase).toBe(false);
    expect(dele.risco).toBe(0);
  });

  it('no dobro do ciclo o atraso pesa o máximo', () => {
    // O dobro é onde o bloco 61 já chama de perdido: daí para a frente não há
    // mais o que somar por atraso.
    const dele = riscoDeChurn({ ...semNada, diasSemVir: 42, temAgendamentoFuturo: true });
    const atraso = dele.motivos.find((m) => m.sinal === 'atraso_no_ciclo');
    expect(atraso?.pontos).toBe(PESO_DO_ATRASO_NO_CICLO);

    // E não passa disso: cem dias não valem mais que o dobro.
    const sumido = riscoDeChurn({ ...semNada, diasSemVir: 100, temAgendamentoFuturo: true });
    expect(sumido.motivos.find((m) => m.sinal === 'atraso_no_ciclo')?.pontos).toBe(PESO_DO_ATRASO_NO_CICLO);
  });

  it('o número é a soma dos motivos, sempre', () => {
    /**
     * É a regra que este arquivo existe para garantir. Uma explicação escrita a
     * partir do score pronto seria texto plausível ao lado de um número, e no
     * primeiro caso em que discordassem o dono descobriria que não pode confiar
     * em nenhum dos dois.
     */
    const dele = riscoDeChurn({
      ...semNada,
      diasSemVir: 45,
      ultimaNota: 3,
      temAgendamentoFuturo: false,
      barbeiroHabitualSaiu: true,
      nomeDoBarbeiroHabitual: 'João',
    });
    const soma = dele.motivos.reduce((t, m) => t + m.pontos, 0);
    expect(dele.risco).toBe(Math.min(100, soma));
  });

  it('a explicação nomeia o barbeiro que saiu', () => {
    // "O profissional que sempre o atendia saiu" é verdade e não ajuda ninguém a
    // agir; com o nome, a recepção sabe com quem remarcar.
    const dele = riscoDeChurn({
      ...semNada,
      diasSemVir: 30,
      barbeiroHabitualSaiu: true,
      nomeDoBarbeiroHabitual: 'João',
    });
    expect(dele.motivos.find((m) => m.sinal === 'barbeiro_saiu')?.frase).toContain('João');
  });

  it('a explicação diz o ritmo e o atraso em dias, não uma fração', () => {
    // É a frase da SPEC: "normalmente retorna a cada 21 dias · está há 45 dias
    // sem retornar". O dono precisa poder repetir isso ao cliente.
    const dele = riscoDeChurn({ ...semNada, diasSemVir: 45 });
    const frase = dele.motivos.find((m) => m.sinal === 'atraso_no_ciclo')?.frase ?? '';
    expect(frase).toContain('21 dias');
    expect(frase).toContain('45 dias');
  });

  it('assinatura ativa desconta, e não zera', () => {
    /**
     * Assinante que sumiu é justamente quem cancela a mensalidade no fim do mês.
     * Sem o desconto ele apareceria no topo ao lado de quem não tem vínculo
     * nenhum; com o risco zerado, ele sumiria da lista — e é dele que a casa mais
     * precisa saber.
     */
    const solto = riscoDeChurn({ ...semNada, diasSemVir: 45, temAgendamentoFuturo: false });
    const assinante = riscoDeChurn({
      ...semNada,
      diasSemVir: 45,
      temAgendamentoFuturo: false,
      assinaturaAtiva: true,
    });
    expect(assinante.risco).toBe(solto.risco + DESCONTO_DE_ASSINANTE);
    expect(assinante.risco).toBeGreaterThan(0);
  });

  it('o motivo mais forte vem primeiro, e o desconto por último', () => {
    /**
     * Quem lê a explicação lê de cima para baixo e para quando entendeu.
     *
     * O atraso aqui é **pequeno** de propósito. Com o atraso no teto a ordem de
     * inserção já sai decrescente sozinha, e o teste passava com e sem a
     * ordenação — provava a aritmética e não a regra. Dois dias além da folga
     * valem seis pontos e entram antes da nota baixa, que vale quinze.
     */
    const dele = riscoDeChurn({
      ...semNada,
      diasSemVir: 26,
      temAgendamentoFuturo: false,
      barbeiroHabitualSaiu: true,
      nomeDoBarbeiroHabitual: 'João',
      assinaturaAtiva: true,
      ultimaNota: 2,
    });
    expect(dele.motivos[0]?.sinal).toBe('nota_baixa');
    const pontos = dele.motivos.map((m) => m.pontos);
    expect(pontos).toEqual([...pontos].sort((a, b) => b - a));
    expect(dele.motivos[dele.motivos.length - 1]?.sinal).toBe('assinatura_ativa');
  });

  it('queda de ticket pequena não é sinal', () => {
    /**
     * Um corte com barba num mês e um corte no outro mudam o ticket sem que nada
     * tenha acontecido. Um sinal que dispara com qualquer oscilação vira ruído em
     * toda a base, e a explicação passa a conter uma linha que não explica nada.
     */
    const pouco = riscoDeChurn({
      ...semNada,
      ticketAnteriorCents: 6000,
      ticketRecenteCents: 5400, // 10%
    });
    expect(pouco.motivos.find((m) => m.sinal === 'ticket_caindo')).toBeUndefined();

    const muito = riscoDeChurn({
      ...semNada,
      ticketAnteriorCents: 8000,
      ticketRecenteCents: 4000, // 50%
    });
    expect(muito.motivos.find((m) => m.sinal === 'ticket_caindo')?.frase).toContain('50%');
  });

  it('ticket anterior zero não vira infinito', () => {
    // Mesma decisão da divisão por zero nos relatórios do bloco 55: a resposta é
    // "não dá para dizer", nunca um número.
    const dele = riscoDeChurn({
      ...semNada,
      ticketAnteriorCents: 0,
      ticketRecenteCents: 5000,
    });
    expect(dele.motivos.find((m) => m.sinal === 'ticket_caindo')).toBeUndefined();
  });

  it('o risco não passa de cem nem cai abaixo de zero', () => {
    const tudo = riscoDeChurn({
      ...semNada,
      diasSemVir: 100,
      ultimaNota: 1,
      temAgendamentoFuturo: false,
      barbeiroHabitualSaiu: true,
      nomeDoBarbeiroHabitual: 'João',
      cancelouRecentemente: true,
      assinaturaVencida: true,
      ticketAnteriorCents: 10000,
      ticketRecenteCents: 2000,
    });
    expect(tudo.risco).toBe(100);

    // E o piso: só o desconto, sem nenhum sinal positivo.
    const so = riscoDeChurn({ ...semNada, assinaturaAtiva: true });
    expect(so.risco).toBe(0);
  });

  it('as três faixas cobrem a escala inteira, sem buraco', () => {
    // Uma faixa a mais obrigaria a explicar no balcão a diferença entre "médio"
    // e "médio-alto", e ninguém consegue.
    expect(faixaDeChurn(0)).toBe('baixo');
    expect(faixaDeChurn(29)).toBe('baixo');
    expect(faixaDeChurn(30)).toBe('medio');
    expect(faixaDeChurn(59)).toBe('medio');
    expect(faixaDeChurn(60)).toBe('alto');
    expect(faixaDeChurn(100)).toBe('alto');
  });

  it('todo sinal declarado sabe produzir um motivo', () => {
    /**
     * Termo de score constante é código morto com teste verde — foi o que
     * aconteceu com `assinante` no bloco 38, que entrou falso para todo mundo e
     * ficou sete blocos assim. Este teste liga cada sinal uma vez e cobra que
     * ele apareça.
     */
    const ligados = riscoDeChurn({
      ritmo: { medianaDias: 21, folgaDias: 3 },
      diasSemVir: 45,
      ultimaNota: 2,
      temAgendamentoFuturo: false,
      barbeiroHabitualSaiu: true,
      nomeDoBarbeiroHabitual: 'João',
      cancelouRecentemente: true,
      assinaturaVencida: true,
      assinaturaAtiva: true,
      ticketAnteriorCents: 8000,
      ticketRecenteCents: 4000,
    });
    expect(ligados.motivos.map((m) => m.sinal).sort()).toEqual([...SINAIS_DE_CHURN].sort());
  });
});
