import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakePaymentProvider } from '@barbearia/core';
import { withTenant } from '@barbearia/db';
import { abrirCaixa, fecharCaixaDaUnidade } from './caixa.js';
import {
  abrirComanda,
  adicionarItem,
  cancelarComanda,
  comandasAbertas,
  fecharComanda,
  getComanda,
} from './comanda.js';
import {
  cancelarCobranca,
  cobrancasDaComanda,
  conciliarCobrancas,
  confirmarCobranca,
  criarCobrancaDaComanda,
} from './cobranca-online.js';

/**
 * O Pix da comanda contra Postgres real (bloco 35).
 *
 * O que só o banco prova: que dois toques no "Cobrar" não geram dois QR Codes,
 * que a confirmação repetida não fecha a venda duas vezes, e que a cadeia
 * inteira da SPEC §3.3 — comanda, caixa, comissão — anda junto ou não anda.
 * Nenhuma dessas garantias existe em memória: elas são índice único, chave
 * primária e transação.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '35353535-1111-1111-1111-111111111111';
const LOCATION = '35353535-aaaa-0000-0000-000000000001';
const FILIAL = '35353535-aaaa-0000-0000-000000000002';
const RUAN = '35353535-bbbb-0000-0000-000000000001';
const CABELO = '35353535-eeee-0000-0000-000000000001';
const CARLOS = '35353535-cccc-0000-0000-000000000001';
const STAFF = '35353535-ffff-0000-0000-000000000001';

const HOJE = '2026-09-10';
/** O relógio entra por parâmetro: nada aqui depende da hora em que a suíte roda. */
const AGORA = new Date('2026-09-10T12:00:00Z');
const operador = { staffId: STAFF, staffName: 'Maria Recepção' };

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

describeIfDb('a cobrança online da comanda', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await exec(`
      INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Domari');

      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('${LOCATION}', '${TENANT}', 'Matriz', 'America/Bahia'),
             ('${FILIAL}', '${TENANT}', 'Filial', 'America/Bahia');

      INSERT INTO professionals (id, tenant_id, location_id, name, kind)
      VALUES ('${RUAN}', '${TENANT}', '${LOCATION}', 'Ruan', 'professional');

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes)
      VALUES ('${CABELO}', '${TENANT}', 'Cabelo', 4900, 30);

      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777');

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${STAFF}', '${TENANT}', 'Maria', 'maria@domari.com.br', 'x', 'receptionist');

      -- Sem regra de comissão, item com profissional não gera lançamento — e o
      -- teste da cadeia da SPEC §3.3 estaria provando menos do que diz.
      INSERT INTO commission_rules (tenant_id, professional_id, mode, value)
      VALUES ('${TENANT}', '${RUAN}', 'percent', 4000);
    `);
  });

  const abrirGaveta = () =>
    abrirCaixa({ tenantId: TENANT, locationId: LOCATION, openingCents: 20000, ...operador });

  async function comandaDe4900(): Promise<string> {
    const comanda = await abrirComanda({
      tenantId: TENANT,
      locationId: LOCATION,
      customerId: CARLOS,
      ...operador,
    });
    await adicionarItem({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId: comanda.id,
      tipo: 'service',
      serviceId: CABELO,
      descricao: 'Corte',
      quantidade: 1,
      precoUnitarioCents: 4900,
      professionalId: RUAN,
    });
    return comanda.id;
  }

  const cobrar = (orderId: string, provider: FakePaymentProvider, chave = 'toque-1') =>
    criarCobrancaDaComanda({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId,
      meio: 'pix',
      idempotencyKey: chave,
      provider,
      agora: AGORA,
      ...operador,
    });

  // -- emissão ---------------------------------------------------------------

  it('o QR Code sai com o valor da comanda e o copia-e-cola', async () => {
    const orderId = await comandaDe4900();
    const provider = new FakePaymentProvider();

    const cobranca = await cobrar(orderId, provider);

    expect(cobranca.estado).toBe('aguardando');
    expect(cobranca.valorCents).toBe(4900);
    // O **texto**, não a imagem: quem paga pelo mesmo celular que abriu a tela
    // não consegue fotografar a própria tela.
    expect(cobranca.pixCopiaECola).toContain('fake');
    expect(cobranca.pagamentoId).toBeTruthy();
  });

  it('a chave que vai ao adquirente é o id da própria linha', async () => {
    /**
     * E não a chave do balcão. Se o processo cair entre gravar a linha e
     * receber a resposta, a retentativa reencontra a **mesma** cobrança no
     * adquirente em vez de emitir a segunda — que é o que o cliente veria como
     * dois QR Codes para a mesma conta.
     */
    const orderId = await comandaDe4900();
    const provider = new FakePaymentProvider();

    const cobranca = await cobrar(orderId, provider);

    expect(provider.cobrancas[0]?.idempotencyKey).toBe(cobranca.id);
  });

  it('dois toques no "Cobrar" devolvem a mesma cobrança', async () => {
    // O duplo toque no celular do balcão é o caso comum, não a exceção.
    const orderId = await comandaDe4900();
    const provider = new FakePaymentProvider();

    const primeira = await cobrar(orderId, provider);
    const segunda = await cobrar(orderId, provider);

    expect(segunda.id).toBe(primeira.id);
    expect(provider.cobrancas).toHaveLength(1);
    expect(await cobrancasDaComanda(TENANT, orderId, LOCATION)).toHaveLength(1);
  });

  it('a mesma chave pode existir em duas unidades sem devolver o Pix da outra loja', async () => {
    const provider = new FakePaymentProvider();
    const matriz = await comandaDe4900();
    const primeira = await cobrar(matriz, provider, 'mesma-chave');

    const comandaFilial = await abrirComanda({
      tenantId: TENANT,
      locationId: FILIAL,
      customerId: CARLOS,
      ...operador,
    });
    await adicionarItem({
      tenantId: TENANT,
      locationId: FILIAL,
      orderId: comandaFilial.id,
      tipo: 'service',
      serviceId: CABELO,
      descricao: 'Corte',
      quantidade: 1,
      precoUnitarioCents: 4900,
    });
    const segunda = await criarCobrancaDaComanda({
      tenantId: TENANT,
      locationId: FILIAL,
      orderId: comandaFilial.id,
      meio: 'pix',
      idempotencyKey: 'mesma-chave',
      provider,
      agora: AGORA,
      ...operador,
    });

    expect(segunda.id).not.toBe(primeira.id);
    expect(segunda.orderId).toBe(comandaFilial.id);
    expect(provider.cobrancas).toHaveLength(2);
  });

  it('duas chaves diferentes na mesma comanda: a segunda é recusada', async () => {
    /**
     * A trava é o índice único parcial, não uma consulta antes do `INSERT` —
     * essa tem janela de corrida, e dois toques acontecem em milissegundos.
     * Dois QR Codes vivos para a mesma conta é o cliente pagando duas vezes.
     */
    const orderId = await comandaDe4900();
    const provider = new FakePaymentProvider();

    await cobrar(orderId, provider, 'toque-1');
    await expect(cobrar(orderId, provider, 'toque-2')).rejects.toMatchObject({
      code: 'cobranca_em_curso',
    });
  });

  it('comanda sem itens não gera cobrança', async () => {
    // Cobrar zero produziria um QR Code que nenhum banco aceita, e o balcão
    // ficaria olhando uma tela que nunca confirma.
    const comanda = await abrirComanda({
      tenantId: TENANT,
      locationId: LOCATION,
      customerId: CARLOS,
      ...operador,
    });

    await expect(cobrar(comanda.id, new FakePaymentProvider())).rejects.toMatchObject({
      code: 'comanda_sem_valor',
    });
  });

  it('resposta perdida na emissão preserva a cobrança e a mesma chave a recupera', async () => {
    /**
     * O adquirente pode ter criado o Pix e perdido apenas a resposta. Expirar
     * a linha local nesse ponto abriria uma segunda cobrança enquanto a
     * primeira continua pagável no mundo externo. A linha permanece viva e a
     * mesma Idempotency-Key reapresenta a mesma intenção.
     */
    const orderId = await comandaDe4900();
    const provider = new FakePaymentProvider();
    const criarReal = provider.criarCobranca.bind(provider);
    let primeira = true;
    provider.criarCobranca = async (pedido) => {
      const criada = await criarReal(pedido);
      if (primeira) {
        primeira = false;
        throw new Error('resposta perdida depois de criar');
      }
      return criada;
    };

    await expect(cobrar(orderId, provider, 'mesma-intencao')).rejects.toThrow(/resposta perdida/);

    const depoisDaFalha = await cobrancasDaComanda(TENANT, orderId, LOCATION);
    expect(depoisDaFalha).toHaveLength(1);
    expect(depoisDaFalha[0]).toMatchObject({ estado: 'aguardando', pagamentoId: null });
    expect(provider.cobrancas).toHaveLength(1);

    // Uma chave nova continua bloqueada: não sabemos que a cobrança externa morreu.
    await expect(cobrar(orderId, provider, 'outra-intencao')).rejects.toMatchObject({
      code: 'cobranca_em_curso',
    });

    const recuperada = await cobrar(orderId, provider, 'mesma-intencao');
    expect(recuperada.pagamentoId).toBe('fake_pay_1');
    expect(provider.cobrancas).toHaveLength(1);
  });

  it('a conciliação recupera emissão sem resposta e se reagenda enquanto houver cobrança viva', async () => {
    const orderId = await comandaDe4900();
    const provider = new FakePaymentProvider();
    const criarReal = provider.criarCobranca.bind(provider);
    let primeira = true;
    provider.criarCobranca = async (pedido) => {
      const criada = await criarReal(pedido);
      if (primeira) {
        primeira = false;
        throw new Error('resposta perdida depois de criar');
      }
      return criada;
    };

    await expect(cobrar(orderId, provider, 'recon')).rejects.toThrow();

    const varredura = await conciliarCobrancas({ tenantId: TENANT, provider, agora: AGORA });
    expect(varredura).toMatchObject({ pendentes: 1, comFalha: 0 });
    expect((await cobrancasDaComanda(TENANT, orderId, LOCATION))[0]?.pagamentoId).toBe('fake_pay_1');
    expect(provider.cobrancas).toHaveLength(1);

    const tarefas = await withTenant(TENANT, (tx) => tx.$queryRaw<{ idempotency_key: string }[]>`
      SELECT idempotency_key FROM jobs
       WHERE tenant_id = ${TENANT}::uuid
         AND kind = 'cobranca.conciliar'
         AND idempotency_key LIKE 'cobranca-recon:%'
    `);
    expect(tarefas).toHaveLength(1);
  });

  it('a conferência é enfileirada **junto** com a cobrança', async () => {
    /**
     * Dentro da mesma transação. Enfileirar depois do commit abriria a janela
     * em que o QR Code existe e nada está marcado para conferi-lo — o processo
     * cai e a comanda fica presa, porque só uma cobrança viva é permitida por
     * vez.
     *
     * O payload vai **vazio**: `jobs` não tem RLS e é legível sem tenant, então
     * o copia-e-cola do Pix não atravessa a fila.
     */
    const orderId = await comandaDe4900();
    await cobrar(orderId, new FakePaymentProvider());

    const tarefas = await withTenant(TENANT, (tx) => tx.$queryRaw<
      { kind: string; payload: Record<string, unknown>; run_after: Date; tenant_id: string }[]
    >`
      SELECT kind, payload, run_after, tenant_id FROM jobs WHERE kind = 'cobranca.conciliar'
    `);

    expect(tarefas).toHaveLength(1);
    expect(tarefas[0]?.payload).toEqual({});
    expect(tarefas[0]?.tenant_id).toBe(TENANT);
    // Depois da janela do Pix: antes disso o webhook é o caminho, e perguntar
    // ao adquirente a cada minuto seria pesquisa em laço sobre o caso normal.
    expect(tarefas[0]?.run_after.getTime()).toBe(AGORA.getTime() + 30 * 60_000);
  });

  it('a emissão que falha não deixa tarefa órfã na fila', async () => {
    // A transação é a mesma: se a linha da cobrança some, a tarefa some junto.
    const orderId = await comandaDe4900();
    const quebrado = new FakePaymentProvider();
    quebrado.criarCobranca = async () => {
      throw new Error('adquirente fora do ar');
    };

    await expect(cobrar(orderId, quebrado)).rejects.toThrow(/fora do ar/);

    // A linha da cobrança existe (nasce antes da chamada, de propósito) e a
    // tarefa existe com ela — é ela que vai encerrar a órfã por tempo.
    const tarefas = await withTenant(TENANT, (tx) => tx.$queryRaw<{ kind: string }[]>`
      SELECT kind FROM jobs WHERE kind = 'cobranca.conciliar'
    `);
    expect(tarefas).toHaveLength(1);
  });

  it('a cobrança órfã, sem id do adquirente, é encerrada pela varredura', async () => {
    /**
     * Ela nasceu e o processo caiu antes de a resposta chegar. Sem tratamento
     * ela travaria a comanda para sempre, porque só uma cobrança viva é
     * permitida por vez — e ela nunca sairia de `aguardando` sozinha.
     */
    const orderId = await comandaDe4900();
    const quebrado = new FakePaymentProvider();
    quebrado.criarCobranca = async () => {
      throw new Error('adquirente fora do ar');
    };
    await expect(cobrar(orderId, quebrado)).rejects.toThrow(/fora do ar/);

    // A emissão já a marcou `expirado` no caminho do erro; forçar de volta a
    // `aguardando` é o que reproduz o processo que **caiu** antes disso.
    await withTenant(TENANT, (tx) => tx.$executeRaw`
      UPDATE order_charges SET status = 'aguardando', psp_payment_id = NULL
    `);

    const varredura = await conciliarCobrancas({
      tenantId: TENANT,
      provider: new FakePaymentProvider(),
      agora: AGORA,
    });

    // Nada a consultar — não há id para perguntar por.
    expect(varredura).toMatchObject({ consultadas: 0, encerradas: 1 });
    expect((await cobrancasDaComanda(TENANT, orderId, LOCATION))[0]?.estado).toBe('expirado');
  });

  // -- confirmação -----------------------------------------------------------

  const confirmar = (
    pagamentoId: string,
    eventoId = 'evt_1',
    provider: FakePaymentProvider = new FakePaymentProvider(),
  ) =>
    confirmarCobranca({
      tenantId: TENANT,
      eventoId,
      tipo: 'payment_intent.succeeded',
      pagamentoId,
      estado: 'pago',
      provider,
      agora: AGORA,
    });

  it('a confirmação dispara a cadeia: fecha comanda, entra no caixa e gera comissão', async () => {
    /**
     * A cadeia da SPEC §3.3, e ela é **uma transação**. "Marca pago agora,
     * fecha depois" abriria a janela em que o dinheiro está confirmado e a
     * venda não existe — e ninguém sabe, olhando o banco, se o fechamento
     * ainda vai acontecer ou se falhou.
     */
    await abrirGaveta();
    const orderId = await comandaDe4900();
    const provider = new FakePaymentProvider();
    const cobranca = await cobrar(orderId, provider);

    const resultado = await confirmar(cobranca.pagamentoId ?? '');

    expect(resultado.desfecho).toBe('pago');
    expect(resultado.comanda?.status).toBe('paid');

    const comanda = await getComanda(TENANT, orderId, LOCATION);
    expect(comanda.status).toBe('paid');
    expect(comanda.pagamentos[0]).toMatchObject({ forma: 'pix', valorCents: 4900 });

    const [gaveta] = await withTenant(TENANT, (tx) => tx.$queryRaw<{ kind: string }[]>`
      SELECT kind::text FROM cash_movements WHERE order_id = ${orderId}::uuid
    `);
    // Pix não entra na gaveta física — o dinheiro cai na conta. `entraNaGaveta`
    // do bloco 18 já decidia isso, e a confirmação não muda a regra.
    expect(gaveta).toBeUndefined();

    const comissoes = await withTenant(TENANT, (tx) => tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM commission_entries WHERE order_id = ${orderId}::uuid
    `);
    expect(comissoes).toHaveLength(1);
  });

  it('a mesma confirmação chegando duas vezes fecha a venda uma vez', async () => {
    /**
     * Reentrega é o comportamento normal do adquirente, não a exceção. Duas
     * camadas travam: a chave primária de `order_charge_events` para a entrega
     * concorrente, e o `AND status = 'aguardando'` para a sequencial — a
     * segunda não depende de ninguém ter lembrado de registrar o evento.
     */
    await abrirGaveta();
    const orderId = await comandaDe4900();
    const cobranca = await cobrar(orderId, new FakePaymentProvider());
    const pagamentoId = cobranca.pagamentoId ?? '';

    expect((await confirmar(pagamentoId, 'evt_1')).desfecho).toBe('pago');
    // Mesmo evento: barrado pela chave primária.
    expect((await confirmar(pagamentoId, 'evt_1')).desfecho).toBe('ignorado');
    // Evento diferente sobre a mesma cobrança: barrado pelo estado.
    expect((await confirmar(pagamentoId, 'evt_2')).desfecho).toBe('ignorado');

    const pagamentos = await withTenant(TENANT, (tx) => tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM order_payments WHERE order_id = ${orderId}::uuid
    `);
    expect(pagamentos).toHaveLength(1);

    const comissoes = await withTenant(TENANT, (tx) => tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM commission_entries WHERE order_id = ${orderId}::uuid
    `);
    expect(comissoes).toHaveLength(1);
  });

  it('sem caixa aberto o dinheiro é confirmado e a venda fica aberta', async () => {
    /**
     * Não é omissão. Desde o bloco 18 nenhuma venda entra sem gaveta aberta,
     * porque a divergência do fechamento precisa ter dono. Forçar aqui
     * inventaria uma gaveta; recusar o pagamento seria pior, porque o cliente
     * já pagou. O que sobra é a verdade, e a tela diz o que fazer.
     */
    const orderId = await comandaDe4900();
    const cobranca = await cobrar(orderId, new FakePaymentProvider());

    const resultado = await confirmar(cobranca.pagamentoId ?? '');

    expect(resultado.desfecho).toBe('pago_sem_caixa');
    expect((await getComanda(TENANT, orderId, LOCATION)).status).toBe('open');
    expect((await cobrancasDaComanda(TENANT, orderId, LOCATION))[0]?.estado).toBe('pago');

    // E abrindo o caixa, a conciliação não refaz nada: a cobrança já saiu de
    // `aguardando`, então ela não é mais varrida.
    await abrirGaveta();
    const varredura = await conciliarCobrancas({
      tenantId: TENANT,
      provider: new FakePaymentProvider(),
      agora: AGORA,
    });
    expect(varredura.consultadas).toBe(0);
  });

  it('cobrança recusada libera a comanda para outra tentativa', async () => {
    await abrirGaveta();
    const orderId = await comandaDe4900();
    const provider = new FakePaymentProvider();
    const cobranca = await cobrar(orderId, provider);

    const resultado = await confirmarCobranca({
      tenantId: TENANT,
      eventoId: 'evt_falhou',
      tipo: 'payment_intent.payment_failed',
      pagamentoId: cobranca.pagamentoId ?? '',
      estado: 'recusado',
      motivo: 'card_declined',
      provider,
      agora: AGORA,
    });

    expect(resultado.desfecho).toBe('recusado');
    expect((await getComanda(TENANT, orderId, LOCATION)).status).toBe('open');
    // E dá para cobrar de novo: o índice único só vale para `aguardando`.
    const outra = await cobrar(orderId, provider, 'toque-2');
    expect(outra.estado).toBe('aguardando');
  });

  it('evento sobre pagamento desconhecido é ignorado, não erro', async () => {
    // O adquirente manda evento de coisas que não são nossas — e uma cobrança
    // de outra barbearia é invisível aqui pela RLS, que é o ponto.
    const resultado = await confirmar('pi_que_nao_existe', 'evt_estranho');
    expect(resultado.desfecho).toBe('ignorado');
  });

  it('com Pix vivo, a comanda não aceita item novo', async () => {
    /**
     * O valor da cobrança é congelado na emissão, e o cliente já está com o
     * código na mão. Acrescentar um item depois criaria uma comanda de R$ 69
     * com um Pix de R$ 49: o cliente paga o que está no código, a confirmação
     * tenta fechar a venda com o valor errado, e **nada** fecha — dinheiro
     * recebido sem venda.
     *
     * O caminho para mudar a conta existe e é explícito: cancelar, mexer,
     * cobrar de novo.
     */
    const orderId = await comandaDe4900();
    const cobranca = await cobrar(orderId, new FakePaymentProvider());

    await expect(
      adicionarItem({
        tenantId: TENANT,
        locationId: LOCATION,
        orderId,
        tipo: 'service',
        descricao: 'Barba',
        quantidade: 1,
        precoUnitarioCents: 2000,
      }),
    ).rejects.toMatchObject({ code: 'cobranca_em_curso' });

    // Cancelado o Pix, o balcão volta a mexer na conta.
    await cancelarCobranca({
      locationId: LOCATION,
      tenantId: TENANT,
      orderId,
      chargeId: cobranca.id,
      provider: new FakePaymentProvider(),
      ...operador,
    });
    const depois = await adicionarItem({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId,
      tipo: 'service',
      descricao: 'Barba',
      quantidade: 1,
      precoUnitarioCents: 2000,
    });
    expect(depois.totalCents).toBe(6900);
  });

  it('se o fechamento falha, **nada** é marcado como pago', async () => {
    /**
     * A prova de que a cadeia é uma transação só. A cobrança e o fechamento
     * compartilham a transação: se `fecharComanda` recusa, a marcação de
     * `pago` volta atrás junto, e a entrega seguinte do adquirente ainda tem o
     * que fazer.
     *
     * Sem a transação compartilhada, o estado ficaria "cobrança paga, comanda
     * aberta e evento consumido" — o pior dos três, porque a reentrega do
     * webhook encontraria tudo já registrado e não faria nada.
     *
     * A divergência é forçada por SQL de propósito: o produto a impede pela
     * porta da frente (`cobranca_em_curso`), e o que se quer provar aqui é o
     * que acontece se ela existir mesmo assim.
     *
     * **O que este teste não prova**, e vale escrever: ele continua verde se
     * `fecharComanda` for chamado sem a transação de fora, porque a exceção
     * desfaz o `UPDATE` de qualquer jeito. A diferença que a transação
     * compartilhada faz aparece só se algo falhar **depois** do fechamento —
     * e não há ponto de falha ali para exercer. A transação fica porque o
     * raciocínio é o mesmo do resto do módulo (cinco tabelas ou nenhuma), não
     * porque este teste a defende.
     */
    await abrirGaveta();
    const orderId = await comandaDe4900();
    const cobranca = await cobrar(orderId, new FakePaymentProvider());

    await withTenant(TENANT, (tx) => tx.$executeRaw`
      INSERT INTO order_items
        (tenant_id, order_id, kind, description, quantity, unit_price_cents)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${orderId}::uuid, 'service', 'Barba fora do fluxo', 1, 2000
      )
    `);

    await expect(confirmar(cobranca.pagamentoId ?? '')).rejects.toMatchObject({
      code: 'pagamento_invalido',
    });

    expect((await cobrancasDaComanda(TENANT, orderId, LOCATION))[0]?.estado).toBe('aguardando');
    expect((await getComanda(TENANT, orderId, LOCATION)).status).toBe('open');

    const eventos = await withTenant(TENANT, (tx) => tx.$queryRaw<{ event_id: string }[]>`
      SELECT event_id FROM order_charge_events
    `);
    expect(eventos).toHaveLength(0);
  });

  it('o evento fica registrado uma vez, com o desfecho', async () => {
    /**
     * `order_charge_events` é a trilha do que o adquirente disse e quando — o
     * que se abre numa divergência de valor. Ela **também** trava a entrega
     * concorrente pela chave primária, mas isso não é o que estes testes
     * provam: o pool serializa as duas transações neste ambiente e o caso não
     * se reproduz. O que carrega a idempotência no caminho sequencial é o
     * `AND status = 'aguardando'`, e é honesto escrever que são duas garantias
     * diferentes, uma provada e outra não.
     */
    await abrirGaveta();
    const orderId = await comandaDe4900();
    const cobranca = await cobrar(orderId, new FakePaymentProvider());

    await confirmar(cobranca.pagamentoId ?? '', 'evt_unico');
    await confirmar(cobranca.pagamentoId ?? '', 'evt_unico');

    const eventos = await withTenant(TENANT, (tx) => tx.$queryRaw<
      { event_id: string; outcome: string }[]
    >`SELECT event_id, outcome FROM order_charge_events`);
    expect(eventos).toHaveLength(1);
    expect(eventos[0]?.outcome).toBe('pago');
  });

  // -- os achados da revisão de segurança -----------------------------------

  it('fechar na mão com Pix vivo é recusado', async () => {
    /**
     * O achado HIGH. A tela oferecia "Receber" logo abaixo do QR Code, e fechar
     * por ali com o Pix em aberto era o caminho para o estrago em três camadas:
     * a confirmação subia exceção, o webhook respondia 500 pelo tempo que o
     * adquirente reentregasse, e a varredura da barbearia parava no meio do laço.
     */
    await abrirGaveta();
    const orderId = await comandaDe4900();
    await cobrar(orderId, new FakePaymentProvider());

    await expect(
      fecharComanda({
        tenantId: TENANT,
        locationId: LOCATION,
        orderId,
        pagamentos: [{ forma: 'cash', valorCents: 4900 }],
        hojeNaUnidade: HOJE,
        ...operador,
      }),
    ).rejects.toMatchObject({ code: 'cobranca_em_curso' });
  });

  it('comanda fechada por fora não perde o dinheiro nem derruba o webhook', async () => {
    /**
     * A outra metade do mesmo achado: mesmo com a porta da frente fechada, se a
     * venda deixar de ser fechável o dinheiro **continua registrado**. Antes, a
     * transação inteira voltava atrás e o pagamento sumia de vez.
     */
    await abrirGaveta();
    const orderId = await comandaDe4900();
    const provider = new FakePaymentProvider();
    const cobranca = await cobrar(orderId, provider);

    // A comanda fecha por um caminho que não passa pela guarda.
    await withTenant(TENANT, (tx) => tx.$executeRaw`
      UPDATE orders SET status = 'paid', closed_at = now(), business_day = ${HOJE}::date
       WHERE id = ${orderId}::uuid
    `);

    const resultado = await confirmar(cobranca.pagamentoId ?? '', 'evt_divergencia', provider);

    expect(resultado.desfecho).toBe('pago_com_divergencia');
    // Dinheiro que não pode ser aplicado à venda é devolvido; não fica como
    // `pago` pedindo ao balcão para abrir caixa para uma divergência insolúvel.
    expect(provider.estornos).toHaveLength(1);
    expect(provider.estornos[0]).toMatchObject({
      pagamentoId: cobranca.pagamentoId,
      valorCents: 4900,
    });
    expect((await cobrancasDaComanda(TENANT, orderId, LOCATION))[0]?.estado).toBe('estornado');
    const eventos = await withTenant(TENANT, (tx) => tx.$queryRaw<{ outcome: string }[]>`
      SELECT outcome FROM order_charge_events
    `);
    expect(eventos[0]?.outcome).toBe('pago_com_divergencia');
  });


  it('divergência reembolsa uma vez e libera nova cobrança só depois do refund', async () => {
    await abrirGaveta();
    const orderId = await comandaDe4900();
    const provider = new FakePaymentProvider();
    const primeira = await cobrar(orderId, provider, 'toque-div-1');

    // Simula integração legada/out-of-band mudando o total depois da emissão.
    await withTenant(TENANT, (tx) => tx.$executeRaw`
      UPDATE orders SET total_cents = 5000 WHERE id = ${orderId}::uuid
    `);

    const resultado = await confirmar(primeira.pagamentoId ?? '', 'evt_div_retry', provider);
    expect(resultado.desfecho).toBe('pago_com_divergencia');
    expect(provider.estornos).toHaveLength(1);
    expect((await cobrancasDaComanda(TENANT, orderId, LOCATION))[0]?.estado).toBe('estornado');

    // Depois da devolução, a cobrança não é mais dinheiro vivo: a recepção
    // precisa poder corrigir a comanda e tentar cobrar novamente.
    const corrigida = await adicionarItem({
      tenantId: TENANT,
      locationId: LOCATION,
      orderId,
      tipo: 'service',
      descricao: 'Ajuste após refund',
      quantidade: 1,
      precoUnitarioCents: 100,
    });
    expect(corrigida.totalCents).toBe(5000);

    // Reentrega do mesmo evento não devolve novamente.
    const repetido = await confirmar(primeira.pagamentoId ?? '', 'evt_div_retry', provider);
    expect(repetido.desfecho).toBe('ignorado');
    expect(provider.estornos).toHaveLength(1);

    // O refund persistido tira a cobrança do índice de "dinheiro vivo".
    const segunda = await cobrar(orderId, provider, 'toque-div-2');
    expect(segunda.valorCents).toBe(5000);
  });

  it('uma cobrança ruim não para a varredura das outras', async () => {
    /**
     * Sem o `try` por item, a exceção subia do meio do `for` e todas as
     * cobranças ordenadas depois daquela ficavam sem conferência — por tempo
     * indeterminado, porque a volta seguinte esbarraria na mesma.
     */
    await abrirGaveta();
    const primeira = await comandaDe4900();
    const segunda = await comandaDe4900();
    const provider = new FakePaymentProvider();
    const ruim = await cobrar(primeira, provider, 'toque-1');
    await cobrar(segunda, provider, 'toque-2');

    const quebrado = new FakePaymentProvider();
    quebrado.proximoEstado = 'pago';
    quebrado.consultar = async (pagamentoId?: string) => {
      if (pagamentoId === ruim.pagamentoId) throw new Error('adquirente fora do ar');
      return 'pago' as const;
    };

    const varredura = await conciliarCobrancas({
      tenantId: TENANT,
      provider: quebrado,
      agora: AGORA,
    });

    expect(varredura.comFalha).toBe(1);
    // A segunda foi conferida e fechada mesmo com a primeira estourando.
    expect(varredura.pagas).toBe(1);
    expect((await getComanda(TENANT, segunda, LOCATION)).status).toBe('paid');
  });

  it('cancelar mata o código no adquirente, não só aqui', async () => {
    /**
     * Cancelar só do nosso lado deixava o QR Code **pagável**: quem já tinha
     * lido o código pagava, o evento chegava para cobrança encerrada e virava
     * silêncio. Dinheiro capturado, nunca registrado, nunca devolvido.
     */
    const orderId = await comandaDe4900();
    const provider = new FakePaymentProvider();
    const cobranca = await cobrar(orderId, provider);

    await cancelarCobranca({
      locationId: LOCATION,
      tenantId: TENANT,
      orderId,
      chargeId: cobranca.id,
      provider,
      ...operador,
    });

    expect(provider.cancelados).toEqual([cobranca.pagamentoId]);
  });


  it('não enterra localmente uma cobrança enquanto o adquirente ainda está emitindo', async () => {
    const orderId = await comandaDe4900();
    const provider = new FakePaymentProvider();
    const original = provider.criarCobranca.bind(provider);

    let iniciou!: () => void;
    let liberar!: () => void;
    const iniciouEmissao = new Promise<void>((resolve) => { iniciou = resolve; });
    const bloqueio = new Promise<void>((resolve) => { liberar = resolve; });
    provider.criarCobranca = async (pedido) => {
      iniciou();
      await bloqueio;
      return original(pedido);
    };

    const emissao = cobrar(orderId, provider);
    await iniciouEmissao;

    const [nascendo] = await cobrancasDaComanda(TENANT, orderId, LOCATION);
    expect(nascendo?.pagamentoId).toBeNull();
    await expect(cancelarCobranca({
      locationId: LOCATION,
      tenantId: TENANT,
      orderId,
      chargeId: nascendo?.id ?? '',
      provider,
      ...operador,
    })).rejects.toMatchObject({ code: 'cobranca_em_curso' });

    expect((await cobrancasDaComanda(TENANT, orderId, LOCATION))[0]?.estado).toBe('aguardando');

    liberar();
    const pronta = await emissao;
    expect(pronta.pagamentoId).toBeTruthy();

    await cancelarCobranca({
      locationId: LOCATION,
      tenantId: TENANT,
      orderId,
      chargeId: pronta.id,
      provider,
      ...operador,
    });
    expect(provider.cancelados).toEqual([pronta.pagamentoId]);
  });

  it('falha ao cancelar no adquirente mantém a cobrança viva e conciliável', async () => {
    const orderId = await comandaDe4900();
    const provider = new FakePaymentProvider();
    const cobranca = await cobrar(orderId, provider);
    provider.cancelar = async () => { throw new Error('adquirente fora do ar'); };

    await expect(cancelarCobranca({
      locationId: LOCATION,
      tenantId: TENANT,
      orderId,
      chargeId: cobranca.id,
      provider,
      ...operador,
    })).rejects.toThrow(/adquirente fora do ar/);

    expect((await cobrancasDaComanda(TENANT, orderId, LOCATION))[0]?.estado).toBe('aguardando');
  });

  it('pagamento que chega depois do cancelamento tem nome próprio', async () => {
    // `ignorado` é reentrega normal. Dinheiro sobre cobrança morta é outra
    // coisa, e chamar as duas do mesmo jeito é como a segunda nunca aparece.
    await abrirGaveta();
    const orderId = await comandaDe4900();
    const provider = new FakePaymentProvider();
    const cobranca = await cobrar(orderId, provider);
    await cancelarCobranca({
      locationId: LOCATION,
      tenantId: TENANT,
      orderId,
      chargeId: cobranca.id,
      provider,
      ...operador,
    });

    const resultado = await confirmar(cobranca.pagamentoId ?? '', 'evt_orfao', provider);
    expect(resultado.desfecho).toBe('pago_orfao');
    expect(provider.estornos).toHaveLength(1);
    expect(provider.estornos[0]).toMatchObject({
      pagamentoId: cobranca.pagamentoId,
      valorCents: 4900,
    });
    const [linha] = await withTenant(TENANT, (tx) => tx.$queryRaw<
      { psp_refund_id: string | null; refunded_cents: number | null }[]
    >`SELECT psp_refund_id, refunded_cents FROM order_charges WHERE id = ${cobranca.id}::uuid`);
    expect(linha?.psp_refund_id).toBe('fake_refund_1');
    expect(linha?.refunded_cents).toBe(4900);
  });

  it('reentrega do mesmo webhook conclui o refund órfão que falhou na primeira tentativa', async () => {
    // O evento fica `pago_orfao` antes da chamada de rede. Se a Stripe cai,
    // devolvemos 5xx; na reentrega do MESMO event_id a branch de duplicata
    // precisa reencontrar o refund pendente, sem criar uma segunda devolução.
    await abrirGaveta();
    const orderId = await comandaDe4900();
    const provider = new FakePaymentProvider();
    const cobranca = await cobrar(orderId, provider);
    await cancelarCobranca({
      locationId: LOCATION, tenantId: TENANT, orderId, chargeId: cobranca.id,
      provider, ...operador,
    });

    let tentativas = 0;
    const estornarReal = provider.estornar.bind(provider);
    provider.estornar = async (pagamentoId, valorCents) => {
      tentativas += 1;
      if (tentativas === 1) throw new Error('stripe temporariamente fora do ar');
      return estornarReal(pagamentoId, valorCents);
    };

    await expect(
      confirmar(cobranca.pagamentoId ?? '', 'evt_orfao_retry', provider),
    ).rejects.toThrow(/temporariamente fora do ar/);

    const [pendente] = await withTenant(TENANT, (tx) => tx.$queryRaw<
      { outcome: string; psp_refund_id: string | null }[]
    >`
      SELECT e.outcome, c.psp_refund_id
        FROM order_charge_events e
        JOIN order_charges c ON c.id = e.charge_id
       WHERE e.event_id = 'evt_orfao_retry'
    `);
    expect(pendente?.outcome).toBe('pago_orfao');
    expect(pendente?.psp_refund_id).toBeNull();

    const recuperado = await confirmar(
      cobranca.pagamentoId ?? '', 'evt_orfao_retry', provider,
    );
    expect(recuperado.desfecho).toBe('pago_orfao');
    expect(tentativas).toBe(2);
    expect(provider.estornos).toHaveLength(1);

    const [final] = await withTenant(TENANT, (tx) => tx.$queryRaw<
      { psp_refund_id: string | null; refunded_cents: number | null }[]
    >`SELECT psp_refund_id, refunded_cents FROM order_charges WHERE id = ${cobranca.id}::uuid`);
    expect(final?.psp_refund_id).toBe('fake_refund_1');
    expect(final?.refunded_cents).toBe(4900);
  });

  it('cancelar de uma comanda não alcança a cobrança de outra', async () => {
    // A rota tem `:id` e `:chargeId`, e a consulta passou a usar os dois: o
    // endereço tem que identificar o objeto que diz identificar.
    const primeira = await comandaDe4900();
    const segunda = await comandaDe4900();
    const provider = new FakePaymentProvider();
    const cobranca = await cobrar(primeira, provider, 'toque-1');

    await expect(
      cancelarCobranca({
        locationId: LOCATION,
        tenantId: TENANT,
        orderId: segunda,
        chargeId: cobranca.id,
        provider,
        ...operador,
      }),
    ).rejects.toMatchObject({ code: 'cobranca_encerrada' });
  });

  it('emitir e cancelar deixam trilha', async () => {
    // Matar o QR Code de um colega não podia ser invisível — e é ato de
    // dinheiro, então a trilha é gravada dentro da transação.
    const orderId = await comandaDe4900();
    const provider = new FakePaymentProvider();
    const cobranca = await cobrar(orderId, provider);
    await cancelarCobranca({
      locationId: LOCATION,
      tenantId: TENANT,
      orderId,
      chargeId: cobranca.id,
      provider,
      ...operador,
    });

    const trilha = await withTenant(TENANT, (tx) => tx.$queryRaw<{ action: string }[]>`
      SELECT action FROM audit_log WHERE entity = 'order_charge' ORDER BY created_at
    `);
    expect(trilha.map((t) => t.action)).toEqual([
      'order.charge_created',
      'order.charge_cancelled',
    ]);
  });

  it('a venda paga sem caixa é concluída quando a gaveta abre', async () => {
    /**
     * O achado nº 4: `pago_sem_caixa` era estado terminal sem saída. A comanda
     * ficava aberta para sempre com o dinheiro já recebido, e o único caminho
     * que sobrava era o "Receber" manual — que cobraria o cliente de novo.
     */
    const orderId = await comandaDe4900();
    const provider = new FakePaymentProvider();
    const cobranca = await cobrar(orderId, provider);

    expect((await confirmar(cobranca.pagamentoId ?? '')).desfecho).toBe('pago_sem_caixa');
    expect((await getComanda(TENANT, orderId, LOCATION)).status).toBe('open');

    await abrirGaveta();
    const varredura = await conciliarCobrancas({
      tenantId: TENANT,
      provider,
      agora: AGORA,
    });

    expect(varredura.concluidas).toBe(1);
    expect((await getComanda(TENANT, orderId, LOCATION)).status).toBe('paid');
  });

  it('fechamento tardio de cobrança paga também deriva o split', async () => {
    await exec(`UPDATE tenants SET split_enabled = true WHERE id = '${TENANT}'`);
    const orderId = await comandaDe4900();
    const provider = new FakePaymentProvider();
    const cobranca = await cobrar(orderId, provider);

    expect((await confirmar(cobranca.pagamentoId ?? '', 'evt_split_sem_caixa')).desfecho)
      .toBe('pago_sem_caixa');
    await abrirGaveta();
    await conciliarCobrancas({ tenantId: TENANT, provider, agora: AGORA });

    const fatias = await withTenant(TENANT, (tx) => tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM payment_splits WHERE order_id = ${orderId}::uuid
    `);
    expect(fatias.length).toBeGreaterThan(0);
  });

  it('cobrança paga sem caixa impede emitir uma segunda cobrança', async () => {
    /**
     * O dinheiro já entrou, mas sem gaveta a comanda permanece `open`. A
     * proteção antiga olhava apenas cobranças `aguardando`, então outro toque
     * com uma nova Idempotency-Key podia gerar um segundo QR/link.
     */
    const orderId = await comandaDe4900();
    const provider = new FakePaymentProvider();
    const primeira = await cobrar(orderId, provider, 'primeira');

    const confirmada = await confirmar(primeira.pagamentoId ?? '', 'evt_pago_sem_caixa');
    expect(confirmada.desfecho).toBe('pago_sem_caixa');
    expect((await getComanda(TENANT, orderId, LOCATION)).status).toBe('open');

    await expect(cobrar(orderId, provider, 'segunda')).rejects.toMatchObject({
      code: 'cobranca_em_curso',
    });
    expect(provider.cobrancas).toHaveLength(1);
    expect(await cobrancasDaComanda(TENANT, orderId, LOCATION)).toHaveLength(1);
  });

  it('com a cobrança já paga, a comanda não aceita item novo', async () => {
    // O total não pode se afastar do dinheiro que já entrou — é a mesma
    // divergência da guarda, por um caminho que o próprio código criava.
    const orderId = await comandaDe4900();
    const cobranca = await cobrar(orderId, new FakePaymentProvider());
    await confirmar(cobranca.pagamentoId ?? '');

    await expect(
      adicionarItem({
        tenantId: TENANT,
        locationId: LOCATION,
        orderId,
        tipo: 'service',
        descricao: 'Barba',
        quantidade: 1,
        precoUnitarioCents: 2000,
      }),
    ).rejects.toMatchObject({ code: 'cobranca_em_curso' });
  });

  // -- conciliação e expiração ----------------------------------------------

  it('a rede de segurança fecha o que o webhook perdeu', async () => {
    await abrirGaveta();
    const orderId = await comandaDe4900();
    const provider = new FakePaymentProvider();
    await cobrar(orderId, provider);

    // O cliente pagou e o webhook não chegou.
    provider.proximoEstado = 'pago';
    const varredura = await conciliarCobrancas({
      tenantId: TENANT,
      provider,
      agora: AGORA,
    });

    expect(varredura).toMatchObject({ consultadas: 1, pagas: 1 });
    expect((await getComanda(TENANT, orderId, LOCATION)).status).toBe('paid');
  });

  it('a conciliação não conta o pagamento de novo quando o webhook já contou', async () => {
    /**
     * As duas escrevem pelo mesmo caminho, e o id do evento sintético é
     * determinístico (`recon:<pagamento>:<estado>`). Duas implementações
     * divergiriam no primeiro ajuste, e a divergência aqui é "pagamento contado
     * duas vezes".
     */
    await abrirGaveta();
    const orderId = await comandaDe4900();
    const provider = new FakePaymentProvider();
    const cobranca = await cobrar(orderId, provider);

    await confirmar(cobranca.pagamentoId ?? '');
    provider.proximoEstado = 'pago';
    const varredura = await conciliarCobrancas({
      tenantId: TENANT,
      provider,
      agora: AGORA,
    });

    expect(varredura.pagas).toBe(0);
    const pagamentos = await withTenant(TENANT, (tx) => tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM order_payments WHERE order_id = ${orderId}::uuid
    `);
    expect(pagamentos).toHaveLength(1);
  });

  it('Pix vencido libera a comanda', async () => {
    // SPEC §3.3: "Pix expirado libera a comanda". Sem isso a comanda ficaria
    // presa a um QR Code que nenhum banco aceita mais.
    const orderId = await comandaDe4900();
    const provider = new FakePaymentProvider();
    provider.expiraEm = new Date('2026-09-10T11:00:00Z');
    await cobrar(orderId, provider);

    const varredura = await conciliarCobrancas({
      tenantId: TENANT,
      provider,
      agora: AGORA,
    });

    expect(varredura.encerradas).toBe(1);
    expect((await cobrancasDaComanda(TENANT, orderId, LOCATION))[0]?.estado).toBe('expirado');
    // E a comanda volta a aceitar cobrança. O mesmo provedor de propósito: o
    // fake numera do 1, e uma instância nova devolveria o id que já está
    // gravado — o índice único de `psp_payment_id` recusaria, com razão.
    expect((await cobrar(orderId, provider, 'toque-2')).estado).toBe('aguardando');
  });


  it('falha ao cancelar Pix vencido não o enterra só no banco', async () => {
    const orderId = await comandaDe4900();
    const provider = new FakePaymentProvider();
    provider.expiraEm = new Date('2026-09-10T11:00:00Z');
    await cobrar(orderId, provider);
    provider.cancelar = async () => { throw new Error('cancelamento externo indisponível'); };

    const varredura = await conciliarCobrancas({ tenantId: TENANT, provider, agora: AGORA });

    expect(varredura.comFalha).toBe(1);
    expect(varredura.encerradas).toBe(0);
    expect((await cobrancasDaComanda(TENANT, orderId, LOCATION))[0]?.estado).toBe('aguardando');
  });

  it('Pix ainda dentro do prazo não é encerrado por engano', async () => {
    const orderId = await comandaDe4900();
    const provider = new FakePaymentProvider();
    provider.expiraEm = new Date('2026-09-10T13:00:00Z');
    await cobrar(orderId, provider);

    const varredura = await conciliarCobrancas({
      tenantId: TENANT,
      provider,
      agora: AGORA,
    });

    expect(varredura.encerradas).toBe(0);
    expect((await cobrancasDaComanda(TENANT, orderId, LOCATION))[0]?.estado).toBe('aguardando');
  });

  it('o balcão cancela o Pix quando o cliente muda de ideia', async () => {
    // "Desisti do Pix, vou pagar em dinheiro" é rotina. Sem isto a comanda
    // ficaria travada até o QR Code vencer, com o cliente esperando na frente.
    const orderId = await comandaDe4900();
    const cobranca = await cobrar(orderId, new FakePaymentProvider());

    await cancelarCobranca({
      locationId: LOCATION,
      tenantId: TENANT,
      orderId,
      chargeId: cobranca.id,
      provider: new FakePaymentProvider(),
      ...operador,
    });

    expect((await cobrancasDaComanda(TENANT, orderId, LOCATION))[0]?.estado).toBe('expirado');
    await expect(
      cancelarCobranca({
        locationId: LOCATION,
        tenantId: TENANT,
        orderId,
        chargeId: cobranca.id,
        provider: new FakePaymentProvider(),
        ...operador,
      }),
    ).rejects.toMatchObject({ code: 'cobranca_encerrada' });
  });

  it('cobrança de uma barbearia não é vista pela outra', async () => {
    /**
     * O caminho triste que a RLS existe para fechar. O webhook abre o tenant a
     * partir do metadado do evento e procura a cobrança **dentro** dele — então
     * um evento apontando para a barbearia errada não encontra nada, em vez de
     * mexer no dinheiro de quem não é dele.
     */
    const VIZINHA = '35353535-2222-2222-2222-222222222222';
    await exec(`INSERT INTO tenants (id, name) VALUES ('${VIZINHA}', 'Vizinha')`);

    const orderId = await comandaDe4900();
    const cobranca = await cobrar(orderId, new FakePaymentProvider());

    const resultado = await confirmarCobranca({
      tenantId: VIZINHA,
      eventoId: 'evt_vizinha',
      tipo: 'payment_intent.succeeded',
      pagamentoId: cobranca.pagamentoId ?? '',
      estado: 'pago',
      provider: new FakePaymentProvider(),
      agora: AGORA,
    });

    expect(resultado.desfecho).toBe('ignorado');
    expect((await getComanda(TENANT, orderId, LOCATION)).status).toBe('open');
  });

  it('caixa fechado depois da emissão não perde o pagamento', async () => {
    // O turno acabou antes de o cliente pagar. O dinheiro é real e não pode
    // sumir só porque a gaveta virou.
    await abrirGaveta();
    const orderId = await comandaDe4900();
    const cobranca = await cobrar(orderId, new FakePaymentProvider());
    await fecharCaixaDaUnidade({
      tenantId: TENANT,
      locationId: LOCATION,
      countedCents: 20000,
      ...operador,
    });

    const resultado = await confirmar(cobranca.pagamentoId ?? '');

    expect(resultado.desfecho).toBe('pago_sem_caixa');
    expect((await cobrancasDaComanda(TENANT, orderId, LOCATION))[0]?.estado).toBe('pago');
  });

  describe('a comanda aberta tem saída', () => {
    /**
     * `order_status` tem `cancelled` desde a migração 0018 e nada o escrevia:
     * uma comanda aberta por engano só saía de `open` sendo paga, e comanda
     * vazia não fecha — o fechamento exige pelo menos uma forma de pagamento.
     * Era linha presa para sempre.
     */
    it('a comanda avulsa aparece na lista de abertas', async () => {
      const comanda = await abrirComanda({
        tenantId: TENANT,
        locationId: LOCATION,
        ...operador,
      });

      const abertas = await comandasAbertas(TENANT, LOCATION, true);

      // Sem `customers.view` o nome sai redigido e a **lista continua**: somar a
      // permissão ao `@Exige` faria o papel de balcão sem ela levar 403 na
      // listagem inteira, e a comanda avulsa voltaria a ser invisível para
      // exatamente quem este bloco existe para atender.
      const semNome = await comandasAbertas(TENANT, LOCATION, false);
      expect(semNome.map((c) => c.id)).toContain(comanda.id);
      expect(semNome.every((c) => c.customerName === null)).toBe(true);
      expect(abertas.map((c) => c.id)).toContain(comanda.id);
      // Sem atendimento e sem cliente: é a venda avulsa, e a tela precisa
      // distinguir para não escrever o nome de ninguém.
      expect(abertas.find((c) => c.id === comanda.id)?.appointmentId).toBeNull();
    });

    it('cancelar tira a comanda da lista, e a comanda cancelada não cancela de novo', async () => {
      const orderId = await comandaDe4900();

      await cancelarComanda({
        tenantId: TENANT,
        locationId: LOCATION,
        orderId,
        ator: { id: STAFF, name: 'Maria Recepção' },
      });

      expect((await getComanda(TENANT, orderId, LOCATION)).status).toBe('cancelled');
      expect((await comandasAbertas(TENANT, LOCATION, true)).map((c) => c.id)).not.toContain(orderId);

      // Quem recusa aqui é `exigirAberta`, que já leu `cancelled`. O `WHERE
      // status = 'open'` do `UPDATE` é a segunda camada, para duas transações
      // simultâneas — e essa **não** é provada por este teste: as duas se
      // serializariam sozinhas, e um teste de corrida que passa com e sem o
      // conserto não prende regra nenhuma.
      await expect(
        cancelarComanda({
          tenantId: TENANT,
          locationId: LOCATION,
          orderId,
          ator: { id: STAFF, name: 'Maria Recepção' },
        }),
      ).rejects.toThrow();
    });

    it('a comanda com cobrança viva não é cancelada', async () => {
      const orderId = await comandaDe4900();
      const provider = new FakePaymentProvider();
      await cobrar(orderId, provider);

      // O cliente está com o código na mão: o caminho é cancelar a cobrança
      // antes, e é a mesma guarda que já protege item, remoção e desconto.
      await expect(
        cancelarComanda({
          tenantId: TENANT,
          locationId: LOCATION,
          orderId,
          ator: { id: STAFF, name: 'Maria Recepção' },
        }),
      ).rejects.toThrow();

      expect((await getComanda(TENANT, orderId, LOCATION)).status).toBe('open');
    });

    it('a comanda da loja vizinha não é cancelada pelo id', async () => {
      const orderId = await comandaDe4900();
      const OUTRA_LOJA = '35353535-aaaa-0000-0000-000000000009';

      // A RLS separa barbearias e **não** separa lojas dentro de uma: sem o
      // filtro por unidade, o gerente da filial cancelaria a comanda da matriz
      // mandando o id. O filtro é duplo — no `SELECT ... FOR UPDATE` e em
      // `carregar` —, e quebrando um deles o outro ainda recusa: é defesa em
      // profundidade, e este teste prova que ela existe, não qual camada agiu.
      await expect(
        cancelarComanda({
          tenantId: TENANT,
          locationId: OUTRA_LOJA,
          orderId,
          ator: { id: STAFF, name: 'Maria Recepção' },
        }),
      ).rejects.toThrow();

      expect((await getComanda(TENANT, orderId, LOCATION)).status).toBe('open');
    });
  });

});
