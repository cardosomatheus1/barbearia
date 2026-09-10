import type { TipoDeNotificacao } from '@barbearia/core';
import type { CadastroDoWhatsAppNaTela } from './crescimento';
import { chamar } from './core';

export interface ConexaoWhatsAppNaTela {
  canal: 'meta' | 'baileys';
  meta: CadastroDoWhatsAppNaTela | null;
  baileys: { disponivel: boolean; estado: 'desconectado' | 'aguardando_qr' | 'conectando' | 'conectado' | 'reconectando' | 'novo_qr' | 'erro';
    numero: string | null; motivo: string | null; qr: string | null; qrExpiraEm: string | null };
}
const BASE = '/v1/admin/whatsapp/conexao';
export const conexaoWhatsAppNaApi = (token: string) => chamar<ConexaoWhatsAppNaTela>('GET', BASE, undefined, token);
export const selecionarConexaoWhatsAppNaApi = (token: string, canal: 'meta' | 'baileys') => chamar<{ ok: true }>('PUT', BASE, { canal }, token);
export const operarBaileysNaApi = (token: string, acao: 'parear' | 'reconectar' | 'desconectar') =>
  chamar<{ ok: true }>(acao === 'desconectar' ? 'DELETE' : 'POST', `${BASE}/baileys${acao === 'desconectar' ? '' : `/${acao}`}`, undefined, token);
export const salvarTextoBaileysNaApi = (token: string, texto: {
  titulo: string; tipo: TipoDeNotificacao; corpo: string; habilitado: boolean;
}, id?: string) => chamar<{ id: string }>(id ? 'PUT' : 'POST', `${BASE}/baileys/textos${id ? `/${encodeURIComponent(id)}` : ''}`, texto, token);
