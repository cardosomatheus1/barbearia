import { createHmac, timingSafeEqual } from 'node:crypto';
import { semTenant } from '@barbearia/db';
import { registrarNaTrilha } from './plataforma.js';
import type { CobrancaProvider, ResultadoDaCobranca } from './cobranca.js';

/**
 * O adquirente (bloco 29, SPEC §9.1).
 *
 * Abstração pelos mesmos dois motivos de sempre (CLAUDE.md §4): trocar de
 * provedor não pode ser reescrever a régua, e teste de cobrança não pode
 * depender de sandbox de PSP no ar. O que muda em relação aos outros provedores
 * do produto é que **este tem duas direções**: nós pedimos a cobrança, e ele
 * responde depois, por webhook.
 *
 * ## Por que a resposta imediata não é a verdade
 *
 * Cartão responde na hora; Pix e boleto não. Uma implementação que tratasse
 * "não aprovou agora" como "recusou" marcaria uma tentativa na escada de
 * retentativa do bloco 28 a cada Pix emitido, e a barbearia seria suspensa por
 * um pagamento que estava a caminho. Por isso `EstadoDaCobranca` tem três
 * valores e não dois — e `pendente` é o que a régua trata como "ainda não
 * conte tentativa".
 */

export type EstadoDaCobranca = 'paga' | 'pendente' | 'recusada';

export interface PedidoDeCobranca {
  readonly tenantId: string;
  readonly faturaId: string;
  readonly valorCents: number;
  readonly pspCustomerId: string;
  readonly pspMethodId: string | null;
}

export interface RespostaDaCobranca {
  readonly estado: EstadoDaCobranca;
  readonly chargeId: string;
  /** O que dizer quando recusou. Vai para a trilha, nunca para o dono cru. */
  readonly motivo?: string;
}

export interface PedidoDeEstorno {
  readonly tenantId: string;
  readonly pspCustomerId: string;
  readonly valorCents: number;
}

export interface PspProvider {
  cobrar(pedido: PedidoDeCobranca): Promise<RespostaDaCobranca>;
  /** Pergunta o estado de uma cobrança. É a rede de segurança, não o caminho. */
  consultar(chargeId: string): Promise<EstadoDaCobranca>;
  estornar(pedido: PedidoDeEstorno): Promise<{ readonly refundId: string }>;
}

/**
 * O provedor de mentira, com estado controlável pelo teste.
 *
 * Recusa por padrão, como o `FakeCobrancaProvider` do bloco 28 e pelo mesmo
 * motivo: um fake que aprova faz a régua nunca ser exercida.
 */
export class FakePspProvider implements PspProvider {
  readonly cobrancas: PedidoDeCobranca[] = [];
  readonly estornos: PedidoDeEstorno[] = [];
  proximoEstado: EstadoDaCobranca = 'recusada';
  private contador = 0;

  async cobrar(pedido: PedidoDeCobranca): Promise<RespostaDaCobranca> {
    this.cobrancas.push(pedido);
    this.contador += 1;
    const chargeId = `ch_fake_${this.contador}`;
    this.estados.set(chargeId, this.proximoEstado);
    return this.proximoEstado === 'recusada'
      ? { estado: 'recusada', chargeId, motivo: 'cartão recusado' }
      : { estado: this.proximoEstado, chargeId };
  }

  private readonly estados = new Map<string, EstadoDaCobranca>();

  async consultar(chargeId: string): Promise<EstadoDaCobranca> {
    return this.estados.get(chargeId) ?? 'pendente';
  }

  /** Move uma cobrança já criada, para simular o que o webhook contaria. */
  liquidar(chargeId: string, estado: EstadoDaCobranca): void {
    this.estados.set(chargeId, estado);
  }

  async estornar(pedido: PedidoDeEstorno): Promise<{ readonly refundId: string }> {
    this.estornos.push(pedido);
    this.contador += 1;
    return { refundId: `re_fake_${this.contador}` };
  }
}

/**
 * A ponte entre o adquirente e a régua do bloco 28.
 *
 * A régua conhece `CobrancaProvider` e nada mais; ela não sabe que existe
 * webhook, cliente do provedor ou cartão salvo. Este adaptador é quem busca o
 * meio de pagamento da barbearia, chama o adquirente e traduz a resposta.
 *
 * **Barbearia sem cartão não é recusa técnica.** Ela é "não há como cobrar
 * automaticamente", e o resultado é o mesmo do `CobrancaManualProvider`: a
 * régua segue avisando e o Super Admin dá a baixa quando o dinheiro chegar. O
 * motivo escrito é o que separa uma coisa da outra na trilha.
 */
export class PspCobrancaProvider implements CobrancaProvider {
  constructor(private readonly psp: PspProvider) {}

  async cobrar(pedido: {
    readonly tenantId: string;
    readonly faturaId: string;
    readonly valorCents: number;
    readonly tentativa: number;
  }): Promise<ResultadoDaCobranca> {
    const conta = await meioDePagamento(pedido.tenantId);
    if (!conta || !conta.pspMethodId) {
      return { pago: false, motivo: 'sem meio de pagamento cadastrado' };
    }

    const resposta = await this.psp.cobrar({
      tenantId: pedido.tenantId,
      faturaId: pedido.faturaId,
      valorCents: pedido.valorCents,
      pspCustomerId: conta.pspCustomerId,
      pspMethodId: conta.pspMethodId,
    });

    await amarrarCobranca(pedido.faturaId, resposta.chargeId);

    if (resposta.estado === 'paga') return { pago: true, metodo: 'card' };
    /**
     * Pendente **não** é recusa, e a diferença custa uma suspensão.
     *
     * A régua conta tentativa a cada recusa e suspende no fim da escada. Tratar
     * um Pix emitido como recusado gastaria a escada inteira enquanto o dono
     * paga — e o webhook chegaria com a conta já fora do ar.
     */
    if (resposta.estado === 'pendente') {
      return { pago: false, motivo: 'aguardando confirmação do adquirente', aguardando: true };
    }
    return { pago: false, motivo: resposta.motivo ?? 'recusada pelo adquirente' };
  }
}

export interface MeioDePagamento {
  readonly tenantId: string;
  readonly pspCustomerId: string;
  readonly pspMethodId: string | null;
  readonly bandeira: string | null;
  readonly final: string | null;
  readonly validadeMes: number | null;
  readonly validadeAno: number | null;
}

interface LinhaDeMeio {
  tenant_id: string;
  psp_customer_id: string;
  psp_method_id: string | null;
  brand: string | null;
  last4: string | null;
  exp_month: number | null;
  exp_year: number | null;
}

const paraMeio = (l: LinhaDeMeio): MeioDePagamento => ({
  tenantId: l.tenant_id,
  pspCustomerId: l.psp_customer_id,
  pspMethodId: l.psp_method_id,
  bandeira: l.brand,
  final: l.last4,
  validadeMes: l.exp_month,
  validadeAno: l.exp_year,
});

export async function meioDePagamento(tenantId: string): Promise<MeioDePagamento | null> {
  return semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<LinhaDeMeio[]>`
      SELECT tenant_id, psp_customer_id, psp_method_id, brand, last4, exp_month, exp_year
        FROM billing_customers WHERE tenant_id = ${tenantId}::uuid
    `;
    const linha = linhas[0];
    return linha ? paraMeio(linha) : null;
  });
}

/**
 * Guarda o meio de pagamento que o adquirente devolveu.
 *
 * Recebe **token**, nunca número: o cartão é digitado no formulário do
 * provedor, que devolve um identificador. Se algum dia alguém tentar passar um
 * PAN por aqui, o `CHECK` de `last4` recusa — e não há coluna onde o resto
 * caberia.
 */
export async function salvarMeioDePagamento(entrada: {
  readonly adminId: string;
  readonly tenantId: string;
  readonly pspCustomerId: string;
  readonly pspMethodId: string | null;
  readonly bandeira?: string | null;
  readonly final?: string | null;
  readonly validadeMes?: number | null;
  readonly validadeAno?: number | null;
}): Promise<void> {
  await semTenant(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO billing_customers (tenant_id, psp_customer_id, psp_method_id,
                                     brand, last4, exp_month, exp_year)
      VALUES (${entrada.tenantId}::uuid, ${entrada.pspCustomerId}, ${entrada.pspMethodId ?? null},
              ${entrada.bandeira ?? null}, ${entrada.final ?? null},
              ${entrada.validadeMes ?? null}, ${entrada.validadeAno ?? null})
      ON CONFLICT (tenant_id) DO UPDATE SET
        psp_customer_id = EXCLUDED.psp_customer_id,
        psp_method_id = EXCLUDED.psp_method_id,
        brand = EXCLUDED.brand,
        last4 = EXCLUDED.last4,
        exp_month = EXCLUDED.exp_month,
        exp_year = EXCLUDED.exp_year,
        updated_at = now()
    `;

    // Dentro da mesma transação, como toda trilha deste schema: cadastrar o
    // cartão que a plataforma vai debitar é ato de plataforma sobre a conta de
    // outra empresa, e é o tipo de mudança cuja resposta a "quem fez isso?"
    // não pode depender de alguém ter lembrado de registrar depois.
    await registrarNaTrilha(tx, entrada.adminId, entrada.tenantId, 'billing.method_saved', {
      bandeira: entrada.bandeira ?? null,
      final: entrada.final ?? null,
    });
  });
}

/**
 * Amarra a cobrança do adquirente à fatura.
 *
 * `ON CONFLICT DO NOTHING` no índice único: uma segunda tentativa que gerasse
 * cobrança nova não pode roubar a amarração da primeira, senão o webhook da
 * primeira chegaria sem dono e o dinheiro ficaria sem fatura.
 */
async function amarrarCobranca(faturaId: string, chargeId: string): Promise<void> {
  await semTenant(async (tx) => {
    await tx.$executeRaw`
      UPDATE invoices SET psp_charge_id = ${chargeId}, updated_at = now()
       WHERE id = ${faturaId}::uuid AND psp_charge_id IS NULL
    `;
  });
}

// ---------------------------------------------------------------------------
// A assinatura do webhook
// ---------------------------------------------------------------------------

/** Quanto tempo um webhook assinado continua aceitável. */
export const JANELA_DO_WEBHOOK_SEGUNDOS = 300;

export class WebhookInvalido extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'WebhookInvalido';
  }
}

/**
 * Confere a assinatura do webhook.
 *
 * ## As três coisas que ela precisa impedir, e como
 *
 * 1. **Forjar um evento.** HMAC-SHA256 sobre `${timestamp}.${corpo cru}` com
 *    segredo compartilhado. Sobre o corpo **cru**, e não sobre o objeto já
 *    analisado: reserializar muda espaço em branco e ordem de chave, e a
 *    assinatura passaria a depender do JSON do Node em vez do que o adquirente
 *    de fato assinou.
 *
 * 2. **Reenviar um evento antigo capturado.** O instante entra na assinatura e
 *    a janela é de cinco minutos. Sem isso, um evento `paid` gravado hoje
 *    quitaria a fatura do mês que vem.
 *
 * 3. **Descobrir o segredo pelo tempo de resposta.** `timingSafeEqual`, nunca
 *    `===`. A comparação de string sai no primeiro byte diferente, e isso
 *    basta para reconstruir a assinatura byte a byte.
 *
 * O segredo vem do ambiente e **falha alto quando ausente** (CLAUDE.md §2):
 * cair num padrão vazio faria toda assinatura conferir.
 */
export function conferirAssinaturaDoWebhook(entrada: {
  readonly corpoCru: string;
  readonly cabecalho: string | undefined;
  readonly segredo: string;
  readonly agora: Date;
}): void {
  if (!entrada.segredo) {
    throw new WebhookInvalido('webhook_secret_missing', 'PSP_WEBHOOK_SECRET não configurado');
  }
  if (!entrada.cabecalho) {
    throw new WebhookInvalido('missing_signature', 'Assinatura ausente');
  }

  const partes = new Map(
    entrada.cabecalho
      .split(',')
      .map((p) => p.trim().split('='))
      .filter((p): p is [string, string] => p.length === 2 && p[0] !== undefined && p[1] !== undefined)
      .map(([k, v]) => [k, v] as const),
  );
  const t = partes.get('t');
  const v1 = partes.get('v1');
  if (!t || !v1) throw new WebhookInvalido('malformed_signature', 'Assinatura malformada');

  const instante = Number(t);
  if (!Number.isFinite(instante)) {
    throw new WebhookInvalido('malformed_signature', 'Assinatura malformada');
  }
  const distancia = Math.abs(entrada.agora.getTime() / 1000 - instante);
  if (distancia > JANELA_DO_WEBHOOK_SEGUNDOS) {
    throw new WebhookInvalido('stale_signature', 'Assinatura fora da janela');
  }

  const esperado = assinarWebhook({ corpoCru: entrada.corpoCru, segredo: entrada.segredo, instante });
  const a = Buffer.from(esperado, 'utf8');
  const b = Buffer.from(v1, 'utf8');
  // Comprimento diferente já é recusa, e `timingSafeEqual` lança nesse caso —
  // conferir antes é o que transforma a exceção em recusa.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new WebhookInvalido('invalid_signature', 'Assinatura inválida');
  }
}

/** A outra ponta da mesma conta. Existe para o teste assinar como o provedor. */
export function assinarWebhook(entrada: {
  readonly corpoCru: string;
  readonly segredo: string;
  readonly instante: number;
}): string {
  return createHmac('sha256', entrada.segredo)
    .update(`${entrada.instante}.${entrada.corpoCru}`)
    .digest('hex');
}
