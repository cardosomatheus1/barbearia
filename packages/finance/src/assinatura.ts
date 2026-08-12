import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  assinaturaVale,
  cicloDaAssinatura,
  mrrDasAssinaturas,
  podeUsarBeneficio,
  planoValeNoHorario,
  podeSerDependente,
  type BeneficioDoPlano,
  type EstadoDaAssinatura,
  type JanelaBloqueada,
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
  | 'dentro_do_cooldown'
  | 'e_o_titular'
  | 'ja_e_dependente'
  | 'fora_do_horario_do_plano'
  // A cobrança recorrente (bloco 47).
  | 'fatura_nao_encontrada'
  | 'motivo_obrigatorio'
  | 'cartao_invalido';

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
  e_o_titular: 'Ele já é o titular desta assinatura.',
  ja_e_dependente: 'Esta pessoa já está em outra assinatura.',
  fora_do_horario_do_plano: 'O plano dele não vale neste horário.',
  fatura_nao_encontrada: 'Esta fatura não está aberta.',
  motivo_obrigatorio: 'Escreva o motivo.',
  cartao_invalido: 'Confira os dados do cartão.',
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
  /** Dias de antecedência a mais que o visitante. Zero é a janela da casa. */
  readonly janelaDeAgendamentoDias: number;
  /** As faixas em que o plano **não** vale (bloco 46). */
  readonly bloqueios: readonly JanelaBloqueada[];
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
        booking_window_days: number;
        assinantes: bigint;
        beneficios: unknown;
        bloqueios: unknown;
      }[]
    >(
      `SELECT p.id, p.name, p.description, p.price_cents, p.product_discount_bps, p.active,
              p.booking_window_days,
              (SELECT jsonb_agg(jsonb_build_object(
                        'diaDaSemana', bl.weekday,
                        'inicio', bl.start_minute,
                        'fim', bl.end_minute) ORDER BY bl.weekday, bl.start_minute)
                 FROM club_plan_blackouts bl WHERE bl.plan_id = p.id) AS bloqueios,
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
      janelaDeAgendamentoDias: l.booking_window_days,
      beneficios: (l.beneficios ?? []) as readonly BeneficioNaTela[],
      bloqueios: (l.bloqueios ?? []) as readonly JanelaBloqueada[],
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
  readonly janelaDeAgendamentoDias?: number;
  readonly beneficios: readonly {
    readonly serviceId: string;
    readonly quantidade: number | null;
    readonly cooldownDias: number;
  }[];
  /** As faixas em que o plano não vale (bloco 46). Substituídas inteiras. */
  readonly bloqueios?: readonly JanelaBloqueada[];
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
               booking_window_days = ${entrada.janelaDeAgendamentoDias ?? 0},
               active = ${entrada.ativo}, updated_at = now()
         WHERE id = ${id}::uuid
      `;
      if (afetados === 0) recusar('plano_nao_encontrado');
    } else {
      const criados = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO club_plans
          (tenant_id, name, description, price_cents, product_discount_bps,
           booking_window_days, active)
        VALUES (
          NULLIF(current_setting('app.tenant_id', true), '')::uuid,
          ${entrada.nome.trim()}, ${entrada.descricao ?? null}, ${entrada.precoCents},
          ${entrada.descontoEmProdutoBps}, ${entrada.janelaDeAgendamentoDias ?? 0},
          ${entrada.ativo}
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

    /**
     * Os bloqueios também são substituídos inteiros.
     *
     * Mesma decisão dos benefícios e da ficha de consumo: é uma lista curta que
     * a barbearia refaz de uma vez ("agora o Essencial não pega sábado de
     * manhã"), e um formulário de adicionar e remover por faixa seria mais tela
     * do que o dado merece.
     */
    await tx.$executeRaw`DELETE FROM club_plan_blackouts WHERE plan_id = ${id}::uuid`;
    for (const b of entrada.bloqueios ?? []) {
      await tx.$executeRaw`
        INSERT INTO club_plan_blackouts (tenant_id, plan_id, weekday, start_minute, end_minute)
        VALUES (
          NULLIF(current_setting('app.tenant_id', true), '')::uuid,
          ${id}::uuid, ${b.diaDaSemana}, ${b.inicio}, ${b.fim}
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
  readonly janelaDeAgendamentoDias: number;
  /**
   * Até quando o plano ainda vale, quando o cliente já pediu para sair (bloco 47).
   *
   * Congelada no pedido, e não derivada aqui: a pessoa vai ler a mesma data
   * amanhã, e recalculá-la faria "seu plano vale até 30/08" mudar se alguém
   * mexesse na adesão.
   */
  readonly valeAte: string | null;
  /** Desde quando o benefício está pausado por falta de pagamento. */
  readonly pausadoDesde: string | null;
  readonly bloqueios: readonly JanelaBloqueada[];
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
  janela: number | null;
  bloqueios: unknown;
  plan_id: string | null;
  cancel_effective_at: Date | null;
  suspended_at: Date | null;
}

const SELECT_DA_ASSINATURA = `
  SELECT s.id, s.status, s.price_cents, s.started_at,
         p.name AS plano, p.product_discount_bps AS desconto,
         p.booking_window_days AS janela,
         (SELECT jsonb_agg(jsonb_build_object(
                   'diaDaSemana', bl.weekday,
                   'inicio', bl.start_minute,
                   'fim', bl.end_minute))
            FROM club_plan_blackouts bl WHERE bl.plan_id = p.id) AS bloqueios,
         s.plan_id, s.cancel_effective_at, s.suspended_at
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
      janelaDeAgendamentoDias: assinatura.janela ?? 0,
      valeAte: assinatura.cancel_effective_at?.toISOString() ?? null,
      pausadoDesde: assinatura.suspended_at?.toISOString() ?? null,
      bloqueios: (assinatura.bloqueios ?? []) as readonly JanelaBloqueada[],
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
                 cancel_reason = ${entrada.motivo.trim()},
                 -- O cartão salvo sai junto: assinatura cancelada não guarda
                 -- credencial cobrável (achado da revisão do bloco 47).
                 payment_token = NULL, card_brand = NULL, card_last4 = NULL,
                 card_exp_month = NULL, card_exp_year = NULL, card_warned_at = NULL,
                 updated_at = now()
           WHERE id = ${entrada.assinaturaId}::uuid
             AND customer_id = ${entrada.customerId}::uuid
             AND status <> 'cancelada'
        `
      : await tx.$executeRaw`
          UPDATE club_subscriptions
             SET status = 'cancelada', cancelled_at = ${agora},
                 cancel_reason = ${entrada.motivo.trim()},
                 payment_token = NULL, card_brand = NULL, card_last4 = NULL,
                 card_exp_month = NULL, card_exp_year = NULL, card_warned_at = NULL,
                 updated_at = now()
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
  /**
   * O dia da semana e o minuto **locais** do atendimento, para a restrição de
   * horário do plano (bloco 46).
   *
   * Da unidade, nunca do aparelho — é a regra do produto inteiro. Ausente
   * significa "não confira o horário", que é o caso do balcão fechando uma
   * comanda de um atendimento que já aconteceu: barrar ali seria punir o
   * cliente por um horário que a própria casa concedeu.
   */
  readonly quandoLocal?: { readonly diaDaSemana: number; readonly minuto: number };
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

    /**
     * A assinatura que **cobre** esta pessoa: a dela, ou a de quem a inclui.
     *
     * É por aqui que o dependente usa a cota da família (bloco 46). Sem isto, o
     * filho no plano do pai pagaria o corte inteiro no balcão — e a família
     * descobriria que "plano família" não incluía a família.
     */
    const cobertura = await assinaturaQueCobre(params.tenantId, params.customerId, tx);
    if (!cobertura) return null;

    const assinatura = await assinaturaDoCliente(
      params.tenantId,
      cobertura.titularId,
      agora,
      tx,
    );
    if (!assinatura) return null;

    /**
     * A restrição de horário do plano (SPEC §4.6).
     *
     * *"Assinante do plano Essencial pode não ter acesso a sábado 09:00–13:00, o
     * horário mais disputado."* Sem ela, o plano barato ocupa a hora que a casa
     * vende cheia — e o clube passa a substituir receita em vez de somar.
     */
    if (params.quandoLocal && assinatura.bloqueios.length > 0) {
      const vale = planoValeNoHorario(
        assinatura.bloqueios,
        params.quandoLocal.diaDaSemana,
        params.quandoLocal.minuto,
      );
      if (!vale) return { recusa: 'fora_do_horario_do_plano' };
    }

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
    /** Quem usou — pode ser o titular ou um dependente (bloco 46). */
    readonly customerId: string;
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
      (tenant_id, subscription_id, customer_id, service_id, order_id, appointment_id,
       value_cents, business_day, used_at)
    VALUES (
      NULLIF(current_setting('app.tenant_id', true), '')::uuid,
      ${params.subscriptionId}::uuid, ${params.customerId}::uuid, ${params.serviceId}::uuid,
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

// ---------------------------------------------------------------------------
// Dependentes (bloco 46, SPEC §4.6)
// ---------------------------------------------------------------------------

export interface DependenteNaTela {
  readonly customerId: string;
  readonly nome: string;
  readonly usosNoCiclo: number;
}

/**
 * Quem mais consome esta assinatura.
 *
 * A cota é **da assinatura**, não da pessoa: o plano família de dois cortes dá
 * dois cortes para a família inteira. O que a lista responde é a pergunta
 * seguinte — "quem usou?" —, sem a qual "3 de 5 usados" numa família de quatro é
 * um número que ninguém consegue conferir.
 */
export async function dependentes(
  tenantId: string,
  subscriptionId: string,
  cicloDe: Date,
  cicloAte: Date,
): Promise<readonly DependenteNaTela[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ customer_id: string; nome: string; usos: bigint }[]>`
      SELECT d.customer_id, c.name AS nome,
             (SELECT count(*) FROM club_uses u
               WHERE u.subscription_id = d.subscription_id
                 AND u.customer_id = d.customer_id
                 AND u.used_at >= ${cicloDe} AND u.used_at < ${cicloAte}) AS usos
        FROM club_dependents d
        JOIN customers c ON c.id = d.customer_id
       WHERE d.subscription_id = ${subscriptionId}::uuid
       ORDER BY c.name
    `;
    return linhas.map((l) => ({
      customerId: l.customer_id,
      nome: l.nome,
      usosNoCiclo: Number(l.usos),
    }));
  });
}

export async function incluirDependente(entrada: {
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly customerId: string;
  readonly ator: Ator;
}): Promise<{ readonly incluido: true }> {
  return withTenant(entrada.tenantId, async (tx) => {
    // Ids da requisição conferidos sob RLS antes de virarem chave estrangeira.
    const clientes = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM customers WHERE id = ${entrada.customerId}::uuid
    `;
    if (!clientes[0]) recusar('cliente_nao_encontrado');

    const assinaturas = await tx.$queryRaw<{ status: EstadoDaAssinatura; customer_id: string }[]>`
      SELECT status, customer_id FROM club_subscriptions
       WHERE id = ${entrada.subscriptionId}::uuid
    `;
    const assinatura = assinaturas[0];
    if (!assinatura) recusar('assinatura_nao_encontrada');

    const jaEDeOutra = await tx.$queryRaw<{ subscription_id: string }[]>`
      SELECT subscription_id FROM club_dependents
       WHERE customer_id = ${entrada.customerId}::uuid
    `;

    const recusa = podeSerDependente({
      estado: assinatura.status,
      titularId: assinatura.customer_id,
      candidatoId: entrada.customerId,
      jaEDependenteDeOutra: jaEDeOutra.length > 0,
    });
    if (recusa === 'e_o_titular') recusar('e_o_titular');
    if (recusa === 'ja_e_dependente') recusar('ja_e_dependente');
    if (recusa === 'assinatura_inativa') recusar('assinatura_inativa');

    await tx.$executeRaw`
      INSERT INTO club_dependents (subscription_id, customer_id, tenant_id)
      VALUES (
        ${entrada.subscriptionId}::uuid, ${entrada.customerId}::uuid,
        NULLIF(current_setting('app.tenant_id', true), '')::uuid
      )
      ON CONFLICT DO NOTHING
    `;

    await audit(tx, {
      actorId: entrada.ator.id,
      actorName: entrada.ator.name,
      action: 'subscription.dependent_changed',
      entity: 'club_subscriptions',
      entityId: entrada.subscriptionId,
      after: { incluiu: entrada.customerId },
    });

    return { incluido: true as const };
  });
}

export async function removerDependente(entrada: {
  readonly tenantId: string;
  readonly subscriptionId: string;
  readonly customerId: string;
  readonly ator: Ator;
}): Promise<{ readonly removido: true }> {
  return withTenant(entrada.tenantId, async (tx) => {
    const afetados = await tx.$executeRaw`
      DELETE FROM club_dependents
       WHERE subscription_id = ${entrada.subscriptionId}::uuid
         AND customer_id = ${entrada.customerId}::uuid
    `;
    if (afetados === 0) recusar('assinatura_nao_encontrada');

    await audit(tx, {
      actorId: entrada.ator.id,
      actorName: entrada.ator.name,
      action: 'subscription.dependent_changed',
      entity: 'club_subscriptions',
      entityId: entrada.subscriptionId,
      after: { removeu: entrada.customerId },
    });

    return { removido: true as const };
  });
}

/**
 * A assinatura que **cobre** esta pessoa: a dela, ou a de quem a inclui.
 *
 * É por aqui que o dependente usa a cota da família. A busca é em dois passos e
 * não num `OR`: o vínculo de dependente é o caso raro, e um `OR` faria toda
 * abertura de comanda pagar por ele.
 */
export async function assinaturaQueCobre(
  tenantId: string,
  customerId: string,
  tx?: TransactionClient,
): Promise<{ readonly subscriptionId: string; readonly titularId: string } | null> {
  const dentro = async (
    t: TransactionClient,
  ): Promise<{ readonly subscriptionId: string; readonly titularId: string } | null> => {
    const propria = await t.$queryRaw<{ id: string; customer_id: string }[]>`
      SELECT id, customer_id FROM club_subscriptions
       WHERE customer_id = ${customerId}::uuid AND status <> 'cancelada'
       LIMIT 1
    `;
    if (propria[0]) {
      return { subscriptionId: propria[0].id, titularId: propria[0].customer_id };
    }

    const comoDependente = await t.$queryRaw<{ id: string; customer_id: string }[]>`
      SELECT s.id, s.customer_id
        FROM club_dependents d
        JOIN club_subscriptions s ON s.id = d.subscription_id
       WHERE d.customer_id = ${customerId}::uuid AND s.status <> 'cancelada'
       LIMIT 1
    `;
    return comoDependente[0]
      ? { subscriptionId: comoDependente[0].id, titularId: comoDependente[0].customer_id }
      : null;
  };

  return tx ? dentro(tx) : withTenant(tenantId, dentro);
}
