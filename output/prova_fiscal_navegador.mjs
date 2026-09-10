import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { signUpOwner } from '../packages/identity/dist/index.js';
import { disconnect } from '../packages/db/dist/index.js';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const forge = createRequire(new URL('../packages/finance/package.json', import.meta.url))('node-forge');
const { Client } = createRequire(new URL('../packages/db/package.json', import.meta.url))('pg');
assert.equal(new URL(process.env.DEMO_DATABASE_URL).hostname, '127.0.0.1');
assert.match(new URL(process.env.DEMO_DATABASE_URL).pathname, /^\/barbearia_nfse_browser_[a-f0-9]+$/);
const db = new Client({ connectionString: process.env.DEMO_DATABASE_URL }); await db.connect();
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const prints = new URL('./PRINTS_CORRECOES_PRE_GO_LIVE/', import.meta.url);
await mkdir(prints, { recursive: true });
const web = process.env.WEB_URL; const api = process.env.API_URL;
const cred = () => {
  const keys = forge.pki.rsa.generateKeyPair(2048); const c = forge.pki.createCertificate();
  c.publicKey = keys.publicKey; c.serialNumber = '01';
  c.validity.notBefore = new Date('2020-01-01'); c.validity.notAfter = new Date('2040-01-01');
  c.setSubject([{ name: 'commonName', value: 'A1 sintetico sem valor fiscal' }]); c.setIssuer(c.subject.attributes);
  const a = forge.asn1;
  const san = a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, [a.create(a.Class.CONTEXT_SPECIFIC, 0, true, [
    a.create(a.Class.UNIVERSAL, a.Type.OID, false, a.oidToDer('2.16.76.1.3.3').getBytes()),
    a.create(a.Class.CONTEXT_SPECIFIC, 0, true, [a.create(a.Class.UNIVERSAL, a.Type.UTF8, false, '12345678000195')]),
  ])]);
  c.setExtensions([{ name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true }, { id: '2.5.29.17', value: a.toDer(san).getBytes() }]);
  c.sign(keys.privateKey, forge.md.sha256.create());
  const senha = ' senha sintetica com espacos ';
  return { senha, pfx: Buffer.from(a.toDer(forge.pkcs12.toPkcs12Asn1(keys.privateKey, [c], senha, { algorithm: '3des' })).getBytes(), 'binary') };
};
try {
  const cadastro = await signUpOwner({ name: 'Operadora de teste', email: 'fiscal@example.invalid',
    password: randomBytes(24).toString('base64url'), phone: '+5511999992222', businessName: 'Barbearia de Teste Fiscal' });
  assert.ok(cadastro.created);
  const sessao = cadastro.session;
  await db.query('UPDATE tenants SET published_at=now(), onboarding_step=6 WHERE id=$1', [sessao.tenantId]);
  await db.query("INSERT INTO tenant_features(tenant_id,flag_code,enabled) VALUES($1,'fiscal',true)", [sessao.tenantId]);
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  await context.addCookies([{ name: 'gestor', value: sessao.token, domain: '127.0.0.1', path: '/admin', httpOnly: true, sameSite: 'Strict', secure: false }]);
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', () => errors.push('erro de javascript'));
  page.on('response', r => { if (r.status() >= 500) errors.push('http ' + r.status()); });
  const situacao = async () => {
    const r = await fetch(api+'/v1/admin/fiscal/nacional', { headers: { authorization: 'Bearer '+sessao.token } });
    assert.equal(r.status, 200); return r.json();
  };
  await page.goto(web+'/admin/fiscal', { waitUntil: 'networkidle' });
  await page.locator('#cnpj').fill('12345678000195'); await page.locator('#regime').selectOption('mei');
  await page.locator('#codigoDeServico').fill('060101'); await page.locator('#issPercent').fill('0');
  await page.locator('#municipioIbge').fill('3550308');
  await page.getByRole('button', { name: 'Salvar cadastro fiscal', exact: true }).click();
  await page.waitForURL(/salvo=1/); await page.waitForLoadState('networkidle');
  await page.locator('#nfse-serie').fill('7'); await page.locator('#nfse-habilitada').selectOption('1');
  await page.getByRole('button', { name: 'Salvar emissor', exact: true }).click();
  await page.waitForURL(/feito=nfse-configurada/); await page.waitForLoadState('networkidle');
  assert.equal((await situacao()).configuracao.serie, 7);
  await page.locator('#nfse-arquivo').setInputFiles({ name: 'invalido.pfx', mimeType: 'application/x-pkcs12', buffer: Buffer.from('nao e certificado') });
  await page.getByRole('button', { name: 'Salvar certificado', exact: true }).click();
  await page.waitForURL(/falha=|erro=/); await page.waitForLoadState('networkidle');
  assert.equal((await situacao()).certificado, null);
  const a1 = cred();
  await page.locator('#nfse-arquivo').setInputFiles({ name: 'sintetico.pfx', mimeType: 'application/x-pkcs12', buffer: a1.pfx });
  await page.locator('#nfse-senha').fill(a1.senha);
  await page.getByRole('button', { name: 'Salvar certificado', exact: true }).click();
  await page.waitForURL(/feito=certificado-salvo/); await page.waitForLoadState('networkidle');
  assert.equal((await situacao()).pronta, true);
  assert.equal(await page.locator('#nfse-senha').inputValue(), '');
  for (const width of [360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 950 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'overflow na largura '+width);
    await page.screenshot({ path: new URL('nfse-configurada-'+width+'.png', prints).pathname, fullPage: true });
  }
  await page.getByText('Certificado A1 cadastrado', { exact: true }).click();
  await page.getByText('Remover certificado', { exact: true }).click();
  await page.getByRole('button', { name: 'Remover desta unidade', exact: true }).click();
  await page.waitForURL(/feito=certificado-removido/); await page.waitForLoadState('networkidle');
  assert.equal((await situacao()).certificado, null);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ resultado: 'passou', cenarios: ['cadastro fiscal', 'configuração nacional', 'arquivo inválido', 'A1 com senha contendo espaços', 'remoção', '360/390/768/1280 sem overflow'], redeFiscal: false }));
} finally { await browser.close(); await db.end(); await disconnect(); }
