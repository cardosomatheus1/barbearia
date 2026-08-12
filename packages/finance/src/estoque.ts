import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  alertasDoProduto,
  custoDaFicha,
  margemDeContribuicao,
  comissaoPorItem,
  sugestaoDeCompra,
  validarMovimento,
  type AlertaDeEstoque,
  type DecomposicaoDaMargem,
  type FaixaDeComissao,
  type ModoDeComissao,
  type TipoDeMovimentoDeEstoque,
  type TipoDeProduto,
} from '@barbearia/core';
import { audit } from '@barbearia/identity';

/**
 * Produtos, estoque, ficha técnica e CMV (bloco 44, SPEC §3.7 e §3.8).
 *
 * Mora em `finance` e não em `catalog` por duas razões que apontam para o mesmo
 * lugar: `perda` e `ajuste` movem valor e precisam de `audit()` — que `catalog`
 * de propósito não conhece —, e a margem de contribuição é a soma de comissão,
 * insumo e taxa do adquirente, três números que já viviam aqui.
 *
 * ## O saldo é sempre uma soma
 *
 * Não existe coluna de estoque. Toda leitura soma `stock_movements`, e é isso
 * que faz "por que só tem 12 se eu comprei 20?" ter resposta.
 */

export type EstoqueFailure =
  | 'produto_nao_encontrado'
  | 'produto_invalido'
  | 'quantidade_invalida'
  | 'sinal_invalido'
  | 'saldo_insuficiente'
  | 'motivo_obrigatorio'
  | 'servico_nao_encontrado';

export class EstoqueError extends Error {
  constructor(readonly code: EstoqueFailure, message: string) {
    super(message);
    this.name = 'EstoqueError';
  }
}

const MENSAGEM: Readonly<Record<EstoqueFailure, string>> = {
  produto_nao_encontrado: 'Este produto não existe.',
  produto_invalido: 'Confira os dados do produto.',
  quantidade_invalida: 'A quantidade precisa ser um número inteiro diferente de zero.',
  sinal_invalido: 'Só ajuste e transferência aceitam quantidade negativa.',
  saldo_insuficiente: 'Não há esse tanto em estoque.',
  motivo_obrigatorio: 'Escreva o motivo — perda e ajuste mudam o número sem venda.',
  servico_nao_encontrado: 'Este serviço não existe.',
};

function recusar(code: EstoqueFailure): never {
  throw new EstoqueError(code, MENSAGEM[code]);
}

interface Ator {
  readonly id: string;
  readonly name: string;
}

// ---------------------------------------------------------------------------
// O cadastro
// ---------------------------------------------------------------------------

export interface ProdutoNaTela {
  readonly id: string;
  readonly sku: string | null;
  readonly barcode: string | null;
  readonly nome: string;
  readonly categoria: string | null;
  readonly fornecedor: string | null;
  readonly tipo: TipoDeProduto;
  readonly custoCents: number;
  readonly precoCents: number | null;
  readonly minimo: number;
  readonly unidade: string;
  readonly venceEm: string | null;
  readonly ativo: boolean;
  readonly saldo: number;
  readonly alertas: readonly AlertaDeEstoque[];
  readonly sugestaoDeCompra: number;
}

interface LinhaDoProduto {
  id: string;
  sku: string | null;
  barcode: string | null;
  name: string;
  category: string | null;
  supplier: string | null;
  kind: TipoDeProduto;
  cost_cents: number;
  price_cents: number | null;
  min_stock: number;
  unit: string;
  expires_on: Date | null;
  active: boolean;
  saldo: bigint | null;
}

/**
 * O saldo entra por subconsulta, numa query só.
 *
 * Um laço somando movimento por produto seria o N+1 clássico: a tela de estoque
 * abre com cinquenta produtos, e cinquenta idas ao banco fariam dela a mais
 * lenta do painel.
 */
const SELECT_DO_PRODUTO = `
  SELECT p.id, p.sku, p.barcode, p.name, p.category, p.supplier, p.kind,
         p.cost_cents, p.price_cents, p.min_stock, p.unit, p.expires_on, p.active,
         (SELECT sum(m.quantity) FROM stock_movements m WHERE m.product_id = p.id) AS saldo
    FROM products p
`;

function paraTela(linha: LinhaDoProduto, agora: Date): ProdutoNaTela {
  const emEstoque = {
    id: linha.id,
    nome: linha.name,
    tipo: linha.kind,
    saldo: Number(linha.saldo ?? 0),
    minimo: linha.min_stock,
    venceEm: linha.expires_on,
    custoCents: linha.cost_cents,
    precoCents: linha.price_cents,
  };

  return {
    id: linha.id,
    sku: linha.sku,
    barcode: linha.barcode,
    nome: linha.name,
    categoria: linha.category,
    fornecedor: linha.supplier,
    tipo: linha.kind,
    custoCents: linha.cost_cents,
    precoCents: linha.price_cents,
    minimo: linha.min_stock,
    unidade: linha.unit,
    venceEm: linha.expires_on ? linha.expires_on.toISOString().slice(0, 10) : null,
    ativo: linha.active,
    saldo: emEstoque.saldo,
    alertas: alertasDoProduto(emEstoque, agora),
    sugestaoDeCompra: sugestaoDeCompra(emEstoque),
  };
}

export async function produtos(
  tenantId: string,
  incluirInativos = false,
  agora: Date = new Date(),
): Promise<readonly ProdutoNaTela[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRawUnsafe<LinhaDoProduto[]>(
      `${SELECT_DO_PRODUTO} WHERE ($1::boolean OR p.active) ORDER BY p.name`,
      incluirInativos,
    );
    return linhas.map((l) => paraTela(l, agora));
  });
}

export async function salvarProduto(entrada: {
  readonly tenantId: string;
  readonly id?: string;
  readonly nome: string;
  readonly tipo: TipoDeProduto;
  readonly sku?: string | null;
  readonly barcode?: string | null;
  readonly categoria?: string | null;
  readonly fornecedor?: string | null;
  readonly custoCents: number;
  readonly precoCents: number | null;
  readonly minimo: number;
  readonly unidade: string;
  readonly venceEm?: string | null;
  readonly ativo: boolean;
  readonly ator: Ator;
}): Promise<{ readonly id: string }> {
  if (
    entrada.nome.trim().length < 2 ||
    !Number.isInteger(entrada.custoCents) ||
    entrada.custoCents < 0 ||
    !Number.isInteger(entrada.minimo) ||
    entrada.minimo < 0
  ) {
    recusar('produto_invalido');
  }

  /**
   * O preço acompanha o tipo, e o `CHECK` do banco cobra igual.
   *
   * Revenda sem preço aparece na busca da comanda e é acrescentado por zero —
   * uma venda que não entra no caixa e some do CMV. Interno **com** preço é um
   * número que ninguém cobra.
   */
  const preco = entrada.tipo === 'resale' ? entrada.precoCents : null;
  if (entrada.tipo === 'resale' && (preco === null || preco < 0)) recusar('produto_invalido');

  const vazioVira = (v: string | null | undefined) => {
    const t = v?.trim();
    return t && t.length > 0 ? t : null;
  };

  return withTenant(entrada.tenantId, async (tx) => {
    if (entrada.id) {
      const afetados = await tx.$executeRaw`
        UPDATE products
           SET name = ${entrada.nome.trim()}, kind = ${entrada.tipo}::product_kind,
               sku = ${vazioVira(entrada.sku)}, barcode = ${vazioVira(entrada.barcode)},
               category = ${vazioVira(entrada.categoria)},
               supplier = ${vazioVira(entrada.fornecedor)},
               cost_cents = ${entrada.custoCents}, price_cents = ${preco},
               min_stock = ${entrada.minimo}, unit = ${entrada.unidade},
               expires_on = ${entrada.venceEm ?? null}::date,
               active = ${entrada.ativo}, updated_at = now()
         WHERE id = ${entrada.id}::uuid
      `;
      if (afetados === 0) recusar('produto_nao_encontrado');

      await audit(tx, {
        actorId: entrada.ator.id,
        actorName: entrada.ator.name,
        action: 'product.changed',
        entity: 'products',
        entityId: entrada.id,
        after: { nome: entrada.nome, custoCents: entrada.custoCents, ativo: entrada.ativo },
      });
      return { id: entrada.id };
    }

    const criados = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO products
        (tenant_id, name, kind, sku, barcode, category, supplier,
         cost_cents, price_cents, min_stock, unit, expires_on, active)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${entrada.nome.trim()}, ${entrada.tipo}::product_kind,
        ${vazioVira(entrada.sku)}, ${vazioVira(entrada.barcode)},
        ${vazioVira(entrada.categoria)}, ${vazioVira(entrada.fornecedor)},
        ${entrada.custoCents}, ${preco}, ${entrada.minimo}, ${entrada.unidade},
        ${entrada.venceEm ?? null}::date, ${entrada.ativo}
      )
      RETURNING id
    `;
    const id = criados[0]?.id;
    if (id === undefined) recusar('produto_invalido');

    await audit(tx, {
      actorId: entrada.ator.id,
      actorName: entrada.ator.name,
      action: 'product.changed',
      entity: 'products',
      entityId: id,
      after: { nome: entrada.nome, tipo: entrada.tipo, criado: true },
    });
    return { id };
  });
}

// ---------------------------------------------------------------------------
// O movimento
// ---------------------------------------------------------------------------

/**
 * Grava um movimento **dentro de uma transação**, com a linha do produto travada.
 *
 * A trava é do caminho que grava, não do que mostra: sem ela, duas vendas
 * simultâneas do último vidro leem "saldo = 1" as duas e gravam as duas. O
 * gatilho do banco é a segunda camada, e existe porque uma cláusula de trava é
 * perdível numa reescrita.
 */
export async function moverEstoque(
  tx: TransactionClient,
  params: {
    readonly produtoId: string;
    readonly tipo: TipoDeMovimentoDeEstoque;
    readonly quantidade: number;
    readonly diaDaUnidade: string;
    readonly locationId?: string | null;
    readonly orderId?: string | null;
    readonly appointmentId?: string | null;
    readonly motivo?: string | null;
    readonly staffUserId?: string | null;
    /** Nulo usa o custo de reposição do cadastro, congelado aqui. */
    readonly custoUnitarioCents?: number | null;
  },
): Promise<void> {
  const linhas = await tx.$queryRaw<{ cost_cents: number; saldo: bigint | null }[]>`
    SELECT p.cost_cents,
           (SELECT sum(m.quantity) FROM stock_movements m WHERE m.product_id = p.id) AS saldo
      FROM products p
     WHERE p.id = ${params.produtoId}::uuid
     FOR UPDATE OF p
  `;
  const produto = linhas[0];
  if (!produto) recusar('produto_nao_encontrado');

  const falha = validarMovimento({
    tipo: params.tipo,
    quantidade: params.quantidade,
    saldoAtual: Number(produto.saldo ?? 0),
    motivo: params.motivo ?? null,
  });
  if (falha) recusar(falha);

  /**
   * A quantidade é gravada **com o sinal do tipo**.
   *
   * A borda recebe "vendi 2" e o banco guarda −2: o saldo é `sum(quantity)`, e
   * uma soma que precisasse conhecer o tipo de cada linha seria a mesma regra
   * escrita em dois lugares — a consulta e o domínio — para discordarem depois.
   */
  const comSinal =
    params.tipo === 'ajuste' || params.tipo === 'transferencia'
      ? params.quantidade
      : params.tipo === 'entrada'
        ? Math.abs(params.quantidade)
        : -Math.abs(params.quantidade);

  await tx.$executeRaw`
    INSERT INTO stock_movements
      (tenant_id, product_id, location_id, kind, quantity, unit_cost_cents,
       order_id, appointment_id, reason, staff_user_id, business_day)
    VALUES (
      NULLIF(current_setting('app.tenant_id', true), '')::uuid,
      ${params.produtoId}::uuid, ${params.locationId ?? null}::uuid,
      ${params.tipo}::stock_movement_kind, ${comSinal},
      ${params.custoUnitarioCents ?? produto.cost_cents},
      ${params.orderId ?? null}::uuid, ${params.appointmentId ?? null}::uuid,
      ${params.motivo?.trim() ?? null}, ${params.staffUserId ?? null}::uuid,
      ${params.diaDaUnidade}::date
    )
    ON CONFLICT DO NOTHING
  `;
}

/** O movimento lançado à mão pelo balcão: entrada, perda, ajuste. */
export async function lancarMovimento(entrada: {
  readonly tenantId: string;
  readonly produtoId: string;
  readonly tipo: TipoDeMovimentoDeEstoque;
  readonly quantidade: number;
  readonly diaDaUnidade: string;
  readonly motivo?: string | null;
  readonly ator: Ator;
}): Promise<{ readonly lancado: true }> {
  return withTenant(entrada.tenantId, async (tx) => {
    await moverEstoque(tx, {
      produtoId: entrada.produtoId,
      tipo: entrada.tipo,
      quantidade: entrada.quantidade,
      diaDaUnidade: entrada.diaDaUnidade,
      motivo: entrada.motivo ?? null,
      staffUserId: entrada.ator.id,
    });

    /**
     * `perda` e `ajuste` são auditados; `entrada` não.
     *
     * As duas primeiras mudam o número sem nota fiscal nem venda, e a pergunta
     * do dia seguinte é "quem baixou trinta unidades?". A entrada tem a nota do
     * fornecedor como registro, e auditar toda reposição encheria a trilha do
     * que ninguém procura — que é como uma trilha deixa de ser lida.
     */
    if (entrada.tipo === 'perda' || entrada.tipo === 'ajuste') {
      await audit(tx, {
        actorId: entrada.ator.id,
        actorName: entrada.ator.name,
        action: 'stock.adjusted',
        entity: 'products',
        entityId: entrada.produtoId,
        after: { tipo: entrada.tipo, quantidade: entrada.quantidade, motivo: entrada.motivo },
      });
    }

    return { lancado: true as const };
  });
}

export interface MovimentoNaTela {
  readonly id: string;
  readonly tipo: TipoDeMovimentoDeEstoque;
  readonly quantidade: number;
  readonly custoUnitarioCents: number;
  readonly motivo: string | null;
  readonly quem: string | null;
  readonly dia: string;
  readonly quando: string;
}

/** O histórico de um produto — a resposta para "por que só tem 12?". */
export async function movimentosDoProduto(
  tenantId: string,
  produtoId: string,
  limite = 50,
): Promise<readonly MovimentoNaTela[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        kind: TipoDeMovimentoDeEstoque;
        quantity: number;
        unit_cost_cents: number;
        reason: string | null;
        quem: string | null;
        business_day: Date;
        created_at: Date;
      }[]
    >`
      SELECT m.id, m.kind, m.quantity, m.unit_cost_cents, m.reason,
             s.name AS quem, m.business_day, m.created_at
        FROM stock_movements m
        LEFT JOIN staff_users s ON s.id = m.staff_user_id
       WHERE m.product_id = ${produtoId}::uuid
       ORDER BY m.created_at DESC
       LIMIT ${limite}
    `;

    return linhas.map((l) => ({
      id: l.id,
      tipo: l.kind,
      quantidade: l.quantity,
      custoUnitarioCents: l.unit_cost_cents,
      motivo: l.reason,
      quem: l.quem,
      dia: l.business_day.toISOString().slice(0, 10),
      quando: l.created_at.toISOString(),
    }));
  });
}

// ---------------------------------------------------------------------------
// A ficha técnica
// ---------------------------------------------------------------------------

export interface ItemDaFichaNaTela {
  readonly produtoId: string;
  readonly nome: string;
  readonly unidade: string;
  readonly quantidade: number;
  readonly custoUnitarioCents: number;
}

export async function fichaDoServico(
  tenantId: string,
  serviceId: string,
): Promise<readonly ItemDaFichaNaTela[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      { product_id: string; name: string; unit: string; quantity: number; cost_cents: number }[]
    >`
      SELECT c.product_id, p.name, p.unit, c.quantity, p.cost_cents
        FROM service_consumables c
        JOIN products p ON p.id = c.product_id
       WHERE c.service_id = ${serviceId}::uuid
       ORDER BY p.name
    `;
    return linhas.map((l) => ({
      produtoId: l.product_id,
      nome: l.name,
      unidade: l.unit,
      quantidade: l.quantity,
      custoUnitarioCents: l.cost_cents,
    }));
  });
}

/**
 * Substitui a ficha inteira de um serviço.
 *
 * Substituir e não editar item a item: a ficha é uma lista curta que a
 * barbearia refaz de uma vez ("agora a barba usa outro pós-barba"), e um
 * formulário de três linhas com botões de adicionar e remover para cada uma
 * seria mais tela do que o dado merece.
 */
export async function salvarFicha(entrada: {
  readonly tenantId: string;
  readonly serviceId: string;
  readonly itens: readonly { readonly produtoId: string; readonly quantidade: number }[];
  readonly ator: Ator;
}): Promise<{ readonly itens: number }> {
  for (const item of entrada.itens) {
    if (!Number.isInteger(item.quantidade) || item.quantidade <= 0) recusar('quantidade_invalida');
  }

  return withTenant(entrada.tenantId, async (tx) => {
    // Ids vindos da requisição conferidos sob RLS: a chave estrangeira do
    // Postgres ignora row security e aceitaria o serviço e o produto do vizinho.
    const servicos = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM services WHERE id = ${entrada.serviceId}::uuid
    `;
    if (!servicos[0]) recusar('servico_nao_encontrado');

    if (entrada.itens.length > 0) {
      const ids = entrada.itens.map((i) => i.produtoId);
      const achados = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM products WHERE id = ANY(${ids}::uuid[]) AND kind = 'internal'
      `;
      /**
       * A contagem tem que bater com o pedido.
       *
       * Só conferir que "achou algum" deixaria passar uma ficha com um produto
       * legítimo e dois alheios. E o filtro por `internal` é a outra metade:
       * pendurar uma pomada de revenda na ficha faria o serviço baixar do
       * estoque de venda sem ninguém ter comprado nada.
       */
      if (achados.length !== new Set(ids).size) recusar('produto_nao_encontrado');
    }

    await tx.$executeRaw`
      DELETE FROM service_consumables WHERE service_id = ${entrada.serviceId}::uuid
    `;

    for (const item of entrada.itens) {
      await tx.$executeRaw`
        INSERT INTO service_consumables (service_id, product_id, tenant_id, quantity)
        VALUES (
          ${entrada.serviceId}::uuid, ${item.produtoId}::uuid,
          NULLIF(current_setting('app.tenant_id', true), '')::uuid, ${item.quantidade}
        )
      `;
    }

    await audit(tx, {
      actorId: entrada.ator.id,
      actorName: entrada.ator.name,
      action: 'product.changed',
      entity: 'services',
      entityId: entrada.serviceId,
      after: { ficha: entrada.itens.length },
    });

    return { itens: entrada.itens.length };
  });
}

/**
 * Baixa os insumos de um serviço, **dentro da transação que fecha a comanda**.
 *
 * Fora dela, a comanda fecharia e o shampoo continuaria na prateleira — o CMV
 * apontaria margem que a casa não teve. O `ON CONFLICT DO NOTHING` do índice
 * único fecha a reentrada do webhook.
 *
 * Estoque insuficiente **não derruba o fechamento**: o cliente já foi atendido e
 * já vai pagar, e recusar a comanda por causa de um shampoo mal contado seria o
 * sistema impedindo a venda para proteger um número. A falta vira ausência de
 * movimento, e a contagem do dia acusa.
 */
export async function consumirFicha(
  tx: TransactionClient,
  params: {
    /**
     * Os serviços da comanda **com a quantidade de cada um**.
     *
     * A primeira versão recebia só os ids e usava `= ANY(...)`, que é teste de
     * pertinência: uma comanda com dois cortes — ou uma linha "Corte × 2" —
     * consumia **uma** ficha, e a prateleira ficava com um shampoo a mais que o
     * sistema. Achado da `/security-review`.
     */
    readonly servicos: readonly { readonly serviceId: string; readonly quantidade: number }[];
    readonly orderId: string;
    readonly diaDaUnidade: string;
    readonly appointmentId?: string | null;
    readonly locationId?: string | null;
  },
): Promise<void> {
  if (params.servicos.length === 0) return;

  const linhas = await tx.$queryRaw<{ service_id: string; product_id: string; quantity: number; cost_cents: number }[]>`
    SELECT c.service_id, c.product_id, c.quantity, p.cost_cents
      FROM service_consumables c
      JOIN products p ON p.id = c.product_id
     WHERE c.service_id = ANY(${params.servicos.map((s) => s.serviceId)}::uuid[])
  `;

  /**
   * Um movimento por produto e por comanda, com a soma.
   *
   * O índice único é `(order_id, product_id, kind)`: dois movimentos do mesmo
   * shampoo na mesma comanda não cabem, e não precisam — o que importa é a
   * quantidade certa numa linha só, e é isso que faz a reentrega do webhook
   * continuar sem efeito.
   */
  const porProduto = new Map<string, { quantity: number; cost_cents: number }>();
  for (const servico of params.servicos) {
    for (const linha of linhas.filter((l) => l.service_id === servico.serviceId)) {
      const conta = porProduto.get(linha.product_id) ?? { quantity: 0, cost_cents: linha.cost_cents };
      conta.quantity += linha.quantity * servico.quantidade;
      porProduto.set(linha.product_id, conta);
    }
  }

  const ficha = [...porProduto].map(([product_id, v]) => ({ product_id, ...v }));

  for (const item of ficha) {
    try {
      await moverEstoque(tx, {
        produtoId: item.product_id,
        tipo: 'consumo',
        quantidade: item.quantity,
        diaDaUnidade: params.diaDaUnidade,
        orderId: params.orderId,
        custoUnitarioCents: item.cost_cents,
        ...(params.appointmentId ? { appointmentId: params.appointmentId } : {}),
        ...(params.locationId ? { locationId: params.locationId } : {}),
      });
    } catch (erro) {
      // Só o saldo insuficiente é engolido, e com o motivo escrito acima.
      // Qualquer outra falha é defeito e precisa derrubar a transação.
      if (!(erro instanceof EstoqueError) || erro.code !== 'saldo_insuficiente') throw erro;
    }
  }
}

/** Baixa os produtos de revenda vendidos na comanda, na mesma transação. */
export async function baixarVendas(
  tx: TransactionClient,
  params: {
    readonly orderId: string;
    readonly diaDaUnidade: string;
    readonly locationId?: string | null;
  },
): Promise<void> {
  const itens = await tx.$queryRaw<{ product_id: string; quantity: number; cost_cents: number }[]>`
    SELECT i.product_id, sum(i.quantity)::int AS quantity, p.cost_cents
      FROM order_items i
      JOIN products p ON p.id = i.product_id
     WHERE i.order_id = ${params.orderId}::uuid AND i.product_id IS NOT NULL
     GROUP BY i.product_id, p.cost_cents
  `;

  for (const item of itens) {
    try {
      await moverEstoque(tx, {
        produtoId: item.product_id,
        tipo: 'venda',
        quantidade: item.quantity,
        diaDaUnidade: params.diaDaUnidade,
        orderId: params.orderId,
        custoUnitarioCents: item.cost_cents,
        ...(params.locationId ? { locationId: params.locationId } : {}),
      });
    } catch (erro) {
      /**
       * Saldo insuficiente **não derruba o fechamento**, e este é o achado mais
       * caro da `/security-review` do bloco 44.
       *
       * A primeira versão deixava a exceção subir. `fecharComanda` é chamada
       * dentro da transação do webhook do Pix, e o bloco 35 já pagou para
       * aprender o que acontece: a transação inteira volta atrás, o dinheiro
       * fica sem registro nenhum, o adquirente reentrega por dias com a mesma
       * falha, e a varredura da barbearia para no meio do laço deixando as
       * outras cobranças sem conferência.
       *
       * E o gatilho é certo: o produto **saiu da prateleira** — o cliente está
       * indo embora com ele. O que falta é a entrada que ninguém registrou, e
       * recusar o pagamento por isso seria o sistema protegendo um número contra
       * um fato. A ausência do movimento aparece na contagem, que é o lugar
       * certo de aparecer.
       */
      if (!(erro instanceof EstoqueError) || erro.code !== 'saldo_insuficiente') throw erro;
    }
  }
}

// ---------------------------------------------------------------------------
// CMV e margem (SPEC §3.8)
// ---------------------------------------------------------------------------

export interface MargemDoServico extends DecomposicaoDaMargem {
  readonly serviceId: string;
  readonly nome: string;
  readonly vezes: number;
}

/**
 * A decomposição da SPEC §3.8, por serviço, num período.
 *
 * Os três custos já existiam separados no produto e nunca tinham sido somados:
 * a comissão sai do lançamento (com a regra congelada), a taxa sai de
 * `orders.fee_cents` (congelada na venda), e o insumo é o que este bloco traz.
 *
 * A taxa é **rateada pelo peso do item na comanda**: ela é cobrada sobre a conta
 * inteira, e atribuí-la ao primeiro serviço faria o corte de R$ 60 numa comanda
 * de R$ 200 carregar a taxa dos outros R$ 140.
 */
export async function margemPorServico(
  tenantId: string,
  de: string,
  ate: string,
): Promise<readonly MargemDoServico[]> {
  return withTenant(tenantId, async (tx) => {
    /**
     * O SQL carrega; a conta é do domínio.
     *
     * A primeira versão calculava a comissão dentro da consulta, e estava errada
     * de duas formas: lia uma coluna que não existe, e não teria como aplicar
     * faixa progressiva — que depende do acumulado do período e não cabe numa
     * expressão por linha. Regra de negócio em SQL é regra de negócio que o
     * teste de `core` não alcança.
     */
    const itens = await tx.$queryRaw<
      {
        item_id: string;
        service_id: string;
        nome: string;
        order_id: string;
        receita: number;
        fee_cents: number;
        total_cents: number;
      }[]
    >`
      SELECT i.id AS item_id, i.service_id, s.name AS nome, o.id AS order_id,
             (i.quantity * i.unit_price_cents) AS receita,
             o.fee_cents, o.total_cents
        FROM order_items i
        JOIN orders o ON o.id = i.order_id
        JOIN services s ON s.id = i.service_id
       WHERE i.service_id IS NOT NULL
         AND o.status = 'paid'
         AND o.business_day >= ${de}::date
         AND o.business_day <= ${ate}::date
    `;
    if (itens.length === 0) return [];

    const lancamentos = await tx.$queryRaw<
      {
        order_item_id: string;
        professional_id: string;
        rule_id: string | null;
        mode: ModoDeComissao;
        value: number;
        tiers: unknown;
        base_cents: number;
        sign: number;
      }[]
    >`
      SELECT e.order_item_id, e.professional_id, e.rule_id, e.mode::text AS mode,
             e.value, e.tiers, e.base_cents, e.sign
        FROM commission_entries e
        JOIN order_items i ON i.id = e.order_item_id
        JOIN orders o ON o.id = i.order_id
       WHERE o.status = 'paid'
         AND o.business_day >= ${de}::date
         AND o.business_day <= ${ate}::date
    `;

    const comissaoDoItem = comissaoPorItem(
      lancamentos
        .filter((l) => l.order_item_id !== null)
        .map((l) => ({
          itemId: l.order_item_id,
          professionalId: l.professional_id,
          regraId: l.rule_id ?? 'sem-regra',
          modo: l.mode,
          valor: l.value,
          faixas: (l.tiers ?? []) as readonly FaixaDeComissao[],
          baseCents: l.base_cents,
          sinal: l.sign as 1 | -1,
        })),
    );

    /**
     * O insumo sai do **movimento congelado**, não do cadastro de hoje.
     *
     * A primeira versão multiplicava `service_consumables` por
     * `products.cost_cents`, e as duas pontas são mutáveis: subir o preço do
     * shampoo em março mudava a margem de janeiro, e refazer a ficha de um
     * serviço reescrevia o custo de todo atendimento passado dele — inclusive
     * de períodos de comissão já fechados, que existem justamente para não
     * mudar. Achado da `/security-review`.
     *
     * `stock_movements.unit_cost_cents` é o que custou o que saiu naquele dia, e
     * é a mesma fonte que `cmvDoPeriodo` lê — o que faz os dois números da tela
     * concordarem por construção, em vez de por coincidência.
     */
    const consumos = await tx.$queryRaw<{ order_id: string; insumo: bigint }[]>`
      SELECT m.order_id, sum(abs(m.quantity)::bigint * m.unit_cost_cents)::bigint AS insumo
        FROM stock_movements m
        JOIN orders o ON o.id = m.order_id
       WHERE m.kind = 'consumo'
         AND o.business_day >= ${de}::date
         AND o.business_day <= ${ate}::date
       GROUP BY m.order_id
    `;
    const insumoDaComanda = new Map(consumos.map((c) => [c.order_id, Number(c.insumo)]));

    const porServico = new Map<
      string,
      { nome: string; vezes: number; receita: number; comissao: number; taxa: number; insumo: number }
    >();

    /**
     * O insumo da comanda rateado pelo peso do serviço nela, como a taxa.
     *
     * O movimento de consumo é por comanda, não por item: uma comanda com corte
     * e barba gera uma baixa só de cada produto. Atribuí-la ao primeiro serviço
     * faria o corte carregar o insumo da barba.
     */
    const receitaDaComanda = new Map<string, number>();
    for (const item of itens) {
      receitaDaComanda.set(item.order_id, (receitaDaComanda.get(item.order_id) ?? 0) + item.receita);
    }

    for (const item of itens) {
      const conta =
        porServico.get(item.service_id) ??
        { nome: item.nome, vezes: 0, receita: 0, comissao: 0, taxa: 0, insumo: 0 };
      conta.vezes += 1;
      conta.receita += item.receita;
      conta.comissao += comissaoDoItem.get(item.item_id) ?? 0;
      /**
       * A taxa é rateada pelo peso do item na comanda.
       *
       * Ela é cobrada sobre a conta inteira, e atribuí-la ao primeiro serviço
       * faria o corte de R$ 60 numa comanda de R$ 200 carregar a taxa dos
       * outros R$ 140.
       */
      conta.taxa +=
        item.total_cents > 0
          ? Math.round((item.fee_cents * item.receita) / item.total_cents)
          : 0;
      const insumoTotal = insumoDaComanda.get(item.order_id) ?? 0;
      const receitaTotal = receitaDaComanda.get(item.order_id) ?? 0;
      conta.insumo +=
        receitaTotal > 0 ? Math.round((insumoTotal * item.receita) / receitaTotal) : 0;

      porServico.set(item.service_id, conta);
    }

    return [...porServico]
      .map(([serviceId, conta]) => ({
        serviceId,
        nome: conta.nome,
        vezes: conta.vezes,
        ...margemDeContribuicao({
          precoCents: conta.receita,
          comissaoCents: conta.comissao,
          insumosCents: conta.insumo,
          taxaCents: conta.taxa,
        }),
      }))
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  });
}

/** O CMV do período: quanto custou o que saiu do estoque. */
export async function cmvDoPeriodo(
  tenantId: string,
  de: string,
  ate: string,
): Promise<{ readonly vendaCents: number; readonly consumoCents: number; readonly perdaCents: number }> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ kind: TipoDeMovimentoDeEstoque; custo: bigint }[]>`
      SELECT kind, sum(abs(quantity) * unit_cost_cents)::bigint AS custo
        FROM stock_movements
       WHERE business_day >= ${de}::date AND business_day <= ${ate}::date
         AND kind IN ('venda', 'consumo', 'perda')
       GROUP BY kind
    `;
    const de_ = (k: TipoDeMovimentoDeEstoque) => Number(linhas.find((l) => l.kind === k)?.custo ?? 0);
    return { vendaCents: de_('venda'), consumoCents: de_('consumo'), perdaCents: de_('perda') };
  });
}

/** O custo de insumo de um serviço, para a tela do catálogo. */
export async function custoDeInsumo(tenantId: string, serviceId: string): Promise<number> {
  const itens = await fichaDoServico(tenantId, serviceId);
  return custoDaFicha(
    itens.map((i) => ({
      produtoId: i.produtoId,
      nome: i.nome,
      quantidade: i.quantidade,
      custoUnitarioCents: i.custoUnitarioCents,
    })),
  );
}
