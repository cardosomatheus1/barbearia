import { PrismaClient } from '@prisma/client';
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { cancelarFatura, pagarFatura } from './cobranca.js';
import { StripeCliente } from './stripe.js';
import { prepararAutenticacaoDaCobranca } from './stripe-autenticacao.js';
const A='12300000-0000-4000-8000-000000000001'; const B='12300000-0000-4000-8000-000000000002';
const F='12300000-0000-4000-8000-000000000003';
const suite=process.env['SEED_DATABASE_URL'] && process.env['APP_DATABASE_URL'] ? describe : describe.skip;
let db: PrismaClient;
suite('autenticação da mesma mensalidade Stripe sob RLS', () => {
  beforeAll(() => { db=new PrismaClient({ datasources: { db: { url: process.env['SEED_DATABASE_URL']! } } }); });
  afterAll(async () => { await db.$disconnect(); }); afterEach(() => vi.unstubAllEnvs());
  beforeEach(async () => {
    vi.stubEnv('PSP_MODO','stripe'); vi.stubEnv('STRIPE_SECRET_KEY','sk_test_sintetico'); vi.stubEnv('STRIPE_PUBLISHABLE_KEY','pk_test_sintetico');
    await db.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await db.$executeRaw`INSERT INTO tenants(id,name) VALUES (${A}::uuid,'Sintética A'),(${B}::uuid,'Sintética B')`;
    await db.$executeRaw`INSERT INTO invoices(id,tenant_id,plan_code,amount_cents,period_start,period_end,due_at,psp_charge_id)
      SELECT ${F}::uuid,${A}::uuid,code,4900,now(),now()+interval '30 days',now(),'pi_autenticacao' FROM plans ORDER BY code LIMIT 1`;
    await db.$executeRaw`INSERT INTO billing_customers(tenant_id,psp_customer_id,psp_method_id,last4) VALUES (${A}::uuid,'cus_sintetico','pm_sintetico','4242')`;
  });
  function rede(alteracoes: Record<string,unknown>={}, donoDoCartao='cus_sintetico', antesDoCartao?: () => Promise<void>) {
    const chamadas: string[]=[];
    const cliente=new StripeCliente(async (url,init) => {
      expect(init.method).toBe('GET'); chamadas.push(new URL(url).pathname);
      if (url.includes('/payment_methods/')) {
        await antesDoCartao?.(); return Response.json({ id:'pm_sintetico',customer:donoDoCartao,type:'card' });
      }
      return Response.json({ id:'pi_autenticacao',status:'requires_payment_method',customer:'cus_sintetico',amount:4900,currency:'brl',
        payment_method:null,client_secret:'pi_autenticacao_secret_sintetico',livemode:false,
        metadata:{ tenant_id:A,fatura_id:F },last_payment_error:{ code:'authentication_required' },...alteracoes });
    }); return { cliente,chamadas };
  }
  it('entrega somente a confirmação do PI existente e não marca a fatura paga', async () => {
    const r=rede(); expect(await prepararAutenticacaoDaCobranca({ tenantId:A,faturaId:F },r.cliente)).toEqual({
      estado:'autenticar',chavePublica:'pk_test_sintetico',clientSecret:'pi_autenticacao_secret_sintetico',paymentMethod:'pm_sintetico' });
    expect(r.chamadas).toEqual(['/v1/payment_intents/pi_autenticacao','/v1/payment_methods/pm_sintetico']);
    expect(await db.$queryRaw`SELECT status FROM invoices WHERE id=${F}::uuid`).toEqual([{ status:'open' }]);
  });
  it('fatura com cobrança viva não pode ser perdoada ou quitada manualmente', async () => {
    await expect(cancelarFatura({ adminId:A,faturaId:F,motivo:'Teste de concorrência' })).rejects.toMatchObject({ code:'not_voidable' });
    await expect(pagarFatura({ adminId:A,faturaId:F,metodo:'manual' })).rejects.toMatchObject({ code:'not_payable' });
    expect(await db.$queryRaw`SELECT status FROM invoices WHERE id=${F}::uuid`).toEqual([{ status:'open' }]);
  });
  it('fatura de outra barbearia não faz chamada Stripe nem revela segredo', async () => {
    const r=rede(); await expect(prepararAutenticacaoDaCobranca({ tenantId:B,faturaId:F },r.cliente)).rejects.toMatchObject({ code:'unknown_invoice' });
    expect(r.chamadas).toEqual([]);
  });
  it.each([{ customer:'cus_outro' },{ amount:1 },{ currency:'usd' },{ metadata:{ tenant_id:B,fatura_id:F } },{ id:'pi_outro' }])('recusa identidade ou valor divergente: %j', async alteracao => {
    await expect(prepararAutenticacaoDaCobranca({ tenantId:A,faturaId:F },rede(alteracao).cliente)).rejects.toMatchObject({ code:'cobranca_stripe_divergente' });
  });
  it('não oferece cartão de outro cliente Stripe', async () => {
    await expect(prepararAutenticacaoDaCobranca({ tenantId:A,faturaId:F },rede({},'cus_outro').cliente)).rejects.toMatchObject({ code:'cartao_stripe_divergente' });
  });
  it('não mistura chave pública de produção com PI de teste', async () => {
    vi.stubEnv('STRIPE_PUBLISHABLE_KEY','pk_live_sintetico');
    await expect(prepararAutenticacaoDaCobranca({ tenantId:A,faturaId:F },rede().cliente)).rejects.toMatchObject({ code:'stripe_autenticacao_indisponivel' });
  });
  it('reconfere o vínculo após a rede sem entregar segredo de cobrança substituída', async () => {
    const r=rede({},'cus_sintetico',async () => { await db.$executeRaw`UPDATE invoices SET psp_charge_id='pi_substituto' WHERE id=${F}::uuid`; });
    expect(await prepararAutenticacaoDaCobranca({ tenantId:A,faturaId:F },r.cliente)).toEqual({ estado:'concluida' });
  });
  it.each(['succeeded','processing'])('%s aguarda conciliação sem abrir outra autenticação', async status => {
    const r=rede({ status }); expect(await prepararAutenticacaoDaCobranca({ tenantId:A,faturaId:F },r.cliente)).toEqual({ estado:'aguardando' });
    expect(r.chamadas).toHaveLength(1);
  });
});
