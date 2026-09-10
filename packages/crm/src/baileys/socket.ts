import type { AuthenticationState } from '@whiskeysockets/baileys';
import pino from 'pino';
import { armazenamentoDeAuth, type PosseBaileys } from './sessao.js';

export interface ChaveMensagemBaileys {
  id?: string | null; remoteJid?: string | null; fromMe?: boolean | null;
  senderPn?: string | null; remoteJidAlt?: string | null;
}
export interface MensagemSocketBaileys {
  key: ChaveMensagemBaileys;
  messageTimestamp?: unknown;
  messageStubType?: number | null;
  message?: { conversation?: string | null;
    extendedTextMessage?: { text?: string | null; contextInfo?: { stanzaId?: string | null } | null } | null } | null;
}
export interface EventosSocketBaileys {
  conexao: (p: { connection?: 'close' | 'connecting' | 'open'; qr?: string; erro?: unknown }) => void;
  mensagens: (p: { messages: MensagemSocketBaileys[]; type?: string }) => void;
  recibos: (p: { key: ChaveMensagemBaileys; update: { status?: number | null } }[]) => void;
  falha: () => void;
}
export interface SocketBaileys {
  numero(): string | null;
  consultarNumero(telefone: string): Promise<string | null>;
  enviar(jid: string, texto: string, messageId: string): Promise<void>;
  fechar(): void;
  logout(): Promise<void>;
}
export interface FabricaBaileys {
  criar(p: PosseBaileys, eventos: EventosSocketBaileys, podeParear: boolean,
    recuperarTexto: (messageId: string, jid: string) => Promise<string | null>): Promise<SocketBaileys>;
}

/** Única fronteira que carrega a biblioteca. Instanciar a fábrica não abre rede. */
export class FabricaBaileysReal implements FabricaBaileys {
  async criar(p: PosseBaileys, eventos: EventosSocketBaileys, podeParear: boolean,
    recuperarTexto: (messageId: string, jid: string) => Promise<string | null>): Promise<SocketBaileys> {
    const pacote = await import('@whiskeysockets/baileys');
    const store = armazenamentoDeAuth(p);
    const antigas = (await store.ler('creds', ['main']))['main'];
    if (!antigas && !podeParear) throw new Error('baileys_pareamento_necessario');
    const creds = antigas ?? pacote.initAuthCreds();
    if (!creds || typeof creds !== 'object' || !('noiseKey' in creds) || !('signedIdentityKey' in creds)) {
      throw new Error('baileys_credencial_invalida');
    }
    if (!antigas) await store.gravar({ creds: { main: creds } });
    const auth = {
      creds,
      keys: {
        get: async (tipo: string, ids: string[]) => {
          const dados = await store.ler(tipo, ids);
          if (tipo === 'app-state-sync-key') for (const [id, valor] of Object.entries(dados)) {
            if (valor && typeof valor === 'object') dados[id] = pacote.proto.Message.AppStateSyncKeyData.fromObject(valor);
          }
          return dados;
        },
        set: store.gravar,
      },
    } as AuthenticationState;
    const sock = pacote.default({ auth, logger: pino({ level: 'silent' }),
      printQRInTerminal: false, markOnlineOnConnect: false, syncFullHistory: false,
      shouldSyncHistoryMessage: () => false, connectTimeoutMs: 15_000, defaultQueryTimeoutMs: 15_000, qrTimeout: 30_000,
      browser: pacote.Browsers.ubuntu('Chrome'),
      shouldIgnoreJid: jid => jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter'),
      getMessage: async key => {
        if (!key.id || !key.remoteJid) return undefined;
        const texto = await recuperarTexto(key.id, key.remoteJid); return texto ? { conversation: texto } : undefined;
      },
    });
    let salvamento: Promise<void> = Promise.resolve();
    sock.ev.on('creds.update', alteracao => {
      Object.assign(creds, alteracao);
      // Persiste em ordem. Falha de armazenamento fecha a sessão, pois seguir
      // cifrando com estado não persistido quebraria os próximos recebimentos.
      salvamento = salvamento.then(() => store.gravar({ creds: { main: creds } })).catch(() => {
        sock.end(new Error('baileys_auth_nao_persistida')); eventos.falha();
      });
    });
    sock.ev.on('connection.update', u => eventos.conexao({
      ...(u.connection ? { connection: u.connection } : {}), ...(u.qr ? { qr: u.qr } : {}),
      ...(u.lastDisconnect ? { erro: u.lastDisconnect.error } : {}),
    }));
    sock.ev.on('messages.upsert', u => eventos.mensagens(u));
    sock.ev.on('messages.update', u => eventos.recibos(u));
    return {
      numero: () => sock.user?.id ?? null,
      consultarNumero: async telefone => {
        const r = await sock.onWhatsApp(telefone);
        return r?.length === 1 && r[0]?.exists ? r[0].jid : null;
      },
      // Não buscar URLs escritas no texto a partir do servidor (prévia/SSRF).
      enviar: async (jid, texto, messageId) => { await sock.sendMessage(jid, { text: texto, linkPreview: null }, { messageId }); },
      fechar: () => sock.end(undefined), logout: () => sock.logout('Desconectado pelo operador'),
    };
  }
}
