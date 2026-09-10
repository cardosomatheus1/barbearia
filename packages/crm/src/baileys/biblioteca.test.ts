import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { desserializarBaileys, serializarBaileys } from './cofre.js';
import { estadoDoAck } from './semantica.js';

describe('contrato da biblioteca Baileys instalada, sem abrir socket', () => {
  it('versão real fornece credenciais serializáveis e estados de ACK esperados', async () => {
    const pacote = await import('@whiskeysockets/baileys');
    const cred = pacote.initAuthCreds();
    expect(desserializarBaileys(serializarBaileys(cred))).toEqual(cred);
    expect(estadoDoAck(pacote.proto.WebMessageInfo.Status.PENDING)).toBeNull();
    expect(estadoDoAck(pacote.proto.WebMessageInfo.Status.SERVER_ACK)).toBe('sent');
    expect(estadoDoAck(pacote.proto.WebMessageInfo.Status.ERROR)).toBe('failed');
    expect(pacote.DisconnectReason.loggedOut).toBe(401);
    expect(pacote.DisconnectReason.connectionReplaced).toBe(440);
  });
  it('patch da libsignal impede que abrir e fechar sessão exponha as chaves', () => {
    const require = createRequire(import.meta.url);
    const daBiblioteca = createRequire(require.resolve('@whiskeysockets/baileys'));
    const signal = daBiblioteca('libsignal') as { SessionRecord: new () => {
      closeSession(s: unknown): void; openSession(s: unknown): void;
    } };
    const spy = [vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined), vi.spyOn(console, 'error').mockImplementation(() => undefined)];
    try {
      const sessao = { indexInfo: { closed: -1 }, privateKey: 'MATERIAL_PRIVADO_SINTETICO_NAO_LOGAR' };
      const record = new signal.SessionRecord(); record.closeSession(sessao); record.closeSession(sessao); record.openSession(sessao);
      expect(JSON.stringify(spy.flatMap(s => s.mock.calls))).not.toContain(sessao.privateKey);
      expect(sessao.indexInfo.closed).toBe(-1);
    } finally { spy.forEach(s => s.mockRestore()); }
  });
});
