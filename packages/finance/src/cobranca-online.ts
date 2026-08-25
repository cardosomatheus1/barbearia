import { withTenant, type TransactionClient } from '@barbearia/db';
import { diaNaUnidade } from '@barbearia/core';
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

function erroSeguroParaLog(erro: unknown): { erroTipo: string; erroCodigo?: string } {
  if (!(erro instanceof Error)) return { erroTipo: 'erro_desconhecido' };
  const codigo = (erro as Error & { code?: unknown }).code;
  return {
    erroTipo: erro.name || 'Error',
    ...(typeof codigo === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(codigo)
      ? { erroCodigo: codigo }
      : {}),
  };
}

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

export type EstadoDaCobrancaOnline = 'aguardando' | 'pago' | 'recusado' | 'expirado' | 'estornado';

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
  | 'cobranca_encerrada'
  | 'idempotency_key_reutilizada';

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
  refunded_at?: Date | null;
  psp_refund_id?: string | null;
  refunded_cents?: number | null;
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
  estado: l.refunded_at ? 'estornado' : (l.status as EstadoDaCobrancaOnline),
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
       WHERE location_id = ${params.locationId}::uuid
         AND idempotency_key = ${params.idempotencyKey}
    `;
    const anterior = repetida[0];
    if (anterior) {
      if (
        anterior.order_id !== params.orderId ||
        (MEIO_NO_DOMINIO[anterior.method] ?? 'pix') !== params.meio
      ) {
        throw new CobrancaError(
          'idempotency_key_reutilizada',
          'Esta chave de cobrança já foi usada para outra intenção.',
        );
      }
      // Linha aguardando sem id do PSP = a criação pode ter sido aceita e a
      // resposta se perdeu. Não devolvemos uma cobrança vazia nem abrimos outra:
      // repetimos a **mesma** criação abaixo, com a chave estável da linha.
      if (anterior.status === 'aguardando' && !anterior.psp_payment_id) {
        const nomes = await tx.$queryRaw<{ customer_name: string | null }[]>`
          SELECT c.name AS customer_name
            FROM orders o
            LEFT JOIN customers c ON c.id = o.customer_id
           WHERE o.id = ${anterior.order_id}::uuid
        `;
        return {
          chargeId: anterior.id,
          valorCents: anterior.amount_cents,
          descricao: nomes[0]?.customer_name
            ? `Atendimento — ${nomes[0].customer_name}`
            : 'Atendimento',
          meio: MEIO_NO_DOMINIO[anterior.method] ?? params.meio,
          orderId: anterior.order_id,
          recuperando: true as const,
        };
      }
      return { repetida: paraCobranca(anterior) };
    }

    const comandas = await tx.$queryRaw<
      { id: string; status: string; total_cents: number; customer_name: string | null }[]
    >`
      SELECT o.id, o.status::text, o.total_cents, c.name AS customer_name
        FROM orders o
        LEFT JOIN customers c ON c.id = o.customer_id
       -- A comanda e desta loja. Sem esta linha, a cobranca nascia com a
       -- location_id de uma loja em order_charges e a de outra em orders: a
       -- mesma cobranca apontando para duas gavetas, e o fechamento pelo
       -- webhook do Pix levando o dinheiro para a errada.
       WHERE o.id = ${params.orderId}::uuid
         AND o.location_id = ${params.locationId}::uuid
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
     * `pago` também trava nova emissão enquanto a comanda continuar aberta.
     *
     * Este estado existe quando o cliente pagou com a gaveta fechada: o
     * adquirente já confirmou o dinheiro, mas a venda ainda espera um caixa
     * aberto para ser concluída. Considerar somente `aguardando` permitia
     * emitir uma segunda cobrança nesse intervalo e cobrar o cliente duas
     * vezes. O `FOR UPDATE` da comanda serializa duas emissões concorrentes; o
     * índice parcial no banco é a segunda camada caso outra porta seja criada.
     */
    const existentes = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status
        FROM order_charges
       WHERE order_id = ${params.orderId}::uuid
         AND status IN ('aguardando', 'pago')
         AND refunded_at IS NULL
       LIMIT 1
    `;
    if (existentes[0]) {
      throw new CobrancaError(
        'cobranca_em_curso',
        existentes[0].status === 'pago'
          ? 'Esta comanda já foi paga pelo adquirente e aguarda conclusão.'
          : 'Já existe uma cobrança em aberto para esta comanda.',
      );
    }

    /**
     * Uma cobrança viva ou já confirmada por comanda — e a recusa é do banco.
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
      ON CONFLICT (order_id) WHERE status IN ('aguardando', 'pago') AND refunded_at IS NULL DO NOTHING
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
      meio: params.meio,
      orderId: params.orderId,
      recuperando: false as const,
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
      orderId: preparo.orderId,
      meio: preparo.meio,
      valorCents: preparo.valorCents,
      descricao: preparo.descricao,
      // Derivada do id da linha: a retentativa reencontra a mesma cobrança no
      // adquirente em vez de criar a segunda.
      idempotencyKey: preparo.chargeId,
    });
  } catch (erro) {
    /**
     * A falha de transporte é ambígua: o adquirente pode ter criado a cobrança
     * e perdido só a resposta. A linha permanece `aguardando` sem id do PSP e
     * bloqueia nova emissão. Repetir esta mesma intenção — pela mesma chave HTTP
     * ou pela conciliação — chama `criarCobranca` com `chargeId` novamente, que
     * o contrato do provider exige tratar idempotentemente.
     */
    await withTenant(params.tenantId, async (tx) => {
      await tx.$executeRaw`
        UPDATE order_charges
           SET refused_reason = 'emissão sem resposta', updated_at = now()
         WHERE id = ${preparo.chargeId}::uuid
           AND status = 'aguardando' AND psp_payment_id IS NULL
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
  /**
   * A loja do balcão.
   *
   * Esta rota devolve `pix_payload` — o copia-e-cola, que é instrumento de
   * pagamento —, `checkout_url` e o id da cobrança. Sem a loja, ela era a
   * janela ao lado do `getComanda` que este bloco fechou, sobre o mesmo
   * `orderId`: a operadora da filial lia as cobranças de uma comanda da matriz
   * e ficava com o `chargeId` que a rota de cancelar precisa.
   */
  locationId: string,
): Promise<CobrancaDaComanda[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<Linha[]>`
      SELECT id, order_id, method::text, amount_cents, status::text, psp_payment_id,
             pix_payload, checkout_url, expires_at, paid_at, refused_reason,
             refunded_at, psp_refund_id, refunded_cents, created_by_name, created_at
        FROM order_charges
       WHERE order_id = ${orderId}::uuid
         AND location_id = ${locationId}::uuid
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
   * resolver. O fluxo atual não deixa esse dinheiro parado: ele dispara
   * refund automático e idempotente e só libera nova cobrança depois de a
   * devolução ficar persistida.
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
/**
 * O dia da loja **da cobrança**, e não o da unidade mais antiga.
 *
 * `orders.business_day` é o dia da unidade, e é ele que decide o mês do acerto
 * do barbeiro. Os dois caminhos que chegam aqui — o webhook do adquirente e a
 * varredura de conciliação — resolviam o fuso por `primaryLocation(tenantId)`:
 * numa rede Salvador + Rio Branco, com duas horas de diferença e as duas
 * oferecidas no cadastro de unidade, uma venda da filial confirmada às 22h30
 * era datada pelo dia da matriz. É o defeito D2 que os dois comentários citam,
 * aplicado à loja errada.
 *
 * A cobrança já carrega `location_id`, então a resposta está a um `JOIN` de
 * distância — e resolvê-la aqui dentro impede a terceira porta de errar de
 * novo.
 */
async function diaDaLojaDaCobranca(
  tx: TransactionClient,
  locationId: string,
  agora: Date,
): Promise<string> {
  const linhas = await tx.$queryRaw<{ timezone: string }[]>`
    SELECT timezone FROM locations WHERE id = ${locationId}::uuid
  `;
  const fuso = linhas[0]?.timezone ?? 'America/Sao_Paulo';
  return diaNaUnidade(null, fuso, agora).dia;
}

interface ReembolsoAutomatico {
  readonly chargeId: string;
  readonly pagamentoId: string;
  readonly valorCents: number;
  readonly desfecho: 'pago_orfao' | 'pago_com_divergencia';
}

type ResultadoInternoDaConfirmacao = ResultadoDaConfirmacao & {
  readonly reembolsoAutomatico?: ReembolsoAutomatico;
};

export async function confirmarCobranca(params: {
  readonly tenantId: string;
  readonly eventoId: string;
  readonly tipo: string;
  readonly pagamentoId: string;
  readonly estado: EstadoDoPagamento;
  readonly motivo?: string | undefined;
  /** Provider é obrigatório porque um pagamento tardio de cobrança cancelada precisa ser devolvido. */
  readonly provider: PaymentProvider;
  /** O relógio. O **dia** sai da loja da cobrança, lá dentro. */
  readonly agora: Date;
}): Promise<ResultadoDaConfirmacao> {
  const resultado = await withTenant(params.tenantId, async (tx): Promise<ResultadoInternoDaConfirmacao> => {
    const registrados = await tx.$executeRaw`
      INSERT INTO order_charge_events (event_id, tenant_id, type, outcome)
      VALUES (
        ${params.eventoId},
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${params.tipo}, 'recebido'
      )
      ON CONFLICT (event_id) DO NOTHING
    `;
    // Entrega repetida normalmente não faz nada. A exceção deliberada é um
    // `pago_orfao` cujo refund ainda não foi persistido: o 500 anterior pediu
    // justamente que o adquirente reentregasse para concluirmos essa devolução.
    if (registrados === 0) {
      const pendentes = await tx.$queryRaw<
        { charge_id: string; psp_payment_id: string; amount_cents: number; outcome: 'pago_orfao' | 'pago_com_divergencia' }[]
      >`
        SELECT c.id AS charge_id, c.psp_payment_id, c.amount_cents, e.outcome
          FROM order_charge_events e
          JOIN order_charges c ON c.id = e.charge_id
         WHERE e.event_id = ${params.eventoId}
           AND e.outcome IN ('pago_orfao', 'pago_com_divergencia')
           AND c.psp_refund_id IS NULL
      `;
      const pendente = pendentes[0];
      return pendente
        ? {
            desfecho: pendente.outcome,
            comanda: null,
            reembolsoAutomatico: {
              chargeId: pendente.charge_id,
              pagamentoId: pendente.psp_payment_id,
              valorCents: pendente.amount_cents,
              desfecho: pendente.outcome,
            },
          }
        : { desfecho: 'ignorado' as const, comanda: null };
    }

    const linhas = await tx.$queryRaw<
      (Linha & { location_id: string; created_by: string | null; psp_refund_id: string | null })[]
    >`
      SELECT id, order_id, method::text, amount_cents, status::text, psp_payment_id,
             pix_payload, checkout_url, expires_at, paid_at, refused_reason,
             created_by_name, created_at,
             location_id, created_by, psp_refund_id
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
      return orfao && cobranca?.psp_payment_id && cobranca.psp_refund_id === null
        ? {
            desfecho,
            comanda: null,
            reembolsoAutomatico: {
              chargeId: cobranca.id,
              pagamentoId: cobranca.psp_payment_id,
              valorCents: cobranca.amount_cents,
              desfecho: 'pago_orfao',
            },
          }
        : { desfecho, comanda: null };
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
      hojeNaUnidade: await diaDaLojaDaCobranca(tx, cobranca.location_id, params.agora),
      idempotencyKey: `cobranca:${cobranca.id}`,
      tx,
    });

    if (comanda === null) {
      await encerrarEvento(tx, params.eventoId, cobranca.id, 'pago_com_divergencia');
      return {
        desfecho: 'pago_com_divergencia' as const,
        comanda: null,
        reembolsoAutomatico: {
          chargeId: cobranca.id,
          // A cobrança foi localizada exatamente pelo id confirmado pelo PSP.
          // Usar o parâmetro preserva o estreitamento para `string` mesmo
          // quando a coluna histórica ainda admite nulo no schema.
          pagamentoId: params.pagamentoId,
          valorCents: cobranca.amount_cents,
          desfecho: 'pago_com_divergencia' as const,
        },
      };
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

  if (resultado.reembolsoAutomatico) {
    const reembolsoPendente = resultado.reembolsoAutomatico;
    // Fora da transação: rede nunca segura conexão do banco. Se falhar, a
    // exceção sobe e o webhook/conciliação repetem; a branch de evento já
    // registrado acima reencontra este mesmo refund pendente.
    const reembolso = await params.provider.estornar(reembolsoPendente.pagamentoId, reembolsoPendente.valorCents);
    await withTenant(params.tenantId, async (tx) => {
      const linhas = await tx.$queryRaw<{ psp_refund_id: string | null }[]>`
        UPDATE order_charges
           SET refunded_at = coalesce(refunded_at, now()),
               psp_refund_id = coalesce(psp_refund_id, ${reembolso.estornoId}),
               refunded_cents = coalesce(refunded_cents, ${reembolsoPendente.valorCents}),
               refused_reason = CASE
                 WHEN ${reembolsoPendente.desfecho} = 'pago_com_divergencia' THEN 'pagamento devolvido por divergência'
                 ELSE refused_reason
               END,
               updated_at = now()
         WHERE id = ${reembolsoPendente.chargeId}::uuid
         RETURNING psp_refund_id
      `;
      if (linhas[0]?.psp_refund_id !== reembolso.estornoId) {
        throw new Error('reembolso_automatico_divergente');
      }
    });
  }

  return { desfecho: resultado.desfecho, comanda: resultado.comanda };
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
    SELECT status::text, total_cents FROM orders
     WHERE id = ${params.orderId}::uuid
       AND location_id = ${params.locationId}::uuid
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
  /** A loja do balcão. */
  readonly locationId: string;
  /** A comanda da URL. Sem ela, um id de cobrança valeria em qualquer endereço. */
  readonly orderId: string;
  readonly chargeId: string;
  readonly staffId: string;
  readonly staffName: string;
  readonly provider: PaymentProvider;
}): Promise<void> {
  /**
   * Primeiro descobrimos o recurso externo, sem alterar o estado local.
   *
   * A versão anterior marcava `expirado` e só depois chamava o adquirente. Se a
   * rede falhasse, a cobrança sumia da conciliação (que olha `aguardando`) mas o
   * QR Code continuava pagável. O estado seguro em falha é o oposto: continuar
   * `aguardando`, bloqueando nova emissão, até conseguirmos provar que o código
   * morreu no adquirente.
   */
  const pagamentoId = await withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ psp_payment_id: string | null }[]>`
      SELECT psp_payment_id
        FROM order_charges
       WHERE id = ${params.chargeId}::uuid
         AND order_id = ${params.orderId}::uuid
         AND location_id = ${params.locationId}::uuid
         AND status = 'aguardando'
       FOR UPDATE
    `;
    const linha = linhas[0];
    if (!linha) {
      throw new CobrancaError('cobranca_encerrada', 'Esta cobrança já foi encerrada.');
    }
    if (!linha.psp_payment_id) {
      // A cobrança existe no banco, mas o adquirente ainda está criando o
      // pagamento. Encerrá-la localmente agora abriria a corrida em que a
      // resposta externa chega depois e deixa um QR Code vivo sem linha viva
      // para conciliá-lo. O estado seguro é manter a cobrança bloqueando nova
      // emissão até a chamada de criação terminar (ou falhar e expirar).
      throw new CobrancaError(
        'cobranca_em_curso',
        'A cobrança ainda está sendo emitida. Tente cancelar novamente em instantes.',
      );
    }
    return linha.psp_payment_id;
  });

  // Rede fora de transação. Se falhar, a linha continua `aguardando` e a
  // conciliação/uma nova tentativa ainda conseguem alcançar o pagamento.
  await params.provider.cancelar(pagamentoId);

  await withTenant(params.tenantId, async (tx) => {
    const encerradas = await tx.$queryRaw<{ id: string }[]>`
      UPDATE order_charges
         SET status = 'expirado', refused_reason = 'cancelada no balcão', updated_at = now()
       WHERE id = ${params.chargeId}::uuid
         AND order_id = ${params.orderId}::uuid
         AND location_id = ${params.locationId}::uuid
         AND status = 'aguardando'
      RETURNING id
    `;
    if (!encerradas[0]) {
      // O adquirente pode ter confirmado enquanto o cancelamento estava na
      // rede. Não sobrescrevemos `pago`: a tela/conciliação resolvem o dinheiro.
      throw new CobrancaError('cobranca_encerrada', 'Esta cobrança mudou de estado durante o cancelamento.');
    }

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'order.charge_cancelled',
      entity: 'order_charge',
      entityId: params.chargeId,
      after: { orderId: params.orderId },
    });
  });
}

export interface ResultadoDaVarredura {
  readonly consultadas: number;
  readonly pagas: number;
  readonly encerradas: number;
  /** Quantas concluíram uma venda que tinha ficado paga sem caixa aberto. */
  readonly concluidas: number;
  /** Quantas falharam. Uma cobrança ruim não pode parar a varredura inteira. */
  readonly comFalha: number;
  /** Cobranças que continuam vivas e exigem outra volta de conciliação. */
  readonly pendentes: number;
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
  readonly agora: Date;
}): Promise<ResultadoDaVarredura> {
  const contagem = { consultadas: 0, pagas: 0, encerradas: 0, concluidas: 0, comFalha: 0, pendentes: 0 };

  const vivas = await withTenant(params.tenantId, async (tx) => {
    return tx.$queryRaw<{
      id: string;
      order_id: string;
      method: string;
      amount_cents: number;
      psp_payment_id: string | null;
      expires_at: Date | null;
      customer_name: string | null;
    }[]>`
      SELECT ch.id, ch.order_id, ch.method::text, ch.amount_cents,
             ch.psp_payment_id, ch.expires_at, c.name AS customer_name
        FROM order_charges ch
        JOIN orders o ON o.id = ch.order_id
        LEFT JOIN customers c ON c.id = o.customer_id
       WHERE ch.status = 'aguardando'
       ORDER BY ch.created_at
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
        /**
         * Recupera a **mesma** criação, nunca abre uma cobrança nova.
         *
         * A linha nasceu antes da rede e seu id é a chave do adquirente. Se a
         * primeira resposta se perdeu, o provider idempotente devolve o mesmo
         * Pix/link. Se a chamada continuar indisponível, a linha permanece viva
         * e outra volta é agendada abaixo — liberar a comanda seria aceitar um
         * pagamento órfão que não conseguimos cancelar nem consultar.
         */
        const recuperada = await params.provider.criarCobranca({
          tenantId: params.tenantId,
          orderId: viva.order_id,
          meio: MEIO_NO_DOMINIO[viva.method] ?? 'pix',
          valorCents: viva.amount_cents,
          descricao: viva.customer_name ? `Atendimento — ${viva.customer_name}` : 'Atendimento',
          idempotencyKey: viva.id,
        });
        await withTenant(params.tenantId, async (tx) => {
          await tx.$executeRaw`
            UPDATE order_charges
               SET psp_payment_id = ${recuperada.pagamentoId},
                   pix_payload = ${recuperada.pixCopiaECola ?? null},
                   checkout_url = ${recuperada.url ?? null},
                   expires_at = ${recuperada.expiraEm ?? null},
                   refused_reason = NULL,
                   updated_at = now()
             WHERE id = ${viva.id}::uuid
               AND status = 'aguardando' AND psp_payment_id IS NULL
          `;
        });

        if (recuperada.estado !== 'aguardando') {
          const resultado = await confirmarCobranca({
            tenantId: params.tenantId,
            eventoId: `recon:${recuperada.pagamentoId}:${recuperada.estado}`,
            tipo: 'conciliacao',
            pagamentoId: recuperada.pagamentoId,
            estado: recuperada.estado,
            provider: params.provider,
            agora: params.agora,
          });
          if (resultado.desfecho === 'pago' || resultado.desfecho === 'pago_sem_caixa') contagem.pagas += 1;
          if (resultado.desfecho === 'recusado' || resultado.desfecho === 'expirado') contagem.encerradas += 1;
        } else {
          contagem.pendentes += 1;
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
          await params.provider.cancelar(viva.psp_payment_id);
          await encerrarPorTempo(params.tenantId, viva.id, 'prazo do Pix vencido');
          contagem.encerradas += 1;
        }
        if (viva.expires_at === null || viva.expires_at.getTime() > params.agora.getTime()) {
          contagem.pendentes += 1;
        }
        continue;
      }

      const resultado = await confirmarCobranca({
        tenantId: params.tenantId,
        eventoId: `recon:${viva.psp_payment_id}:${estado}`,
        tipo: 'conciliacao',
        pagamentoId: viva.psp_payment_id,
        estado,
        provider: params.provider,
        agora: params.agora,
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
      console.error('[cobranca] conciliação falhou', { chargeId: viva.id, ...erroSeguroParaLog(erro) });
    }
  }

  contagem.concluidas = await concluirPagasSemCaixa(params);
  /**
   * A conciliação é contínua enquanto houver cobrança viva ou falha transitória.
   *
   * A primeira versão tinha uma única tarefa 30 minutos depois da emissão. Se o
   * PSP estivesse fora do ar naquela volta — ou o link ainda estivesse
   * aguardando — o job concluía e nunca mais alguém perguntava. Uma chave por
   * janela de dez minutos deduplica workers concorrentes sem transformar a rede
   * de segurança em laço apertado.
   */
  if (contagem.pendentes > 0 || contagem.comFalha > 0) {
    const proxima = new Date(params.agora.getTime() + 10 * 60_000);
    const janela = Math.floor(proxima.getTime() / (10 * 60_000));
    await withTenant(params.tenantId, async (tx) => {
      await enfileirarPara(tx, params.tenantId, {
        kind: 'cobranca.conciliar',
        payload: {},
        rodarApos: proxima,
        idempotencyKey: `cobranca-recon:${params.tenantId}:${janela}`,
      });
    });
  }

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
  readonly agora: Date;
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
       WHERE c.status = 'pago'
         AND c.refunded_at IS NULL
         AND o.status = 'open'
       ORDER BY c.paid_at
    `;
  });

  let concluidas = 0;
  for (const cobranca of pendentes) {
    try {
      const fechada = await withTenant(params.tenantId, async (tx) => {
        const venda = await fecharComandaOuDivergencia(tx, {
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
          hojeNaUnidade: await diaDaLojaDaCobranca(tx, cobranca.location_id, params.agora),
          idempotencyKey: `cobranca:${cobranca.id}`,
          tx,
        });
        if (venda) {
          // O caminho tardio precisa produzir os mesmos fatos do webhook com
          // caixa aberto. Sem isto comissão existia, mas `payment_splits` não:
          // o dinheiro do profissional nunca entrava na fila de repasse.
          await derivarSplitDaVenda(tx, {
            orderId: cobranca.order_id,
            chargeId: cobranca.id,
            pagamentoCents: cobranca.amount_cents,
          });
        }
        return venda;
      });
      if (fechada) concluidas += 1;
    } catch (erro) {
      console.error('[cobranca] conclusão falhou', { chargeId: cobranca.id, ...erroSeguroParaLog(erro) });
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
