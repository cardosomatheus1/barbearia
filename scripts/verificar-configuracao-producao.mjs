#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

function valor(env, nome) {
  return (env[nome] ?? '').trim();
}

function preenchidas(env, nomes) {
  return nomes.filter((nome) => valor(env, nome) !== '');
}

export function errosDaConfiguracaoDeProducao(env = process.env) {
  const erros = [];
  const psp = valor(env, 'PSP_MODO') || 'nenhum';
  const fiscal = valor(env, 'FISCAL_MODO') || 'nenhum';
  const midia = valor(env, 'MEDIA_STORAGE') || 'local';
  const whatsapp = valor(env, 'WHATSAPP_MODO') || 'nenhum';
  const onboarding = valor(env, 'WHATSAPP_ONBOARDING') || 'padrao';
  const identityMessaging = valor(env, 'IDENTITY_MESSAGING_MODO') || 'console';

  for (const nome of ['STAFF_EMAIL_PEPPER', 'OTP_PEPPER', 'API_KEY_PEPPER']) {
    const segredo = valor(env, nome);
    if (segredo.length < 32) erros.push(`${nome} precisa ter pelo menos 32 caracteres`);
  }

  const mfaBruta = valor(env, 'MFA_SECRET_KEY');
  if (!mfaBruta) erros.push('MFA_SECRET_KEY é obrigatória');
  else {
    try {
      const chave = Buffer.from(mfaBruta, 'base64');
      const canonica = chave.toString('base64').replace(/=+$/, '');
      if (chave.length !== 32 || canonica !== mfaBruta.replace(/=+$/, '')) {
        erros.push('MFA_SECRET_KEY precisa ter 32 bytes em base64');
      }
    } catch { erros.push('MFA_SECRET_KEY precisa ter 32 bytes em base64'); }
  }

  if (!['nenhum', 'fake', 'stripe'].includes(psp)) erros.push(`PSP_MODO inválido: ${psp}`);
  if (psp === 'fake') erros.push('PSP_MODO=fake é proibido em produção');
  if (psp === 'stripe') {
    const chave = valor(env, 'STRIPE_SECRET_KEY');
    const webhook = valor(env, 'STRIPE_WEBHOOK_SECRET');
    if (!chave) erros.push('PSP_MODO=stripe exige STRIPE_SECRET_KEY');
    if (!webhook) erros.push('PSP_MODO=stripe exige STRIPE_WEBHOOK_SECRET');
    if (/^(?:sk|rk)_test_/i.test(chave)) erros.push('STRIPE_SECRET_KEY de teste é proibida em produção');
  }

  if (!['nenhum', 'fake'].includes(fiscal)) erros.push(`FISCAL_MODO inválido: ${fiscal}`);
  if (fiscal === 'fake') erros.push('FISCAL_MODO=fake é proibido em produção');

  if (!['local', 's3'].includes(midia)) erros.push(`MEDIA_STORAGE inválido: ${midia}`);
  if (midia === 's3') {
    for (const nome of ['MEDIA_S3_ENDPOINT', 'MEDIA_S3_BUCKET', 'MEDIA_S3_ACCESS_KEY_ID', 'MEDIA_S3_SECRET_ACCESS_KEY']) {
      if (!valor(env, nome)) erros.push(`MEDIA_STORAGE=s3 exige ${nome}`);
    }
    const endpointBruto = valor(env, 'MEDIA_S3_ENDPOINT');
    if (endpointBruto) {
      try {
        const endpoint = new URL(endpointBruto);
        if (!['http:', 'https:'].includes(endpoint.protocol)) erros.push('MEDIA_S3_ENDPOINT deve usar http ou https');
        if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
          erros.push('MEDIA_S3_ENDPOINT não pode carregar credencial, query ou fragmento');
        }
        if (endpoint.protocol === 'http:' && valor(env, 'MEDIA_S3_ALLOW_HTTP') !== '1') {
          erros.push('S3 por HTTP exige MEDIA_S3_ALLOW_HTTP=1 explicitamente');
        }
      } catch {
        erros.push('MEDIA_S3_ENDPOINT não é uma URL válida');
      }
    }
  }
  const permiteHttp = valor(env, 'MEDIA_S3_ALLOW_HTTP');
  if (permiteHttp && !['0', '1'].includes(permiteHttp)) erros.push('MEDIA_S3_ALLOW_HTTP deve ser 0 ou 1');

  if (!['console', 'meta'].includes(identityMessaging)) {
    erros.push(`IDENTITY_MESSAGING_MODO inválido: ${identityMessaging}`);
  }
  if (identityMessaging === 'console') {
    erros.push('IDENTITY_MESSAGING_MODO=console é proibido em produção');
  }
  if (identityMessaging === 'meta') {
    for (const nome of [
      'IDENTITY_WHATSAPP_PHONE_NUMBER_ID',
      'IDENTITY_WHATSAPP_ACCESS_TOKEN',
      'IDENTITY_WHATSAPP_OTP_TEMPLATE',
      'IDENTITY_WHATSAPP_STAFF_TEMPLATE',
    ]) {
      if (!valor(env, nome)) erros.push(`IDENTITY_MESSAGING_MODO=meta exige ${nome}`);
    }
    const phoneId = valor(env, 'IDENTITY_WHATSAPP_PHONE_NUMBER_ID');
    if (phoneId && !/^[0-9]+$/.test(phoneId)) {
      erros.push('IDENTITY_WHATSAPP_PHONE_NUMBER_ID deve ser numérico');
    }
    for (const nome of ['IDENTITY_WHATSAPP_OTP_TEMPLATE', 'IDENTITY_WHATSAPP_STAFF_TEMPLATE']) {
      const template = valor(env, nome);
      if (template && !/^[a-z0-9_]+$/.test(template)) erros.push(`${nome} tem nome de template inválido`);
    }
  }

  if (!['nenhum', 'meta'].includes(whatsapp)) erros.push(`WHATSAPP_MODO inválido: ${whatsapp}`);
  if (!['padrao', 'coexistencia'].includes(onboarding)) erros.push(`WHATSAPP_ONBOARDING inválido: ${onboarding}`);

  const meta = ['META_APP_ID', 'META_CONFIG_ID', 'META_APP_SECRET'];
  const metaPreenchidas = preenchidas(env, meta);
  if (metaPreenchidas.length > 0 && metaPreenchidas.length < meta.length) {
    erros.push('Embedded Signup parcialmente configurado: META_APP_ID, META_CONFIG_ID e META_APP_SECRET devem vir juntos');
  }
  if (onboarding === 'coexistencia' && metaPreenchidas.length !== meta.length) {
    erros.push('WHATSAPP_ONBOARDING=coexistencia exige as três credenciais META_APP_*');
  }
  if (whatsapp === 'meta') {
    for (const nome of ['WHATSAPP_TOKEN_KEY', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN']) {
      if (!valor(env, nome)) erros.push(`WHATSAPP_MODO=meta exige ${nome}`);
    }
  }
  const segredoSignup = valor(env, 'META_APP_SECRET');
  const segredoWebhook = valor(env, 'WHATSAPP_APP_SECRET');
  if (segredoSignup && segredoWebhook && segredoSignup !== segredoWebhook) {
    erros.push('META_APP_SECRET e WHATSAPP_APP_SECRET apontam para segredos diferentes do app Meta');
  }

  const chaveBackupBruta = valor(env, 'BACKUP_ENCRYPTION_KEY');
  if (!chaveBackupBruta) erros.push('backup criptografado exige BACKUP_ENCRYPTION_KEY');
  else {
    try {
      const chaveBackup = Buffer.from(chaveBackupBruta, 'base64');
      const canonica = chaveBackup.toString('base64').replace(/=+$/, '');
      if (chaveBackup.length !== 32 || canonica !== chaveBackupBruta.replace(/=+$/, '')) {
        erros.push('BACKUP_ENCRYPTION_KEY precisa ter 32 bytes em base64');
      }
    } catch { erros.push('BACKUP_ENCRYPTION_KEY precisa ter 32 bytes em base64'); }
  }

  /**
   * A proteção anti-bot é do mesmo formato de `PSP_MODO` e `FISCAL_MODO`:
   * provedor não contratado é `nenhum` **declarado**, nunca omitido.
   *
   * O padrão continua `turnstile`, então quem não escrever nada continua sendo
   * cobrado das três chaves. `nenhum` é uma linha no `.env` que alguém digitou
   * de propósito, e é isso que a torna encontrável quando o cadastro público
   * começar a receber conta falsa.
   */
  const antiBot = valor(env, 'BOT_PROTECTION_MODO') || 'turnstile';
  if (!['turnstile', 'nenhum'].includes(antiBot)) {
    erros.push(`BOT_PROTECTION_MODO inválido: ${antiBot}. Use turnstile ou nenhum.`);
  }
  if (antiBot === 'turnstile') {
    for (const nome of ['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'TURNSTILE_HOSTNAMES']) {
      if (!valor(env, nome)) {
        erros.push(
          `proteção anti-bot exige ${nome} (ou BOT_PROTECTION_MODO=nenhum para assumir a pendência)`,
        );
      }
    }
    const hostnamesTurnstile = valor(env, 'TURNSTILE_HOSTNAMES')
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean);
    if (hostnamesTurnstile.some((h) => ['localhost', '127.0.0.1', '::1'].includes(h))) {
      erros.push('TURNSTILE_HOSTNAMES de produção não pode conter localhost');
    }
  }

  const webUrl = valor(env, 'WEB_URL');
  if (webUrl) {
    try {
      const url = new URL(webUrl);
      if (url.protocol !== 'https:') erros.push('WEB_URL de produção deve usar https');
      if (['localhost', '127.0.0.1', '::1'].includes(url.hostname)) erros.push('WEB_URL de produção não pode apontar para localhost');
    } catch {
      erros.push('WEB_URL não é uma URL válida');
    }
  }

  return [...new Set(erros)];
}

export function verificarConfiguracaoDeProducao(env = process.env) {
  const erros = errosDaConfiguracaoDeProducao(env);
  if (erros.length) {
    const detalhe = erros.map((erro) => `  - ${erro}`).join('\n');
    throw new Error(`configuração de produção recusada:\n${detalhe}`);
  }
  return true;
}

const direto = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direto) {
  try {
    verificarConfiguracaoDeProducao(process.env);
    console.log('configuração de produção: OK');
  } catch (erro) {
    console.error(erro instanceof Error ? erro.message : 'configuração de produção recusada');
    process.exitCode = 1;
  }
}
