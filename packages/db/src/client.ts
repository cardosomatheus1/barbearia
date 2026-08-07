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

/**
 * Confirma que a conexão da aplicação **não** ignora RLS.
 *
 * Todo o isolamento multi-tenant depende disso. Um `DATABASE_URL` apontando
 * para superusuário desliga a RLS silenciosamente: nada falha, nada avisa, e
 * cada barbearia passa a enxergar a base inteira.
 *
 * Foi exatamente o que aconteceu no arnês de testes do bloco 4 — os testes de
 * isolamento passavam sem provar nada. Falhar alto na subida é barato; descobrir
 * em produção, não.
 *
 * Chamar no bootstrap, antes de servir a primeira requisição.
 */
export async function assertRlsEnforced(prisma: PrismaClient = getPrisma()): Promise<void> {
  const rows = await prisma.$queryRaw<
    { is_superuser: string; bypass_rls: boolean; role_name: string }[]
  >`
    SELECT current_setting('is_superuser') AS is_superuser,
           rolbypassrls AS bypass_rls,
           current_user AS role_name
    FROM pg_roles WHERE rolname = current_user
  `;

  const row = rows[0];
  if (!row) throw new Error('Não foi possível verificar o role da conexão');

  if (row.is_superuser === 'on' || row.bypass_rls) {
    throw new Error(
      `Conexão da aplicação usa o role "${row.role_name}", que ignora RLS. ` +
        'O isolamento entre tenants não teria efeito. Use um role NOSUPERUSER NOBYPASSRLS.',
    );
  }
}
