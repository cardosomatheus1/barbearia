import { withTenant } from '@barbearia/db';
import { validarTransferencia } from '@barbearia/core';
import { audit } from '@barbearia/identity';

/**
 * Multiunidade, do banco para a tela (bloco 58).
 *
 * ## A transferência preenche um mecanismo que já existia
 *
 * `stock_movement_kind` tem `'transferencia'` desde o bloco 47, e nada o
 * escrevia. Era o defeito que a regra deste projeto chama de *"campo que o
 * motor aceita e ninguém preenche é mentira"* — o tipo estava lá, o saldo já
 * sabia somá-lo, e não havia por onde transferir.
 *
 * ## Dois movimentos e uma linha que os liga
 *
 * O saldo é derivado da soma dos movimentos e sempre foi, então a transferência
 * **precisa** gerar dois. O que ela acrescenta é a linha que explica: sem ela,
 * "de onde veio este shampoo?" teria duas respostas independentes que alguém
 * dessincroniza — é a mesma decisão da transferência entre contas do bloco 51.
 */

export type MultiunidadeFailure =
  | 'mesma_unidade'
  | 'quantidade_invalida'
  | 'saldo_insuficiente'
  | 'unidade_fechada'
  | 'produto_nao_encontrado'
  | 'unidade_nao_encontrada';

export class MultiunidadeError extends Error {
  constructor(
    readonly code: MultiunidadeFailure,
    message: string,
  ) {
    super(message);
    this.name = 'MultiunidadeError';
  }
}

const MENSAGEM: Readonly<Record<MultiunidadeFailure, string>> = {
  mesma_unidade: 'Escolha duas unidades diferentes.',
  quantidade_invalida: 'A quantidade precisa ser maior que zero.',
  saldo_insuficiente: 'A unidade de origem não tem essa quantidade.',
  unidade_fechada: 'Não dá para movimentar estoque de uma unidade fechada.',
  produto_nao_encontrado: 'Este produto não existe.',
  unidade_nao_encontrada: 'Esta unidade não existe nesta barbearia.',
};

function recusar(code: MultiunidadeFailure): never {
  throw new MultiunidadeError(code, MENSAGEM[code]);
}

/**
 * O saldo de cada produto em cada loja, numa consulta só.
 *
 * A tela da transferência precisa de "quanto tem na origem" para todo produto e
 * toda loja de uma vez. Perguntar produto a produto seria N+1 sobre a tabela que
 * mais cresce do módulo — e é a consulta que o índice
 * `stock_movements_por_unidade_idx` existe para servir.
 *
 * Movimento sem unidade **não entra**: ele é anterior ao bloco 58 numa rede que
 * já tinha duas lojas, e atribuí-lo a uma delas aqui seria inventar de que loja
 * saiu o produto — com o número aparecendo como estoque transferível.
 */
export async function saldosPorUnidade(
  tenantId: string,
  autorizadas: readonly string[] = [],
): Promise<readonly { produtoId: string; unidadeId: string; saldo: number }[]> {
  const filtro = [...autorizadas];
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      { product_id: string; location_id: string; saldo: number }[]
    >`
      SELECT product_id, location_id, sum(quantity)::int AS saldo
        FROM stock_movements
       WHERE location_id IS NOT NULL
         AND (cardinality(${filtro}::uuid[]) = 0 OR location_id = ANY(${filtro}::uuid[]))
       GROUP BY product_id, location_id
    `;
    return linhas.map((l) => ({
      produtoId: l.product_id,
      unidadeId: l.location_id,
      saldo: Number(l.saldo),
    }));
  });
}

export interface TransferenciaDeEstoqueNaTela {
  readonly id: string;
  readonly produto: string;
  readonly deNome: string;
  readonly paraNome: string;
  readonly quantidade: number;
  readonly quando: string;
  readonly quem: string;
  readonly nota: string | null;
}

/**
 * O histórico, recortado pelas unidades que a pessoa administra.
 *
 * **Vazio significa todas**, como em todo o bloco. Sem o recorte, o gerente de
 * uma filial leria o vaivém de produto da rede inteira — que é o que
 * `staff_locations` existe para separar, e é o mesmo defeito que a revisão
 * apontou no `POST`.
 */
export async function transferenciasDaCasa(
  tenantId: string,
  autorizadas: readonly string[] = [],
  limite = 30,
): Promise<readonly TransferenciaDeEstoqueNaTela[]> {
  const filtro = [...autorizadas];
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        produto: string;
        de_nome: string;
        para_nome: string;
        quantity: number;
        created_at: Date;
        created_by_name: string;
        note: string | null;
      }[]
    >`
      SELECT t.id, p.name AS produto, o.name AS de_nome, d.name AS para_nome,
             t.quantity, t.created_at, t.created_by_name, t.note
        FROM stock_transfers t
        JOIN products p ON p.id = t.product_id
        JOIN locations o ON o.id = t.from_location_id
        JOIN locations d ON d.id = t.to_location_id
       WHERE cardinality(${filtro}::uuid[]) = 0
          OR t.from_location_id = ANY(${filtro}::uuid[])
          OR t.to_location_id = ANY(${filtro}::uuid[])
       ORDER BY t.created_at DESC
       LIMIT ${limite}
    `;
    return linhas.map((l) => ({
      id: l.id,
      produto: l.produto,
      deNome: l.de_nome,
      paraNome: l.para_nome,
      quantidade: l.quantity,
      quando: l.created_at.toISOString(),
      quem: l.created_by_name,
      nota: l.note,
    }));
  });
}

/**
 * Move produto de uma loja para outra.
 *
 * Tudo numa transação: a linha que explica e os dois movimentos que mexem no
 * saldo. Separá-los criaria o estado em que o produto saiu de uma loja e não
 * chegou na outra — e o saldo é derivado, então ninguém notaria além do buraco.
 *
 * A leitura do saldo trava a linha do produto (`FOR UPDATE`), porque é ela que
 * decide a gravação: sem a trava, duas transferências simultâneas da mesma loja
 * leem o mesmo saldo e as duas passam. O índice não pega isso — não há índice
 * sobre um saldo que é soma.
 */
export async function transferirEstoque(params: {
  readonly tenantId: string;
  readonly produtoId: string;
  readonly origemId: string;
  readonly destinoId: string;
  readonly quantidade: number;
  readonly nota?: string | null;
  readonly diaDaUnidade: string;
  /**
   * As unidades que quem transfere administra. **Vazio significa todas.**
   *
   * Mora aqui e não no controller de propósito: a RLS separa barbearias e não
   * separa lojas dentro de uma, e o segundo chamador desta função nasceria sem
   * a conferência se ela fosse da borda. Achado da `/security-review` do bloco
   * 58 — o id da unidade vem do corpo, e a lista do seletor não é guarda: ela
   * decide o que a tela **oferece**, não o que o `POST` aceita.
   */
  readonly autorizadas: readonly string[];
  readonly ator: { readonly id: string; readonly name: string };
}): Promise<{ readonly id: string }> {
  return withTenant(params.tenantId, async (tx) => {
    const produtos = await tx.$queryRaw<{ id: string; name: string; cost_cents: number }[]>`
      SELECT id, name, cost_cents FROM products
       WHERE id = ${params.produtoId}::uuid
       FOR UPDATE
    `;
    const produto = produtos[0];
    if (!produto) recusar('produto_nao_encontrado');

    const lojas = await tx.$queryRaw<{ id: string; active: boolean }[]>`
      SELECT id, active FROM locations
       WHERE id = ANY(ARRAY[${params.origemId}::uuid, ${params.destinoId}::uuid])
    `;
    const origem = lojas.find((l) => l.id === params.origemId);
    const destino = lojas.find((l) => l.id === params.destinoId);
    if (!origem || !destino) recusar('unidade_nao_encontrada');

    const podeOperar = (id: string) =>
      params.autorizadas.length === 0 || params.autorizadas.includes(id);
    /**
     * Recusa com **a mesma mensagem** de unidade inexistente.
     *
     * "Esta unidade existe, mas não é sua" confirmaria o id para quem o
     * adivinhou — e o id da unidade mais antiga sai na página pública. É o
     * precedente do OTP, que responde igual para telefone existente e
     * inexistente.
     */
    if (!podeOperar(params.origemId) || !podeOperar(params.destinoId)) {
      recusar('unidade_nao_encontrada');
    }

    /**
     * O saldo é **da unidade de origem**, não o global.
     *
     * Somar todos os movimentos do produto responderia "quanto a rede tem", e a
     * pergunta aqui é "quanto esta loja tem". Com o saldo global, a matriz
     * transferiria dez unidades que estão na filial.
     */
    const saldos = await tx.$queryRaw<{ saldo: number | null }[]>`
      SELECT sum(quantity)::int AS saldo FROM stock_movements
       WHERE product_id = ${params.produtoId}::uuid
         AND location_id = ${params.origemId}::uuid
    `;
    const saldoNaOrigem = Number(saldos[0]?.saldo ?? 0);

    const falha = validarTransferencia({
      origemId: params.origemId,
      destinoId: params.destinoId,
      quantidade: params.quantidade,
      saldoNaOrigem,
      origemAberta: origem.active,
      destinoAberta: destino.active,
    });
    if (falha) recusar(falha);

    const criadas = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO stock_transfers
        (tenant_id, product_id, from_location_id, to_location_id, quantity,
         unit_cost_cents, note, created_by, created_by_name)
      VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid,
              ${params.produtoId}::uuid, ${params.origemId}::uuid, ${params.destinoId}::uuid,
              ${params.quantidade}, ${produto.cost_cents}, ${params.nota?.trim() || null},
              ${params.ator.id}::uuid, ${params.ator.name})
      RETURNING id
    `;
    const criada = criadas[0];
    if (!criada) recusar('produto_nao_encontrado');

    /**
     * Os dois movimentos, com o **mesmo custo unitário**.
     *
     * Congelado desde o bloco 47: o produto sai de uma loja pelo custo que
     * tinha lá e entra na outra pelo mesmo. Sem isso, transferir mudaria a
     * margem das duas — a de origem ganharia e a de destino perderia, sem
     * ninguém ter comprado nada.
     */
    const motivo = `transferência ${criada.id}`;
    for (const [local, sinal] of [
      [params.origemId, -params.quantidade],
      [params.destinoId, params.quantidade],
    ] as const) {
      await tx.$executeRaw`
        INSERT INTO stock_movements
          (tenant_id, product_id, location_id, kind, quantity, unit_cost_cents,
           reason, staff_user_id, business_day)
        VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid,
                ${params.produtoId}::uuid, ${local}::uuid, 'transferencia',
                ${sinal}, ${produto.cost_cents}, ${motivo},
                ${params.ator.id}::uuid, ${params.diaDaUnidade}::date)
      `;
    }

    await audit(tx, {
      actorId: params.ator.id,
      actorName: params.ator.name,
      action: 'stock.transferred',
      entity: 'stock_transfers',
      entityId: criada.id,
      after: { produto: produto.name, quantidade: params.quantidade },
    });

    return { id: criada.id };
  });
}
