/**
 * Geometria pura da agenda em linha do tempo (V10).
 *
 * A tela não deduz jornada pelo primeiro/último cliente: recebe a jornada efetiva
 * do domínio e apenas converte HH:mm em posições. Assim um buraco de duas horas
 * continua duas vezes maior que um de uma hora, mesmo sem nenhum agendamento ao
 * redor para “denunciar” onde a barbearia estava aberta.
 */

export interface FaixaTexto {
  readonly start: string;
  readonly end: string;
}

export interface EntradaVisual {
  readonly professionalId: string;
  readonly occupiedStart: string;
  readonly occupiedEnd: string;
}

export interface JornadaVisual {
  readonly professionalId: string;
  readonly working: readonly FaixaTexto[];
  readonly breaks: readonly FaixaTexto[];
}

export interface DiaVisual {
  readonly entries: readonly EntradaVisual[];
  readonly workingDays: readonly JornadaVisual[];
  readonly exceptions: readonly {
    readonly professionalId: string | null;
    readonly start: string | null;
    readonly end: string | null;
  }[];
}

export interface FaixaMinutos {
  readonly start: number;
  readonly end: number;
}

export interface LimitesDaLinha {
  readonly start: number;
  readonly end: number;
}

export const PIXELS_POR_MINUTO = 1.5;

export function minutos(hhmm: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!match) return 0;
  const hora = Number(match[1]);
  const minuto = Number(match[2]);
  return Math.max(0, Math.min(24 * 60, hora * 60 + minuto));
}

export function hhmm(total: number): string {
  const seguro = Math.max(0, Math.min(24 * 60, Math.round(total)));
  const hora = Math.floor(seguro / 60);
  const minuto = seguro % 60;
  return `${String(hora).padStart(2, '0')}:${String(minuto).padStart(2, '0')}`;
}

const faixa = (item: FaixaTexto): FaixaMinutos => ({ start: minutos(item.start), end: minutos(item.end) });

function normalizar(faixas: readonly FaixaMinutos[]): FaixaMinutos[] {
  const ordenadas = faixas
    .filter((item) => item.end > item.start)
    .map((item) => ({ ...item }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const saida: { start: number; end: number }[] = [];
  for (const atual of ordenadas) {
    const ultima = saida[saida.length - 1];
    if (!ultima || atual.start > ultima.end) saida.push(atual);
    else ultima.end = Math.max(ultima.end, atual.end);
  }
  return saida;
}

export function subtrair(
  base: readonly FaixaMinutos[],
  ocupadas: readonly FaixaMinutos[],
): FaixaMinutos[] {
  let resultado = normalizar(base);
  for (const ocupada of normalizar(ocupadas)) {
    const proxima: FaixaMinutos[] = [];
    for (const livre of resultado) {
      if (ocupada.end <= livre.start || ocupada.start >= livre.end) {
        proxima.push(livre);
        continue;
      }
      if (ocupada.start > livre.start) proxima.push({ start: livre.start, end: ocupada.start });
      if (ocupada.end < livre.end) proxima.push({ start: ocupada.end, end: livre.end });
    }
    resultado = proxima;
  }
  return resultado;
}

/** Limite único por dia para todas as colunas — sem isso 14h não alinha entre cadeiras. */
export function limitesDoDia(dia: DiaVisual): LimitesDaLinha | null {
  const pontos: number[] = [];
  for (const jornada of dia.workingDays) {
    for (const item of [...jornada.working, ...jornada.breaks]) {
      pontos.push(minutos(item.start), minutos(item.end));
    }
  }
  for (const entrada of dia.entries) {
    pontos.push(minutos(entrada.occupiedStart), minutos(entrada.occupiedEnd));
  }
  for (const excecao of dia.exceptions) {
    if (excecao.start && excecao.end) pontos.push(minutos(excecao.start), minutos(excecao.end));
  }
  if (pontos.length === 0) return null;

  const menor = Math.min(...pontos);
  const maior = Math.max(...pontos);
  const start = Math.max(0, Math.floor(menor / 30) * 30);
  let end = Math.min(24 * 60, Math.ceil(maior / 30) * 30);
  // Uma reserva isolada de 30 min sem jornada ainda precisa de contexto visual.
  if (end - start < 60) end = Math.min(24 * 60, start + 60);
  return { start, end };
}

/** Buracos reais dentro da jornada, descontando almoço e janela ocupada (buffer incluso). */
export function livresDoProfissional(
  dia: DiaVisual,
  professionalId: string,
): FaixaMinutos[] {
  const jornada = dia.workingDays.find((item) => item.professionalId === professionalId);
  if (!jornada) return [];
  const trabalho = jornada.working.map(faixa);
  const pausas = jornada.breaks.map(faixa);
  const ocupadas = dia.entries
    .filter((item) => item.professionalId === professionalId)
    .map((item) => ({ start: minutos(item.occupiedStart), end: minutos(item.occupiedEnd) }));
  return subtrair(trabalho, [...pausas, ...ocupadas]);
}

/**
 * Divide um buraco grande em pontos de entrada de meia hora.
 * O último pedaço pequeno é anexado ao anterior para evitar um alvo minúsculo.
 */
export function alvosLivres(faixas: readonly FaixaMinutos[], passo = 30): FaixaMinutos[] {
  const saida: FaixaMinutos[] = [];
  for (const livre of faixas) {
    let cursor = livre.start;
    const destaFaixa: FaixaMinutos[] = [];
    while (cursor < livre.end) {
      const fim = Math.min(livre.end, cursor + passo);
      destaFaixa.push({ start: cursor, end: fim });
      cursor = fim;
    }
    if (destaFaixa.length > 1) {
      const ultima = destaFaixa[destaFaixa.length - 1];
      const anterior = destaFaixa[destaFaixa.length - 2];
      if (ultima && anterior && ultima.end - ultima.start < 20) {
        destaFaixa[destaFaixa.length - 2] = { start: anterior.start, end: ultima.end };
        destaFaixa.pop();
      }
    }
    saida.push(...destaFaixa);
  }
  return saida;
}

export function marcacoesDoEixo(limites: LimitesDaLinha, passo = 60): number[] {
  const primeira = Math.ceil(limites.start / passo) * passo;
  const saida: number[] = [];
  for (let atual = primeira; atual <= limites.end; atual += passo) saida.push(atual);
  return saida;
}

export function topPx(minuto: number, limites: LimitesDaLinha): number {
  return Math.max(0, minuto - limites.start) * PIXELS_POR_MINUTO;
}

export function alturaPx(start: number, end: number): number {
  return Math.max(1, end - start) * PIXELS_POR_MINUTO;
}
