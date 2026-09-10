import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
const require=createRequire(new URL('../package.json',import.meta.url));
const {chromium}=require('playwright');
const db=process.env.DEMO_DATABASE_URL;
assert.equal(new URL(db).hostname,'127.0.0.1');
const web=process.env.WEB_URL;
const sql=q=>execFileSync('psql',[db,'-X','-q','-tA','-v','ON_ERROR_STOP=1','-c',q],{encoding:'utf8'}).trim();
const fixture=JSON.parse(sql(`SELECT row_to_json(t) FROM (
 SELECT a.id,a.tenant_id,a.customer_id,a.starts_at,s.slug
 FROM appointments a JOIN customers c ON c.id=a.customer_id
 JOIN tenant_slugs s ON s.tenant_id=a.tenant_id
 WHERE c.name='Cliente do Percurso' AND a.status IN ('confirmed','pending')
 ORDER BY a.created_at DESC LIMIT 1) t`));
assert.ok(fixture,'The completed measurement booking journey must exist');
const token=randomBytes(32).toString('base64url');
const hash=createHash('sha256').update(token).digest('hex');
sql(`INSERT INTO customer_sessions(tenant_id,customer_id,token_hash,expires_at)
 VALUES('${fixture.tenant_id}','${fixture.customer_id}','${hash}',now()+interval '1 hour')`);
const browser=await chromium.launch({args:['--no-sandbox']});
const context=await browser.newContext({viewport:{width:390,height:900}});
await context.addCookies([{name:'sessao_'+fixture.slug,value:token,domain:'127.0.0.1',path:'/'+fixture.slug,httpOnly:true,sameSite:'Lax',secure:false}]);
const page=await context.newPage();
const errors=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('response',r=>{if(r.status()>=500)errors.push(`${r.status()} ${new URL(r.url()).pathname}`)});
try {
 await page.goto(`${web}/${fixture.slug}/meus-agendamentos`,{waitUntil:'networkidle'});
 await page.locator(`a[href="/${fixture.slug}/meus-agendamentos/${fixture.id}/remarcar"]`).click();
 await page.waitForURL(/\/remarcar/);
 const option=page.locator('form:has(button.hora--botao)').first();
 await option.waitFor({state:'visible'});
 const chosen={date:await option.locator('input[name="date"]').inputValue(),start:await option.locator('input[name="start"]').inputValue()};
 await option.locator('button').click();
 await page.waitForURL(/feito=remarcado/);
 const oldStatus=sql(`SELECT status FROM appointments WHERE id='${fixture.id}'`);
 const next=JSON.parse(sql(`SELECT row_to_json(t) FROM (SELECT id,status,starts_at FROM appointments WHERE rescheduled_from='${fixture.id}') t`));
 assert.equal(oldStatus,'rescheduled');
 assert.ok(next && ['confirmed','pending'].includes(next.status));
 assert.notEqual(new Date(next.starts_at).getTime(),new Date(fixture.starts_at).getTime());
 console.log(JSON.stringify({scenario:'Customer reschedules through mobile browser',result:'passed',old_state:oldStatus,new_state:next.status,chosen,db_confirmed:true,authentication:'Synthetic valid session fixture; OTP delivery is not certified'}));
 const form=page.locator(`form:has(input[name="id"][value="${next.id}"])`).filter({has:page.getByRole('button',{name:'Cancelar',exact:true})});
 await form.getByRole('button',{name:'Cancelar',exact:true}).click();
 await page.waitForURL(/feito=cancelado/);
 const cancelled=sql(`SELECT status FROM appointments WHERE id='${next.id}'`);
 assert.equal(cancelled,'cancelled_customer');
 console.log(JSON.stringify({scenario:'Customer cancels through mobile browser',result:'passed',state:cancelled,db_confirmed:true}));
 assert.deepEqual(errors,[]);
} finally {
 await browser.close();
 sql(`DELETE FROM customer_sessions WHERE token_hash='${hash}'`);
}
