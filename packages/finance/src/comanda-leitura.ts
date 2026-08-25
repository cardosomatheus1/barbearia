import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  somarComanda,
  type DescontoDaComanda,
  type FormaDePagamento,
  type TipoDeItem,
} from '@barbearia/core';
import { inteiroSeguroDoBanco } from './inteiro-seguro.js';
import { ComandaError, type Comanda } from './comanda-tipos.js';

/**
 * Carrega a comanda. Com `locationId`, ela precisa ser **daquela loja**.
 *
 * `null` significa "a loja já foi conferida por quem chamou" — e só os
 * caminhos internos, depois de `exigirAberta`, o usam. Nenhuma porta de fora
 * do módulo passa `null`.
 */
export async function carregarComanda(
  tx: TransactionClient,
  orderId: string,
  locationId: string | null,
): Promise<Comanda> {
  const cabecas = await tx.$queryRaw<
    {
      id: string;
      status: Comanda['status'];
      customer_id: string | null;
      customer_name: string | null;
      balance_cents: number | null;
      credit_limit_cents: number | null;
      appointment_id: string | null;
      opened_at: Date;
      closed_at: Date | null;
      discount_cents: number;
      discount_reason: string | null;
      tip_cents: number;
      tip_professional_id: string | null;
      change_cents: number;
    }[]
  >`
    SELECT o.id, o.status, o.customer_id, c.name AS customer_name,
           c.balance_cents, c.credit_limit_cents,
           o.appointment_id, o.opened_at, o.closed_at,
           o.discount_cents, o.discount_reason, o.tip_cents, o.tip_professional_id,
           o.change_cents
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.id = ${orderId}::uuid
       AND (${locationId}::uuid IS NULL OR o.location_id = ${locationId}::uuid)
  `;
  const cabeca = cabecas[0];
  if (!cabeca) {
    throw new ComandaError('comanda_nao_encontrada', 'Esta comanda não existe mais.');
  }

  const linhas = await tx.$queryRaw<
    {
      id: string;
      kind: TipoDeItem;
      service_id: string | null;
      description: string;
      quantity: number;
      unit_price_cents: number;
      professional_id: string | null;
      professional_name: string | null;
    }[]
  >`
    SELECT i.id, i.kind, i.service_id, i.description, i.quantity, i.unit_price_cents,
           i.professional_id, p.name AS professional_name
      FROM order_items i
      LEFT JOIN professionals p ON p.id = i.professional_id
     WHERE i.order_id = ${orderId}::uuid
     ORDER BY i.position, i.created_at
  `;

  const pagos = await tx.$queryRaw<{ method: FormaDePagamento; amount_cents: number }[]>`
    SELECT method, amount_cents FROM order_payments
     WHERE order_id = ${orderId}::uuid ORDER BY created_at
  `;

  const itens = linhas.map((linha) => ({
    id: linha.id,
    tipo: linha.kind,
    serviceId: linha.service_id,
    descricao: linha.description,
    quantidade: linha.quantity,
    precoUnitarioCents: linha.unit_price_cents,
    professionalId: linha.professional_id,
    professionalName: linha.professional_name,
  }));

  const desconto: DescontoDaComanda | null =
    cabeca.discount_cents > 0
      ? { tipo: 'amount', valor: cabeca.discount_cents, motivo: cabeca.discount_reason }
      : null;

  const totais = somarComanda({ itens, desconto, gorjetaCents: cabeca.tip_cents });

  return {
    id: cabeca.id,
    status: cabeca.status,
    customerId: cabeca.customer_id,
    customerName: cabeca.customer_name,
    appointmentId: cabeca.appointment_id,
    openedAt: cabeca.opened_at.toISOString(),
    closedAt: cabeca.closed_at?.toISOString() ?? null,
    itens,
    desconto,
    gorjetaCents: totais.gorjetaCents,
    gorjetaProfessionalId: cabeca.tip_professional_id,
    subtotalCents: totais.subtotalCents,
    descontoCents: totais.descontoCents,
    totalCents: totais.totalCents,
    trocoCents: cabeca.change_cents,
    pagamentos: pagos.map((p) => ({ forma: p.method, valorCents: p.amount_cents })),
    conta:
      cabeca.customer_id && cabeca.balance_cents !== null
        ? {
            saldoCents: cabeca.balance_cents,
            limiteCents: cabeca.credit_limit_cents ?? 0,
          }
        : null,
  };
}

export async function getComanda(
  tenantId: string,
  orderId: string,
  locationId: string,
): Promise<Comanda> {
  return withTenant(tenantId, (tx) => carregarComanda(tx, orderId, locationId));
}

export interface ComandaAberta {
  readonly id: string;
  readonly abertaEm: string;
  readonly customerName: string | null;
  /** Nulo é venda avulsa: ninguém foi atendido, alguém entrou só para comprar. */
  readonly appointmentId: string | null;
  readonly itens: number;
  readonly totalCents: number;
}

/**
 * As comandas abertas desta unidade.
 *
 * A tela de cobrar listava **os atendimentos do dia** e nada mais, e a comanda
 * avulsa não nasce de atendimento nenhum: aberta, ela existia só na URL para
 * onde o botão redirecionava. Fechar a aba era perder a única porta, e a linha
 * ficava `open` para sempre — invisível no dia, no caixa, no financeiro e no
 * DRE, porque nenhuma daquelas telas pergunta por comanda aberta.
 *
 * O índice que esta consulta usa — `orders_abertas_idx`, parcial em `status =
 * 'open'` — foi criado na migração 0018 **para uma listagem que nunca foi
 * escrita**. Ele estava lá desde o bloco 18, esperando por ela.
 *
 * Sem `tenant_id` no `WHERE` de propósito: quem filtra é a política de RLS. O
 * recorte por unidade é outro assunto — a RLS separa barbearias e **não** separa
 * lojas dentro de uma.
 */
export async function comandasAbertas(
  tenantId: string,
  locationId: string,
  /**
   * Quem chama pode ver identidade de cliente (`customers.view`).
   *
   * Obrigatório no tipo, e **redigir e não recusar** é a decisão: somar
   * `customers.view` ao `@Exige` da rota faria o papel de balcão a quem o dono
   * tirou essa permissão levar 403 na listagem inteira — e a comanda avulsa
   * voltaria a ser invisível justamente para ele, que é o defeito que esta
   * listagem existe para fechar. É o precedente do bloco 119, e o mesmo que
   * `comandaVisivel` já documenta neste arquivo.
   */
  podeVerCliente: boolean,
): Promise<readonly ComandaAberta[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        opened_at: Date;
        customer_name: string | null;
        appointment_id: string | null;
        itens: bigint;
        total_cents: number;
      }[]
    >`
      SELECT o.id, o.opened_at, c.name AS customer_name, o.appointment_id,
             count(i.id) AS itens, o.total_cents
        FROM orders o
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN order_items i ON i.order_id = o.id
       WHERE o.location_id = ${locationId}::uuid AND o.status = 'open'
       GROUP BY o.id, c.name
       ORDER BY o.opened_at
    `;

    return linhas.map((l) => ({
      id: l.id,
      abertaEm: l.opened_at.toISOString(),
      customerName: podeVerCliente ? l.customer_name : null,
      appointmentId: l.appointment_id,
      itens: Number(l.itens),
      totalCents: l.total_cents,
    }));
  });
}

export interface Devedor {
  readonly id: string;
  readonly name: string;
  readonly saldoCents: number;
}

export interface QuemEstaDevendo {
  /** Os cem primeiros, do que mais deve para o que menos deve. */
  readonly devedores: readonly Devedor[];
  /** Quantos devem no total, e não quantos couberam na lista. */
  readonly quantos: number;
  /** Quanto a casa tem a receber ao todo, em centavos positivos. */
  readonly totalCents: number;
}

/**
 * Quem está devendo, para a tela de cobrança.
 *
 * ## Por que o total não sai da lista (bloco 103)
 *
 * A tela somava as linhas devolvidas e chamava aquilo de **"Total a receber"**.
 * Como a consulta corta em cem, a partir do 101º devedor o cartão no alto da
 * tela afirmava um total que não é o total, e "N pessoas" travava em cem para
 * sempre — sem paginação e sem aviso de corte, então a lista **parecia**
 * completa.
 *
 * E o que ficava de fora era a cauda: a ordenação é pela maior dívida, então o
 * que some é a ponta de dívidas pequenas — a que ninguém percebe faltando. O
 * caderno atrás do balcão é o concorrente declarado desta tela, e uma barbearia
 * de bairro com anos de fiado passa de cem nomes sem esforço.
 *
 * É a convenção escrita: *"Total que a tela promete e a cobrança usa sai do
 * domínio, sem o teto da leitura"*.
 */
export async function quemEstaDevendo(tenantId: string): Promise<QuemEstaDevendo> {
  return withTenant(tenantId, async (tx) => {
    const [linhas, somas] = await Promise.all([
      tx.$queryRaw<{ id: string; name: string; balance_cents: number }[]>`
        SELECT id, name, balance_cents FROM customers
         WHERE balance_cents < 0
         ORDER BY balance_cents
         LIMIT 100
      `,
      tx.$queryRaw<{ quantos: bigint; total: bigint | null }[]>`
        SELECT count(*)::bigint AS quantos, -sum(balance_cents)::bigint AS total
          FROM customers WHERE balance_cents < 0
      `,
    ]);

    return {
      devedores: linhas.map((l) => ({ id: l.id, name: l.name, saldoCents: l.balance_cents })),
      quantos: Number(somas[0]?.quantos ?? 0),
      totalCents: inteiroSeguroDoBanco(somas[0]?.total, 'total de fiado em aberto'),
    };
  });
}

/**
 * O faturamento do dia — a lacuna declarada desde o bloco 11.
 *
 * Três números separados, e a separação é o ponto: **fiado não é receita
 * agora**. Somá-lo ao faturamento é a barbearia comemorar um mês que não
 * aconteceu; deixá-lo de fora sem registrar é esquecer de cobrar.
 */
export async function faturamentoDoDia(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly de: Date;
  readonly ate: Date;
}): Promise<{
  readonly recebidoCents: number;
  readonly fiadoCents: number;
  readonly gorjetaCents: number;
  readonly porForma: readonly { readonly forma: FormaDePagamento; readonly valorCents: number }[];
  readonly comandas: number;
}> {
  return withTenant(params.tenantId, async (tx) => {
    const porForma = await tx.$queryRaw<{ method: FormaDePagamento; total: bigint }[]>`
      SELECT p.method, sum(p.amount_cents)::bigint AS total
        FROM order_payments p
        JOIN orders o ON o.id = p.order_id
       WHERE o.location_id = ${params.locationId}::uuid
         AND o.status = 'paid'
         AND o.closed_at >= ${params.de} AND o.closed_at < ${params.ate}
       GROUP BY p.method
    `;

    const resumo = await tx.$queryRaw<{ comandas: bigint; troco: bigint; gorjeta: bigint }[]>`
      SELECT count(*)::bigint AS comandas,
             COALESCE(sum(change_cents), 0)::bigint AS troco,
             COALESCE(sum(tip_cents), 0)::bigint AS gorjeta
        FROM orders
       WHERE location_id = ${params.locationId}::uuid
         AND status = 'paid'
         AND closed_at >= ${params.de} AND closed_at < ${params.ate}
    `;

    const formas = porForma.map((f) => ({
      forma: f.method,
      valorCents: inteiroSeguroDoBanco(f.total, `faturamento por ${f.method}`),
    }));
    const fiadoCents = formas
      .filter((f) => f.forma === 'fiado')
      .reduce((soma, f) => soma + f.valorCents, 0);
    const bruto = formas
      .filter((f) => f.forma !== 'fiado')
      .reduce((soma, f) => soma + f.valorCents, 0);

    return {
      recebidoCents: bruto - inteiroSeguroDoBanco(resumo[0]?.troco, 'troco do período'),
      fiadoCents,
      gorjetaCents: inteiroSeguroDoBanco(resumo[0]?.gorjeta, 'gorjeta do período'),
      porForma: formas,
      comandas: Number(resumo[0]?.comandas ?? 0),
    };
  });
}
