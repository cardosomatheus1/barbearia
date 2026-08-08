import { describe, expect, it } from 'vitest';
import { horariosEmDestaque, horariosRestantes } from './vitrine.js';

const grade = (horas: readonly string[], quem = 'ruan') =>
  horas.map((start) => ({ start, professionalId: quem }));

describe('horários em destaque', () => {
  it('cobre o dia inteiro em vez de repetir a próxima hora', () => {
    // O defeito que existia: a grade sai ordenada, e os primeiros quatro de um
    // dia inteiro eram 09:00, 09:05, 09:10, 09:15 — quatro vezes "agora".
    const dia = grade(
      Array.from({ length: 60 }, (_, i) => {
        const minuto = 9 * 60 + i * 10;
        return `${String(Math.floor(minuto / 60)).padStart(2, '0')}:${String(minuto % 60).padStart(2, '0')}`;
      }),
    );

    // 60 vagas de 10 em 10 a partir das 09:00 acabam às 18:50, não às 19:00 —
    // a primeira versão desta expectativa contava 60 intervalos onde há 59.
    const destaque = horariosEmDestaque(dia, 4);
    expect(destaque.map((s) => s.start)).toEqual(['09:00', '12:20', '15:30', '18:50']);
  });

  it('prende as duas pontas', () => {
    // O primeiro horário responde "dá para ir agora?" e o último desenha o fim
    // do expediente. Nenhum dos dois pode cair da amostra.
    const dia = grade(['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00']);
    const destaque = horariosEmDestaque(dia, 3);
    expect(destaque[0]?.start).toBe('08:00');
    expect(destaque.at(-1)?.start).toBe('14:00');
  });

  it('mostra cada horário uma vez, mesmo com a equipe inteira livre', () => {
    // Dois barbeiros às 14:00 são uma opção para quem escolhe, não duas.
    const cheio = [
      { start: '14:00', professionalId: 'ruan' },
      { start: '14:00', professionalId: 'gleidson' },
      { start: '15:00', professionalId: 'ruan' },
      { start: '15:00', professionalId: 'gleidson' },
    ];
    expect(horariosEmDestaque(cheio, 10).map((s) => s.start)).toEqual(['14:00', '15:00']);
  });

  it('devolve tudo quando cabe', () => {
    const poucos = grade(['09:00', '09:30']);
    expect(horariosEmDestaque(poucos, 8)).toHaveLength(2);
  });

  it('aguenta grade vazia e pedido de zero', () => {
    expect(horariosEmDestaque([], 5)).toEqual([]);
    expect(horariosEmDestaque(grade(['09:00']), 0)).toEqual([]);
  });

  it('com um só cartão, mostra o primeiro horário livre', () => {
    // Não o do meio: a pergunta que um cartão só consegue responder é
    // "quando abre a próxima vaga".
    const dia = grade(['09:00', '10:00', '11:00']);
    expect(horariosEmDestaque(dia, 1).map((s) => s.start)).toEqual(['09:00']);
  });

  it('nunca repete um horário na amostra', () => {
    // Arredondamento do passo poderia cair duas vezes no mesmo índice.
    const dia = grade(['08:00', '08:30', '09:00', '09:30', '10:00']);
    for (const quantos of [2, 3, 4, 5]) {
      const destaque = horariosEmDestaque(dia, quantos);
      expect(new Set(destaque.map((s) => s.start)).size, `${quantos} cartões`).toBe(
        destaque.length,
      );
    }
  });
});

describe('quantos sobraram', () => {
  it('conta horários distintos, não vagas', () => {
    // "e mais 122" quando existem 40 horários com três barbeiros cada é número
    // inflado — e número inflado numa página de venda custa a confiança no
    // resto dela.
    const cheio = [
      ...grade(['09:00', '10:00', '11:00'], 'ruan'),
      ...grade(['09:00', '10:00', '11:00'], 'gleidson'),
    ];
    expect(horariosRestantes(cheio, 1)).toBe(2);
  });

  it('não fica negativo quando tudo coube na tela', () => {
    expect(horariosRestantes(grade(['09:00']), 8)).toBe(0);
  });
});
