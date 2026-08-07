import { PrismaClient, Prisma } from '@prisma/client';

/**
 * Cliente de banco com escopo de tenant.
 *
 * A RLS da migração 0001 depende de `app.tenant_id` estar setado na sessão.
 * Como o pool reaproveita conexões entre requisições, o valor precisa ser
 * definido **dentro da transação** (`set_config(..., true)` = local), senão uma
 * requisição herdaria o tenant da anterior — que seria exatamente o vazamento
 * que a RLS existe para impedir.
 *
 * Por isso não existe acesso ao banco fora de `withTenant`.
 */

export type TransactionClient = Prisma.TransactionClient;

let singleton: PrismaClient | undefined;

export function getPrisma(): PrismaClient {
  singleton ??= new PrismaClient();
  return singleton;
}

export async function disconnect(): Promise<void> {
  if (singleton) {
    await singleton.$disconnect();
    singleton = undefined;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Executa `fn` numa transação com o tenant fixado.
 *
 * Toda leitura e escrita dentro de `fn` é filtrada pelas políticas de RLS. Um
 * `WHERE tenant_id` esquecido no repositório não vaza dados.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: TransactionClient) => Promise<T>,
  options: { readonly prisma?: PrismaClient; readonly timeoutMs?: number } = {},
): Promise<T> {
  // O valor vai para dentro de set_config como parâmetro, mas um id malformado
  // causaria erro de cast no meio da transação, com mensagem obscura. Falhar
  // aqui é mais barato e mais claro.
  if (!UUID.test(tenantId)) {
    throw new TypeError(`tenantId inválido: ${JSON.stringify(tenantId)}`);
  }

  const prisma = options.prisma ?? getPrisma();

  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    },
    { timeout: options.timeoutMs ?? 10_000 },
  );
}
