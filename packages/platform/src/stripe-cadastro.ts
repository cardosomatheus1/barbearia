import { semTenant, withTenant } from '@barbearia/db';
import { modoDoAdquirente } from './adquirente.js';
import { StripeCliente } from './stripe.js';
import { meioDePagamento } from './psp.js';
import { PlataformaError, registrarNaTrilha } from './plataforma.js';

/**
 * Checkout hospedado inspirado no módulo subscription do Raiz. O Barberdock já
 * tem uma régua para planos, créditos e rateio: mode=setup apenas cadastra o
 * cartão. Criar uma segunda assinatura Stripe cobraria a mensalidade em dobro.
 * A reserva local e a chave Stripe antecedem a rede; nenhuma transação espera HTTP.
 */
export const CONSENTIMENTO_CARTAO_SAAS = 'assinatura-recorrente-v1';
type Reserva = {
  id: string; tenant_id: string; staff_user_id: string; stripe_session_id: string | null;
  stripe_url: string | null; state: 'pending' | 'applied' | 'expired' | 'superseded';
  created_at: Date; expires_at: Date; return_url: string; consent_version: string;
};
type Sessao = {
  id: string; url?: string | null; mode: string; status: string;
  customer: string | null; client_reference_id: string | null; setup_intent: string | null;
  metadata?: { tenant_id?: string; cadastro_id?: string };
};
type Setup = {
  id: string; status: string; usage: string; customer: string | null;
  payment_method: string | null; metadata?: { tenant_id?: string; cadastro_id?: string };
};
type Cartao = {
  id: string; type: string; customer: string | null;
  card?: { brand: string; last4: string; exp_month: number; exp_year: number };
};

function exigirStripe() {
  if (modoDoAdquirente() !== 'stripe') {
    throw new PlataformaError('stripe_indisponivel', 'O cadastro automático de cartão está indisponível.');
  }
}

function retornoSeguro(): string {
  const url = new URL(process.env['WEB_URL'] ?? 'http://localhost:3001');
  if (url.username || url.password || url.search || url.hash ||
    (url.protocol !== 'https:' && !(process.env['NODE_ENV'] !== 'production' &&
      url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw new Error('WEB_URL inválida para o cadastro de cartão');
  }
  return `${url.origin}/admin/plano`;
}

function checkoutSeguro(url: string | null | undefined): string {
  if (!url) throw new Error('stripe_checkout_sem_url');
  const destino = new URL(url);
  if (destino.protocol !== 'https:' || destino.hostname !== 'checkout.stripe.com' ||
    destino.username || destino.password || destino.port) throw new Error('stripe_checkout_url_invalida');
  return url;
}

/** Retorna apenas URL hospedada. O dono nunca fornece cus_/pm_ à API. */
export async function iniciarCadastroDeCartao(entrada: {
  tenantId: string; staffUserId: string; idempotencyKey: string; consentiu: boolean;
}, cliente = new StripeCliente()): Promise<{ url: string }> {
  exigirStripe();
  if (entrada.consentiu !== true || !entrada.idempotencyKey || entrada.idempotencyKey.length > 128) {
    throw new PlataformaError('consentimento_necessario', 'Autorize a cobrança recorrente para cadastrar o cartão.');
  }
  // A borda exige settings.manage; o domínio também verifica o vínculo sob RLS.
  const vinculo = await withTenant(entrada.tenantId, tx => tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM staff_users WHERE id = ${entrada.staffUserId}::uuid AND active = true
  `);
  if (!vinculo.length) throw new PlataformaError('cadastro_nao_permitido', 'Cadastro não permitido.');

  const retorno = retornoSeguro();
  const reserva = await semTenant(async tx => {
    await tx.$executeRaw`
      INSERT INTO billing_setup_sessions
        (tenant_id, staff_user_id, idempotency_key, consent_version, return_url, expires_at)
      VALUES (${entrada.tenantId}::uuid, ${entrada.staffUserId}::uuid, ${entrada.idempotencyKey},
        ${CONSENTIMENTO_CARTAO_SAAS}, ${retorno}, now() + interval '1 hour')
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
    `;
    const [r] = await tx.$queryRaw<Reserva[]>`
      SELECT * FROM billing_setup_sessions
       WHERE tenant_id = ${entrada.tenantId}::uuid AND idempotency_key = ${entrada.idempotencyKey}
    `;
    if (!r) throw new Error('cadastro_nao_reservado');
    return r;
  });
  if (reserva.state !== 'pending' || reserva.expires_at.getTime() <= Date.now()) {
    throw new PlataformaError('cadastro_encerrado', 'Este cadastro terminou. Atualize a página para iniciar outro.');
  }
  if (reserva.stripe_url) return { url: checkoutSeguro(reserva.stripe_url) };

  let conta = await meioDePagamento(entrada.tenantId);
  if (!conta) {
    const criada = await cliente.post<{ id: string }>('/customers',
      { metadata: { tenant_id: entrada.tenantId, finalidade: 'assinatura_saas' } },
      { idempotencyKey: `saas-customer:${entrada.tenantId}` });
    if (!/^cus_[A-Za-z0-9]+$/.test(criada.id)) throw new Error('stripe_customer_invalido');
    await semTenant(tx => tx.$executeRaw`
      INSERT INTO billing_customers (tenant_id, psp_customer_id)
      VALUES (${entrada.tenantId}::uuid, ${criada.id}) ON CONFLICT (tenant_id) DO NOTHING
    `);
    conta = await meioDePagamento(entrada.tenantId);
  }
  if (!conta) throw new Error('stripe_customer_nao_persistido');
  // Confere também clientes legados, anteriormente cadastrados manualmente.
  const customer = await cliente.get<{ id: string; deleted?: boolean; metadata?: { tenant_id?: string } }>(
    `/customers/${encodeURIComponent(conta.pspCustomerId)}`);
  if (customer.deleted || customer.id !== conta.pspCustomerId || customer.metadata?.tenant_id !== entrada.tenantId) {
    throw new PlataformaError('conta_stripe_divergente', 'O cadastro de cobrança precisa ser revisado pelo suporte.');
  }
  const metadata = { tenant_id: entrada.tenantId, cadastro_id: reserva.id };
  const sessao = await cliente.post<Sessao>('/checkout/sessions', {
    mode: 'setup', currency: 'brl', customer: conta.pspCustomerId,
    client_reference_id: reserva.id, payment_method_types: ['card'], metadata,
    setup_intent_data: { metadata },
    expires_at: Math.floor(reserva.expires_at.getTime() / 1000),
    success_url: `${reserva.return_url}?cartao=retorno`,
    cancel_url: `${reserva.return_url}?cartao=cancelado`,
  }, { idempotencyKey: `saas-setup:${reserva.id}` });
  const url = checkoutSeguro(sessao.url);
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessao.id) || sessao.mode !== 'setup' ||
    sessao.customer !== conta.pspCustomerId || sessao.client_reference_id !== reserva.id) {
    throw new Error('stripe_checkout_divergente');
  }
  await semTenant(tx => tx.$executeRaw`
    UPDATE billing_setup_sessions SET stripe_session_id = ${sessao.id}, stripe_url = ${url}
     WHERE id = ${reserva.id}::uuid AND stripe_session_id IS NULL
  `);
  return { url };
}

/** Webhook e polling consultam a Stripe; nenhum dado de cartão do evento é aceito. */
export async function confirmarCadastroDeCartao(sessionId: string, cliente = new StripeCliente()): Promise<string> {
  exigirStripe();
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return 'ignorado';
  const sessao = await cliente.get<Sessao>(`/checkout/sessions/${encodeURIComponent(sessionId)}`);
  const cadastroId = sessao.client_reference_id;
  if (sessao.mode !== 'setup' || sessao.id !== sessionId ||
    !cadastroId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cadastroId)) return 'ignorado';
  const [reserva] = await semTenant(tx => tx.$queryRaw<Reserva[]>`
    SELECT * FROM billing_setup_sessions WHERE id = ${cadastroId}::uuid
  `);
  if (!reserva || reserva.state !== 'pending') return 'ignorado';
  if ((reserva.stripe_session_id && reserva.stripe_session_id !== sessionId) ||
    sessao.metadata?.cadastro_id !== reserva.id || sessao.metadata.tenant_id !== reserva.tenant_id) return 'ignorado';
  if (sessao.status === 'expired') {
    await semTenant(tx => tx.$executeRaw`
      UPDATE billing_setup_sessions SET state = 'expired' WHERE id = ${reserva.id}::uuid AND state = 'pending'
    `);
    return 'expirado';
  }
  if (sessao.status !== 'complete' || !sessao.setup_intent) return 'pendente';
  const setup = await cliente.get<Setup>(`/setup_intents/${encodeURIComponent(sessao.setup_intent)}`);
  if (setup.id !== sessao.setup_intent || setup.status !== 'succeeded' || setup.usage !== 'off_session' ||
    !setup.payment_method || setup.customer !== sessao.customer ||
    setup.metadata?.cadastro_id !== reserva.id || setup.metadata.tenant_id !== reserva.tenant_id) return 'ignorado';
  const metodo = await cliente.get<Cartao>(`/payment_methods/${encodeURIComponent(setup.payment_method)}`);
  const card = metodo.card;
  if (metodo.id !== setup.payment_method || metodo.type !== 'card' || metodo.customer !== sessao.customer ||
    !card || !/^\d{4}$/.test(card.last4) || !Number.isInteger(card.exp_month) ||
    card.exp_month < 1 || card.exp_month > 12 || !Number.isInteger(card.exp_year) ||
    card.exp_year < 2024 || card.exp_year > 2100 || !card.brand || card.brand.length > 50) return 'ignorado';
  return semTenant(async tx => {
    // Uma conta, uma alteração de cartão por vez. Evento antigo não desfaz o mais novo.
    const [conta] = await tx.$queryRaw<{ psp_customer_id: string }[]>`
      SELECT psp_customer_id FROM billing_customers WHERE tenant_id = ${reserva.tenant_id}::uuid FOR UPDATE
    `;
    if (!conta || conta.psp_customer_id !== sessao.customer) return 'ignorado';
    const [atual] = await tx.$queryRaw<Reserva[]>`
      SELECT * FROM billing_setup_sessions WHERE id = ${reserva.id}::uuid FOR UPDATE
    `;
    if (atual?.state !== 'pending') return 'ignorado';
    const [novo] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM billing_setup_sessions WHERE tenant_id = ${reserva.tenant_id}::uuid
        AND state = 'applied' AND (created_at, id) > (${reserva.created_at}, ${reserva.id}::uuid)
      LIMIT 1
    `;
    if (novo) {
      await tx.$executeRaw`UPDATE billing_setup_sessions SET state = 'superseded' WHERE id = ${reserva.id}::uuid`;
      return 'ignorado';
    }
    await tx.$executeRaw`
      UPDATE billing_customers SET psp_method_id = ${metodo.id}, brand = ${card.brand},
        last4 = ${card.last4}, exp_month = ${card.exp_month}, exp_year = ${card.exp_year}, updated_at = now()
       WHERE tenant_id = ${reserva.tenant_id}::uuid
    `;
    await tx.$executeRaw`
      UPDATE billing_setup_sessions SET state = 'applied', applied_at = now(),
        stripe_session_id = ${sessionId} WHERE id = ${reserva.id}::uuid
    `;
    await registrarNaTrilha(tx, null, reserva.tenant_id, 'billing.card_setup_completed', {
      staffUserId: reserva.staff_user_id, cadastroId: reserva.id,
      consentimento: reserva.consent_version, bandeira: card.brand, final: card.last4,
    });
    return 'aplicado';
  });
}

export async function conciliarCadastrosDeCartao(tenantId?: string, cliente = new StripeCliente()): Promise<{ consultados: number; falhas: number }> {
  if (modoDoAdquirente() !== 'stripe') return { consultados: 0, falhas: 0 };
  const reservas = await semTenant(tx => tx.$queryRaw<{ stripe_session_id: string }[]>`
    SELECT stripe_session_id FROM billing_setup_sessions WHERE state = 'pending'
      AND stripe_session_id IS NOT NULL AND (${tenantId ?? null}::uuid IS NULL OR tenant_id = ${tenantId ?? null}::uuid)
    ORDER BY created_at LIMIT 20
  `);
  let falhas = 0;
  for (const r of reservas) {
    try { await confirmarCadastroDeCartao(r.stripe_session_id, cliente); }
    catch { falhas++; }
  }
  return { consultados: reservas.length, falhas };
}
