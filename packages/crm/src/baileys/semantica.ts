/** Regras conferidas na referência Raiz e no contrato Baileys 6.7.24. */
export type EstadoBaileys = 'desconectado' | 'aguardando_qr' | 'conectando' | 'conectado' | 'reconectando' | 'novo_qr' | 'erro';
export type EstadoEnvioBaileys = 'queued' | 'sending' | 'uncertain' | 'sent' | 'delivered' | 'read' | 'failed';

export function estadoDoAck(status: unknown): 'sent' | 'delivered' | 'read' | 'failed' | null {
  if (status === 0) return 'failed';
  if (status === 2) return 'sent';
  if (status === 3) return 'delivered';
  if (status === 4 || status === 5) return 'read';
  return null;
}

export function telefoneDoJid(jid: unknown): string | null {
  if (typeof jid !== 'string') return null;
  const match = /^([1-9][0-9]{7,14})(?::[0-9]+)?@(s\.whatsapp\.net|c\.us)$/.exec(jid);
  return match?.[1] ? `+${match[1]}` : null;
}

export function jidDePessoa(jid: unknown): boolean {
  return typeof jid === 'string' && /^\d+(?::\d+)?@(s\.whatsapp\.net|c\.us|lid)$/.test(jid);
}

export function motivoDeDesconexao(status: number | undefined): { terminal: boolean; codigo: string } {
  if (status === 401 || status === 500 || status === 411) return { terminal: true, codigo: 'pareamento_necessario' };
  if (status === 440) return { terminal: true, codigo: 'sessao_substituida' };
  if (status === 403) return { terminal: true, codigo: 'conta_indisponivel' };
  return { terminal: false, codigo: status === 515 ? 'reinicio_apos_pareamento' : 'conexao_interrompida' };
}

export function tempoDeReconexao(tentativa: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.min(Math.max(tentativa, 0), 6));
}

export function comandoDeTexto(texto: string): 'parar_de_receber' | 'confirmar' | 'cancelar' | null {
  const v = texto.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (['parar', 'sair', 'cancelar promocoes', 'nao quero receber promocoes'].includes(v)) return 'parar_de_receber';
  if (v === 'confirmar' || v === 'confirmo') return 'confirmar';
  if (v === 'cancelar') return 'cancelar';
  return null;
}
