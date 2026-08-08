import { describe, expect, it } from 'vitest';
import {
  fraseDaMeta,
  progressoDaMeta,
  taxaDeRetorno,
  ticketMedio,
  variacao,
} from './desempenho.js';

/**
 * Os números do barbeiro.
 *
 * O que estes testes protegem: que um número sem referência não chegue à tela.
 * Meta que só cobra no dia 30 é meta que ninguém usa, e indicador que devolve
 * `NaN` no primeiro dia é indicador que o barbeiro aprende a ignorar.
 */

const reais = (cents: number): string =>
  `R$ ${(cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

describe('ticket médio', () => {
  it('divide o faturamento pelos atendimentos', () => {
    expect(ticketMedio({ faturamentoCents: 60000, atendimentos: 10, saiuComHorario: 0 })).toBe(6000);
  });

  it('primeiro dia do mês devolve zero, não NaN', () => {
    // É o barbeiro novo abrindo a tela. `NaN` vira "R$ NaN" na cara dele.
    expect(ticketMedio({ faturamentoCents: 0, atendimentos: 0, saiuComHorario: 0 })).toBe(0);
  });

  it('arredonda para o centavo', () => {
    expect(ticketMedio({ faturamentoCents: 10000, atendimentos: 3, saiuComHorario: 0 })).toBe(3333);
  });
});

describe('taxa de retorno', () => {
  it('conta quantos saíram com o próximo horário marcado', () => {
    /**
     * A SPEC §4.21 chama de a métrica mais preditiva de retenção em barbearia,
     * e observa que quase ninguém mede.
     */
    expect(taxaDeRetorno({ faturamentoCents: 0, atendimentos: 8, saiuComHorario: 6 })).toBe(75);
  });

  it('sem atendimento não há taxa, e o número é zero', () => {
    expect(taxaDeRetorno({ faturamentoCents: 0, atendimentos: 0, saiuComHorario: 0 })).toBe(0);
  });

  it('em pontos inteiros, não fração', () => {
    // Ninguém decide nada com a terceira casa decimal.
    expect(taxaDeRetorno({ faturamentoCents: 0, atendimentos: 3, saiuComHorario: 1 })).toBe(33);
  });
});

describe('progresso da meta', () => {
  const meta = (realizadoCents: number, diaDoMes: number) =>
    progressoDaMeta({ metaCents: 1_500_000, realizadoCents, diaDoMes, diasNoMes: 30 });

  it('o esperado até hoje é proporcional ao dia do mês', () => {
    // É este número que transforma meta em orientação: sem ele o barbeiro
    // descobre no dia 30 que estava atrás desde o dia 8.
    expect(meta(0, 10).esperadoAteHojeCents).toBe(500_000);
    expect(meta(0, 30).esperadoAteHojeCents).toBe(1_500_000);
  });

  it('quem está adiantado está no ritmo', () => {
    expect(meta(600_000, 10).noRitmo).toBe(true);
    expect(meta(400_000, 10).noRitmo).toBe(false);
  });

  it('quem está exatamente no esperado está no ritmo', () => {
    // A fronteira decide o tom da frase; deixá-la para "atrás" cobraria de quem
    // está fazendo tudo certo.
    expect(meta(500_000, 10).noRitmo).toBe(true);
  });

  it('o que falta por dia usa os dias que sobram, não os do mês', () => {
    const atrasado = meta(500_000, 20); // faltam 1.000.000 em 10 dias
    expect(atrasado.porDiaRestanteCents).toBe(100_000);
  });

  it('no último dia não divide por zero', () => {
    /**
     * "Faltam ∞ por dia" não é uma frase. No dia 30 o que falta é tudo o que
     * falta.
     */
    const ultimo = meta(1_000_000, 30);
    expect(Number.isFinite(ultimo.porDiaRestanteCents)).toBe(true);
    expect(ultimo.porDiaRestanteCents).toBe(500_000);
  });

  it('bater a meta zera o que falta e passa de 100%', () => {
    const batida = meta(1_800_000, 25);
    expect(batida.faltamCents).toBe(0);
    expect(batida.percentual).toBe(120);
    expect(batida.porDiaRestanteCents).toBe(0);
  });

  it('sem meta, o percentual é zero e não infinito', () => {
    const sem = progressoDaMeta({
      metaCents: 0,
      realizadoCents: 300_000,
      diaDoMes: 10,
      diasNoMes: 30,
    });
    expect(sem.percentual).toBe(0);
    expect(Number.isFinite(sem.percentual)).toBe(true);
  });

  it('dia fora do mês é trazido para dentro', () => {
    // Fuso, virada de mês e relógio torto: o dia 31 de um mês de 30 não pode
    // produzir um esperado maior que a meta.
    const forcado = progressoDaMeta({
      metaCents: 1_000_000,
      realizadoCents: 0,
      diaDoMes: 45,
      diasNoMes: 30,
    });
    expect(forcado.esperadoAteHojeCents).toBe(1_000_000);
  });
});

describe('a frase da meta', () => {
  const doDia = (realizadoCents: number, diaDoMes: number) =>
    fraseDaMeta(
      progressoDaMeta({ metaCents: 1_500_000, realizadoCents, diaDoMes, diasNoMes: 30 }),
      reais,
    );

  it('quem bateu não é cobrado', () => {
    // Cobrar quem já bateu é o jeito mais rápido de fazer alguém parar de olhar
    // a tela.
    expect(doDia(1_600_000, 20)).toContain('batida');
    expect(doDia(1_600_000, 20)).not.toContain('por dia');
  });

  it('quem está no ritmo ouve quanto falta, não uma cobrança', () => {
    expect(doDia(600_000, 10)).toContain('No ritmo');
  });

  it('quem está atrás ouve o número que resolve', () => {
    // "Você está atrás" não ajuda ninguém; "R$ 550,00 por dia" ajuda.
    const atras = doDia(400_000, 10);
    expect(atras).toContain('por dia');
    expect(atras).toContain('R$');
  });

  it('sem meta a tela diz que não há meta, em vez de mostrar 0%', () => {
    const sem = fraseDaMeta(
      progressoDaMeta({ metaCents: 0, realizadoCents: 0, diaDoMes: 1, diasNoMes: 30 }),
      reais,
    );
    expect(sem).toContain('Sem meta');
  });
});

describe('variação contra o próprio passado', () => {
  it('compara com o mês anterior', () => {
    expect(variacao(120_000, 100_000)).toBe(20);
    expect(variacao(80_000, 100_000)).toBe(-20);
  });

  it('primeiro mês não é queda de 100%', () => {
    /**
     * Sem mês anterior não há comparação. Devolver zero, ou -100, contaria uma
     * história que não aconteceu para quem acabou de ser contratado.
     */
    expect(variacao(50_000, 0)).toBeNull();
  });
});
