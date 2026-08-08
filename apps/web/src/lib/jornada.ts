import { formatHHMM, parseHHMM } from '@barbearia/core';
import type { FaixaDaJornada } from './admin-api';

/**
 * A jornada da semana, do formulário para o domínio.
 *
 * Sete linhas de `<input type="time">` viram sete faixas em minutos locais. A
 * conversão é aqui, pura e testada, porque é o ponto onde um erro é invisível:
 * "18:00" virando 18 em vez de 1080 não quebra nada na hora — só faz o barbeiro
 * sumir da grade depois das 18h01 e ninguém liga uma coisa à outra.
 *
 * O minuto local é a moeda do motor (CLAUDE.md). Nada de `Date` aqui: o fuso é
 * o da unidade e entra lá no servidor, nunca no navegador de quem preenche.
 */

export const DIAS: readonly { readonly weekday: number; readonly nome: string; readonly curto: string }[] = [
  { weekday: 1, nome: 'Segunda', curto: 'seg' },
  { weekday: 2, nome: 'Terça', curto: 'ter' },
  { weekday: 3, nome: 'Quarta', curto: 'qua' },
  { weekday: 4, nome: 'Quinta', curto: 'qui' },
  { weekday: 5, nome: 'Sexta', curto: 'sex' },
  { weekday: 6, nome: 'Sábado', curto: 'sáb' },
  { weekday: 0, nome: 'Domingo', curto: 'dom' },
];

/** Minutos de "09:30", ou `null` se não der para ler. Nunca lança. */
export function minutosOuNulo(valor: string | null | undefined): number | null {
  if (!valor) return null;
  try {
    return parseHHMM(valor.trim());
  } catch {
    return null;
  }
}

export const paraHHMM = (minutos: number): string => formatHHMM(minutos);

export interface LinhaDoFormulario {
  readonly weekday: number;
  readonly trabalha: boolean;
  readonly inicio: string | null;
  readonly fim: string | null;
  readonly pausaInicio: string | null;
  readonly pausaFim: string | null;
}

export type FalhaDaJornada = 'horario_invalido' | 'fim_antes_do_inicio' | 'pausa_fora';

export type JornadaLida =
  | { readonly ok: true; readonly faixas: FaixaDaJornada[] }
  | { readonly ok: false; readonly code: FalhaDaJornada; readonly weekday: number };

/**
 * Lê a semana inteira.
 *
 * Dia desmarcado simplesmente não vira faixa — é assim que se fecha a
 * segunda-feira. Dia marcado sem horário é erro, não folga silenciosa: quem
 * marcou o dia quis trabalhar nele, e engolir isso deixaria o barbeiro fora da
 * grade sem aviso.
 *
 * A pausa só entra se as duas pontas forem lidas. Meia pausa é erro pelo mesmo
 * motivo — o formulário não pode adivinhar quando o almoço acaba.
 */
export function lerJornada(linhas: readonly LinhaDoFormulario[]): JornadaLida {
  const faixas: FaixaDaJornada[] = [];

  for (const linha of linhas) {
    if (!linha.trabalha) continue;

    const inicio = minutosOuNulo(linha.inicio);
    const fim = minutosOuNulo(linha.fim);
    if (inicio === null || fim === null) {
      return { ok: false, code: 'horario_invalido', weekday: linha.weekday };
    }
    if (inicio >= fim) {
      return { ok: false, code: 'fim_antes_do_inicio', weekday: linha.weekday };
    }

    const pausaInicio = minutosOuNulo(linha.pausaInicio);
    const pausaFim = minutosOuNulo(linha.pausaFim);
    const breaks: { start: number; end: number }[] = [];

    if (pausaInicio !== null || pausaFim !== null) {
      if (pausaInicio === null || pausaFim === null || pausaInicio >= pausaFim) {
        return { ok: false, code: 'horario_invalido', weekday: linha.weekday };
      }
      if (pausaInicio < inicio || pausaFim > fim) {
        return { ok: false, code: 'pausa_fora', weekday: linha.weekday };
      }
      breaks.push({ start: pausaInicio, end: pausaFim });
    }

    faixas.push({ weekday: linha.weekday, startMinute: inicio, endMinute: fim, breaks });
  }

  return { ok: true, faixas };
}

/**
 * O que preencher em cada linha, a partir do que já está gravado.
 *
 * A tela mostra a primeira faixa de cada dia. Jornada partida em dois turnos
 * com intervalo é representada como faixa única com pausa — que é como a
 * barbearia descreve ("das 9 às 18, almoço 12 às 13").
 */
export function linhasDaJornada(faixas: readonly FaixaDaJornada[]): readonly LinhaDoFormulario[] {
  return DIAS.map(({ weekday }) => {
    const faixa = faixas.find((f) => f.weekday === weekday);
    if (!faixa) {
      return {
        weekday,
        trabalha: false,
        inicio: null,
        fim: null,
        pausaInicio: null,
        pausaFim: null,
      };
    }
    const pausa = faixa.breaks[0];
    return {
      weekday,
      trabalha: true,
      inicio: paraHHMM(faixa.startMinute),
      fim: paraHHMM(faixa.endMinute),
      pausaInicio: pausa ? paraHHMM(pausa.start) : null,
      pausaFim: pausa ? paraHHMM(pausa.end) : null,
    };
  });
}
