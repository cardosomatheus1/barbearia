import { describe, expect, it } from 'vitest';
import { linkWhatsAppManual } from './fila.js';
describe('link manual com telefone e mensagem', () => {
  it('codifica texto sem permitir alterar destinatário ou parâmetros', () => {
    const texto = 'Olá & phone=123? ação + 😀\nLinha';
    const url = new URL(linkWhatsAppManual({ telefone: '+5571988887777', texto }));
    expect(url.origin).toBe('https://wa.me'); expect(url.pathname).toBe('/5571988887777');
    expect([...url.searchParams.keys()]).toEqual(['text']); expect(url.searchParams.get('text')).toBe(texto);
  });
  it.each(['javascript:alert(1)', '+5571?text=x', '5571988887777', '+0123456789'])('recusa telefone fora de E.164: %s', telefone => {
    expect(() => linkWhatsAppManual({ telefone, texto: 'Convite' })).toThrow();
  });
});
