import { describe, expect, it } from 'vitest';
import {
  ConsoleMessagingProvider,
  MensageriaPendenteProvider,
  MetaIdentityMessagingProvider,
  identityMessagingProviderFromEnv,
} from './messaging.js';

const OTP = { phoneE164: '+5571999998888', code: '123456', establishmentName: 'Medida', ttlMinutes: 5 };
const SENHA = { phoneE164: '+5571999998888', name: 'Ruan', establishmentName: 'Medida', password: 'x' };

const META_COMPLETO = {
  IDENTITY_MESSAGING_MODO: 'meta',
  IDENTITY_WHATSAPP_PHONE_NUMBER_ID: '123456789',
  IDENTITY_WHATSAPP_ACCESS_TOKEN: 'token',
  IDENTITY_WHATSAPP_OTP_TEMPLATE: 'codigo_de_acesso',
  IDENTITY_WHATSAPP_STAFF_TEMPLATE: 'senha_primeiro_acesso',
} as NodeJS.ProcessEnv;

describe('a fábrica do provider de identidade', () => {
  /**
   * A regressão que derrubou a API em produção.
   *
   * `app.module.ts` chama esta fábrica num `useFactory`, avaliado na subida.
   * Enquanto o preflight recusava `console` antes de chegar aqui, lançar era
   * coerente. Quando a recusa passou a ser derivada do banco — console é aceito
   * enquanto ninguém exigir OTP —, este `throw` virou uma API que passa no
   * portão e não sobe: `container barbearia-api-1 is unhealthy`.
   *
   * A falha tem que estar no **uso**, e este teste é o que amarra isso.
   */
  it('em produção sem provedor, constrói em vez de derrubar o processo', () => {
    const env = { NODE_ENV: 'production', IDENTITY_MESSAGING_MODO: 'console' } as NodeJS.ProcessEnv;
    expect(() => identityMessagingProviderFromEnv(env)).not.toThrow();
    expect(identityMessagingProviderFromEnv(env)).toBeInstanceOf(MensageriaPendenteProvider);
  });

  it('fora de produção, console é o provider de console', () => {
    const env = { IDENTITY_MESSAGING_MODO: 'console' } as NodeJS.ProcessEnv;
    expect(identityMessagingProviderFromEnv(env)).toBeInstanceOf(ConsoleMessagingProvider);
  });

  it('com as quatro credenciais, é o provider da Meta', () => {
    expect(identityMessagingProviderFromEnv(META_COMPLETO)).toBeInstanceOf(MetaIdentityMessagingProvider);
  });

  /** Modo `meta` mal configurado ainda derruba no boot, e deve mesmo: */
  it('modo meta sem credencial continua falhando alto na construção', () => {
    const env = { IDENTITY_MESSAGING_MODO: 'meta' } as NodeJS.ProcessEnv;
    expect(() => identityMessagingProviderFromEnv(env)).toThrow(/incompleta/);
  });

  it('modo desconhecido continua falhando alto', () => {
    const env = { IDENTITY_MESSAGING_MODO: 'consoel' } as NodeJS.ProcessEnv;
    expect(() => identityMessagingProviderFromEnv(env)).toThrow(/inválido/);
  });
});

describe('o provider de pendência', () => {
  /**
   * Recusa, e não sucesso silencioso. É a diferença entre o cliente ver um erro
   * e o cliente esperar para sempre por um código que está no log do contêiner.
   */
  it('recusa os dois envios, dizendo o que configurar', async () => {
    const provider = new MensageriaPendenteProvider();
    await expect(provider.sendOtp(OTP)).rejects.toThrow(/IDENTITY_MESSAGING_MODO=meta/);
    await expect(provider.sendStaffPassword(SENHA)).rejects.toThrow(/não foi enviada/);
  });
});
