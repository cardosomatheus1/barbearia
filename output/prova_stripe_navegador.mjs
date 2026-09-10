import assert from 'node:assert/strict';
import { randomBytes,randomUUID,createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { signUpOwner } from '../packages/identity/dist/index.js';
import { disconnect } from '../packages/db/dist/index.js';
const require=createRequire(import.meta.url); const { chromium }=require('playwright');
const { Client }=createRequire(new URL('../packages/db/package.json',import.meta.url))('pg');
assert.equal(new URL(process.env.DEMO_DATABASE_URL).hostname,'127.0.0.1');
assert.match(new URL(process.env.DEMO_DATABASE_URL).pathname,/^\/barbearia_stripe_browser_[a-f0-9]+$/);
const db=new Client({ connectionString:process.env.DEMO_DATABASE_URL }); await db.connect();
const browser=await chromium.launch({ args:['--no-sandbox'] });
function inteiroNaHorizontal(el) {
  const r=el.getBoundingClientRect();let esquerda=0,direita=innerWidth;
  for(let p=el.parentElement;p;p=p.parentElement){
    if(getComputedStyle(p).overflowX!=='visible'){
      const limite=p.getBoundingClientRect();esquerda=Math.max(esquerda,limite.left);direita=Math.min(direita,limite.right);
    }
  }
  return r.left>=esquerda-1&&r.right<=direita+1;
}
try {
  const cadastro=await signUpOwner({ name:'Dono sintético',email:'stripe@example.invalid',password:randomBytes(24).toString('base64url'),
    phone:'+5511999998888',businessName:'Barbearia de Teste' }); assert.ok(cadastro.created); const sessao=cadastro.session;
  await db.query('UPDATE tenants SET published_at=now(),onboarding_step=6 WHERE id=$1',[sessao.tenantId]);
  const faturaId=randomUUID();
  await db.query(`INSERT INTO invoices(id,tenant_id,kind,plan_code,amount_cents,period_start,period_end,due_at,psp_charge_id)
    VALUES ($1,$2,'proration','pro',4900,now(),now()+interval '1 day',now(),'pi_browser')`,[faturaId,sessao.tenantId]);
  await db.query(`INSERT INTO billing_customers(tenant_id,psp_customer_id,psp_method_id,last4) VALUES($1,'cus_browser','pm_browser','4242')`,[sessao.tenantId]);
  await db.query('CREATE TABLE audit_stripe_respostas(tenant_id uuid,fatura_id uuid,estado text)');
  await db.query("INSERT INTO audit_stripe_respostas VALUES($1,$2,'requires_payment_method')",[sessao.tenantId,faturaId]);
  const context=await browser.newContext({ viewport:{ width:390,height:950 } });
  await context.addCookies([{ name:'gestor',value:sessao.token,domain:'127.0.0.1',path:'/admin',httpOnly:true,sameSite:'Strict',secure:false }]);
  const page=await context.newPage(); const falhas=[];
  page.on('pageerror',()=>falhas.push('javascript'));
  await context.route('https://js.stripe.com/v3/',r=>r.fulfill({ contentType:'application/javascript',body:`
    window.__confirmacoes=[]; window.Stripe=key=>({ confirmCardPayment:async(secret,dados)=>{
      window.__confirmacoes.push({key,secret,dados});
      return window.__confirmacoes.length===1 ? {error:{message:'Recusa sintética'}} : {paymentIntent:{status:'succeeded'}};
    }});
  ` }));
  const situacao=async()=>(await db.query('SELECT status FROM invoices WHERE id=$1',[faturaId])).rows[0].status;
  await page.goto(process.env.WEB_URL+'/admin/plano',{ waitUntil:'networkidle' });
  const verificar=page.getByRole('button',{ name:'Verificar cobrança',exact:true });
  await verificar.click(); await page.getByText('O banco não confirmou. Tente novamente ou confira o cartão cadastrado.',{ exact:true }).waitFor();
  assert.equal(await situacao(),'open');
  await verificar.click(); await page.getByText('Confirmação recebida. A fatura será atualizada após a conferência do pagamento.',{ exact:true }).waitFor();
  assert.equal(await situacao(),'open','SDK do navegador não quita a fatura');
  const confirmacoes=await page.evaluate(()=>window.__confirmacoes);
  assert.equal(confirmacoes.length,2); for(const c of confirmacoes) assert.deepEqual(c,{key:'pk_test_sintetico',secret:'pi_browser_secret_sintetico',dados:{payment_method:'pm_browser'}});
  for(const width of [360,390,768,1280]) {
    await page.setViewportSize({ width,height:950 });
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'overflow '+width);
    await page.screenshot({ path:new URL('./PRINTS_CORRECOES_PRE_GO_LIVE/stripe-autenticacao-'+width+'.png',import.meta.url).pathname,fullPage:true });
    // O painel tem rolagem interna; fullPage sozinho mostra o topo do plano.
    // Registrar também o componente que acabou de exercer a confirmação.
    await verificar.scrollIntoViewIfNeeded();
    const valor=page.getByText(/^R\$\s49,00$/);
    assert.equal(await valor.evaluate(inteiroNaHorizontal),true,'o valor completo precisa acompanhar a confirmação em '+width);
    if(width===360){
      // Prova negativa do instrumento: valor fora do recorte precisa reprovar.
      await valor.evaluate(el=>{el.style.transform='translateX(-100vw)';});
      assert.equal(await valor.evaluate(inteiroNaHorizontal),false,'o conferidor precisa detectar valor cortado');
      await valor.evaluate(el=>{el.style.removeProperty('transform');});
    }
    await page.screenshot({ path:new URL('./PRINTS_CORRECOES_PRE_GO_LIVE/stripe-cobranca-'+width+'.png',import.meta.url).pathname });
  }
  await db.query("UPDATE audit_stripe_respostas SET estado='succeeded'");
  const cru=JSON.stringify({id:'evt_browser',type:'payment_intent.succeeded',data:{object:{id:'pi_browser',metadata:{tenant_id:sessao.tenantId,fatura_id:faturaId}}}});
  const tempo=Math.floor(Date.now()/1000); const assinatura=createHmac('sha256',process.env.STRIPE_WEBHOOK_SECRET).update(`${tempo}.${cru}`).digest('hex');
  const res=await fetch(process.env.API_URL+'/v1/webhooks/stripe',{method:'POST',headers:{'content-type':'application/json','stripe-signature':`t=${tempo},v1=${assinatura}`},body:cru});
  assert.equal(res.status,201); assert.equal(await situacao(),'paid');
  await page.reload({waitUntil:'networkidle'}); assert.equal(await verificar.count(),0); assert.deepEqual(falhas,[]);
  console.log(JSON.stringify({resultado:'passou',redeStripe:false,cenarios:['carregamento do SDK sob CSP','recusa recuperável','mesmo PaymentIntent','SDK não quita fatura','webhook consulta provedor antes da baixa','quatro larguras']}));
} finally { await browser.close(); await db.end(); await disconnect(); }
