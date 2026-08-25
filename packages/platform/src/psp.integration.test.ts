import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { semTenant } from '@barbearia/db';
import {
  aplicarEvento,
  aplicarRegua,
  assinarWebhook,
  conciliarPendentes,
  conciliarEstornosPendentes,
  conferirAssinaturaDoWebhook,
  emitirFatura,
  estornarCredito,
  estornosDaBarbearia,
  FakePspProvider,
  faturasDaBarbearia,
  JANELA_DO_WEBHOOK_SEGUNDOS,
  meioDePagamento,
  MOTIVO_DO_BLOQUEIO,
  PlataformaError,
  PspCobrancaProvider,
  salvarMeioDePagamento,
  WebhookInvalido,
  assinaturaDaBarbearia,
  bloqueioDaBarbearia,
} from './index.js';

/**
 * O adquirente contra Postgres real (bloco 29).
 *
 * O que esta suíte prova e as outras não podiam: que a mesma confirmação
 * chegando duas vezes move dinheiro uma vez só, que a rede de segurança fecha
 * o que o webhook perdeu sem contar o pagamento de novo, e que o estorno não
 * devolve mais do que existe de crédito.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const DOMARI = '29292929-aaaa-1111-1111-111111111111';
const ADMIN = 'd9292929-0000-0000-0000-000000000001';
const SEGREDO = 'segredo-de-teste-do-webhook';

const DIA = 86_400_000;
const FIM_DO_TESTE = new Date('2026-06-01T12:00:00Z');
const depois = (dias: number): Date => new Date(FIM_DO_TESTE.getTime() + dias * DIA);

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

describeIfDb('adquirente e conciliação', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await admin.$executeRawUnsafe('TRUNCATE platform_admins CASCADE');
    await admin.$executeRawUnsafe('TRUNCATE platform_audit');
    await admin.$executeRawUnsafe('TRUNCATE psp_events');

    await exec(`
      INSERT INTO platform_admins (id, email_key, name, password_hash)
      VALUES ('${ADMIN}', 'chave-29', 'Super', 'hash');

      INSERT INTO tenants (id, name) VALUES ('${DOMARI}', 'Domari');

      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('a9292929-0000-0000-0000-000000000009', '${DOMARI}', 'Matriz', 'America/Bahia');

      UPDATE subscriptions
         SET period_start = '2026-05-18T12:00:00Z', period_end = '${FIM_DO_TESTE.toISOString()}'
       WHERE tenant_id = '${DOMARI}';
    `);

    await salvarMeioDePagamento({
      adminId: ADMIN,
      tenantId: DOMARI,
      pspCustomerId: 'cus_domari',
      pspMethodId: 'pm_domari',
      bandeira: 'visa',
      final: '4242',
      validadeMes: 12,
      validadeAno: 2030,
    });
  });

  // -- o meio de pagamento ----------------------------------------------------

  it('guarda token e final, e a trilha registra quem cadastrou', async () => {
    const meio = await meioDePagamento(DOMARI);
    expect(meio).toMatchObject({ bandeira: 'visa', final: '4242', pspMethodId: 'pm_domari' });

    const trilha = await semTenant(
      (tx) => tx.$queryRaw<{ admin_id: string; detail: Record<string, unknown> }[]>`
        SELECT admin_id, detail FROM platform_audit WHERE action = 'billing.method_saved'
      `,
    );
    expect(trilha).toHaveLength(1);
    expect(trilha[0]?.admin_id).toBe(ADMIN);
    expect(trilha[0]?.detail['final']).toBe('4242');
  });

  // -- a cobrança pelo adquirente --------------------------------------------

  it('cartão aprovado quita a fatura na própria volta da régua', async () => {
    const psp = new FakePspProvider();
    const provider = new PspCobrancaProvider(psp);

    await aplicarRegua({ agora: depois(-3), provider });
    await aplicarRegua({ agora: depois(5), provider });

    psp.proximoEstado = 'paga';
    expect(await aplicarRegua({ agora: depois(6), provider })).toMatchObject({ pagas: 1 });

    expect(psp.cobrancas[0]).toMatchObject({ pspCustomerId: 'cus_domari', valorCents: 9900 });
    expect((await assinaturaDaBarbearia(DOMARI))?.estado).toBe('active');
  });

  /**
   * O caso que custa uma suspensão se for tratado como recusa.
   *
   * Pix e boleto respondem depois. Contar um degrau da escada a cada emissão
   * gastaria a escada inteira enquanto o dono paga.
   */
  it('cobrança pendente não gasta degrau da escada nem avisa o dono', async () => {
    const psp = new FakePspProvider();
    const provider = new PspCobrancaProvider(psp);
    psp.proximoEstado = 'pendente';

    await aplicarRegua({ agora: depois(-3), provider });
    await aplicarRegua({ agora: depois(5), provider });
    expect(await aplicarRegua({ agora: depois(6), provider })).toMatchObject({
      aguardando: 1,
      cobradas: 0,
    });

    const [fatura] = await faturasDaBarbearia(DOMARI);
    expect(fatura?.tentativas).toBe(1);
    expect(fatura?.chargeId).toBe('ch_fake_1');

    const avisos = await semTenant(
      (tx) => tx.$queryRaw<{ payload: Record<string, unknown> }[]>`
        SELECT payload FROM jobs WHERE kind = 'cobranca.aviso'
      `,
    );
    expect(avisos.some((a) => a.payload['assunto'] === 'tentativa_recusada')).toBe(false);
  });

  it('com cobrança em curso a régua não emite uma segunda', async () => {
    const psp = new FakePspProvider();
    const provider = new PspCobrancaProvider(psp);
    psp.proximoEstado = 'pendente';

    await aplicarRegua({ agora: depois(-3), provider });
    await aplicarRegua({ agora: depois(5), provider });
    await aplicarRegua({ agora: depois(6), provider });
    await aplicarRegua({ agora: depois(9), provider });
    await aplicarRegua({ agora: depois(13), provider });

    // Uma cobrança só: insistir emitiria um Pix por dia para a mesma fatura.
    expect(psp.cobrancas).toHaveLength(1);
  });

  it('cartão recusado não trava a amarração da tentativa seguinte', async () => {
    /**
     * O achado da `/security-review` do bloco 34.
     *
     * A Stripe recusa sem devolver id de cobrança, e a primeira tradução disso
     * foi string vazia. Vazio não é nulo: `amarrarCobranca` só escreve enquanto
     * `psp_charge_id IS NULL`, então a fatura ficava amarrada a nada **para
     * sempre**. A tentativa seguinte cobraria de verdade, o webhook dela
     * procuraria a fatura pelo id da cobrança, não acharia ninguém, e a
     * barbearia seria suspensa por uma fatura que pagou.
     *
     * O `FakePspProvider` escondia isso porque devolvia `ch_fake_N` até quando
     * recusava — fake que responde mais bonito que o provedor de verdade é
     * teste verde sobre caminho que não existe.
     */
    const psp = new FakePspProvider();
    const provider = new PspCobrancaProvider(psp);

    await aplicarRegua({ agora: depois(-3), provider });
    await aplicarRegua({ agora: depois(5), provider });
    // A primeira tentativa é recusada — `proximoEstado` já nasce assim.
    await aplicarRegua({ agora: depois(6), provider });

    const [recusada] = await faturasDaBarbearia(DOMARI);
    expect(recusada?.chargeId).toBeNull();

    psp.proximoEstado = 'paga';
    expect(await aplicarRegua({ agora: depois(9), provider })).toMatchObject({ pagas: 1 });

    const [paga] = await faturasDaBarbearia(DOMARI);
    expect(paga?.estado).toBe('paid');
    // E a cobrança que deu certo ficou amarrada: é por este id que o webhook e
    // a conciliação reencontram a fatura.
    expect(paga?.chargeId).toBe('ch_fake_2');
  });

  it('sem cartão cadastrado a régua segue no caminho manual', async () => {
    await semTenant((tx) => tx.$executeRaw`DELETE FROM billing_customers`);
    const psp = new FakePspProvider();
    const provider = new PspCobrancaProvider(psp);

    await aplicarRegua({ agora: depois(-3), provider });
    await aplicarRegua({ agora: depois(5), provider });
    expect(await aplicarRegua({ agora: depois(6), provider })).toMatchObject({ cobradas: 1 });
    expect(psp.cobrancas).toHaveLength(0);
  });

  // -- o webhook e a reentrega ------------------------------------------------

  /**
   * A reentrega é o comportamento normal do adquirente, não a exceção.
   *
   * Quem carrega esta garantia é a **máquina de estados**, e isso foi
   * descoberto quebrando de propósito a chave de `psp_events`: os dois testes
   * abaixo continuaram verdes sem ela. Depois de `charge.paid` a fatura fica
   * `paid` e a segunda entrega esbarra no estado; depois de `charge.failed` o
   * `psp_charge_id` foi limpo e a segunda entrega não acha a fatura.
   *
   * A tabela de eventos continua valendo por outras duas razões — ela é a
   * trilha do que o adquirente disse e quando, que é o que se abre numa
   * divergência de valor; e é a trava para a entrega **concorrente**, que este
   * ambiente não consegue exercer de forma determinística porque o pool
   * serializa as duas transações. O que não se prova aqui não é afirmado
   * como provado.
   */
  it('a confirmação quita a fatura, e a reentrega dela não quita de novo', async () => {
    const psp = new FakePspProvider();
    const provider = new PspCobrancaProvider(psp);
    psp.proximoEstado = 'pendente';

    await aplicarRegua({ agora: depois(-3), provider });
    await aplicarRegua({ agora: depois(5), provider });
    await aplicarRegua({ agora: depois(6), provider });

    const evento = {
      eventoId: 'evt_1',
      tipo: 'charge.paid' as const,
      chargeId: 'ch_fake_1',
      payload: {},
    };
    expect(await aplicarEvento(evento)).toBe('paid');
    // O adquirente reentrega por desenho. A segunda vez não pode mover nada.
    expect(await aplicarEvento(evento)).toBe('ignored');

    const [fatura] = await faturasDaBarbearia(DOMARI);
    expect(fatura?.estado).toBe('paid');

    const pagamentos = await semTenant(
      (tx) => tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM platform_audit WHERE action = 'invoice.paid'
      `,
    );
    expect(Number(pagamentos[0]?.n)).toBe(1);
  });

  it('a recusa solta a fatura para a próxima tentativa', async () => {
    const psp = new FakePspProvider();
    const provider = new PspCobrancaProvider(psp);
    psp.proximoEstado = 'pendente';

    await aplicarRegua({ agora: depois(-3), provider });
    await aplicarRegua({ agora: depois(5), provider });
    await aplicarRegua({ agora: depois(6), provider });

    expect(
      await aplicarEvento({
        eventoId: 'evt_falha',
        tipo: 'charge.failed',
        chargeId: 'ch_fake_1',
        payload: {},
      }),
    ).toBe('failed');

    const [fatura] = await faturasDaBarbearia(DOMARI);
    expect(fatura?.chargeId).toBeNull();
    expect(fatura?.tentativas).toBe(2);

    // Solta, ela volta para a escada e o adquirente é chamado de novo.
    await aplicarRegua({ agora: depois(9), provider });
    expect(psp.cobrancas).toHaveLength(2);
  });

  it('a reentrega de uma recusa não gasta um segundo degrau da escada', async () => {
    const psp = new FakePspProvider();
    const provider = new PspCobrancaProvider(psp);
    psp.proximoEstado = 'pendente';

    await aplicarRegua({ agora: depois(-3), provider });
    await aplicarRegua({ agora: depois(5), provider });
    await aplicarRegua({ agora: depois(6), provider });

    const recusa = {
      eventoId: 'evt_recusa',
      tipo: 'charge.failed' as const,
      chargeId: 'ch_fake_1',
      payload: {},
    };
    expect(await aplicarEvento(recusa)).toBe('failed');
    expect(await aplicarEvento(recusa)).toBe('ignored');
    expect(await aplicarEvento(recusa)).toBe('ignored');

    const [fatura] = await faturasDaBarbearia(DOMARI);
    expect(fatura?.estado).toBe('open');
    expect(fatura?.tentativas).toBe(2);
  });

  it('evento sobre cobrança desconhecida é ignorado, não é erro', async () => {
    expect(
      await aplicarEvento({
        eventoId: 'evt_orfao',
        tipo: 'charge.paid',
        chargeId: 'ch_que_nao_existe',
        payload: {},
      }),
    ).toBe('ignored');
  });

  // -- a rede de segurança ----------------------------------------------------

  it('a conciliação fecha o que o webhook perdeu', async () => {
    const psp = new FakePspProvider();
    const provider = new PspCobrancaProvider(psp);
    psp.proximoEstado = 'pendente';

    await aplicarRegua({ agora: depois(-3), provider });
    await aplicarRegua({ agora: depois(5), provider });
    await aplicarRegua({ agora: depois(6), provider });

    // O adquirente aprovou e o webhook nunca chegou.
    psp.liquidar('ch_fake_1', 'paga');
    expect(await conciliarPendentes({ provider: psp })).toMatchObject({
      consultadas: 1,
      pagas: 1,
    });
    expect((await faturasDaBarbearia(DOMARI))[0]?.estado).toBe('paid');
  });

  it('e a conciliação repetida não conta o pagamento duas vezes', async () => {
    const psp = new FakePspProvider();
    const provider = new PspCobrancaProvider(psp);
    psp.proximoEstado = 'pendente';

    await aplicarRegua({ agora: depois(-3), provider });
    await aplicarRegua({ agora: depois(5), provider });
    await aplicarRegua({ agora: depois(6), provider });

    psp.liquidar('ch_fake_1', 'paga');
    await conciliarPendentes({ provider: psp });
    // Segunda volta: a fatura já não está aberta e nem é consultada de novo.
    expect(await conciliarPendentes({ provider: psp })).toMatchObject({ consultadas: 0 });

    const pagamentos = await semTenant(
      (tx) => tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM platform_audit WHERE action = 'invoice.paid'
      `,
    );
    expect(Number(pagamentos[0]?.n)).toBe(1);
  });

  /**
   * Webhook e conciliação contando a mesma coisa é o caso comum, não o raro: a
   * rede roda todo dia e o webhook chega em segundos.
   */
  it('webhook e conciliação sobre o mesmo desfecho não se somam', async () => {
    const psp = new FakePspProvider();
    const provider = new PspCobrancaProvider(psp);
    psp.proximoEstado = 'pendente';

    await aplicarRegua({ agora: depois(-3), provider });
    await aplicarRegua({ agora: depois(5), provider });
    await aplicarRegua({ agora: depois(6), provider });

    psp.liquidar('ch_fake_1', 'paga');
    await aplicarEvento({
      eventoId: 'evt_webhook',
      tipo: 'charge.paid',
      chargeId: 'ch_fake_1',
      payload: {},
    });
    await conciliarPendentes({ provider: psp });

    const pagamentos = await semTenant(
      (tx) => tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM platform_audit WHERE action = 'invoice.paid'
      `,
    );
    expect(Number(pagamentos[0]?.n)).toBe(1);
  });

  it('pagar pelo adquirente destranca a barbearia suspensa pela régua', async () => {
    const psp = new FakePspProvider();
    const provider = new PspCobrancaProvider(psp);
    psp.proximoEstado = 'pendente';

    await aplicarRegua({ agora: depois(-3), provider });
    await aplicarRegua({ agora: depois(5), provider });
    // A cobrança sai aqui e fica pendente — é ela que o webhook vai confirmar.
    await aplicarRegua({ agora: depois(6), provider });
    await aplicarRegua({ agora: depois(26), provider });

    expect(await bloqueioDaBarbearia(DOMARI)).toMatchObject({
      bloqueada: true,
      motivo: MOTIVO_DO_BLOQUEIO,
    });

    const [fatura] = await faturasDaBarbearia(DOMARI);
    expect(fatura?.chargeId).toBe('ch_fake_1');
    await aplicarEvento({
      eventoId: 'evt_pagou',
      tipo: 'charge.paid',
      chargeId: 'ch_fake_1',
      payload: {},
    });

    expect(await bloqueioDaBarbearia(DOMARI)).toMatchObject({ bloqueada: false });
  });

  // -- a assinatura do webhook ------------------------------------------------

  it('assinatura correta passa; corpo trocado não', () => {
    const corpoCru = '{"id":"evt_1","type":"charge.paid"}';
    const agora = new Date('2026-06-10T10:00:00Z');
    const instante = Math.floor(agora.getTime() / 1000);
    const v1 = assinarWebhook({ corpoCru, segredo: SEGREDO, instante });

    expect(() =>
      conferirAssinaturaDoWebhook({
        corpoCru,
        cabecalho: `t=${instante},v1=${v1}`,
        segredo: SEGREDO,
        agora,
      }),
    ).not.toThrow();

    expect(() =>
      conferirAssinaturaDoWebhook({
        corpoCru: '{"id":"evt_1","type":"charge.failed"}',
        cabecalho: `t=${instante},v1=${v1}`,
        segredo: SEGREDO,
        agora,
      }),
    ).toThrow(WebhookInvalido);
  });

  it('rotação de segredo aceita qualquer assinatura v1 válida do cabeçalho', () => {
    const corpoCru = '{"id":"evt_rotacao"}';
    const agora = new Date('2026-06-10T10:00:00Z');
    const instante = Math.floor(agora.getTime() / 1000);
    const valida = assinarWebhook({ corpoCru, segredo: SEGREDO, instante });
    const antiga = assinarWebhook({ corpoCru, segredo: 'segredo-em-rotacao', instante });

    // A assinatura válida não é a última de propósito: a versão que colocava o
    // cabeçalho num Map descartava exatamente este caso.
    expect(() =>
      conferirAssinaturaDoWebhook({
        corpoCru,
        cabecalho: `t=${instante},v1=${valida},v1=${antiga}`,
        segredo: SEGREDO,
        agora,
      }),
    ).not.toThrow();
  });

  it('assinatura capturada não vale para sempre', () => {
    const corpoCru = '{"id":"evt_1"}';
    const agora = new Date('2026-06-10T10:00:00Z');
    const velho = Math.floor(agora.getTime() / 1000) - JANELA_DO_WEBHOOK_SEGUNDOS - 60;
    const v1 = assinarWebhook({ corpoCru, segredo: SEGREDO, instante: velho });

    expect(() =>
      conferirAssinaturaDoWebhook({
        corpoCru,
        cabecalho: `t=${velho},v1=${v1}`,
        segredo: SEGREDO,
        agora,
      }),
    ).toThrow(/janela/i);
  });

  it('segredo ausente é recusa, nunca liberação', () => {
    expect(() =>
      conferirAssinaturaDoWebhook({
        corpoCru: '{}',
        cabecalho: 't=1,v1=abc',
        segredo: '',
        agora: new Date(),
      }),
    ).toThrow(/PSP_WEBHOOK_SECRET/);
  });

  it('assinatura de outro segredo não passa', () => {
    const corpoCru = '{"id":"evt_1"}';
    const agora = new Date('2026-06-10T10:00:00Z');
    const instante = Math.floor(agora.getTime() / 1000);
    const v1 = assinarWebhook({ corpoCru, segredo: 'outro-segredo', instante });

    expect(() =>
      conferirAssinaturaDoWebhook({
        corpoCru,
        cabecalho: `t=${instante},v1=${v1}`,
        segredo: SEGREDO,
        agora,
      }),
    ).toThrow(WebhookInvalido);
  });

  // -- estorno ----------------------------------------------------------------

  /**
   * Uma fatura paga com cobrança amarrada.
   *
   * Estorno sai **de uma cobrança**, nunca "da conta" — adquirente nenhum
   * aceita a segunda coisa. Sem esta fatura no cenário, o que se testaria seria
   * a recusa, não a devolução.
   */
  async function faturaPagaComCobranca(chargeId = 'ch_paga_1'): Promise<void> {
    await semTenant(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO invoices
          (tenant_id, kind, status, plan_code, amount_cents, due_at,
           period_start, period_end, psp_charge_id, paid_at, paid_method)
        VALUES (
          ${DOMARI}::uuid, 'subscription', 'paid', 'pro', 24900,
          ${FIM_DO_TESTE}, ${FIM_DO_TESTE}, ${depois(30)},
          ${chargeId}, ${FIM_DO_TESTE}, 'card'
        )
      `;
    });
  }

  it('devolve o crédito em dinheiro e baixa o saldo na mesma transação', async () => {
    await exec(`UPDATE subscriptions SET credit_cents = 7500 WHERE tenant_id = '${DOMARI}'`);
    await faturaPagaComCobranca();
    const psp = new FakePspProvider();

    const estorno = await estornarCredito({
      adminId: ADMIN,
      tenantId: DOMARI,
      valorCents: 5000,
      motivo: 'desceu de plano e pediu de volta',
      idempotencyKey: 'teste-estorno-1',
      provider: psp,
    });

    expect(estorno).toMatchObject({ valorCents: 5000, estado: 'done' });
    expect(psp.estornos[0]).toMatchObject({
      pspCustomerId: 'cus_domari',
      valorCents: 5000,
      // Qual cobrança está sendo estornada. Sem isto a chamada não existe do
      // lado de lá — foi o que o provedor de verdade mostrou no bloco 34.
      pspChargeId: 'ch_paga_1',
    });

    const saldo = await semTenant(
      (tx) => tx.$queryRaw<{ credit_cents: number }[]>`
        SELECT credit_cents FROM subscriptions WHERE tenant_id = ${DOMARI}::uuid
      `,
    );
    expect(saldo[0]?.credit_cents).toBe(2500);
    expect(await estornosDaBarbearia(DOMARI)).toHaveLength(1);
  });

  it('não devolve mais do que existe de crédito', async () => {
    await exec(`UPDATE subscriptions SET credit_cents = 1000 WHERE tenant_id = '${DOMARI}'`);
    await faturaPagaComCobranca();

    await expect(
      estornarCredito({
        adminId: ADMIN,
        tenantId: DOMARI,
        valorCents: 5000,
        motivo: 'tentativa',
        idempotencyKey: 'teste-estorno-2',
        provider: new FakePspProvider(),
      }),
    ).rejects.toMatchObject({ code: 'insufficient_credit' });

    // E nada foi debitado no caminho: o débito e o lançamento são a mesma
    // transação, então falhar num falha nos dois.
    const saldo = await semTenant(
      (tx) => tx.$queryRaw<{ credit_cents: number }[]>`
        SELECT credit_cents FROM subscriptions WHERE tenant_id = ${DOMARI}::uuid
      `,
    );
    expect(saldo[0]?.credit_cents).toBe(1000);
    expect(await estornosDaBarbearia(DOMARI)).toHaveLength(0);
  });

  it('sem cobrança paga no adquirente, recusa **antes** de debitar o crédito', async () => {
    /**
     * A ordem é o que importa. Descobrir que não há o que estornar depois do
     * débito seria descobrir com o saldo da barbearia já reduzido e nada a
     * caminho dela — dinheiro que some de um lado sem aparecer no outro.
     */
    await exec(`UPDATE subscriptions SET credit_cents = 7500 WHERE tenant_id = '${DOMARI}'`);

    await expect(
      estornarCredito({
        adminId: ADMIN,
        tenantId: DOMARI,
        valorCents: 5000,
        motivo: 'sem cobrança para estornar',
        idempotencyKey: 'teste-estorno-3',
        provider: new FakePspProvider(),
      }),
    ).rejects.toMatchObject({ code: 'no_charge_to_refund' });

    const saldo = await semTenant(
      (tx) => tx.$queryRaw<{ credit_cents: number }[]>`
        SELECT credit_cents FROM subscriptions WHERE tenant_id = ${DOMARI}::uuid
      `,
    );
    expect(saldo[0]?.credit_cents).toBe(7500);
    expect(await estornosDaBarbearia(DOMARI)).toHaveLength(0);
  });

  it('falha ambígua deixa o estorno pendente e a conciliação o retoma com a mesma origem', async () => {
    await exec(`UPDATE subscriptions SET credit_cents = 7500 WHERE tenant_id = '${DOMARI}'`);
    await faturaPagaComCobranca('ch_origem_estorno');
    const psp = new FakePspProvider();
    const estornarReal = psp.estornar.bind(psp);
    let primeira = true;
    psp.estornar = async (pedido) => {
      const resposta = await estornarReal(pedido);
      if (primeira) {
        primeira = false;
        throw new Error('resposta do refund se perdeu');
      }
      return resposta;
    };

    await expect(estornarCredito({
      adminId: ADMIN,
      tenantId: DOMARI,
      valorCents: 5000,
      motivo: 'resposta perdida',
      idempotencyKey: 'teste-estorno-4',
      provider: psp,
    })).rejects.toThrow(/resposta do refund/);

    const [pendente] = await semTenant((tx) => tx.$queryRaw<{
      id: string; status: string; psp_charge_id: string | null;
    }[]>`SELECT id, status, psp_charge_id FROM refunds WHERE tenant_id = ${DOMARI}::uuid`);
    expect(pendente).toMatchObject({ status: 'pending', psp_charge_id: 'ch_origem_estorno' });
    expect(psp.estornos).toHaveLength(1);

    const retomada = await conciliarEstornosPendentes({ provider: psp });
    expect(retomada).toMatchObject({ consultados: 1, concluidos: 1, comFalha: 0 });
    // A chamada foi repetida, mas o fake usa `estornoId` como a Stripe e não
    // executa uma segunda devolução externa.
    expect(psp.estornos).toHaveLength(1);
    expect((await estornosDaBarbearia(DOMARI))[0]?.estado).toBe('done');
  });

  it('repetir o mesmo estorno administrativo não debita nem devolve duas vezes', async () => {
    await exec(`UPDATE subscriptions SET credit_cents = 7500 WHERE tenant_id = '${DOMARI}'`);
    await faturaPagaComCobranca('ch_idempotente');
    const psp = new FakePspProvider();
    const entrada = {
      adminId: ADMIN,
      tenantId: DOMARI,
      valorCents: 5000,
      motivo: 'mesma ação repetida',
      idempotencyKey: 'admin:mesma-chave',
      provider: psp,
    };

    const primeiro = await estornarCredito(entrada);
    const segundo = await estornarCredito(entrada);
    expect(segundo.id).toBe(primeiro.id);
    expect(psp.estornos).toHaveLength(1);
    const [saldo] = await semTenant((tx) => tx.$queryRaw<{ credit_cents: number }[]>`
      SELECT credit_cents FROM subscriptions WHERE tenant_id = ${DOMARI}::uuid
    `);
    expect(saldo?.credit_cents).toBe(2500);
  });


  it('duas requisições simultâneas com a mesma chave viram um único estorno', async () => {
    await exec(`UPDATE subscriptions SET credit_cents = 7500 WHERE tenant_id = '${DOMARI}'`);
    await faturaPagaComCobranca('ch_corrida_idempotente');
    const psp = new FakePspProvider();
    const entrada = {
      adminId: ADMIN,
      tenantId: DOMARI,
      valorCents: 5000,
      motivo: 'duplo clique concorrente',
      idempotencyKey: 'admin:corrida-mesma-chave',
      provider: psp,
    };

    const [a, b] = await Promise.all([estornarCredito(entrada), estornarCredito(entrada)]);
    expect(a.id).toBe(b.id);
    expect(psp.estornos).toHaveLength(1);
    const [saldo] = await semTenant((tx) => tx.$queryRaw<{ credit_cents: number }[]>`
      SELECT credit_cents FROM subscriptions WHERE tenant_id = ${DOMARI}::uuid
    `);
    expect(saldo?.credit_cents).toBe(2500);
  });

  it('recusa definitiva do adquirente devolve o crédito debitado', async () => {
    /**
     * 4xx é a Stripe dizendo que **nada saiu** da conta — a cobrança já foi
     * estornada, o valor não cabe. Deixar o crédito debitado nesse caso é a
     * barbearia perdendo saldo por um estorno que jamais aconteceu.
     *
     * O oposto — indisponibilidade — é ambíguo e **não** devolve, porque o
     * estorno pode ter sido feito e a resposta ter se perdido. Esse caminho
     * está provado no teste unitário do provedor, onde dá para escolher o
     * código HTTP.
     */
    await exec(`UPDATE subscriptions SET credit_cents = 7500 WHERE tenant_id = '${DOMARI}'`);
    await faturaPagaComCobranca();
    const psp = new FakePspProvider();
    psp.recusaOEstorno = true;

    await expect(
      estornarCredito({
        adminId: ADMIN,
        tenantId: DOMARI,
        valorCents: 5000,
        motivo: 'adquirente recusou',
        idempotencyKey: 'teste-estorno-5',
        provider: psp,
      }),
    ).rejects.toMatchObject({ code: 'refund_refused' });

    const saldo = await semTenant(
      (tx) => tx.$queryRaw<{ credit_cents: number }[]>`
        SELECT credit_cents FROM subscriptions WHERE tenant_id = ${DOMARI}::uuid
      `,
    );
    expect(saldo[0]?.credit_cents).toBe(7500);

    // O lançamento fica, marcado como falho: apagá-lo esconderia que alguém
    // tentou devolver e não conseguiu, que é a pergunta seguinte.
    const lancamentos = await estornosDaBarbearia(DOMARI);
    expect(lancamentos).toHaveLength(1);
    expect(lancamentos[0]?.estado).toBe('failed');
  });

  it('estorno exige motivo e valor positivo', async () => {
    await exec(`UPDATE subscriptions SET credit_cents = 7500 WHERE tenant_id = '${DOMARI}'`);
    const psp = new FakePspProvider();

    await expect(
      estornarCredito({
        adminId: ADMIN,
        tenantId: DOMARI,
        valorCents: 100,
        motivo: ' ',
        idempotencyKey: 'teste-estorno-6a',
        provider: psp,
      }),
    ).rejects.toBeInstanceOf(PlataformaError);
    await expect(
      estornarCredito({
        adminId: ADMIN,
        tenantId: DOMARI,
        valorCents: 0,
        motivo: 'nada',
        idempotencyKey: 'teste-estorno-6b',
        provider: psp,
      }),
    ).rejects.toMatchObject({ code: 'invalid_amount' });
  });

  it('barbearia sem conta no adquirente não recebe estorno', async () => {
    await semTenant((tx) => tx.$executeRaw`DELETE FROM billing_customers`);
    await exec(`UPDATE subscriptions SET credit_cents = 7500 WHERE tenant_id = '${DOMARI}'`);

    await expect(
      estornarCredito({
        adminId: ADMIN,
        tenantId: DOMARI,
        valorCents: 5000,
        motivo: 'devolução',
        idempotencyKey: 'teste-estorno-7',
        provider: new FakePspProvider(),
      }),
    ).rejects.toMatchObject({ code: 'no_payment_method' });
  });
});
