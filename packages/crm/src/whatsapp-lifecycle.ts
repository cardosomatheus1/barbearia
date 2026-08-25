import { withTenant } from '@barbearia/db';

/**
 * Confere o número visível somente depois de o roteamento opaco ter resolvido
 * tenant + unidade. Assim `display_phone` continua protegido pela RLS e nunca
 * precisa ir para a tabela pública usada antes do contexto do tenant existir.
 */
export async function numeroVisivelDaUnidadeConfere(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly numeroVisivel: string;
}): Promise<boolean> {
  const normalizar = (valor: string) => valor.replace(/\D/g, '');
  const esperado = normalizar(params.numeroVisivel);
  if (!esperado) return false;

  const salvo = await withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ display_phone: string | null }[]>`
      SELECT display_phone FROM whatsapp_settings
       WHERE location_id = ${params.locationId}::uuid
    `;
    return linhas[0]?.display_phone ?? null;
  });
  return salvo !== null && normalizar(salvo) === esperado;
}

/** Suspende uma unidade já resolvida por WABA, sem depender do número visível. */
export async function suspenderUnidadeWhatsApp(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly motivo: string;
}): Promise<boolean> {
  return withTenant(params.tenantId, async (tx) => {
    const afetadas = await tx.$executeRaw`
      UPDATE whatsapp_settings
         SET status = 'suspenso', status_reason = ${params.motivo}, updated_at = now()
       WHERE location_id = ${params.locationId}::uuid
         AND status <> 'suspenso'
    `;
    return afetadas === 1;
  });
}

/**
 * Um reconnect não prova sozinho que o número já voltou a operar. Ele apenas
 * reabre a verificação; a próxima conciliação pergunta à Meta e só então
 * promove para `ativo`.
 */
export async function prepararReconciliacaoDaUnidade(params: {
  readonly tenantId: string;
  readonly locationId: string;
}): Promise<boolean> {
  return withTenant(params.tenantId, async (tx) => {
    const afetadas = await tx.$executeRaw`
      UPDATE whatsapp_settings
         SET status = 'aguardando_verificacao',
             status_reason = NULL,
             verified_at = NULL,
             updated_at = now()
       WHERE location_id = ${params.locationId}::uuid
         AND status = 'suspenso'
         AND phone_number_id IS NOT NULL
         AND waba_id IS NOT NULL
         AND access_token_cipher IS NOT NULL
    `;
    return afetadas === 1;
  });
}

