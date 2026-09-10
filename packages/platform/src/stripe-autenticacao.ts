import { withTenant } from '@barbearia/db';
import { modoDoAdquirente } from './adquirente.js';
import { meioDePagamento } from './psp.js';
import { PlataformaError } from './plataforma.js';
import { StripePspProvider } from './stripe-pagamento.js';
import { aplicarEvento } from './conciliacao.js';
import { StripeCliente } from './stripe.js';

export type AutenticacaoDaCobranca =
  | { estado: 'concluida' | 'aguardando' | 'atualizar_cartao' }
  | { estado: 'autenticar'; chavePublica: string; clientSecret: string; paymentMethod: string };

type Intent = { id: string; status: string; customer: string | null; amount: number; currency: string;
  payment_method: string | null; client_secret: string | null; livemode: boolean;
  metadata?: { tenant_id?: string; fatura_id?: string };
  last_payment_error?: { code?: string } | null };

/** Só consulta a cobrança existente. A confirmação no navegador nunca quita a fatura. */
export async function prepararAutenticacaoDaCobranca(p: {
  tenantId: string; faturaId: string;
}, cliente = new StripeCliente()): Promise<AutenticacaoDaCobranca> {
  if (modoDoAdquirente() !== 'stripe') throw new PlataformaError('stripe_indisponivel','A cobrança automática está indisponível.');
  const [fatura] = await withTenant(p.tenantId, tx => tx.$queryRaw<{
    status: string; amount_cents: number; psp_charge_id: string | null;
  }[]>`SELECT status, amount_cents, psp_charge_id FROM invoices WHERE id=${p.faturaId}::uuid`);
  if (!fatura) throw new PlataformaError('unknown_invoice','Fatura não encontrada.');
  if (fatura.status !== 'open') return { estado: 'concluida' };
  const id = fatura.psp_charge_id;
  if (!id || !/^pi_[A-Za-z0-9]+$/.test(id)) return { estado: 'atualizar_cartao' };
  const conta = await meioDePagamento(p.tenantId);
  if (!conta) throw new PlataformaError('conta_stripe_divergente','O cadastro de cobrança precisa ser conferido pelo suporte.');
  const intent = await cliente.get<Intent>(`/payment_intents/${encodeURIComponent(id)}`);
  if (intent.id !== id || intent.customer !== conta.pspCustomerId || intent.amount !== fatura.amount_cents ||
      intent.currency !== 'brl' || intent.metadata?.tenant_id !== p.tenantId || intent.metadata?.fatura_id !== p.faturaId) {
    throw new PlataformaError('cobranca_stripe_divergente','Esta cobrança precisa ser conferida pelo suporte.');
  }
  if (intent.status === 'succeeded' || intent.status === 'processing') return { estado: 'aguardando' };
  if (intent.status !== 'requires_action' && !(intent.status === 'requires_payment_method' && intent.last_payment_error?.code === 'authentication_required')) {
    return { estado: 'atualizar_cartao' };
  }
  const publica = process.env['STRIPE_PUBLISHABLE_KEY'];
  if (!publica || !/^pk_(test|live)_[A-Za-z0-9]+$/.test(publica) || intent.livemode !== publica.startsWith('pk_live_')) {
    throw new PlataformaError('stripe_autenticacao_indisponivel','A confirmação pelo banco está indisponível. Fale com o suporte.');
  }
  const metodo = intent.payment_method ?? conta.pspMethodId;
  if (!metodo || !/^pm_[A-Za-z0-9]+$/.test(metodo)) return { estado: 'atualizar_cartao' };
  const cartao = await cliente.get<{ id: string; customer: string | null; type: string }>(`/payment_methods/${encodeURIComponent(metodo)}`);
  if (cartao.id !== metodo || cartao.type !== 'card' || cartao.customer !== conta.pspCustomerId) {
    throw new PlataformaError('cartao_stripe_divergente','O cartão desta cobrança precisa ser conferido.');
  }
  if (!intent.client_secret || !new RegExp(`^${id}_secret_[A-Za-z0-9]+$`).test(intent.client_secret)) throw new Error('stripe_confirmacao_invalida');
  // Releitura após a rede: não entregar confirmação de cobrança já substituída/encerrada.
  const [atual] = await withTenant(p.tenantId, tx => tx.$queryRaw<{ id: string }[]>`SELECT id FROM invoices
    WHERE id=${p.faturaId}::uuid AND status='open' AND psp_charge_id=${id} AND amount_cents=${intent.amount}`);
  if (!atual) return { estado: 'concluida' };
  return { estado: 'autenticar', chavePublica: publica, clientSecret: intent.client_secret, paymentMethod: metodo };
}

/** Eventos fora de ordem consultam o estado atual antes de quitar/liberar a fatura. */
export async function conciliarEventoDeFaturaStripe(p: {
  tenantId: string; faturaId: string; chargeId: string; eventoId: string;
}, cliente = new StripeCliente()): Promise<string> {
  if (modoDoAdquirente() !== 'stripe' || !/^pi_[A-Za-z0-9]+$/.test(p.chargeId)) return 'ignorado';
  const [f] = await withTenant(p.tenantId, tx => tx.$queryRaw<{ amount_cents: number }[]>`SELECT amount_cents FROM invoices
    WHERE id=${p.faturaId}::uuid AND status='open' AND psp_charge_id=${p.chargeId}`);
  if (!f) return 'ignorado';
  const conta = await meioDePagamento(p.tenantId);
  const intent = await cliente.get<Intent>(`/payment_intents/${encodeURIComponent(p.chargeId)}`);
  if (intent.id !== p.chargeId || intent.customer !== conta?.pspCustomerId || intent.amount !== f.amount_cents ||
    intent.currency !== 'brl' || intent.metadata?.tenant_id !== p.tenantId || intent.metadata?.fatura_id !== p.faturaId) {
    throw new Error('stripe_fatura_divergente');
  }
  // A consulta do provider também cancela recusas definitivas antes de soltar
  // o vínculo. O mesmo tratamento é usado pela conciliação periódica.
  const estado = await new StripePspProvider(cliente).consultar(p.chargeId);
  return aplicarEvento({ eventoId:p.eventoId,chargeId:p.chargeId,
    tipo:estado==='paga' ? 'charge.paid' : estado==='recusada' ? 'charge.failed' : 'charge.pending',
    payload:{ origem:'stripe',estado } });
}
