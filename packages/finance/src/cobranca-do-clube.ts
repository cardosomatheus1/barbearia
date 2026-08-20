import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  DIAS_ATE_SUSPENDER,
  cancelamentoValeAPartirDe,
  cartaoVaiVencer,
  cicloDaAssinatura,
  diasAteSuspender,
  fraseDoAvisoDoClube,
  proximoPassoDaCobranca,
  type CobrancaDoClubeProvider,
  type FaturaDoClube,
  type MotivoDoAvisoDoClube,
} from '@barbearia/core';
import { audit } from '@barbearia/identity';
import { enfileirarPara } from '@barbearia/jobs';
import { AssinaturaError } from './assinatura.js';

/**
 * A cobrança recorrente do clube (bloco 47, SPEC §4.6).
 *
 * ## Três camadas, como a régua da plataforma
 *
 * - **`packages/core/src/assinatura.ts`** decide *quando*: cobrar, retentar,
 *   marcar inadimplente, suspender. Puro, com o relógio por parâmetro — a régua
 *   inteira é conferível sem banco e sem esperar o mês virar.
 * - **este arquivo** faz *o quê*: lê o estado, chama a decisão, grava o
 *   resultado e enfileira o aviso na mesma transação.
 * - **o provedor** cobra de verdade, e é a única coisa aqui que sai da máquina.
 *
 * ## A cobrança acontece **fora** da transação
 *
 * Segurar transação aberta esperando resposta de adquirente é o jeito clássico
 * de esgotar o pool: o tempo limite deles é de dezenas de segundos, e uma volta
 * da régua tem uma fatura por assinante. O que a transação faz depois é gravar o
 * resultado, que é rápido — e ela grava com o estado **e o contador** no
 * `WHERE`, de forma que dois workers na mesma volta não gastem dois degraus da
 * escada pela mesma recusa.
 *
 * ## Por que a suspensão é gradual
 *
 * *"Suspensão de benefício é gradual e avisada — cortar o acesso no primeiro
 * erro de cartão gera cancelamento por raiva, não por preço."* O caminho inteiro
 * é: cobra, falha, **avisa e continua entregando** por quinze dias, e só então
 * pausa. `inadimplente` usa o plano; `suspensa` não.
 */

// ---------------------------------------------------------------------------
// A leitura
// ---------------------------------------------------------------------------

export interface FaturaNaTela {
  readonly id: string;
  readonly assinaturaId: string;
  readonly cliente: string;
  readonly clienteId: string;
  readonly plano: string | null;
  readonly valorCents: number;
  readonly estado: 'aberta' | 'paga' | 'cancelada';
  readonly periodoDe: string;
  readonly periodoAte: string;
  readonly vencimento: string;
  readonly tentativas: number;
  readonly ultimoErro: string | null;
  /** A anotação de quem perdoou a mensalidade. **Só** para o balcão. */
  readonly motivoDoCancelamento: string | null;
  readonly pagaEm: string | null;
  readonly metodo: string | null;
  readonly marcadaInadimplenteEm: string | null;
  /** Quantos dias faltam para o benefício parar. `null` quando não está em atraso. */
  readonly diasAteSuspender: number | null;
}

interface LinhaDeFatura {
  id: string;
  subscription_id: string;
  customer_id: string;
  cliente: string;
  plano: string | null;
  amount_cents: number;
  status: 'aberta' | 'paga' | 'cancelada';
  period_start: Date;
  period_end: Date;
  due_at: Date;
  attempts: number;
  last_error: string | null;
  void_reason: string | null;
  paid_at: Date | null;
  paid_method: string | null;
  marked_delinquent_at: Date | null;
}

const paraTela = (l: LinhaDeFatura, agora: Date): FaturaNaTela => ({
  id: l.id,
  assinaturaId: l.subscription_id,
  clienteId: l.customer_id,
  cliente: l.cliente,
  plano: l.plano,
  valorCents: l.amount_cents,
  estado: l.status,
  periodoDe: l.period_start.toISOString(),
  periodoAte: l.period_end.toISOString(),
  vencimento: l.due_at.toISOString(),
  tentativas: l.attempts,
  ultimoErro: l.last_error,
  motivoDoCancelamento: l.void_reason,
  pagaEm: l.paid_at ? l.paid_at.toISOString() : null,
  metodo: l.paid_method,
  marcadaInadimplenteEm: l.marked_delinquent_at ? l.marked_delinquent_at.toISOString() : null,
  diasAteSuspender:
    l.status === 'aberta' && l.due_at <= agora ? diasAteSuspender(l.due_at, agora) : null,
});

/**
 * As faturas do clube para o balcão.
 *
 * Em aberto primeiro, e por vencimento: quem opera abre esta tela para saber de
 * quem cobrar hoje, não para ler o histórico. O histórico vem embaixo.
 */
export async function faturasDoClube(
  tenantId: string,
  filtro: { readonly estado?: 'aberta' | 'paga' | 'cancelada'; readonly agora?: Date } = {},
): Promise<readonly FaturaNaTela[]> {
  const agora = filtro.agora ?? new Date();
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<LinhaDeFatura[]>`
      SELECT f.id, f.subscription_id, s.customer_id, c.name AS cliente, p.name AS plano,
             f.amount_cents, f.status::text AS status, f.period_start, f.period_end,
             f.due_at, f.attempts, f.last_error, f.void_reason, f.paid_at, f.paid_method,
             f.marked_delinquent_at
        FROM club_invoices f
        JOIN club_subscriptions s ON s.id = f.subscription_id
        JOIN customers c ON c.id = s.customer_id
        LEFT JOIN club_plans p ON p.id = s.plan_id
       WHERE (${filtro.estado ?? null}::text IS NULL
              OR f.status::text = ${filtro.estado ?? null}::text)
       ORDER BY (f.status = 'aberta') DESC, f.due_at DESC
       LIMIT 200
    `;
    return linhas.map((l) => paraTela(l, agora));
  });
}

/**
 * A mensalidade como o **assinante** a vê.
 *
 * Forma própria, e não `FaturaNaTela` compartilhada com o balcão — que foi a
 * primeira versão e um achado da `/security-review`. Duas telas com públicos
 * diferentes lendo o mesmo objeto significa que todo campo novo criado para o
 * balcão chega ao cliente sem ninguém decidir isso: foi assim que a anotação
 * interna do cancelamento de fatura vazou para o self-service.
 *
 * O que o cliente precisa é o que está aqui: quanto, de que mês, se está pago e
 * quanto falta para o plano pausar. Nada de tentativa de cartão, motivo de
 * recusa do adquirente ou anotação de quem perdoou.
 */
export interface MinhaFatura {
  readonly id: string;
  readonly valorCents: number;
  readonly estado: 'aberta' | 'paga' | 'cancelada';
  readonly periodoDe: string;
  readonly vencimento: string;
  readonly pagaEm: string | null;
  readonly diasAteSuspender: number | null;
}

/**
 * As faturas de um cliente — a porta do self-service.
 *
 * `customer_id` no `WHERE` é obrigatório e não é redundância: a RLS separa
 * barbearias e **não separa clientes dentro de uma**. Sem o filtro, um id
 * vazado bastaria para ler o extrato de pagamento de outra pessoa.
 */
export async function minhasFaturas(
  tenantId: string,
  customerId: string,
  agora: Date = new Date(),
): Promise<readonly MinhaFatura[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        amount_cents: number;
        status: 'aberta' | 'paga' | 'cancelada';
        period_start: Date;
        due_at: Date;
        paid_at: Date | null;
      }[]
    >`
      SELECT f.id, f.amount_cents, f.status::text AS status, f.period_start,
             f.due_at, f.paid_at
        FROM club_invoices f
        JOIN club_subscriptions s ON s.id = f.subscription_id
       WHERE s.customer_id = ${customerId}::uuid
       ORDER BY f.period_start DESC
       LIMIT 24
    `;
    return linhas.map((l) => ({
      id: l.id,
      valorCents: l.amount_cents,
      estado: l.status,
      periodoDe: l.period_start.toISOString(),
      vencimento: l.due_at.toISOString(),
      pagaEm: l.paid_at ? l.paid_at.toISOString() : null,
      diasAteSuspender:
        l.status === 'aberta' && l.due_at <= agora ? diasAteSuspender(l.due_at, agora) : null,
    }));
  });
}

// ---------------------------------------------------------------------------
// A emissão
// ---------------------------------------------------------------------------

/**
 * Emite a fatura do ciclo em curso de cada assinatura viva.
 *
 * O vencimento é o **primeiro dia do ciclo**, porque a cobrança é adiantada: o
 * assinante paga o mês que vai consumir. Cobrar depois de entregar
 * transformaria o mês inteiro em crédito — o cliente corta quatro vezes, some, e
 * a casa fica com uma fatura para perseguir.
 *
 * Idempotente pelo índice único `(subscription_id, period_start)`, e não por um
 * `SELECT` antes do `INSERT`: o worker roda a cada volta do laço, e uma janela
 * de corrida aqui cobra o assinante duas vezes pelo mesmo mês.
 *
 * O `ON CONFLICT DO NOTHING` é seguro porque a tabela tem **um** índice único.
 * É a lição do bloco 39, onde dois índices e um `DO NOTHING` descartavam a linha
 * inteira em silêncio.
 */
export async function emitirFaturas(entrada: {
  readonly tenantId: string;
  readonly agora?: Date;
}): Promise<number> {
  const agora = entrada.agora ?? new Date();

  return withTenant(entrada.tenantId, async (tx) => {
    const vivas = await tx.$queryRaw<
      {
        id: string;
        price_cents: number;
        started_at: Date;
        cancel_effective_at: Date | null;
      }[]
    >`
      SELECT id, price_cents, started_at, cancel_effective_at
        FROM club_subscriptions
       WHERE status IN ('ativa', 'pendente', 'inadimplente', 'suspensa')
    `;

    let emitidas = 0;
    for (const assinatura of vivas) {
      const ciclo = cicloDaAssinatura(assinatura.started_at, agora);

      /**
       * Quem pediu para sair não é cobrado pelo ciclo seguinte.
       *
       * Sem isto, o cancelamento self-service seria uma promessa: a pessoa pede
       * para sair no dia 20, o ciclo vira no dia 30, e no dia 30 o worker emite
       * mais uma fatura de R$ 149 para quem já tinha ido embora.
       */
      if (assinatura.cancel_effective_at && ciclo.de >= assinatura.cancel_effective_at) continue;

      emitidas += await tx.$executeRaw`
        INSERT INTO club_invoices (
          tenant_id, subscription_id, period_start, period_end, amount_cents, due_at
        ) VALUES (
          NULLIF(current_setting('app.tenant_id', true), '')::uuid,
          ${assinatura.id}::uuid, ${ciclo.de}, ${ciclo.ate},
          ${assinatura.price_cents}, ${ciclo.de}
        )
        ON CONFLICT DO NOTHING
      `;
    }
    return emitidas;
  });
}

// ---------------------------------------------------------------------------
// A régua
// ---------------------------------------------------------------------------

export interface ResultadoDaRegua {
  readonly emitidas: number;
  readonly cobradas: number;
  readonly pagas: number;
  readonly inadimplentes: number;
  readonly suspensas: number;
  readonly encerradas: number;
  readonly avisosDeCartao: number;
}

interface FaturaEmCobranca {
  id: string;
  subscription_id: string;
  amount_cents: number;
  due_at: Date;
  attempts: number;
  marked_delinquent_at: Date | null;
  last_definitive: boolean;
  payment_token: string | null;
  plano: string | null;
}

async function faturasEmCobranca(
  tx: TransactionClient,
  agora: Date,
): Promise<readonly FaturaEmCobranca[]> {
  return tx.$queryRaw<FaturaEmCobranca[]>`
    SELECT f.id, f.subscription_id, f.amount_cents, f.due_at, f.attempts,
           f.marked_delinquent_at, f.last_definitive,
           s.payment_token, p.name AS plano
      FROM club_invoices f
      JOIN club_subscriptions s ON s.id = f.subscription_id
      LEFT JOIN club_plans p ON p.id = s.plan_id
     WHERE f.status = 'aberta' AND f.due_at <= ${agora}
       -- O estado da ASSINATURA no filtro, e não só o da fatura. Achado da
       -- revisão de segurança: anonimizar um cliente cancela a assinatura dele,
       -- e o cancelamento pelo balcão faz o mesmo, mas a fatura já emitida
       -- continua aberta. Sem esta linha a régua da madrugada apresentaria o
       -- cartão salvo ao adquirente por mais quinze dias, cobrando alguém que
       -- não é mais cliente — e em silêncio, porque o telefone já foi apagado e
       -- o aviso não teria para onde ir. A emissão e o aviso de cartão já
       -- filtravam; só quem cobra não filtrava, que é onde custava dinheiro.
       AND s.status <> 'cancelada'
     ORDER BY f.due_at
     LIMIT 500
  `;
}

const estadoDaFatura = (f: FaturaEmCobranca): FaturaDoClube => ({
  status: 'aberta',
  vencimento: f.due_at,
  tentativas: f.attempts,
  marcadaInadimplenteEm: f.marked_delinquent_at,
  recusaDefinitiva: f.last_definitive,
});

/**
 * Enfileira o aviso ao assinante **dentro** da transação que muda o estado.
 *
 * Mandar depois do commit cria a janela em que o plano foi suspenso e ninguém
 * soube — a mesma janela que a régua de cobrança da plataforma evita desde o
 * bloco 28, e o motivo pelo qual `finance` depende de `jobs`.
 */
async function avisarAssinante(
  tx: TransactionClient,
  tenantId: string,
  assinaturaId: string,
  motivo: MotivoDoAvisoDoClube,
  chave: string,
): Promise<void> {
  await enfileirarPara(tx, tenantId, {
    kind: 'clube.aviso',
    payload: { subscriptionId: assinaturaId, motivo },
    idempotencyKey: `clube.aviso:${assinaturaId}:${motivo}:${chave}`,
  });
}

/**
 * Uma volta da régua para uma barbearia.
 *
 * Por barbearia e não global, ao contrário da régua da plataforma: `club_*` tem
 * RLS, e um processo sem tenant no contexto enxerga zero linhas. É o mesmo
 * desenho da varredura de retenção e da apuração diária.
 */
export async function aplicarReguaDoClube(entrada: {
  readonly tenantId: string;
  readonly provider: CobrancaDoClubeProvider;
  readonly agora?: Date;
}): Promise<ResultadoDaRegua> {
  const agora = entrada.agora ?? new Date();
  const contagem = {
    emitidas: 0,
    cobradas: 0,
    pagas: 0,
    inadimplentes: 0,
    suspensas: 0,
    encerradas: 0,
    avisosDeCartao: 0,
  };

  contagem.emitidas = await emitirFaturas({ tenantId: entrada.tenantId, agora });

  const emCobranca = await withTenant(entrada.tenantId, (tx) => faturasEmCobranca(tx, agora));

  for (const fatura of emCobranca) {
    const passo = proximoPassoDaCobranca(estadoDaFatura(fatura), agora);
    if (passo === 'nada') continue;

    if (passo === 'cobrar' || passo === 'retentar') {
      /**
       * Sem cartão salvo não há o que tentar — e a fatura **não** gasta degrau.
       *
       * É o caso comum de uma barbearia pequena: o assinante paga no balcão, e a
       * fatura fica em aberto até alguém dar baixa. Contar isso como recusa faria
       * o cliente receber "não conseguimos cobrar o seu cartão" quando não há
       * cartão nenhum, e a escada correria contra quem paga em dia.
       */
      if (!fatura.payment_token) continue;

      const resultado = await entrada.provider.cobrar({
        tenantId: entrada.tenantId,
        faturaId: fatura.id,
        token: fatura.payment_token,
        valorCents: fatura.amount_cents,
        tentativa: fatura.attempts + 1,
        descricao: `Plano ${fatura.plano ?? 'assinatura'}`,
      });

      await withTenant(entrada.tenantId, async (tx) => {
        if (resultado.pago) {
          /**
           * `attempts` no `WHERE` além do estado.
           *
           * O estado sozinho bastaria para não pagar duas vezes, mas não para
           * impedir que dois workers na mesma volta gastem dois degraus da
           * escada pela mesma recusa. O contador é a versão da linha.
           */
          const baixadas = await tx.$executeRaw`
            UPDATE club_invoices
               SET status = 'paga', paid_at = ${agora}, paid_method = 'card',
                   attempts = attempts + 1, last_attempt_at = ${agora},
                   last_error = NULL, last_definitive = false,
                   psp_charge_id = coalesce(psp_charge_id, ${resultado.cobrancaId}),
                   updated_at = now()
             WHERE id = ${fatura.id}::uuid AND status = 'aberta'
               AND attempts = ${fatura.attempts}
          `;
          if (baixadas === 0) return;
          await reativar(tx, fatura.subscription_id, agora);
          contagem.pagas += 1;
          return;
        }

        const gravadas = await tx.$executeRaw`
          UPDATE club_invoices
             SET attempts = attempts + 1, last_attempt_at = ${agora},
                 last_error = ${resultado.motivo.slice(0, 200)},
                 last_definitive = ${resultado.definitiva}, updated_at = now()
           WHERE id = ${fatura.id}::uuid AND status = 'aberta'
             AND attempts = ${fatura.attempts}
        `;
        if (gravadas === 0) return;
        contagem.cobradas += 1;
        await avisarAssinante(
          tx,
          entrada.tenantId,
          fatura.subscription_id,
          'cobranca_recusada',
          `${fatura.id}:${fatura.attempts + 1}`,
        );
      });
      continue;
    }

    await withTenant(entrada.tenantId, async (tx) => {
      if (passo === 'marcar_inadimplente') {
        const marcadas = await tx.$executeRaw`
          UPDATE club_invoices SET marked_delinquent_at = ${agora}, updated_at = now()
           WHERE id = ${fatura.id}::uuid AND status = 'aberta'
             AND marked_delinquent_at IS NULL
        `;
        if (marcadas === 0) return;
        /**
         * O estado muda, o **benefício não**.
         *
         * `inadimplente` está em `ESTADOS_QUE_USAM`: o assinante continua
         * cortando. É o degrau que a SPEC pede em letras, e ele é o que separa
         * "cobrar de novo" de "perder o cliente".
         */
        await tx.$executeRaw`
          UPDATE club_subscriptions SET status = 'inadimplente', updated_at = now()
           WHERE id = ${fatura.subscription_id}::uuid AND status IN ('ativa', 'pendente')
        `;
        contagem.inadimplentes += 1;
        await avisarAssinante(
          tx,
          entrada.tenantId,
          fatura.subscription_id,
          'inadimplente',
          fatura.id,
        );
        return;
      }

      if (passo === 'suspender') {
        const suspensas = await tx.$executeRaw`
          UPDATE club_subscriptions
             SET status = 'suspensa', suspended_at = ${agora}, updated_at = now()
           WHERE id = ${fatura.subscription_id}::uuid
             AND status IN ('ativa', 'pendente', 'inadimplente')
        `;
        if (suspensas === 0) return;
        contagem.suspensas += 1;
        await avisarAssinante(tx, entrada.tenantId, fatura.subscription_id, 'suspenso', fatura.id);
      }
    });
  }

  contagem.encerradas = await encerrarCancelamentosVencidos({
    tenantId: entrada.tenantId,
    agora,
  });
  contagem.avisosDeCartao = await avisarCartoesAVencer({ tenantId: entrada.tenantId, agora });

  return contagem;
}

/**
 * Volta a assinatura para ativa quando a fatura é quitada.
 *
 * `suspended_at` é limpo junto porque a `CHECK` do banco exige coerência — e
 * porque a tela do cliente diz "pausado desde 12/08", que é uma frase que não
 * pode sobreviver ao pagamento.
 *
 * Quem pediu para sair **não** volta a ativa: pagar a fatura do ciclo em curso é
 * cumprir o que já era devido, não desistir do cancelamento. Desfazer é botão.
 */
async function reativar(
  tx: TransactionClient,
  assinaturaId: string,
  agora: Date,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE club_subscriptions
       SET status = 'ativa', suspended_at = NULL, updated_at = ${agora}
     WHERE id = ${assinaturaId}::uuid
       AND status IN ('pendente', 'inadimplente', 'suspensa')
  `;
}

// ---------------------------------------------------------------------------
// O balcão: baixa manual e cancelamento de fatura
// ---------------------------------------------------------------------------

interface Ator {
  readonly id: string;
  readonly name: string;
}

/**
 * Reexportada do `core`, e **importada** também: a reexportação sozinha não põe
 * o nome no escopo deste arquivo, e é o `build` que reclama — o `typecheck` da
 * API lê o `dist`, que ainda tinha a versão antiga.
 */
export { METODOS_DA_BAIXA, type MetodoDaBaixa } from '@barbearia/core';
import type { MetodoDaBaixa } from '@barbearia/core';

/**
 * O balcão dá baixa numa mensalidade.
 *
 * É o caminho que de fato acontece numa barbearia pequena: o cliente paga o
 * plano no Pix da casa, e alguém registra. Auditado porque quem digita "recebi
 * R$ 149" é a única testemunha de dinheiro que entrou por fora da gaveta — a
 * mesma razão do sinal do bloco 37.
 *
 * O estado no `WHERE` é quem impede a segunda baixa, e a contagem de linhas
 * afetadas é conferida: um `UPDATE` que não pegou ninguém e segue adiante vira
 * assinatura reativada sem pagamento.
 */
export async function registrarPagamentoDaFatura(entrada: {
  readonly tenantId: string;
  readonly faturaId: string;
  readonly metodo: MetodoDaBaixa;
  readonly ator: Ator;
  readonly agora?: Date;
}): Promise<{ readonly pago: true }> {
  const agora = entrada.agora ?? new Date();

  return withTenant(entrada.tenantId, async (tx) => {
    const [fatura] = await tx.$queryRaw<{ subscription_id: string; amount_cents: number }[]>`
      SELECT subscription_id, amount_cents FROM club_invoices
       WHERE id = ${entrada.faturaId}::uuid AND status = 'aberta'
       FOR UPDATE
    `;
    if (!fatura) throw new AssinaturaError('fatura_nao_encontrada', 'Esta fatura não está aberta.');

    const baixadas = await tx.$executeRaw`
      UPDATE club_invoices
         SET status = 'paga', paid_at = ${agora}, paid_method = ${entrada.metodo},
             updated_at = now()
       WHERE id = ${entrada.faturaId}::uuid AND status = 'aberta'
    `;
    if (baixadas === 0) {
      throw new AssinaturaError('fatura_nao_encontrada', 'Esta fatura não está aberta.');
    }

    await reativar(tx, fatura.subscription_id, agora);

    await audit(tx, {
      actorId: entrada.ator.id,
      actorName: entrada.ator.name,
      action: 'subscription.invoice_paid',
      entity: 'club_invoices',
      entityId: entrada.faturaId,
      after: { metodo: entrada.metodo, valorCents: fatura.amount_cents },
    });

    return { pago: true as const };
  });
}

/**
 * Cancelar uma fatura é perdoar uma dívida.
 *
 * Por isso é estado e não `DELETE` — a linha continua respondendo "vocês me
 * cobraram em março?" com o valor e a data intactos —, exige motivo escrito e é
 * auditada: perdoar mensalidade é dar desconto com outro nome, e desconto tem
 * dono na trilha desde o bloco 18.
 */
export async function cancelarFatura(entrada: {
  readonly tenantId: string;
  readonly faturaId: string;
  readonly motivo: string;
  readonly ator: Ator;
}): Promise<{ readonly cancelada: true }> {
  const motivo = entrada.motivo.trim();
  if (motivo.length < 3) {
    throw new AssinaturaError('motivo_obrigatorio', 'Escreva o motivo do cancelamento.');
  }

  return withTenant(entrada.tenantId, async (tx) => {
    const canceladas = await tx.$executeRaw`
      UPDATE club_invoices
         SET status = 'cancelada', void_reason = ${motivo}, updated_at = now()
       WHERE id = ${entrada.faturaId}::uuid AND status = 'aberta'
    `;
    if (canceladas === 0) {
      throw new AssinaturaError('fatura_nao_encontrada', 'Esta fatura não está aberta.');
    }

    await audit(tx, {
      actorId: entrada.ator.id,
      actorName: entrada.ator.name,
      action: 'subscription.invoice_voided',
      entity: 'club_invoices',
      entityId: entrada.faturaId,
      after: { motivo },
    });

    return { cancelada: true as const };
  });
}

// ---------------------------------------------------------------------------
// O cancelamento self-service
// ---------------------------------------------------------------------------

export interface CancelamentoAgendado {
  readonly valeAte: string;
}

/**
 * O cliente pede para sair.
 *
 * *"Cancelamento self-service obrigatório"* (SPEC §4.6), e não é gentileza: o
 * clube que só cancela por telefone é o que vira reclamação no Procon e estorno
 * no cartão — que custa mais caro que o mês que ele tentou segurar.
 *
 * Vale do **fim do ciclo pago**, e a data é congelada na hora do pedido: o
 * cliente vai ler a mesma frase amanhã, e derivá-la na leitura faria "seu plano
 * vale até 30/08" mudar se alguém mexesse na adesão.
 *
 * `customerId` no `WHERE` quando o pedido vem do cliente — a RLS separa
 * barbearias e não separa clientes dentro de uma.
 */
export async function agendarCancelamento(entrada: {
  readonly tenantId: string;
  readonly assinaturaId: string;
  readonly motivo: string;
  readonly ator: Ator | null;
  readonly customerId?: string;
  readonly agora?: Date;
}): Promise<CancelamentoAgendado> {
  const agora = entrada.agora ?? new Date();
  const motivo = entrada.motivo.trim();

  return withTenant(entrada.tenantId, async (tx) => {
    /**
     * A leitura trava a linha, porque é ela que decide a gravação.
     *
     * Sem `FOR UPDATE`, dois toques no botão "Cancelar" — que no celular é o
     * caso comum, não a exceção — leem os dois `cancel_requested_at IS NULL` e
     * gravam os dois. O segundo sobrescreveria a data congelada pelo primeiro.
     */
    const [assinatura] = entrada.customerId
      ? await tx.$queryRaw<{ id: string; started_at: Date }[]>`
          SELECT s.id, s.started_at
            FROM club_subscriptions s
           WHERE s.id = ${entrada.assinaturaId}::uuid
             AND s.customer_id = ${entrada.customerId}::uuid
             AND s.status <> 'cancelada' AND s.cancel_requested_at IS NULL
           FOR UPDATE
        `
      : await tx.$queryRaw<{ id: string; started_at: Date }[]>`
          SELECT s.id, s.started_at
            FROM club_subscriptions s
           WHERE s.id = ${entrada.assinaturaId}::uuid
             AND s.status <> 'cancelada' AND s.cancel_requested_at IS NULL
           FOR UPDATE
        `;
    if (!assinatura) {
      throw new AssinaturaError(
        'assinatura_nao_encontrada',
        'Esta assinatura não está ativa ou já foi cancelada.',
      );
    }

    const ciclo = cicloDaAssinatura(assinatura.started_at, agora);
    const valeAte = cancelamentoValeAPartirDe(ciclo.ate);

    await tx.$executeRaw`
      UPDATE club_subscriptions
         SET cancel_requested_at = ${agora}, cancel_effective_at = ${valeAte},
             cancel_reason = ${motivo.length > 0 ? motivo : null}, updated_at = now()
       WHERE id = ${entrada.assinaturaId}::uuid
    `;

    /**
     * `actor_id` nulo quando quem cancela é o próprio cliente.
     *
     * A trilha aponta para `staff_users`, e o cliente não é um. O nome escrito
     * diz de onde veio — é a mesma solução que a impersonação usa desde o bloco
     * 28 para registrar dois sujeitos numa linha só.
     */
    await audit(tx, {
      actorId: entrada.ator?.id ?? null,
      actorName: entrada.ator?.name ?? 'o próprio cliente',
      action: 'subscription.cancel_scheduled',
      entity: 'club_subscriptions',
      entityId: entrada.assinaturaId,
      after: { motivo, valeAte: valeAte.toISOString() },
    });

    await avisarAssinante(
      tx,
      entrada.tenantId,
      entrada.assinaturaId,
      'cancelamento_agendado',
      valeAte.toISOString(),
    );

    return { valeAte: valeAte.toISOString() };
  });
}

/**
 * O cliente mudou de ideia antes de o ciclo acabar.
 *
 * Todo estado precisa de saída **na tela** (§6 do CLAUDE.md), e este é o estado
 * mais valioso do produto para ter uma: quem desfaz o cancelamento é receita que
 * já estava contada como perdida.
 */
export async function desfazerCancelamento(entrada: {
  readonly tenantId: string;
  readonly assinaturaId: string;
  readonly ator: Ator | null;
  readonly customerId?: string;
}): Promise<{ readonly desfeito: true }> {
  return withTenant(entrada.tenantId, async (tx) => {
    const desfeitos = entrada.customerId
      ? await tx.$executeRaw`
          UPDATE club_subscriptions
             SET cancel_requested_at = NULL, cancel_effective_at = NULL,
                 cancel_reason = NULL, updated_at = now()
           WHERE id = ${entrada.assinaturaId}::uuid
             AND customer_id = ${entrada.customerId}::uuid
             AND status <> 'cancelada' AND cancel_requested_at IS NOT NULL
        `
      : await tx.$executeRaw`
          UPDATE club_subscriptions
             SET cancel_requested_at = NULL, cancel_effective_at = NULL,
                 cancel_reason = NULL, updated_at = now()
           WHERE id = ${entrada.assinaturaId}::uuid
             AND status <> 'cancelada' AND cancel_requested_at IS NOT NULL
        `;
    if (desfeitos === 0) {
      throw new AssinaturaError(
        'assinatura_nao_encontrada',
        'Esta assinatura não tem cancelamento agendado.',
      );
    }
    return { desfeito: true as const };
  });
}

/**
 * Fecha as assinaturas cujo ciclo pago acabou.
 *
 * O `WHERE` compara com `cancel_effective_at`, que foi congelado no pedido — e
 * não com um ciclo recalculado aqui. Duas fontes para o mesmo fato é o defeito
 * que a venda de pacote do bloco 42 ensinou a não repetir.
 */
export async function encerrarCancelamentosVencidos(entrada: {
  readonly tenantId: string;
  readonly agora?: Date;
}): Promise<number> {
  const agora = entrada.agora ?? new Date();
  return withTenant(entrada.tenantId, (tx) =>
    tx.$executeRaw`
      UPDATE club_subscriptions
         SET status = 'cancelada', cancelled_at = ${agora},
             suspended_at = NULL,
             -- O cartão salvo sai junto: assinatura cancelada não tem razão
             -- para guardar credencial cobrável. É a segunda camada do achado
             -- da revisão — o filtro de estado impede a cobrança, e isto tira
             -- a arma da mesa.
             payment_token = NULL, card_brand = NULL, card_last4 = NULL,
             card_exp_month = NULL, card_exp_year = NULL, card_warned_at = NULL,
             updated_at = now()
       WHERE cancel_effective_at IS NOT NULL AND cancel_effective_at <= ${agora}
         AND status <> 'cancelada'
    `,
  );
}

// ---------------------------------------------------------------------------
// O cartão
// ---------------------------------------------------------------------------

/**
 * Guarda o cartão salvo da assinatura.
 *
 * Token do provedor, bandeira, quatro últimos e validade — nada mais. Não existe
 * coluna para PAN nem para CVV, e há invariante no banco que reprova quem criar
 * uma.
 */
export async function salvarCartaoDaAssinatura(entrada: {
  readonly tenantId: string;
  readonly assinaturaId: string;
  readonly token: string;
  readonly bandeira: string;
  readonly ultimosQuatro: string;
  readonly mes: number;
  readonly ano: number;
}): Promise<{ readonly salvo: true }> {
  if (!/^[0-9]{4}$/.test(entrada.ultimosQuatro)) {
    throw new AssinaturaError('cartao_invalido', 'Confira os dados do cartão.');
  }
  if (entrada.mes < 1 || entrada.mes > 12 || entrada.ano < 2020 || entrada.ano > 2100) {
    throw new AssinaturaError('cartao_invalido', 'Confira os dados do cartão.');
  }
  if (entrada.token.trim().length === 0) {
    throw new AssinaturaError('cartao_invalido', 'Confira os dados do cartão.');
  }

  return withTenant(entrada.tenantId, async (tx) => {
    const salvos = await tx.$executeRaw`
      UPDATE club_subscriptions
         SET payment_token = ${entrada.token.trim()}, card_brand = ${entrada.bandeira},
             card_last4 = ${entrada.ultimosQuatro}, card_exp_month = ${entrada.mes},
             card_exp_year = ${entrada.ano}, card_warned_at = NULL, updated_at = now()
       WHERE id = ${entrada.assinaturaId}::uuid AND status <> 'cancelada'
    `;
    if (salvos === 0) {
      throw new AssinaturaError('assinatura_nao_encontrada', 'Esta assinatura não está ativa.');
    }
    return { salvo: true as const };
  });
}

/**
 * O aviso de cartão prestes a vencer, quinze dias antes (SPEC §4.6).
 *
 * Cartão vencido é o motivo nº 1 de cancelamento involuntário, e é o único que o
 * cliente conserta em trinta segundos se souber a tempo. `card_warned_at` é o
 * que impede o aviso diário — quinze dias de "seu cartão vai vencer" é o que faz
 * o canal ser ignorado, que é pior que canal nenhum.
 */
export async function avisarCartoesAVencer(entrada: {
  readonly tenantId: string;
  readonly agora?: Date;
}): Promise<number> {
  const agora = entrada.agora ?? new Date();

  return withTenant(entrada.tenantId, async (tx) => {
    const comCartao = await tx.$queryRaw<
      { id: string; card_exp_month: number; card_exp_year: number }[]
    >`
      SELECT id, card_exp_month, card_exp_year
        FROM club_subscriptions
       WHERE status IN ('ativa', 'inadimplente')
         AND card_exp_month IS NOT NULL AND card_exp_year IS NOT NULL
         AND card_warned_at IS NULL
    `;

    let avisados = 0;
    for (const assinatura of comCartao) {
      const vence = cartaoVaiVencer(
        { mes: assinatura.card_exp_month, ano: assinatura.card_exp_year },
        agora,
      );
      if (!vence) continue;

      await tx.$executeRaw`
        UPDATE club_subscriptions SET card_warned_at = ${agora}, updated_at = now()
         WHERE id = ${assinatura.id}::uuid AND card_warned_at IS NULL
      `;
      await avisarAssinante(
        tx,
        entrada.tenantId,
        assinatura.id,
        'cartao_vencendo',
        `${assinatura.card_exp_year}-${assinatura.card_exp_month}`,
      );
      avisados += 1;
    }
    return avisados;
  });
}

// ---------------------------------------------------------------------------
// A mensagem
// ---------------------------------------------------------------------------

export interface AvisoDoClube {
  readonly telefone: string;
  readonly barbearia: string;
  readonly texto: string;
}

/**
 * Monta o aviso que sai para o assinante.
 *
 * A frase vem de `packages/core` — o mesmo lugar de onde a tela do cliente e a
 * lista do balcão a leem. Três textos para o mesmo fato é como o treinamento
 * vira folclore: a recepção diz "está suspenso" e o cliente leu "em atraso".
 *
 * Devolve `null` quando não há mais a quem avisar: entre o enfileiramento e o
 * envio a pessoa pode ter pedido exclusão, e aí não há telefone. A tarefa
 * conclui, porque não há o que repetir.
 */
export async function montarAvisoDoClube(entrada: {
  readonly tenantId: string;
  readonly assinaturaId: string;
  readonly motivo: MotivoDoAvisoDoClube;
  readonly agora?: Date;
}): Promise<AvisoDoClube | null> {
  const agora = entrada.agora ?? new Date();

  return withTenant(entrada.tenantId, async (tx) => {
    const [linha] = await tx.$queryRaw<
      {
        telefone: string | null;
        plano: string | null;
        barbearia: string;
        cancel_effective_at: Date | null;
        vencimento: Date | null;
      }[]
    >`
      SELECT c.phone_e164 AS telefone, p.name AS plano, t.name AS barbearia,
             s.cancel_effective_at,
             (SELECT min(f.due_at) FROM club_invoices f
               WHERE f.subscription_id = s.id AND f.status = 'aberta') AS vencimento
        FROM club_subscriptions s
        JOIN customers c ON c.id = s.customer_id
        JOIN tenants t ON t.id = s.tenant_id
        LEFT JOIN club_plans p ON p.id = s.plan_id
       WHERE s.id = ${entrada.assinaturaId}::uuid
    `;
    if (!linha || !linha.telefone) return null;

    const texto = fraseDoAvisoDoClube(entrada.motivo, {
      plano: linha.plano ?? 'assinatura',
      barbearia: linha.barbearia,
      diasAteSuspender: linha.vencimento
        ? diasAteSuspender(linha.vencimento, agora)
        : DIAS_ATE_SUSPENDER,
      ...(linha.cancel_effective_at
        ? { valeAte: linha.cancel_effective_at.toLocaleDateString('pt-BR', { timeZone: 'UTC' }) }
        : {}),
    });

    return { telefone: linha.telefone, barbearia: linha.barbearia, texto };
  });
}
