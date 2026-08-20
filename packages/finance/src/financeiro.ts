import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  contaVencida,
  fraseDoPrazo,
  podeQuitar,
  resumoDoFinanceiro,
  validarConta,
  validarLimiteDeFiado,
  type DirecaoDaConta,
  type EstadoDaConta,
  type ResumoDoFinanceiro,
} from '@barbearia/core';
import { audit } from '@barbearia/identity';
import { lancarNoExtrato } from './comanda.js';

/**
 * Financeiro, do banco para a tela (bloco 51, SPEC §3.10).
 *
 * A regra mora em `packages/core`. Aqui se carrega, se chama o domínio e se
 * grava — e a parte que só existe aqui é a **conciliação**: quando a conta é
 * paga pela gaveta, o movimento de caixa nasce na mesma transação e as duas
 * linhas apontam uma para a outra.
 *
 * ## O id que vem do corpo é conferido sob RLS
 *
 * `category_id` e `account_id` chegam da requisição, e a checagem de integridade
 * referencial do Postgres **ignora row security**: a chave estrangeira aceitaria
 * o id de uma categoria de outra barbearia. Toda gravação que os recebe faz um
 * `SELECT` sob a política antes — é a mesma lição do bloco 39.
 */

export type FinanceiroFailure =
  | 'conta_nao_encontrada'
  | 'conta_nao_aberta'
  | 'valor_invalido'
  | 'valor_pago_invalido'
  | 'descricao_obrigatoria'
  | 'vencimento_invalido'
  | 'categoria_invalida'
  | 'conta_bancaria_invalida'
  | 'direcao_incompativel'
  | 'mesma_conta'
  | 'cliente_nao_encontrado'
  | 'motivo_obrigatorio'
  | 'nome_repetido'
  | 'ja_tem_extrato'
  | 'gaveta_ja_existe';

export class FinanceiroError extends Error {
  constructor(readonly code: FinanceiroFailure, message: string) {
    super(message);
    this.name = 'FinanceiroError';
  }
}

const MENSAGEM: Readonly<Record<FinanceiroFailure, string>> = {
  conta_nao_encontrada: 'Esta conta não existe.',
  conta_nao_aberta: 'Esta conta já foi paga ou cancelada.',
  valor_invalido: 'Confira o valor.',
  valor_pago_invalido: 'Informe quanto foi pago, em reais.',
  descricao_obrigatoria: 'Diga do que é a conta.',
  vencimento_invalido: 'Confira a data de vencimento.',
  categoria_invalida: 'Esta categoria não existe.',
  conta_bancaria_invalida: 'Esta conta não existe.',
  direcao_incompativel: 'A categoria não serve para este tipo de conta.',
  mesma_conta: 'Escolha duas contas diferentes.',
  cliente_nao_encontrado: 'Cliente não encontrado.',
  motivo_obrigatorio: 'Escreva o motivo.',
  nome_repetido: 'Já existe uma com esse nome.',
  ja_tem_extrato:
    'Este cliente já tem movimento no fiado. O saldo inicial só vale para quem ainda não tem nenhum.',
  gaveta_ja_existe: 'Esta loja já tem uma gaveta. Cada unidade tem uma só.',
};

function recusar(code: FinanceiroFailure): never {
  throw new FinanceiroError(code, MENSAGEM[code]);
}

// ---------------------------------------------------------------------------
// Categorias e contas (onde o dinheiro está)
// ---------------------------------------------------------------------------

export interface CategoriaFinanceira {
  readonly id: string;
  readonly nome: string;
  readonly direcao: DirecaoDaConta;
  readonly ativa: boolean;
}

export async function categoriasFinanceiras(
  tenantId: string,
  tx?: TransactionClient,
): Promise<readonly CategoriaFinanceira[]> {
  const dentro = async (t: TransactionClient) => {
    const linhas = await t.$queryRaw<
      { id: string; name: string; direction: DirecaoDaConta; active: boolean }[]
    >`
      SELECT id, name, direction, active FROM financial_categories
       ORDER BY direction, lower(name)
    `;
    return linhas.map((l) => ({
      id: l.id,
      nome: l.name,
      direcao: l.direction,
      ativa: l.active,
    }));
  };
  return tx ? dentro(tx) : withTenant(tenantId, dentro);
}

export async function criarCategoriaFinanceira(params: {
  readonly tenantId: string;
  readonly nome: string;
  readonly direcao: DirecaoDaConta;
}): Promise<CategoriaFinanceira> {
  const nome = params.nome.trim();
  if (nome.length < 2) recusar('descricao_obrigatoria');

  return withTenant(params.tenantId, async (tx) => {
    const repetida = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM financial_categories
       WHERE direction = ${params.direcao}::bill_direction
         AND lower(btrim(name)) = lower(btrim(${nome}))
    `;
    if (repetida.length > 0) recusar('nome_repetido');

    const linhas = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO financial_categories (tenant_id, name, direction)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${nome}, ${params.direcao}::bill_direction
      )
      RETURNING id
    `;
    const criada = linhas[0];
    if (!criada) recusar('categoria_invalida');
    return { id: criada.id, nome, direcao: params.direcao, ativa: true };
  });
}

export async function arquivarCategoriaFinanceira(params: {
  readonly tenantId: string;
  readonly categoriaId: string;
  readonly ativa: boolean;
}): Promise<void> {
  await withTenant(params.tenantId, async (tx) => {
    const afetadas = await tx.$executeRaw`
      UPDATE financial_categories SET active = ${params.ativa}
       WHERE id = ${params.categoriaId}::uuid
    `;
    if (afetadas === 0) recusar('categoria_invalida');
  });
}

export interface ContaBancaria {
  readonly id: string;
  readonly nome: string;
  readonly ehGaveta: boolean;
  readonly locationId: string | null;
  readonly ativa: boolean;
}

export async function contasFinanceiras(
  tenantId: string,
  tx?: TransactionClient,
): Promise<readonly ContaBancaria[]> {
  const dentro = async (t: TransactionClient) => {
    const linhas = await t.$queryRaw<
      { id: string; name: string; is_cash: boolean; location_id: string | null; active: boolean }[]
    >`
      SELECT id, name, is_cash, location_id, active FROM financial_accounts
       ORDER BY is_cash DESC, lower(name)
    `;
    return linhas.map((l) => ({
      id: l.id,
      nome: l.name,
      ehGaveta: l.is_cash,
      locationId: l.location_id,
      ativa: l.active,
    }));
  };
  return tx ? dentro(tx) : withTenant(tenantId, dentro);
}

export async function criarContaFinanceira(params: {
  readonly tenantId: string;
  readonly nome: string;
  /** A gaveta de uma unidade. Sem unidade, é conta do negócio (banco, cofre). */
  readonly locationId?: string | null;
  /**
   * As lojas que o ator opera. Vazio significa **todas**, como em
   * `staff_locations` — e a lista sai do banco, nunca do corpo.
   */
  readonly autorizadas: readonly string[];
  readonly ehGaveta?: boolean;
}): Promise<ContaBancaria> {
  const nome = params.nome.trim();
  if (nome.length < 2) recusar('descricao_obrigatoria');
  const ehGaveta = params.ehGaveta ?? false;
  if (ehGaveta && !params.locationId) recusar('conta_bancaria_invalida');

  /**
   * A unidade do corpo precisa estar entre as que o ator opera — e a
   * conferência vem **antes** de qualquer consulta que fale sobre aquela loja.
   *
   * `EXISTS (SELECT 1 FROM locations ...)` confere que a loja existe nesta
   * barbearia; a RLS faz esse recorte e não separa lojas dentro de uma. A
   * gerente escopada à filial criava "Conta do Bradesco da matriz" mandando o
   * id no corpo, e recebia 201.
   *
   * A ordem importa: embaixo da conferência de gaveta duplicada, ela devolvia
   * "esta loja já tem uma gaveta" para uma loja que a pessoa não opera — duas
   * mensagens onde a convenção manda uma. E qualquer conferência nova que
   * entrasse acima herdaria o oráculo. Achado da `/security-review`.
   *
   * Lista vazia significa "todas", como em todo o resto de `staff_locations`, e
   * `null` é a conta que vale para a rede.
   */
  if (
    params.locationId &&
    params.autorizadas.length > 0 &&
    !params.autorizadas.includes(params.locationId)
  ) {
    recusar('conta_bancaria_invalida');
  }

  return withTenant(params.tenantId, async (tx) => {
    const repetida = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM financial_accounts
       WHERE lower(btrim(name)) = lower(btrim(${nome}))
    `;
    if (repetida.length > 0) recusar('nome_repetido');

    /**
     * Uma gaveta por loja, conferida **antes** do `INSERT`.
     *
     * O índice único parcial `financial_accounts (location_id) WHERE is_cash`
     * garante a regra, e sozinho ele a entregava como **500 "Erro interno"**:
     * entrada válida que bate em constraint tem que ser 400 com motivo, e é a
     * regra de borda deste repositório desde o telefone brasileiro do bloco 1.
     */
    if (ehGaveta && params.locationId) {
      const gaveta = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM financial_accounts
         WHERE is_cash AND location_id = ${params.locationId}::uuid
      `;
      if (gaveta.length > 0) recusar('gaveta_ja_existe');
    }

    // Conferida sob RLS: a chave estrangeira aceitaria a unidade de outra
    // barbearia, porque a checagem referencial ignora row security.
    const linhas = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO financial_accounts (tenant_id, location_id, name, is_cash)
      SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid,
             ${params.locationId ?? null}::uuid, ${nome}, ${ehGaveta}
       WHERE ${params.locationId ?? null}::uuid IS NULL
          OR EXISTS (SELECT 1 FROM locations WHERE id = ${params.locationId ?? null}::uuid)
      RETURNING id
    `;
    const criada = linhas[0];
    if (!criada) recusar('conta_bancaria_invalida');
    return {
      id: criada.id,
      nome,
      ehGaveta,
      locationId: params.locationId ?? null,
      ativa: true,
    };
  });
}

// ---------------------------------------------------------------------------
// As contas a pagar e a receber
// ---------------------------------------------------------------------------

export interface ContaDoFinanceiroNaTela {
  readonly id: string;
  readonly direcao: DirecaoDaConta;
  readonly descricao: string;
  readonly valorCents: number;
  readonly vencimentoEm: string;
  readonly estado: EstadoDaConta;
  readonly pagaEm: string | null;
  readonly valorPagoCents: number | null;
  readonly categoriaId: string | null;
  readonly categoriaNome: string | null;
  readonly contaId: string | null;
  readonly contaNome: string | null;
  readonly observacao: string | null;
  readonly pagaPelaGaveta: boolean;
  readonly vencida: boolean;
  readonly prazo: string;
  readonly criadaPor: string;
}

export interface AgendaDoFinanceiro {
  readonly contas: readonly ContaDoFinanceiroNaTela[];
  readonly resumo: ResumoDoFinanceiro;
  /** O dia da unidade, que é o que decide o que está vencido. */
  readonly hoje: string;
}

/**
 * A lista que abre a tela.
 *
 * Uma consulta só, com os nomes de categoria e conta já juntados: um laço que
 * fosse buscar o nome de cada categoria seria N+1 numa tela que abre trinta
 * linhas por vez.
 *
 * O recorte padrão é **o que está em aberto**, e não "os últimos trinta dias":
 * a pergunta desta tela é o que ainda vai acontecer com o dinheiro, e uma conta
 * que venceu há três meses e ninguém pagou é justamente a que não pode sumir
 * do recorte.
 */
export async function agendaDoFinanceiro(params: {
  readonly tenantId: string;
  readonly locationId: string;
  /** `YYYY-MM-DD` no fuso da unidade — nunca o do processo. */
  readonly hoje: string;
  readonly direcao?: DirecaoDaConta | null;
  readonly incluirFechadas?: boolean;
}): Promise<AgendaDoFinanceiro> {
  return withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        direction: DirecaoDaConta;
        description: string;
        amount_cents: number;
        due_on: Date;
        status: EstadoDaConta;
        paid_on: Date | null;
        paid_cents: number | null;
        category_id: string | null;
        categoria: string | null;
        account_id: string | null;
        conta: string | null;
        note: string | null;
        cash_movement_id: string | null;
        created_by_name: string;
      }[]
    >`
      SELECT b.id, b.direction, b.description, b.amount_cents, b.due_on, b.status,
             b.paid_on, b.paid_cents, b.category_id, c.name AS categoria,
             b.account_id, a.name AS conta, b.note, b.cash_movement_id,
             b.created_by_name
        FROM bills b
        LEFT JOIN financial_categories c ON c.id = b.category_id
        LEFT JOIN financial_accounts a ON a.id = b.account_id
       WHERE b.location_id = ${params.locationId}::uuid
         AND (${params.incluirFechadas ?? false} OR b.status = 'aberta')
         AND (${params.direcao ?? null}::bill_direction IS NULL
              OR b.direction = ${params.direcao ?? null}::bill_direction)
       ORDER BY b.status, b.due_on, lower(b.description)
       LIMIT 400
    `;

    const contas = linhas.map((l) => {
      const vencimentoEm = diaSimples(l.due_on);
      const nucleo = { estado: l.status, vencimentoEm };
      return {
        id: l.id,
        direcao: l.direction,
        descricao: l.description,
        valorCents: l.amount_cents,
        vencimentoEm,
        estado: l.status,
        pagaEm: l.paid_on ? diaSimples(l.paid_on) : null,
        valorPagoCents: l.paid_cents,
        categoriaId: l.category_id,
        categoriaNome: l.categoria,
        contaId: l.account_id,
        contaNome: l.conta,
        observacao: l.note,
        pagaPelaGaveta: l.cash_movement_id !== null,
        vencida: contaVencida(nucleo, params.hoje),
        prazo: fraseDoPrazo(vencimentoEm, params.hoje),
        criadaPor: l.created_by_name,
      };
    });

    return {
      contas,
      resumo: resumoDoFinanceiro(contas, params.hoje),
      hoje: params.hoje,
    };
  });
}

/** `date` do Postgres chega como `Date` à meia-noite UTC. O dia é o que importa. */
function diaSimples(valor: Date | string): string {
  return typeof valor === 'string' ? valor.slice(0, 10) : valor.toISOString().slice(0, 10);
}

export async function criarContaDoFinanceiro(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly direcao: DirecaoDaConta;
  readonly descricao: string;
  readonly valorCents: number;
  readonly vencimentoEm: string;
  readonly categoriaId?: string | null;
  readonly contaId?: string | null;
  readonly observacao?: string | null;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<{ readonly id: string }> {
  const falha = validarConta({
    descricao: params.descricao,
    valorCents: params.valorCents,
    vencimentoEm: params.vencimentoEm,
  });
  if (falha) recusar(falha);

  return withTenant(params.tenantId, async (tx) => {
    await conferirClassificacao(tx, {
      direcao: params.direcao,
      categoriaId: params.categoriaId ?? null,
      contaId: params.contaId ?? null,
      locationId: params.locationId ?? null,
    });

    const linhas = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO bills
        (tenant_id, location_id, direction, description, category_id, account_id,
         amount_cents, due_on, note, created_by, created_by_name)
      SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid,
             ${params.locationId}::uuid, ${params.direcao}::bill_direction,
             ${params.descricao.trim()}, ${params.categoriaId ?? null}::uuid,
             ${params.contaId ?? null}::uuid, ${params.valorCents},
             ${params.vencimentoEm}::date, ${params.observacao?.trim() || null},
             ${params.staffId}::uuid, ${params.staffName}
       WHERE EXISTS (SELECT 1 FROM locations WHERE id = ${params.locationId}::uuid)
      RETURNING id
    `;
    const criada = linhas[0];
    if (!criada) recusar('conta_nao_encontrada');

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'bill.created',
      entity: 'bill',
      entityId: criada.id,
      after: {
        direcao: params.direcao,
        descricao: params.descricao.trim(),
        valorCents: params.valorCents,
        vencimentoEm: params.vencimentoEm,
      },
    });

    return { id: criada.id };
  });
}

/**
 * A categoria e a conta vêm do corpo, então são conferidas sob RLS.
 *
 * E não basta existir: a categoria carrega direção, e uma despesa classificada
 * como receita entra no DRE do bloco 52 com o sinal trocado — um erro que não
 * aparece em lugar nenhum até o resultado do mês estar errado.
 */
async function conferirClassificacao(
  tx: TransactionClient,
  params: {
    readonly direcao: DirecaoDaConta;
    readonly categoriaId: string | null;
    readonly contaId: string | null;
    /** A loja da conta a pagar/receber, para casar com a da conta bancária. */
    readonly locationId: string | null;
  },
): Promise<void> {
  if (params.categoriaId) {
    const linhas = await tx.$queryRaw<{ direction: DirecaoDaConta }[]>`
      SELECT direction FROM financial_categories WHERE id = ${params.categoriaId}::uuid
    `;
    const categoria = linhas[0];
    if (!categoria) recusar('categoria_invalida');
    if (categoria.direction !== params.direcao) recusar('direcao_incompativel');
  }

  if (params.contaId) {
    /**
     * A conta é da loja da conta a pagar, ou da rede (`location_id` nulo).
     *
     * Sem a segunda condição, uma conta a pagar da filial era gravada apontando
     * para a conta bancária da matriz: o pagamento sairia de uma gaveta e a
     * dívida estaria registrada na outra loja.
     */
    const linhas = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM financial_accounts
       WHERE id = ${params.contaId}::uuid
         AND (location_id IS NULL OR location_id = ${params.locationId ?? null}::uuid)
    `;
    if (linhas.length === 0) recusar('conta_bancaria_invalida');
  }
}

/**
 * Paga (ou recebida), e a gaveta sabe.
 *
 * A trava é `FOR UPDATE` na leitura que decide a gravação: sem ela, dois toques
 * do balcão em aparelhos diferentes leem "aberta" os dois e gravam os dois, com
 * duas saídas de caixa para uma conta só. É a mesma lição do pacote no bloco 43.
 *
 * Quando `pelaGaveta`, o movimento de caixa nasce **dentro desta transação** e a
 * conta guarda o id dele. Gravar depois abriria a janela em que a conta consta
 * paga e o fechamento do dia não enxerga o dinheiro que saiu.
 */
export async function quitarContaDoFinanceiro(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly contaId: string;
  readonly valorPagoCents: number;
  /** `YYYY-MM-DD` no fuso da unidade. */
  readonly pagaEm: string;
  readonly pelaGaveta: boolean;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<void> {
  await withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        direction: DirecaoDaConta;
        description: string;
        amount_cents: number;
        status: EstadoDaConta;
      }[]
    >`
      SELECT id, direction, description, amount_cents, status
        FROM bills
       WHERE id = ${params.contaId}::uuid AND location_id = ${params.locationId}::uuid
       FOR UPDATE
    `;
    const conta = linhas[0];
    if (!conta) recusar('conta_nao_encontrada');

    const falha = podeQuitar({
      estado: conta.status,
      valorPagoCents: params.valorPagoCents,
    });
    if (falha) recusar(falha === 'conta_nao_aberta' ? 'conta_nao_aberta' : 'valor_pago_invalido');

    let movimentoId: string | null = null;
    if (params.pelaGaveta) {
      movimentoId = await movimentoDaConta(tx, {
        locationId: params.locationId,
        direcao: conta.direction,
        valorCents: params.valorPagoCents,
        descricao: conta.description,
        staffId: params.staffId,
        staffName: params.staffName,
      });
    }

    await tx.$executeRaw`
      UPDATE bills
         SET status = 'paga',
             paid_on = ${params.pagaEm}::date,
             paid_cents = ${params.valorPagoCents},
             cash_movement_id = ${movimentoId}::uuid
       WHERE id = ${params.contaId}::uuid
    `;

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: conta.direction === 'pagar' ? 'bill.paid' : 'bill.received',
      entity: 'bill',
      entityId: params.contaId,
      before: { valorCents: conta.amount_cents, estado: conta.status },
      after: {
        valorPagoCents: params.valorPagoCents,
        pagaEm: params.pagaEm,
        pelaGaveta: params.pelaGaveta,
      },
    });
  });
}

/**
 * O dinheiro que entra ou sai da gaveta por causa de uma conta.
 *
 * Exige caixa aberto pelo mesmo motivo que a venda exige desde o bloco 18: sem
 * gaveta, a divergência do fechamento não tem dono. E a saída é conferida
 * contra o que existe — gaveta negativa não é estado do mundo.
 */
async function movimentoDaConta(
  tx: TransactionClient,
  params: {
    readonly locationId: string;
    readonly direcao: DirecaoDaConta;
    readonly valorCents: number;
    readonly descricao: string;
    readonly staffId: string;
    readonly staffName: string;
  },
): Promise<string> {
  const sessoes = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM cash_sessions
     WHERE location_id = ${params.locationId}::uuid AND status = 'open'
     FOR UPDATE
  `;
  const sessao = sessoes[0];
  if (!sessao) {
    throw new FinanceiroError(
      'valor_invalido',
      'Não há caixa aberto. Abra o caixa ou marque que o pagamento foi por fora dela.',
    );
  }

  const saindo = params.direcao === 'pagar';
  if (saindo) {
    const somas = await tx.$queryRaw<{ total: number | null }[]>`
      SELECT sum(amount_cents)::int AS total FROM cash_movements
       WHERE session_id = ${sessao.id}::uuid
    `;
    const naGaveta = somas[0]?.total ?? 0;
    if (params.valorCents > naGaveta) {
      throw new FinanceiroError(
        'valor_pago_invalido',
        `Não há esse valor na gaveta. Disponível agora: ${naGaveta} centavos.`,
      );
    }
  }

  const linhas = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO cash_movements
      (tenant_id, session_id, kind, amount_cents, reason, created_by, created_by_name)
    VALUES (
      NULLIF(current_setting('app.tenant_id', true), '')::uuid,
      ${sessao.id}::uuid,
      ${saindo ? 'bill_payment' : 'bill_receipt'}::cash_movement_type,
      ${saindo ? -params.valorCents : params.valorCents},
      ${params.descricao},
      ${params.staffId}::uuid, ${params.staffName}
    )
    RETURNING id
  `;
  const movimento = linhas[0];
  if (!movimento) recusar('valor_invalido');
  return movimento.id;
}

export async function cancelarContaDoFinanceiro(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly contaId: string;
  readonly motivo: string;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<void> {
  const motivo = params.motivo.trim();
  if (motivo.length < 3) recusar('motivo_obrigatorio');

  await withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ status: EstadoDaConta; amount_cents: number }[]>`
      SELECT status, amount_cents FROM bills
       WHERE id = ${params.contaId}::uuid AND location_id = ${params.locationId}::uuid
       FOR UPDATE
    `;
    const conta = linhas[0];
    if (!conta) recusar('conta_nao_encontrada');
    if (conta.status !== 'aberta') recusar('conta_nao_aberta');

    await tx.$executeRaw`
      UPDATE bills SET status = 'cancelada', note = ${motivo}
       WHERE id = ${params.contaId}::uuid
    `;

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'bill.cancelled',
      entity: 'bill',
      entityId: params.contaId,
      before: { valorCents: conta.amount_cents },
      after: { motivo },
    });
  });
}

// ---------------------------------------------------------------------------
// Transferência entre contas
// ---------------------------------------------------------------------------

/**
 * O dinheiro mudou de lugar sem mudar de dono.
 *
 * Quando sai da gaveta, sai como **sangria** — que é o que ela é, e é assim que
 * o fechamento do dia já a enxerga desde o bloco 18. O que este bloco conserta é
 * o outro lado: até aqui a sangria era uma saída que sumia, e agora ela chega em
 * algum lugar.
 */
export async function transferirEntreContas(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly deContaId: string;
  readonly paraContaId: string;
  readonly valorCents: number;
  readonly quandoEm: string;
  readonly observacao?: string | null;
  readonly idempotencyKey?: string;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<{ readonly id: string }> {
  if (!Number.isInteger(params.valorCents) || params.valorCents <= 0) recusar('valor_invalido');
  if (params.deContaId === params.paraContaId) recusar('mesma_conta');

  return withTenant(params.tenantId, async (tx) => {
    if (params.idempotencyKey) {
      const jaFeita = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM account_transfers
         WHERE idempotency_key = ${params.idempotencyKey}
      `;
      const anterior = jaFeita[0];
      if (anterior) return { id: anterior.id };
    }

    /**
     * As duas de uma vez, e a **contagem** tem que bater: somar uma conta
     * legítima com uma de outra barbearia daria uma linha só, e um `length > 0`
     * aceitaria a transferência para fora do tenant.
     */
    const contas = await tx.$queryRaw<
      { id: string; is_cash: boolean; location_id: string | null }[]
    >`
      SELECT id, is_cash, location_id FROM financial_accounts
       WHERE id IN (${params.deContaId}::uuid, ${params.paraContaId}::uuid)
    `;
    if (contas.length !== 2) recusar('conta_bancaria_invalida');

    const origem = contas.find((c) => c.id === params.deContaId);
    const destino = contas.find((c) => c.id === params.paraContaId);
    if (!origem || !destino) recusar('conta_bancaria_invalida');

    /**
     * A gaveta é de uma unidade, e a sessão de caixa que vai receber o
     * movimento é a **desta** unidade. Sem a conferência, uma rede com duas
     * lojas tiraria o dinheiro da gaveta de uma pela sessão da outra: as duas
     * fechariam erradas, uma com sobra e a outra com falta.
     */
    for (const conta of [origem, destino]) {
      if (conta.is_cash && conta.location_id !== params.locationId) {
        recusar('conta_bancaria_invalida');
      }
    }

    let movimentoId: string | null = null;
    if (origem.is_cash) {
      movimentoId = await movimentoDaTransferencia(tx, {
        locationId: params.locationId,
        valorCents: -params.valorCents,
        staffId: params.staffId,
        staffName: params.staffName,
      });
    }

    /**
     * O outro lado, quando o destino é a gaveta.
     *
     * A primeira versão só registrava a saída, e por isso o dinheiro depositado
     * **na** gaveta entrava na lista de transferências e sumia do fechamento —
     * a conferência do dia acusaria sobra que ninguém explica. Achado da revisão
     * de segurança deste bloco.
     */
    if (destino.is_cash) {
      await movimentoDaTransferencia(tx, {
        locationId: params.locationId,
        valorCents: params.valorCents,
        staffId: params.staffId,
        staffName: params.staffName,
      });
    }

    const linhas = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO account_transfers
        (tenant_id, location_id, from_account_id, to_account_id, amount_cents,
         happened_on, note, cash_movement_id, idempotency_key, created_by,
         created_by_name)
      SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid,
             ${params.locationId}::uuid, ${params.deContaId}::uuid,
             ${params.paraContaId}::uuid, ${params.valorCents},
             ${params.quandoEm}::date, ${params.observacao?.trim() || null},
             ${movimentoId}::uuid, ${params.idempotencyKey ?? null},
             ${params.staffId}::uuid, ${params.staffName}
       WHERE EXISTS (SELECT 1 FROM locations WHERE id = ${params.locationId}::uuid)
      RETURNING id
    `;
    const criada = linhas[0];
    if (!criada) recusar('conta_bancaria_invalida');

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'account.transferred',
      entity: 'account_transfer',
      entityId: criada.id,
      after: {
        deContaId: params.deContaId,
        paraContaId: params.paraContaId,
        valorCents: params.valorCents,
        quandoEm: params.quandoEm,
      },
    });

    return { id: criada.id };
  });
}

/**
 * O lado da gaveta numa transferência.
 *
 * Sangria quando sai, suprimento quando entra — que é o que os dois tipos já
 * significam desde o bloco 18. `valorCents` chega com sinal, e é ele que decide
 * qual dos dois: um parâmetro booleano a mais faria a mesma coisa com uma
 * chance de discordar do sinal gravado.
 */
async function movimentoDaTransferencia(
  tx: TransactionClient,
  params: {
    readonly locationId: string;
    readonly valorCents: number;
    readonly staffId: string;
    readonly staffName: string;
  },
): Promise<string> {
  const sessoes = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM cash_sessions
     WHERE location_id = ${params.locationId}::uuid AND status = 'open'
     FOR UPDATE
  `;
  const sessao = sessoes[0];
  if (!sessao) {
    throw new FinanceiroError(
      'valor_invalido',
      'Não há caixa aberto. Abra o caixa antes de mexer no dinheiro da gaveta.',
    );
  }

  if (params.valorCents < 0) {
    const somas = await tx.$queryRaw<{ total: number | null }[]>`
      SELECT sum(amount_cents)::int AS total FROM cash_movements
       WHERE session_id = ${sessao.id}::uuid
    `;
    const naGaveta = somas[0]?.total ?? 0;
    if (-params.valorCents > naGaveta) {
      throw new FinanceiroError(
        'valor_invalido',
        `Não há esse valor na gaveta. Disponível agora: ${naGaveta} centavos.`,
      );
    }
  }

  const linhas = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO cash_movements
      (tenant_id, session_id, kind, amount_cents, reason, created_by, created_by_name)
    VALUES (
      NULLIF(current_setting('app.tenant_id', true), '')::uuid,
      ${sessao.id}::uuid,
      ${params.valorCents < 0 ? 'withdrawal' : 'supply'}::cash_movement_type,
      ${params.valorCents},
      'Transferência entre contas', ${params.staffId}::uuid, ${params.staffName}
    )
    RETURNING id
  `;
  const movimento = linhas[0];
  if (!movimento) recusar('valor_invalido');
  return movimento.id;
}

export interface TransferenciaNaTela {
  readonly id: string;
  readonly deNome: string;
  readonly paraNome: string;
  readonly valorCents: number;
  readonly quandoEm: string;
  readonly observacao: string | null;
  readonly criadaPor: string;
}

export async function transferenciasRecentes(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly limite?: number;
}): Promise<readonly TransferenciaNaTela[]> {
  return withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        de: string;
        para: string;
        amount_cents: number;
        happened_on: Date;
        note: string | null;
        created_by_name: string;
      }[]
    >`
      SELECT t.id, o.name AS de, d.name AS para, t.amount_cents, t.happened_on,
             t.note, t.created_by_name
        FROM account_transfers t
        JOIN financial_accounts o ON o.id = t.from_account_id
        JOIN financial_accounts d ON d.id = t.to_account_id
       WHERE t.location_id = ${params.locationId}::uuid
       ORDER BY t.happened_on DESC, t.created_at DESC
       LIMIT ${Math.min(params.limite ?? 20, 100)}
    `;
    return linhas.map((l) => ({
      id: l.id,
      deNome: l.de,
      paraNome: l.para,
      valorCents: l.amount_cents,
      quandoEm: diaSimples(l.happened_on),
      observacao: l.note,
      criadaPor: l.created_by_name,
    }));
  });
}

// ---------------------------------------------------------------------------
// Fiado: o limite e o saldo herdado
// ---------------------------------------------------------------------------

/**
 * O teto de crédito de um cliente.
 *
 * A coluna existe desde o bloco 18 e **nasceu em zero sem nenhuma rota que a
 * escrevesse**: toda venda fiada era recusada por estourar um limite que ninguém
 * conseguia levantar. Era o defeito de `blocks` de novo — o motor aceitava a
 * entrada e a origem do dado não existia.
 */
export interface FiadoDoCliente {
  /** Negativo é dívida, como em todo o produto desde o bloco 18. */
  readonly saldoCents: number;
  readonly limiteCents: number;
}

/**
 * O que a ficha do cliente mostra antes de mexer no limite.
 *
 * Rota própria e não um campo a mais na ficha: a ficha é `customers.view`, que a
 * recepção tem, e saldo e limite são dinheiro. Enfiá-los ali obrigaria a ficha
 * inteira a exigir `finance.view` — e a recepção deixaria de achar o cliente.
 */
export async function fiadoDoCliente(
  tenantId: string,
  customerId: string,
): Promise<FiadoDoCliente> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ balance_cents: number; credit_limit_cents: number }[]>`
      SELECT balance_cents, credit_limit_cents FROM customers
       WHERE id = ${customerId}::uuid
    `;
    const linha = linhas[0];
    if (!linha) recusar('cliente_nao_encontrado');
    return { saldoCents: linha.balance_cents, limiteCents: linha.credit_limit_cents };
  });
}

export async function definirLimiteDeFiado(params: {
  readonly tenantId: string;
  readonly customerId: string;
  readonly limiteCents: number;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<{ readonly limiteCents: number }> {
  const falha = validarLimiteDeFiado(params.limiteCents);
  if (falha) recusar('valor_invalido');

  return withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ credit_limit_cents: number }[]>`
      SELECT credit_limit_cents FROM customers
       WHERE id = ${params.customerId}::uuid
       FOR UPDATE
    `;
    const antes = linhas[0];
    if (!antes) recusar('cliente_nao_encontrado');

    await tx.$executeRaw`
      UPDATE customers SET credit_limit_cents = ${params.limiteCents}
       WHERE id = ${params.customerId}::uuid
    `;

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'debt.limit_changed',
      entity: 'customer',
      entityId: params.customerId,
      before: { limiteCents: antes.credit_limit_cents },
      after: { limiteCents: params.limiteCents },
    });

    return { limiteCents: params.limiteCents };
  });
}

/**
 * O que o cliente já devia antes de o produto existir.
 *
 * É como se traz o fiado em aberto do sistema antigo, e é **uma linha por
 * pessoa, digitada com o motivo** — não uma coluna numa planilha. A importação
 * de base traz nome, telefone e aniversário; dinheiro não entra por ali de
 * propósito, pela mesma razão que consentimento de marketing não entra: uma
 * coluna mal mapeada criaria mil e duzentas dívidas sem nenhum porquê escrito,
 * e o extrato do fiado é exatamente o documento que precisa explicar cada
 * centavo quando o cliente discorda.
 *
 * O lançamento é `adjustment` no razão que já existe desde o bloco 18 — não uma
 * segunda tabela de saldo inicial. Duas fontes para "quanto ele deve" é o que a
 * SPEC §3.5 proíbe em letras.
 */
export async function lancarSaldoInicialDeFiado(params: {
  readonly tenantId: string;
  readonly customerId: string;
  /** Quanto a pessoa **deve**, em centavos positivos. O sinal é do domínio. */
  readonly deveCents: number;
  readonly motivo: string;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<{ readonly saldoCents: number }> {
  if (!Number.isInteger(params.deveCents) || params.deveCents <= 0) recusar('valor_invalido');
  const motivo = params.motivo.trim();
  if (motivo.length < 3) recusar('motivo_obrigatorio');

  return withTenant(params.tenantId, async (tx) => {
    const existe = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM customers WHERE id = ${params.customerId}::uuid FOR UPDATE
    `;
    if (existe.length === 0) recusar('cliente_nao_encontrado');

    /**
     * O toque duplo é barrado pelo **estado**, não por chave de idempotência.
     *
     * "Saldo inicial" é por definição a primeira linha do extrato: quem já tem
     * lançamento não tem saldo inicial, tem histórico. A guarda é mais forte que
     * uma chave gerada pelo cliente — ela segura o segundo toque de outro
     * aparelho, de outra sessão e com chave nova, que é o que uma chave livre não
     * garante. É o precedente de `deposit_paid_cents = 0` no bloco 37.
     *
     * A leitura decide a gravação, e por isso a linha de `customers` já está
     * travada acima: sem a trava, dois pedidos leem o extrato vazio e gravam os
     * dois.
     */
    const jaTemExtrato = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM customer_ledger
       WHERE customer_id = ${params.customerId}::uuid
       LIMIT 1
    `;
    if (jaTemExtrato.length > 0) recusar('ja_tem_extrato');

    // Negativo aumenta a dívida: é o mesmo sinal do saldo desde o bloco 18.
    const saldo = await lancarNoExtrato(tx, {
      customerId: params.customerId,
      kind: 'adjustment',
      amountCents: -params.deveCents,
      note: motivo,
      staffId: params.staffId,
      staffName: params.staffName,
    });

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'debt.opening_balance',
      entity: 'customer',
      entityId: params.customerId,
      /**
       * O tamanho do motivo, nunca o texto.
       *
       * Ele é escrito **sobre um cliente** ("devia desde a mudança do salão"),
       * e a cópia dele mora em `customer_ledger.note`, que `anonimizar_cliente`
       * limpa. A de `audit_log` não seria limpa por nada: a tabela é
       * append-only, a anonimização não a alcança e a exportação do titular a
       * deixa de fora de propósito.
       */
      after: { deveCents: params.deveCents, caracteresDoMotivo: motivo.length, saldoCents: saldo },
    });

    return { saldoCents: saldo };
  });
}
