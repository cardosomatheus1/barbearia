import { createHash, randomBytes } from 'node:crypto';
import { withTenant, type TransactionClient } from '@barbearia/db';
import { VERSAO_CONSENTIMENTO_WHATSAPP_CADASTRO, textoConsentimentoWhatsAppCadastro } from '@barbearia/core';
export class ConsentimentoCadastroError extends Error {
  constructor(readonly code: string, message: string, readonly status = 404) { super(message); }
}
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const VALIDADE_MS = 30 * 60_000;
export async function solicitarConsentimentoCadastro(p: { tenantId: string; customerId: string; appointmentId: string; ip: string | null; agora: Date }) {
  return withTenant(p.tenantId, async tx => {
    const [origem] = await tx.$queryRaw<{ name: string }[]>`SELECT t.name FROM tenants t
      JOIN appointments a ON a.tenant_id = t.id JOIN customers c ON c.id = a.customer_id
      WHERE a.id = ${p.appointmentId}::uuid AND a.customer_id = ${p.customerId}::uuid AND c.anonymized_at IS NULL`;
    if (!origem) throw new ConsentimentoCadastroError('consentimento_indisponivel', 'Não foi possível preparar a confirmação do WhatsApp.');
    await limparPedidosConsentimento(tx, p.agora);
    const token = randomBytes(32).toString('base64url'); const expiresAt = new Date(p.agora.getTime() + VALIDADE_MS);
    await tx.$executeRaw`INSERT INTO customer_marketing_requests
      (tenant_id,customer_id,appointment_id,token_hash,text_version,text_snapshot,requested_ip,created_at,expires_at)
      VALUES (${p.tenantId}::uuid,${p.customerId}::uuid,${p.appointmentId}::uuid,${hash(token)},
        ${VERSAO_CONSENTIMENTO_WHATSAPP_CADASTRO},${textoConsentimentoWhatsAppCadastro(origem.name)},${p.ip}::inet,${p.agora},${expiresAt})`;
    return { token, expiresAt: expiresAt.toISOString() };
  });
}
interface Pedido { id: string; text_version: string; text_snapshot: string; requested_ip: string | null; created_at: Date; consumed_at: Date | null }
async function pedido(tx: TransactionClient, p: { customerId: string; token: string; agora: Date }): Promise<Pedido> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(p.token)) throw new ConsentimentoCadastroError('consentimento_indisponivel', 'Esta confirmação expirou. Você pode escolher suas preferências em Meus agendamentos.');
  const [r] = await tx.$queryRaw<Pedido[]>`SELECT id,text_version,text_snapshot,requested_ip::text,created_at,consumed_at
    FROM customer_marketing_requests WHERE token_hash = ${hash(p.token)} AND customer_id = ${p.customerId}::uuid
      AND expires_at > ${p.agora} FOR UPDATE`;
  if (!r) throw new ConsentimentoCadastroError('consentimento_indisponivel', 'Esta confirmação expirou ou pertence a outro número. Confira suas preferências em Meus agendamentos.');
  return r;
}
export async function lerConsentimentoCadastro(p: { tenantId: string; customerId: string; token: string; agora: Date }) {
  return withTenant(p.tenantId, async tx => { const r = await pedido(tx, p); return { texto: r.text_snapshot, confirmado: r.consumed_at !== null }; });
}
/** Exige customerId da sessão OTP; saber o telefone ou o UUID do horário não autoriza nada. */
export async function confirmarConsentimentoCadastro(p: { tenantId: string; customerId: string; token: string; ip: string | null; agora: Date }) {
  return withTenant(p.tenantId, async tx => {
    // A anonimização também trava o cliente antes dos pedidos. Duas confirmações
    // em abas diferentes não podem promover travas SHARE simultâneas para UPDATE.
    const [cliente] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM customers WHERE id = ${p.customerId}::uuid AND anonymized_at IS NULL FOR UPDATE`;
    if (!cliente) throw new ConsentimentoCadastroError('consentimento_indisponivel', 'Cadastro indisponível.');
    const r = await pedido(tx, p);
    // Uma confirmação já consumida não representa a preferência atual: o titular
    // pode ter revogado o aceite depois. O chamador não deve anunciar ativação.
    if (r.consumed_at) return { confirmado: true as const, novoAceite: false };
    await tx.$executeRaw`INSERT INTO customer_consents
      (tenant_id,customer_id,purpose,granted,text_version,text_snapshot,verification_method,requested_at,requested_ip,ip,decided_at)
      VALUES (${p.tenantId}::uuid,${p.customerId}::uuid,'marketing',true,${r.text_version},${r.text_snapshot},'sessao_otp',
        ${r.created_at},${r.requested_ip}::inet,${p.ip}::inet,${p.agora})`;
    await tx.$executeRaw`UPDATE customer_marketing_requests SET consumed_at = ${p.agora} WHERE id = ${r.id}::uuid`;
    return { confirmado: true as const, novoAceite: true };
  });
}
export async function limparPedidosConsentimento(tx: TransactionClient, agora: Date): Promise<void> {
  await tx.$executeRaw`DELETE FROM customer_marketing_requests WHERE expires_at <= ${agora}`;
}

/**
 * A varredura da limpeza acima, e por que carona não bastava.
 *
 * `limparPedidosConsentimento` só era chamada de carona: quando **outra** pessoa
 * pede consentimento, e na anonimização. Carona só alcança quem volta — a
 * barbearia que experimenta o fluxo e para fica com o pedido vencido para
 * sempre, e `customer_marketing_requests` guarda `requested_ip`, que é dado
 * pessoal. É a convenção que já estava escrita: *carona **e** varredura*, como
 * o `payload` do preview de importação.
 *
 * Achada pela guarda de varredura sem chamador, não pela revisão — a terceira
 * vez que ela pega esta classe.
 */
export async function expirarPedidosConsentimento(tenantId: string, agora: Date): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await limparPedidosConsentimento(tx, agora);
  });
}
