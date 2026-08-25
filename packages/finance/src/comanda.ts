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
import { registrarEventoDeWebhook } from '@barbearia/jobs';
import { lancarComissaoDaComanda } from './comissao.js';
import { conferirResgate, creditarDaVenda, programaDaCasa, registrarResgate } from './fidelidade.js';
import { consumirPacote, consumoDisponivel, venderPacote } from './pacote.js';
import { baixarVendas, consumirFicha } from './estoque.js';
import { consumirAssinatura, usoDisponivel } from './assinatura.js';
import { pedirNota } from './fiscal.js';
import { ComandaError, type Comanda } from './comanda-tipos.js';
import {
  exigirPacoteSemDescontoGeral,
  fingerprintDoFechamento,
  recusarDescontoEmVendaDePacote,
} from './comanda-fechamento.js';
import { carregarComanda as carregar } from './comanda-leitura.js';
import { saldoTravado, lancarNoExtrato } from './comanda-fiado.js';
import { itensDePacoteDaComanda, snapshotDePacoteAtivo, type SnapshotDePacote } from './comanda-pacote.js';

export { lancarNoExtrato, receberFiado } from './comanda-fiado.js';

export * from './comanda-tipos.js';
export { getComanda, comandasAbertas, quemEstaDevendo, faturamentoDoDia } from './comanda-leitura.js';
export type { ComandaAberta, Devedor, QuemEstaDevendo } from './comanda-leitura.js';

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

/**
 * Cancelar uma comanda aberta.
 *
 * `order_status` tem `cancelled` desde a migração 0018 e **nada no produto o
 * escrevia**: o estado existia no enum, no tipo do domínio e em nenhum caminho.
 * Uma comanda aberta por engano — e o botão fica a um clique, dentro de um
 * `details` na tela de cobrar — só saía de `open` sendo paga, e uma comanda
 * vazia não fecha, porque o fechamento exige pelo menos uma forma de pagamento.
 * Era linha presa para sempre, alcançável sem erro nenhum de operação.
 *
 * Não mexe em estoque nem em comissão, e é por construção: os dois acontecem no
 * **fechamento** (`baixarVendas`, `lancarComissoes`). Comanda aberta com itens
 * ainda não tirou nada da prateleira.
 *
 * A cobrança viva barra o cancelamento pelo motivo de sempre: o cliente está
 * com o código do Pix na mão, e o caminho explícito é cancelar a cobrança
 * antes. É a mesma guarda que já protege item, remoção e desconto.
 *
 * O atendimento volta a ser cobrável sozinho — `comandaAbertaDoAtendimento` não
 * acha mais nenhuma, e o botão "Cobrar" reaparece na lista do dia.
 */
export async function cancelarComanda(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly orderId: string;
  readonly ator: { readonly id: string; readonly name: string };
}): Promise<{ readonly cancelada: true }> {
  return withTenant(params.tenantId, async (tx) => {
    const comanda = await exigirAberta(tx, params.orderId, params.locationId, true);
    await exigirSemCobrancaViva(tx, params.orderId);

    /**
     * O estado no `WHERE`, com a contagem conferida: é ele que barra o segundo
     * toque de outro aparelho, e não a trava — que cai no commit.
     */
    const canceladas = await tx.$executeRaw`
      UPDATE orders
         SET status = 'cancelled', closed_at = now()
       WHERE id = ${params.orderId}::uuid AND status = 'open'
    `;
    if (canceladas === 0) {
      throw new ComandaError('comanda_fechada', 'Esta comanda já foi fechada.');
    }

    await audit(tx, {
      actorId: params.ator.id,
      actorName: params.ator.name,
      action: 'order.cancelled',
      entity: 'orders',
      entityId: params.orderId,
      // A **contagem** e o total, nunca a descrição dos itens: a trilha é
      // append-only e a anonimização não a alcança.
      before: { itens: comanda.itens.length, totalCents: comanda.totalCents },
    });

    return { cancelada: true as const };
  });
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
 *
 * ## Abrir duas vezes devolve a mesma comanda, e isso é a regra
 *
 * `orders_uma_aberta_por_agendamento` diz desde o bloco 18 que um atendimento
 * tem **uma** comanda aberta. O que faltava era a outra metade: quem pedisse a
 * segunda recebia violação de unicidade — um 500 genérico, e a tela do balcão
 * respondia "não deu para abrir, tente de novo" para sempre, porque tentar de
 * novo dava exatamente o mesmo erro. A comanda existia e não havia caminho até
 * ela pela tela.
 *
 * Não é caso raro: o balcão abre a comanda quando o corte começa, some para
 * atender o telefone e volta pela lista de "Cobrar" — que mostra a mesma pessoa
 * com o mesmo botão. Duas recepcionistas no mesmo notebook fazem isso o dia
 * inteiro.
 *
 * A chave de idempotência **não** cobre isto: ela é por operador e por
 * requisição, então dois cliques em telas diferentes trazem chaves diferentes.
 * O que identifica a comanda aqui é o atendimento, e é ele que o índice já
 * declarava.
 */
export async function abrirComanda(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly appointmentId?: string | null;
  readonly customerId?: string | null;
  readonly staffId: string;
  readonly idempotencyKey?: string;
}): Promise<Comanda> {
  try {
    return await inserirComanda(params);
  } catch (erro) {
    // Corrida: duas requisições passaram juntas pela consulta e a segunda
    // esbarrou no índice. A transação já morreu no Postgres, então a leitura
    // tem que ser numa nova — e se não achar nada, o erro não era este.
    if (!params.appointmentId || pgCode(erro) !== UNIQUE_VIOLATION) throw erro;
    const existente = await withTenant(params.tenantId, (tx) =>
      comandaAbertaDoAtendimento(tx, params.appointmentId as string),
    );
    if (!existente) throw erro;
    return existente;
  }
}

const UNIQUE_VIOLATION = '23505';

/**
 * O SQLSTATE do Postgres dentro do erro do Prisma.
 *
 * Consulta crua falha como `PrismaClientKnownRequestError` com `code: 'P2010'`
 * — o código do Prisma, não o do banco. O SQLSTATE real fica em `meta.code`, e
 * como último recurso no texto da mensagem.
 */
function pgCode(erro: unknown): string | null {
  const meta = (erro as { meta?: { code?: unknown } })?.meta;
  if (typeof meta?.code === 'string') return meta.code;

  const code = (erro as { code?: unknown })?.code;
  if (typeof code === 'string' && !/^P\d+$/.test(code)) return code;

  return /Code: `(\w+)`/.exec(erro instanceof Error ? erro.message : '')?.[1] ?? null;
}

async function comandaAbertaDoAtendimento(
  tx: TransactionClient,
  appointmentId: string,
): Promise<Comanda | null> {
  const abertas = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM orders
     WHERE appointment_id = ${appointmentId}::uuid
       AND status = 'open'
  `;
  const aberta = abertas[0];
  return aberta ? carregar(tx, aberta.id, null) : null;
}

async function inserirComanda(params: {
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
      if (jaExiste) return carregar(tx, jaExiste.id, params.locationId);
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

      // Depois de conferir o atendimento sob RLS, nunca antes: id inexistente
      // ou de outra barbearia continua respondendo "não encontrado", em vez de
      // virar uma consulta que não acha nada e segue para o INSERT.
      const jaAberta = await comandaAbertaDoAtendimento(tx, params.appointmentId);
      if (jaAberta) return jaAberta;

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
    return carregar(tx, id, params.locationId);
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
  const comanda = await carregar(tx, orderId, null);

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
     WHERE order_id = ${orderId}::uuid
       AND status IN ('aguardando', 'pago')
       AND refunded_at IS NULL
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

/**
 * A comanda desta loja, aberta — a porta única de toda escrita sobre `orders`.
 *
 * ## `locationId` é obrigatório, e é o conserto
 *
 * A RLS separa barbearias e **não** separa lojas dentro de uma. Esta função
 * lia `WHERE id = $1` e nada mais, e por ela passam acrescentar item, remover
 * item, dar desconto e **fechar**: a gerente escopada à filial fechava a
 * comanda da matriz mandando o id por `curl`, e o dinheiro caía na gaveta da
 * filial com `orders.location_id` continuando matriz.
 *
 * O sintoma não é abstrato: o caixa da matriz fecha faltando, o da filial
 * sobrando, e nenhuma das duas telas explica. É a única coisa que a exigência
 * de caixa aberto desde o bloco 18 existe para dar — a divergência do
 * fechamento ter dono.
 *
 * Pelo Pix acontece **sem ninguém clicar**: o webhook confirma e o fechamento
 * roda com o `locationId` da linha de cobrança.
 *
 * O parâmetro é obrigatório de propósito. Opcional, ele nasceria ausente na
 * primeira rota nova e o buraco voltaria sem nada ficar vermelho — é o defeito
 * de `blocks`, e este arquivo é o lugar mais caro do produto para repeti-lo.
 *
 * A recusa usa a **mesma mensagem** de comanda inexistente: "existe, mas não é
 * sua" confirma o id para quem o adivinhou.
 */
async function exigirAberta(
  tx: TransactionClient,
  orderId: string,
  locationId: string,
  travar = false,
): Promise<Comanda> {
  if (travar) {
    // Só a chave: `carregar` faz JOIN com `customers` e `professionals`, e
    // `FOR UPDATE` sobre junção travaria linha que não é desta operação.
    const travadas = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM orders
       WHERE id = ${orderId}::uuid
         AND location_id = ${locationId}::uuid
       FOR UPDATE
    `;
    if (!travadas[0]) {
      throw new ComandaError('comanda_nao_encontrada', 'Esta comanda não existe mais.');
    }
  }

  const comanda = await carregar(tx, orderId, locationId);
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
  /**
   * O pacote do catálogo que este item vende (bloco 42).
   *
   * É ele que faz a venda do pacote e o preço cobrado serem o mesmo dado: o
   * fechamento deriva daqui quem foi vendido, em vez de receber uma lista que
   * pode discordar do que a comanda cobrou.
   */
  readonly packageId?: string | null;
  /**
   * O produto do catálogo que este item vende (bloco 44).
   *
   * Mesma decisão de `packageId`: é ele que faz a venda e a baixa de estoque
   * serem o mesmo dado, e o preço vem do cadastro — não do corpo.
   */
  readonly productId?: string | null;
  /**
   * Chave do gesto da tela. O mesmo POST pode chegar de novo se a gravação
   * confirmar e a resposta cair no caminho de volta.
   */
  readonly idempotencyKey?: string;
}): Promise<Comanda> {
  return withTenant(params.tenantId, async (tx) => {
    const fingerprint = JSON.stringify([
      params.tipo,
      params.serviceId ?? null,
      params.descricao.trim(),
      params.quantidade,
      params.precoUnitarioCents,
      params.professionalId ?? null,
      params.packageId ?? null,
      params.productId ?? null,
    ]);

    if (params.idempotencyKey) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${params.tenantId}:${params.orderId}:${params.idempotencyKey}`}, 0))`;
      const anteriores = await tx.$queryRaw<{ idempotency_fingerprint: string | null }[]>`
        SELECT oi.idempotency_fingerprint
          FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
         WHERE oi.order_id = ${params.orderId}::uuid
           AND o.location_id = ${params.locationId}::uuid
           AND oi.idempotency_key = ${params.idempotencyKey}
         LIMIT 1
      `;
      const anterior = anteriores[0];
      if (anterior) {
        if (anterior.idempotency_fingerprint && anterior.idempotency_fingerprint !== fingerprint) {
          throw new ComandaError('idempotencia_conflitante', 'Esta tentativa já foi usada para outro item.');
        }
        return carregar(tx, params.orderId, params.locationId);
      }
    }

    const comandaAberta = await exigirAberta(tx, params.orderId, params.locationId, true);
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
    /**
     * O preço do pacote sai do **catálogo**, não do corpo da requisição.
     *
     * Ele é a base de `unit_value_cents` na venda: aceitar o preço da tela faria
     * um item de R$ 1 congelar cinco unidades de R$ 50, que é dinheiro criado do
     * nada. Como todo id vindo de fora, o pacote é conferido sob RLS — a chave
     * estrangeira do Postgres ignora row security.
     */
    let precoCents = params.precoUnitarioCents;
    let snapshotDoPacote: SnapshotDePacote | null = null;
    if (params.packageId) {
      recusarDescontoEmVendaDePacote(comandaAberta.descontoCents);
      if (params.tipo !== 'package') {
        throw new ComandaError('item_invalido', 'Item inválido.', 'tipo');
      }
      snapshotDoPacote = await snapshotDePacoteAtivo(tx, params.packageId);
      precoCents = snapshotDoPacote.priceCents;
    } else if (params.tipo === 'package') {
      // Item de pacote sem pacote é um item que ninguém sabe o que vende — e o
      // `CHECK` da migração recusaria o contrário.
      throw new ComandaError('item_invalido', 'Item inválido.', 'tipo');
    }

    /**
     * O preço do produto sai do **catálogo**, como o do pacote.
     *
     * Aceitar o do corpo faria a pomada de R$ 35 ser vendida por R$ 1 com o
     * estoque baixando um vidro de verdade — desconto sem passar pelo teto da
     * casa, e CMV negativo no relatório.
     *
     * Só `resale` entra: um item apontando para shampoo de uso interno venderia
     * ao cliente o que a casa usa no serviço, e baixaria duas vezes o mesmo
     * frasco.
     */
    if (params.productId) {
      const produto = await tx.$queryRaw<{ price_cents: number | null }[]>`
        SELECT price_cents FROM products
         WHERE id = ${params.productId}::uuid AND active AND kind = 'resale'
      `;
      const achado = produto[0];
      if (!achado || achado.price_cents === null) {
        throw new ComandaError('servico_desconhecido', 'Produto não encontrado.');
      }
      precoCents = achado.price_cents;
    }

    await tx.$executeRaw`
      INSERT INTO order_items
        (tenant_id, order_id, kind, service_id, package_id, product_id, description, quantity,
         unit_price_cents, professional_id, position, idempotency_key, idempotency_fingerprint,
         package_snapshot_service_id, package_snapshot_quantity,
         package_snapshot_validity_days, package_snapshot_transferable)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${params.orderId}::uuid, ${params.tipo}::order_item_type,
        ${params.serviceId ?? null}::uuid, ${params.packageId ?? null}::uuid,
        ${params.productId ?? null}::uuid, ${params.descricao.trim()},
        ${params.quantidade}, ${precoCents},
        ${params.professionalId ?? null}::uuid,
        (SELECT COALESCE(max(position) + 1, 0) FROM order_items WHERE order_id = ${params.orderId}::uuid),
        ${params.idempotencyKey ?? null}, ${params.idempotencyKey ? fingerprint : null},
        ${snapshotDoPacote?.serviceId ?? null}::uuid,
        ${snapshotDoPacote?.quantity ?? null},
        ${snapshotDoPacote?.validityDays ?? null},
        ${snapshotDoPacote?.transferable ?? null}
      )
    `;

    await recalcular(tx, params.orderId);
    return carregar(tx, params.orderId, null);
  });
}

/**
 * Tira um item da comanda.
 *
 * ## Por que a remoção é auditada, e a inclusão não
 *
 * O balcão precifica a linha livremente, e isso é capacidade do produto, não
 * furo: a "cortesia" e o "serviço avulso" são a mesma linha de texto livre com
 * preço livre, e é assim que a tela a oferece. `max_discount_bps` limita o
 * **gesto de desconto**, que é outra coisa — abrir mão de receita sobre um
 * total que já existe.
 *
 * O que não tinha resposta era a pergunta do dia seguinte: *"quem tirou o corte
 * de R$ 49 da comanda do Carlos?"*. A comanda nasce pré-preenchida do
 * agendamento, com o preço congelado na reserva; removida a linha e digitada
 * outra por R$ 1,00, o resultado é aritmeticamente um desconto de 98% — e a
 * única marca que ficava era um `order.closed` de R$ 1,00, indistinguível de
 * uma venda legítima de R$ 1,00.
 *
 * A trilha é a resposta proporcional. Ela não impede a operação legítima —
 * cliente desistiu da barba, item digitado errado —, e dá dono à divergência.
 * Guarda o valor e **se a linha vendia catálogo**: a que carrega `service_id`
 * veio do agendamento ou do cadastro, e é a que interessa.
 */
export async function removerItem(params: {
  readonly tenantId: string;
  /** A loja do balcão. A comanda de outra loja é recusada como inexistente. */
  readonly locationId: string;
  readonly orderId: string;
  readonly itemId: string;
  readonly ator?: { readonly id: string; readonly name: string };
}): Promise<Comanda> {
  return withTenant(params.tenantId, async (tx) => {
    await exigirAberta(tx, params.orderId, params.locationId, true);
    await exigirSemCobrancaViva(tx, params.orderId);

    const alvo = await tx.$queryRaw<
      { description: string; unit_price_cents: number; quantity: number; service_id: string | null }[]
    >`
      SELECT description, unit_price_cents, quantity, service_id
        FROM order_items
       WHERE id = ${params.itemId}::uuid AND order_id = ${params.orderId}::uuid
    `;

    const removidas = await tx.$executeRaw`
      DELETE FROM order_items
       WHERE id = ${params.itemId}::uuid AND order_id = ${params.orderId}::uuid
    `;

    const item = alvo[0];
    // A contagem conferida: sem ela, o segundo toque gravaria trilha de uma
    // remoção que não aconteceu.
    if (removidas > 0 && item && params.ator) {
      await audit(tx, {
        actorId: params.ator.id,
        actorName: params.ator.name,
        action: 'order.item_removed',
        entity: 'orders',
        entityId: params.orderId,
        before: {
          descricao: item.description,
          valorCents: item.unit_price_cents * item.quantity,
          doCatalogo: item.service_id !== null,
        },
      });
    }

    await recalcular(tx, params.orderId);
    return carregar(tx, params.orderId, null);
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
  /** A loja do balcão. A comanda de outra loja é recusada como inexistente. */
  readonly locationId: string;
  readonly orderId: string;
  readonly desconto?: DescontoDaComanda | null;
  readonly gorjetaCents?: number;
  /**
   * De quem é a gorjeta (SPEC §3.6, bloco 124).
   *
   * `undefined` é "não mexa", como todo campo opcional desta borda. `null` é a
   * escolha explícita de **ratear entre quem atendeu**, que é o padrão e o caso
   * comum; um id é o cliente tendo dito a quem.
   */
  readonly gorjetaProfessionalId?: string | null;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<Comanda> {
  return withTenant(params.tenantId, async (tx) => {
    const atual = await exigirAberta(tx, params.orderId, params.locationId, true);
    await exigirSemCobrancaViva(tx, params.orderId);

    if (params.desconto) {
      const falha = validarDesconto(params.desconto);
      if (falha) throw new ComandaError('desconto_invalido', 'Desconto inválido.', falha);
    }

    /**
     * O dono da gorjeta é conferido **sob RLS antes de gravar**.
     *
     * A checagem de integridade referencial do Postgres roda com os direitos do
     * dono da tabela e ignora row security: a chave estrangeira aceitaria o id
     * de um profissional de outra barbearia sem reclamar, e o repasse ficaria
     * pendurado em quem não trabalha aqui.
     *
     * Pela **loja** e não só pelo tenant: a RLS separa barbearias e não separa
     * lojas dentro de uma, então sem este filtro o gerente da filial repassaria
     * a gorjeta a um barbeiro da matriz. Foi a guarda `id-com-unidade` do bloco
     * 117 que cobrou, na primeira versão desta consulta.
     */
    if (params.gorjetaProfessionalId) {
      const encontrados = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM professionals
         WHERE id = ${params.gorjetaProfessionalId}::uuid
           AND location_id = ${params.locationId}::uuid
           AND active
      `;
      if (!encontrados[0]) {
        throw new ComandaError(
          'profissional_desconhecido',
          'Este profissional não existe mais nesta barbearia.',
        );
      }
    }

    const totais = somarComanda({
      itens: atual.itens,
      desconto: params.desconto ?? null,
      gorjetaCents: params.gorjetaCents ?? atual.gorjetaCents,
    });

    await exigirPacoteSemDescontoGeral(tx, params.orderId, totais.descontoCents);

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
        -- Campo ausente significa "nao mexa", nunca "desligue": escrever o
        -- padrao por omissao faria corrigir um desconto apagar em silencio a
        -- escolha de quem recebe a gorjeta.
        tip_professional_id = CASE WHEN ${params.gorjetaProfessionalId !== undefined}
                                   THEN ${params.gorjetaProfessionalId ?? null}::uuid
                                   ELSE tip_professional_id END,
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

    return carregar(tx, params.orderId, null);
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
   * Quantos pontos, visitas ou centavos o cliente está resgatando (bloco 41).
   *
   * Vem separado do pagamento porque a **unidade** é outra: o pagamento diz
   * quantos centavos abateram da conta; isto diz quanto saiu do saldo. Em
   * `visitas` os dois nem se parecem — dez visitas viram a conta inteira.
   */
  readonly resgateQuantidade?: number;
  /**
   * Qual serviço o pacote está cobrindo, quando há pagamento por pacote
   * (bloco 42).
   *
   * Vem separado do pagamento porque a forma diz "quitou pelo pacote" e isto diz
   * **qual** unidade some — a comanda com corte e barba precisa de alguém para
   * desempatar. É conferido contra os itens da própria comanda: sem isso, uma
   * barba de R$ 50 queimaria uma unidade do pacote de corte, e o cliente perderia
   * um corte pago sem nada ficar vermelho.
   *
   * Não existe par `pacotesVendidos`: quem foi vendido é derivado dos itens de
   * pacote da comanda, que são os que carregam o preço cobrado.
   */
  readonly servicoDoPacote?: string;
  /**
   * Qual serviço a assinatura está cobrindo, quando há pagamento por assinatura
   * (bloco 45).
   *
   * Separado do pagamento pela mesma razão do pacote: a forma diz "quitou pelo
   * plano", isto diz **qual** cota some. O domínio confere que o serviço está
   * nesta comanda, que o plano o cobre, e que a cota e o cooldown permitem.
   */
  readonly servicoDaAssinatura?: string;
  /**
   * O instante do fechamento, para o que depende de janela de tempo.
   *
   * O ciclo da assinatura é ancorado no dia da adesão, e o uso precisa cair
   * **dentro** dele. Com `new Date()` fixo aqui dentro, o teste que congela o
   * relógio grava o uso fora do ciclo que ele mesmo montou — e o produto ficaria
   * sem prova de que a cota conta. Relógio entra por parâmetro; a ausência
   * continua sendo agora.
   */
  readonly agora?: Date;
  /**
   * O dia da semana e o minuto **locais** do atendimento, para a restrição de
   * horário do plano (bloco 46).
   *
   * Da unidade, nunca do aparelho. Ausente significa "não confira": é o caso do
   * balcão fechando o que já aconteceu, e barrar ali seria punir o cliente por um
   * horário que a própria casa concedeu.
   */
  readonly quandoLocal?: { readonly diaDaSemana: number; readonly minuto: number };
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
    const fingerprintDaIntencao = fingerprintDoFechamento({
      orderId: params.orderId,
      pagamentos: params.pagamentos,
      ...(params.resgateQuantidade !== undefined ? { resgateQuantidade: params.resgateQuantidade } : {}),
      ...(params.servicoDoPacote !== undefined ? { servicoDoPacote: params.servicoDoPacote } : {}),
      ...(params.servicoDaAssinatura !== undefined ? { servicoDaAssinatura: params.servicoDaAssinatura } : {}),
    });

    /**
     * Repetição do mesmo toque devolve a comanda paga, não um erro.
     *
     * A trava e o `AND status = 'open'` abaixo já impedem cobrar duas vezes —
     * o dinheiro está seguro sem isto. O que isto resolve é o que a pessoa vê:
     * sem a chave, o segundo toque no celular lento responde "esta comanda já
     * foi fechada", que soa como falha para uma operação que deu certo.
     */
    if (params.idempotencyKey) {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${`${params.tenantId}:${params.locationId}:fechar:${params.idempotencyKey}`}, 0)
        )
      `;
      const anterior = await tx.$queryRaw<
        { id: string; close_idempotency_fingerprint: string | null }[]
      >`
        SELECT id, close_idempotency_fingerprint FROM orders
         WHERE location_id = ${params.locationId}::uuid
           AND close_idempotency_key = ${params.idempotencyKey}
      `;
      const jaCobrada = anterior[0];
      if (jaCobrada) {
        // Linhas anteriores à migração 0111 não têm fingerprint. Nesse caso só
        // aceitamos replay para a própria comanda; a chave jamais pode apontar
        // silenciosamente para outra venda.
        if (
          (jaCobrada.close_idempotency_fingerprint !== null &&
            jaCobrada.close_idempotency_fingerprint !== fingerprintDaIntencao) ||
          (jaCobrada.close_idempotency_fingerprint === null && jaCobrada.id !== params.orderId)
        ) {
          throw new ComandaError(
            'idempotencia_conflitante',
            'Esta tentativa de fechamento já foi usada para outra cobrança.',
          );
        }
        return carregar(tx, jaCobrada.id, params.locationId);
      }
    }

    const comanda = await exigirAberta(tx, params.orderId, params.locationId, true);

    await exigirPacoteSemDescontoGeral(tx, params.orderId, comanda.descontoCents);

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
      ? await saldoTravado(tx, comanda.customerId, params.locationId)
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
        close_idempotency_key = ${params.idempotencyKey ?? null},
        close_idempotency_fingerprint = ${params.idempotencyKey ? fingerprintDaIntencao : null}
      WHERE id = ${params.orderId}::uuid AND status = 'open'
    `;
    if (fechadas === 0) {
      throw new ComandaError('comanda_fechada', 'Esta comanda já foi fechada.');
    }

    /**
     * O webhook da venda paga (bloco 112).
     *
     * `order.paid` estava no catálogo, na tela e no banco, e nenhum ponto do
     * produto o emitia: o contador marcava a caixa, salvava, e o ERP dele nunca
     * recebia um aviso — sem erro, sem entrega falhada, sem linha no histórico.
     *
     * Aqui e não depois do commit, como todo trabalho fora de requisição neste
     * produto. E **nunca** com exceção: `fecharComanda` roda na transação do
     * webhook do Pix, e uma exceção aqui voltaria atrás com o dinheiro sem
     * registro nenhum. `registrarEventoDeWebhook` não lança — sem endpoint
     * inscrito ela não faz nada e não custa nada além da própria consulta.
     */
    await registrarEventoDeWebhook(tx, {
      evento: 'order.paid',
      objetoId: params.orderId,
      locationId: params.locationId,
      quando: params.agora ?? new Date(),
    });

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
        locationId: params.locationId,
      });
    }

    /**
     * A fidelidade nasce na mesma transação, e pelo mesmo motivo (bloco 41).
     *
     * O resgate **sai** do saldo e o acúmulo **entra**, nesta ordem e aqui
     * dentro. Gravar o resgate depois do commit deixaria a comanda fechada com
     * o crédito aplicado e o saldo intacto — crédito infinito, gasto uma vez por
     * comanda, que é o pior desfecho possível deste bloco.
     *
     * O acúmulo desconta o que foi resgatado: é o bloqueio anti-laço que a SPEC
     * §4.8 pede, e sem ele o corte grátis gera o crédito que compra o próximo
     * corte grátis.
     */
    const resgatadoCents = params.pagamentos
      .filter((p) => p.forma === 'fidelidade')
      .reduce((soma, p) => soma + p.valorCents, 0);

    if (resgatadoCents > 0) {
      if (!comanda.customerId) {
        throw new ComandaError(
          'pagamento_invalido',
          'Identifique o cliente antes de usar o saldo de fidelidade.',
        );
      }
      const programaDaVenda = await programaDaCasa(tx);
      // Reconferido **sob a trava**, e não só na tela: entre a montagem do
      // pagamento e este ponto pode ter entrado outro resgate do mesmo saldo.
      const conferido = await conferirResgate({
        // A transação já está aberta com o tenant no contexto; `conferirResgate`
        // só usa o id quando precisa abrir a própria.
        tenantId: params.tenantId,
        customerId: comanda.customerId,
        quantidade: params.resgateQuantidade ?? 0,
        tetoCents: comanda.totalCents,
        /**
         * O prêmio de `visitas` é **um serviço**, não a comanda.
         *
         * "A cada dez cortes, um grátis" é um corte. O teto era o total, e a
         * decisão foi tomada quando a comanda só tinha serviço — item de pacote
         * e de produto entraram nos blocos 42 e 44 sem revisitá-lo. Com um
         * pacote de R$ 250 na mesma conta, o prêmio pagava a compra inteira: o
         * cliente saía com cinco cortes pré-pagos que ninguém pagou, ainda
         * reembolsáveis proporcionalmente — virando crédito no razão do fiado.
         *
         * O maior item de serviço, e não a soma deles: o prêmio é **um**.
         */
        tetoDeUmServicoCents: comanda.itens
          .filter((i) => i.tipo === 'service')
          .reduce((maior, i) => Math.max(maior, i.precoUnitarioCents * i.quantidade), 0),
        locationId: params.locationId,
        tx,
      });
      if (conferido.valorCents !== resgatadoCents) {
        throw new ComandaError(
          'pagamento_invalido',
          'O valor do resgate mudou. Refaça o pagamento.',
        );
      }
      await registrarResgate(tx, {
        customerId: comanda.customerId,
        orderId: params.orderId,
        quantidade: conferido.quantidade,
        modo: programaDaVenda.modo,
        // A loja em que a venda aconteceu: é ela que decide de qual bolso o
        // saldo sai quando a fidelidade é por unidade (bloco 59).
        locationId: params.locationId,
      });
    }

    /**
     * Os pacotes, na mesma transação (bloco 42).
     *
     * **Vendidos** viram `customer_packages` com tudo congelado — serviço,
     * quantidade, preço e validade. **Consumidos** viram `package_uses`, que é o
     * momento em que a receita diferida na compra é reconhecida.
     *
     * Fora desta transação, a comanda fecharia com o corte quitado pelo pacote e
     * o pacote continuaria cheio: crédito infinito, um corte por comanda.
     */
    const pagoComPacote = params.pagamentos
      .filter((p) => p.forma === 'pacote')
      .reduce((soma, p) => soma + p.valorCents, 0);

    /**
     * Quem foi vendido sai dos **itens**, nunca de uma lista no corpo.
     *
     * A primeira versão recebia `pacotesVendidos` do fechamento, ao lado dos
     * itens que dão o preço. Duas fontes para o mesmo fato: um item de R$ 1 e
     * uma lista com o pacote de R$ 250 fechariam a conta por um real e criariam
     * cinco cortes de R$ 50 congelados — dinheiro criado do nada, resgatável
     * como crédito pelo reembolso proporcional, e por fora do teto de desconto
     * da casa. Cada metade estava internamente coerente, e por isso nada ficava
     * vermelho.
     *
     * Derivado do item, o que foi cobrado e o que foi entregue são o mesmo dado.
     */
    const itensDePacote = await itensDePacoteDaComanda(tx, params.orderId);

    if (pagoComPacote > 0 || itensDePacote.length > 0) {
      if (!comanda.customerId) {
        throw new ComandaError(
          'pagamento_invalido',
          'Identifique o cliente antes de vender ou usar um pacote.',
        );
      }
    }

    const agoraNoFechamento = params.agora ?? new Date();
    for (const item of itensDePacote) {
      // A quantidade cobrada e a quantidade entregue são o mesmo fato.
      // `Pacote × 2` precisa criar dois customer_packages, não um.
      for (let unidade = 0; unidade < item.quantity; unidade += 1) {
        await venderPacote(tx, {
          tenantId: params.tenantId,
          customerId: comanda.customerId as string,
          packageId: item.package_id,
          orderId: params.orderId,
          serviceId: item.package_snapshot_service_id,
          quantidade: item.package_snapshot_quantity,
          precoCents: item.unit_price_cents,
          validadeDias: item.package_snapshot_validity_days,
          transferivel: item.package_snapshot_transferable,
          agora: agoraNoFechamento,
        });
      }
    }

    if (pagoComPacote > 0) {
      const servicoCoberto = params.servicoDoPacote;
      if (!servicoCoberto) {
        throw new ComandaError(
          'pagamento_invalido',
          'Diga qual serviço o pacote está cobrindo.',
        );
      }

      /**
       * O serviço coberto tem que estar **nesta comanda**.
       *
       * Sem a conferência, uma barba de R$ 50 fecharia queimando uma unidade do
       * pacote de corte: os valores batem, o domínio aceita, e o cliente perde
       * um corte que pagou. A receita ainda seria reconhecida no serviço errado,
       * e a exportação do titular mostraria a unidade consumida sem dizer que
       * foi mal aplicada.
       */
      const naComanda = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM order_items
         WHERE order_id = ${params.orderId}::uuid
           AND service_id = ${servicoCoberto}::uuid
         LIMIT 1
      `;
      if (!naComanda[0]) {
        throw new ComandaError(
          'pagamento_invalido',
          'Este pacote não cobre nenhum serviço desta comanda.',
        );
      }
      // Reconferido **sob a trava**: entre a montagem do pagamento e este ponto
      // pode ter entrado outro consumo do mesmo pacote.
      const disponivel = await consumoDisponivel({
        tenantId: params.tenantId,
        customerId: comanda.customerId,
        serviceId: servicoCoberto,
        tx,
      });
      if (!disponivel || disponivel.valorCents !== pagoComPacote) {
        throw new ComandaError(
          'pagamento_invalido',
          'O pacote mudou. Refaça o pagamento.',
        );
      }
      await consumirPacote(tx, {
        customerPackageId: disponivel.customerPackageId,
        orderId: params.orderId,
        valorCents: disponivel.valorCents,
        diaDaUnidade: params.hojeNaUnidade,
        ...(comanda.appointmentId ? { appointmentId: comanda.appointmentId } : {}),
      });
    }

    /**
     * O estoque, na mesma transação (bloco 44).
     *
     * **Venda** baixa a pomada que o cliente levou; **consumo** baixa o shampoo
     * que o barbeiro usou, pela ficha técnica. Fora desta transação, a comanda
     * fecharia e a prateleira continuaria cheia no sistema — e o CMV apontaria
     * margem que a casa não teve.
     *
     * Os dois derivam dos **itens** da comanda, como a venda de pacote: uma
     * lista no corpo do fechamento seria a segunda fonte do mesmo fato, e o que
     * foi cobrado poderia discordar do que baixou.
     */
    /**
     * A assinatura, na mesma transação (bloco 45).
     *
     * Fora dela, a comanda fecharia com o corte quitado pelo plano e a cota
     * continuaria cheia — corte ilimitado de graça, um por comanda. É o mesmo
     * defeito que o pacote e o resgate de fidelidade teriam, e a mesma solução.
     */
    const pagoComAssinatura = params.pagamentos
      .filter((p) => p.forma === 'assinatura')
      .reduce((soma, p) => soma + p.valorCents, 0);

    if (pagoComAssinatura > 0) {
      if (!comanda.customerId) {
        throw new ComandaError(
          'pagamento_invalido',
          'Identifique o cliente antes de usar a assinatura.',
        );
      }
      const servicoCoberto = params.servicoDaAssinatura;
      if (!servicoCoberto) {
        throw new ComandaError(
          'pagamento_invalido',
          'Diga qual serviço a assinatura está cobrindo.',
        );
      }

      /**
       * O serviço coberto tem que estar **nesta comanda**.
       *
       * Sem a conferência, uma barba fecharia queimando a cota de corte do
       * plano: os valores batem, o domínio aceita, e o cliente perde um corte
       * que pagou na mensalidade. É a mesma lição do bloco 42.
       */
      const naComanda = comanda.itens.find(
        (i) => i.serviceId === servicoCoberto && i.tipo === 'service',
      );
      if (!naComanda) {
        throw new ComandaError(
          'pagamento_invalido',
          'A assinatura não cobre nenhum serviço desta comanda.',
        );
      }

      // Reconferido **sob a trava**: entre a montagem do pagamento e este ponto
      // pode ter entrado outro uso do mesmo plano.
      const disponivel = await usoDisponivel({
        tenantId: params.tenantId,
        customerId: comanda.customerId,
        serviceId: servicoCoberto,
        precoCents: naComanda.precoUnitarioCents,
        agora: agoraNoFechamento,
        ...(params.quandoLocal ? { quandoLocal: params.quandoLocal } : {}),
        // A loja da venda: um plano de escopo `unidade` cobre só onde a pessoa
        // assinou (bloco 59).
        locationId: params.locationId,
        tx,
      });

      if (!disponivel || 'recusa' in disponivel || disponivel.valorCents !== pagoComAssinatura) {
        throw new ComandaError(
          'pagamento_invalido',
          'A assinatura mudou. Refaça o pagamento.',
        );
      }

      await consumirAssinatura(tx, {
        subscriptionId: disponivel.subscriptionId,
        // Quem usou, para o extrato da família (bloco 46): sem isso, "3 de 5
        // usados" numa família de quatro é um número que ninguém confere.
        customerId: comanda.customerId,
        serviceId: servicoCoberto,
        orderId: params.orderId,
        orderItemId: naComanda.id,
        valorCents: disponivel.valorCents,
        diaDaUnidade: params.hojeNaUnidade,
        agora: agoraNoFechamento,
        ...(comanda.appointmentId ? { appointmentId: comanda.appointmentId } : {}),
      });
    }

    await baixarVendas(tx, {
      orderId: params.orderId,
      diaDaUnidade: params.hojeNaUnidade,
      locationId: params.locationId,
    });
    await consumirFicha(tx, {
      // Com a quantidade: uma linha "Corte × 2" consome duas fichas.
      servicos: comanda.itens
        .filter((i) => i.tipo === 'service' && i.serviceId)
        .map((i) => ({ serviceId: i.serviceId as string, quantidade: i.quantidade })),
      orderId: params.orderId,
      diaDaUnidade: params.hojeNaUnidade,
      locationId: params.locationId,
      ...(comanda.appointmentId ? { appointmentId: comanda.appointmentId } : {}),
    });

    await creditarDaVenda(tx, {
      orderId: params.orderId,
      customerId: comanda.customerId,
      // Sem gorjeta: ela é do barbeiro, e premiar o cliente por ela seria a
      // barbearia pagando fidelidade com dinheiro que não é dela.
      totalCents: comanda.totalCents - comanda.gorjetaCents,
      resgatadoCents,
      /**
       * Pacote e assinatura saem da base: são crédito **já pago e já premiado**.
       *
       * O pacote de R$ 250 entra uma vez no caixa e era premiado duas — na
       * compra e em cada um dos cinco usos —, dando 10% onde a casa configurou
       * 5%. Cada metade era internamente coerente, e por isso nada ficava
       * vermelho.
       */
      prepagoCents: params.pagamentos
        .filter((p) => p.forma === 'pacote' || p.forma === 'assinatura')
        .reduce((soma, p) => soma + p.valorCents, 0),
      agora: agoraNoFechamento,
      // O bolso em que o saldo nasce, congelado com o lançamento (bloco 59).
      locationId: params.locationId,
    });

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

    /**
     * A nota fiscal (bloco 53), quando a barbearia ligou a emissão automática.
     *
     * Ela nasce `pendente` **nesta transação**, e a tarefa que a envia nasce
     * junto: enfileirar depois do commit abriria a janela em que a venda foi
     * fechada e nada está marcado para emitir. Quem fala com a prefeitura é a
     * fila, nunca este caminho — ela pode levar minutos e pode estar fora do ar,
     * e o cliente está esperando o troco.
     *
     * Silenciosa quando não há configuração, quando a emissão automática está
     * desligada ou quando a comanda só tem produto: os três são normais, e
     * nenhum é erro. Nada aqui pode lançar exceção por motivo fiscal — esta
     * função roda na transação do webhook do Pix, e a lição do bloco 44 é que
     * uma exceção ali volta atrás com o dinheiro sem registro nenhum.
     */
    await pedirNota(tx, {
      tenantId: params.tenantId,
      locationId: params.locationId,
      orderId: params.orderId,
      staffId: params.staffId,
      staffName: params.staffName,
      automatica: true,
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

    return carregar(tx, params.orderId, null);
  };

  return params.tx ? dentro(params.tx) : withTenant(params.tenantId, dentro);
}

