import { afterEach, describe, expect, it, vi } from 'vitest';
import { cifrarBaileys, decifrarBaileys, serializarBaileys, desserializarBaileys, hashBaileys } from './cofre.js';
import { comandoDeTexto, estadoDoAck, jidDePessoa, motivoDeDesconexao, telefoneDoJid } from './semantica.js';

describe('segredos e semântica do Baileys', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('sessão cifrada não pode ser movida para outra unidade, chave ou geração', () => {
    vi.stubEnv('WHATSAPP_TOKEN_KEY', Buffer.alloc(32, 31).toString('base64'));
    const cifra = cifrarBaileys('credencial-sintetica', 'tenant:unidade:geracao');
    expect(cifra).not.toContain('credencial');
    expect(decifrarBaileys(cifra, 'tenant:unidade:geracao')).toBe('credencial-sintetica');
    expect(() => decifrarBaileys(cifra, 'vizinho:unidade:geracao')).toThrow();
    expect(() => decifrarBaileys(cifra, 'tenant:unidade:outra')).toThrow();
    const bytes = Buffer.from(cifra, 'base64'); bytes[15] = (bytes[15] ?? 0) ^ 1;
    expect(() => decifrarBaileys(bytes.toString('base64'), 'tenant:unidade:geracao')).toThrow();
    vi.stubEnv('WHATSAPP_TOKEN_KEY', Buffer.alloc(32, 32).toString('base64'));
    expect(() => decifrarBaileys(cifra, 'tenant:unidade:geracao')).toThrow();
  });
  it('chaves Signal preservam bytes aninhados e remoções no roundtrip', () => {
    const creds = { noiseKey: { private: Buffer.from([0, 255, 128]), public: new Uint8Array([7, 8]) }, removed: null };
    expect(desserializarBaileys(serializarBaileys(creds))).toEqual({ noiseKey: {
      private: Buffer.from([0, 255, 128]), public: Buffer.from([7, 8]) }, removed: null });
  });
  it('não cifra nem cria identificador global sem chave válida', () => {
    vi.stubEnv('WHATSAPP_TOKEN_KEY', 'incorreta');
    expect(() => cifrarBaileys('x', 'escopo')).toThrow();
    expect(() => hashBaileys('numero')).toThrow();
  });
  it('pending não prova envio; zero é falha e ACK do servidor prova aceitação', () => {
    expect([undefined, null, 1, 7, '2'].map(estadoDoAck)).toEqual([null, null, null, null, null]);
    expect([0, 2, 3, 4, 5].map(estadoDoAck)).toEqual(['failed', 'sent', 'delivered', 'read', 'read']);
  });
  it('LID não vira telefone e mensagens de grupo não viram ações do cliente', () => {
    expect(telefoneDoJid('5511999992222:12@s.whatsapp.net')).toBe('+5511999992222');
    expect(telefoneDoJid('5511999992222@lid')).toBeNull();
    expect(jidDePessoa('5511999992222@lid')).toBe(true);
    expect(jidDePessoa('5511999992222@g.us')).toBe(false);
    expect(jidDePessoa('status@broadcast')).toBe(false);
    expect(telefoneDoJid('5511999992222@g.us')).toBeNull();
  });
  it('revogação e substituição exigem operador; reinício após QR reconecta', () => {
    expect(motivoDeDesconexao(401).terminal).toBe(true);
    expect(motivoDeDesconexao(440).terminal).toBe(true);
    expect(motivoDeDesconexao(515).terminal).toBe(false);
    expect(comandoDeTexto('  PARAR ')).toBe('parar_de_receber');
    expect(comandoDeTexto('não quero receber promoções')).toBe('parar_de_receber');
    expect(comandoDeTexto('não cancelar')).toBeNull();
    expect(comandoDeTexto('cancelar')).toBe('cancelar');
  });
});
