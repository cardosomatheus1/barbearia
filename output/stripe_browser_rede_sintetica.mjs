import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const dbUrl=new URL(process.env.DEMO_DATABASE_URL);
assert.equal(process.env.NODE_ENV,'test'); assert.equal(dbUrl.hostname,'127.0.0.1');
assert.match(dbUrl.pathname,/^\/barbearia_stripe_browser_[a-f0-9]+$/);
const { Client }=createRequire(new URL('../packages/db/package.json',import.meta.url))('pg');
const original=globalThis.fetch;
globalThis.fetch=async (url,init) => {
  if (new URL(String(url)).hostname !== 'api.stripe.com') return original(url,init);
  assert.equal(init?.method,'GET','este ensaio não pode criar cobranças');
  const db=new Client({ connectionString:process.env.DEMO_DATABASE_URL }); await db.connect();
  try {
    const p=(await db.query('SELECT * FROM audit_stripe_respostas LIMIT 1')).rows[0]; assert.ok(p);
    if (String(url).endsWith('/payment_methods/pm_browser')) return Response.json({ id:'pm_browser',type:'card',customer:'cus_browser' });
    assert.ok(String(url).endsWith('/payment_intents/pi_browser'));
    return Response.json({ id:'pi_browser',status:p.estado,customer:'cus_browser',amount:4900,currency:'brl',
      payment_method:'pm_browser',client_secret:'pi_browser_secret_sintetico',livemode:false,
      metadata:{ tenant_id:p.tenant_id,fatura_id:p.fatura_id },last_payment_error:{ code:'authentication_required' } });
  } finally { await db.end(); }
};
