import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { signUpOwner } from '../packages/identity/dist/index.js';
import { disconnect } from '../packages/db/dist/index.js';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { Client } = createRequire(new URL('../packages/db/package.json', import.meta.url))('pg');
assert.equal(new URL(process.env.DEMO_DATABASE_URL).hostname, '127.0.0.1');
assert.match(new URL(process.env.DEMO_DATABASE_URL).pathname, /^\/barbearia_nfse_browser_[a-f0-9]+$/);
const db = new Client({ connectionString: process.env.DEMO_DATABASE_URL }); await db.connect();
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const prints = new URL('./PRINTS_CORRECOES_PRE_GO_LIVE/', import.meta.url);
await mkdir(prints, { recursive: true });
const web = process.env.WEB_URL; const api = process.env.API_URL;
const cnpj = '12ABC34501DE35';
const fixture = JSON.parse(await readFile(join(process.env.FISCAL_CONFIANCA_DIR, 'a1-teste.json'), 'utf8'));
const a1 = { pfx: Buffer.from(fixture.pfx, 'base64'), senha: fixture.senha };
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
  await page.locator('#cnpj').fill('12.abc.345/01de-35'); await page.locator('#regime').selectOption('mei');
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
  await page.locator('#nfse-arquivo').setInputFiles({ name: 'sintetico.pfx', mimeType: 'application/x-pkcs12', buffer: a1.pfx });
  await page.locator('#nfse-senha').fill(a1.senha);
  await page.getByRole('button', { name: 'Salvar certificado', exact: true }).click();
  await page.waitForURL(/feito=certificado-salvo/); await page.waitForLoadState('networkidle');
  assert.equal((await situacao()).pronta, true);
  if (process.env.FISCAL_MEDIR === '1') {
    const { abrirCaixa, abrirComanda, adicionarItem, fecharComanda, notaDaVenda } = await import('../packages/finance/dist/index.js');
    const locationId = (await db.query('SELECT id FROM locations WHERE tenant_id=$1', [sessao.tenantId])).rows[0].id;
    const staffId = (await db.query('SELECT id FROM staff_users WHERE tenant_id=$1', [sessao.tenantId])).rows[0].id;
    const ator = { tenantId: sessao.tenantId, locationId, staffId, staffName: 'Operadora sintética' };
    const serviceId = randomUUID(); const professionalId = randomUUID();
    await db.query("INSERT INTO services(id,tenant_id,name,price_cents,duration_minutes) VALUES($1,$2,'Corte sintético',5000,30)", [serviceId,sessao.tenantId]);
    await db.query("INSERT INTO professionals(id,tenant_id,location_id,name,kind) VALUES($1,$2,$3,'Profissional sintético','professional')", [professionalId,sessao.tenantId,locationId]);
    await db.query('UPDATE fiscal_settings SET auto_issue=true WHERE location_id=$1', [locationId]);
    await abrirCaixa({ ...ator, openingCents: 0 });
    const chamadas = []; const pagamentos = [];
    for (let i=0;i<20;i++) {
      let inicio=performance.now(); assert.equal((await situacao()).pronta,true); chamadas.push(performance.now()-inicio);
      const venda=await abrirComanda(ator);
      await adicionarItem({ ...ator, orderId:venda.id, tipo:'service', descricao:'Corte sintético', serviceId, professionalId, quantidade:1, precoUnitarioCents:5000 });
      inicio=performance.now();
      await fecharComanda({ ...ator, orderId:venda.id, hojeNaUnidade:new Date().toISOString().slice(0,10), pagamentos:[{forma:'cash',valorCents:5000}] });
      pagamentos.push(performance.now()-inicio);
      assert.ok(await notaDaVenda(sessao.tenantId,locationId,venda.id),'Fechamento deve criar a nota pendente');
    }
    const resumo = xs => { const a=[...xs].sort((a,b)=>a-b); return {n:a.length,p50:Math.round(a[Math.ceil(a.length*.5)-1]),p95:Math.round(a[Math.ceil(a.length*.95)-1]),max:Math.round(a.at(-1))}; };
    const medicao={etapa:'medicao-fiscal',prontidaoApiMs:resumo(chamadas),fechamentoComA1SnapshotFilaMs:resumo(pagamentos),redeFiscal:false};
    console.log(JSON.stringify(medicao));
    assert.ok(medicao.prontidaoApiMs.p95<500,'Prontidão fiscal ultrapassou P95 de 500ms');
    assert.ok(medicao.fechamentoComA1SnapshotFilaMs.p95<1000,'Fechamento fiscal ultrapassou P95 de 1s');
  }
  assert.equal((await db.query('SELECT cnpj FROM fiscal_settings WHERE tenant_id=$1', [sessao.tenantId])).rows[0].cnpj, cnpj);
  assert.equal(await page.locator('#nfse-senha').inputValue(), '');
  for (const width of [360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 950 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'overflow na largura '+width);
    await page.screenshot({ path: new URL('nfse-configurada-'+width+'.png', prints).pathname, fullPage: true });
  }
  await page.locator('details').filter({ has: page.locator('#regime') }).locator('summary').first().click();
  await page.locator('#regime').selectOption('simples'); await page.locator('#issPercent').fill('5');
  await page.getByRole('button', { name: 'Salvar cadastro fiscal', exact: true }).click();
  await page.waitForURL(/salvo=1/); await page.waitForLoadState('networkidle');
  assert.equal((await situacao()).pronta, false, 'Simples precisa informar os tributos');
  await page.getByText('Configurar emissão', { exact: true }).click();
  await page.locator('#nfse-apuracao').selectOption('1');
  assert.equal(await page.locator('#nfse-simples').count(), 0);
  await page.locator('#nfse-tributos-federal').fill('13,45');
  await page.locator('#nfse-tributos-estadual').fill('0');
  await page.locator('#nfse-tributos-municipal').fill('5');
  await page.getByRole('button', { name: 'Salvar emissor', exact: true }).click();
  await page.waitForURL(/feito=nfse-configurada/); await page.waitForLoadState('networkidle');
  const foraDas = await situacao(); assert.equal(foraDas.pronta, true);
  assert.equal(foraDas.configuracao.issForaDas, true);
  assert.deepEqual(foraDas.configuracao.tributosAproximadosBps, { federal: 1345, estadual: 0, municipal: 500 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText('Configurar emissão', { exact: true }).click();
  assert.equal(await page.locator('#nfse-apuracao').inputValue(), '1');
  assert.equal(await page.locator('#nfse-tributos-federal').inputValue(), '13,45');
  for (const width of [360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 950 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'overflow no Simples fora do DAS '+width);
    await page.screenshot({ path: new URL('nfse-simples-fora-das-'+width+'.png', prints).pathname, fullPage: true });
  }
  await page.locator('#nfse-apuracao').selectOption('2');
  await Promise.all([
    page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).origin === web),
    page.getByRole('button', { name: 'Salvar emissor', exact: true }).click(),
  ]);
  await page.waitForLoadState('networkidle');
  const foraTodos = await situacao(); assert.equal(foraTodos.pronta, true);
  assert.equal(foraTodos.configuracao.issForaDas, true); assert.equal(foraTodos.configuracao.federaisForaDas, true);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText('Configurar emissão', { exact: true }).click();
  assert.equal(await page.locator('#nfse-apuracao').inputValue(), '2');
  for (const width of [360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 950 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: new URL('nfse-simples-apuracao3-'+width+'.png', prints).pathname, fullPage: true });
  }
  await page.locator('#nfse-apuracao').selectOption('0');
  assert.equal(await page.locator('#nfse-tributos-federal').count(), 0);
  await page.locator('#nfse-simples').fill('6,50');
  // A URL já contém feito=nfse-configurada. Aguarda a resposta desta gravação,
  // pois networkidle sozinho pode observar a página anterior antes do POST.
  await Promise.all([
    page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).origin === web),
    page.getByRole('button', { name: 'Salvar emissor', exact: true }).click(),
  ]);
  await page.waitForLoadState('networkidle');
  const noDas = await situacao(); assert.equal(noDas.pronta, true);
  assert.equal(noDas.configuracao.issForaDas, false);
  assert.equal(noDas.configuracao.federaisForaDas, false);
  assert.equal(noDas.configuracao.aliquotaTotalSimplesBps, 650);
  assert.equal(noDas.configuracao.tributosAproximadosBps, null);
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('details').filter({ has: page.locator('#regime') }).locator('summary').first().click();
  await page.locator('#regime').selectOption('normal'); await page.locator('#issPercent').fill('5');
  await page.getByRole('button', { name: 'Salvar cadastro fiscal', exact: true }).click();
  await page.waitForURL(/salvo=1/); await page.waitForLoadState('networkidle');
  assert.equal((await situacao()).pronta, false, 'não optante ainda precisa informar tributos');
  await page.getByText('Configurar emissão', { exact: true }).click();
  assert.equal(await page.locator('#nfse-simples').count(), 0);
  for (const tipo of ['federal', 'estadual', 'municipal']) assert.equal(await page.locator('#nfse-tributos-'+tipo).inputValue(), '');
  await page.locator('#nfse-tributos-federal').fill('13,45');
  await page.locator('#nfse-tributos-estadual').fill('0');
  await page.locator('#nfse-tributos-municipal').fill('5');
  await page.locator('#nfse-ibscbs').selectOption('regular_presencial');
  await page.locator('#nfse-nbs').fill('126021000');
  await page.getByRole('button', { name: 'Salvar emissor', exact: true }).click();
  await page.waitForURL(/feito=nfse-configurada/); await page.waitForLoadState('networkidle');
  const normal = await situacao(); assert.equal(normal.pronta, true);
  assert.deepEqual(normal.configuracao.tributosAproximadosBps, { federal: 1345, estadual: 0, municipal: 500 });
  assert.equal(normal.configuracao.perfilIbsCbs, 'regular_presencial');
  assert.equal(normal.configuracao.nbs, '126021000');
  await page.getByText('Configurar emissão', { exact: true }).click();
  for (const width of [360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 950 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'overflow no perfil não optante '+width);
    await page.screenshot({ path: new URL('nfse-nao-optante-'+width+'.png', prints).pathname, fullPage: true });
  }
  const abrirCadastro = async () => {
    if (!await page.locator('#regime').isVisible()) await page.locator('details').filter({ has: page.locator('#regime') }).locator('summary').first().click();
  };
  await abrirCadastro();
  await page.locator('#regime').selectOption('simples');
  await page.locator('#issPercent').fill('2');
  await page.locator('#inscricaoMunicipal').fill('12345678');
  await page.getByRole('button', { name: 'Salvar cadastro fiscal', exact: true }).click();
  await page.waitForURL(/salvo=1/); await page.waitForLoadState('networkidle');
  await page.getByRole('link', { name: 'Emissor municipal', exact: true }).click();
  await page.waitForURL(/emissor=municipal/); await page.waitForLoadState('networkidle');
  assert.equal(await page.locator('#nfse-serie').count(), 0, 'formulário nacional deve ficar oculto');
  for (const [campo, valor] of Object.entries({ serie: 'SP1', numeroInicial: '25', razaoSocial: 'Barbearia de teste',
    itemListaServico: '06.01', codigoMunicipal: '2658', logradouro: 'Rua teste', numero: '1', bairro: 'Centro',
    cep: '01001000', codigoCancelamento: '1' })) await page.locator('#municipal-'+campo).fill(valor);
  await page.locator('[name=serieExclusiva]').check();
  await page.locator('#municipal-habilitada').selectOption('1');
  await page.getByRole('button', { name: 'Salvar emissor municipal', exact: true }).click();
  await page.waitForURL(/feito=municipal-salvo/); await page.waitForLoadState('networkidle');
  const obterMunicipal = async () => {
    const r = await fetch(api+'/v1/admin/fiscal/municipal', { headers: { authorization: 'Bearer '+sessao.token } });
    assert.equal(r.status, 200); return r.json();
  };
  assert.equal((await obterMunicipal()).pronta, true);
  assert.equal((await obterMunicipal()).configuracao.numeroInicial, 25);
  await page.getByText('Configurar emissão municipal', { exact: true }).click();
  for (const width of [360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 950 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'overflow municipal '+width);
    await page.screenshot({ path: new URL('nfse-municipal-'+width+'.png', prints).pathname, fullPage: true });
  }
  await page.getByText('Certificado A1 cadastrado', { exact: true }).click();
  await page.locator('#nfse-arquivo').setInputFiles({ name: 'sintetico.pfx', mimeType: 'application/x-pkcs12', buffer: a1.pfx });
  await page.locator('#nfse-senha').fill(a1.senha);
  await page.getByRole('button', { name: 'Substituir certificado', exact: true }).click();
  await page.waitForURL(/emissor=municipal&feito=certificado-salvo/); await page.waitForLoadState('networkidle');
  await page.getByText('Certificado A1 cadastrado', { exact: true }).click();
  await page.getByText('Remover certificado', { exact: true }).click();
  await page.getByRole('button', { name: 'Remover desta unidade', exact: true }).click();
  await page.waitForURL(/feito=certificado-removido/); await page.waitForLoadState('networkidle');
  assert.equal((await situacao()).certificado, null);
  assert.match(page.url(), /emissor=municipal/);
  await abrirCadastro();
  await page.locator('#municipioIbge').fill('2927408');
  await page.getByRole('button', { name: 'Salvar cadastro fiscal', exact: true }).click();
  await page.waitForURL(/salvo=1/); await page.waitForLoadState('networkidle');
  await page.getByRole('link', { name: 'Emissor municipal', exact: true }).click();
  await page.waitForURL(/emissor=municipal/); await page.waitForLoadState('networkidle');
  assert.equal(await page.getByRole('button', { name: 'Salvar emissor municipal', exact: true }).count(), 0);
  assert.equal(await page.getByText(/Use o portal da prefeitura para este município/).isVisible(), true);
  assert.equal(await page.getByRole('link', { name: 'Emissor nacional', exact: true }).isVisible(), true);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ resultado: 'passou', cenarios: ['cadastro fiscal com CNPJ alfanumérico e máscara', 'configuração nacional', 'arquivo inválido', 'A1 com senha contendo espaços', 'Simples fora do DAS e retorno ao DAS com persistência', 'não optante com tributos obrigatórios e persistidos', 'configuração municipal com série exclusiva e número inicial', 'um formulário de emissor por vez', 'troca e remoção de A1 preservam aba municipal', 'município sem adaptador orienta portal e oferece retorno ao nacional', 'remoção', '360/390/768/1280 sem overflow'], redeFiscal: false }));
} finally { await browser.close(); await db.end(); await disconnect(); }
