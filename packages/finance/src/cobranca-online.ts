import { withTenant, type TransactionClient } from '@barbearia/db';
import { enfileirarPara } from '@barbearia/jobs';
import type {
  CobrancaCriada,
  EstadoDoPagamento,
  MeioDePagamento,
  PaymentProvider,
} from '@barbearia/core';
import { audit } from '@barbearia/identity';
import { fecharComanda, type Comanda } from './comanda.js';
import { derivarSplitDaVenda } from './split.js';

/**
 * A cobrança online da comanda (blocos 35 e 36, SPEC §3.3).
 *
 * Até aqui o pagamento era **registro**: a recepção olhava a maquininha ou o
 * aplicativo do banco e digitava no sistema o que já tinha acontecido em outro
 * lugar. Aqui o produto emite a cobrança e acompanha o desfecho.
 *
 * ## A cadeia da SPEC, e por que ela é uma transação
 *
 * A SPEC §3.3 diz que a confirmação dispara em cadeia: fecha comanda, registra
 * no caixa, gera comissão. Ela não pode ser "marca pago agora, fecha depois" —
 * a janela entre as duas é o dinheiro confirmado sem venda, e ninguém sabe
 * dizer, olhando o banco, se o fechamento ainda vai acontecer ou se ele falhou.
 * Por isso `fecharComanda` aceita a transação de fora.
 *
 * ## O que acontece quando o caixa está fechado
 *
 * A cobrança fica `pago` e a comanda fica aberta. Não é omissão: desde o bloco
 * 18 nenhuma venda entra sem gaveta aberta, porque a divergência do fechamento
 * precisa ter dono. O dinheiro **está** confirmado e registrado; o que falta é
 * dizer em qual caixa ele entrou, e isso é uma pergunta que só o balcão
 * responde. A tela mostra "Pix recebido — abra o caixa para fechar a comanda".
 *
 * ## A varredura é enfileirada com a cobrança, não depois
 *
 * `finance` passa a depender de `jobs` por uma coisa só: `enfileirarPara()`. É
 * o mesmo precedente de `platform → jobs` (bloco 28), e o motivo é o mesmo — a
 * tarefa que vai conferir esta cobrança precisa nascer **dentro** da transação
 * que a cria. Enfileirar depois do commit abre a janela em que o QR Code existe
 * e nada está marcado para vencê-lo: o processo cai, e a comanda fica presa
 * para sempre, porque só uma cobrança viva é permitida por vez.
 *
 * A seta não volta: `jobs` continua sem saber que existe comanda, e recebe do
 * `Contexto` do worker a função que sabe.
 *
 * ## Ordem: a linha nasce antes da chamada ao adquirente
 *
 * A ordem inversa perde a cobrança inteira se o processo cair no meio: haveria
 * um Pix no mundo que o produto não conhece, e portanto que a conciliação não
 * alcança. A chave de idempotência que vai para o adquirente é derivada do id
 * **desta linha**, então a retentativa reencontra a mesma cobrança lá em vez de
 * criar a segunda.
 */

export type EstadoDaCobrancaOnline = 'aguardando' | 'pago' | 'recusado' | 'expirado';

/**
 * Quanto tempo a conferência espera antes de perguntar ao adquirente.
 *
 * O webhook é o caminho e chega em segundos; esta tarefa é a rede. Trinta
 * minutos porque é a janela usual de um Pix de balcão — e porque perguntar
 * antes disso seria pesquisa em laço sobre o caso normal, que já foi resolvido
 * pelo webhook.
 */
export const VIDA_DA_COBRANCA_MINUTOS = 30;

export type FalhaDaCobranca =
  | 'comanda_nao_encontrada'
  | 'comanda_fechada'
  | 'cobranca_em_curso'
  | 'meio_nao_emitivel'
  | 'comanda_sem_valor'
  | 'cobranca_nao_encontrada'
  | 'cobranca_encerrada';

export class CobrancaError extends Error {
  constructor(
    readonly code: FalhaDaCobranca,
    message: string,
  ) {
    super(message);
    this.name = 'CobrancaError';
  }
}

export interface CobrancaDaComanda {
  readonly id: string;
  readonly orderId: string;
  readonly meio: MeioDePagamento;
  readonly valorCents: number;
  readonly estado: EstadoDaCobrancaOnline;
  readonly pagamentoId: string | null;
  readonly pixCopiaECola: string | null;
  readonly url: string | null;
  readonly expiraEm: string | null;
  readonly pagaEm: string | null;
  readonly motivo: string | null;
  readonly criadaPor: string;
  readonly criadaEm: string;
}

interface Linha {
  id: string;
  order_id: string;
  method: string;
  amount_cents: number;
  status: string;
  psp_payment_id: string | null;
  pix_payload: string | null;
  checkout_url: string | null;
  expires_at: Date | null;
  paid_at: Date | null;
  refused_reason: string | null;
  created_by_name: string;
  created_at: Date;
}

/** O enum do banco fala a língua da comanda; o domínio fala a do adquirente. */
const MEIO_NO_BANCO: Readonly<Record<MeioDePagamento, string>> = {
  pix: 'pix',
  cartao: 'credit',
  link: 'link',
};

const MEIO_NO_DOMINIO: Readonly<Record<string, MeioDePagamento>> = {
  pix: 'pix',
  credit: 'cartao',
  link: 'link',
};

/** A forma como ela é gravada em `order_payments` quando a venda fecha. */
const FORMA_DO_PAGAMENTO: Readonly<Record<MeioDePagamento, 'pix' | 'credit' | 'link'>> = {
  pix: 'pix',
  cartao: 'credit',
  link: 'link',
};

const paraCobranca = (l: Linha): CobrancaDaComanda => ({
  id: l.id,
  orderId: l.order_id,
  meio: MEIO_NO_DOMINIO[l.method] ?? 'pix',
  valorCents: l.amount_cents,
  estado: l.status as EstadoDaCobrancaOnline,
  pagamentoId: l.psp_payment_id,
  pixCopiaECola: l.pix_payload,
  url: l.checkout_url,
  expiraEm: l.expires_at?.toISOString() ?? null,
  pagaEm: l.paid_at?.toISOString() ?? null,
  motivo: l.refused_reason,
  criadaPor: l.created_by_name,
  criadaEm: l.created_at.toISOString(),
});

/**
 * Emite a cobrança de uma comanda aberta.
 *
 * `Idempotency-Key` é obrigatória aqui — o duplo toque no celular do balcão é o
 * caso comum, não a exceção, e cada toque a mais seria um QR Code a mais para a
 * mesma conta. A chave é escopada por operador na borda, como no fechamento.
 */
export async function criarCobrancaDaComanda(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly orderId: string;
  readonly meio: MeioDePagamento;
  readonly staffId: string;
  readonly staffName: string;
  readonly idempotencyKey: string;
  readonly provider: PaymentProvider;
  /** O relógio entra por parâmetro; o domínio não lê a hora do processo. */
  readonly agora: Date;
}): Promise<CobrancaDaComanda> {
  const preparo = await withTenant(params.tenantId, async (tx) => {
    const repetida = await tx.$queryRaw<Linha[]>`
      SELECT id, order_id, method::text, amount_cents, status::text, psp_payment_id,
             pix_payload, checkout_url, expires_at, paid_at, refused_reason,
             created_by_name, created_at
        FROM order_charges
       WHERE idempotency_key = ${params.idempotencyKey}
    `;
    const anterior = repetida[0];
    if (anterior) return { repetida: paraCobranca(anterior) };

    const comandas = await tx.$queryRaw<
      { id: string; status: string; total_cents: number; customer_name: string | null }[]
    >`
      SELECT o.id, o.status::text, o.total_cents, c.name AS customer_name
        FROM orders o
        LEFT JOIN customers c ON c.id = o.customer_id
       WHERE o.id = ${params.orderId}::uuid
       FOR UPDATE OF o
    `;
    const comanda = comandas[0];
    if (!comanda) {
      throw new CobrancaError('comanda_nao_encontrada', 'Esta comanda não existe.');
    }
    if (comanda.status !== 'open') {
      throw new CobrancaError('comanda_fechada', 'Esta comanda já foi fechada.');
    }
    if (comanda.total_cents <= 0) {
      // Cobrar zero produziria um QR Code que nenhum banco aceita, e o balcão
      // ficaria olhando uma tela que nunca confirma.
      throw new CobrancaError('comanda_sem_valor', 'Adicione itens antes de cobrar.');
    }

    /**
     * Uma cobrança viva por comanda — e a recusa é do banco.
     *
     * Uma consulta antes do `INSERT` tem janela de corrida, e dois toques no
     * "Cobrar" acontecem em milissegundos. Dois QR Codes abertos para a mesma
     * conta é o cliente pagando duas vezes.
     */
    const criadas = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO order_charges
        (tenant_id, location_id, order_id, method, amount_cents,
         idempotency_key, created_by, created_by_name)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${params.locationId}::uuid, ${params.orderId}::uuid,
        ${MEIO_NO_BANCO[params.meio]}::payment_method, ${comanda.total_cents},
        ${params.idempotencyKey}, ${params.staffId}::uuid, ${params.staffName}
      )
      ON CONFLICT (order_id) WHERE status = 'aguardando' DO NOTHING
      RETURNING id
    `;
    const criada = criadas[0];
    if (!criada) {
      throw new CobrancaError(
        'cobranca_em_curso',
        'Já existe uma cobrança em aberto para esta comanda.',
      );
    }

    /**
     * A conferência nasce junto com a cobrança.
     *
     * Enfileirar depois do commit abriria a janela em que o QR Code existe e
     * nada está marcado para conferi-lo — o processo cai e a comanda fica
     * presa, porque só uma cobrança viva é permitida por vez. Roda depois da
     * janela do Pix (`VIDA_DA_COBRANCA_MINUTOS`): antes disso o webhook é o
     * caminho, e perguntar ao adquirente a cada minuto seria pesquisa em laço.
     */
    /**
     * Emitir cobrança é ato de dinheiro, e a trilha é gravada **dentro** da
     * transação que cria o fato — como todo o resto do módulo.
     */
    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'order.charge_created',
      entity: 'order_charge',
      entityId: criada.id,
      after: { orderId: params.orderId, meio: params.meio, valorCents: comanda.total_cents },
    });

    await enfileirarPara(tx, params.tenantId, {
      kind: 'cobranca.conciliar',
      /**
       * Payload vazio, e a tarefa varre **a barbearia**, não esta cobrança.
       *
       * Duas razões. `jobs` não tem RLS e o payload é legível sem tenant, então
       * quanto menos ele carregar, melhor — o copia-e-cola do Pix não atravessa
       * a fila. E varrer a barbearia inteira recolhe também a cobrança órfã, a
       * que nasceu e nunca recebeu id do adquirente porque o processo caiu: ela
       * não tem tarefa própria, e sem isso travaria a comanda para sempre.
       */
      payload: {},
      rodarApos: new Date(params.agora.getTime() + VIDA_DA_COBRANCA_MINUTOS * 60_000),
      idempotencyKey: `cobranca:${criada.id}`,
    });

    return {
      chargeId: criada.id,
      valorCents: comanda.total_cents,
      descricao: comanda.customer_name
        ? `Atendimento — ${comanda.customer_name}`
        : 'Atendimento',
    };
  });

  if ('repetida' in preparo) return preparo.repetida;

  /**
   * A ida ao adquirente fica **fora** da transação.
   *
   * Segurar conexão de banco esperando rede é o jeito clássico de esgotar o
   * pool, e uma cobrança demora o quanto o adquirente demorar. O preço é a
   * janela em que a linha existe sem id do provedor — que é estado real, tem
   * nome (`aguardando` sem `psp_payment_id`) e tem tratamento na conciliação.
   */
  let resposta: CobrancaCriada;
  try {
    resposta = await params.provider.criarCobranca({
      tenantId: params.tenantId,
      orderId: params.orderId,
      meio: params.meio,
      valorCents: preparo.valorCents,
      descricao: preparo.descricao,
      // Derivada do id da linha: a retentativa reencontra a mesma cobrança no
      // adquirente em vez de criar a segunda.
      idempotencyKey: preparo.chargeId,
    });
  } catch (erro) {
    // A linha vira `expirado` para destravar a comanda: deixá-la `aguardando`
    // prenderia o balcão num QR Code que nunca existiu.
    await withTenant(params.tenantId, async (tx) => {
      await tx.$executeRaw`
        UPDATE order_charges
           SET status = 'expirado', refused_reason = 'falha ao emitir', updated_at = now()
         WHERE id = ${preparo.chargeId}::uuid AND status = 'aguardando'
      `;
    });
    throw erro;
  }

  return withTenant(params.tenantId, async (tx) => {
    /**
     * `AND status = 'aguardando'` como em toda escrita de estado deste arquivo.
     *
     * Sem ele, um cancelamento feito no balcão **durante** os segundos em que a
     * chamada ao adquirente está no ar seria sobrescrito: a linha voltaria a
     * apontar para um Pix vivo e a tela devolveria o QR Code de uma cobrança
     * que o operador já tinha matado.
     */
    const atualizadas = await tx.$queryRaw<Linha[]>`
      UPDATE order_charges SET
        psp_payment_id = ${resposta.pagamentoId},
        pix_payload = ${resposta.pixCopiaECola ?? null},
        checkout_url = ${resposta.url ?? null},
        expires_at = ${resposta.expiraEm ?? null},
        updated_at = now()
       WHERE id = ${preparo.chargeId}::uuid AND status = 'aguardando'
      RETURNING id, order_id, method::text, amount_cents, status::text, psp_payment_id,
             pix_payload, checkout_url, expires_at, paid_at, refused_reason,
             created_by_name, created_at
    `;
    const linha = atualizadas[0];
    if (!linha) {
      // Cancelada no meio do caminho. O que existe no adquirente precisa morrer
      // lá também, senão o cliente paga um código que o produto já enterrou.
      await params.provider.cancelar(resposta.pagamentoId).catch(() => undefined);
      throw new CobrancaError('cobranca_encerrada', 'Esta cobrança foi cancelada.');
    }
    return paraCobranca(linha);
  });
}

/** O que a tela da comanda mostra: a viva primeiro, o histórico embaixo. */
export async function cobrancasDaComanda(
  tenantId: string,
  orderId: string,
): Promise<CobrancaDaComanda[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<Linha[]>`
      SELECT id, order_id, method::text, amount_cents, status::text, psp_payment_id,
             pix_payload, checkout_url, expires_at, paid_at, refused_reason,
             created_by_name, created_at
        FROM order_charges
       WHERE order_id = ${orderId}::uuid
       ORDER BY created_at DESC
    `;
    return linhas.map(paraCobranca);
  });
}

export type DesfechoDaConfirmacao =
  | 'pago'
  | 'pago_sem_caixa'
  /**
   * O adquirente confirmou e a venda **não** dava mais para fechar.
   *
   * Comanda fechada na mão enquanto o Pix estava vivo, ou total que mudou por
   * fora. É desfecho, não exceção, e a diferença custa caro: deixar a exceção
   * subir devolvia 500 ao adquirente — que reentrega por dias — e derrubava a
   * varredura da barbearia inteira no meio do laço. Agora o dinheiro fica
   * registrado como recebido e a linha aparece como divergência para alguém
   * resolver.
   */
  | 'pago_com_divergencia'
  /** Pago **depois** de a cobrança ter sido encerrada. Ver `cancelarCobranca`. */
  | 'pago_orfao'
  | 'recusado'
  | 'expirado'
  | 'ignorado';

export interface ResultadoDaConfirmacao {
  readonly desfecho: DesfechoDaConfirmacao;
  readonly comanda: Comanda | null;
}

/**
 * Aplica o que o adquirente disse sobre uma cobrança — uma vez só.
 *
 * É a **única** função que muda o estado de uma cobrança por conta do
 * adquirente, e é chamada tanto pelo webhook quanto pela conciliação. Duas
 * implementações divergiriam no primeiro ajuste, e a divergência aqui é
 * "pagamento contado duas vezes".
 *
 * A idempotência tem duas camadas, e as duas importam: `order_charge_events`
 * trava a entrega **concorrente** pela chave primária, e o `AND status =
 * 'aguardando'` do `UPDATE` trava a sequencial — a segunda não depende de
 * ninguém ter lembrado de registrar o evento.
 */
export async function confirmarCobranca(params: {
  readonly tenantId: string;
  readonly eventoId: string;
  readonly tipo: string;
  readonly pagamentoId: string;
  readonly estado: EstadoDoPagamento;
  readonly motivo?: string | undefined;
  readonly hojeNaUnidade: string;
}): Promise<ResultadoDaConfirmacao> {
  return withTenant(params.tenantId, async (tx) => {
    const registrados = await tx.$executeRaw`
      INSERT INTO order_charge_events (event_id, tenant_id, type, outcome)
      VALUES (
        ${params.eventoId},
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${params.tipo}, 'recebido'
      )
      ON CONFLICT (event_id) DO NOTHING
    `;
    // Já registrado é entrega repetida, e a única resposta certa é não fazer
    // nada de novo. O adquirente reentrega por desenho.
    if (registrados === 0) return { desfecho: 'ignorado' as const, comanda: null };

    const linhas = await tx.$queryRaw<
      (Linha & { location_id: string; created_by: string | null })[]
    >`
      SELECT id, order_id, method::text, amount_cents, status::text, psp_payment_id,
             pix_payload, checkout_url, expires_at, paid_at, refused_reason,
             created_by_name, created_at,
             location_id, created_by
        FROM order_charges
       WHERE psp_payment_id = ${params.pagamentoId}
       FOR UPDATE
    `;
    const cobranca = linhas[0];
    if (!cobranca || cobranca.status !== 'aguardando') {
      /**
       * Pagamento que chega para cobrança já encerrada tem nome próprio.
       *
       * Reentrega de algo já aplicado é `ignorado` e é normal. Mas dinheiro
       * confirmado sobre uma cobrança **cancelada ou vencida** é outra coisa:
       * o cliente pagou um código que o balcão já tinha dado por morto, e isso
       * precisa ser encontrável. Chamar os dois de `ignorado` é o jeito de a
       * segunda nunca aparecer.
       */
      const orfao = cobranca !== undefined && cobranca.status !== 'pago' && params.estado === 'pago';
      const desfecho = orfao ? ('pago_orfao' as const) : ('ignorado' as const);
      await encerrarEvento(tx, params.eventoId, cobranca?.id ?? null, desfecho);
      return { desfecho, comanda: null };
    }

    if (params.estado !== 'pago') {
      const novo = params.estado === 'expirado' ? 'expirado' : 'recusado';
      await tx.$executeRaw`
        UPDATE order_charges
           SET status = ${novo}::order_charge_status,
               refused_reason = ${params.motivo ?? null}, updated_at = now()
         WHERE id = ${cobranca.id}::uuid AND status = 'aguardando'
      `;
      await encerrarEvento(tx, params.eventoId, cobranca.id, novo);
      return { desfecho: novo as DesfechoDaConfirmacao, comanda: null };
    }

    await tx.$executeRaw`
      UPDATE order_charges
         SET status = 'pago', paid_at = now(), updated_at = now()
       WHERE id = ${cobranca.id}::uuid AND status = 'aguardando'
    `;

    /**
     * Sem caixa aberto, o dinheiro fica confirmado e a venda fica aberta.
     *
     * Desde o bloco 18 nenhuma venda entra sem gaveta aberta, porque a
     * divergência do fechamento precisa ter dono. Forçar aqui inventaria uma
     * gaveta; recusar o pagamento seria pior, porque o cliente já pagou. O que
     * sobra é a verdade: a cobrança está paga e o balcão fecha quando abrir o
     * caixa.
     */
    const sessoes = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM cash_sessions
       WHERE location_id = ${cobranca.location_id}::uuid AND status = 'open'
    `;
    if (!sessoes[0]) {
      await encerrarEvento(tx, params.eventoId, cobranca.id, 'pago_sem_caixa');
      return { desfecho: 'pago_sem_caixa' as const, comanda: null };
    }

    /**
     * A cadeia da SPEC §3.3, na mesma transação.
     *
     * Quem fecha é `fecharComanda`, e não uma segunda implementação: ele já
     * grava o pagamento, move a gaveta, lança o fiado, escreve o extrato e
     * gera a comissão. Reescrever isso aqui seria manter duas verdades sobre o
     * que é fechar uma venda.
     */
    const comanda = await fecharComandaOuDivergencia(tx, {
      tenantId: params.tenantId,
      locationId: cobranca.location_id,
      orderId: cobranca.order_id,
      pagamentos: [
        {
          forma: FORMA_DO_PAGAMENTO[MEIO_NO_DOMINIO[cobranca.method] ?? 'pix'],
          valorCents: cobranca.amount_cents,
        },
      ],
      // O crédito é de quem emitiu a cobrança, não de um usuário de sistema: o
      // webhook não tem gente atrás, e a trilha ficaria sem responsável.
      staffId: cobranca.created_by ?? '00000000-0000-0000-0000-000000000000',
      staffName: cobranca.created_by_name,
      hojeNaUnidade: params.hojeNaUnidade,
      idempotencyKey: `cobranca:${cobranca.id}`,
      tx,
    });

    if (comanda === null) {
      await encerrarEvento(tx, params.eventoId, cobranca.id, 'pago_com_divergencia');
      return { desfecho: 'pago_com_divergencia' as const, comanda: null };
    }

    /**
     * O split, **depois** de a comanda fechar (bloco 49).
     *
     * Depois porque é `fecharComanda` quem cria os lançamentos de comissão, e o
     * split é derivado deles. Antes, ele repartiria uma venda sem comissão
     * nenhuma e mandaria tudo para a casa.
     *
     * `derivarSplitDaVenda` nunca lança por motivo que não seja de pagamento —
     * é a lição do bloco 35, e ela vale aqui com força: esta é literalmente a
     * transação do webhook do Pix.
     */
    await derivarSplitDaVenda(tx, {
      orderId: cobranca.order_id,
      chargeId: cobranca.id,
      pagamentoCents: cobranca.amount_cents,
    });

    await encerrarEvento(tx, params.eventoId, cobranca.id, 'pago');
    return { desfecho: 'pago' as const, comanda };
  });
}

/**
 * Fecha a venda, ou devolve `null` quando ela não fecha mais.
 *
 * O achado HIGH da `/security-review` do bloco 35. A comanda podia ser fechada
 * na mão com o Pix ainda vivo — a tela oferecia as duas coisas lado a lado —, e
 * então a confirmação subia `comanda_fechada` como exceção. O estrago era em
 * três camadas: a transação inteira voltava atrás (o dinheiro ficava sem
 * registro nenhum), o webhook respondia 500 e o adquirente reentregava por
 * dias, e a varredura da barbearia **parava no meio do laço** — deixando todas
 * as outras cobranças dela sem conferência.
 *
 * Agora "não dá para fechar" é desfecho: a cobrança continua `pago`, o evento é
 * consumido, o adquirente recebe 2xx e a linha fica encontrável como
 * divergência. Dinheiro recebido nunca deixa de ser registrado por causa de um
 * conflito de estado da venda.
 */
async function fecharComandaOuDivergencia(
  tx: TransactionClient,
  params: Parameters<typeof fecharComanda>[0],
): Promise<Comanda | null> {
  const aberta = await tx.$queryRaw<{ status: string; total_cents: number }[]>`
    SELECT status::text, total_cents FROM orders WHERE id = ${params.orderId}::uuid
  `;
  const comanda = aberta[0];
  if (!comanda || comanda.status !== 'open') return null;
  // O total mudou por fora depois da emissão: fechar com o valor da cobrança
  // seria gravar uma venda que não bate com o que foi cobrado.
  if (comanda.total_cents !== params.pagamentos.reduce((s, p) => s + p.valorCents, 0)) {
    return null;
  }
  return fecharComanda(params);
}

async function encerrarEvento(
  tx: TransactionClient,
  eventoId: string,
  chargeId: string | null,
  desfecho: string,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE order_charge_events
       SET charge_id = ${chargeId}::uuid, outcome = ${desfecho}
     WHERE event_id = ${eventoId}
  `;
}

/**
 * Cancela uma cobrança em aberto, a pedido do balcão.
 *
 * "O cliente desistiu do Pix e vai pagar em dinheiro" é rotina. Sem isto a
 * comanda ficaria travada até o QR Code vencer, e o balcão teria que esperar
 * com o cliente na frente.
 */
export async function cancelarCobranca(params: {
  readonly tenantId: string;
  /** A comanda da URL. Sem ela, um id de cobrança valeria em qualquer endereço. */
  readonly orderId: string;
  readonly chargeId: string;
  readonly staffId: string;
  readonly staffName: string;
  readonly provider: PaymentProvider;
}): Promise<void> {
  const pagamentoId = await withTenant(params.tenantId, async (tx) => {
    const encerradas = await tx.$queryRaw<{ psp_payment_id: string | null }[]>`
      UPDATE order_charges
         SET status = 'expirado', refused_reason = 'cancelada no balcão', updated_at = now()
       WHERE id = ${params.chargeId}::uuid
         AND order_id = ${params.orderId}::uuid
         AND status = 'aguardando'
      RETURNING psp_payment_id
    `;
    const encerrada = encerradas[0];
    if (!encerrada) {
      throw new CobrancaError('cobranca_encerrada', 'Esta cobrança já foi encerrada.');
    }

    /**
     * Cancelar é ato de dinheiro, e a trilha é gravada **dentro** da transação.
     *
     * Sem ela, matar o QR Code de um colega não deixava rastro nenhum — e
     * combinado com o cancelamento que não chegava ao adquirente, cada
     * cancelamento virava um pagamento que o produto nunca registraria.
     */
    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'order.charge_cancelled',
      entity: 'order_charge',
      entityId: params.chargeId,
      after: { orderId: params.orderId },
    });

    return encerrada.psp_payment_id;
  });

  /**
   * O adquirente precisa saber, e é o ponto do achado.
   *
   * Cancelar só do nosso lado deixava o QR Code **pagável**: o cliente que já
   * tinha lido o código pagava, o webhook encontrava a cobrança fora de
   * `aguardando` e devolvia "ignorado". Dinheiro capturado, nunca registrado,
   * nunca devolvido, e sem aviso nenhum.
   *
   * Fora da transação, como toda ida ao adquirente. Se ele recusar, a cobrança
   * já está encerrada aqui e a confirmação que chegar depois cai em
   * `pago_orfao` — que é encontrável, ao contrário do silêncio anterior.
   */
  if (pagamentoId) await params.provider.cancelar(pagamentoId);
}

export interface ResultadoDaVarredura {
  readonly consultadas: number;
  readonly pagas: number;
  readonly encerradas: number;
  /** Quantas concluíram uma venda que tinha ficado paga sem caixa aberto. */
  readonly concluidas: number;
  /** Quantas falharam. Uma cobrança ruim não pode parar a varredura inteira. */
  readonly comFalha: number;
}

/**
 * A rede de segurança: pergunta ao adquirente o que houve com o que está vivo,
 * e conclui o que ficou pago sem gaveta.
 *
 * O webhook é o caminho normal e chega em segundos; esperar por esta varredura
 * faria o balcão olhar "aguardando" com o cliente já tendo pago. Mas webhook se
 * perde — proxy fora do ar, publicação no meio da entrega —, e sem a rede a
 * comanda ficaria aberta até alguém reclamar.
 *
 * O id do evento é `recon:<pagamento>:<estado>`, determinístico: se o webhook já
 * contou a mesma coisa, o `ON CONFLICT` engole, e duas voltas da varredura
 * sobre o mesmo estado também.
 *
 * **Uma falha não para o laço.** Era metade do estrago do achado HIGH da
 * `/security-review`: a exceção subia do meio do `for` e todas as cobranças
 * ordenadas depois daquela ficavam sem conferência, por tempo indeterminado,
 * porque a volta seguinte esbarraria na mesma.
 */
export async function conciliarCobrancas(params: {
  readonly tenantId: string;
  readonly provider: PaymentProvider;
  readonly hojeNaUnidade: string;
  readonly agora: Date;
}): Promise<ResultadoDaVarredura> {
  const contagem = { consultadas: 0, pagas: 0, encerradas: 0, concluidas: 0, comFalha: 0 };

  const vivas = await withTenant(params.tenantId, async (tx) => {
    return tx.$queryRaw<{ id: string; psp_payment_id: string | null; expires_at: Date | null }[]>`
      SELECT id, psp_payment_id, expires_at FROM order_charges
       WHERE status = 'aguardando'
       ORDER BY created_at
    `;
  });

  for (const viva of vivas) {
    try {
      /**
       * Sem id do provedor não há o que perguntar.
       *
       * É a linha órfã: nasceu e o processo caiu antes de a resposta chegar.
       * Vencido o prazo, ela vira `expirado` — do contrário travaria a comanda
       * para sempre, porque só uma cobrança viva é permitida por vez.
       */
      if (!viva.psp_payment_id) {
        if (viva.expires_at === null || viva.expires_at.getTime() <= params.agora.getTime()) {
          await encerrarPorTempo(params.tenantId, viva.id, 'emissão sem resposta');
          contagem.encerradas += 1;
        }
        continue;
      }

      // Fora de transação, como toda ida ao adquirente.
      const estado = await params.provider.consultar(viva.psp_payment_id);
      contagem.consultadas += 1;

      if (estado === 'aguardando') {
        if (viva.expires_at !== null && viva.expires_at.getTime() <= params.agora.getTime()) {
          /**
           * Vencido aqui **e** lá: cancelar só do nosso lado deixaria o código
           * pagável, e o pagamento chegaria para uma cobrança que já morreu.
           */
          await params.provider.cancelar(viva.psp_payment_id).catch(() => undefined);
          await encerrarPorTempo(params.tenantId, viva.id, 'prazo do Pix vencido');
          contagem.encerradas += 1;
        }
        continue;
      }

      const resultado = await confirmarCobranca({
        tenantId: params.tenantId,
        eventoId: `recon:${viva.psp_payment_id}:${estado}`,
        tipo: 'conciliacao',
        pagamentoId: viva.psp_payment_id,
        estado,
        hojeNaUnidade: params.hojeNaUnidade,
      });

      if (resultado.desfecho === 'pago' || resultado.desfecho === 'pago_sem_caixa') {
        contagem.pagas += 1;
      }
      if (resultado.desfecho === 'recusado' || resultado.desfecho === 'expirado') {
        contagem.encerradas += 1;
      }
    } catch (erro) {
      contagem.comFalha += 1;
      // O id, nunca o copia-e-cola: log não é lugar de dado que cobra alguém.
      console.error('[cobranca] conciliação falhou', { chargeId: viva.id, erro });
    }
  }

  contagem.concluidas = await concluirPagasSemCaixa(params);
  return contagem;
}

/**
 * Fecha a venda que ficou paga sem gaveta aberta.
 *
 * O achado nº 4 da revisão: `pago_sem_caixa` era estado terminal sem saída. A
 * varredura só olhava `aguardando`, então a comanda ficava aberta para sempre
 * com o dinheiro já recebido — e o único caminho que sobrava para o balcão era
 * o "Receber" manual, que cobraria o cliente uma segunda vez.
 *
 * A chave de idempotência é a mesma do webhook (`cobranca:<id>`), então isto é
 * naturalmente reentrante: se o fechamento já aconteceu, ele devolve a comanda
 * paga em vez de fechá-la de novo.
 */
async function concluirPagasSemCaixa(params: {
  readonly tenantId: string;
  readonly hojeNaUnidade: string;
}): Promise<number> {
  const pendentes = await withTenant(params.tenantId, async (tx) => {
    return tx.$queryRaw<
      (Linha & { location_id: string; created_by: string | null })[]
    >`
      SELECT c.id, c.order_id, c.method::text, c.amount_cents, c.status::text, c.psp_payment_id,
             c.pix_payload, c.checkout_url, c.expires_at, c.paid_at, c.refused_reason,
             c.created_by_name, c.created_at, c.location_id, c.created_by
        FROM order_charges c
        JOIN orders o ON o.id = c.order_id
        JOIN cash_sessions s
          ON s.location_id = c.location_id AND s.status = 'open'
       WHERE c.status = 'pago' AND o.status = 'open'
       ORDER BY c.paid_at
    `;
  });

  let concluidas = 0;
  for (const cobranca of pendentes) {
    try {
      const fechada = await withTenant(params.tenantId, async (tx) =>
        fecharComandaOuDivergencia(tx, {
          tenantId: params.tenantId,
          locationId: cobranca.location_id,
          orderId: cobranca.order_id,
          pagamentos: [
            {
              forma: FORMA_DO_PAGAMENTO[MEIO_NO_DOMINIO[cobranca.method] ?? 'pix'],
              valorCents: cobranca.amount_cents,
            },
          ],
          staffId: cobranca.created_by ?? '00000000-0000-0000-0000-000000000000',
          staffName: cobranca.created_by_name,
          hojeNaUnidade: params.hojeNaUnidade,
          idempotencyKey: `cobranca:${cobranca.id}`,
          tx,
        }),
      );
      if (fechada) concluidas += 1;
    } catch (erro) {
      console.error('[cobranca] conclusão falhou', { chargeId: cobranca.id, erro });
    }
  }
  return concluidas;
}

async function encerrarPorTempo(
  tenantId: string,
  chargeId: string,
  motivo: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.$executeRaw`
      UPDATE order_charges
         SET status = 'expirado', refused_reason = ${motivo}, updated_at = now()
       WHERE id = ${chargeId}::uuid AND status = 'aguardando'
    `;
  });
}
