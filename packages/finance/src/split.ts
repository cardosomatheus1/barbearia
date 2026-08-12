import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  calcularSplit,
  comissaoPorItem,
  splitFecha,
  type EstadoDoSplit,
  type FaixaDeComissao,
  type LancamentoDeComissao,
  type ModoDeComissao,
  type ParteDoSplit,
} from '@barbearia/core';
import { audit } from '@barbearia/identity';

/**
 * Split de pagamento: a derivação (bloco 49, SPEC §3.5).
 *
 * ## Derivado da comissão, e o que isso quer dizer no código
 *
 * *"Split é derivado da comissão, nunca configurado em paralelo — duas fontes
 * de verdade para o mesmo número é bug garantido."*
 *
 * Aqui isso é literal: o que o profissional recebe sai de `commission_entries`,
 * a tabela que já existe, pela mesma função que a margem por serviço usa desde
 * o bloco 44. Não existe alíquota de split em lugar nenhum do schema.
 *
 * ## A derivação roda dentro da transação que confirma o pagamento
 *
 * E, por isso, **não pode lançar exceção por motivo que não seja de pagamento**.
 * É a lição do bloco 35, aprendida com o estrago inteiro: uma exceção ali volta
 * atrás com o dinheiro sem registro nenhum, o adquirente reentrega por dias e a
 * varredura para no meio do laço. Split que não fecha vira **linha com motivo
 * escrito**, nunca `throw`.
 */

export interface FatiaNaTela {
  readonly id: string;
  readonly parte: ParteDoSplit;
  readonly professionalId: string | null;
  readonly profissional: string | null;
  readonly valorCents: number;
  readonly estado: EstadoDoSplit;
  readonly liquidadoEm: string | null;
  readonly ultimoErro: string | null;
}

export interface SplitDaVenda {
  readonly orderId: string;
  readonly chargeId: string;
  readonly pagamentoCents: number;
  readonly fatias: readonly FatiaNaTela[];
}

/**
 * Quanto cada profissional ganhou **nesta venda**.
 *
 * `comissaoPorItem` e não a soma do período: faixa progressiva depende do
 * acumulado do mês, e o split acontece no instante do pagamento. A escolha do
 * rateio proporcional está escrita em `packages/core/src/comissao.ts`, e a
 * consequência está escrita no topo de `packages/core/src/split.ts` — o que foi
 * repassado na hora pode ficar abaixo do que o fechamento apura, e a diferença
 * é acerto, não erro.
 */
async function comissoesDaVenda(
  tx: TransactionClient,
  orderId: string,
): Promise<readonly { professionalId: string; valorCents: number }[]> {
  const linhas = await tx.$queryRaw<
    {
      id: string;
      professional_id: string;
      rule_id: string | null;
      mode: ModoDeComissao;
      value: number;
      tiers: FaixaDeComissao[];
      base_cents: number;
      sign: number;
    }[]
  >`
    SELECT id, professional_id, rule_id, mode, value, tiers, base_cents, sign
      FROM commission_entries
     WHERE order_id = ${orderId}::uuid
     ORDER BY id
  `;

  const lancamentos = linhas.map(
    (l): LancamentoDeComissao & { itemId: string } => ({
      itemId: l.id,
      professionalId: l.professional_id,
      regraId: l.rule_id ?? 'sem-regra',
      modo: l.mode,
      valor: l.value,
      faixas: l.tiers,
      baseCents: l.base_cents,
      sinal: l.sign === -1 ? -1 : 1,
    }),
  );

  const porItem = comissaoPorItem(lancamentos);
  const porProfissional = new Map<string, number>();
  for (const lancamento of lancamentos) {
    const valor = porItem.get(lancamento.itemId) ?? 0;
    porProfissional.set(
      lancamento.professionalId,
      (porProfissional.get(lancamento.professionalId) ?? 0) + valor,
    );
  }

  return [...porProfissional].map(([professionalId, valorCents]) => ({
    professionalId,
    valorCents,
  }));
}

export interface ResultadoDaDerivacao {
  readonly criadas: number;
  /** Preenchido quando o split não pôde ser montado. Nunca lançado. */
  readonly recusa?: string;
}

/**
 * Monta o split de uma venda paga pelo nosso adquirente.
 *
 * Chamada **dentro** da transação que confirma o pagamento, depois de a comanda
 * fechar — é ali que os lançamentos de comissão existem.
 *
 * Idempotente pelo índice único `(cobrança, parte, profissional)`: o webhook
 * reentrega por desenho, e sem ele a mesma confirmação criaria a segunda cópia
 * de cada parte — o profissional receberia duas vezes.
 */
export async function derivarSplitDaVenda(
  tx: TransactionClient,
  params: {
    readonly orderId: string;
    readonly chargeId: string;
    readonly pagamentoCents: number;
  },
): Promise<ResultadoDaDerivacao> {
  /**
   * O interruptor vem de `tenants`; a alíquota, de `tenant_platform`.
   *
   * São dois donos: quem decide se o adquirente paga o barbeiro direto é a
   * barbearia — é o dinheiro dela —, e quanto o produto cobra por transação é
   * termo comercial da plataforma. A primeira versão pôs os dois em `tenants`, e
   * a revisão de segurança mostrou o que isso significava: o cliente definindo o
   * preço que paga, e zerá-lo desligava a receita sem nada falhar.
   *
   * `tenant_platform` não tem RLS e é escrita só por `packages/platform`; a
   * leitura daqui é por `tenant_id`, dentro do `withTenant` que já está aberto.
   */
  const config = await tx.$queryRaw<{ ligado: boolean; taxa: number }[]>`
    SELECT t.split_enabled AS ligado, coalesce(tp.platform_fee_bps, 0) AS taxa
      FROM tenants t
      LEFT JOIN tenant_platform tp ON tp.tenant_id = t.id
  `;
  const ligado = config[0]?.ligado ?? false;
  // Desligado é o padrão, e é o comportamento anterior: sem split, o dinheiro
  // cai inteiro na conta da barbearia como sempre caiu.
  if (!ligado) return { criadas: 0 };

  const comissoes = await comissoesDaVenda(tx, params.orderId);
  const decisao = calcularSplit({
    pagamentoCents: params.pagamentoCents,
    comissoes,
    plataformaBps: config[0]?.taxa ?? 0,
  });

  /**
   * Recusa do domínio **não** derruba o pagamento.
   *
   * A comissão pode não caber no pagamento — uma comanda paga metade em
   * dinheiro e metade no Pix é o caso comum. Lançar aqui voltaria atrás com o
   * dinheiro que o cliente já pagou, que é o defeito do bloco 35 outra vez. O
   * que sobra é a verdade: sem split, e o valor cai inteiro na casa, com o
   * motivo registrado na parte dela.
   */
  if (decisao.recusa) {
    await gravarFatia(tx, {
      ...params,
      parte: 'barbearia',
      professionalId: null,
      valorCents: params.pagamentoCents,
      estado: 'retido',
      motivo: decisao.recusa,
    });
    return { criadas: 1, recusa: decisao.recusa };
  }

  /**
   * A soma é conferida antes de gravar, e a guarda não é decorativa.
   *
   * Um centavo a mais e o adquirente recusa a chamada inteira; um a menos e o
   * troco fica preso na conta da plataforma. Se não fechar, o split não é
   * gravado pela metade — a casa fica com tudo e o motivo é encontrável.
   */
  if (!splitFecha(params.pagamentoCents, decisao.fatias)) {
    await gravarFatia(tx, {
      ...params,
      parte: 'barbearia',
      professionalId: null,
      valorCents: params.pagamentoCents,
      estado: 'retido',
      motivo: 'soma das partes diferente do pagamento',
    });
    return { criadas: 1, recusa: 'nao_fecha' };
  }

  let criadas = 0;
  for (const fatia of decisao.fatias) {
    criadas += await gravarFatia(tx, {
      ...params,
      parte: fatia.parte,
      professionalId: fatia.professionalId ?? null,
      valorCents: fatia.valorCents,
      /**
       * A parte da casa nasce liquidada; as outras duas, pendentes.
       *
       * O dinheiro da casa **é** a conta para onde o adquirente manda por
       * padrão — não existe transferência a fazer. Marcá-la pendente encheria a
       * fila de liquidação do bloco 50 com linhas que nunca teriam o que
       * repassar.
       */
      estado: fatia.parte === 'barbearia' ? 'liquidado' : 'pendente',
      motivo: null,
    });
  }

  return { criadas };
}

async function gravarFatia(
  tx: TransactionClient,
  params: {
    readonly orderId: string;
    readonly chargeId: string;
    readonly parte: ParteDoSplit;
    readonly professionalId: string | null;
    readonly valorCents: number;
    readonly estado: EstadoDoSplit;
    readonly motivo: string | null;
  },
): Promise<number> {
  return tx.$executeRaw`
    INSERT INTO payment_splits
      (tenant_id, order_id, charge_id, party, professional_id, amount_cents, status,
       settled_at, last_error)
    VALUES (
      NULLIF(current_setting('app.tenant_id', true), '')::uuid,
      ${params.orderId}::uuid, ${params.chargeId}::uuid,
      ${params.parte}::split_party, ${params.professionalId}::uuid,
      ${params.valorCents}, ${params.estado}::split_status,
      ${params.estado === 'liquidado' ? new Date() : null},
      ${params.motivo}
    )
    ON CONFLICT DO NOTHING
  `;
}

// ---------------------------------------------------------------------------
// A leitura
// ---------------------------------------------------------------------------

interface LinhaDeSplit {
  id: string;
  order_id: string;
  charge_id: string;
  party: ParteDoSplit;
  professional_id: string | null;
  profissional: string | null;
  amount_cents: number;
  status: EstadoDoSplit;
  settled_at: Date | null;
  last_error: string | null;
}

const paraTela = (l: LinhaDeSplit): FatiaNaTela => ({
  id: l.id,
  parte: l.party,
  professionalId: l.professional_id,
  profissional: l.profissional,
  valorCents: l.amount_cents,
  estado: l.status,
  liquidadoEm: l.settled_at ? l.settled_at.toISOString() : null,
  ultimoErro: l.last_error,
});

/** O split de uma venda, para a tela da comanda. */
export async function splitDaVenda(
  tenantId: string,
  orderId: string,
): Promise<SplitDaVenda | null> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<(LinhaDeSplit & { pagamento: number })[]>`
      SELECT s.id, s.order_id, s.charge_id, s.party, s.professional_id,
             p.name AS profissional, s.amount_cents, s.status::text AS status,
             s.settled_at, s.last_error, c.amount_cents AS pagamento
        FROM payment_splits s
        JOIN order_charges c ON c.id = s.charge_id
        LEFT JOIN professionals p ON p.id = s.professional_id
       WHERE s.order_id = ${orderId}::uuid
       ORDER BY s.party, s.created_at
    `;
    const primeira = linhas[0];
    if (!primeira) return null;

    return {
      orderId,
      chargeId: primeira.charge_id,
      pagamentoCents: primeira.pagamento,
      fatias: linhas.map(paraTela),
    };
  });
}

export interface RepasseNaTela extends FatiaNaTela {
  readonly orderId: string;
  /** O dia **da unidade** em que a venda aconteceu, não o instante do repasse. */
  readonly quando: string;
}

/**
 * Os repasses de um período, para o balcão.
 *
 * `professionalId` recorta para o barbeiro que só pode ver os próprios números
 * — é o mesmo recorte de `extratoDeComissao`, e pela mesma razão: barbeiro que
 * vê o repasse do colega é o motivo nº 1 de briga interna em barbearia.
 */
export async function repassesDoPeriodo(params: {
  readonly tenantId: string;
  readonly de: string;
  readonly ate: string;
  readonly somenteProfessionalId?: string | null;
}): Promise<readonly RepasseNaTela[]> {
  const recorte = params.somenteProfessionalId ?? null;

  return withTenant(params.tenantId, async (tx) => {
    /**
     * `orders.business_day`, e não `payment_splits.created_at`.
     *
     * O repasse é dinheiro **de uma venda**, e o dia de uma venda é o dia da
     * unidade — a convenção do bloco 36. `created_at` responde "que instante o
     * adquirente confirmou", que às 22h de Salvador já é o dia seguinte em UTC:
     * o repasse cairia no mês seguinte do acerto do barbeiro, que é o defeito D2
     * com outra roupa.
     *
     * Foi o teste do extrato que pegou: ele fecha a venda no dia da unidade e
     * lia zero repasse, porque a linha nascia com o relógio do processo.
     */
    const linhas = await tx.$queryRaw<(LinhaDeSplit & { dia: Date })[]>`
      SELECT s.id, s.order_id, s.charge_id, s.party, s.professional_id,
             p.name AS profissional, s.amount_cents, s.status::text AS status,
             s.settled_at, s.last_error, o.business_day AS dia
        FROM payment_splits s
        JOIN orders o ON o.id = s.order_id
        LEFT JOIN professionals p ON p.id = s.professional_id
       WHERE o.business_day >= ${params.de}::date
         AND o.business_day <= ${params.ate}::date
         AND (${recorte}::uuid IS NULL OR s.professional_id = ${recorte}::uuid)
       ORDER BY o.business_day DESC, s.created_at DESC
       LIMIT 300
    `;

    return linhas.map((l) => ({
      ...paraTela(l),
      orderId: l.order_id,
      quando: l.dia.toISOString().slice(0, 10),
    }));
  });
}

export interface ConfiguracaoDoSplit {
  readonly ligado: boolean;
  readonly plataformaBps: number;
}

export async function configuracaoDoSplit(tenantId: string): Promise<ConfiguracaoDoSplit> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ ligado: boolean; taxa: number }[]>`
      SELECT t.split_enabled AS ligado, coalesce(tp.platform_fee_bps, 0) AS taxa
        FROM tenants t
        LEFT JOIN tenant_platform tp ON tp.tenant_id = t.id
    `;
    return { ligado: linhas[0]?.ligado ?? false, plataformaBps: linhas[0]?.taxa ?? 0 };
  });
}

/**
 * Liga o repasse direto ao barbeiro.
 *
 * **Só o interruptor.** A alíquota da plataforma não está aqui, e é achado da
 * `/security-review` deste bloco: ela é termo comercial do produto, mora em
 * `tenant_platform` e é escrita pelo Super Admin. Editável por esta rota, o
 * cliente definia o preço que paga — e zerá-la desligava a receita sem nada
 * falhar, sem invariante quebrada e sem linha vermelha em lugar nenhum.
 *
 * O que sobra é legítimo da barbearia: se o adquirente paga o barbeiro direto é
 * decisão sobre o dinheiro dela. Auditado porque muda **para onde o dinheiro
 * vai**, e a pergunta do mês seguinte — "por que entrou menos na conta?" —
 * precisa de resposta com nome e data.
 */
export async function salvarConfiguracaoDoSplit(params: {
  readonly tenantId: string;
  readonly ligado: boolean;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<{ readonly salvo: true }> {
  return withTenant(params.tenantId, async (tx) => {
    const antes = await tx.$queryRaw<{ ligado: boolean }[]>`
      SELECT split_enabled AS ligado FROM tenants
    `;

    await tx.$executeRaw`
      UPDATE tenants SET split_enabled = ${params.ligado}
       WHERE id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    `;

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'split.changed',
      entity: 'tenants',
      before: { ligado: antes[0]?.ligado ?? false },
      after: { ligado: params.ligado },
    });

    return { salvo: true as const };
  });
}

export type SplitFailureNaBorda = 'aliquota_invalida';

export class SplitError extends Error {
  constructor(readonly code: SplitFailureNaBorda, message: string) {
    super(message);
    this.name = 'SplitError';
  }
}
