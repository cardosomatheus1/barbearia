'use server';
import { LIMIAR_DO_GATILHO, type Gatilho } from '@barbearia/core';
import { revalidatePath } from 'next/cache';
import { abrirManualNaApi, concluirManualNaApi, configurarManualNaApi, estadoAutomacaoManualNaApi } from '@/lib/admin-api';
import { exigirSessao, texto } from './comum';
export async function acaoAbrirManual(id: string) { const r = await abrirManualNaApi(await exigirSessao(), id); if (r.ok) revalidatePath('/admin/whatsapp/manual'); return r; }
export async function acaoConcluirManual(id: string, acao: 'enviado' | 'liberar' | 'descartar' | 'optout' | 'assumir') {
  if (!['enviado','liberar','descartar','optout','assumir'].includes(acao)) return { ok: false as const, message: 'Ação inválida.' };
  const r = await concluirManualNaApi(await exigirSessao(), id, acao);
  if (r.ok) revalidatePath('/admin/whatsapp/manual'); return r;
}
export async function acaoEstadoAutomacaoManual(id: string, ativa: boolean) {
  const r = await estadoAutomacaoManualNaApi(await exigirSessao(), id, ativa);
  if (r.ok) revalidatePath('/admin/whatsapp/manual'); return r;
}
export async function acaoConfigurarManual(_anterior: { erro: string | null; sucesso: string | null }, f: FormData): Promise<{ erro: string | null; sucesso: string | null }> {
  const destino = texto(f, 'destino'); const token = await exigirSessao(); let dados: unknown;
  if (destino === 'textos') dados = { ...(texto(f, 'id') ? { id: texto(f, 'id') } : {}), titulo: texto(f, 'titulo'), corpo: texto(f, 'corpo'), habilitado: texto(f, 'habilitado') === 'on' };
  else if (destino === 'campanhas') dados = { requestId: texto(f, 'requestId'), nome: texto(f, 'nome'), templateId: texto(f, 'templateId'), filtro: texto(f, 'filtro'),
    valorDoFiltro: texto(f, 'filtro') === 'inativos' ? Number(texto(f, 'dias')) : texto(f, 'filtro') === 'celula_fria' ? Number(texto(f, 'hora')) : null, diaDaSemana: texto(f, 'filtro') === 'celula_fria' ? Number(texto(f, 'diaSemana')) : null, janelaDias: Number(texto(f, 'janela') || '7') };
  else if (destino === 'automacoes') dados = { requestId: texto(f, 'requestId'), nome: texto(f, 'nome'), templateId: texto(f, 'templateId'), gatilho: texto(f, 'gatilho'),
    limiar: LIMIAR_DO_GATILHO[texto(f, 'gatilho') as Gatilho] ? Number(texto(f, 'dias')) : null, atrasoMinutos: Number(texto(f, 'atraso') || '0'), tipo: 'retorno', publico: texto(f, 'publico') || null,
    objetivo: texto(f, 'objetivo') || 'agendamento', janelaDias: Number(texto(f, 'janela') || '7'), ativa: true };
  else return { erro: 'Escolha o que deseja criar.', sucesso: null };
  const r = await configurarManualNaApi(token, destino, dados);
  if (!r.ok) return { erro: r.message, sucesso: null };
  revalidatePath('/admin/whatsapp/manual');
  return { erro: null, sucesso: destino === 'campanhas' ? 'Campanha preparada. Abra a aba Fila para enviar uma mensagem por vez.' : destino === 'automacoes' ? 'Preparação ativada. A cada hora, os clientes elegíveis aparecem na Fila. Você envia cada mensagem.' : 'Mensagem salva. Ela já pode ser escolhida nas campanhas e lembretes manuais.' };
}
