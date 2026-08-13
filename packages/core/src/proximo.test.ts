import { describe, expect, it } from 'vitest';
import {
  DIAS_DO_PROXIMO_HORARIO,
  JANELA_DO_AGORA_MINUTOS,
  estaDisponivelAgora,
  passaNaDisponibilidade,
  proximoHorario,
  rotuloDoProximoHorario,
  type DiaComHorarios,
} from './proximo.js';

/** 20/08/2026 é uma quinta-feira. Salvador é UTC−3 o ano inteiro. */
const HOJE = '2026-08-20';
const AMANHA = '2026-08-21';
const AGORA = new Date('2026-08-20T17:00:00Z'); // 14:00 em Salvador

const slot = (data: string, hora: string) => ({
  start: hora,
  startsAt: `${data}T${String(Number(hora.slice(0, 2)) + 3).padStart(2, '0')}:${hora.slice(3)}:00Z`,
});

const dia = (data: string, horas: readonly string[]): DiaComHorarios => ({
  date: data,
  slots: horas.map((h) => slot(data, h)),
});

describe('o próximo horário do card', () => {
  it('é o primeiro livre, e a frase diz de que dia ele é', () => {
    const grade = [dia(HOJE, ['15:00', '16:00']), dia(AMANHA, ['09:00'])];
    const proximo = proximoHorario(grade, AGORA, HOJE);

    expect(proximo?.hora).toBe('15:00');
    expect(proximo?.hoje).toBe(true);
    expect(rotuloDoProximoHorario(proximo)).toBe('Hoje, 15:00');
  });

  it('cai para amanhã quando o dia já acabou', () => {
    // Quem busca às 21h não quer ler "sem horário": amanhã às 09:00 é a
    // informação, e é ela que faz a pessoa clicar.
    const grade = [dia(HOJE, []), dia(AMANHA, ['09:00', '09:30'])];
    const proximo = proximoHorario(grade, AGORA, HOJE);

    expect(proximo?.hoje).toBe(false);
    expect(rotuloDoProximoHorario(proximo)).toBe('Amanhã, 09:00');
  });

  it('descarta o horário que já passou, mesmo vindo do motor', () => {
    /**
     * A grade é calculada num instante e o card é montado noutro. Sem esta
     * guarda, o card anunciaria "Hoje, 09:00" às duas da tarde — e a pessoa
     * clicaria para descobrir na página que aquilo não existe.
     */
    const grade = [dia(HOJE, ['09:00', '15:00'])];
    expect(proximoHorario(grade, AGORA, HOJE)?.hora).toBe('15:00');
  });

  it('sem horário nenhum, a frase é a ausência — não um espaço em branco', () => {
    expect(proximoHorario([dia(HOJE, []), dia(AMANHA, [])], AGORA, HOJE)).toBeNull();
    expect(rotuloDoProximoHorario(null)).toBe('Sem horário hoje nem amanhã');
  });

  it('a janela é de dois dias, e a frase depende disso', () => {
    // "Amanhã" é literal: com três dias, o terceiro sairia rotulado de amanhã e
    // nada ficaria vermelho. A constante é o contrato entre os dois.
    expect(DIAS_DO_PROXIMO_HORARIO).toBe(2);
  });
});

describe('disponível agora', () => {
  it('é sobre a próxima hora e meia, não sobre o dia', () => {
    const daqui = (minutos: number) =>
      proximoHorario(
        [
          {
            date: HOJE,
            slots: [
              {
                start: '14:30',
                startsAt: new Date(AGORA.getTime() + minutos * 60_000).toISOString(),
              },
            ],
          },
        ],
        AGORA,
        HOJE,
      );

    expect(estaDisponivelAgora(daqui(30), AGORA)).toBe(true);
    expect(estaDisponivelAgora(daqui(JANELA_DO_AGORA_MINUTOS), AGORA)).toBe(true);
    expect(estaDisponivelAgora(daqui(JANELA_DO_AGORA_MINUTOS + 1), AGORA)).toBe(false);
  });

  it('sem horário não é "agora"', () => {
    expect(estaDisponivelAgora(null, AGORA)).toBe(false);
  });
});

describe('o filtro de disponibilidade', () => {
  const hojeCedo = proximoHorario([dia(HOJE, ['15:00'])], AGORA, HOJE);
  const soAmanha = proximoHorario([dia(HOJE, []), dia(AMANHA, ['09:00'])], AGORA, HOJE);

  it('"qualquer" deixa passar até quem está lotado', () => {
    /**
     * A barbearia com a agenda cheia continua sendo resultado legítimo de uma
     * busca por barbearia. Escondê-la faria a lista encolher sem ninguém ter
     * pedido — e quem quer só quem tem vaga tem os outros dois filtros.
     */
    expect(passaNaDisponibilidade(null, 'qualquer', AGORA)).toBe(true);
  });

  it('"hoje" separa quem tem vaga hoje de quem só tem amanhã', () => {
    expect(passaNaDisponibilidade(hojeCedo, 'hoje', AGORA)).toBe(true);
    expect(passaNaDisponibilidade(soAmanha, 'hoje', AGORA)).toBe(false);
    expect(passaNaDisponibilidade(null, 'hoje', AGORA)).toBe(false);
  });

  it('"agora" é mais estreito que "hoje", e a distinção é o ponto dos dois filtros', () => {
    // 15:00 está a uma hora de 14:00: passa nos dois. Um horário às 18:00 passa
    // em "hoje" e não em "agora" — se os dois filtros dessem a mesma resposta,
    // um deles não precisaria existir.
    const tarde = proximoHorario([dia(HOJE, ['18:00'])], AGORA, HOJE);

    expect(passaNaDisponibilidade(hojeCedo, 'agora', AGORA)).toBe(true);
    expect(passaNaDisponibilidade(tarde, 'hoje', AGORA)).toBe(true);
    expect(passaNaDisponibilidade(tarde, 'agora', AGORA)).toBe(false);
  });
});
