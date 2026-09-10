import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { signUpOwner } from '../packages/identity/dist/index.js';
import { disconnect } from '../packages/db/dist/index.js';
import { agendarAutomacaoDeTodas } from '../packages/jobs/dist/index.js';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { Client } = createRequire(new URL('../packages/db/package.json', import.meta.url))('pg');
assert.equal(new URL(process.env.DEMO_DATABASE_URL).hostname, '127.0.0.1');
assert.match(new URL(process.env.DEMO_DATABASE_URL).pathname, /^\/barbearia_baileys_browser_[a-f0-9]+$/);
const db = new Client({ connectionString: process.env.DEMO_DATABASE_URL }); await db.connect();
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const prints = new URL('./PRINTS_CORRECOES_PRE_GO_LIVE/', import.meta.url); await mkdir(prints, { recursive: true });
// O processo main do worker, iniciado pelo wrapper Python, consome tudo.
const controle = async acao => {
  const resposta = await fetch('http://127.0.0.1:3482/'+acao, { method: 'POST' });
  assert.equal(resposta.status, 200); return resposta.json();
};
const esperarTarefa = async (kind, idempotencia = null) => {
  const limite = Date.now()+60_000;
  while (Date.now() < limite) {
    const tarefas = (await db.query('SELECT status,attempts,claim_token FROM jobs WHERE kind=$1 AND ($2::text IS NULL OR idempotency_key=$2)', [kind,idempotencia])).rows;
    assert.ok(!tarefas.some(t => t.status === 'failed'), 'tarefa falhou: '+kind);
    if (tarefas.some(t => t.status === 'done')) {
      assert.ok(tarefas.filter(t => t.status === 'done').every(t => t.attempts === 1 && t.claim_token === null));
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail('worker não concluiu '+kind);
};
try {
  const cadastro = await signUpOwner({ name: 'Operadora de teste', email: 'baileys@example.invalid',
    password: randomBytes(24).toString('base64url'), phone: '+5511999992222', businessName: 'Barbearia de Teste' });
  assert.ok(cadastro.created); const sessao = cadastro.session;
  const offset = 12-new Date().getUTCHours();
  const timezone = 'Etc/GMT'+(offset >= 0 ? '-' : '+')+Math.abs(offset);
  await db.query('UPDATE locations SET timezone=$1 WHERE tenant_id=$2',[timezone,sessao.tenantId]);
  let telefoneNumero = 5550;
  const cliente = async aniversario => {
    const id = randomUUID(); telefoneNumero++;
    await db.query(`INSERT INTO customers(id,tenant_id,name,phone_e164,accepts_marketing,birth_date)
      VALUES($1,$2,'Cliente sintético',$3,true,$4)`,[id,sessao.tenantId,'+551199999'+telefoneNumero,
      aniversario ? '1990-'+new Date().toISOString().slice(5,10) : null]);
    return id;
  };
  await db.query('UPDATE tenants SET published_at=now(), onboarding_step=6 WHERE id=$1', [sessao.tenantId]);
  const context = await browser.newContext({ viewport: { width: 390, height: 950 } });
  await context.addCookies([{ name: 'gestor', value: sessao.token, domain: '127.0.0.1', path: '/admin', httpOnly: true, sameSite: 'Strict', secure: false }]);
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', () => errors.push('erro de javascript'));
  page.on('response', r => { if (r.status() >= 500) errors.push('http ' + r.status()); });
  const situacao = async () => {
    const r = await fetch(process.env.API_URL+'/v1/admin/whatsapp/conexao', { headers: { authorization: 'Bearer '+sessao.token } });
    assert.equal(r.status,200); return r.json();
  };
  await page.goto(process.env.WEB_URL+'/admin/whatsapp', { waitUntil: 'networkidle' });
  await page.locator('#canal-whatsapp').selectOption('baileys');
  await page.getByRole('button', { name: 'Usar esta conexão', exact: true }).click();
  await page.getByRole('heading', { name: 'Mensagens por QR', exact: true }).waitFor();
  assert.equal((await situacao()).canal,'baileys');
  assert.equal(await page.getByRole('heading', { name: 'Textos aprovados', exact: true }).count(),0);
  await page.getByRole('button', { name: 'Gerar QR Code', exact: true }).click();
  await page.getByAltText('QR para conectar o WhatsApp desta unidade').waitFor({ timeout: 20_000 });
  await page.screenshot({ path: new URL('baileys-worker-qr-sintetico-390.png',prints).pathname, fullPage: true });
  assert.equal((await controle('estado')).sockets,1);
  await db.query("UPDATE whatsapp_baileys_sessions SET pairing_until=now()-interval '1 second',qr_until=now()-interval '1 second'");
  await page.getByRole('button',{ name: 'Atualizar conexão',exact: true }).click();
  await page.getByText('Conecte novamente pelo celular',{ exact: true }).waitFor();
  assert.equal(await page.getByAltText('QR para conectar o WhatsApp desta unidade').count(),0);
  await page.getByRole('button',{ name: 'Gerar QR Code',exact: true }).click();
  await page.getByAltText('QR para conectar o WhatsApp desta unidade').waitFor({ timeout: 20_000 });
  assert.equal((await controle('estado')).sockets,2); await controle('abrir');
  await page.getByText('Número conectado', { exact: true }).waitFor({ timeout: 20_000 });
  await page.locator('#titulo-nova').fill('Convite de retorno');
  assert.equal(await page.locator('#tipo-nova option[value=senha_de_acesso]').count(),0);
  await page.locator('#corpo-nova').fill('Olá {{99}}, texto com variável inválida.');
  await page.getByRole('button',{ name: 'Salvar mensagem',exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Confira' }).waitFor();
  assert.equal(await page.locator('#corpo-nova').inputValue(),'Olá {{99}}, texto com variável inválida.');
  assert.equal(await page.locator('#titulo-nova').inputValue(),'Convite de retorno');
  await page.locator('#corpo-nova').fill('Olá {{1}}, vamos marcar seu próximo corte na {{2}}?');
  await page.getByRole('button', { name: 'Salvar mensagem', exact: true }).click();
  await page.waitForURL(/feito=texto-local/); await page.waitForLoadState('networkidle');
  await page.getByText('Convite de retorno · Disponível', { exact: true }).waitFor();
  for (const width of [360,390,768,1280]) {
    await page.setViewportSize({ width, height: 950 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true,'overflow '+width);
    await page.screenshot({ path: new URL('baileys-worker-conectado-'+width+'.png',prints).pathname, fullPage: true });
  }
  const avulso = await cliente(false);
  await page.goto(process.env.WEB_URL+'/admin/cliente/'+avulso,{ waitUntil: 'networkidle' });
  await page.getByRole('button',{ name: 'Mandar',exact: true }).click();
  await page.waitForURL(/feito=|enviado=/); await page.waitForLoadState('networkidle');
  assert.equal((await controle('estado')).envios,1,'mensagem manual não transmitida');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM whatsapp_manual_send_intents WHERE status='enviado'")).rows[0].n,1);
  await cliente(false);
  for (const caminho of ['campanhas','automacoes']) {
    await page.goto(process.env.WEB_URL+'/admin/'+caminho, { waitUntil: 'networkidle' });
    const textoDaTela = await page.locator('body').innerText();
    assert.ok(textoDaTela.includes('Convite de retorno'),caminho+' não oferece texto local');
    assert.ok(!textoDaTela.includes('O WhatsApp da casa ainda não está pronto'), caminho+' ignora a conexão por QR');
    assert.ok(!textoDaTela.includes('a Meta aprova cada um'), caminho+' exige aprovação para texto local');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
    if (caminho === 'campanhas') {
      await page.locator('#nome').fill('Campanha por QR'); await page.locator('#filtro').selectOption('todos');
      await page.getByRole('button',{ name: 'Criar campanha',exact: true }).click(); await page.waitForLoadState('networkidle');
      await page.getByText('Enviar para 2',{ exact: true }).click();
      await page.getByRole('button',{ name: 'Confirmar e enviar',exact: true }).click(); await page.waitForURL(/feito=enviando/); await page.waitForLoadState('networkidle');
      const ca = (await db.query('SELECT id,status FROM campaigns')).rows[0]; assert.ok(['enviando','enviada'].includes(ca.status));
      await esperarTarefa('campanha.enviar');
      assert.equal((await controle('estado')).envios,2);
    } else {
      const aniversariante = await cliente(true);
      await page.locator('#nome').fill('Aniversário por QR');
      await page.locator('input[name=gatilho][value=aniversario]').check(); await page.locator('#limiar').fill('0');
      await page.getByRole('button',{ name: 'Salvar automação',exact: true }).click(); await page.waitForURL(/feito=/); await page.waitForLoadState('networkidle');
      const a = (await db.query('SELECT active FROM automations')).rows[0]; assert.equal(a.active,true);
      const horaDoEnsaio = 'ensaio-'+randomUUID();
      assert.equal(await agendarAutomacaoDeTodas({ hora: horaDoEnsaio }),1);
      await esperarTarefa('automacao.varrer', 'automacao:'+sessao.tenantId+':'+horaDoEnsaio);
      assert.equal((await controle('estado')).envios,3);
      await controle('parar');
      const limiteOptout = Date.now()+10_000;
      while ((await db.query('SELECT accepts_marketing FROM customers WHERE id=$1',[aniversariante])).rows[0].accepts_marketing) {
        assert.ok(Date.now()<limiteOptout,'worker não aplicou a saída das promoções');
        await new Promise(resolve => setTimeout(resolve,100));
      }
    }
    await page.reload({ waitUntil: 'networkidle' });
    await page.screenshot({ path: new URL('baileys-worker-'+caminho+'-1280.png',prints).pathname, fullPage: true });
  }
  await page.goto(process.env.WEB_URL+'/admin/whatsapp', { waitUntil: 'networkidle' });
  await page.getByText('Desconectar ou trocar número', { exact: true }).click();
  await page.getByRole('button', { name: 'Desconectar número', exact: true }).click();
  await page.getByText('Número desconectado', { exact: true }).waitFor();
  assert.equal((await situacao()).baileys.qr,null);
  await page.locator('#canal-whatsapp').selectOption('meta');
  await page.getByRole('button', { name: 'Usar esta conexão', exact: true }).click();
  await page.getByRole('heading', { name: 'Textos aprovados', exact: true }).waitFor();
  assert.equal((await situacao()).canal,'meta'); assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ resultado: 'passou', cenarios: ['seleção do canal','QR sintético','conexão','texto local','envio manual pela tela','campanha criada na tela e consumida pela fila real','automação criada na tela, agendada e consumida pela fila real','QR expirado','texto preservado em erro','quatro larguras','desconexão','retorno à Meta','PARAR recebido pelo worker revoga marketing'], redeWhatsApp: false, processoMainWorker: true, factoryReal: true, bibliotecaAuthReal: true }));
} finally { await browser.close(); await db.end(); await disconnect(); }
