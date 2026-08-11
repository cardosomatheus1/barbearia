import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  PROGRAMA_DESLIGADO,
  acumuloDaVenda,
  podeResgatar,
  quantidadeAExpirar,
  saldoDisponivel,
  valorDoResgate,
  vencimentoDoAcumulo,
  type LancamentoDeFidelidade,
  type ModoDeFidelidade,
  type ProgramaDeFidelidade,
  type TipoDeLancamento,
} from '@barbearia/core';
import { audit } from '@barbearia/identity';

/**
 * A fidelidade, do banco para a decisão (bloco 41, SPEC §4.8).
 *
 * A regra mora em `packages/core` e não sabe que existe banco. Aqui se carrega o
 * programa e o extrato, se chama o domínio e se grava o resultado.
 *
 * ## Tudo dentro da transação que fecha a venda
 *
 * O acúmulo nasce junto da comissão, pelo mesmo motivo: fora da transação
 * existiria a janela em que a venda aconteceu e o saldo não — e o cliente
 * descobriria no balcão, com o barbeiro sem ter o que responder.
 *
 * ## Por que `finance` e não `crm`
 *
 * Porque isto é dinheiro. O saldo vira forma de pagamento na comanda seguinte,
 * o ajuste manual **cria** valor gastável, e as duas coisas moram do lado que já
 * tem caixa, comanda e comissão. `crm` é a ficha do cliente.
 */

export type FidelidadeFailure =
  | 'sem_programa'
  | 'sem_cliente'
  | 'saldo_insuficiente'
  | 'nada_a_pagar'
  | 'quantidade_invalida'
  | 'premio_incompleto'
  | 'motivo_curto'
  | 'programa_invalido';

export class FidelidadeError extends Error {
  constructor(readonly code: FidelidadeFailure, message: string) {
    super(message);
    this.name = 'FidelidadeError';
  }
}

const MENSAGEM: Readonly<Record<FidelidadeFailure, string>> = {
  sem_programa: 'Esta barbearia não tem programa de fidelidade ligado.',
  sem_cliente: 'Identifique o cliente antes de usar o saldo.',
  saldo_insuficiente: 'O saldo não cobre este resgate.',
  nada_a_pagar: 'Não há valor a pagar nesta comanda.',
  quantidade_invalida: 'Informe uma quantidade inteira e positiva.',
  premio_incompleto: 'O cartão ainda não está completo para o prêmio.',
  motivo_curto: 'Escreva por que o saldo está sendo ajustado.',
  programa_invalido: 'Confira os números do programa.',
};

function recusar(code: FidelidadeFailure): never {
  throw new FidelidadeError(code, MENSAGEM[code]);
}

/** Piso do motivo, igual ao do override de confiabilidade do bloco 37. */
export const MINIMO_DO_MOTIVO = 10;

interface LinhaDoPrograma {
  mode: ModoDeFidelidade;
  points_per_real: number;
  point_value_cents: number;
  visits_goal: number;
  cashback_bps: number;
  expires_days: number | null;
}

const doBanco = (linha: LinhaDoPrograma): ProgramaDeFidelidade => ({
  modo: linha.mode,
  pontosPorReal: linha.points_per_real,
  valorDoPontoCents: linha.point_value_cents,
  visitasParaPremio: linha.visits_goal,
  cashbackBps: linha.cashback_bps,
  validadeDias: linha.expires_days,
});

/**
 * O programa desta barbearia.
 *
 * Barbearia sem linha é barbearia sem programa, e não é erro: é o padrão. Criar
 * a linha na leitura seria escrever no banco a partir de um `GET`.
 */
export async function programaDaCasa(
  tx: TransactionClient,
): Promise<ProgramaDeFidelidade> {
  const linhas = await tx.$queryRaw<LinhaDoPrograma[]>`
    SELECT mode, points_per_real, point_value_cents, visits_goal, cashback_bps, expires_days
      FROM loyalty_programs
  `;
  const linha = linhas[0];
  return linha ? doBanco(linha) : PROGRAMA_DESLIGADO;
}

export async function programa(tenantId: string): Promise<ProgramaDeFidelidade> {
  return withTenant(tenantId, programaDaCasa);
}

/**
 * Salva o programa.
 *
 * Uma linha por barbearia, e é a chave primária que garante — trocar de modelo
 * é `UPDATE`, nunca uma segunda linha. O extrato antigo não muda: cada
 * lançamento carrega o modo com que nasceu.
 */
export async function salvarPrograma(entrada: {
  readonly tenantId: string;
  readonly programa: ProgramaDeFidelidade;
  readonly ator: { readonly id: string; readonly name: string };
}): Promise<ProgramaDeFidelidade> {
  const p = entrada.programa;
  if (
    !Number.isInteger(p.pontosPorReal) ||
    !Number.isInteger(p.valorDoPontoCents) ||
    !Number.isInteger(p.visitasParaPremio) ||
    !Number.isInteger(p.cashbackBps) ||
    p.pontosPorReal <= 0 ||
    p.valorDoPontoCents <= 0
  ) {
    recusar('programa_invalido');
  }

  return withTenant(entrada.tenantId, async (tx) => {
    const anterior = await programaDaCasa(tx);

    await tx.$executeRaw`
      INSERT INTO loyalty_programs
        (tenant_id, mode, points_per_real, point_value_cents, visits_goal,
         cashback_bps, expires_days)
      VALUES (
        ${entrada.tenantId}::uuid, ${p.modo}::loyalty_mode, ${p.pontosPorReal},
        ${p.valorDoPontoCents}, ${p.visitasParaPremio}, ${p.cashbackBps},
        ${p.validadeDias}
      )
      ON CONFLICT (tenant_id) DO UPDATE SET
        mode = EXCLUDED.mode,
        points_per_real = EXCLUDED.points_per_real,
        point_value_cents = EXCLUDED.point_value_cents,
        visits_goal = EXCLUDED.visits_goal,
        cashback_bps = EXCLUDED.cashback_bps,
        expires_days = EXCLUDED.expires_days,
        updated_at = now()
    `;

    await audit(tx, {
      actorId: entrada.ator.id,
      actorName: entrada.ator.name,
      action: 'loyalty.program_changed',
      entity: 'loyalty_programs',
      entityId: entrada.tenantId,
      before: { modo: anterior.modo },
      after: { modo: p.modo, validadeDias: p.validadeDias },
    });

    return programaDaCasa(tx);
  });
}

export interface LancamentoNaTela {
  readonly id: string;
  readonly tipo: TipoDeLancamento;
  readonly quantidade: number;
  readonly quando: string;
  readonly venceEm: string | null;
  readonly nota: string | null;
  readonly baseCents: number | null;
}

export interface SaldoDoCliente {
  readonly modo: ModoDeFidelidade;
  readonly saldo: number;
  /** Quanto falta para o prêmio. Só faz sentido no modo `visitas`. */
  readonly faltaParaPremio: number | null;
  readonly extrato: readonly LancamentoNaTela[];
}

async function extratoDe(
  tx: TransactionClient,
  customerId: string,
): Promise<readonly (LancamentoDeFidelidade & LancamentoNaTela)[]> {
  const linhas = await tx.$queryRaw<
    {
      id: string;
      kind: TipoDeLancamento;
      amount: number;
      expires_at: Date | null;
      created_at: Date;
      note: string | null;
      base_cents: number | null;
    }[]
  >`
    SELECT id, kind, amount, expires_at, created_at, note, base_cents
      FROM loyalty_entries
     WHERE customer_id = ${customerId}::uuid
     ORDER BY created_at
  `;

  return linhas.map((linha) => ({
    id: linha.id,
    tipo: linha.kind,
    quantidade: linha.amount,
    criadoEm: linha.created_at,
    venceEm: linha.expires_at,
    quando: linha.created_at.toISOString(),
    nota: linha.note,
    baseCents: linha.base_cents,
  })) as unknown as readonly (LancamentoDeFidelidade & LancamentoNaTela)[];
}

/**
 * O saldo de um cliente, com o extrato que o explica.
 *
 * O extrato vem junto de propósito: "por que caiu?" é a pergunta que a barbearia
 * recebe, e um número sozinho não responde. É a mesma decisão do extrato de
 * fiado.
 *
 * Filtra por `customer_id` — a RLS separa barbearias e **não** separa clientes
 * dentro de uma.
 */
export async function saldoDoCliente(
  tenantId: string,
  customerId: string,
  agora: Date = new Date(),
): Promise<SaldoDoCliente> {
  return withTenant(tenantId, async (tx) => {
    const p = await programaDaCasa(tx);
    const extrato = await extratoDe(tx, customerId);
    const saldo = saldoDisponivel(extrato, agora);

    return {
      modo: p.modo,
      saldo,
      faltaParaPremio:
        p.modo === 'visitas' ? Math.max(0, p.visitasParaPremio - saldo) : null,
      extrato: extrato.map((l) => ({
        id: l.id,
        tipo: l.tipo,
        quantidade: l.quantidade,
        quando: l.quando,
        venceEm: l.venceEm ? new Date(l.venceEm).toISOString() : null,
        nota: l.nota,
        baseCents: l.baseCents,
      })),
    };
  });
}

/**
 * Quanto vale, em centavos, o resgate que o balcão está pedindo.
 *
 * Chamada **antes** de fechar a comanda, para montar a linha de pagamento. O
 * saldo é lido sob a mesma transação de quem chama quando ela existe: entre a
 * conferência e a gravação não pode caber outro resgate.
 */
export async function conferirResgate(params: {
  readonly tenantId: string;
  readonly customerId: string | null;
  readonly quantidade: number;
  readonly tetoCents: number;
  readonly agora?: Date;
  readonly tx?: TransactionClient;
}): Promise<{ readonly valorCents: number; readonly quantidade: number }> {
  const agora = params.agora ?? new Date();

  const dentro = async (tx: TransactionClient) => {
    if (!params.customerId) recusar('sem_cliente');

    const p = await programaDaCasa(tx);
    const extrato = await extratoDe(tx, params.customerId);
    const saldo = saldoDisponivel(extrato, agora);

    const decisao = podeResgatar({
      programa: p,
      saldo,
      quantidade: params.quantidade,
      tetoCents: params.tetoCents,
    });
    if (!decisao.aceito) recusar(decisao.recusa);

    const valorCents = valorDoResgate({
      programa: p,
      quantidade: params.quantidade,
      tetoCents: params.tetoCents,
    });
    if (valorCents <= 0) recusar('nada_a_pagar');

    return { valorCents, quantidade: params.quantidade };
  };

  return params.tx ? dentro(params.tx) : withTenant(params.tenantId, dentro);
}

/**
 * Grava o resgate, **dentro da transação que fecha a comanda**.
 *
 * Fora dela, a comanda fecharia com o desconto aplicado e o saldo continuaria
 * intacto — o que é o defeito com o pior desfecho possível deste bloco: crédito
 * infinito, gasto uma vez por comanda.
 */
export async function registrarResgate(
  tx: TransactionClient,
  params: {
    readonly customerId: string;
    readonly orderId: string;
    readonly quantidade: number;
    readonly modo: ModoDeFidelidade;
  },
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO loyalty_entries (tenant_id, customer_id, order_id, kind, mode, amount)
    VALUES (
      NULLIF(current_setting('app.tenant_id', true), '')::uuid,
      ${params.customerId}::uuid, ${params.orderId}::uuid, 'resgate',
      ${params.modo}::loyalty_mode, ${-Math.abs(params.quantidade)}
    )
  `;
}

/**
 * Credita o que esta venda gerou, **dentro da transação que a fecha**.
 *
 * Silencioso quando não há programa, quando não há cliente identificado ou
 * quando a conta inteira saiu do próprio saldo — os três são normais, e nenhum
 * é erro.
 *
 * O `ON CONFLICT DO NOTHING` fecha a reentrada: o webhook do Pix pode chamar a
 * cadeia de fechamento por outro caminho, e sem o índice único a reentrega
 * dobraria o saldo do cliente. Saldo dobrado vira dinheiro no balcão.
 */
export async function creditarDaVenda(
  tx: TransactionClient,
  params: {
    readonly orderId: string;
    readonly customerId: string | null;
    readonly totalCents: number;
    readonly resgatadoCents: number;
    readonly agora: Date;
  },
): Promise<number> {
  if (!params.customerId) return 0;

  const p = await programaDaCasa(tx);
  const acumulo = acumuloDaVenda({
    programa: p,
    totalCents: params.totalCents,
    resgatadoCents: params.resgatadoCents,
  });
  if (!acumulo) return 0;

  await tx.$executeRaw`
    INSERT INTO loyalty_entries
      (tenant_id, customer_id, order_id, kind, mode, amount, base_cents, expires_at)
    VALUES (
      NULLIF(current_setting('app.tenant_id', true), '')::uuid,
      ${params.customerId}::uuid, ${params.orderId}::uuid, 'acumulo',
      ${p.modo}::loyalty_mode, ${acumulo.quantidade}, ${acumulo.baseCents},
      ${vencimentoDoAcumulo(p, params.agora)}
    )
    ON CONFLICT DO NOTHING
  `;

  return acumulo.quantidade;
}

/**
 * O ajuste manual — a única linha que uma pessoa cria à mão.
 *
 * Motivo obrigatório com piso, no domínio **e** por `CHECK`: "meus pontos
 * sumiram" é a pergunta, e o extrato é a resposta. Um ajuste sem explicação é
 * indefensável na primeira vez que o dono perguntar.
 *
 * A permissão é `finance.loyalty_adjust`, no grupo de dinheiro por prefixo:
 * criar saldo é criar valor gastável no balcão da operação seguinte.
 */
export async function ajustarSaldo(entrada: {
  readonly tenantId: string;
  readonly customerId: string;
  readonly quantidade: number;
  readonly motivo: string;
  readonly ator: { readonly id: string; readonly name: string };
  readonly agora?: Date;
}): Promise<SaldoDoCliente> {
  const motivo = entrada.motivo.trim();
  if (motivo.length < MINIMO_DO_MOTIVO) recusar('motivo_curto');
  if (!Number.isInteger(entrada.quantidade) || entrada.quantidade === 0) {
    recusar('quantidade_invalida');
  }

  const agora = entrada.agora ?? new Date();

  await withTenant(entrada.tenantId, async (tx) => {
    const p = await programaDaCasa(tx);
    if (p.modo === 'nenhum') recusar('sem_programa');

    // Tirar mais do que existe deixaria o saldo negativo, e saldo negativo é
    // uma dívida que o produto não sabe cobrar — fiado tem tabela própria.
    if (entrada.quantidade < 0) {
      const extrato = await extratoDe(tx, entrada.customerId);
      if (saldoDisponivel(extrato, agora) + entrada.quantidade < 0) {
        recusar('saldo_insuficiente');
      }
    }

    await tx.$executeRaw`
      INSERT INTO loyalty_entries
        (tenant_id, customer_id, kind, mode, amount, note, created_by, expires_at)
      VALUES (
        ${entrada.tenantId}::uuid, ${entrada.customerId}::uuid, 'ajuste',
        ${p.modo}::loyalty_mode, ${entrada.quantidade}, ${motivo},
        ${entrada.ator.id}::uuid,
        ${entrada.quantidade > 0 ? vencimentoDoAcumulo(p, agora) : null}
      )
    `;

    await audit(tx, {
      actorId: entrada.ator.id,
      actorName: entrada.ator.name,
      action: 'loyalty.adjusted',
      entity: 'customers',
      entityId: entrada.customerId,
      after: { quantidade: entrada.quantidade, motivo },
    });
  });

  return saldoDoCliente(entrada.tenantId, entrada.customerId, agora);
}

/**
 * A varredura que grava o que venceu.
 *
 * O saldo já **some da leitura** no instante do vencimento — quem lê usa
 * `saldoDisponivel`, que olha o relógio. Esta varredura é o que mantém o extrato
 * honesto: sem ela, a soma das linhas não bateria com o saldo mostrado, e a
 * primeira pessoa a conferir a conta na mão encontraria uma diferença.
 *
 * Uma linha por cliente por rodada, e nunca de zero: extrato com movimento nulo
 * é extrato que ninguém consegue ler.
 */
export async function expirarSaldos(tenantId: string, agora: Date): Promise<number> {
  return withTenant(tenantId, async (tx) => {
    /**
     * O modo vem do próprio saldo que venceu, não do programa de hoje.
     *
     * A barbearia pode ter trocado de pontos para cashback no meio do prazo. A
     * linha de expiração precisa sair na unidade do que expirou — com o modo
     * novo, ela subtrairia centavos de um saldo em pontos.
     */
    const clientes = await tx.$queryRaw<{ customer_id: string; mode: ModoDeFidelidade }[]>`
      SELECT customer_id, min(mode::text)::loyalty_mode AS mode
        FROM loyalty_entries
       -- Toda entrada com prazo, não só a de venda. O ajuste manual positivo
       -- também vence, e recortar por tipo fazia o saldo ajustado sumir da
       -- leitura sem nunca aparecer no extrato — a divergência exata que este
       -- bloco existe para não ter. Foi o teste da varredura que pegou.
       WHERE amount > 0 AND expires_at IS NOT NULL AND expires_at <= ${agora}
       GROUP BY customer_id
    `;

    let expirados = 0;
    for (const cliente of clientes) {
      const extrato = await extratoDe(tx, cliente.customer_id);
      const quanto = quantidadeAExpirar(extrato, agora);
      if (quanto <= 0) continue;

      await tx.$executeRaw`
        INSERT INTO loyalty_entries (tenant_id, customer_id, kind, mode, amount, note)
        VALUES (
          ${tenantId}::uuid, ${cliente.customer_id}::uuid, 'expiracao',
          ${cliente.mode}::loyalty_mode, ${-quanto}, 'Vencimento automático'
        )
      `;
      expirados += 1;
    }

    return expirados;
  });
}
