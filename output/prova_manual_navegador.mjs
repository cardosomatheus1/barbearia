import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { signUpOwner } from '../packages/identity/dist/index.js';
import { disconnect } from '../packages/db/dist/index.js';
import { varrerAutomacoes, despacharAutomacoes } from '../packages/crm/dist/index.js';
const require = createRequire(import.meta.url); const { chromium } = require('playwright');
const { Client } = createRequire(new URL('../packages/db/package.json', import.meta.url))('pg');
assert.equal(new URL(process.env.DEMO_DATABASE_URL).hostname,'127.0.0.1');
assert.match(new URL(process.env.DEMO_DATABASE_URL).pathname,/^\/barbearia_manual_browser_[a-f0-9]+$/);
const db = new Client({ connectionString: process.env.DEMO_DATABASE_URL }); await db.connect();
const browser = await chromium.launch({ args:['--no-sandbox'] });
const prints = new URL('./PRINTS_CORRECOES_PRE_GO_LIVE/',import.meta.url); await mkdir(prints,{ recursive:true });
const resultados=[];
try {
  const cadastro = await signUpOwner({ name:'Operadora manual',email:'manual-browser@example.invalid',password:randomBytes(24).toString('base64url'),phone:'+5511988887777',businessName:'Barbearia Manual de Teste' });
  assert.ok(cadastro.created); const sessao=cadastro.session;
  const offset=12-new Date().getUTCHours(), timezone='Etc/GMT'+(offset>=0?'-':'+')+Math.abs(offset);
  await db.query('UPDATE locations SET timezone=$1 WHERE tenant_id=$2',[timezone,sessao.tenantId]);
  await db.query('UPDATE tenants SET published_at=now(),onboarding_step=6 WHERE id=$1',[sessao.tenantId]);
  const cliente=randomUUID(); await db.query(`INSERT INTO customers(id,tenant_id,name,phone_e164,accepts_marketing) VALUES($1,$2,'Cliente da Campanha','+5511988885555',true)`,[cliente,sessao.tenantId]);
  const context=await browser.newContext({viewport:{width:390,height:950}});
  await context.addCookies([{name:'gestor',value:sessao.token,domain:'127.0.0.1',path:'/admin',httpOnly:true,sameSite:'Strict',secure:false}]);
  const page=await context.newPage(); const erros=[]; page.on('pageerror', e=>erros.push(e.message)); page.on('response',r=>{if(r.status()>=500)erros.push('http '+r.status());});
  const sqlFila=async()=> (await db.query('SELECT status,sent_at,claimed_by FROM whatsapp_manual_queue ORDER BY created_at,id')).rows;
  await page.goto(process.env.WEB_URL+'/admin/whatsapp',{waitUntil:'networkidle'});
  await page.getByRole('link',{name:/Sem envio automático Manual/}).click();
  await page.getByRole('heading',{name:'WhatsApp manual',exact:true}).waitFor();
  await page.getByRole('button',{name:'Campanhas',exact:true}).click();
  await page.locator('#titulo-novo').fill('Convite manual');
  await page.locator('#texto-novo').fill('Olá {{99}}, variável inválida.');
  await page.getByRole('button',{name:'Salvar mensagem',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'Confira'}).waitFor();
  assert.equal(await page.locator('#texto-novo').inputValue(),'Olá {{99}}, variável inválida.');
  await page.locator('#texto-novo').fill('Olá {{1}}, vamos cortar o cabelo na {{2}}?');
  await page.getByRole('button',{name:'Salvar mensagem',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Mensagem salva'}).waitFor();
  await page.locator('#nome-campanhas').fill('Campanha operada pela recepção');
  await page.locator('#mensagem-campanhas').selectOption({label:'Convite manual'});
  await page.getByRole('button',{name:'Preparar campanha na fila',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Campanha preparada'}).waitFor();
  await page.getByRole('button',{name:'Fila',exact:true}).click();
  const item=page.locator('li').filter({has:page.getByRole('heading',{name:'Cliente da Campanha',exact:true})});
  await item.getByRole('button',{name:'Preparar envio',exact:true}).click();
  await item.getByRole('link',{name:'Abrir WhatsApp com a mensagem',exact:true}).waitFor();
  let fila=await sqlFila(); assert.equal(fila[0].status,'em_atendimento'); assert.equal(fila[0].sent_at,null);
  const link=await item.getByRole('link',{name:'Abrir WhatsApp com a mensagem',exact:true}).getAttribute('href');
  const url=new URL(link); assert.equal(url.hostname,'wa.me'); assert.equal(url.pathname,'/5511988885555'); assert.ok(url.searchParams.get('text').includes('Olá Cliente da Campanha'));
  // Navegação WhatsApp interceptada no navegador: não abre serviço externo nem envia mensagem real.
  let abertas=0; await context.route('https://wa.me/**',async route=>{abertas++;await route.fulfill({status:200,contentType:'text/html',body:'<p>Conversa sintética. Nenhum envio real.</p>'});});
  const popupPromise=context.waitForEvent('page'); await item.getByRole('link',{name:'Abrir WhatsApp com a mensagem',exact:true}).click();
  const popup=await popupPromise; await popup.waitForLoadState(); await popup.close(); assert.equal(abertas,1);
  assert.equal((await sqlFila())[0].sent_at,null,'Abrir link não pode confirmar envio');
  await page.reload({waitUntil:'networkidle'});
  await item.getByRole('button',{name:'Retomar conversa',exact:true}).click();
  await item.getByRole('link',{name:'Abrir WhatsApp com a mensagem',exact:true}).waitFor();
  assert.equal(await item.getByRole('link',{name:'Abrir WhatsApp com a mensagem',exact:true}).getAttribute('href'),link);
  for(const width of [360,390,768,1280]){
    await page.setViewportSize({width,height:950});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'overflow manual '+width);
    await page.evaluate(()=>{window.scrollTo(0,0);for(const e of document.querySelectorAll('*'))if(e.scrollTop)e.scrollTop=0;});await page.screenshot({path:new URL('manual-conversa-'+width+'.png',prints).pathname,fullPage:true});
  }
  await item.getByRole('button',{name:'Marcar como enviado',exact:true}).click();
  assert.equal((await sqlFila())[0].sent_at,null,'Abrir confirmação não pode marcar enviado');
  await item.getByRole('button',{name:'Sim, eu enviei',exact:true}).click();
  await page.getByRole('link',{name:'Ver histórico',exact:true}).click();
  await page.getByText('Envio confirmado por Operadora manual',{exact:true}).waitFor();
  assert.equal((await sqlFila())[0].status,'enviado'); resultados.push('campanha manual criada, aberta, retomada e confirmada pelo operador');
  const aniversario=randomUUID(); await db.query(`INSERT INTO customers(id,tenant_id,name,phone_e164,accepts_marketing,birth_date) VALUES($1,$2,'Cliente Aniversariante','+5511988884444',true,$3)`,[aniversario,sessao.tenantId,'1990-'+new Date().toISOString().slice(5,10)]);
  await page.getByRole('button',{name:'Lembretes',exact:true}).click();
  await page.locator('#nome-automacoes').fill('Aniversários manuais');await page.locator('#publico-automacoes').selectOption('aniversario');
  await page.locator('#mensagem-automacoes').selectOption({label:'Convite manual'});
  await page.getByRole('button',{name:'Ativar preparação da fila',exact:true}).click(); await page.getByRole('status').filter({hasText:'Preparação ativada'}).waitFor();
  await varrerAutomacoes({tenantId:sessao.tenantId,agora:new Date(),timeZone:timezone});
  let automaticos=0;await despacharAutomacoes({tenantId:sessao.tenantId,agora:new Date(),enviar:async()=>{automaticos++;}});assert.equal(automaticos,0);
  await page.getByRole('button',{name:'Pausar preparação',exact:true}).click();await page.getByRole('button',{name:'Retomar preparação',exact:true}).waitFor();
  await page.getByRole('button',{name:'Retomar preparação',exact:true}).click();await page.getByRole('button',{name:'Pausar preparação',exact:true}).waitFor();
  await page.getByText('Quantos dias antes (0 = no dia): 0',{exact:true}).waitFor();
  for(const [gatilho,nome,numero,resumo] of [
    ['pacote_acabando','Pacote manual','1','Quando faltarem quantas unidades: 1'],
    ['avaliacao_positiva','Avaliação positiva manual','4','A partir de quantas estrelas: 4'],
    ['avaliacao_negativa','Avaliação negativa manual','3','Até quantas estrelas: 3'],
  ]){
    await page.locator('#nome-automacoes').fill(nome);await page.locator('#publico-automacoes').selectOption(gatilho);
    await page.locator('#dias-automacoes').fill(numero);await page.locator('#mensagem-automacoes').selectOption({label:'Convite manual'});
    await page.getByRole('button',{name:'Ativar preparação da fila',exact:true}).click();
    const card=page.getByRole('heading',{name:nome+' · Preparando fila',exact:true}).locator('..');
    await card.getByText(resumo,{exact:true}).waitFor();assert.equal(await card.getByText(numero+' dias',{exact:false}).count(),0);
  }
  for(const width of [360,390,768,1280]){await page.setViewportSize({width,height:950});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.evaluate(()=>{window.scrollTo(0,0);for(const e of document.querySelectorAll('*'))if(e.scrollTop)e.scrollTop=0;});await page.screenshot({path:new URL('manual-limiares-'+width+'.png',prints).pathname,fullPage:true});}
  resultados.push('resumos preservam zero, unidades de pacote e estrelas de avaliação');
  await page.goto(process.env.WEB_URL+'/admin/whatsapp/manual',{waitUntil:'networkidle'});
  const aniversariante=page.locator('li').filter({has:page.getByRole('heading',{name:'Cliente Aniversariante',exact:true})});
  await aniversariante.getByText('Outras ações',{exact:true}).click();
  await aniversariante.getByRole('button',{name:'Cliente pediu para parar',exact:true}).click();
  await aniversariante.getByRole('button',{name:'Confirmar',exact:true}).click();
  await page.getByRole('link',{name:'Ver histórico',exact:true}).click();await page.getByText('Descartada, sem envio confirmado',{exact:true}).waitFor();
  assert.equal((await db.query('SELECT accepts_marketing FROM customers WHERE id=$1',[aniversario])).rows[0].accepts_marketing,false);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM whatsapp_messages')).rows[0].n,0);assert.equal((await db.query('SELECT count(*)::int AS n FROM whatsapp_baileys_outbox')).rows[0].n,0);
  resultados.push('automação manual criada, disparada sem provider, pausada, retomada e opt-out registrado');
  await page.evaluate(()=>{window.scrollTo(0,0);for(const e of document.querySelectorAll('*'))if(e.scrollTop)e.scrollTop=0;});await page.screenshot({path:new URL('manual-historico-1280.png',prints).pathname,fullPage:true});
  assert.deepEqual(erros,[]);console.log(JSON.stringify({resultado:'passou',cenarios:resultados,larguras:[360,390,768,1280],redeWhatsApp:false}));
}finally{await browser.close();await db.end();await disconnect();}
