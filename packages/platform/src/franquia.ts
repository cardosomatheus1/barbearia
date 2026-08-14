import { semTenant, withTenant } from '@barbearia/db';
import { PlataformaError, registrarNaTrilha } from './plataforma.js';

/**
 * Franquia, do lado da plataforma (bloco 76).
 *
 * ## Quem monta é o Super Admin, e é a única coisa que ele faz aqui
 *
 * Ligar duas barbearias numa franquia é uma operação **entre tenants**, e não
 * existe lugar dentro de uma delas de onde ela possa ser feita: a RLS separa
 * barbearias, e é para isso que ela existe. Por isso a montagem mora aqui, do
 * mesmo jeito que o plano e o bloqueio.
 *
 * O que a plataforma **não** faz é operar a franquia. Ela não publica cardápio,
 * não vê preço praticado e não fala com franqueada. Depois de montada, a
 * franquia é dos dois lados dela.
 */

export interface FranquiaNaPlataforma {
  readonly id: string;
  readonly nome: string;
  readonly criadaEm: Date;
  readonly franqueadora: string | null;
  readonly franqueadas: number;
  readonly itensNoPadrao: number;
}

export interface CasaDaFranquia {
  readonly tenantId: string;
  readonly nome: string;
  readonly papel: 'franqueadora' | 'franqueada';
  readonly entrouEm: Date;
}

/**
 * Cria a franquia com a franqueadora já dentro.
 *
 * Nunca vazia: uma franquia sem franqueadora é um cardápio que ninguém pode
 * publicar, e a tela mostraria uma linha inerte que alguém tentaria usar.
 *
 * A permissão `franchise.manage` é concedida ao dono da franqueadora **aqui**,
 * na mesma transação — é o único instante em que se sabe que aquela barbearia é
 * uma franqueadora. Concedê-la na migração seria dar a toda a base uma
 * permissão que ninguém decidiu dar.
 */
export async function criarFranquia(entrada: {
  readonly adminId: string;
  readonly nome: string;
  readonly franqueadoraTenantId: string;
}): Promise<{ readonly id: string }> {
  const nome = entrada.nome.trim();
  if (nome.length < 2) throw new PlataformaError('invalid_name', 'A franquia precisa de nome');

  const id = await semTenant(async (tx) => {
    const jaEsta = await tx.$queryRaw<{ franchise_id: string }[]>`
      SELECT franchise_id FROM franchise_tenants WHERE tenant_id = ${entrada.franqueadoraTenantId}::uuid
    `;
    if (jaEsta[0]) {
      throw new PlataformaError('already_in_franchise', 'Esta barbearia já é de uma franquia');
    }

    const criadas = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO franchises (name) VALUES (${nome}) RETURNING id
    `;
    const franquia = criadas[0];
    if (!franquia) throw new PlataformaError('invalid_name', 'Não foi possível criar a franquia');

    await tx.$executeRaw`
      INSERT INTO franchise_tenants (tenant_id, franchise_id, role)
      VALUES (${entrada.franqueadoraTenantId}::uuid, ${franquia.id}::uuid, 'franqueadora')
    `;

    await registrarNaTrilha(tx, entrada.adminId, entrada.franqueadoraTenantId, 'franchise.created', {
      franquia: nome,
    });

    return franquia.id;
  });

  await concederPublicacao(entrada.franqueadoraTenantId);
  return { id };
}

/**
 * `franchise.manage` para o papel do dono da franqueadora.
 *
 * `withTenant`, porque `role_permissions` tem RLS — a permissão é da barbearia,
 * não da plataforma. E `ON CONFLICT DO NOTHING`: semear padrão **respeitando
 * quem já decidiu**. Se alguém de lá já tiver desenhado os papéis, remontar a
 * franquia não desfaz o desenho.
 */
async function concederPublicacao(tenantId: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.$executeRaw`
      INSERT INTO role_permissions (tenant_id, role, permission)
      VALUES (${tenantId}::uuid, 'owner', 'franchise.manage')
      ON CONFLICT DO NOTHING
    `;
  });
}

/**
 * Põe uma barbearia dentro de uma franquia, como franqueada.
 *
 * O papel **não vem do corpo**: é sempre `franqueada`. É o precedente do
 * convite do barbeiro no bloco 29 — o papel do convite é sempre `professional`
 * e nunca vem da requisição —, e aqui vale mais ainda: `franqueadora` é quem
 * escreve o padrão da rede inteira, e o índice único parcial recusaria a
 * segunda de qualquer forma. Melhor recusar por desenho que por constraint.
 */
export async function entrarNaFranquia(entrada: {
  readonly adminId: string;
  readonly franquiaId: string;
  readonly tenantId: string;
}): Promise<void> {
  await semTenant(async (tx) => {
    const franquias = await tx.$queryRaw<{ id: string; name: string }[]>`
      SELECT id, name FROM franchises WHERE id = ${entrada.franquiaId}::uuid
    `;
    const franquia = franquias[0];
    if (!franquia) throw new PlataformaError('unknown_franchise', 'Franquia não encontrada');

    const jaEsta = await tx.$queryRaw<{ franchise_id: string }[]>`
      SELECT franchise_id FROM franchise_tenants WHERE tenant_id = ${entrada.tenantId}::uuid
    `;
    if (jaEsta[0]) {
      throw new PlataformaError('already_in_franchise', 'Esta barbearia já é de uma franquia');
    }

    await tx.$executeRaw`
      INSERT INTO franchise_tenants (tenant_id, franchise_id, role)
      VALUES (${entrada.tenantId}::uuid, ${entrada.franquiaId}::uuid, 'franqueada')
    `;

    await registrarNaTrilha(tx, entrada.adminId, entrada.tenantId, 'franchise.joined', {
      franquia: franquia.name,
    });
  });
}

/**
 * Tira uma barbearia da franquia.
 *
 * O que ela vende **fica**: `services.franchise_service_id` continua apontando
 * para o item, e o corte que ela vende há dois anos não pode sumir do catálogo
 * porque um contrato acabou. A leitura do padrão é que para de devolver linha,
 * porque `franquia_do_contexto()` passa a ser nula.
 *
 * A franqueadora não sai: sem ela a franquia fica com um cardápio que ninguém
 * publica. Dissolver a rede é outra operação, e ela não existe ainda.
 */
export async function sairDaFranquia(entrada: {
  readonly adminId: string;
  readonly tenantId: string;
}): Promise<void> {
  await semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<{ franchise_id: string; role: string }[]>`
      SELECT franchise_id, role::text AS role FROM franchise_tenants
       WHERE tenant_id = ${entrada.tenantId}::uuid
    `;
    const vinculo = linhas[0];
    if (!vinculo) throw new PlataformaError('unknown_franchise', 'Esta barbearia não é de uma franquia');
    if (vinculo.role === 'franqueadora') {
      throw new PlataformaError(
        'is_franchisor',
        'A franqueadora não sai: sem ela ninguém publica o padrão',
      );
    }

    await tx.$executeRaw`
      DELETE FROM franchise_tenants WHERE tenant_id = ${entrada.tenantId}::uuid
    `;
    await registrarNaTrilha(tx, entrada.adminId, entrada.tenantId, 'franchise.left', {});
  });
}

/** As franquias montadas, para o painel da plataforma. */
export async function franquiasNaPlataforma(): Promise<readonly FranquiaNaPlataforma[]> {
  return semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        name: string;
        created_at: Date;
        franqueadora: string | null;
        franqueadas: number;
        itens: number;
      }[]
    >`
      SELECT f.id, f.name, f.created_at,
             (SELECT tp.name FROM franchise_tenants ft
                JOIN tenant_platform tp ON tp.tenant_id = ft.tenant_id
               WHERE ft.franchise_id = f.id AND ft.role = 'franqueadora') AS franqueadora,
             (SELECT count(*) FROM franchise_tenants ft
               WHERE ft.franchise_id = f.id AND ft.role = 'franqueada') AS franqueadas,
             (SELECT count(*) FROM franchise_services fs
               WHERE fs.franchise_id = f.id AND fs.active) AS itens
        FROM franchises f
       ORDER BY f.created_at DESC
       LIMIT 200
    `;
    return linhas.map((l) => ({
      id: l.id,
      nome: l.name,
      criadaEm: l.created_at,
      franqueadora: l.franqueadora,
      franqueadas: Number(l.franqueadas),
      itensNoPadrao: Number(l.itens),
    }));
  });
}

/** Quem está dentro de uma franquia. */
export async function casasDaFranquia(franquiaId: string): Promise<readonly CasaDaFranquia[]> {
  return semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<
      { tenant_id: string; name: string; role: string; joined_at: Date }[]
    >`
      SELECT ft.tenant_id, tp.name, ft.role::text AS role, ft.joined_at
        FROM franchise_tenants ft
        JOIN tenant_platform tp ON tp.tenant_id = ft.tenant_id
       WHERE ft.franchise_id = ${franquiaId}::uuid
       ORDER BY ft.role, tp.name
    `;
    return linhas.map((l) => ({
      tenantId: l.tenant_id,
      nome: l.name,
      papel: l.role === 'franqueadora' ? ('franqueadora' as const) : ('franqueada' as const),
      entrouEm: l.joined_at,
    }));
  });
}
