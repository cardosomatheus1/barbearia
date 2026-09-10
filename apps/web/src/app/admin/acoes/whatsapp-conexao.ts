'use server';
import { redirect } from 'next/navigation';
import { TIPOS_DE_NOTIFICACAO, type TipoDeNotificacao } from '@barbearia/core';
import { selecionarConexaoWhatsAppNaApi, operarBaileysNaApi, salvarTextoBaileysNaApi } from '@/lib/admin-api/whatsapp-conexao';
import { exigirSessao, texto } from './comum';

export async function acaoSelecionarConexao(canal: 'meta' | 'baileys') {
  if (!['meta','baileys'].includes(canal)) return { ok: false as const, message: 'Escolha uma conexão.' };
  return selecionarConexaoWhatsAppNaApi(await exigirSessao(), canal);
}
export async function acaoOperarBaileys(acao: 'parear' | 'reconectar' | 'desconectar') {
  if (!['parear','reconectar','desconectar'].includes(acao)) return { ok: false as const, message: 'Ação inválida.' };
  return operarBaileysNaApi(await exigirSessao(), acao);
}
export async function acaoSalvarTextoBaileys(_anterior: { erro: string | null }, form: FormData): Promise<{ erro: string | null }> {
  const token = await exigirSessao(); const tipo = texto(form, 'tipo') as TipoDeNotificacao;
  if (!TIPOS_DE_NOTIFICACAO.includes(tipo) || tipo === 'senha_de_acesso') return { erro: 'Escolha a finalidade desta mensagem.' };
  const resultado = await salvarTextoBaileysNaApi(token, { tipo, titulo: texto(form, 'titulo'), corpo: texto(form, 'corpo'),
    habilitado: texto(form, 'habilitado') === '1' }, texto(form, 'id') || undefined);
  if (!resultado.ok) return { erro: resultado.message };
  redirect('/admin/whatsapp?feito=texto-local');
}
