import { semTenant } from '@barbearia/db';

export interface DestinoDoWhatsApp {
  readonly tenantId: string;
  readonly locationId: string;
}

/**
 * De quem é este número — a porta do webhook de mensagens.
 *
 * A tabela é legível antes de existir tenant e guarda só identificadores opacos.
 */
export async function tenantDoNumero(phoneNumberId: string): Promise<DestinoDoWhatsApp | null> {
  return semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<{ tenant_id: string; location_id: string }[]>`
      SELECT tenant_id, location_id FROM whatsapp_numbers
       WHERE phone_number_id = ${phoneNumberId}
    `;
    const linha = linhas[0];
    return linha ? { tenantId: linha.tenant_id, locationId: linha.location_id } : null;
  });
}

/**
 * Destinos de uma WABA — a porta dos eventos de ciclo de vida da conta.
 *
 * Uma WABA pode ter mais de um número/unidade, portanto o retorno é lista. O
 * número visível, quando a Meta o envia, só é comparado depois sob RLS; ele não
 * entra nesta tabela de roteamento público.
 */
export async function tenantsDaWaba(wabaId: string): Promise<readonly DestinoDoWhatsApp[]> {
  return semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<{ tenant_id: string; location_id: string }[]>`
      SELECT tenant_id, location_id FROM whatsapp_wabas
       WHERE waba_id = ${wabaId}
       ORDER BY location_id
    `;
    return linhas.map((linha) => ({ tenantId: linha.tenant_id, locationId: linha.location_id }));
  });
}
