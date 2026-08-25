import type { LinhaDoDia, PainelDoDia } from '@/lib/admin-api';

const CANCELADO = new Set<LinhaDoDia['status']>([
  'cancelled_customer',
  'cancelled_business',
  'rescheduled',
]);

const ESPERANDO = new Set<LinhaDoDia['status']>(['checked_in', 'waiting']);
const ENCERRADO = new Set<LinhaDoDia['status']>([
  'completed',
  'cancelled_customer',
  'cancelled_business',
  'no_show',
  'rescheduled',
]);

/**
 * O recorte que a recepção precisa antes de ler a linha do tempo inteira.
 *
 * É cálculo puro sobre o mesmo payload de `/day`: não abre uma segunda noção de
 * estado, não consulta banco por cartão e não muda autorização. A tela só deixa
 * de obrigar a pessoa a contar linhas para responder perguntas de balcão.
 */
export interface ResumoDoHoje {
  readonly marcados: number;
  readonly confirmados: number;
  readonly aguardandoConfirmacao: number;
  readonly esperando: number;
  readonly atendendo: number;
  readonly atrasados: number;
  readonly sinaisPendentes: number;
  readonly proximo: LinhaDoDia | null;
}

export function proximoDoBalcao(linhas: readonly LinhaDoDia[]): LinhaDoDia | null {
  // Quem já chegou ganha de quem ainda está a caminho: para o balcão, esta é a
  // pessoa que precisa de decisão agora, mesmo que o horário nominal seja mais
  // tarde que outro agendamento ainda não presente.
  const chegou = linhas.find((linha) => ESPERANDO.has(linha.status));
  if (chegou) return chegou;

  // Depois, a primeira reserva ainda aberta. `entries` já chega em ordem do
  // relógio pelo dayboard; repetir ordenação aqui abriria duas fontes da verdade.
  return linhas.find((linha) => !ENCERRADO.has(linha.status) && linha.status !== 'in_progress') ?? null;
}

export function resumoDoHoje(
  linhas: readonly LinhaDoDia[],
  totals: PainelDoDia['totals'],
): ResumoDoHoje {
  return {
    marcados: linhas.filter((linha) => !CANCELADO.has(linha.status)).length,
    confirmados: linhas.filter((linha) => linha.status === 'confirmed').length,
    aguardandoConfirmacao: linhas.filter((linha) => linha.status === 'pending').length,
    esperando: totals.chegaram,
    atendendo: totals.atendendo,
    atrasados: linhas.filter((linha) =>
      linha.punctuality?.kind === 'late' || linha.punctuality?.kind === 'no_show_due'
    ).length,
    sinaisPendentes: linhas.filter((linha) =>
      Boolean(linha.deposit && linha.deposit.exigidoCents > 0 && linha.deposit.pagoCents === 0)
    ).length,
    proximo: proximoDoBalcao(linhas),
  };
}

export function fraseDoProximo(linha: LinhaDoDia | null): string {
  if (!linha) return 'Nenhum próximo atendimento';
  if (ESPERANDO.has(linha.status)) {
    return linha.waitingMinutes && linha.waitingMinutes > 0
      ? `já chegou · esperando há ${linha.waitingMinutes} min`
      : 'já chegou';
  }

  const p = linha.punctuality;
  if (!p) return `às ${linha.start}`;
  if (p.kind === 'upcoming') return `em ${p.minutesUntil} min`;
  if (p.kind === 'due') return 'é agora';
  return `atrasado ${p.minutesLate} min`;
}

export function saudacaoDoBalcao(hora: string): 'Bom dia' | 'Boa tarde' | 'Boa noite' {
  const horas = Number(hora.split(':')[0] ?? 0);
  if (horas < 12) return 'Bom dia';
  if (horas < 18) return 'Boa tarde';
  return 'Boa noite';
}
