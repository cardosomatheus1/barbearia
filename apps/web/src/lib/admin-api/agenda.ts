import type {
  AlertaDeEstoque,
  BaseDeComissao,
  Conversa,
  DesfechoDaRecuperacao,
  DirecaoDaConta,
  EstadoDaAssinatura,
  EstadoDaNota,
  EstadoDeCampanha,
  EstadoDoRecado,
  FormaDePagamento,
  ModoDeComissao,
  ModoDeFidelidade,
  MotivoDaContestacao,
  Papel,
  RegimeFiscal,
  ServiceTemplate,
  TipoDeCadeira,
  TipoDeExcecao,
  TipoDeMovimentoDeEstoque,
  TipoDeProduto,
  TipoDeRecado,
  TratamentoDaTaxa,
  TratamentoDoDesconto,
} from '@barbearia/core';

import { BASE, chamar, type Resposta } from './core';
import type { StatusAtendimento } from './operacao';

// -- Agenda do admin -----------------------------------------------------------

export type { TipoDeExcecao };

export interface EntradaDaAgenda {
  id: string;
  professionalId: string;
  status: StatusAtendimento;
  start: string;
  end: string;
  /** Janela com buffer: é ela que explica o horário seguinte não estar livre. */
  occupiedStart: string;
  occupiedEnd: string;
  customerName: string | null;
  services: string[];
  priceCents: number;
}

export interface ExcecaoDaAgenda {
  id: string;
  kind: TipoDeExcecao;
  professionalId: string | null;
  start: string | null;
  end: string | null;
  reason: string | null;
}

export interface JornadaDaAgenda {
  professionalId: string;
  working: { start: string; end: string }[];
  breaks: { start: string; end: string }[];
  closedBy: 'custom_hours' | 'day_off' | 'holiday' | 'vacation' | 'no_weekly_plan' | null;
}

export interface DiaDaAgenda {
  date: string;
  weekday: number;
  entries: EntradaDaAgenda[];
  exceptions: ExcecaoDaAgenda[];
  workingDays: JornadaDaAgenda[];
}

export interface AgendaDoAdmin {
  timezone: string;
  from: string;
  to: string;
  today: string;
  professionals: { id: string; name: string }[];
  days: DiaDaAgenda[];
}

/** `from` ausente é "hoje na barbearia" — resolvido pelo servidor, com o fuso da unidade. */
export const agendaDoAdmin = (
  token: string,
  filtros: { from?: string; to?: string; professionalId?: string } = {},
) => {
  const busca = new URLSearchParams();
  if (filtros.from) busca.set('from', filtros.from);
  if (filtros.to) busca.set('to', filtros.to);
  if (filtros.professionalId) busca.set('professionalId', filtros.professionalId);
  return chamar<AgendaDoAdmin>('GET', `/v1/admin/agenda?${busca.toString()}`, undefined, token);
};

export interface ConflitoDaExcecao {
  appointmentId: string;
  start: string;
  customerName: string | null;
  professionalName: string;
}

export type ExcecaoGravada =
  | { saved: true; id: string; conflitos: ConflitoDaExcecao[] }
  | { saved: false; conflitos: ConflitoDaExcecao[] };

export interface NovaExcecao {
  kind: TipoDeExcecao;
  date: string;
  startMinute?: number | null;
  endMinute?: number | null;
  professionalId?: string;
  reason?: string;
  confirmarConflitos?: boolean;
}

/**
 * Duas rotas de propósito, não uma com `if`.
 *
 * Bloquear uma hora é operação de recepção (`appointments.create`); fechar a
 * barbearia no feriado muda o funcionamento e é do dono (`settings.manage`).
 * Uma rota só teria que exigir a permissão mais forte, e a recepcionista
 * passaria a chamar o dono para tirar uma hora do dia.
 */
export const criarBloqueio = (token: string, dados: NovaExcecao) =>
  chamar<ExcecaoGravada>('POST', '/v1/admin/agenda/blocks', dados, token);

export const criarExcecao = (token: string, dados: NovaExcecao) =>
  chamar<ExcecaoGravada>('POST', '/v1/admin/agenda/exceptions', dados, token);

export const removerExcecao = (token: string, id: string) =>
  chamar<{ deleted: boolean }>('DELETE', `/v1/admin/agenda/exceptions/${id}`, undefined, token);

export const moverAgendamento = (
  token: string,
  id: string,
  dados: { date: string; start: string; professionalId?: string },
) =>
  chamar<{ id: string; startsAt: string; professionalId: string }>(
    'POST',
    `/v1/admin/agenda/appointments/${id}/move`,
    dados,
    token,
  );

