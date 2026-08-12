import { describe, expect, it } from 'vitest';
import {
  CORTE_CHEIO_BPS,
  CORTE_FRIO_BPS,
  celulasFrias,
  ehHorarioDePico,
  faixaDaCelula,
  horasDaGrade,
  horasDePico,
  montarGrade,
  nomeDaCelula,
  ocupacaoDaCelula,
} from './ocupacao.js';

/**
 * O heatmap de ocupação (bloco 57, SPEC §5.9).
 *
 * O que estes testes prendem é o que a SPEC pede em uma frase — *"o heatmap não
 * é relatório, é ponto de partida de ação"* —: que a célula fria vire público, e
 * que a célula cheia seja o horário de pico que faltava ao sinal.
 */

const celula = (extra: Partial<Parameters<typeof faixaDaCelula>[0]> = {}) => ({
  diaDaSemana: 2,
  hora: 14,
  minutosVendidos: 0,
  minutosDeJornada: 0,
  ...extra,
});

describe('a ocupação de uma célula', () => {
  it('é a divisão de minutos vendidos por minutos de jornada', () => {
    expect(ocupacaoDaCelula(celula({ minutosVendidos: 30, minutosDeJornada: 60 }))).toBe(5000);
  });

  it('hora fechada devolve nulo, e não zero por cento', () => {
    /**
     * Zero diria "esta hora está vazia, faça algo" sobre uma hora em que a
     * barbearia não abre — e é a célula que mais apareceria em vermelho num
     * heatmap ingênuo.
     */
    expect(ocupacaoDaCelula(celula({ minutosDeJornada: 0 }))).toBeNull();
    expect(faixaDaCelula(celula({ minutosDeJornada: 0 }))).toBe('fechado');
  });

  it('os dois cortes separam frio, morno e cheio', () => {
    const com = (bps: number) =>
      faixaDaCelula(celula({ minutosVendidos: bps, minutosDeJornada: 10_000 }));
    expect(com(CORTE_FRIO_BPS - 1)).toBe('fria');
    expect(com(CORTE_FRIO_BPS)).toBe('morna');
    expect(com(CORTE_CHEIO_BPS - 1)).toBe('morna');
    expect(com(CORTE_CHEIO_BPS)).toBe('cheia');
  });

  it('a hora lotada é cheia', () => {
    expect(faixaDaCelula(celula({ minutosVendidos: 60, minutosDeJornada: 60 }))).toBe('cheia');
  });
});

describe('a grade', () => {
  it('tem os sete dias, mesmo os sem movimento', () => {
    /**
     * Uma tabela que pula as horas sem movimento faz a coluna de sábado ter
     * sete linhas e a de terça ter três, e a leitura vira comparação
     * impossível. O que a hora fechada mostra é "fechado", não um buraco.
     */
    const grade = montarGrade([celula({ minutosVendidos: 30, minutosDeJornada: 60 })], [14]);
    expect(grade).toHaveLength(7);
    expect(grade.filter((c) => c.faixa === 'fechado')).toHaveLength(6);
  });

  it('as horas saem do que a casa de fato abre', () => {
    const horas = horasDaGrade([
      celula({ hora: 9, minutosDeJornada: 60 }),
      celula({ hora: 12, minutosDeJornada: 60 }),
    ]);
    expect(horas).toEqual([9, 10, 11, 12]);
  });

  it('sem movimento nenhum, a grade ainda desenha a faixa comercial', () => {
    // A tela precisa mostrar alguma coisa no primeiro dia de uso.
    expect(horasDaGrade([]).length).toBeGreaterThan(0);
  });
});

describe('o horário de pico', () => {
  it('sai das células cheias, e não de uma caixa que o dono preenche', () => {
    /**
     * Era lacuna declarada desde o bloco 39. A saída não foi criar o parâmetro
     * — que seria mais um campo que ninguém preenche — foi derivá-lo do
     * movimento medido. O dono não adivinha, e a definição não é burlável.
     */
    const grade = montarGrade(
      [
        { diaDaSemana: 5, hora: 19, minutosVendidos: 60, minutosDeJornada: 60 },
        { diaDaSemana: 2, hora: 19, minutosVendidos: 10, minutosDeJornada: 60 },
      ],
      [19],
    );
    expect(horasDePico(grade)).toEqual([{ diaDaSemana: 5, hora: 19 }]);
  });

  it('o instante é comparado em dia e hora locais da unidade', () => {
    // Errar o fuso cobraria sinal de quem marcou às nove da manhã de terça
    // porque no servidor era meio-dia.
    const picos = [{ diaDaSemana: 5, hora: 19 }];
    expect(ehHorarioDePico({ picos, diaDaSemanaLocal: 5, horaLocal: 19 })).toBe(true);
    expect(ehHorarioDePico({ picos, diaDaSemanaLocal: 5, horaLocal: 18 })).toBe(false);
    expect(ehHorarioDePico({ picos, diaDaSemanaLocal: 2, horaLocal: 19 })).toBe(false);
  });

  it('sem pico nenhum, nada é pico', () => {
    expect(ehHorarioDePico({ picos: [], diaDaSemanaLocal: 5, horaLocal: 19 })).toBe(false);
  });
});

describe('as células frias', () => {
  it('vêm da mais vazia para a menos, que é a ordem de atacar', () => {
    const grade = montarGrade(
      [
        { diaDaSemana: 2, hora: 9, minutosVendidos: 6, minutosDeJornada: 60 },
        { diaDaSemana: 3, hora: 9, minutosVendidos: 18, minutosDeJornada: 60 },
        { diaDaSemana: 4, hora: 9, minutosVendidos: 60, minutosDeJornada: 60 },
      ],
      [9],
    );
    const frias = celulasFrias(grade);
    expect(frias[0]?.diaDaSemana).toBe(2);
    expect(frias.map((c) => c.diaDaSemana)).not.toContain(4);
  });

  it('hora fechada não entra: não há o que encher', () => {
    const grade = montarGrade([], [9]);
    expect(celulasFrias(grade)).toHaveLength(0);
  });
});

describe('o nome da célula', () => {
  it('é o mesmo na tela e na campanha', () => {
    // Duas telas que mostram a mesma célula com nomes diferentes fazem o dono
    // achar que são duas coisas.
    expect(nomeDaCelula({ diaDaSemana: 2, hora: 14 })).toBe('Terça, 14h');
    expect(nomeDaCelula({ diaDaSemana: 0, hora: 9 })).toBe('Domingo, 09h');
  });
});
