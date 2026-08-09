import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  conferirPagamento,
  entraNaGaveta,
  resultadoDoPagamento,
  somarComanda,
  taxaDaVenda,
  validarDesconto,
  tetoDoDesconto,
  validarItem,
  type DescontoDaComanda,
  type FormaDePagamento,
  type ItemDaComanda,
  type Pagamento,
  type TipoDeItem,
} from '@barbearia/core';
import { audit } from '@barbearia/identity';
import { lancarComissaoDaComanda } from './comissao.js';

/**
 * A comanda, do banco para a tela e de volta.
 *
 * Toda decisão de dinheiro está em `packages/core` — soma, desconto, troco,
 * limite de fiado. Aqui só se carrega o estado, se chama o domínio e se grava o
 * resultado **numa transação só**.
 *
 * A transação não é detalhe: fechar uma comanda escreve em cinco tabelas —
 * `orders`, `order_payments`, `cash_movements`, `customers` e
 * `customer_ledger`. Metade disso gravado é caixa que não bate com extrato que
 * não bate com dívida, e nenhum dos três diz qual está certo.
 */

export type ComandaFailure =
  | 'comanda_nao_encontrada'
  | 'comanda_fechada'
  | 'item_invalido'
  | 'desconto_invalido'
  | 'desconto_acima_do_teto'
  | 'pagamento_invalido'
  | 'caixa_fechado'
  | 'cliente_nao_encontrado'
  | 'cobranca_em_curso'
  | 'servico_desconhecido';

export class ComandaError extends Error {
  constructor(
    readonly code: ComandaFailure,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ComandaError';
  }
}

export interface Comanda {
  readonly id: string;
  readonly status: 'open' | 'paid' | 'cancelled';
  readonly customerId: string | null;
  readonly customerName: string | null;
  readonly appointmentId: string | null;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly itens: readonly (ItemDaComanda & { readonly professionalName: string | null })[];
  readonly desconto: DescontoDaComanda | null;
  readonly gorjetaCents: number;
  readonly subtotalCents: number;
  readonly descontoCents: number;
  readonly totalCents: number;
  readonly trocoCents: number;
  readonly pagamentos: readonly { readonly forma: FormaDePagamento; readonly valorCents: number }[];
  /** Saldo e limite de quem vai pagar, para a tela saber se pode fiar. */
  readonly conta: { readonly saldoCents: number; readonly limiteCents: number } | null;
}

async function carregar(tx: TransactionClient, orderId: string): Promise<Comanda> {
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
      change_cents: number;
    }[]
  >`
    SELECT o.id, o.status, o.customer_id, c.name AS customer_name,
           c.balance_cents, c.credit_limit_cents,
           o.appointment_id, o.opened_at, o.closed_at,
           o.discount_cents, o.discount_reason, o.tip_cents, o.change_cents
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
     WHERE o.id = ${orderId}::uuid
  `;
  const cabeca = cabecas[0];
  if (!cabeca) {
    throw new ComandaError('comanda_nao_encontrada', 'Esta comanda não existe mais.');
  }

  const linhas = await tx.$queryRaw<
    {
      id: string;
      kind: TipoDeItem;
      description: string;
      quantity: number;
      unit_price_cents: number;
      professional_id: string | null;
      professional_name: string | null;
    }[]
  >`
    SELECT i.id, i.kind, i.description, i.quantity, i.unit_price_cents,
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

export async function getComanda(tenantId: string, orderId: string): Promise<Comanda> {
  return withTenant(tenantId, (tx) => carregar(tx, orderId));
}

/**
 * Saldo e limite do cliente, com a linha travada até o fim da transação.
 *
 * Quem decide sobre dívida precisa ler o saldo **committed**, não o de um
 * instantâneo anterior: em READ COMMITTED, duas transações simultâneas leem o
 * mesmo saldo antigo e as duas concluem que cabe no limite.
 */
async function saldoTravado(
  tx: TransactionClient,
  customerId: string,
): Promise<{ readonly saldoCents: number; readonly limiteCents: number }> {
  const linhas = await tx.$queryRaw<{ balance_cents: number; credit_limit_cents: number }[]>`
    SELECT balance_cents, credit_limit_cents FROM customers
     WHERE id = ${customerId}::uuid
     FOR UPDATE
  `;
  const linha = linhas[0];
  if (!linha) throw new ComandaError('cliente_nao_encontrado', 'Cliente não encontrado.');
  return { saldoCents: linha.balance_cents, limiteCents: linha.credit_limit_cents };
}

/**
 * Abre a comanda de um atendimento, **pré-preenchida**.
 *
 * A SPEC §3.1 é explícita: a comanda nasce com os serviços do agendamento e o
 * barbeiro só acrescenta o extra. Obrigar a recepção a redigitar o que já está
 * marcado é como o preço cobrado passa a divergir do combinado.
 *
 * O preço vem de `appointment_services`, que guardou o valor **praticado na
 * reserva** — não do catálogo de hoje. Reajuste de tabela não muda o que foi
 * combinado com quem já estava marcado.
 */
export async function abrirComanda(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly appointmentId?: string | null;
  readonly customerId?: string | null;
  readonly staffId: string;
  readonly idempotencyKey?: string;
}): Promise<Comanda> {
  return withTenant(params.tenantId, async (tx) => {
    if (params.idempotencyKey) {
      const anterior = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM orders
         WHERE location_id = ${params.locationId}::uuid
           AND idempotency_key = ${params.idempotencyKey}
      `;
      const jaExiste = anterior[0];
      if (jaExiste) return carregar(tx, jaExiste.id);
    }

    let customerId = params.customerId ?? null;
    const servicos: {
      service_id: string;
      name: string;
      price_cents: number;
      professional_id: string;
    }[] = [];

    if (params.appointmentId) {
      // O id vem da requisição: conferido sob RLS antes de virar chave
      // estrangeira, que é o caminho que ignora row security.
      const agendamentos = await tx.$queryRaw<
        { id: string; customer_id: string | null; professional_id: string }[]
      >`
        SELECT a.id, a.customer_id, a.professional_id
          FROM appointments a
          JOIN professionals p ON p.id = a.professional_id
         WHERE a.id = ${params.appointmentId}::uuid
           AND p.location_id = ${params.locationId}::uuid
      `;
      const agendamento = agendamentos[0];
      if (!agendamento) {
        throw new ComandaError('comanda_nao_encontrada', 'Agendamento não encontrado.');
      }
      customerId = customerId ?? agendamento.customer_id;

      const doAgendamento = await tx.$queryRaw<
        { service_id: string; name: string; price_cents: number }[]
      >`
        SELECT aps.service_id, s.name, aps.price_cents
          FROM appointment_services aps
          JOIN services s ON s.id = aps.service_id
         WHERE aps.appointment_id = ${params.appointmentId}::uuid
         ORDER BY aps.position
      `;
      for (const servico of doAgendamento) {
        servicos.push({ ...servico, professional_id: agendamento.professional_id });
      }
    }

    if (customerId) {
      const cliente = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM customers WHERE id = ${customerId}::uuid
      `;
      if (!cliente[0]) {
        throw new ComandaError('cliente_nao_encontrado', 'Cliente não encontrado.');
      }
    }

    const criada = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO orders
        (tenant_id, location_id, customer_id, appointment_id, opened_by, idempotency_key)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${params.locationId}::uuid, ${customerId}::uuid,
        ${params.appointmentId ?? null}::uuid, ${params.staffId}::uuid,
        ${params.idempotencyKey ?? null}
      )
      RETURNING id
    `;
    const id = criada[0]?.id;
    if (!id) throw new ComandaError('comanda_nao_encontrada', 'Não foi possível abrir a comanda.');

    for (const [posicao, servico] of servicos.entries()) {
      await tx.$executeRaw`
        INSERT INTO order_items
          (tenant_id, order_id, kind, service_id, description, quantity,
           unit_price_cents, professional_id, position)
        VALUES (
          NULLIF(current_setting('app.tenant_id', true), '')::uuid,
          ${id}::uuid, 'service', ${servico.service_id}::uuid, ${servico.name}, 1,
          ${servico.price_cents}, ${servico.professional_id}::uuid, ${posicao}
        )
      `;
    }

    await recalcular(tx, id);
    return carregar(tx, id);
  });
}

/**
 * Os totais gravados acompanham os itens; a fonte é sempre o domínio.
 *
 * ## O desconto é reajustado aqui, e não é detalhe
 *
 * A `/security-review` do bloco 30 achou o furo: o teto era conferido **só no
 * instante de gravar o desconto**, e esta função reescrevia subtotal e total
 * deixando `discount_cents` intacto. Bastava inflar a comanda com uma linha
 * qualquer, descontar o teto do total inflado e apagar a linha — o desconto
 * efetivo subia até zerar a conta, com a trilha registrando os 20% de política.
 *
 * O `CHECK` do banco não pegava: ele exige `discount_cents <= subtotal_cents`,
 * que é exatamente o caso de 100%.
 *
 * A correção é reafirmar o invariante **em toda escrita que muda o subtotal**,
 * que é o que esta função é. Um `CHECK` não resolveria: o teto é por barbearia
 * e mora em outra tabela.
 */
async function recalcular(tx: TransactionClient, orderId: string): Promise<void> {
  const comanda = await carregar(tx, orderId);

  const teto = tetoDoDesconto(comanda.subtotalCents, await tetoDaBarbearia(tx));
  const descontoCents = Math.min(comanda.descontoCents, teto);

  // Recontar com o desconto já grampeado: `carregar` somou com o valor antigo,
  // e gravar aquele total deixaria a conta do banco discordando das colunas.
  const totais = somarComanda({
    itens: comanda.itens,
    desconto: descontoCents > 0 ? { tipo: 'amount', valor: descontoCents, motivo: null } : null,
    gorjetaCents: comanda.gorjetaCents,
  });

  await tx.$executeRaw`
    UPDATE orders SET
      subtotal_cents = ${totais.subtotalCents},
      discount_cents = ${totais.descontoCents},
      total_cents = ${totais.totalCents}
    WHERE id = ${orderId}::uuid
  `;
}

/**
 * Carrega a comanda exigindo que ela esteja aberta.
 *
 * `travar` decide se a linha é bloqueada antes da leitura. O fechamento **tem**
 * que travar: sem isso, dois toques simultâneos no botão "Receber" leem o mesmo
 * estado aberto, os dois passam pela conferência e os dois gravam — duas vezes
 * o pagamento, duas vezes o movimento de caixa e duas vezes a dívida, num
 * extrato que é append-only e não dá para corrigir.
 *
 * Acrescentar item não trava: duas pessoas mexendo na mesma comanda ao mesmo
 * tempo é situação real de balcão, e as duas inserções são compatíveis.
 */
/**
 * Recusa mexer na conta enquanto houver um QR Code vivo (bloco 35).
 *
 * O valor da cobrança é congelado na emissão, e o cliente já está com o código
 * na mão. Deixar acrescentar um item depois criaria uma comanda de R$ 69 com um
 * Pix de R$ 49: o cliente paga o que está no código, a confirmação tenta fechar
 * a venda com o valor errado e **nada** fecha — dinheiro recebido sem venda.
 *
 * O caminho para mudar a conta existe e é explícito: cancelar o Pix, mexer,
 * cobrar de novo. É uma decisão do balcão, não um erro do sistema.
 */
async function exigirSemCobrancaViva(tx: TransactionClient, orderId: string): Promise<void> {
  /**
   * `pago` entra na lista, e não só `aguardando`.
   *
   * Achado nº 4 da `/security-review`: uma cobrança confirmada com o caixa
   * fechado fica `pago` com a comanda **aberta**, e nesse estado o total voltava
   * a ser editável — podendo se afastar do dinheiro que já entrou. É a mesma
   * divergência que a guarda existe para impedir, por um caminho que o próprio
   * código criava.
   */
  const vivas = await tx.$queryRaw<{ status: string }[]>`
    SELECT status::text FROM order_charges
     WHERE order_id = ${orderId}::uuid AND status IN ('aguardando', 'pago')
  `;
  const viva = vivas[0];
  if (viva) {
    throw new ComandaError(
      'cobranca_em_curso',
      viva.status === 'pago'
        ? 'Esta comanda já foi paga pelo adquirente. Abra o caixa para fechá-la.'
        : 'Cancele o Pix em aberto antes de mudar a comanda.',
    );
  }
}

async function exigirAberta(
  tx: TransactionClient,
  orderId: string,
  travar = false,
): Promise<Comanda> {
  if (travar) {
    // Só a chave: `carregar` faz JOIN com `customers` e `professionals`, e
    // `FOR UPDATE` sobre junção travaria linha que não é desta operação.
    const travadas = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE
    `;
    if (!travadas[0]) {
      throw new ComandaError('comanda_nao_encontrada', 'Esta comanda não existe mais.');
    }
  }

  const comanda = await carregar(tx, orderId);
  if (comanda.status !== 'open') {
    throw new ComandaError('comanda_fechada', 'Esta comanda já foi fechada.');
  }
  return comanda;
}

export async function adicionarItem(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly orderId: string;
  readonly tipo: TipoDeItem;
  readonly serviceId?: string | null;
  readonly descricao: string;
  readonly quantidade: number;
  readonly precoUnitarioCents: number;
  readonly professionalId?: string | null;
}): Promise<Comanda> {
  return withTenant(params.tenantId, async (tx) => {
    await exigirAberta(tx, params.orderId);
    await exigirSemCobrancaViva(tx, params.orderId);

    const falha = validarItem({
      tipo: params.tipo,
      descricao: params.descricao,
      quantidade: params.quantidade,
      precoUnitarioCents: params.precoUnitarioCents,
    });
    if (falha) throw new ComandaError('item_invalido', 'Item inválido.', falha);

    // Ids vindos da requisição conferidos sob RLS: a chave estrangeira do
    // Postgres ignora row security e aceitaria o serviço do vizinho.
    if (params.serviceId) {
      const servico = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM services WHERE id = ${params.serviceId}::uuid
      `;
      if (!servico[0]) {
        throw new ComandaError('servico_desconhecido', 'Serviço não encontrado.');
      }
    }
    if (params.professionalId) {
      const pro = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM professionals
         WHERE id = ${params.professionalId}::uuid AND location_id = ${params.locationId}::uuid
      `;
      if (!pro[0]) {
        throw new ComandaError('servico_desconhecido', 'Profissional não encontrado.');
      }
    }

    await tx.$executeRaw`
      INSERT INTO order_items
        (tenant_id, order_id, kind, service_id, description, quantity,
         unit_price_cents, professional_id, position)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${params.orderId}::uuid, ${params.tipo}::order_item_type,
        ${params.serviceId ?? null}::uuid, ${params.descricao.trim()},
        ${params.quantidade}, ${params.precoUnitarioCents},
        ${params.professionalId ?? null}::uuid,
        (SELECT COALESCE(max(position) + 1, 0) FROM order_items WHERE order_id = ${params.orderId}::uuid)
      )
    `;

    await recalcular(tx, params.orderId);
    return carregar(tx, params.orderId);
  });
}

export async function removerItem(params: {
  readonly tenantId: string;
  readonly orderId: string;
  readonly itemId: string;
}): Promise<Comanda> {
  return withTenant(params.tenantId, async (tx) => {
    await exigirAberta(tx, params.orderId);
    await exigirSemCobrancaViva(tx, params.orderId);
    await tx.$executeRaw`
      DELETE FROM order_items
       WHERE id = ${params.itemId}::uuid AND order_id = ${params.orderId}::uuid
    `;
    await recalcular(tx, params.orderId);
    return carregar(tx, params.orderId);
  });
}

/** O teto de desconto configurado, em pontos-base. Dado, não constante. */
async function tetoDaBarbearia(tx: TransactionClient): Promise<number> {
  const linhas = await tx.$queryRaw<{ max_discount_bps: number }[]>`
    SELECT max_discount_bps FROM tenants LIMIT 1
  `;
  // Sem linha não existe barbearia no contexto, e a RLS já teria recusado tudo
  // antes; zero aqui é a resposta conservadora, não um padrão silencioso.
  return linhas[0]?.max_discount_bps ?? 0;
}

const reais = (centavos: number): string =>
  `R$ ${(centavos / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

/**
 * Desconto e gorjeta.
 *
 * O percentual é convertido em centavos **aqui e agora**, e é o valor em
 * centavos que fica gravado. Guardar "10%" faria o desconto do passado mudar
 * quando alguém acrescentasse um item à comanda — e a conta que o cliente já viu
 * mudaria sozinha.
 */
export async function ajustarComanda(params: {
  readonly tenantId: string;
  readonly orderId: string;
  readonly desconto?: DescontoDaComanda | null;
  readonly gorjetaCents?: number;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<Comanda> {
  return withTenant(params.tenantId, async (tx) => {
    const atual = await exigirAberta(tx, params.orderId);
    await exigirSemCobrancaViva(tx, params.orderId);

    if (params.desconto) {
      const falha = validarDesconto(params.desconto);
      if (falha) throw new ComandaError('desconto_invalido', 'Desconto inválido.', falha);
    }

    const totais = somarComanda({
      itens: atual.itens,
      desconto: params.desconto ?? null,
      gorjetaCents: params.gorjetaCents ?? atual.gorjetaCents,
    });

    /**
     * O teto da barbearia, conferido **depois** de converter para centavos.
     *
     * É o único jeito de a conta valer para os dois tipos de desconto: 100% e
     * "R$ 500 numa conta de R$ 500" são a mesma coisa em centavos e coisas
     * diferentes no que foi digitado. Comparar antes deixaria o segundo passar.
     *
     * O teto vem do banco, não de uma constante: configuração de negócio é
     * dado. Uma barbearia que trabalha com pacote promocional muda o número na
     * tela de configurações e ninguém faz deploy.
     */
    if (totais.descontoCents > 0) {
      const teto = tetoDoDesconto(totais.subtotalCents, await tetoDaBarbearia(tx));
      if (totais.descontoCents > teto) {
        throw new ComandaError(
          'desconto_acima_do_teto',
          `O desconto máximo desta barbearia é ${reais(teto)}.`,
          'desconto_acima_do_teto',
        );
      }
    }

    await tx.$executeRaw`
      UPDATE orders SET
        discount_cents = ${totais.descontoCents},
        discount_reason = ${params.desconto?.motivo ?? null},
        tip_cents = ${totais.gorjetaCents},
        subtotal_cents = ${totais.subtotalCents},
        total_cents = ${totais.totalCents}
      WHERE id = ${params.orderId}::uuid
    `;

    // Só o desconto é auditado; gorjeta não é receita da casa e mudá-la não tira
    // dinheiro de ninguém. Registrar as duas encheria a trilha de linha sem
    // pergunta associada, que é como uma trilha deixa de ser lida.
    if (totais.descontoCents !== atual.descontoCents) {
      await audit(tx, {
        actorId: params.staffId,
        actorName: params.staffName,
        action: 'order.discount',
        entity: 'order',
        entityId: params.orderId,
        before: { descontoCents: atual.descontoCents, totalCents: atual.totalCents },
        after: {
          descontoCents: totais.descontoCents,
          totalCents: totais.totalCents,
          motivo: params.desconto?.motivo ?? null,
        },
      });
    }

    return carregar(tx, params.orderId);
  });
}

/**
 * Fecha a comanda: uma transação, cinco tabelas.
 *
 * O que acontece junto, ou não acontece:
 *
 * 1. a comanda vira `paid`, com os totais congelados;
 * 2. os pagamentos são gravados;
 * 3. o dinheiro entra na gaveta do caixa **aberto**;
 * 4. o fiado vira dívida no saldo do cliente;
 * 5. o extrato registra o porquê do saldo novo.
 *
 * Metade disso gravado é caixa que não bate com extrato que não bate com
 * dívida, e nenhum dos três diz qual está certo.
 *
 * **Sem caixa aberto não se fecha comanda.** Parece rigor, e é o contrário: a
 * venda precisa saber em qual gaveta entrou, senão a divergência do fechamento
 * não tem dono — que é a única coisa que o controle de caixa existe para dar.
 */
export async function fecharComanda(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly orderId: string;
  readonly pagamentos: readonly Pagamento[];
  readonly staffId: string;
  readonly staffName: string;
  readonly idempotencyKey?: string;
  /**
   * A data de hoje **no fuso da unidade**, para datar a comissão.
   *
   * Vem de quem chama e não de `now()` no banco: às 22h de Salvador o servidor
   * em UTC já virou o dia, e a comissão cairia no mês seguinte — no mês errado
   * do acerto do barbeiro (defeito D2, o mesmo que erra a grade).
   */
  readonly hojeNaUnidade: string;
  /**
   * A transação de fora, quando já existe uma.
   *
   * Existe por uma coisa só: o webhook do Pix (bloco 35). A SPEC §3.3 diz que a
   * confirmação **dispara em cadeia** — fecha comanda, registra no caixa, gera
   * comissão —, e essa cadeia tem que ser a mesma transação que marca a
   * cobrança como paga. Fora dela existiria a janela em que o adquirente
   * confirmou e a venda não fechou, e o dinheiro ficaria sem comanda.
   *
   * É o mesmo precedente de `anonimizarCliente` (bloco 32). Quem chama de uma
   * requisição normal não passa nada e ganha a transação própria.
   */
  readonly tx?: TransactionClient;
}): Promise<Comanda> {
  const dentro = async (tx: TransactionClient): Promise<Comanda> => {
    /**
     * Repetição do mesmo toque devolve a comanda paga, não um erro.
     *
     * A trava e o `AND status = 'open'` abaixo já impedem cobrar duas vezes —
     * o dinheiro está seguro sem isto. O que isto resolve é o que a pessoa vê:
     * sem a chave, o segundo toque no celular lento responde "esta comanda já
     * foi fechada", que soa como falha para uma operação que deu certo.
     */
    if (params.idempotencyKey) {
      const anterior = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM orders
         WHERE close_idempotency_key = ${params.idempotencyKey}
      `;
      const jaCobrada = anterior[0];
      if (jaCobrada) return carregar(tx, jaCobrada.id);
    }

    const comanda = await exigirAberta(tx, params.orderId, true);
    /**
     * O fechamento manual também respeita a cobrança viva — achado HIGH.
     *
     * A tela oferecia "Receber" logo abaixo do QR Code, e fechar por ali com um
     * Pix em aberto era o caminho para: a confirmação subir exceção, o webhook
     * responder 500 pelo tempo que a Stripe reentregasse, e a varredura da
     * barbearia inteira parar no meio do laço. Quando a própria confirmação
     * chama daqui, a cobrança já está `pago` **e** a comanda ainda `open`, e é
     * por isso que ela passa: a guarda só barra o que ainda não fechou.
     */
    if (!params.tx) await exigirSemCobrancaViva(tx, params.orderId);

    /**
     * O saldo do cliente é relido **sob trava**, e não aproveitado da leitura
     * anterior.
     *
     * O limite de fiado é a única coisa entre a barbearia e crédito sem fim, e
     * conferi-lo contra um saldo lido antes de travar deixa duas comandas
     * fechadas ao mesmo tempo passarem as duas — cada uma vendo a dívida de
     * antes da outra, e a soma estourando o limite.
     */
    const conta = comanda.customerId
      ? await saldoTravado(tx, comanda.customerId)
      : null;

    const conferido = conferirPagamento({
      totalCents: comanda.totalCents,
      pagamentos: params.pagamentos,
      conta,
    });
    if (conferido.falha) {
      throw new ComandaError('pagamento_invalido', 'Pagamento inválido.', conferido.falha);
    }

    const sessoes = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM cash_sessions
       WHERE location_id = ${params.locationId}::uuid AND status = 'open'
       FOR UPDATE
    `;
    const sessao = sessoes[0];
    if (!sessao) {
      throw new ComandaError(
        'caixa_fechado',
        'Não há caixa aberto. Abra o caixa antes de fechar uma comanda.',
      );
    }

    // `AND status = 'open'` mesmo com a trava acima: é a garantia que não
    // depende de ninguém ter lembrado de travar. Zero linhas significa que
    // outra transação fechou primeiro.
    /**
     * A taxa do adquirente, congelada aqui (bloco 36).
     *
     * Calculada no fechamento e gravada, como o preço do serviço e a regra de
     * comissão: renegociar a maquininha em maio não pode mudar a comissão que
     * já foi paga em abril. Alíquota ausente é zero, e a barbearia cadastra só
     * o que paga.
     */
    const aliquotas = await tx.$queryRaw<{ method: string; bps: number }[]>`
      SELECT method::text, bps FROM acquirer_fees
    `;
    const taxaCents = taxaDaVenda({
      pagamentos: params.pagamentos,
      aliquotasBps: new Map(aliquotas.map((a) => [a.method, a.bps])),
      // O troco sai da base: cobrar tarifa sobre o que voltou para o bolso do
      // cliente seria cobrar de dinheiro que nunca ficou com a barbearia.
      trocoCents: conferido.trocoCents,
    });

    const fechadas = await tx.$executeRaw`
      UPDATE orders SET
        status = 'paid', closed_at = now(), fee_cents = ${taxaCents},
        session_id = ${sessao.id}::uuid,
        change_cents = ${conferido.trocoCents},
        business_day = ${params.hojeNaUnidade}::date,
        close_idempotency_key = ${params.idempotencyKey ?? null}
      WHERE id = ${params.orderId}::uuid AND status = 'open'
    `;
    if (fechadas === 0) {
      throw new ComandaError('comanda_fechada', 'Esta comanda já foi fechada.');
    }

    for (const pagamento of params.pagamentos) {
      await tx.$executeRaw`
        INSERT INTO order_payments (tenant_id, order_id, method, amount_cents)
        VALUES (
          NULLIF(current_setting('app.tenant_id', true), '')::uuid,
          ${params.orderId}::uuid, ${pagamento.forma}::payment_method, ${pagamento.valorCents}
        )
      `;
    }

    const naGaveta = entraNaGaveta({
      pagamentos: params.pagamentos,
      trocoCents: conferido.trocoCents,
    });
    if (naGaveta > 0) {
      await tx.$executeRaw`
        INSERT INTO cash_movements
          (tenant_id, session_id, kind, amount_cents, reason, order_id,
           created_by, created_by_name)
        VALUES (
          NULLIF(current_setting('app.tenant_id', true), '')::uuid,
          ${sessao.id}::uuid, 'sale', ${naGaveta}, 'Venda',
          ${params.orderId}::uuid, ${params.staffId}::uuid, ${params.staffName}
        )
      `;
    }

    const resultado = resultadoDoPagamento({
      pagamentos: params.pagamentos,
      trocoCents: conferido.trocoCents,
    });

    if (resultado.aReceberCents > 0 && comanda.customerId) {
      await lancarNoExtrato(tx, {
        customerId: comanda.customerId,
        kind: 'fiado',
        // Negativo aumenta a dívida — mesmo sinal do saldo.
        amountCents: -resultado.aReceberCents,
        orderId: params.orderId,
        sessionId: sessao.id,
        note: 'Fiado na comanda',
        staffId: params.staffId,
        staffName: params.staffName,
      });
    }

    /**
     * A comissão nasce **na mesma transação** que fecha a venda.
     *
     * Fora dela existiria a janela em que a venda aconteceu e a comissão não —
     * e ela apareceria como dinheiro faltando no acerto do barbeiro, sem nada
     * dizendo por quê. Item sem profissional ou sem regra simplesmente não
     * gera lançamento; a tela de comissão lista quem ficou de fora.
     */
    await lancarComissaoDaComanda(tx, {
      orderId: params.orderId,
      quandoISO: params.hojeNaUnidade,
    });

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'order.closed',
      entity: 'order',
      entityId: params.orderId,
      after: {
        totalCents: comanda.totalCents,
        trocoCents: conferido.trocoCents,
        fiadoCents: resultado.aReceberCents,
        formas: params.pagamentos.map((p) => p.forma),
      },
    });

    return carregar(tx, params.orderId);
  };

  return params.tx ? dentro(params.tx) : withTenant(params.tenantId, dentro);
}

/**
 * Lança no extrato e move o saldo, sempre juntos.
 *
 * `customers.balance_cents` é o acumulado; `customer_ledger` é o porquê dele.
 * Mover um sem o outro produz um saldo que ninguém consegue justificar no
 * balcão — e a primeira discussão sobre "quanto eu devo" não tem como terminar.
 *
 * O `balance_after_cents` é gravado junto de propósito: refazer a conta somando
 * o extrato inteiro daria outro número no dia em que uma linha fosse corrigida,
 * e o extrato é append-only justamente para que isso nunca aconteça.
 */
async function lancarNoExtrato(
  tx: TransactionClient,
  params: {
    readonly customerId: string;
    readonly kind: 'fiado' | 'payment' | 'credit' | 'adjustment';
    readonly amountCents: number;
    readonly orderId?: string | null;
    readonly sessionId?: string | null;
    readonly note: string;
    readonly staffId: string;
    readonly staffName: string;
  },
): Promise<number> {
  const atualizados = await tx.$queryRaw<{ balance_cents: number }[]>`
    UPDATE customers
       SET balance_cents = balance_cents + ${params.amountCents}
     WHERE id = ${params.customerId}::uuid
    RETURNING balance_cents
  `;
  const saldo = atualizados[0]?.balance_cents;
  if (saldo === undefined) {
    throw new ComandaError('cliente_nao_encontrado', 'Cliente não encontrado.');
  }

  await tx.$executeRaw`
    INSERT INTO customer_ledger
      (tenant_id, customer_id, kind, amount_cents, balance_after_cents,
       order_id, session_id, note, created_by, created_by_name)
    VALUES (
      NULLIF(current_setting('app.tenant_id', true), '')::uuid,
      ${params.customerId}::uuid, ${params.kind}::customer_ledger_kind,
      ${params.amountCents}, ${saldo},
      ${params.orderId ?? null}::uuid, ${params.sessionId ?? null}::uuid,
      ${params.note}, ${params.staffId}::uuid, ${params.staffName}
    )
  `;

  return saldo;
}

/**
 * O cliente voltou e pagou o que devia.
 *
 * Este é o momento em que fiado vira dinheiro — e por isso entra na gaveta como
 * `debt_payment`, separado de `sale`. Somar aos dois no mesmo balde faria o
 * faturamento do dia contar duas vezes: uma quando o corte foi fiado e outra
 * quando ele foi pago.
 */
export async function receberFiado(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly customerId: string;
  readonly amountCents: number;
  readonly forma: FormaDePagamento;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<{ readonly saldoCents: number }> {
  if (!Number.isInteger(params.amountCents) || params.amountCents <= 0) {
    throw new ComandaError('pagamento_invalido', 'Informe um valor maior que zero.');
  }
  if (params.forma === 'fiado') {
    // Pagar fiado com fiado é rolar a dívida sem que nada aconteça, e o extrato
    // ficaria com duas linhas que se anulam.
    throw new ComandaError('pagamento_invalido', 'Não se paga fiado com fiado.');
  }

  return withTenant(params.tenantId, async (tx) => {
    const cliente = await saldoTravado(tx, params.customerId);
    if (cliente.saldoCents >= 0) {
      throw new ComandaError('pagamento_invalido', 'Este cliente não tem dívida em aberto.');
    }
    if (params.amountCents > -cliente.saldoCents) {
      throw new ComandaError(
        'pagamento_invalido',
        'O valor é maior que a dívida. Receber a mais viraria crédito não combinado.',
      );
    }

    const sessoes = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM cash_sessions
       WHERE location_id = ${params.locationId}::uuid AND status = 'open'
       FOR UPDATE
    `;
    const sessao = sessoes[0];
    if (!sessao) {
      throw new ComandaError('caixa_fechado', 'Abra o caixa antes de receber.');
    }

    const saldo = await lancarNoExtrato(tx, {
      customerId: params.customerId,
      kind: 'payment',
      amountCents: params.amountCents,
      sessionId: sessao.id,
      note: `Pagamento de dívida (${params.forma})`,
      staffId: params.staffId,
      staffName: params.staffName,
    });

    if (params.forma === 'cash') {
      await tx.$executeRaw`
        INSERT INTO cash_movements
          (tenant_id, session_id, kind, amount_cents, reason, created_by, created_by_name)
        VALUES (
          NULLIF(current_setting('app.tenant_id', true), '')::uuid,
          ${sessao.id}::uuid, 'debt_payment', ${params.amountCents},
          'Pagamento de fiado', ${params.staffId}::uuid, ${params.staffName}
        )
      `;
    }

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'debt.received',
      entity: 'customer',
      entityId: params.customerId,
      before: { saldoCents: cliente.saldoCents },
      after: { saldoCents: saldo, amountCents: params.amountCents, forma: params.forma },
    });

    return { saldoCents: saldo };
  });
}

/** Quem está devendo, para a tela de cobrança. */
export async function quemEstaDevendo(
  tenantId: string,
): Promise<readonly { readonly id: string; readonly name: string; readonly saldoCents: number }[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ id: string; name: string; balance_cents: number }[]>`
      SELECT id, name, balance_cents FROM customers
       WHERE balance_cents < 0
       ORDER BY balance_cents
       LIMIT 100
    `;
    return linhas.map((l) => ({ id: l.id, name: l.name, saldoCents: l.balance_cents }));
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

    const formas = porForma.map((f) => ({ forma: f.method, valorCents: Number(f.total) }));
    const fiadoCents = formas
      .filter((f) => f.forma === 'fiado')
      .reduce((soma, f) => soma + f.valorCents, 0);
    const bruto = formas
      .filter((f) => f.forma !== 'fiado')
      .reduce((soma, f) => soma + f.valorCents, 0);

    return {
      recebidoCents: bruto - Number(resumo[0]?.troco ?? 0),
      fiadoCents,
      gorjetaCents: Number(resumo[0]?.gorjeta ?? 0),
      porForma: formas,
      comandas: Number(resumo[0]?.comandas ?? 0),
    };
  });
}
