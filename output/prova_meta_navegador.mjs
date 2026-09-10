import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes,randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { signUpOwner,cifrarCom } from '../packages/identity/dist/index.js';
import { disconnect } from '../packages/db/dist/index.js';
import { FakeWhatsAppProvider } from '../packages/core/dist/index.js';
import { despacharCampanha,enviarPeloWhatsApp,varrerAutomacoes,despacharAutomacoes,registrarEstadoDaMensagem } from '../packages/crm/dist/index.js';
const require=createRequire(import.meta.url);const {chromium}=require('playwright');const {Client}=createRequire(new URL('../packages/db/package.json',import.meta.url))('pg');
assert.equal(new URL(process.env.DEMO_DATABASE_URL).hostname,'127.0.0.1');assert.match(new URL(process.env.DEMO_DATABASE_URL).pathname,/^\/barbearia_meta_browser_/);
const db=new Client({connectionString:process.env.DEMO_DATABASE_URL});await db.connect();const browser=await chromium.launch({args:['--no-sandbox']});
const prints=new URL('./PRINTS_CORRECOES_PRE_GO_LIVE/',import.meta.url);await mkdir(prints,{recursive:true});
try{
  const c=await signUpOwner({name:'Operadora Meta',email:'meta-browser@example.invalid',password:randomBytes(24).toString('base64url'),phone:'+5511988880000',businessName:'Barbearia Meta de Teste'});assert.ok(c.created);const sessao=c.session;
  const local=(await db.query('SELECT id FROM locations WHERE tenant_id=$1',[sessao.tenantId])).rows[0].id;
  const offset=12-new Date().getUTCHours(),timezone='Etc/GMT'+(offset>=0?'-':'+')+Math.abs(offset);
  await db.query('UPDATE locations SET timezone=$1 WHERE id=$2',[timezone,local]);await db.query('UPDATE tenants SET published_at=now(),onboarding_step=6 WHERE id=$1',[sessao.tenantId]);
  await db.query(`INSERT INTO whatsapp_settings(location_id,tenant_id,status,phone_number_id,waba_id,display_phone,access_token_cipher) VALUES($1,$2,'ativo','numero-sintetico','waba-sintetica','+55 11 98888-0000',$3)`,[local,sessao.tenantId,cifrarCom('WHATSAPP_TOKEN_KEY','token-sintetico-sem-valor')]);
  const context=await browser.newContext({viewport:{width:390,height:950}});await context.addCookies([{name:'gestor',value:sessao.token,domain:'127.0.0.1',path:'/admin',httpOnly:true,sameSite:'Strict',secure:false}]);
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=500)errors.push('HTTP '+r.status());});
  await db.query("UPDATE whatsapp_settings SET status='aguardando_verificacao' WHERE location_id=$1",[local]);
  await page.goto(process.env.WEB_URL+'/admin/whatsapp',{waitUntil:'networkidle'});
  const escolha=page.getByRole('navigation',{name:'Modo do WhatsApp',exact:true});
  assert.equal(await escolha.getByRole('link').count(),3);
  assert.ok((await escolha.getByRole('link',{name:/Recomendado · oficial Meta/}).innerText()).includes('custos'));
  assert.ok((await escolha.getByRole('link',{name:/Alternativa não oficial Baileys/}).innerText()).includes('banimento'));
  assert.ok((await escolha.getByRole('link',{name:/Sem envio automático Manual/}).innerText()).includes('marca como enviado'));
  await page.getByRole('heading',{name:'Passo a passo do cadastro na Meta',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Conectar pela Meta',exact:true}).isVisible(),true);
  assert.equal(await page.locator('#token').isVisible(),false,'Credenciais avançadas ficam recolhidas');
  const orientacao=await page.locator('main').innerText();
  if(process.env.WHATSAPP_ONBOARDING === 'coexistencia'){ assert.ok(orientacao.includes('O número continua funcionando no seu WhatsApp Business')); assert.ok(!orientacao.includes('chip dedicado')); }
  else assert.ok(orientacao.includes('chip dedicado'));
  for(const width of [360,390,768,1280]){
    await page.setViewportSize({width,height:950}); assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:new URL('whatsapp-escolha-meta-'+(process.env.WHATSAPP_ONBOARDING === 'coexistencia' ? 'coexistencia-' : '')+width+'.png',prints).pathname,fullPage:true});
  }
  await page.getByText('Criar mensagem para aprovação',{exact:true}).click();
  await page.locator('#titulo').fill('Convite aguardando aprovação');
  await page.locator('#tipo').selectOption('confirmacao');
  await page.getByText('Adicionar botões à mensagem (opcional)',{exact:true}).click();
  await page.locator('input[name=botoes][value=confirmar]').check();
  await page.locator('#tipo').selectOption('retorno');
  assert.equal(await page.locator('input[name=botoes][value=confirmar]').count(),0,'Botão de confirmar não pertence a convite de retorno');
  assert.equal(await page.locator('input[name=botoes]:checked').count(),0,'Trocar aviso limpa escolhas incompatíveis');
  await page.locator('#corpo').fill('Olá {{1}}, vamos marcar na {{2}}?');
  assert.ok((await page.locator('#corpo').locator('..').innerText()).includes('nome da barbearia'));
  for(const width of [390,1280]){await page.setViewportSize({width,height:950});await page.screenshot({path:new URL('meta-editor-'+width+'.png',prints).pathname,fullPage:true});}
  await page.getByRole('button',{name:'Mandar para aprovação',exact:true}).click();
  await page.waitForURL(/feito=template/);
  const submetido=(await db.query("SELECT status,kind,buttons FROM whatsapp_templates WHERE titulo='Convite aguardando aprovação'")).rows[0];
  assert.deepEqual(submetido,{status:'pendente',kind:'retorno',buttons:[]});
  await db.query("UPDATE whatsapp_settings SET status='ativo' WHERE location_id=$1",[local]);
  await page.goto(process.env.WEB_URL+'/admin/campanhas',{waitUntil:'networkidle'});
  assert.ok((await page.locator('body').innerText()).includes('Envio automático · Meta'));assert.equal(await page.locator('input[name=templateId]').count(),0);
  const template=randomUUID();await db.query(`INSERT INTO whatsapp_templates(id,tenant_id,location_id,kind,name,titulo,status,body) VALUES($1,$2,$3,'retorno','convite_meta','Convite aprovado Meta','aprovado','Olá {{1}}, volte para a {{2}}!')`,[template,sessao.tenantId,local]);
  await db.query(`INSERT INTO customers(tenant_id,name,phone_e164,accepts_marketing) VALUES($1,'Cliente Meta','+5511988881111',true)`,[sessao.tenantId]);
  const provider=new FakeWhatsAppProvider();const enviar=async alvo=>{
    const r=await enviarPeloWhatsApp({tenantId:sessao.tenantId,locationId:alvo.locationId,customerId:alvo.customerId,telefone:alvo.telefone,tipo:alvo.tipo,templateId:alvo.templateId,variaveis:[alvo.clienteNome,alvo.barbearia],promocional:true,provider});assert.ok(r);return r.wamid;
  };
  await page.reload({waitUntil:'networkidle'});await page.locator('#nome').fill('Campanha Meta');await page.locator('#filtro').selectOption('todos');
  await page.getByRole('button',{name:'Criar campanha',exact:true}).click();await page.waitForURL(/feito=criada/);await page.waitForLoadState('networkidle');
  await page.getByText('Enviar para 1',{exact:true}).click();await page.getByRole('button',{name:'Confirmar e enviar',exact:true}).click();await page.waitForURL(/feito=enviando/);
  const ca=(await db.query('SELECT id FROM campaigns')).rows[0].id;assert.equal((await despacharCampanha({tenantId:sessao.tenantId,campanhaId:ca,agora:new Date(),timeZone:timezone,enviar})).enviados,1);
  assert.equal(provider.enviadas.length,1);await page.reload({waitUntil:'networkidle'});
  let metricas=await (await fetch(process.env.API_URL+'/v1/admin/campanhas',{headers:{authorization:'Bearer '+sessao.token}})).json();assert.equal(metricas.campanhas[0].entregues,0);assert.equal(metricas.campanhas[0].lidos,0);
  await registrarEstadoDaMensagem({tenantId:sessao.tenantId,wamid:'wamid.fake.1',estado:'entregue'});await registrarEstadoDaMensagem({tenantId:sessao.tenantId,wamid:'wamid.fake.1',estado:'lida'});
  await page.reload({waitUntil:'networkidle'});metricas=await (await fetch(process.env.API_URL+'/v1/admin/campanhas',{headers:{authorization:'Bearer '+sessao.token}})).json();assert.equal(metricas.campanhas[0].entregues,1);assert.equal(metricas.campanhas[0].lidos,1);
  for(const width of [360,390,768,1280]){await page.setViewportSize({width,height:950});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:new URL('meta-campanha-'+width+'.png',prints).pathname,fullPage:true});}
  await db.query(`INSERT INTO customers(tenant_id,name,phone_e164,accepts_marketing,birth_date) VALUES($1,'Aniversariante Meta','+5511988882222',true,$2)`,[sessao.tenantId,'1990-'+new Date().toISOString().slice(5,10)]);
  await page.goto(process.env.WEB_URL+'/admin/automacoes',{waitUntil:'networkidle'});await page.locator('#nome').fill('Aniversário Meta');await page.locator('input[name=gatilho][value=aniversario]').check();await page.locator('#limiar').fill('0');
  await page.getByRole('button',{name:'Salvar automação',exact:true}).click();await page.waitForURL(/feito=/);await varrerAutomacoes({tenantId:sessao.tenantId,agora:new Date(),timeZone:timezone});
  assert.equal(await despacharAutomacoes({tenantId:sessao.tenantId,agora:new Date(),enviar:async d=>{await enviar(d);}}),1);assert.equal(provider.enviadas.length,2);
  await db.query(`UPDATE whatsapp_templates SET status='rejeitado',rejection_reason='Recusa sintética' WHERE id=$1`,[template]);
  await page.reload({waitUntil:'networkidle'});assert.ok((await page.locator('body').innerText()).includes('a mensagem escolhida não está disponível nesta conexão'));
  await page.screenshot({path:new URL('meta-automacao-texto-indisponivel-1280.png',prints).pathname,fullPage:true});assert.deepEqual(errors,[]);
  console.log(JSON.stringify({resultado:'passou',cenarios:['escolha de três modos e riscos/custos','cadastro Meta passo a passo com campos técnicos recolhidos','editor filtra botões e submete mensagem à fila','sem texto aprovado','campanha criada e consumida pelo domínio real','aceitação distinta de entrega/leitura','automação de aniversário','texto indisponível com orientação'],larguras:[360,390,768,1280],redeMeta:false,transporte:'FakeWhatsAppProvider'}));
}finally{await browser.close();await db.end();await disconnect();}
