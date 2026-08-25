import { describe, expect, it } from 'vitest';
import {
  AssinaturaDoWhatsAppInvalida,
  assinarWebhookDaMeta,
  conferirAssinaturaDaMeta,
} from './whatsapp-assinatura.js';

const corpo = '{"object":"whatsapp_business_account","entry":[]}';
const segredo = 'segredo-teste';
const assinatura = 'e6965dee88ac517f4897fa919ccaadbf360fb37985f320c756192011d39897f4';

function esperarFalha(
  entrada: Parameters<typeof conferirAssinaturaDaMeta>[0],
  code: AssinaturaDoWhatsAppInvalida['code'],
): void {
  try {
    conferirAssinaturaDaMeta(entrada);
    throw new Error('assinatura deveria ter sido recusada');
  } catch (erro) {
    expect(erro).toBeInstanceOf(AssinaturaDoWhatsAppInvalida);
    expect((erro as AssinaturaDoWhatsAppInvalida).code).toBe(code);
  }
}

describe('assinatura do webhook da Meta', () => {
  it('produz o vetor HMAC-SHA256 conhecido e aceita o cabeçalho correspondente', () => {
    expect(assinarWebhookDaMeta({ corpoCru: corpo, segredo })).toBe(assinatura);
    expect(() =>
      conferirAssinaturaDaMeta({ corpoCru: corpo, segredo, cabecalho: `sha256=${assinatura}` }),
    ).not.toThrow();
  });

  it('recusa segredo ausente', () => {
    esperarFalha({ corpoCru: corpo, segredo: '', cabecalho: `sha256=${assinatura}` }, 'segredo_ausente');
  });

  it('recusa cabeçalho ausente', () => {
    esperarFalha({ corpoCru: corpo, segredo, cabecalho: undefined }, 'assinatura_ausente');
  });

  it('recusa algoritmo/formato diferente', () => {
    esperarFalha({ corpoCru: corpo, segredo, cabecalho: 'md5=abc' }, 'assinatura_malformada');
  });

  it('recusa valor não hexadecimal', () => {
    esperarFalha({ corpoCru: corpo, segredo, cabecalho: 'sha256=xyz' }, 'assinatura_malformada');
  });

  it('recusa assinatura de comprimento/valor errado sem vazar exceção do timingSafeEqual', () => {
    esperarFalha({ corpoCru: corpo, segredo, cabecalho: 'sha256=00' }, 'assinatura_invalida');
  });

  it('recusa a assinatura válida quando um byte do corpo muda', () => {
    esperarFalha(
      { corpoCru: `${corpo} `, segredo, cabecalho: `sha256=${assinatura}` },
      'assinatura_invalida',
    );
  });
});
