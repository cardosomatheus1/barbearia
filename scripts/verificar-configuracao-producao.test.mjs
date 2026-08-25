import assert from 'node:assert/strict';
import test from 'node:test';
import { errosDaConfiguracaoDeProducao } from './verificar-configuracao-producao.mjs';

const BASE = {
  NODE_ENV: 'production',
  STAFF_EMAIL_PEPPER: 'staff-email-pepper-0123456789abcdef',
  OTP_PEPPER: 'otp-pepper-seguro-0123456789abcdef',
  API_KEY_PEPPER: 'api-key-pepper-0123456789abcdef0123456789',
  MFA_SECRET_KEY: Buffer.alloc(32, 3).toString('base64'),
  PSP_MODO: 'nenhum',
  FISCAL_MODO: 'nenhum',
  MEDIA_STORAGE: 'local',
  WHATSAPP_MODO: 'nenhum',
  WHATSAPP_ONBOARDING: 'padrao',
  IDENTITY_MESSAGING_MODO: 'meta',
  IDENTITY_WHATSAPP_PHONE_NUMBER_ID: '123456789012345',
  IDENTITY_WHATSAPP_ACCESS_TOKEN: 'token-producao-de-teste',
  IDENTITY_WHATSAPP_OTP_TEMPLATE: 'barberdock_otp',
  IDENTITY_WHATSAPP_STAFF_TEMPLATE: 'barberdock_primeiro_acesso',
  WEB_URL: 'https://barberdock.example',
  BACKUP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  TURNSTILE_SITE_KEY: 'site-key',
  TURNSTILE_SECRET_KEY: 'secret-key',
  TURNSTILE_HOSTNAMES: 'barberdock.example',
};
const erros = (mais = {}) => errosDaConfiguracaoDeProducao({ ...BASE, ...mais });

test('configuração mínima segura passa', () => assert.deepEqual(erros(), []));

test('mensageria de identidade por console é recusada em produção', () =>
  assert.match(erros({ IDENTITY_MESSAGING_MODO: 'console' }).join('\n'), /console.*proibido/i));

test('mensageria Meta de identidade exige credenciais e templates', () => {
  const e = erros({
    IDENTITY_MESSAGING_MODO: 'meta',
    IDENTITY_WHATSAPP_PHONE_NUMBER_ID: '',
    IDENTITY_WHATSAPP_ACCESS_TOKEN: '',
    IDENTITY_WHATSAPP_OTP_TEMPLATE: '',
    IDENTITY_WHATSAPP_STAFF_TEMPLATE: '',
  }).join('\n');
  assert.match(e, /PHONE_NUMBER_ID/);
  assert.match(e, /ACCESS_TOKEN/);
  assert.match(e, /OTP_TEMPLATE/);
  assert.match(e, /STAFF_TEMPLATE/);
});

test('mensageria Meta valida id do número e nomes de template', () => {
  assert.match(erros({ IDENTITY_WHATSAPP_PHONE_NUMBER_ID: 'abc' }).join('\n'), /deve ser numérico/);
  assert.match(erros({ IDENTITY_WHATSAPP_OTP_TEMPLATE: 'Template Inválido' }).join('\n'), /template inválido/);
});

test('segredos de identidade fracos são recusados', () => {
  assert.match(erros({ STAFF_EMAIL_PEPPER: 'curto' }).join('\n'), /STAFF_EMAIL_PEPPER/);
  assert.match(erros({ OTP_PEPPER: 'curto' }).join('\n'), /OTP_PEPPER/);
  assert.match(erros({ API_KEY_PEPPER: 'curto' }).join('\n'), /API_KEY_PEPPER/);
  assert.match(erros({ MFA_SECRET_KEY: 'curto' }).join('\n'), /MFA_SECRET_KEY/);
});
test('fake de cobrança não sobe em produção', () => assert.match(erros({ PSP_MODO: 'fake' }).join('\n'), /PSP_MODO=fake/));
test('Stripe exige chave e webhook', () => {
  const e = erros({ PSP_MODO: 'stripe' }).join('\n');
  assert.match(e, /STRIPE_SECRET_KEY/); assert.match(e, /STRIPE_WEBHOOK_SECRET/);
});
test('Stripe rejeita chave de teste em produção', () => assert.match(erros({ PSP_MODO: 'stripe', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' }).join('\n'), /STRIPE_SECRET_KEY.*teste/i));
test('fiscal fake não sobe em produção', () => assert.match(erros({ FISCAL_MODO: 'fake' }).join('\n'), /FISCAL_MODO=fake/));
test('S3 incompleto é recusado', () => assert.match(erros({ MEDIA_STORAGE: 's3' }).join('\n'), /MEDIA_S3_ENDPOINT/));
test('S3 HTTP exige decisão explícita', () => {
  const e = erros({ MEDIA_STORAGE: 's3', MEDIA_S3_ENDPOINT: 'http://minio:9000', MEDIA_S3_BUCKET: 'b', MEDIA_S3_ACCESS_KEY_ID: 'a', MEDIA_S3_SECRET_ACCESS_KEY: 's' }).join('\n');
  assert.match(e, /MEDIA_S3_ALLOW_HTTP=1/);
  assert.deepEqual(erros({ MEDIA_STORAGE: 's3', MEDIA_S3_ENDPOINT: 'http://minio:9000', MEDIA_S3_BUCKET: 'b', MEDIA_S3_ACCESS_KEY_ID: 'a', MEDIA_S3_SECRET_ACCESS_KEY: 's', MEDIA_S3_ALLOW_HTTP: '1' }), []);
});
test('S3 não aceita credencial ou query no endpoint', () => assert.match(erros({ MEDIA_STORAGE: 's3', MEDIA_S3_ENDPOINT: 'https://u:p@objects.example/x?token=y', MEDIA_S3_BUCKET: 'b', MEDIA_S3_ACCESS_KEY_ID: 'a', MEDIA_S3_SECRET_ACCESS_KEY: 's' }).join('\n'), /credencial, query ou fragmento/));
test('Meta ativo exige segredos do webhook e cofre', () => {
  const e = erros({ WHATSAPP_MODO: 'meta' }).join('\n');
  assert.match(e, /WHATSAPP_TOKEN_KEY/); assert.match(e, /WHATSAPP_APP_SECRET/); assert.match(e, /WHATSAPP_VERIFY_TOKEN/);
});
test('Embedded Signup parcial é recusado', () => assert.match(erros({ META_APP_ID: '1' }).join('\n'), /parcialmente configurado/));
test('coexistência exige app Meta completo', () => assert.match(erros({ WHATSAPP_ONBOARDING: 'coexistencia' }).join('\n'), /exige as três credenciais/));
test('segredo de signup e webhook do mesmo app não podem divergir', () => {
  const e = erros({ META_APP_ID: '1', META_CONFIG_ID: '2', META_APP_SECRET: 'segredo-a', WHATSAPP_APP_SECRET: 'segredo-b' }).join('\n');
  assert.match(e, /segredos diferentes/);
});
test('backup exige chave AES-256 própria', () => {
  assert.match(erros({ BACKUP_ENCRYPTION_KEY: '' }).join('\n'), /BACKUP_ENCRYPTION_KEY/);
  assert.match(erros({ BACKUP_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString('base64') }).join('\n'), /32 bytes/);
  assert.match(erros({ BACKUP_ENCRYPTION_KEY: '***nao-base64***' }).join('\n'), /32 bytes/);
});
test('Turnstile é obrigatório em produção', () => {
  assert.match(erros({ TURNSTILE_SECRET_KEY: '' }).join('\n'), /TURNSTILE_SECRET_KEY/);
  assert.match(erros({ TURNSTILE_SITE_KEY: '' }).join('\n'), /TURNSTILE_SITE_KEY/);
  assert.match(erros({ TURNSTILE_HOSTNAMES: '' }).join('\n'), /TURNSTILE_HOSTNAMES/);
});
test('Turnstile não aceita localhost na lista de produção', () =>
  assert.match(erros({ TURNSTILE_HOSTNAMES: 'barberdock.example,localhost' }).join('\n'), /localhost/));
test('WEB_URL público exige HTTPS e não localhost', () => {
  assert.match(erros({ WEB_URL: 'http://localhost:3001' }).join('\n'), /https/);
  assert.match(erros({ WEB_URL: 'http://localhost:3001' }).join('\n'), /localhost/);
});
