import { randomUUID } from 'node:crypto';
import { semTenant } from '@barbearia/db';
import type { PedidoDeCobranca, PspProvider, RespostaDaCobranca } from './psp.js';

type Pedido = Pick<PedidoDeCobranca, 'tenantId' | 'faturaId' | 'valorCents' | 'tentativa'>;
interface Reserva {
  invoice_id: string; tenant_id: string; attempt: number; amount_cents: number;
  psp_customer_id: string; psp_method_id: string;
  state: 'pending' | 'paid' | 'refused'; charge_id: string | null;
  lease_until: Date | null; created_at: Date;
}
const pendente = (): RespostaDaCobranca => ({ estado: 'pendente', chargeId: '' });

/** Rede fora da transação, identidade persistida e posse temporária por fatura. */
export async function cobrarComReserva(p: Pedido, psp: PspProvider, agora = new Date()): Promise<RespostaDaCobranca> {
  const token = randomUUID();
  const reserva = await semTenant(async (tx): Promise<Reserva | RespostaDaCobranca> => {
    const [fatura] = await tx.$queryRaw<{
      tenant_id: string; status: string; amount_cents: number; attempts: number; psp_charge_id: string | null;
    }[]>`SELECT tenant_id, status, amount_cents, attempts, psp_charge_id FROM invoices
      WHERE id=${p.faturaId}::uuid FOR UPDATE`;
    if (!fatura || fatura.tenant_id !== p.tenantId || fatura.status !== 'open' ||
      fatura.amount_cents !== p.valorCents || fatura.attempts + 1 !== p.tentativa) return pendente();
    if (fatura.psp_charge_id) return { estado: 'pendente', chargeId: fatura.psp_charge_id };

    let [linha] = await tx.$queryRaw<Reserva[]>`SELECT * FROM invoice_charge_attempts
      WHERE invoice_id=${p.faturaId}::uuid AND attempt=${p.tentativa}`;
    if (!linha) {
      const [conta] = await tx.$queryRaw<{ psp_customer_id: string; psp_method_id: string | null }[]>`
        SELECT psp_customer_id, psp_method_id FROM billing_customers WHERE tenant_id=${p.tenantId}::uuid`;
      if (!conta?.psp_method_id) return { estado: 'recusada', chargeId: '', motivo: 'sem meio de pagamento cadastrado' };
      [linha] = await tx.$queryRaw<Reserva[]>`INSERT INTO invoice_charge_attempts
        (invoice_id, tenant_id, attempt, amount_cents, psp_customer_id, psp_method_id, created_at)
        VALUES (${p.faturaId}::uuid, ${p.tenantId}::uuid, ${p.tentativa}, ${p.valorCents},
          ${conta.psp_customer_id}, ${conta.psp_method_id}, ${agora}) RETURNING *`;
    }
    if (!linha) throw new Error('cobranca_reserva_ausente');
    if (linha.state === 'refused') return { estado: 'recusada', chargeId: '' };
    if (linha.lease_until && linha.lease_until > agora) return pendente();
    await tx.$executeRaw`UPDATE invoice_charge_attempts SET lease_token=${token}::uuid,
      lease_until=${new Date(agora.getTime() + 60_000)}, updated_at=now()
      WHERE invoice_id=${p.faturaId}::uuid AND attempt=${p.tentativa}`;
    return linha;
  });
  if ('estado' in reserva) return reserva;

  const pedido: PedidoDeCobranca = {
    tenantId: reserva.tenant_id, faturaId: reserva.invoice_id, tentativa: reserva.attempt,
    valorCents: reserva.amount_cents, pspCustomerId: reserva.psp_customer_id, pspMethodId: reserva.psp_method_id,
  };
  try {
    // A Stripe só garante a chave por pelo menos 24h. Margem de uma hora;
    // busca vazia depois desse prazo não autoriza outra criação.
    const antiga = agora.getTime() - reserva.created_at.getTime() >= 23 * 3_600_000;
    const resposta = antiga
      ? await psp.recuperar?.(pedido) ?? null
      : await psp.cobrar(pedido);
    if (!resposta) throw new Error('cobranca_antiga_exige_conciliacao');
    if (resposta.estado !== 'recusada' && !resposta.chargeId) throw new Error('cobranca_sem_identidade');
    return await semTenant(async (tx) => {
      await tx.$queryRaw`SELECT id FROM invoices WHERE id=${p.faturaId}::uuid FOR UPDATE`;
      const alteradas = await tx.$executeRaw`UPDATE invoice_charge_attempts SET
        state=${resposta.estado === 'paga' ? 'paid' : resposta.estado === 'recusada' ? 'refused' : 'pending'},
        charge_id=${resposta.chargeId || null}, lease_token=NULL, lease_until=NULL, updated_at=now()
        WHERE invoice_id=${p.faturaId}::uuid AND attempt=${p.tentativa} AND lease_token=${token}::uuid`;
      if (!alteradas) return pendente();
      if (resposta.chargeId && resposta.estado !== 'recusada') {
        const amarradas = await tx.$executeRaw`UPDATE invoices SET psp_charge_id=${resposta.chargeId}, updated_at=now()
          WHERE id=${p.faturaId}::uuid AND status='open' AND psp_charge_id IS NULL`;
        if (!amarradas) throw new Error('cobranca_vinculo_divergente');
      }
      return resposta;
    });
  } finally {
    // Falha libera a posse, nunca a reserva financeira ou sua identidade.
    await semTenant((tx) => tx.$executeRaw`UPDATE invoice_charge_attempts
      SET lease_token=NULL, lease_until=NULL WHERE invoice_id=${p.faturaId}::uuid
      AND attempt=${p.tentativa} AND lease_token=${token}::uuid`);
  }
}
