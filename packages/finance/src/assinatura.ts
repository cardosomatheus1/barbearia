import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  assinaturaVale,
  cicloDaAssinatura,
  mrrDasAssinaturas,
  podeUsarBeneficio,
  type BeneficioDoPlano,
  type EstadoDaAssinatura,
} from '@barbearia/core';
import { audit } from '@barbearia/identity';

/**
 * Assinaturas do clube: planos, adesão e uso (bloco 45, SPEC §4.6).
 *
 * A regra mora em `packages/core`. Aqui se carrega o ciclo, se pergunta ao
 * domínio e se grava — dentro da transação que fecha a comanda, como o pacote e
 * a fidelidade.
 *
 * ## Isto não é a assinatura da plataforma
 *
 * `subscriptions` é o que a **barbearia paga a nós** (bloco 29). `club_*` é o
 * que o **cliente paga à barbearia**. A SPEC §8 chama as duas de MRR, e o
 * schema as separa para que nenhuma consulta as confunda.
 */

export type AssinaturaFailure =
  | 'plano_nao_encontrado'
  | 'plano_invalido'
  | 'cliente_nao_encontrado'
  | 'ja_assina'
  | 'assinatura_nao_encontrada'
  | 'servico_nao_encontrado'
  | 'assinatura_inativa'
  | 'servico_fora_do_plano'
  | 'cota_esgotada'
  | 'dentro_do_cooldown';

export class AssinaturaError extends Error {
  constructor(readonly code: AssinaturaFailure, message: string) {
    super(message);
    this.name = 'AssinaturaError';
  }
}

const MENSAGEM: Readonly<Record<AssinaturaFailure, string>> = {
  plano_nao_encontrado: 'Este plano não existe.',
  plano_invalido: 'Confira os números do plano.',
  cliente_nao_encontrado: 'Este cliente não existe.',
  ja_assina: 'Este cliente já tem uma assinatura. Cancele a atual para trocar de plano.',
  assinatura_nao_encontrada: 'Esta assinatura não existe.',
  servico_nao_encontrado: 'Este serviço não existe.',
  assinatura_inativa: 'A assinatura deste cliente não está valendo.',
  servico_fora_do_plano: 'O plano dele não cobre este serviço.',
  cota_esgotada: 'Ele já usou tudo que o plano dá neste ciclo.',
  dentro_do_cooldown: 'Ainda não passou o intervalo mínimo entre um uso e outro.',
};

function recusar(code: AssinaturaFailure): never {
  throw new AssinaturaError(code, MENSAGEM[code]);
}

interface Ator {
  readonly id: string;
  readonly name: string;
}

// ---------------------------------------------------------------------------
// Os planos
// ---------------------------------------------------------------------------

export interface BeneficioNaTela extends BeneficioDoPlano {
  readonly servicoNome: string;
  readonly precoAvulsoCents: number;
}

export interface PlanoNaTela {
  readonly id: string;
  readonly nome: string;
  readonly descricao: string | null;
  readonly precoCents: number;
  readonly descontoEmProdutoBps: number;
  readonly ativo: boolean;
  readonly beneficios: readonly BeneficioNaTela[];
  readonly assinantes: number;
}

/**
 * Os planos do clube.
 *
 * `comContagem` decide se `assinantes` vem preenchido, e é achado da
 * `/security-review`: quantas pessoas assinam cada plano, multiplicado pelo
 * preço, **é** o faturamento recorrente da casa — o mesmo número que a rota do
 * clube guarda atrás de `finance.view`. Numa lista aberta a quem monta a
 * comanda, ele era o caminho mais curto para a permissão que o dono negou.
 *
 * Sem a contagem, o que sobra é catálogo: nome, preço de tabela e o que o plano
 * dá. Nada disso revela dinheiro de ninguém.
 */
export async function planos(
  tenantId: string,
  incluirInativos = false,
  comContagem = false,
): Promise<readonly PlanoNaTela[]> {
  return withTenant(tenantId, async (tx) => {
    /**
     * Os benefícios entram por subconsulta agregada, numa query só.
     *
     * Um laço buscando benefícios por plano seria N+1 na tela que o dono abre
     * para decidir preço — e são três ou quatro planos, cada um com dois ou três
     * serviços.
     */
    const linhas = await tx.$queryRawUnsafe<
      {
        id: string;
        name: string;
        description: string | null;
        price_cents: number;
        product_discount_bps: number;
        active: boolean;
        assinantes: bigint;
        beneficios: unknown;
      }[]
    >(
      `SELECT p.id, p.name, p.description, p.price_cents, p.product_discount_bps, p.active,
              CASE WHEN $2::boolean THEN
                (SELECT count(*) FROM club_subscriptions s
                  WHERE s.plan_id = p.id AND s.status IN ('ativa', 'inadimplente'))
              ELSE 0 END AS assinantes,
              (SELECT jsonb_agg(jsonb_build_object(
                        'serviceId', b.service_id::text,
                        'servicoNome', sv.name,
                        'precoAvulsoCents', sv.price_cents,
                        'quantidade', b.quantity,
                        'cooldownDias', b.cooldown_days) ORDER BY sv.name)
                 FROM club_plan_benefits b
                 JOIN services sv ON sv.id = b.service_id
                WHERE b.plan_id = p.id) AS beneficios
         FROM club_plans p
        WHERE ($1::boolean OR p.active)
        ORDER BY p.position, p.name`,
      incluirInativos,
      comContagem,
    );

    return linhas.map((l) => ({
      id: l.id,
      nome: l.name,
      descricao: l.description,
      precoCents: l.price_cents,
      descontoEmProdutoBps: l.product_discount_bps,
      ativo: l.active,
      assinantes: Number(l.assinantes),
      beneficios: (l.beneficios ?? []) as readonly BeneficioNaTela[],
    }));
  });
}

export async function salvarPlano(entrada: {
  readonly tenantId: string;
  readonly id?: string;
  readonly nome: string;
  readonly descricao?: string | null;
  readonly precoCents: number;
  readonly descontoEmProdutoBps: number;
  readonly ativo: boolean;
  readonly beneficios: readonly {
    readonly serviceId: string;
    readonly quantidade: number | null;
    readonly cooldownDias: number;
  }[];
  readonly ator: Ator;
}): Promise<{ readonly id: string }> {
  if (
    entrada.nome.trim().length < 2 ||
    !Number.isInteger(entrada.precoCents) ||
    entrada.precoCents <= 0 ||
    !Number.isInteger(entrada.descontoEmProdutoBps) ||
    entrada.descontoEmProdutoBps < 0 ||
    entrada.descontoEmProdutoBps > 5000
  ) {
    recusar('plano_invalido');
  }
  for (const b of entrada.beneficios) {
    if (b.quantidade !== null && (!Number.isInteger(b.quantidade) || b.quantidade <= 0)) {
      recusar('plano_invalido');
    }
    if (!Number.isInteger(b.cooldownDias) || b.cooldownDias < 0 || b.cooldownDias > 90) {
      recusar('plano_invalido');
    }
  }

  return withTenant(entrada.tenantId, async (tx) => {
    if (entrada.beneficios.length > 0) {
      /**
       * Os serviços vêm do formulário e são conferidos **sob RLS**, com a
       * contagem batendo.
       *
       * A checagem de integridade referencial do Postgres ignora row security:
       * a chave estrangeira aceitaria o serviço do vizinho, e o plano nasceria
       * dando um corte que esta casa não vende. Só somar não pega — um pedido
       * com um serviço legítimo e dois alheios passaria.
       */
      const ids = entrada.beneficios.map((b) => b.serviceId);
      const achados = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM services WHERE id = ANY(${ids}::uuid[])
      `;
      if (achados.length !== new Set(ids).size) recusar('servico_nao_encontrado');
    }

    let id = entrada.id;

    if (id) {
      const afetados = await tx.$executeRaw`
        UPDATE club_plans
           SET name = ${entrada.nome.trim()}, description = ${entrada.descricao ?? null},
               price_cents = ${entrada.precoCents},
               product_discount_bps = ${entrada.descontoEmProdutoBps},
               active = ${entrada.ativo}, updated_at = now()
         WHERE id = ${id}::uuid
      `;
      if (afetados === 0) recusar('plano_nao_encontrado');
    } else {
      const criados = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO club_plans
          (tenant_id, name, description, price_cents, product_discount_bps, active)
        VALUES (
          NULLIF(current_setting('app.tenant_id', true), '')::uuid,
          ${entrada.nome.trim()}, ${entrada.descricao ?? null}, ${entrada.precoCents},
          ${entrada.descontoEmProdutoBps}, ${entrada.ativo}
        )
        RETURNING id
      `;
      id = criados[0]?.id;
      if (id === undefined) recusar('plano_invalido');
    }

    /**
     * Os benefícios são substituídos inteiros.
     *
     * É uma lista curta que a barbearia refaz de uma vez ("agora o Premium dá
     * barba também"), e o preço já vendido não muda por isso: `club_subscriptions`
     * congela o valor na adesão. O que muda é o que o assinante passa a poder
     * usar — que é justamente a decisão que o dono está tomando.
     */
    await tx.$executeRaw`DELETE FROM club_plan_benefits WHERE plan_id = ${id}::uuid`;
    for (const b of entrada.beneficios) {
      await tx.$executeRaw`
        INSERT INTO club_plan_benefits (plan_id, service_id, tenant_id, quantity, cooldown_days)
        VALUES (
          ${id}::uuid, ${b.serviceId}::uuid,
          NULLIF(current_setting('app.tenant_id', true), '')::uuid,
          ${b.quantidade}, ${b.cooldownDias}
        )
      `;
    }

    await audit(tx, {
      actorId: entrada.ator.id,
      actorName: entrada.ator.name,
      action: 'subscription.plan_changed',
      entity: 'club_plans',
      entityId: id,
      after: {
        nome: entrada.nome,
        precoCents: entrada.precoCents,
        beneficios: entrada.beneficios.length,
      },
    });

    return { id };
  });
}

// ---------------------------------------------------------------------------
// A assinatura de um cliente
// ---------------------------------------------------------------------------

export interface AssinaturaNaTela {
  readonly id: string;
  readonly planoNome: string;
  readonly estado: EstadoDaAssinatura;
  readonly precoCents: number;
  readonly desdeEm: string;
  readonly cicloDe: string;
  readonly cicloAte: string;
  readonly descontoEmProdutoBps: number;
  readonly beneficios: readonly {
    readonly serviceId: string;
    readonly servicoNome: string;
    readonly quantidade: number | null;
    readonly cooldownDias: number;
    readonly usados: number;
    /** O mais recente de todos, **sem** corte de ciclo — é dele que o cooldown conta. */
    readonly ultimoUso: string | null;
    readonly liberaEm: string | null;
  }[];
}

interface LinhaDaAssinatura {
  id: string;
  status: EstadoDaAssinatura;
  price_cents: number;
  started_at: Date;
  plano: string | null;
  desconto: number | null;
  plan_id: string | null;
}

const SELECT_DA_ASSINATURA = `
  SELECT s.id, s.status, s.price_cents, s.started_at,
         p.name AS plano, p.product_discount_bps AS desconto, s.plan_id
    FROM club_subscriptions s
    LEFT JOIN club_plans p ON p.id = s.plan_id
`;

/**
 * A assinatura viva de um cliente, com a cota do ciclo já contada.
 *
 * Filtra por `customer_id` — a RLS separa barbearias e **não** separa clientes
 * dentro de uma.
 */
export async function assinaturaDoCliente(
  tenantId: string,
  customerId: string,
  agora: Date = new Date(),
  tx?: TransactionClient,
): Promise<AssinaturaNaTela | null> {
  const dentro = async (t: TransactionClient): Promise<AssinaturaNaTela | null> => {
    const linhas = await t.$queryRawUnsafe<LinhaDaAssinatura[]>(
      `${SELECT_DA_ASSINATURA} WHERE s.customer_id = $1::uuid AND s.status <> 'cancelada' LIMIT 1`,
      customerId,
    );
    const assinatura = linhas[0];
    if (!assinatura) return null;

    const ciclo = cicloDaAssinatura(assinatura.started_at, agora);

    const beneficios = await t.$queryRaw<
      {
        service_id: string;
        nome: string;
        quantity: number | null;
        cooldown_days: number;
        usados: bigint;
        ultimo: Date | null;
      }[]
    >`
      SELECT b.service_id, sv.name AS nome, b.quantity, b.cooldown_days,
             (SELECT count(*) FROM club_uses u
               WHERE u.subscription_id = ${assinatura.id}::uuid
                 AND u.service_id = b.service_id
                 AND u.used_at >= ${ciclo.de} AND u.used_at < ${ciclo.ate}) AS usados,
             (SELECT max(u.used_at) FROM club_uses u
               WHERE u.subscription_id = ${assinatura.id}::uuid
                 AND u.service_id = b.service_id) AS ultimo
        FROM club_plan_benefits b
        JOIN services sv ON sv.id = b.service_id
       WHERE b.plan_id = ${assinatura.plan_id}::uuid
       ORDER BY sv.name
    `;

    return {
      id: assinatura.id,
      planoNome: assinatura.plano ?? 'Plano removido',
      estado: assinatura.status,
      precoCents: assinatura.price_cents,
      desdeEm: assinatura.started_at.toISOString(),
      cicloDe: ciclo.de.toISOString(),
      cicloAte: ciclo.ate.toISOString(),
      descontoEmProdutoBps: assinatura.desconto ?? 0,
      beneficios: beneficios.map((b) => ({
        serviceId: b.service_id,
        servicoNome: b.nome,
        quantidade: b.quantity,
        cooldownDias: b.cooldown_days,
        usados: Number(b.usados),
        ultimoUso: b.ultimo?.toISOString() ?? null,
        /**
         * O cooldown conta do **último uso de todos**, não do ciclo.
         *
         * Um corte no dia 18 segura o do dia 20 mesmo que o ciclo tenha virado
         * no dia 19 — o intervalo é sobre o cabelo da pessoa, não sobre o
         * calendário da cobrança.
         */
        liberaEm:
          b.cooldown_days > 0 && b.ultimo
            ? new Date(b.ultimo.getTime() + b.cooldown_days * 86_400_000).toISOString()
            : null,
      })),
    };
  };

  return tx ? dentro(tx) : withTenant(tenantId, dentro);
}

export async function assinar(entrada: {
  readonly tenantId: string;
  readonly customerId: string;
  readonly planId: string;
  readonly ator: Ator;
  readonly agora?: Date;
}): Promise<{ readonly id: string }> {
  const agora = entrada.agora ?? new Date();

  return withTenant(entrada.tenantId, async (tx) => {
    // Ids da requisição conferidos sob RLS antes de virarem chave estrangeira.
    const clientes = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM customers WHERE id = ${entrada.customerId}::uuid
    `;
    if (!clientes[0]) recusar('cliente_nao_encontrado');

    const planos_ = await tx.$queryRaw<{ price_cents: number }[]>`
      SELECT price_cents FROM club_plans WHERE id = ${entrada.planId}::uuid AND active
    `;
    const plano = planos_[0];
    if (!plano) recusar('plano_nao_encontrado');

    /**
     * O preço é lido do plano **dentro da transação**, nunca do corpo.
     *
     * É a mesma decisão do pacote e do produto: aceitar o preço da tela faria
     * uma assinatura de R$ 1 dar corte ilimitado, com o MRR mentindo e a
     * cobrança recorrente do bloco 47 cobrando o valor errado para sempre.
     */
    const criadas = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO club_subscriptions
        (tenant_id, customer_id, plan_id, price_cents, status, started_at)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${entrada.customerId}::uuid, ${entrada.planId}::uuid,
        ${plano.price_cents}, 'ativa', ${agora}
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    const id = criadas[0]?.id;
    // O índice único é quem garante: uma assinatura viva por cliente.
    if (id === undefined) recusar('ja_assina');

    await audit(tx, {
      actorId: entrada.ator.id,
      actorName: entrada.ator.name,
      action: 'subscription.started',
      entity: 'club_subscriptions',
      entityId: id,
      after: { planId: entrada.planId, precoCents: plano.price_cents },
    });

    return { id };
  });
}

export async function cancelarAssinatura(entrada: {
  readonly tenantId: string;
  readonly assinaturaId: string;
  readonly motivo: string;
  readonly ator: Ator;
  readonly agora?: Date;
  /** Filtro obrigatório quando quem cancela é o próprio cliente. */
  readonly customerId?: string;
}): Promise<{ readonly cancelada: true }> {
  const agora = entrada.agora ?? new Date();

  return withTenant(entrada.tenantId, async (tx) => {
    /**
     * `customer_id` no `WHERE` quando o pedido vem do cliente.
     *
     * A RLS separa barbearias e não separa clientes dentro de uma: sem o filtro,
     * um id de assinatura vazado bastaria para cancelar a de outra pessoa. O
     * cancelamento self-service é exigência da SPEC §4.6 e é do bloco 47; a
     * porta já nasce fechada.
     */
    const afetadas = entrada.customerId
      ? await tx.$executeRaw`
          UPDATE club_subscriptions
             SET status = 'cancelada', cancelled_at = ${agora},
                 cancel_reason = ${entrada.motivo.trim()}, updated_at = now()
           WHERE id = ${entrada.assinaturaId}::uuid
             AND customer_id = ${entrada.customerId}::uuid
             AND status <> 'cancelada'
        `
      : await tx.$executeRaw`
          UPDATE club_subscriptions
             SET status = 'cancelada', cancelled_at = ${agora},
                 cancel_reason = ${entrada.motivo.trim()}, updated_at = now()
           WHERE id = ${entrada.assinaturaId}::uuid AND status <> 'cancelada'
        `;
    if (afetadas === 0) recusar('assinatura_nao_encontrada');

    await audit(tx, {
      actorId: entrada.ator.id,
      actorName: entrada.ator.name,
      action: 'subscription.cancelled',
      entity: 'club_subscriptions',
      entityId: entrada.assinaturaId,
      after: { motivo: entrada.motivo },
    });

    return { cancelada: true as const };
  });
}

// ---------------------------------------------------------------------------
// O uso, na comanda
// ---------------------------------------------------------------------------

export interface UsoDisponivel {
  readonly subscriptionId: string;
  readonly valorCents: number;
  readonly restamDepois: number | null;
}

/**
 * Este assinante pode usar o plano neste serviço agora?
 *
 * Chamada antes de fechar a comanda, para a tela mostrar; e **de novo** dentro
 * da transação, sob a trava, porque entre uma coisa e outra pode ter entrado
 * outro uso.
 */
export async function usoDisponivel(params: {
  readonly tenantId: string;
  readonly customerId: string | null;
  readonly serviceId: string;
  readonly precoCents: number;
  readonly agora?: Date;
  readonly tx?: TransactionClient;
}): Promise<UsoDisponivel | { readonly recusa: AssinaturaFailure } | null> {
  const agora = params.agora ?? new Date();

  const dentro = async (
    tx: TransactionClient,
  ): Promise<UsoDisponivel | { readonly recusa: AssinaturaFailure } | null> => {
    if (!params.customerId) return null;

    /**
     * A trava é do caminho que grava, não do que mostra.
     *
     * Sem ela, duas comandas do mesmo assinante fechando juntas leem "usou 1 de
     * 2" as duas e gravam as duas — três cortes num plano de dois. É a mesma
     * lição do pacote no bloco 42.
     */
    if (params.tx) {
      await tx.$executeRaw`
        SELECT 1 FROM club_subscriptions
         WHERE customer_id = ${params.customerId}::uuid AND status <> 'cancelada'
         FOR UPDATE
      `;
    }

    const assinatura = await assinaturaDoCliente(params.tenantId, params.customerId, agora, tx);
    if (!assinatura) return null;

    /**
     * O repositório já conta e já sabe o último uso; o domínio recebe os dois
     * números prontos.
     *
     * A primeira versão sintetizava uma lista de usos a partir da contagem do
     * ciclo, e perdia o cooldown sempre que o último corte tinha caído no ciclo
     * anterior — quem cortou no dia 28 e viu o ciclo virar no dia 30 cortava de
     * novo no dia 30. `ultimoUso` vem sem corte de ciclo, que é o que a regra
     * pede.
     */
    const doServico = assinatura.beneficios.find((b) => b.serviceId === params.serviceId);

    const decisao = podeUsarBeneficio({
      estado: assinatura.estado,
      beneficios: assinatura.beneficios.map((b) => ({
        serviceId: b.serviceId,
        quantidade: b.quantidade,
        cooldownDias: b.cooldownDias,
      })),
      serviceId: params.serviceId,
      uso: {
        usados: doServico?.usados ?? 0,
        ultimoUso: doServico?.ultimoUso ? new Date(doServico.ultimoUso) : null,
      },
      agora,
    });

    if (!decisao.pode) return { recusa: decisao.recusa as AssinaturaFailure };

    return {
      subscriptionId: assinatura.id,
      valorCents: params.precoCents,
      restamDepois: decisao.restam === null ? null : decisao.restam - 1,
    };
  };

  return params.tx ? dentro(params.tx) : withTenant(params.tenantId, dentro);
}

/** Consome uma cota, **dentro da transação que fecha a comanda**. */
export async function consumirAssinatura(
  tx: TransactionClient,
  params: {
    readonly subscriptionId: string;
    readonly serviceId: string;
    readonly orderId: string;
    readonly valorCents: number;
    readonly diaDaUnidade: string;
    readonly agora: Date;
    readonly appointmentId?: string | null;
  },
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO club_uses
      (tenant_id, subscription_id, service_id, order_id, appointment_id,
       value_cents, business_day, used_at)
    VALUES (
      NULLIF(current_setting('app.tenant_id', true), '')::uuid,
      ${params.subscriptionId}::uuid, ${params.serviceId}::uuid,
      ${params.orderId}::uuid, ${params.appointmentId ?? null}::uuid,
      ${params.valorCents}, ${params.diaDaUnidade}::date, ${params.agora}
    )
    ON CONFLICT DO NOTHING
  `;
}

// ---------------------------------------------------------------------------
// O MRR da barbearia (SPEC §8) — lacuna declarada no bloco 29
// ---------------------------------------------------------------------------

export interface ClubeDaCasa {
  readonly mrrCents: number;
  readonly ativas: number;
  readonly inadimplentes: number;
  readonly porPlano: readonly {
    readonly planoId: string;
    readonly nome: string;
    readonly assinantes: number;
    readonly mrrCents: number;
  }[];
}

/**
 * O MRR do **clube**, que é o que os clientes pagam à barbearia.
 *
 * Não se confunde com o MRR da plataforma (bloco 29): aquele é o que a
 * barbearia paga a nós. A SPEC §8 pede os dois, e o segundo estava declarado
 * como lacuna desde então.
 */
export async function clubeDaCasa(tenantId: string): Promise<ClubeDaCasa> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      { plan_id: string | null; nome: string | null; status: EstadoDaAssinatura; price_cents: number }[]
    >`
      SELECT s.plan_id, p.name AS nome, s.status, s.price_cents
        FROM club_subscriptions s
        LEFT JOIN club_plans p ON p.id = s.plan_id
       WHERE s.status <> 'cancelada'
    `;

    const { mrrCents, ativas } = mrrDasAssinaturas(
      linhas.map((l) => ({ estado: l.status, precoCents: l.price_cents })),
    );

    const porPlano = new Map<string, { nome: string; assinantes: number; mrrCents: number }>();
    for (const l of linhas) {
      if (!assinaturaVale(l.status) || !l.plan_id) continue;
      const conta = porPlano.get(l.plan_id) ?? { nome: l.nome ?? 'Plano removido', assinantes: 0, mrrCents: 0 };
      conta.assinantes += 1;
      conta.mrrCents += l.price_cents;
      porPlano.set(l.plan_id, conta);
    }

    return {
      mrrCents,
      ativas,
      inadimplentes: linhas.filter((l) => l.status === 'inadimplente').length,
      porPlano: [...porPlano].map(([planoId, c]) => ({ planoId, ...c })),
    };
  });
}
