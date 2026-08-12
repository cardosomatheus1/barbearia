import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  calcularSplit,
  chaveDoRepasse,
  comissaoPorItem,
  desfechoDoEstornoDeRepasse,
  proximoPassoDaLiquidacao,
  splitFecha,
  type EstadoDoKyc,
  type EstadoDoRecebedor,
  type ResultadoDoRepasse,
  type SplitProvider,
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

export type SplitFailureNaBorda =
  | 'aliquota_invalida'
  | 'profissional_nao_encontrado'
  | 'ja_aprovado'
  | 'dados_invalidos';

export class SplitError extends Error {
  constructor(readonly code: SplitFailureNaBorda, message: string) {
    super(message);
    this.name = 'SplitError';
  }
}

// ---------------------------------------------------------------------------
// KYC, liquidação e estorno (bloco 50, SPEC §3.5)
// ---------------------------------------------------------------------------

export interface RecebedorNaTela {
  readonly professionalId: string;
  readonly nome: string;
  readonly kyc: EstadoDoKyc;
  readonly temRecebedor: boolean;
  readonly motivo: string | null;
  readonly atualizadoEm: string | null;
  /** Quanto está retido por falta de cadastro. É o número que move o dono. */
  readonly retidoCents: number;
}

/**
 * Quem já pode receber direto, e quanto está esperando cadastro.
 *
 * `retidoCents` existe porque o cadastro no adquirente é burocracia que ninguém
 * faz por gosto: a coluna que mostra "R$ 1.240 do Ruan passaram pela casa este
 * mês porque ele não terminou o cadastro" é o que faz o cadastro acontecer.
 */
export async function recebedores(tenantId: string): Promise<readonly RecebedorNaTela[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        name: string;
        psp_kyc_status: EstadoDoKyc;
        tem: boolean;
        psp_kyc_reason: string | null;
        psp_kyc_updated_at: Date | null;
        retido: bigint;
      }[]
    >`
      SELECT p.id, p.name, p.psp_kyc_status,
             (p.psp_recipient_id IS NOT NULL) AS tem,
             p.psp_kyc_reason, p.psp_kyc_updated_at,
             coalesce((
               SELECT sum(s.amount_cents) FROM payment_splits s
                WHERE s.professional_id = p.id AND s.status = 'retido'
             ), 0)::bigint AS retido
        FROM professionals p
       WHERE p.active
       ORDER BY p.name
    `;

    return linhas.map((l) => ({
      professionalId: l.id,
      nome: l.name,
      kyc: l.psp_kyc_status,
      temRecebedor: l.tem,
      motivo: l.psp_kyc_reason,
      atualizadoEm: l.psp_kyc_updated_at ? l.psp_kyc_updated_at.toISOString() : null,
      retidoCents: Number(l.retido),
    }));
  });
}

/**
 * Começa o cadastro de um profissional como recebedor no adquirente.
 *
 * Documento, banco, agência e conta **atravessam** para o adquirente e não são
 * gravados aqui: quem tem obrigação regulatória de guardá-los é ele. Deste lado
 * fica a referência opaca, pela mesma razão de o cartão do clube guardar só o
 * token — e há invariante no banco que reprova quem criar coluna para eles.
 *
 * A chamada acontece **fora** da transação: é rede, e o adquirente responde em
 * segundos ou em dezenas deles.
 */
export async function cadastrarRecebedor(entrada: {
  readonly tenantId: string;
  readonly professionalId: string;
  readonly documento: string;
  readonly banco: string;
  readonly agencia: string;
  readonly conta: string;
  readonly provider: SplitProvider;
  readonly staffId: string;
  readonly staffName: string;
  readonly agora?: Date;
}): Promise<{ readonly estado: EstadoDoRecebedor }> {
  const agora = entrada.agora ?? new Date();

  const [profissional] = await withTenant(entrada.tenantId, (tx) =>
    tx.$queryRaw<{ id: string; name: string; psp_kyc_status: EstadoDoKyc }[]>`
      SELECT id, name, psp_kyc_status FROM professionals
       WHERE id = ${entrada.professionalId}::uuid AND active
    `,
  );
  if (!profissional) {
    throw new SplitError('profissional_nao_encontrado', 'Este profissional não existe.');
  }
  if (profissional.psp_kyc_status === 'aprovado') {
    throw new SplitError('ja_aprovado', 'Este profissional já recebe direto.');
  }

  const resposta = await entrada.provider.cadastrarRecebedor({
    tenantId: entrada.tenantId,
    professionalId: entrada.professionalId,
    nome: profissional.name,
    documento: entrada.documento,
    banco: entrada.banco,
    agencia: entrada.agencia,
    conta: entrada.conta,
  });

  await withTenant(entrada.tenantId, async (tx) => {
    await tx.$executeRaw`
      UPDATE professionals
         SET psp_recipient_id = ${resposta.recebedorId},
             psp_kyc_status = ${resposta.estado}::psp_kyc_status,
             psp_kyc_updated_at = ${agora},
             psp_kyc_reason = ${resposta.motivo ?? null},
             updated_at = now()
       WHERE id = ${entrada.professionalId}::uuid
    `;
    await audit(tx, {
      actorId: entrada.staffId,
      actorName: entrada.staffName,
      action: 'split.recipient_changed',
      entity: 'professionals',
      entityId: entrada.professionalId,
      // Sem documento, sem conta: eles atravessaram para o adquirente e a trilha
      // não é lugar de dado bancário de terceiro.
      after: { estado: resposta.estado },
    });
  });

  return { estado: resposta.estado };
}

/**
 * A conciliação do cadastro: pergunta ao adquirente quem já foi aprovado.
 *
 * *"O onboarding disso é assíncrono"*, e o adquirente responde por webhook — que
 * é o caminho. Esta é a rede de segurança, pelo mesmo desenho da conciliação de
 * cobranças do bloco 35: webhook perdido não pode deixar um barbeiro aprovado
 * recebendo pelo fechamento para sempre.
 */
export async function conciliarRecebedores(entrada: {
  readonly tenantId: string;
  readonly provider: SplitProvider;
  readonly agora?: Date;
}): Promise<{ readonly conferidos: number; readonly aprovados: number }> {
  const agora = entrada.agora ?? new Date();

  const pendentes = await withTenant(entrada.tenantId, (tx) =>
    tx.$queryRaw<{ id: string; psp_recipient_id: string }[]>`
      SELECT id, psp_recipient_id FROM professionals
       WHERE psp_kyc_status = 'pendente' AND psp_recipient_id IS NOT NULL
    `,
  );

  let aprovados = 0;
  for (const profissional of pendentes) {
    const estado = await entrada.provider.consultarRecebedor(profissional.psp_recipient_id);
    if (estado === 'pendente') continue;

    await withTenant(entrada.tenantId, (tx) =>
      tx.$executeRaw`
        UPDATE professionals
           SET psp_kyc_status = ${estado}::psp_kyc_status,
               psp_kyc_updated_at = ${agora}, updated_at = now()
         WHERE id = ${profissional.id}::uuid AND psp_kyc_status = 'pendente'
      `,
    );
    if (estado === 'aprovado') aprovados += 1;
  }

  return { conferidos: pendentes.length, aprovados };
}

export interface ResultadoDaLiquidacao {
  readonly repassados: number;
  readonly retidos: number;
  readonly falhados: number;
  readonly desistidos: number;
  /**
   * O adquirente confirmou uma transferência de uma parte que já não estava
   * liquidando — quase sempre porque a venda foi estornada no meio da chamada.
   *
   * Existe como número próprio e não somado a `repassados` porque ele é o
   * sintoma de dinheiro que saiu sem contrapartida no produto, e é a linha de log
   * que alguém precisa ver.
   */
  readonly divergentes: number;
}

interface ParteNaFila {
  id: string;
  order_id: string;
  amount_cents: number;
  status: EstadoDoSplit;
  attempts: number;
  party: ParteDoSplit;
  professional_id: string | null;
  kyc: EstadoDoKyc | null;
  recebedor: string | null;
  pagamento: string | null;
}

/**
 * Uma volta da liquidação: manda para o adquirente o que está esperando.
 *
 * ## A chamada acontece fora da transação, e a tentativa é reivindicada antes
 *
 * `attempts` entra no `WHERE` do `UPDATE` que reivindica a tentativa, e é ele
 * que impede dois workers de mandarem o mesmo repasse duas vezes — contar linhas
 * numa tabela que a outra transação ainda não commitou não impede nada. É o
 * mesmo desenho da régua do clube.
 *
 * ## Reter não é falhar
 *
 * A parte de quem não tem cadastro aprovado vira `retido`, e isso é o caminho
 * normal: *"enquanto pendente, o pagamento cai integralmente na barbearia e a
 * comissão é paga fora, sem bloquear a venda"*. A conta da casa e a da
 * plataforma não passam por KYC — a primeira **é** para onde o adquirente manda
 * por padrão, e a segunda é a nossa.
 */
export async function liquidarRepasses(entrada: {
  readonly tenantId: string;
  readonly provider: SplitProvider;
  readonly agora?: Date;
}): Promise<ResultadoDaLiquidacao> {
  const agora = entrada.agora ?? new Date();
  const contagem = { repassados: 0, retidos: 0, falhados: 0, desistidos: 0, divergentes: 0 };

  /**
   * Quem ficou preso em `liquidando` volta para `falhou` antes da volta.
   *
   * A parte nesse estado tem uma chamada que não voltou — processo derrubado,
   * rede cortada. Com a **chave estável**, retentar é seguro: o adquirente
   * devolve o resultado da primeira em vez de executar a segunda transferência.
   * Sem esta linha, ela ficaria parada para sempre, porque
   * `proximoPassoDaLiquidacao` recusa `liquidando` de propósito.
   */
  await withTenant(entrada.tenantId, (tx) =>
    tx.$executeRaw`
      UPDATE payment_splits
         SET status = 'falhou',
             last_error = 'o adquirente não respondeu na volta anterior', updated_at = now()
       WHERE status = 'liquidando' AND updated_at < ${new Date(agora.getTime() - 3_600_000)}
    `,
  );

  const fila = await withTenant(entrada.tenantId, (tx) =>
    tx.$queryRaw<ParteNaFila[]>`
      SELECT s.id, s.order_id, s.amount_cents, s.status::text AS status, s.attempts,
             s.party, s.professional_id,
             p.psp_kyc_status AS kyc, p.psp_recipient_id AS recebedor,
             c.psp_payment_id AS pagamento
        FROM payment_splits s
        LEFT JOIN professionals p ON p.id = s.professional_id
        JOIN order_charges c ON c.id = s.charge_id
       WHERE s.status IN ('pendente', 'falhou')
       ORDER BY s.created_at
       LIMIT 200
    `,
  );

  for (const parte of fila) {
    const passo = proximoPassoDaLiquidacao({
      estado: parte.status,
      valorCents: parte.amount_cents,
      tentativas: parte.attempts,
      kyc: parte.party === 'profissional' ? (parte.kyc ?? 'ausente') : null,
      recebedorId: parte.recebedor,
    });

    if (passo === 'nada') continue;

    if (passo === 'reter' || passo === 'desistir') {
      const mexidas = await withTenant(entrada.tenantId, (tx) =>
        tx.$executeRaw`
          UPDATE payment_splits
             SET status = 'retido',
                 last_error = ${passo === 'reter' ? 'sem cadastro aprovado no adquirente' : 'o adquirente recusou o repasse três vezes'},
                 updated_at = now()
           WHERE id = ${parte.id}::uuid AND status IN ('pendente', 'falhou')
        `,
      );
      if (mexidas > 0) {
        if (passo === 'reter') contagem.retidos += 1;
        else contagem.desistidos += 1;
      }
      continue;
    }

    /**
     * A tentativa é reivindicada **antes** da chamada, e num estado próprio.
     *
     * `liquidando` é o mesmo desenho de `aceitando` no resgate de convite do
     * bloco 39, e ele existe pelo mesmo motivo: **`FOR UPDATE` sem escrita não
     * separa nada** — a trava cai no commit, e esta função solta a linha antes
     * de falar com o adquirente. Sem o estado, o estorno da venda entrava
     * exatamente nessa janela, lia `pendente`, marcava `estornado` e concluía
     * que ninguém devia nada; segundos depois o adquirente confirmava a
     * transferência. Achado da `/security-review` deste bloco.
     *
     * A linha da tentativa nasce **junto**, na mesma transação: se o processo
     * cair entre o claim e a resposta, a chamada fica registrada e a conciliação
     * tem por onde começar. É a ordem que o bloco 35 já ensinou — a linha antes
     * da chamada, nunca depois.
     */
    const reivindicadas = await withTenant(entrada.tenantId, (tx) =>
      tx.$executeRaw`
        UPDATE payment_splits
           SET attempts = attempts + 1, status = 'liquidando', updated_at = now()
         WHERE id = ${parte.id}::uuid AND attempts = ${parte.attempts}
           AND status IN ('pendente', 'falhou')
      `,
    );
    if (reivindicadas === 0) continue;

    /**
     * A chave é **estável por fatia**, e é o oposto da chave da cobrança do
     * clube.
     *
     * Lá ela varia por tentativa porque retentar um cartão recusado precisa ser
     * uma cobrança nova. Aqui, retentar significa que a chamada anterior
     * terminou em desfecho ambíguo — e uma chave nova faria o adquirente
     * executar a **segunda transferência**, pagando o barbeiro duas vezes.
     */
    const pedido = {
      tenantId: entrada.tenantId,
      fatiaId: parte.id,
      // A casa e a plataforma não têm recebedor: o adquirente já sabe para onde
      // mandar a parte de cada uma.
      recebedorId: parte.recebedor ?? '',
      valorCents: parte.amount_cents,
      pagamentoId: parte.pagamento ?? '',
      idempotencyKey: '',
    };
    const resultado = await entrada.provider
      .transferir({ ...pedido, idempotencyKey: chaveDoRepasse(pedido) })
      .catch(
        (erro: unknown): ResultadoDoRepasse => ({
          ok: false,
          codigo: 'indisponivel',
          motivo: erro instanceof Error ? erro.message : 'o adquirente não respondeu',
        }),
      );

    await withTenant(entrada.tenantId, async (tx) => {
      await tx.$executeRaw`
        INSERT INTO split_transfers
          (tenant_id, split_id, amount_cents, ok, psp_transfer_id, error_code, error_message)
        VALUES (
          NULLIF(current_setting('app.tenant_id', true), '')::uuid,
          ${parte.id}::uuid, ${parte.amount_cents}, ${resultado.ok},
          ${resultado.ok ? resultado.transferenciaId : null},
          ${resultado.ok ? null : resultado.codigo},
          ${resultado.ok ? null : resultado.motivo}
        )
      `;

      if (resultado.ok) {
        /**
         * A contagem é conferida, e zero linhas é um alarme — não um "tudo bem".
         *
         * Zero quer dizer que a parte saiu de `liquidando` enquanto a chamada
         * estava em voo: o estorno da venda passou por aqui. O dinheiro **saiu**,
         * e contar isso como repasse bem-sucedido em silêncio é o defeito que a
         * revisão apontou. O que se faz é registrar a transferência (acima, já
         * feito) e deixar o desfecho visível.
         */
        const baixadas = await tx.$executeRaw`
          UPDATE payment_splits
             SET status = 'liquidado', settled_at = ${agora},
                 psp_transfer_id = ${resultado.transferenciaId},
                 last_error = NULL, updated_at = now()
           WHERE id = ${parte.id}::uuid AND status = 'liquidando'
        `;
        if (baixadas === 0) {
          contagem.divergentes += 1;
          return;
        }
        contagem.repassados += 1;
        return;
      }

      await tx.$executeRaw`
        UPDATE payment_splits
           SET status = 'falhou', last_error = ${resultado.motivo.slice(0, 200)},
               updated_at = now()
         WHERE id = ${parte.id}::uuid AND status = 'liquidando'
      `;
      contagem.falhados += 1;
    });
  }

  return contagem;
}

/**
 * Desfaz o split de uma venda estornada.
 *
 * *"Estorno com split já liquidado exige política explícita de recuperação."* A
 * política, escrita:
 *
 * - Parte **não liquidada**: vira `estornado` e ninguém deve nada — o dinheiro
 *   ainda estava com a plataforma.
 * - Parte **liquidada de um profissional**: o dinheiro entrou na conta dele e
 *   nenhum adquirente deixa a plataforma sacar de um recebedor. Vira dívida,
 *   lançada como **comissão negativa no período aberto** — que é exatamente o
 *   que a SPEC §3.4 já manda para estorno de venda, e o mecanismo que o barbeiro
 *   já entende.
 *
 * Chamada de dentro da transação que estorna a venda: fora dela existiria a
 * janela em que a venda voltou atrás e o repasse continua de pé.
 */
export async function estornarSplitDaVenda(
  tx: TransactionClient,
  params: { readonly orderId: string; readonly quandoISO: string },
): Promise<{ readonly cancelados: number; readonly cobrados: number }> {
  const partes = await tx.$queryRaw<
    {
      id: string;
      party: ParteDoSplit;
      status: EstadoDoSplit;
      professional_id: string | null;
      amount_cents: number;
    }[]
  >`
    SELECT id, party, status::text AS status, professional_id, amount_cents
      FROM payment_splits
     WHERE order_id = ${params.orderId}::uuid
     ORDER BY id
     FOR UPDATE
  `;

  let cancelados = 0;
  let cobrados = 0;

  for (const parte of partes) {
    const desfecho = desfechoDoEstornoDeRepasse({ estado: parte.status, parte: parte.party });
    if (desfecho === 'nada') continue;

    if (desfecho === 'cancelar') {
      cancelados += await tx.$executeRaw`
        UPDATE payment_splits
           SET status = 'estornado', updated_at = now()
         WHERE id = ${parte.id}::uuid AND status <> 'estornado'
      `;
      continue;
    }

    /**
     * A dívida é um lançamento de comissão negativo, **na data de hoje**.
     *
     * Nunca com a data da venda: datá-lo no passado mexeria num período que já
     * foi pago, que é o que a SPEC §3.4 proíbe em letras. `mode = 'fixed'` com
     * `value` igual ao repasse: a dívida é do valor que saiu, não de um
     * percentual recalculado sobre uma base que não existe mais.
     */
    const [lancamento] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO commission_entries
        (tenant_id, professional_id, order_id, earned_on, mode, value, base_cents, sign)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${parte.professional_id}::uuid, ${params.orderId}::uuid,
        ${params.quandoISO}::date, 'fixed'::commission_mode,
        ${parte.amount_cents}, 0, -1
      )
      RETURNING id
    `;

    /**
     * A contagem é conferida antes de contar a dívida.
     *
     * `UPDATE` guardado por estado que não confere linhas afetadas deixa a
     * segunda camada inerte — é a convenção deste código desde o bloco 42, e a
     * revisão deste bloco cobrou a ausência dela aqui.
     */
    const marcadas = await tx.$executeRaw`
      UPDATE payment_splits
         SET status = 'estornado', clawback_entry_id = ${lancamento?.id ?? null}::uuid,
             updated_at = now()
       WHERE id = ${parte.id}::uuid AND status <> 'estornado'
    `;
    if (marcadas > 0) cobrados += 1;
  }

  return { cancelados, cobrados };
}
