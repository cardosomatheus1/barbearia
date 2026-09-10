import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes,randomUUID } from 'node:crypto';
import { mkdir,readFile } from 'node:fs/promises';
import { signUpOwner } from '../packages/identity/dist/index.js';
import { disconnect } from '../packages/db/dist/index.js';
const require=createRequire(import.meta.url),{chromium}=require('playwright');const {Client}=createRequire(new URL('../packages/db/package.json',import.meta.url))('pg');
assert.equal(new URL(process.env.DEMO_DATABASE_URL).hostname,'127.0.0.1');assert.match(new URL(process.env.DEMO_DATABASE_URL).pathname,/^\/barbearia_consentimento_browser_/);
const db=new Client({connectionString:process.env.DEMO_DATABASE_URL});await db.connect();const browser=await chromium.launch({args:['--no-sandbox']});
const prints=new URL('./PRINTS_CORRECOES_PRE_GO_LIVE/',import.meta.url);await mkdir(prints,{recursive:true});
try{
  const c=await signUpOwner({name:'Responsável sintético',email:'consentimento-browser@example.invalid',password:randomBytes(24).toString('base64url'),phone:'+5511988881000',businessName:'Barbearia Cadastro de Teste'});assert.ok(c.created);const sessao=c.session;
  const local=(await db.query('SELECT id FROM locations WHERE tenant_id=$1',[sessao.tenantId])).rows[0].id;const prof=randomUUID(),servico=randomUUID();
  await db.query('UPDATE tenants SET published_at=now(),onboarding_step=6 WHERE id=$1',[sessao.tenantId]);
  await db.query(`INSERT INTO professionals(id,tenant_id,location_id,name,kind) VALUES($1,$2,$3,'Profissional de teste','professional')`,[prof,sessao.tenantId,local]);
  await db.query(`INSERT INTO services(id,tenant_id,name,price_cents,duration_minutes) VALUES($1,$2,'Corte',5000,30)`,[servico,sessao.tenantId]);
  await db.query(`INSERT INTO professional_services(tenant_id,professional_id,service_id) VALUES($1,$2,$3)`,[sessao.tenantId,prof,servico]);
  await db.query(`INSERT INTO work_schedules(tenant_id,professional_id,weekday,start_minute,end_minute) SELECT $1,$2,d,480,1080 FROM generate_series(0,6) d`,[sessao.tenantId,prof]);
  // O cache de perfil do Next persiste entre bancos efêmeros; um slug exclusivo
  // impede que outro ensaio com o mesmo nome devolva IDs do banco já destruído.
  const slug='consentimento-'+randomUUID().replaceAll('-','').slice(0,12);
  await db.query('UPDATE tenant_slugs SET slug=$1 WHERE tenant_id=$2 AND is_primary',[slug,sessao.tenantId]);
  const amanha=new Date();amanha.setUTCDate(amanha.getUTCDate()+2);const date=amanha.toISOString().slice(0,10);
  const context=await browser.newContext({viewport:{width:390,height:950}}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=500)errors.push('HTTP '+r.status());});
  const caminho=hora=>process.env.WEB_URL+'/'+slug+'/agendar?'+new URLSearchParams({s:servico,p:prof,d:date,h:hora,e:'d'});
  const label='Aceito receber pelo WhatsApp confirmações, lembretes e novidades da Barbearia Cadastro de Teste.';
  await page.goto(caminho('09:00'),{waitUntil:'networkidle'});const checkbox=page.getByRole('checkbox',{name:label,exact:true});assert.equal(await checkbox.isChecked(),false);
  await page.locator('#nome').fill('Cliente Público');await page.locator('#celular').fill('(11) 98888-4444');
  await page.getByRole('button',{name:'Confirmar agendamento',exact:true}).click();await page.waitForURL(/agendado\//);
  assert.equal((await db.query('SELECT count(*)::int n FROM appointments')).rows[0].n,1);assert.equal((await db.query('SELECT count(*)::int n FROM customer_marketing_requests')).rows[0].n,0);
  assert.equal(await page.getByRole('link',{name:'Confirmar meu WhatsApp',exact:true}).count(),0);
  await db.query(`INSERT INTO customer_consents(tenant_id,customer_id,purpose,granted,text_version) SELECT tenant_id,id,'marketing',false,'revogado-anteriormente' FROM customers WHERE tenant_id=$1`,[sessao.tenantId]);
  await page.goto(caminho('10:00'),{waitUntil:'networkidle'});assert.equal(await checkbox.isChecked(),false);
  await page.locator('#nome').fill('Cliente Público');await page.locator('#celular').fill('(11) 98888-4444');await checkbox.check();
  for(const width of [360,390,768,1280]){await page.setViewportSize({width,height:950});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:new URL('consentimento-cadastro-'+width+'.png',prints).pathname,fullPage:true});}
  await page.getByRole('button',{name:'Confirmar agendamento',exact:true}).click();await page.waitForURL(/agendado\//);await page.getByRole('link',{name:'Confirmar meu WhatsApp',exact:true}).waitFor();
  assert.equal((await db.query('SELECT accepts_marketing FROM customers WHERE tenant_id=$1',[sessao.tenantId])).rows[0].accepts_marketing,false);
  await page.getByRole('link',{name:'Confirmar meu WhatsApp',exact:true}).click();await page.waitForURL(/entrar\?/);
  await page.locator('#celular').fill('(11) 98888-4444');await page.getByRole('button',{name:'Receber código',exact:true}).click();await page.waitForURL(/e=codigo/);
  const otp=JSON.parse(await readFile(process.env.CONSENTIMENTO_ENSAIO_OTP,'utf8'));assert.equal(otp.phone,'+5511988884444');await page.locator('#codigo').fill(otp.code);
  await page.getByRole('button',{name:'Entrar',exact:true}).click();await page.waitForURL(/consentimento-whatsapp$/);await page.getByRole('button',{name:'Confirmar meu aceite',exact:true}).waitFor();
  assert.equal((await db.query('SELECT accepts_marketing FROM customers WHERE tenant_id=$1',[sessao.tenantId])).rows[0].accepts_marketing,false,'OTP sozinho não altera a preferência');
  await page.screenshot({path:new URL('consentimento-pos-otp-1280.png',prints).pathname,fullPage:true});
  // Mantidos só em memória: simulam a resposta perdida antes de o navegador
  // receber a remoção do cookie. A segunda aba conserva o formulário antigo.
  const cookiePedido=(await context.cookies()).find(c=>c.name==='wa_cadastro_'+slug);assert.ok(cookiePedido);
  const abaAntiga=await context.newPage();await abaAntiga.goto(process.env.WEB_URL+'/'+slug+'/consentimento-whatsapp',{waitUntil:'networkidle'});
  await abaAntiga.getByRole('button',{name:'Confirmar meu aceite',exact:true}).waitFor();
  await page.getByRole('button',{name:'Confirmar meu aceite',exact:true}).click();await page.waitForURL(/meus-agendamentos\?feito=aceitou/);
  const registros=(await db.query(`SELECT text_snapshot,verification_method,requested_at,requested_ip,ip,granted FROM customer_consents WHERE granted AND purpose='marketing'`)).rows;
  assert.equal(registros.length,1);assert.equal(registros[0].text_snapshot,label);assert.equal(registros[0].verification_method,'sessao_otp');assert.ok(registros[0].requested_at);assert.ok(registros[0].requested_ip);assert.ok(registros[0].ip);
  assert.equal((await db.query('SELECT accepts_marketing FROM customers WHERE tenant_id=$1',[sessao.tenantId])).rows[0].accepts_marketing,true);assert.deepEqual(errors,[]);
  await page.getByRole('button',{name:'Não quero mais: Promoções por WhatsApp',exact:true}).click();
  await page.getByRole('button',{name:'Autorizar: Promoções por WhatsApp',exact:true}).waitFor();
  const antesDoReplay=(await db.query('SELECT count(*)::int n FROM customer_consents')).rows[0].n;
  await context.addCookies([cookiePedido]);
  await abaAntiga.getByRole('button',{name:'Confirmar meu aceite',exact:true}).click();await abaAntiga.waitForURL(/meus-agendamentos\?feito=aceite_anterior/);
  await abaAntiga.getByText('Esta escolha já havia sido confirmada.',{exact:false}).waitFor();
  assert.equal(await abaAntiga.getByText('você vai receber as promoções desta barbearia.',{exact:false}).count(),0);
  await abaAntiga.getByRole('button',{name:'Autorizar: Promoções por WhatsApp',exact:true}).waitFor();
  await context.addCookies([cookiePedido]);
  await page.goto(process.env.WEB_URL+'/'+slug+'/consentimento-whatsapp',{waitUntil:'networkidle'});
  await page.getByText('Esta escolha já foi confirmada anteriormente.',{exact:false}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Confirmar meu aceite',exact:true}).count(),0);
  for(const width of [360,390,768,1280]){await page.setViewportSize({width,height:950});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:new URL('consentimento-repetido-'+width+'.png',prints).pathname,fullPage:true});}
  await page.getByRole('link',{name:'Ver minhas preferências',exact:true}).click();await page.waitForURL(/meus-agendamentos$/);
  assert.equal((await db.query('SELECT count(*)::int n FROM customer_consents')).rows[0].n,antesDoReplay);
  assert.equal((await db.query('SELECT accepts_marketing FROM customers WHERE tenant_id=$1',[sessao.tenantId])).rows[0].accepts_marketing,false);
  await abaAntiga.close();
  const fallback=await browser.newContext({viewport:{width:390,height:950}}),falha=await fallback.newPage();
  falha.on('pageerror',e=>errors.push(e.message));falha.on('response',r=>{if(r.status()>=500)errors.push('HTTP '+r.status());});
  await db.query('ALTER TABLE customer_marketing_requests ADD CONSTRAINT ensaio_indisponivel CHECK (false) NOT VALID');
  try {
    await falha.goto(caminho('11:00'),{waitUntil:'networkidle'});
    await falha.locator('#nome').fill('Cliente da falha sintética');await falha.locator('#celular').fill('(11) 98888-5555');
    await falha.getByRole('checkbox',{name:label,exact:true}).check();
    await falha.getByRole('button',{name:'Confirmar agendamento',exact:true}).click();await falha.waitForURL(/agendado\/.*whatsapp=pendente/);
    await falha.getByText('Não conseguimos guardar sua escolha sobre novidades por WhatsApp.',{exact:false}).waitFor();
    assert.equal((await db.query('SELECT count(*)::int n FROM appointments')).rows[0].n,3);
    assert.equal((await db.query("SELECT accepts_marketing FROM customers WHERE phone_e164='+5511988885555'")).rows[0].accepts_marketing,false);
    for(const width of [360,390,768,1280]){await falha.setViewportSize({width,height:950});assert.equal(await falha.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await falha.screenshot({path:new URL('consentimento-fallback-'+width+'.png',prints).pathname,fullPage:true});}
    await falha.getByRole('link',{name:'Escolher minhas preferências',exact:true}).click();await falha.waitForURL(/entrar/);
    await falha.locator('#celular').fill('(11) 98888-5555');await falha.getByRole('button',{name:'Receber código',exact:true}).click();await falha.waitForURL(/e=codigo/);
    const codigo=JSON.parse(await readFile(process.env.CONSENTIMENTO_ENSAIO_OTP,'utf8'));assert.equal(codigo.phone,'+5511988885555');
    await falha.locator('#codigo').fill(codigo.code);await falha.getByRole('button',{name:'Entrar',exact:true}).click();await falha.waitForURL(/meus-agendamentos/);
    assert.equal((await db.query("SELECT accepts_marketing FROM customers WHERE phone_e164='+5511988885555'")).rows[0].accepts_marketing,false);
  } finally {await db.query('ALTER TABLE customer_marketing_requests DROP CONSTRAINT ensaio_indisponivel');await fallback.close();}
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({resultado:'passou',cenarios:['checkbox opcional e desmarcado','nome dinâmico da casa','agenda sem opt-in','telefone existente revogado não reativado pelo cadastro','OTP com transporte sintético','confirmação explícita autenticada','texto, versão, datas e IP registrados','replay após revogação mantém preferência e não anuncia ativação','token consumido mostra preferência atual sem novo botão de aceite','falha de intenção preserva agendamento e oferece preferências','recuperação acessível após OTP'],larguras:[360,390,768,1280],redeWhatsApp:false}));
}finally{await browser.close();await db.end();await disconnect();}
