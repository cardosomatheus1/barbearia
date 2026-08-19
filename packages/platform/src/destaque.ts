import { semTenant, withTenant } from '@barbearia/db';
import { LUGARES_EM_DESTAQUE, precoDoDestaque } from '@barbearia/core';
import { PlataformaError, registrarNaTrilha } from './plataforma.js';

/**
 * Destaque pago na busca, do lado da plataforma (bloco 75).
 *
 * ## Quem vende é a plataforma, e só ela
 *
 * Não existe rota da barbearia que crie anúncio: destaque é **vendido**, não
 * solicitado. Isso não é burocracia — é o que impede a lista de virar leilão
 * automático, e é a mesma postura de `tenant_platform`, que a barbearia não
 * escreve porque é termo comercial do produto.
 *
 * ## `semTenant`, e por que isto não é brecha
 *
 * `marketplace_ads` **tem** RLS, e `FORCE` — ao contrário de
 * `marketplace_listings`. Este comentário dizia o contrário desde que o arquivo
 * foi escrito, e a diferença é o conteúdo: a vitrine só guarda o que a página
 * pública já mostra, e o anúncio guarda preço, fatura, motivo do cancelamento e
 * autor. "Tabela sem RLS pelo argumento 'isto é público' só quando **todas** as
 * colunas são" — quatro delas não são.
 *
 * A política é a de `invoices`: leitura com **ou sem** tenant (a busca anônima
 * roda sem; a barbearia vê o que é dela), escrita só sem tenant, porque destaque
 * é vendido pela plataforma e não solicitado pela barbearia. É por isso que as
 * funções daqui rodam em `semTenant` — não porque a tabela seja aberta.
 *
 * Comentário que afirma o oposto do schema é pior que comentário nenhum: ele é
 * exatamente o raciocínio que já produziu um achado de segurança neste
 * repositório, escrito no topo do arquivo como se fosse a decisão vigente.
 */

export interface Destaque {
  readonly id: string;
  readonly tenantId: string;
  readonly barbearia: string;
  readonly cidade: string;
  readonly estado: string;
  readonly lugar: number;
  readonly de: Date;
  readonly ate: Date;
  readonly valorCents: number;
  readonly estado_: 'ativo' | 'cancelado';
}

const DIA_MS = 86_400_000;
/** Prazo da fatura do destaque. O mesmo da mensalidade e da comissão. */
const DIAS_DE_PRAZO = 5;
/** Piso do motivo escrito do cancelamento, como no resto do produto. */
const MOTIVO_MINIMO = 10;

/**
 * Vende um destaque.
 *
 * A cidade é copiada da unidade **na venda**, e não lida na busca: mudar o
 * cadastro da loja não pode mudar a cidade de um anúncio já cobrado — quem
 * comprou destaque em Salvador comprou em Salvador.
 *
 * O lugar é escolhido por quem vende, e a constraint de exclusão é quem garante
 * que ele estava livre. Um contador aqui teria corrida entre duas vendas
 * simultâneas, e a escassez é o produto.
 */
export async function venderDestaque(entrada: {
  readonly adminId: string;
  readonly tenantId: string;
  /** Ausente é a unidade primária — a mais antiga, como na página pública. */
  readonly locationId?: string | undefined;
  readonly lugar: number;
  readonly de: Date;
  readonly ate: Date;
}): Promise<{ readonly id: string; readonly valorCents: number }> {
  if (!Number.isInteger(entrada.lugar) || entrada.lugar < 1 || entrada.lugar > LUGARES_EM_DESTAQUE) {
    throw new PlataformaError('invalid_slot', `O lugar vai de 1 a ${LUGARES_EM_DESTAQUE}`);
  }
  const dias = Math.round((entrada.ate.getTime() - entrada.de.getTime()) / DIA_MS);
  /**
   * `Number.isFinite` e não só `<= 0`.
   *
   * Com data inválida a subtração dá `NaN`, e `NaN <= 0` é **falso**: a guarda
   * deixava passar, e o `NaN` chegava a `amount_cents`. A borda já recusa a
   * data inexistente; esta é a camada que não depende de a borda ser a única.
   */
  if (!Number.isFinite(dias) || dias <= 0) {
    throw new PlataformaError('invalid_period', 'O período precisa ter pelo menos um dia');
  }

  const valorCents = precoDoDestaque(dias);

  /**
   * A cidade sai de dentro da barbearia, `withTenant`.
   *
   * `locations` tem RLS: ler a unidade sem tenant devolveria zero linhas em
   * silêncio, e o anúncio nasceria sem cidade nenhuma. É a mesma divisão da
   * emissão de comissão do bloco 72.
   */
  const unidade = await withTenant(entrada.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ id: string; city: string | null; state: string | null }[]>`
      SELECT id, city, state FROM locations
       WHERE active
         AND (${entrada.locationId ?? null}::uuid IS NULL OR id = ${entrada.locationId ?? null}::uuid)
       ORDER BY created_at
       LIMIT 1
    `;
    return linhas[0] ?? null;
  });
  if (!unidade?.city || !unidade.state) {
    throw new PlataformaError('unknown_location', 'A unidade precisa de cidade e estado no cadastro');
  }

  return semTenant(async (tx) => {
    const planos = await tx.$queryRaw<{ plan_code: string }[]>`
      SELECT plan_code FROM subscriptions WHERE tenant_id = ${entrada.tenantId}::uuid
    `;
    const planCode = planos[0]?.plan_code;
    if (!planCode) throw new PlataformaError('unknown_tenant', 'Barbearia sem assinatura');

    const vencimento = new Date(entrada.de.getTime() + DIAS_DE_PRAZO * DIA_MS);
    const faturas = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO invoices (tenant_id, kind, plan_code, amount_cents,
                            period_start, period_end, due_at)
      VALUES (${entrada.tenantId}::uuid, 'ad', ${planCode}, ${valorCents},
              ${entrada.de}, ${entrada.ate}, ${vencimento})
      RETURNING id
    `;
    const fatura = faturas[0];
    if (!fatura) throw new PlataformaError('invoice_failed', 'Não foi possível emitir a fatura');

    /**
     * O lugar ocupado vira 409, não 500.
     *
     * A constraint de exclusão é a garantia da escassez, e o erro cru dela é
     * `23P01` — que chegaria à tela do operador como "erro interno" sobre uma
     * venda que só precisava de outra data. Entrada que devolve 500 é defeito
     * de borda, sempre.
     */
    const criados = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO marketplace_ads
        (tenant_id, location_id, city, state, slot, starts_on, ends_on,
         price_cents, invoice_id, created_by)
      VALUES (
        ${entrada.tenantId}::uuid, ${unidade.id}::uuid,
        ${unidade.city}, ${unidade.state}, ${entrada.lugar},
        ${entrada.de}::date, ${entrada.ate}::date,
        ${valorCents}, ${fatura.id}::uuid, ${entrada.adminId}::uuid
      )
      RETURNING id
    `;
    const anuncio = criados[0];
    if (!anuncio) throw new PlataformaError('invoice_failed', 'Não foi possível criar o destaque');

    await registrarNaTrilha(tx, entrada.adminId, entrada.tenantId, 'marketplace.ad_sold', {
      lugar: entrada.lugar,
      cidade: unidade.city,
      dias,
      valorCents,
    });

    return { id: anuncio.id, valorCents };
  }).catch((erro: unknown) => {
    /**
     * `23P01` é a constraint de exclusão: o lugar já está vendido naquele
     * período. Sem esta tradução o operador leria "erro interno" sobre uma
     * venda que só precisava de outra data — e entrada que devolve 500 é
     * defeito de borda, sempre.
     */
    if (erro instanceof PlataformaError) throw erro;
    if (typeof erro === 'object' && erro !== null && String((erro as { message?: string }).message ?? '').includes('marketplace_ads_um_por_lugar')) {
      throw new PlataformaError('slot_taken', 'Este lugar já está vendido neste período');
    }
    throw erro;
  });
}

/**
 * Cancela um destaque, com motivo escrito.
 *
 * Cancelar libera o lugar na hora — é o que a barbearia espera —, e é
 * **estado**, nunca `DELETE`: o anúncio que ela pagou e a plataforma tirou do ar
 * precisa continuar existindo para a conversa ter documento. A fatura já
 * emitida segue o caminho dela, que existe desde o bloco 30 e tem trilha
 * própria: mexer aqui deixaria a cobrança sem par.
 */
export async function cancelarDestaque(entrada: {
  readonly adminId: string;
  readonly anuncioId: string;
  readonly motivo: string;
}): Promise<void> {
  const motivo = entrada.motivo.trim();
  if (motivo.length < MOTIVO_MINIMO) {
    throw new PlataformaError('missing_reason', 'Escreva o motivo do cancelamento');
  }

  await semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<{ tenant_id: string }[]>`
      UPDATE marketplace_ads
         SET status = 'cancelado', cancelled_at = now(), cancel_reason = ${motivo}
       WHERE id = ${entrada.anuncioId}::uuid AND status = 'ativo'
      RETURNING tenant_id
    `;
    const anuncio = linhas[0];
    if (!anuncio) throw new PlataformaError('unknown_ad', 'Destaque não encontrado ou já cancelado');

    await registrarNaTrilha(tx, entrada.adminId, anuncio.tenant_id, 'marketplace.ad_cancelled', {
      motivo,
    });
  });
}

/**
 * Quem está em destaque numa cidade hoje.
 *
 * Devolve slug e lugar — o mínimo que a busca precisa para pôr os cards em cima
 * na ordem comprada. A barbearia bloqueada não aparece: quem não está pagando a
 * plataforma não é vendida por ela, e é a mesma condição da vitrine.
 */
export async function destaquesDaCidade(
  cidade: string,
  estado: string,
  hoje: Date,
): Promise<readonly { readonly locationId: string; readonly lugar: number }[]> {
  return semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<{ location_id: string; slot: number }[]>`
      SELECT a.location_id, a.slot
        FROM marketplace_ads a
        JOIN marketplace_listings m ON m.location_id = a.location_id
        LEFT JOIN tenant_platform tp ON tp.tenant_id = a.tenant_id
       WHERE a.status = 'ativo'
         AND a.city = ${cidade} AND a.state = ${estado}
         AND a.starts_on <= ${hoje}::date AND a.ends_on > ${hoje}::date
         AND tp.blocked_at IS NULL
       ORDER BY a.slot
    `;
    return linhas.map((l) => ({ locationId: l.location_id, lugar: Number(l.slot) }));
  });
}

/** Os destaques vendidos, para o painel da plataforma. */
export async function destaquesVendidos(): Promise<readonly Destaque[]> {
  return semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        tenant_id: string;
        nome: string;
        city: string;
        state: string;
        slot: number;
        starts_on: Date;
        ends_on: Date;
        price_cents: number;
        status: 'ativo' | 'cancelado';
      }[]
    >`
      SELECT a.id, a.tenant_id, t.name AS nome, a.city, a.state, a.slot,
             a.starts_on, a.ends_on, a.price_cents, a.status::text AS status
        FROM marketplace_ads a
        -- tenant_platform e nao tenants, pelo mesmo motivo da lista de
        -- contestacoes: RLS estrita ali, leitura sem tenant aqui.
        JOIN tenant_platform t ON t.tenant_id = a.tenant_id
       ORDER BY a.starts_on DESC
       LIMIT 200
    `;
    return linhas.map((l) => ({
      id: l.id,
      tenantId: l.tenant_id,
      barbearia: l.nome,
      cidade: l.city,
      estado: l.state,
      lugar: Number(l.slot),
      de: l.starts_on,
      ate: l.ends_on,
      valorCents: Number(l.price_cents),
      estado_: l.status,
    }));
  });
}
