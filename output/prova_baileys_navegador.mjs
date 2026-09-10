import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { signUpOwner } from '../packages/identity/dist/index.js';
import { disconnect } from '../packages/db/dist/index.js';
import { RuntimeBaileys, enviarNoCanalDaUnidade, despacharCampanha, varrerAutomacoes, despacharAutomacoes } from '../packages/crm/dist/index.js';
import { rodada, agendarAutomacaoDeTodas } from '../packages/jobs/dist/index.js';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { Client } = createRequire(new URL('../packages/db/package.json', import.meta.url))('pg');
assert.equal(new URL(process.env.DEMO_DATABASE_URL).hostname, '127.0.0.1');
assert.match(new URL(process.env.DEMO_DATABASE_URL).pathname, /^\/barbearia_baileys_browser_[a-f0-9]+$/);
const db = new Client({ connectionString: process.env.DEMO_DATABASE_URL }); await db.connect();
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const prints = new URL('./PRINTS_CORRECOES_PRE_GO_LIVE/', import.meta.url); await mkdir(prints, { recursive: true });
const sockets = []; const envios = [];
const runtime = new RuntimeBaileys({ async criar(_p, eventos) {
  const socket = { eventos, numero: () => '5511999992222:1@s.whatsapp.net',
    consultarNumero: async telefone => telefone.slice(1)+'@s.whatsapp.net',
    enviar: async (jid,texto,id) => {
      envios.push({ jid,texto,id });
      queueMicrotask(() => eventos.recibos([{ key: { remoteJid: jid,id,fromMe: true }, update: { status: 3 } }]));
    }, fechar: () => undefined,
    logout: async () => undefined };
  sockets.push(socket); queueMicrotask(() => eventos.conexao({ qr: 'QR-SINTETICO-SEM-VALOR-DE-PAREAMENTO' })); return socket;
} });
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
  const transmitir = async (d,origem) => {
    const enviado = await enviarNoCanalDaUnidade({ tenantId: sessao.tenantId, locationId: d.locationId,
      intentKey: `promo:${origem}:${d.id}`, customerId: d.customerId, telefone: d.telefone,
      templateId: d.templateId, tipo: d.tipo, promocional: true, variaveis: [d.clienteNome,d.barbearia] });
    assert.ok(enviado?.wamid); return enviado.wamid;
  };
  // Executa o consumidor real da fila (claim, handler e conclusão). O transporte
  // de WhatsApp continua sintético; isto não simula o processo main do worker.
  const consumir = async (kind, callbacks) => {
    const eventos = [];
    const resultado = await rodada({ relogio: { agora: () => new Date() }, ...callbacks },
      { quem: 'ensaio-baileys', aoEvento: evento => eventos.push(evento) });
    assert.deepEqual(resultado, { tomadas: 1, concluidas: 1, falhadas: 0, reagendadas: 0 });
    assert.deepEqual(eventos.map(e => [e.kind,e.fase]), [[kind,'inicio'],[kind,'concluida']]);
    const tarefa = (await db.query('SELECT status,attempts,claim_token FROM jobs WHERE id=$1', [eventos[0].tarefaId])).rows[0];
    assert.deepEqual(tarefa, { status: 'done', attempts: 1, claim_token: null });
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
  runtime.iniciar();
  await page.getByRole('button', { name: 'Gerar QR Code', exact: true }).click();
  await page.getByAltText('QR para conectar o WhatsApp desta unidade').waitFor({ timeout: 20_000 });
  await page.screenshot({ path: new URL('baileys-qr-sintetico-390.png',prints).pathname, fullPage: true });
  assert.equal(sockets.length,1);
  await db.query("UPDATE whatsapp_baileys_sessions SET pairing_until=now()-interval '1 second',qr_until=now()-interval '1 second'");
  await page.getByRole('button',{ name: 'Atualizar conexão',exact: true }).click();
  await page.getByText('Conecte novamente pelo celular',{ exact: true }).waitFor();
  assert.equal(await page.getByAltText('QR para conectar o WhatsApp desta unidade').count(),0);
  await page.getByRole('button',{ name: 'Gerar QR Code',exact: true }).click();
  await page.getByAltText('QR para conectar o WhatsApp desta unidade').waitFor({ timeout: 20_000 });
  assert.equal(sockets.length,2); sockets.at(-1).eventos.conexao({ connection: 'open' });
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
    await page.screenshot({ path: new URL('baileys-conectado-'+width+'.png',prints).pathname, fullPage: true });
  }
  const avulso = await cliente(false);
  await page.goto(process.env.WEB_URL+'/admin/cliente/'+avulso,{ waitUntil: 'networkidle' });
  await page.getByRole('button',{ name: 'Mandar',exact: true }).click();
  await page.waitForURL(/feito=|enviado=/); await page.waitForLoadState('networkidle');
  assert.equal(envios.length,1,'mensagem manual não transmitida');
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
      const ca = (await db.query('SELECT id,status FROM campaigns')).rows[0]; assert.equal(ca.status,'enviando');
      await consumir('campanha.enviar', { enviarCampanha: async (tenantId, campanhaId, agora) => {
        assert.equal(tenantId,sessao.tenantId); assert.equal(campanhaId,ca.id);
        const resultado = await despacharCampanha({ tenantId,campanhaId,agora,timeZone: timezone,
          enviar: alvo => transmitir(alvo,'campanha') });
        assert.equal(resultado.enviados,1);
      } });
      assert.equal(envios.length,2);
    } else {
      await cliente(true);
      await page.locator('#nome').fill('Aniversário por QR');
      await page.locator('input[name=gatilho][value=aniversario]').check(); await page.locator('#limiar').fill('0');
      await page.getByRole('button',{ name: 'Salvar automação',exact: true }).click(); await page.waitForURL(/feito=/); await page.waitForLoadState('networkidle');
      const a = (await db.query('SELECT active FROM automations')).rows[0]; assert.equal(a.active,true);
      assert.equal(await agendarAutomacaoDeTodas({ hora: new Date().toISOString().slice(0,13) }),1);
      await consumir('automacao.varrer', { rodarAutomacoes: async (tenantId, agora) => {
        assert.equal(tenantId,sessao.tenantId);
        await varrerAutomacoes({ tenantId,agora,timeZone: timezone });
        assert.equal(await despacharAutomacoes({ tenantId,agora,
          enviar: async d => { await transmitir(d,'automacao'); } }),1);
      } });
      assert.equal(envios.length,3);
    }
    await page.reload({ waitUntil: 'networkidle' });
    await page.screenshot({ path: new URL('baileys-'+caminho+'-1280.png',prints).pathname, fullPage: true });
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
  console.log(JSON.stringify({ resultado: 'passou', cenarios: ['seleção do canal','QR sintético','conexão','texto local','envio manual pela tela','campanha criada na tela e consumida pela fila real','automação criada na tela, agendada e consumida pela fila real','QR expirado','texto preservado em erro','quatro larguras','desconexão','retorno à Meta'], redeWhatsApp: false, processoMainWorker: false }));
} finally { await runtime.parar(); await browser.close(); await db.end(); await disconnect(); }
