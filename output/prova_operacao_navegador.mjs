import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { signUpOwner } from '../packages/identity/dist/index.js';
import { disconnect } from '../packages/db/dist/index.js';
import { emitirFaturas, encerrarCancelamentosVencidos } from '../packages/finance/dist/index.js';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { Client } = createRequire(new URL('../packages/db/package.json', import.meta.url))('pg');
assert.equal(new URL(process.env.DEMO_DATABASE_URL).hostname, '127.0.0.1');
assert.match(new URL(process.env.DEMO_DATABASE_URL).pathname, /^\/barbearia_operacao_browser_[a-f0-9]+$/);
const db = new Client({ connectionString: process.env.DEMO_DATABASE_URL }); await db.connect();
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const prints = new URL('./PRINTS_CORRECOES_PRE_GO_LIVE/', import.meta.url);
await mkdir(prints, { recursive: true });
const web = process.env.WEB_URL; const api = process.env.API_URL;
const errors = []; let etapa = 'preparação';
const q = async (sql, args = []) => (await db.query(sql, args)).rows;
async function aguardar(obter, aceitar, mensagem) {
  for (let i = 0; i < 120; i++) {
    const r = await obter(); if (aceitar(r)) return r;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(mensagem);
}
async function enviar(page, botao) {
  const [response] = await Promise.all([page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).origin === web), botao.click()]);
  const redirect = response.headers()['x-action-redirect']?.split(';')[0] ?? response.headers().location;
  if (redirect) {
    const destino = new URL(redirect, web);
    await page.waitForURL(u => u.pathname === destino.pathname && u.search === destino.search);
  }
  await page.waitForLoadState('networkidle');
  assert.ok(!/[?&](erro|falha)=/.test(page.url()), 'recusa na ação: '+new URL(page.url()).search);
}
async function fotografar(page, nome) {
  for (const width of [360, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 950 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'overflow: '+nome+' '+width);
    await page.screenshot({ path: new URL(nome+'-'+width+'.png', prints).pathname, fullPage: true, mask: [page.locator('.link-fila')] });
  }
}
async function request(sessao, method, path, body) {
  const r = await fetch(api+path, { method, headers: { authorization: 'Bearer '+sessao.token, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(r.ok, method+' '+path+' -> '+r.status); return r.json();
}
async function contexto(token) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 950 } });
  if (token) await ctx.addCookies([{ name: 'gestor', value: token, domain: '127.0.0.1', path: '/admin', httpOnly: true, sameSite: 'Strict', secure: false }]);
  const page = await ctx.newPage();
  page.on('pageerror', () => errors.push('erro de javascript'));
  page.on('response', r => { if (r.status() >= 500) errors.push('HTTP '+r.status()+' '+new URL(r.url()).pathname); });
  return { ctx, page };
}
async function novaComanda(page, customerId) {
  await page.goto(web+'/admin/cliente/'+customerId, { waitUntil: 'networkidle' });
  await enviar(page, page.getByRole('button', { name: 'Nova comanda', exact: true }));
  await page.waitForURL(/\/comanda\/[a-f0-9-]{36}/);
  return /\/comanda\/([a-f0-9-]{36})/.exec(page.url())[1];
}
async function adicionarServico(page, serviceId) {
  await page.getByText('Acrescentar item', { exact: true }).click();
  const option = await page.locator('#item option').evaluateAll((os, id) => os.find(o => o.value.includes(id))?.value, serviceId);
  assert.ok(option, 'serviço do catálogo não disponível');
  await page.locator('#item').selectOption(option);
  await page.locator('#descricao').fill('Corte do percurso');
  await page.locator('#precoUnitarioCents').fill('49,00');
  await enviar(page, page.getByRole('button', { name: 'Acrescentar', exact: true }));
}
async function pagar(page, forma, valor) {
  await page.locator('#forma0').selectOption(forma); await page.locator('#valor0').fill(valor);
  await enviar(page, page.getByRole('button', { name: /Receber R\$/ }));
  await page.getByRole('heading', { name: 'Pago com', exact: true }).waitFor();
}
try {
  const senha = randomBytes(24).toString('base64url');
  const dono = { name: 'Operadora de teste', email: 'operacao@example.invalid', password: senha,
    phone: '+5511999995555', businessName: 'Barbearia Percursos Operacionais' };
  const cadastro = await signUpOwner(dono); assert.ok(cadastro.created);
  const s = cadastro.session;
  await request(s, 'PUT', '/v1/admin/business', { name: dono.businessName, city: 'Salvador', timezone: 'America/Bahia' });
  await request(s, 'PUT', '/v1/admin/services', { services: [{ key: 'corte', name: 'Corte do percurso', category: 'Cabelo',
    durationMinutes: 30, bufferAfterMinutes: 0, priceCents: 4900 }] });
  await request(s, 'PUT', '/v1/admin/professionals', { professionals: [{ name: 'Profissional do percurso',
    schedule: [0,1,2,3,4,5,6].map(weekday => ({ weekday, startMinute: 0, endMinute: 1439 })) }] });
  await request(s, 'POST', '/v1/admin/publish');
  await q("INSERT INTO tenant_features(tenant_id,flag_code,enabled) SELECT $1,code,true FROM feature_flags WHERE code IN ('fila','avisos','fiscal') ON CONFLICT (tenant_id,flag_code) DO UPDATE SET enabled=true", [s.tenantId]);
  const catalog = await request(s, 'GET', '/v1/admin/catalog');
  const estado = await request(s, 'GET', '/v1/admin/state');
  const serviceId = catalog.services[0].id; const professionalId = catalog.professionals[0].id;
  const { page } = await contexto(s.token);
  etapa = 'walk-in';
  await page.goto(web+'/admin/caixa', { waitUntil: 'networkidle' });
  await page.locator('[name="openingCents"]').fill('100,00');
  await enviar(page, page.getByRole('button', { name: 'Abrir caixa', exact: true }));
  await page.goto(web+'/admin/fila', { waitUntil: 'networkidle' });
  await page.locator('#name').fill('Cliente do Walk-in'); await page.locator('#phone').fill('(11) 99999-1234');
  await enviar(page, page.getByRole('button', { name: 'Entrar na fila', exact: true }));
  const espera = page.locator('li.espera').filter({ hasText: 'Cliente do Walk-in' });
  await espera.waitFor();
  const [fila] = await q("SELECT w.id,w.customer_id FROM queue_entries w WHERE w.tenant_id=$1", [s.tenantId]);
  assert.ok(fila);
  await enviar(page, espera.getByRole('button', { name: 'Chamar', exact: true }));
  await enviar(page, page.locator('li.espera').filter({ hasText: 'Cliente do Walk-in' }).getByRole('button', { name: 'Sentou', exact: true }));
  await page.waitForURL(/\/admin\/dia/);
  const atendimento = page.locator('article.atendimento').filter({ hasText: 'Cliente do Walk-in' });
  await atendimento.waitFor();
  const concluir = atendimento.locator('form').filter({ has: page.locator('input[name="action"][value="complete"]') }).getByRole('button');
  await enviar(page, concluir);
  const cobrar = atendimento.locator('form').filter({ has: page.locator('input[name="appointmentId"]') }).getByRole('button');
  await enviar(page, cobrar);
  await page.waitForURL(/\/comanda\/[a-f0-9-]{36}/);
  const vendaId = /\/comanda\/([a-f0-9-]{36})/.exec(page.url())[1];
  await pagar(page, 'cash', '49,00');
  const [venda] = await q('SELECT status,total_cents,location_id FROM orders WHERE id=$1', [vendaId]);
  assert.equal(venda.status, 'paid'); assert.equal(venda.total_cents, 4900); assert.equal(venda.location_id, estado.locationId);
  assert.equal((await q('SELECT status FROM queue_entries WHERE id=$1', [fila.id]))[0].status, 'done');
  await fotografar(page, 'operacao-walkin-pago');
  console.log(JSON.stringify({ percurso: etapa, resultado: 'passou', banco: true }));
  etapa = 'pacote';
  await page.goto(web+'/admin/pacotes', { waitUntil: 'networkidle' });
  await page.locator('#novo-nome').fill('Dois cortes do percurso');
  await page.locator('#novo-serviceId').selectOption(serviceId);
  await page.locator('#novo-quantidade').fill('2'); await page.locator('#novo-precoReais').fill('98,00');
  await page.locator('#novo-validadeDias').fill('90');
  await enviar(page, page.getByRole('button', { name: 'Adicionar pacote', exact: true }));
  const compraId = await novaComanda(page, fila.customer_id);
  await page.getByText('Vender um pacote', { exact: true }).click();
  await enviar(page, page.getByRole('button', { name: /Dois cortes do percurso/ }));
  await pagar(page, 'cash', '98,00');
  const [pacote] = await q('SELECT id,quantity FROM customer_packages WHERE customer_id=$1', [fila.customer_id]);
  assert.equal(pacote.quantity, 2);
  assert.equal((await q('SELECT status FROM orders WHERE id=$1', [compraId]))[0].status, 'paid');
  const consumoId = await novaComanda(page, fila.customer_id);
  await adicionarServico(page, serviceId); await pagar(page, 'pacote', '49,00');
  assert.equal((await q('SELECT status FROM orders WHERE id=$1', [consumoId]))[0].status, 'paid');
  assert.equal((await q('SELECT count(*)::int AS n FROM package_uses WHERE customer_package_id=$1', [pacote.id]))[0].n, 1);
  await fotografar(page, 'operacao-pacote-usado');
  console.log(JSON.stringify({ percurso: etapa, resultado: 'passou', banco: true }));
  etapa = 'clube';
  await page.goto(web+'/admin/clube', { waitUntil: 'networkidle' });
  await page.locator('#novo-nome').fill('Clube do percurso'); await page.locator('#novo-precoReais').fill('89,90');
  await page.locator(`[name="inclui-${serviceId}"]`).check();
  await page.locator(`#novo-q-${serviceId}`).fill('2'); await page.locator(`#novo-c-${serviceId}`).fill('0');
  await enviar(page, page.locator('form').filter({ has: page.locator('#novo-nome') }).getByRole('button', { name: /Adicionar|Criar|Salvar/ }));
  await page.goto(web+'/admin/cliente/'+fila.customer_id+'?aba=fidelidade', { waitUntil: 'networkidle' });
  await enviar(page, page.getByRole('button', { name: 'Assinar', exact: true }));
  const [assinatura] = await q('SELECT id,price_cents,status FROM club_subscriptions WHERE customer_id=$1', [fila.customer_id]);
  assert.equal(assinatura.price_cents, 8990); assert.equal(assinatura.status, 'ativa');
  // Executa a tarefa periódica real com relógio explícito, sem esperar a madrugada.
  await emitirFaturas({ tenantId: s.tenantId });
  await page.goto(web+'/admin/clube', { waitUntil: 'networkidle' });
  const [fatura] = await q('SELECT id FROM club_invoices WHERE subscription_id=$1', [assinatura.id]);
  const baixar = page.locator('form.fatura__baixa').filter({ has: page.locator(`input[name="id"][value="${fatura.id}"]`) });
  await baixar.locator('select[name="metodo"]').selectOption('pix');
  await enviar(page, baixar.getByRole('button', { name: 'Registrar pagamento', exact: true }));
  assert.equal((await q('SELECT status FROM club_invoices WHERE id=$1', [fatura.id]))[0].status, 'paga');
  const usoClube = await novaComanda(page, fila.customer_id);
  await adicionarServico(page, serviceId); await pagar(page, 'assinatura', '49,00');
  assert.equal((await q('SELECT count(*)::int n FROM club_uses WHERE subscription_id=$1 AND order_id=$2', [assinatura.id,usoClube]))[0].n, 1);
  await page.goto(web+'/admin/cliente/'+fila.customer_id+'?aba=fidelidade', { waitUntil: 'networkidle' });
  const encerrar = page.locator('form').filter({ has: page.getByRole('button', { name: 'Encerrar no fim do ciclo', exact: true }) });
  await encerrar.locator('[name="motivo"]').fill('Solicitado pelo cliente no percurso');
  await enviar(page, encerrar.getByRole('button', { name: 'Encerrar no fim do ciclo', exact: true }));
  const [saida] = await q('SELECT status,cancel_effective_at FROM club_subscriptions WHERE id=$1', [assinatura.id]);
  assert.equal(saida.status, 'ativa'); assert.ok(saida.cancel_effective_at);
  await fotografar(page, 'operacao-clube-fim-ciclo');
  assert.equal(await encerrarCancelamentosVencidos({ tenantId: s.tenantId, agora: new Date(saida.cancel_effective_at) }), 1);
  assert.equal(await emitirFaturas({ tenantId: s.tenantId, agora: new Date(saida.cancel_effective_at) }), 0);
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal((await q('SELECT status FROM club_subscriptions WHERE id=$1', [assinatura.id]))[0].status, 'cancelada');
  console.log(JSON.stringify({ percurso: etapa, resultado: 'passou', banco: true, viradaCiclo: 'tarefa real com relógio injetado', pagamento: 'registro manual' }));

  etapa = 'lista de espera';
  const amanha = new Date(); amanha.setUTCDate(amanha.getUTCDate()+2); const date = amanha.toISOString().slice(0,10);
  // Precondição: única meia hora de expediente, já ocupada; o cliente só pode neste dia.
  await q("INSERT INTO schedule_exceptions(tenant_id,professional_id,on_date,kind,start_minute,end_minute) VALUES($1,$2,$3,'custom_hours',540,570)", [s.tenantId,professionalId,date]);
  const ocupado = await request(s,'POST','/v1/admin/appointments', { customerId: fila.customer_id, professionalId, serviceIds:[serviceId],date,start:'09:00' });
  const { page: cliente } = await contexto();
  const slug = (await q('SELECT slug FROM tenant_slugs WHERE tenant_id=$1 AND is_primary', [s.tenantId]))[0].slug;
  await cliente.goto(web+'/'+slug+'/agendar?'+new URLSearchParams({s:serviceId,p:professionalId,d:date,e:'h'}),{waitUntil:'networkidle'});
  await cliente.getByText('Avise-me se surgir uma vaga',{exact:true}).click();
  await cliente.locator('#espera-nome').fill('Cliente da Espera'); await cliente.locator('#espera-fone').fill('(11) 98888-1234');
  await cliente.locator('#espera-inicio').fill('09:00'); await cliente.locator('#espera-fim').fill('09:30');
  await enviar(cliente,cliente.getByRole('button',{name:'Entrar na lista de espera',exact:true}));
  await cliente.waitForURL(/espera=1/);
  await page.goto(web+'/admin/dia?d='+date,{waitUntil:'networkidle'});
  const cancelar = page.locator(`#atendimento-${ocupado.id} form`).filter({has:page.locator('input[name="action"][value="cancel"]')});
  await enviar(page,cancelar.getByRole('button'));
  const link = await aguardar(async () => {
    const log = await readFile(process.env.OPERACAO_WORKER_LOG,'utf8');
    return log.match(/\[aviso\] vaga_liberada[^\n]* (http[^\s]+)/)?.[1];
  },r=>Boolean(r),'worker não preparou o convite de vaga');
  assert.equal(new URL(link).pathname.split('/')[1],slug,'link precisa identificar a barbearia');
  await cliente.goto(link,{waitUntil:'networkidle'});
  await fotografar(cliente,'operacao-convite-espera');
  await enviar(cliente,cliente.getByRole('button',{name:'Quero este horário',exact:true}));
  await cliente.waitForURL(/agendado\//);
  assert.equal((await q("SELECT count(*)::int n FROM waitlist_offers WHERE tenant_id=$1 AND status='aceita'",[s.tenantId]))[0].n,1);
  const [atual] = await q("SELECT a.id,a.status FROM appointments a JOIN customers c ON c.id=a.customer_id WHERE c.name='Cliente da Espera'");
  assert.ok(['confirmed','pending'].includes(atual.status));
  await cliente.goto(link,{waitUntil:'networkidle'});
  assert.equal(await cliente.getByRole('button',{name:'Quero este horário',exact:true}).count(),0);
  assert.equal((await q("SELECT count(*)::int n FROM appointments a JOIN customers c ON c.id=a.customer_id WHERE c.name='Cliente da Espera'"))[0].n,1);
  console.log(JSON.stringify({ percurso: etapa, resultado: 'passou', banco: true, workerReal: true, mensagem: 'console sintético, sem rede' }));

  etapa = 'duas unidades';
  await page.goto(web+'/admin/unidades',{waitUntil:'networkidle'});
  await page.locator('#nome').fill('Filial do percurso'); await page.locator('#cidade').fill('Salvador'); await page.locator('#estado').fill('BA');
  await enviar(page,page.getByRole('button',{name:'Abrir unidade',exact:true}));
  const [filial] = await q('SELECT id FROM locations WHERE tenant_id=$1 AND name=$2',[s.tenantId,'Filial do percurso']);
  const segundo = await request(s,'POST','/v1/admin/login',{email:dono.email,password:senha});
  const { page: page2 } = await contexto(segundo.token);
  await page2.goto(web+'/admin/unidades',{waitUntil:'networkidle'});
  await enviar(page2,page2.locator('form').filter({has:page2.locator(`input[name="unidadeId"][value="${filial.id}"]`)}).filter({has:page2.getByRole('button',{name:'Ir para esta',exact:true})}).getByRole('button'));
  await page2.goto(web+'/admin/caixa',{waitUntil:'networkidle'}); await page2.locator('[name="openingCents"]').fill('200,00');
  await enviar(page2,page2.getByRole('button',{name:'Abrir caixa',exact:true}));
  await page.goto(web+'/admin/caixa',{waitUntil:'networkidle'});
  assert.equal((await request(s,'GET','/v1/admin/state')).locationId,estado.locationId);
  assert.equal((await request(segundo,'GET','/v1/admin/state')).locationId,filial.id);
  const [comandaMatriz,comandaFilial] = await Promise.all([novaComanda(page,fila.customer_id),novaComanda(page2,fila.customer_id)]);
  await Promise.all([adicionarServico(page,serviceId),adicionarServico(page2,serviceId)]);
  await Promise.all([pagar(page,'cash','49,00'),pagar(page2,'cash','49,00')]);
  const vendas = await q('SELECT o.id,o.location_id,c.location_id AS caixa FROM orders o JOIN cash_sessions c ON c.id=o.session_id WHERE o.id=ANY($1::uuid[])',[[comandaMatriz,comandaFilial]]);
  assert.equal(vendas.find(v=>v.id===comandaMatriz).location_id,estado.locationId);
  assert.equal(vendas.find(v=>v.id===comandaFilial).location_id,filial.id);
  assert.ok(vendas.every(v=>v.location_id===v.caixa));
  await fotografar(page2,'operacao-duas-unidades');
  console.log(JSON.stringify({ percurso: etapa, resultado: 'passou', banco: true, sessoesIndependentes: true, pagamentosSimultaneos: true }));
  assert.deepEqual(errors, []);
} catch (e) {
  console.error(JSON.stringify({ etapa, resultado: 'falhou', erro: String(e.message).replace(/Bearer\s+\S+|\/vaga\/[^\s/]+/g, '[credencial removida]') }));
  process.exitCode = 1;
} finally { await browser.close(); await db.end(); await disconnect(); }
