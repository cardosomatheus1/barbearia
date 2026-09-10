import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

assert.equal(process.env.BAILEYS_ENSAIO_LOCAL, '1');
assert.equal(process.env.NODE_ENV, 'test');
const banco = new URL(process.env.DATABASE_URL);
assert.equal(banco.hostname, '127.0.0.1');
assert.match(banco.pathname, /^\/barbearia_baileys_browser_[a-f0-9]+$/);
const require = createRequire(new URL('../packages/crm/package.json', import.meta.url));
const real = await import(pathToFileURL(require.resolve('@whiskeysockets/baileys')));
export const { initAuthCreds, proto, Browsers } = real;
const sockets = [];
let envios = 0;
const servidor = createServer((req, res) => {
  if (req.method !== 'POST' || !['/estado', '/abrir', '/parar'].includes(req.url)) {
    res.writeHead(404).end(); return;
  }
  if (req.url === '/abrir') {
    const atual = sockets.at(-1);
    assert.ok(atual && !atual.fechado);
    atual.ev.emit('creds.update', { registered: true });
    atual.ev.emit('connection.update', { connection: 'open' });
  }
  if (req.url === '/parar') {
    const atual = sockets.at(-1);
    assert.ok(atual && !atual.fechado);
    // Terceiro cliente sintético criado pelo roteiro de navegador.
    atual.ev.emit('messages.upsert', { type: 'notify', messages: [{
      key: { id: 'OPT_OUT_SINTETICO', remoteJid: '5511999995553@s.whatsapp.net', fromMe: false },
      messageTimestamp: Math.floor(Date.now()/1000), message: { conversation: 'PARAR' },
    }] });
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ sockets: sockets.length, envios }));
});
await new Promise(resolve => servidor.listen(3482, '127.0.0.1', resolve));
servidor.unref();
process.once('SIGTERM', () => servidor.close());

export default function makeWASocket(opcoes) {
  assert.equal(opcoes.printQRInTerminal, false);
  assert.equal(opcoes.syncFullHistory, false);
  const socket = { ev: new EventEmitter(), user: { id: '5511999992222:1@s.whatsapp.net' }, fechado: false,
    onWhatsApp: async telefone => [{ exists: true, jid: telefone.replace(/^\+/, '')+'@s.whatsapp.net' }],
    sendMessage: async (jid, conteudo, envio) => {
      assert.equal(socket.fechado, false);
      assert.equal(conteudo.linkPreview, null);
      assert.ok(conteudo.text && envio.messageId);
      envios++;
      queueMicrotask(() => socket.ev.emit('messages.update', [{ key: {
        id: envio.messageId, remoteJid: jid, fromMe: true }, update: { status: 3 } }]));
      return { key: { id: envio.messageId } };
    },
    end: () => { socket.fechado = true; },
    logout: async () => { socket.fechado = true; },
  };
  sockets.push(socket);
  queueMicrotask(() => socket.ev.emit('connection.update', {
    qr: 'QR-SINTETICO-SEM-VALOR-DE-PAREAMENTO' }));
  return socket;
}
