import { chamar } from './core';
export interface ItemManual { id: string; clienteId: string; fuso: string; cliente: string; origem: string; tipo: 'campanha' | 'automacao';
  minhaReserva: boolean; estado: 'pendente' | 'em_atendimento' | 'enviado' | 'descartado'; operadorId: string | null; operador: string | null;
  abertoEm: string | null; enviadoEm: string | null; enviadoPor: string | null; motivo: string | null; criadoEm: string; disponivel: boolean }
export interface TextoManual { id: string; titulo: string; corpo: string; habilitado: boolean }
export interface ConfiguracoesManuais { campanhas: readonly { id: string; nome: string; mensagem: string; total: number; enviados: number; descartados: number }[];
  automacoes: readonly { id: string; nome: string; mensagem: string; ativa: boolean; gatilho: string; limiar: number | null; enviados: number; alcancados: number }[] }
const BASE = '/v1/admin/whatsapp/manual';
export const filaManualNaApi = (token: string, antes?: string, visao: 'pendentes' | 'historico' = 'pendentes') => chamar<{ itens: readonly ItemManual[]; proximo: string | null }>('GET', BASE + `?visao=${visao}` + (antes ? `&antes=${encodeURIComponent(antes)}` : ''), undefined, token);
export const textosManuaisNaApi = (token: string) => chamar<{ textos: readonly TextoManual[] }>('GET', `${BASE}/textos`, undefined, token);
export const configuracoesManuaisNaApi = (token: string) => chamar<ConfiguracoesManuais>('GET', `${BASE}/configuracoes`, undefined, token);
export const abrirManualNaApi = (token: string, id: string) => chamar<{ url: string; telefone: string; texto: string }>('POST', `${BASE}/${encodeURIComponent(id)}/abrir`, {}, token);
export const concluirManualNaApi = (token: string, id: string, acao: 'enviado' | 'liberar' | 'descartar' | 'optout' | 'assumir') => chamar<{ ok: true }>('POST', `${BASE}/${encodeURIComponent(id)}/concluir`, { acao }, token);
export const configurarManualNaApi = (token: string, destino: 'textos' | 'campanhas' | 'automacoes', dados: unknown) => chamar<{ id: string }>('POST', `${BASE}/${destino}`, dados, token);
export const estadoAutomacaoManualNaApi = (token: string, id: string, ativa: boolean) => chamar<{ ok: true }>('POST', `${BASE}/automacoes/${encodeURIComponent(id)}/estado`, { ativa }, token);
