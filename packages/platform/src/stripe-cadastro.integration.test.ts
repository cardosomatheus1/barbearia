import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTenant } from '@barbearia/db';
import { iniciarCadastroDeCartao, confirmarCadastroDeCartao, conciliarCadastrosDeCartao } from './stripe-cadastro.js';
import { StripeCliente } from './stripe.js';
import { meioDePagamento } from './psp.js';

const A = '12000000-0000-4000-8000-000000000001';
const B = '12000000-0000-4000-8000-000000000002';
const SA = '12000000-0000-4000-8000-000000000003';
const SB = '12000000-0000-4000-8000-000000000004';
const url = process.env['SEED_DATABASE_URL'];
const suite = url && process.env['APP_DATABASE_URL'] ? describe : describe.skip;
let db: PrismaClient;

function redeStripe() {
  const objects = new Map<string, Record<string, unknown>>();
  const idempotencias = new Map<string, Record<string, unknown>>();
  const pedidos: { path: string; body: URLSearchParams; key: string }[] = [];
  let contador = 0;
  let perderResposta = false;
  const falharGet = new Set<string>();
  const cliente = new StripeCliente(async (url, init) => {
    const path = new URL(url).pathname.replace(/^\/v1/, '');
    if (init.method === 'GET') {
      if (falharGet.has(path)) throw new Error('falha de rede simulada');
      const obj = objects.get(path);
      return Response.json(obj ?? { error: { code: 'missing', message: 'missing' } }, { status: obj ? 200 : 404 });
    }
    const body = new URLSearchParams(String(init.body));
    const key = new Headers(init.headers).get('Idempotency-Key') ?? '';
    pedidos.push({ path, body, key });
    if (idempotencias.has(key)) return Response.json(idempotencias.get(key));
    let obj: Record<string, unknown>;
    if (path === '/customers') {
      obj = { id: `cus_${++contador}`, metadata: { tenant_id: body.get('metadata[tenant_id]') } };
      objects.set(`/customers/${obj['id']}`, obj);
    } else if (path === '/checkout/sessions') {
      const id = `cs_${++contador}`;
      obj = { id, mode: body.get('mode'), customer: body.get('customer'), status: 'open',
        client_reference_id: body.get('client_reference_id'), setup_intent: null,
        metadata: { cadastro_id: body.get('metadata[cadastro_id]'), tenant_id: body.get('metadata[tenant_id]') },
        url: `https://checkout.stripe.com/c/pay/${id}` };
      objects.set(`/checkout/sessions/${id}`, obj);
    } else throw new Error(`Chamada inesperada: ${path}`);
    idempotencias.set(key, obj);
    if (path === '/checkout/sessions' && perderResposta) {
      perderResposta = false;
      throw new Error('resposta perdida após criar a sessão');
    }
    return Response.json(obj);
  });
  function concluir(id: string, final = '4242') {
    const s = objects.get(`/checkout/sessions/${id}`)!;
    s['status'] = 'complete'; s['setup_intent'] = `seti_${id}`;
    objects.set(`/setup_intents/seti_${id}`, { id: `seti_${id}`, status: 'succeeded', usage: 'off_session',
      customer: s['customer'], payment_method: `pm_${id}`, metadata: s['metadata'] });
    objects.set(`/payment_methods/pm_${id}`, { id: `pm_${id}`, type: 'card', customer: s['customer'],
      card: { brand: 'visa', last4: final, exp_month: 12, exp_year: 2035 } });
  }
  return { cliente, objects, pedidos, concluir, falharGet, perderProximaResposta: () => { perderResposta = true; } };
}

suite('cadastro de cartão SaaS: banco real, RLS e somente a rede Stripe simulada', () => {
  beforeAll(() => { db = new PrismaClient({ datasources: { db: { url: url! } } }); });
  afterAll(async () => { await db.$disconnect(); });
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(async () => {
    vi.stubEnv('PSP_MODO', 'stripe');
    vi.stubEnv('STRIPE_SECRET_KEY', 'chave-ficticia-rede-simulada');
    vi.stubEnv('WEB_URL', 'https://app.example.com');
    await db.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await db.$executeRawUnsafe('TRUNCATE platform_audit');
    await db.$executeRaw`INSERT INTO tenants (id, name) VALUES (${A}::uuid, 'Loja A'), (${B}::uuid, 'Loja B')`;
    await db.$executeRaw`
      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES (${SA}::uuid, ${A}::uuid, 'Dono A', 'dono-a@example.test', 'hash', 'owner'),
             (${SB}::uuid, ${B}::uuid, 'Dono B', 'dono-b@example.test', 'hash', 'owner')
    `;
  });
  const entrada = (key = 'cadastro-1') => ({ tenantId: A, staffUserId: SA, idempotencyKey: key, consentiu: true });
  const id = (url: string) => url.split('/').at(-1)!;

  it('resposta perdida e duplo clique reencontram a sessão; nenhum pagamento é criado', async () => {
    const rede = redeStripe();
    rede.perderProximaResposta();
    await expect(iniciarCadastroDeCartao(entrada(), rede.cliente)).rejects.toThrow();
    const [r1, r2] = await Promise.all([
      iniciarCadastroDeCartao(entrada(), rede.cliente), iniciarCadastroDeCartao(entrada(), rede.cliente),
    ]);
    expect(r1.url).toBe(r2.url);
    const sessoes = rede.pedidos.filter(x => x.path === '/checkout/sessions');
    expect(new Set(sessoes.map(x => x.key)).size).toBe(1);
    for (const p of sessoes) {
      expect(p.body.get('mode')).toBe('setup');
      expect(p.body.get('payment_method_types[0]')).toBe('card');
      expect(p.body.has('line_items[0][price]')).toBe(false);
      expect(p.body.get('success_url')).toBe('https://app.example.com/admin/plano?cartao=retorno');
    }
    expect(await meioDePagamento(A)).toMatchObject({ pspMethodId: null });
    expect((await db.$queryRaw<unknown[]>`SELECT * FROM billing_setup_sessions`)).toHaveLength(1);
  });

  it('confirma cartão consultando a Stripe e reentrega concorrente grava uma única auditoria', async () => {
    const rede = redeStripe();
    const r = await iniciarCadastroDeCartao(entrada(), rede.cliente);
    expect(await confirmarCadastroDeCartao(id(r.url), rede.cliente)).toBe('pendente');
    rede.concluir(id(r.url));
    const resultados = await Promise.all([confirmarCadastroDeCartao(id(r.url), rede.cliente), confirmarCadastroDeCartao(id(r.url), rede.cliente)]);
    expect(resultados.sort()).toEqual(['aplicado', 'ignorado']);
    expect(await meioDePagamento(A)).toMatchObject({ pspMethodId: `pm_${id(r.url)}`, final: '4242' });
    expect(await meioDePagamento(B)).toBeNull();
    expect(await db.$queryRaw<unknown[]>`SELECT * FROM platform_audit WHERE action = 'billing.card_setup_completed'`).toHaveLength(1);
    expect(await withTenant(A, tx => tx.$queryRaw<unknown[]>`SELECT * FROM billing_setup_sessions`)).toHaveLength(0);
  });

  it('sem consentimento ou com usuário da outra loja não cria cliente nem sessão', async () => {
    const rede = redeStripe();
    await expect(iniciarCadastroDeCartao({ ...entrada(), consentiu: false }, rede.cliente)).rejects.toThrow();
    await expect(iniciarCadastroDeCartao({ ...entrada(), staffUserId: SB }, rede.cliente)).rejects.toThrow();
    expect(rede.pedidos).toHaveLength(0);
  });

  it('cartão pertencente a outro cliente é recusado mesmo com sessão concluída', async () => {
    const rede = redeStripe(); const r = await iniciarCadastroDeCartao(entrada(), rede.cliente);
    rede.concluir(id(r.url));
    rede.objects.get(`/payment_methods/pm_${id(r.url)}`)!['customer'] = 'cus_outra';
    expect(await confirmarCadastroDeCartao(id(r.url), rede.cliente)).toBe('ignorado');
    expect((await meioDePagamento(A))?.pspMethodId).toBeNull();
  });

  it('sessão de outra loja não pode reivindicar a reserva e o cartão dela', async () => {
    const rede = redeStripe(); const a = await iniciarCadastroDeCartao(entrada(), rede.cliente);
    const b = await iniciarCadastroDeCartao({ ...entrada(), tenantId: B, staffUserId: SB }, rede.cliente);
    rede.concluir(id(b.url));
    const objeto = rede.objects.get(`/checkout/sessions/${id(b.url)}`)!;
    objeto['client_reference_id'] = rede.objects.get(`/checkout/sessions/${id(a.url)}`)!['client_reference_id'];
    expect(await confirmarCadastroDeCartao(id(b.url), rede.cliente)).toBe('ignorado');
    expect((await meioDePagamento(A))?.pspMethodId).toBeNull();
  });

  it('polling recupera webhook perdido e continua depois de falha de outra conta', async () => {
    const rede = redeStripe(); const a = await iniciarCadastroDeCartao(entrada(), rede.cliente);
    const b = await iniciarCadastroDeCartao({ ...entrada(), tenantId: B, staffUserId: SB }, rede.cliente);
    rede.concluir(id(b.url)); rede.falharGet.add(`/checkout/sessions/${id(a.url)}`);
    expect(await conciliarCadastrosDeCartao(undefined, rede.cliente)).toEqual({ consultados: 2, falhas: 1 });
    expect((await meioDePagamento(B))?.pspMethodId).toBe(`pm_${id(b.url)}`);
  });

  it('webhook antigo não substitui o cartão cadastrado mais recentemente', async () => {
    const rede = redeStripe(); const a = await iniciarCadastroDeCartao(entrada(), rede.cliente);
    await db.$executeRaw`UPDATE billing_setup_sessions SET created_at = now() - interval '1 minute'`;
    const b = await iniciarCadastroDeCartao(entrada('cadastro-2'), rede.cliente);
    rede.concluir(id(a.url), '1111'); rede.concluir(id(b.url), '2222');
    expect(await confirmarCadastroDeCartao(id(b.url), rede.cliente)).toBe('aplicado');
    expect(await confirmarCadastroDeCartao(id(a.url), rede.cliente)).toBe('ignorado');
    expect((await meioDePagamento(A))?.final).toBe('2222');
  });
});
