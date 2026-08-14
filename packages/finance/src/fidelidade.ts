import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  PROGRAMA_DESLIGADO,
  acumuloDaVenda,
  dividirResgate,
  escopoDoLancamento,
  separarPorBolso,
  podeResgatar,
  quantidadeAExpirar,
  saldoDisponivel,
  valorDoResgate,
  vencimentoDoAcumulo,
  type EscopoMultiunidade,
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
  scope: EscopoMultiunidade;
}

const doBanco = (linha: LinhaDoPrograma): ProgramaDeFidelidade => ({
  modo: linha.mode,
  pontosPorReal: linha.points_per_real,
  valorDoPontoCents: linha.point_value_cents,
  visitasParaPremio: linha.visits_goal,
  cashbackBps: linha.cashback_bps,
  validadeDias: linha.expires_days,
  escopo: linha.scope,
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
    SELECT mode, points_per_real, point_value_cents, visits_goal, cashback_bps,
           expires_days, scope
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
  /**
   * `escopo` é opcional aqui, e é a regra do campo opcional na borda: ausente
   * significa **não mexa**, nunca "volte para a rede". Escrever o padrão por
   * omissão faria corrigir o cashback numa tela antiga devolver o saldo de todo
   * mundo para a rede sem ninguém ter decidido isso.
   */
  readonly programa: Omit<ProgramaDeFidelidade, 'escopo'> & {
    // `| undefined` explícito: com `exactOptionalPropertyTypes`, um corpo que
    // traz a chave ausente e um que a traz como `undefined` são tipos
    // diferentes, e o zod produz o segundo.
    readonly escopo?: EscopoMultiunidade | undefined;
  };
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
         cashback_bps, expires_days, scope)
      VALUES (
        ${entrada.tenantId}::uuid, ${p.modo}::loyalty_mode, ${p.pontosPorReal},
        ${p.valorDoPontoCents}, ${p.visitasParaPremio}, ${p.cashbackBps},
        ${p.validadeDias}, COALESCE(${p.escopo ?? null}::escopo_multiunidade, 'empresa')
      )
      ON CONFLICT (tenant_id) DO UPDATE SET
        mode = EXCLUDED.mode,
        points_per_real = EXCLUDED.points_per_real,
        point_value_cents = EXCLUDED.point_value_cents,
        visits_goal = EXCLUDED.visits_goal,
        cashback_bps = EXCLUDED.cashback_bps,
        expires_days = EXCLUDED.expires_days,
        -- Ausente significa "não mexa": o COALESCE do VALUES ja resolveu o
        -- padrao de quem nasce, e aqui ele preserva a decisao de quem ja existe.
        scope = COALESCE(EXCLUDED.scope, loyalty_programs.scope),
        updated_at = now()
    `;

    await audit(tx, {
      actorId: entrada.ator.id,
      actorName: entrada.ator.name,
      action: 'loyalty.program_changed',
      entity: 'loyalty_programs',
      entityId: entrada.tenantId,
      before: { modo: anterior.modo, escopo: anterior.escopo },
      after: {
        modo: p.modo,
        validadeDias: p.validadeDias,
        escopo: p.escopo ?? anterior.escopo,
      },
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
  readonly escopo: EscopoMultiunidade;
  readonly unidadeId: string | null;
  /** O nome da loja, para o extrato responder "onde eu ganhei isso?". */
  readonly unidade: string | null;
}

/**
 * O saldo separado nos dois bolsos daquela loja (bloco 59).
 *
 * O FIFO de vencimento roda **dentro de cada bolso**: uma saída da loja não pode
 * consumir um lote compartilhado sem que a linha diga que consumiu, senão o
 * mesmo ponto sai duas vezes — uma no bolso que encolheu e outra no que ficou.
 */
export function saldoNosBolsos(
  extrato: readonly (LancamentoDeFidelidade & LancamentoNaTela)[],
  unidadeId: string | null,
  agora: Date,
): { readonly compartilhado: number; readonly daUnidade: number; readonly total: number } {
  const bolsos = separarPorBolso(extrato, unidadeId);
  const compartilhado = saldoDisponivel(bolsos.compartilhado, agora);
  const daUnidade = saldoDisponivel(bolsos.daUnidade, agora);
  return { compartilhado, daUnidade, total: compartilhado + daUnidade };
}

export interface SaldoDoCliente {
  readonly modo: ModoDeFidelidade;
  readonly escopo: EscopoMultiunidade;
  /** O saldo desta loja: o bolso compartilhado mais o dela. */
  readonly saldo: number;
  /** Quanto do saldo vale em qualquer loja. Igual ao total sob `empresa`. */
  readonly saldoCompartilhado: number;
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
      scope: EscopoMultiunidade;
      location_id: string | null;
      location_name: string | null;
    }[]
  >`
    SELECT e.id, e.kind, e.amount, e.expires_at, e.created_at, e.note, e.base_cents,
           e.scope, e.location_id, l.name AS location_name
      FROM loyalty_entries e
      LEFT JOIN locations l ON l.id = e.location_id
     WHERE e.customer_id = ${customerId}::uuid
     ORDER BY e.created_at
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
    escopo: linha.scope,
    unidadeId: linha.location_id,
    unidade: linha.location_name,
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
  unidadeId: string | null = null,
): Promise<SaldoDoCliente> {
  return withTenant(tenantId, async (tx) => {
    const p = await programaDaCasa(tx);
    const extrato = await extratoDe(tx, customerId);
    const bolsos = saldoNosBolsos(extrato, unidadeId, agora);
    const saldo = bolsos.total;

    return {
      modo: p.modo,
      escopo: p.escopo,
      saldo,
      saldoCompartilhado: bolsos.compartilhado,
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
        escopo: l.escopo,
        unidadeId: l.unidadeId,
        unidade: l.unidade,
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
  /** A loja da venda: com fidelidade por unidade, o saldo é o dos dois bolsos dela. */
  readonly locationId?: string | null;
  readonly tx?: TransactionClient;
}): Promise<{ readonly valorCents: number; readonly quantidade: number }> {
  const agora = params.agora ?? new Date();

  const dentro = async (tx: TransactionClient) => {
    if (!params.customerId) recusar('sem_cliente');

    const p = await programaDaCasa(tx);
    const extrato = await extratoDe(tx, params.customerId);
    const saldo = saldoNosBolsos(extrato, params.locationId ?? null, agora).total;

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
    readonly locationId?: string | null;
    readonly agora?: Date;
  },
): Promise<void> {
  /**
   * O resgate sai do bolso compartilhado primeiro, e pode virar **duas** linhas.
   *
   * É o que impede o mesmo ponto de ser gasto duas vezes: com uma linha só no
   * bolso da loja, um saldo compartilhado de 300 seria gasto na matriz — o bolso
   * da matriz iria a −300 — e continuaria inteiro para gastar na filial.
   */
  const extrato = await extratoDe(tx, params.customerId);
  const bolsos = saldoNosBolsos(extrato, params.locationId ?? null, params.agora ?? new Date());
  const divisao = dividirResgate({
    quantidade: Math.abs(params.quantidade),
    saldoCompartilhado: bolsos.compartilhado,
    saldoDaUnidade: bolsos.daUnidade,
  });
  if (!divisao) recusar('saldo_insuficiente');

  for (const [escopo, quantidade, unidade] of [
    ['empresa', divisao.doCompartilhado, null],
    ['unidade', divisao.daUnidade, params.locationId ?? null],
  ] as const) {
    // Linha de zero não entra: extrato com movimento nulo é extrato que ninguém
    // consegue ler.
    if (quantidade <= 0) continue;
    await tx.$executeRaw`
      INSERT INTO loyalty_entries
        (tenant_id, customer_id, order_id, kind, mode, amount, scope, location_id)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${params.customerId}::uuid, ${params.orderId}::uuid, 'resgate',
        ${params.modo}::loyalty_mode, ${-quantidade},
        ${escopo}::escopo_multiunidade, ${unidade}::uuid
      )
    `;
  }
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
    readonly locationId?: string | null;
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

  /**
   * O escopo é congelado aqui, como o modo.
   *
   * Lido do cadastro **no momento da gravação** e nunca mais: toda pergunta
   * posterior — saldo, extrato, expiração — lê o escopo da linha. É o que faz a
   * barbearia trocar o interruptor em maio sem os pontos de abril sumirem.
   */
  const unidade = params.locationId ?? null;
  const escopo = escopoDoLancamento(p.escopo, unidade);

  await tx.$executeRaw`
    INSERT INTO loyalty_entries
      (tenant_id, customer_id, order_id, kind, mode, amount, base_cents, expires_at,
       scope, location_id)
    VALUES (
      NULLIF(current_setting('app.tenant_id', true), '')::uuid,
      ${params.customerId}::uuid, ${params.orderId}::uuid, 'acumulo',
      ${p.modo}::loyalty_mode, ${acumulo.quantidade}, ${acumulo.baseCents},
      ${vencimentoDoAcumulo(p, params.agora)},
      ${escopo}::escopo_multiunidade, ${unidade}::uuid
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
  /** A unidade do balcão: é ela que decide de qual bolso o ajuste sai (bloco 59). */
  readonly locationId?: string | null;
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

    /**
     * O ajuste também é **por bolso** (bloco 59).
     *
     * A primeira versão conferia o saldo misturado e escrevia a linha sempre no
     * compartilhado. Numa barbearia com fidelidade por unidade isso produzia o
     * pior desfecho possível desta rota, e sem nenhuma corrida: tirar 300
     * passava na conferência, ia para um bolso sem lote e era **descartado em
     * silêncio** por `lotes()`; devolver os 300 criava um lote vivo lá. Duas
     * operações que somam zero deixavam o cliente com o dobro.
     *
     * Achado da `/security-review` do bloco 59.
     */
    const extrato = await extratoDe(tx, entrada.customerId);
    const bolsos = saldoNosBolsos(extrato, entrada.locationId ?? null, agora);

    const linhas: readonly {
      readonly quantidade: number;
      readonly escopo: EscopoMultiunidade;
      readonly unidade: string | null;
    }[] =
      entrada.quantidade > 0
        ? [
            {
              quantidade: entrada.quantidade,
              escopo: escopoDoLancamento(p.escopo, entrada.locationId ?? null),
              unidade:
                escopoDoLancamento(p.escopo, entrada.locationId ?? null) === 'unidade'
                  ? (entrada.locationId ?? null)
                  : null,
            },
          ]
        : (() => {
            // Tirar mais do que existe deixaria o saldo negativo, e saldo
            // negativo é uma dívida que o produto não sabe cobrar — fiado tem
            // tabela própria. A divisão é a mesma do resgate: compartilhado
            // primeiro, e recusa inteira quando não cabe.
            const divisao = dividirResgate({
              quantidade: -entrada.quantidade,
              saldoCompartilhado: bolsos.compartilhado,
              saldoDaUnidade: bolsos.daUnidade,
            });
            if (!divisao) recusar('saldo_insuficiente');
            return [
              { quantidade: -divisao.doCompartilhado, escopo: 'empresa' as const, unidade: null },
              {
                quantidade: -divisao.daUnidade,
                escopo: 'unidade' as const,
                unidade: entrada.locationId ?? null,
              },
            ];
          })();

    for (const linha of linhas) {
      // Linha de zero não entra: extrato com movimento nulo é extrato que
      // ninguém consegue ler.
      if (linha.quantidade === 0) continue;
      await tx.$executeRaw`
        INSERT INTO loyalty_entries
          (tenant_id, customer_id, kind, mode, amount, note, created_by, expires_at,
           scope, location_id)
        VALUES (
          ${entrada.tenantId}::uuid, ${entrada.customerId}::uuid, 'ajuste',
          ${p.modo}::loyalty_mode, ${linha.quantidade}, ${motivo},
          ${entrada.ator.id}::uuid,
          ${linha.quantidade > 0 ? vencimentoDoAcumulo(p, agora) : null},
          ${linha.escopo}::escopo_multiunidade, ${linha.unidade}::uuid
        )
      `;
    }

    await audit(tx, {
      actorId: entrada.ator.id,
      actorName: entrada.ator.name,
      action: 'loyalty.adjusted',
      entity: 'customers',
      entityId: entrada.customerId,
      // Idem: "creditei porque o Marcelo brigou na frente da loja" é texto
      // sobre uma pessoa, e ele fica no razão, que a anonimização alcança.
      after: { quantidade: entrada.quantidade, caracteresDoMotivo: motivo.length },
    });
  });

  return saldoDoCliente(entrada.tenantId, entrada.customerId, agora, entrada.locationId ?? null);
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

      /**
       * A expiração é contada e gravada **dentro de cada bolso** (bloco 59).
       *
       * Escrita no compartilhado, a expiração de um lote de unidade consumia um
       * lote compartilhado **vivo** — destruindo saldo que não tinha vencido,
       * sem nada ficar vermelho. É o mesmo defeito do ajuste, com o sinal
       * trocado. Achado da `/security-review` do bloco 59.
       */
      const unidades = new Set(
        extrato.filter((l) => l.escopo === 'unidade').map((l) => l.unidadeId),
      );
      const bolsos: readonly { escopo: EscopoMultiunidade; unidade: string | null }[] = [
        { escopo: 'empresa', unidade: null },
        ...[...unidades].map((u) => ({ escopo: 'unidade' as const, unidade: u })),
      ];

      let algum = false;
      for (const bolso of bolsos) {
        const doBolso = extrato.filter(
          (l) => l.escopo === bolso.escopo && (bolso.escopo === 'empresa' || l.unidadeId === bolso.unidade),
        );
        const quanto = quantidadeAExpirar(doBolso, agora);
        if (quanto <= 0) continue;

        await tx.$executeRaw`
          INSERT INTO loyalty_entries
            (tenant_id, customer_id, kind, mode, amount, note, scope, location_id)
          VALUES (
            ${tenantId}::uuid, ${cliente.customer_id}::uuid, 'expiracao',
            ${cliente.mode}::loyalty_mode, ${-quanto}, 'Vencimento automático',
            ${bolso.escopo}::escopo_multiunidade, ${bolso.unidade}::uuid
          )
        `;
        algum = true;
      }
      if (algum) expirados += 1;
    }

    return expirados;
  });
}
