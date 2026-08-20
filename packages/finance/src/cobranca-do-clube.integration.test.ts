import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@barbearia/db';
import { FakeCobrancaDoClubeProvider } from '@barbearia/core';
import { assinar, assinaturaDoCliente, cancelarAssinatura, salvarPlano } from './assinatura.js';
import {
  agendarCancelamento,
  aplicarReguaDoClube,
  avisarCartoesAVencer,
  cancelarFatura,
  desfazerCancelamento,
  emitirFaturas,
  encerrarCancelamentosVencidos,
  faturasDoClube,
  minhasFaturas,
  montarAvisoDoClube,
  registrarPagamentoDaFatura,
  salvarCartaoDaAssinatura,
} from './cobranca-do-clube.js';

/**
 * A cobrança recorrente do clube contra Postgres real (bloco 47).
 *
 * O que só o banco prova: que a emissão é idempotente sob o índice único e não
 * sob um `SELECT`, que a escada não gasta dois degraus quando duas voltas se
 * cruzam, que a suspensão é gradual de verdade, e que o cancelamento self-service
 * de um cliente não alcança a assinatura de outro.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '47474747-1111-1111-1111-111111111111';
const RIVAL = '47474747-2222-2222-2222-222222222222';
const LOCAL = 'a4747474-0000-0000-0000-000000000001';
const CARLOS = 'c4747474-0000-0000-0000-000000000001';
const BRUNO = 'c4747474-0000-0000-0000-000000000002';
const DONO = 'd4747474-0000-0000-0000-000000000001';
const CORTE = 'f4747474-0000-0000-0000-000000000001';

/** A adesão é no dia 1º; o ciclo vai do dia 1º ao dia 1º. */
const ADERIU = new Date('2026-10-01T09:00:00Z');
const VENCIMENTO = new Date('2026-11-01T09:00:00Z');
const emDias = (n: number, base: Date = VENCIMENTO): Date =>
  new Date(base.getTime() + n * 86_400_000);

const ator = { id: DONO, name: 'Matheus' };

let admin: PrismaClient;
let provider: FakeCobrancaDoClubeProvider;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

async function assinaturaDe(cliente = CARLOS): Promise<string> {
  const plano = await salvarPlano({
    tenantId: TENANT,
    nome: 'Premium',
    precoCents: 14_900,
    descontoEmProdutoBps: 0,
    ativo: true,
    beneficios: [{ serviceId: CORTE, quantidade: 2, cooldownDias: 0 }],
    ator,
  });
  const feita = await assinar({
    tenantId: TENANT,
    customerId: cliente,
    planId: plano.id,
    ator,
    agora: ADERIU,
  });
  /**
   * A adesão grava `started_at` com `now()` do banco; o ciclo é ancorado nele, e
   * o teste precisa de uma âncora fixa para poder falar de D+1 e D+15.
   */
  await exec(`
    UPDATE club_subscriptions SET started_at = '${ADERIU.toISOString()}', status = 'ativa'
     WHERE id = '${feita.id}';
  `);
  return feita.id;
}

const comCartao = (assinaturaId: string) =>
  salvarCartaoDaAssinatura({
    tenantId: TENANT,
    assinaturaId,
    token: 'tok_teste',
    bandeira: 'visa',
    ultimosQuatro: '4242',
    mes: 12,
    ano: 2030,
  });

const estadoDa = async (assinaturaId: string): Promise<string> =>
  withTenant(TENANT, async (tx) => {
    const [linha] = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM club_subscriptions
       WHERE id = ${assinaturaId}::uuid
    `;
    return linha?.status ?? 'sumiu';
  });

const temCartao = async (assinaturaId: string): Promise<boolean> =>
  withTenant(TENANT, async (tx) => {
    const [linha] = await tx.$queryRaw<{ tem: boolean }[]>`
      SELECT (payment_token IS NOT NULL OR card_last4 IS NOT NULL) AS tem
        FROM club_subscriptions WHERE id = ${assinaturaId}::uuid
    `;
    return linha?.tem ?? false;
  });

const avisosNaFila = async (): Promise<string[]> => {
  const linhas = await admin.$queryRawUnsafe<{ idempotency_key: string }[]>(
    `SELECT idempotency_key FROM jobs WHERE kind = 'clube.aviso' ORDER BY idempotency_key`,
  );
  return linhas.map((l) => l.idempotency_key);
};

describeIfDb('cobrança recorrente do clube', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    provider = new FakeCobrancaDoClubeProvider();
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await admin.$executeRawUnsafe('TRUNCATE jobs');
    await exec(`
      INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Domari'), ('${RIVAL}', 'Vizinha');

      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('${LOCAL}', '${TENANT}', 'Matriz', 'America/Bahia');

      INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
        ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777'),
        ('${BRUNO}', '${TENANT}', 'Bruno Lima', '+5571977776666');

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${DONO}', '${TENANT}', 'Matheus', 'dono@domari.com.br', 'x', 'owner');

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes)
      VALUES ('${CORTE}', '${TENANT}', 'Corte', 6000, 30);
    `);
  });

  // -- a emissão ---------------------------------------------------------------

  it('emite uma fatura por ciclo, e a segunda volta não emite nada', async () => {
    /**
     * O worker roda a cada volta do laço. Sem o índice único, ele emitiria uma
     * fatura por rodada — cobrando o assinante dezenas de vezes pelo mesmo mês.
     * Quem recusa é o banco, e não um `SELECT` antes do `INSERT`.
     */
    const assinatura = await assinaturaDe();

    expect(await emitirFaturas({ tenantId: TENANT, agora: VENCIMENTO })).toBe(1);
    expect(await emitirFaturas({ tenantId: TENANT, agora: emDias(3) })).toBe(0);

    const lista = await faturasDoClube(TENANT, { agora: emDias(3) });
    expect(lista).toHaveLength(1);
    expect(lista[0]).toMatchObject({
      assinaturaId: assinatura,
      valorCents: 14_900,
      estado: 'aberta',
      tentativas: 0,
    });
  });

  it('o valor da fatura é o congelado na adesão, não o preço de tabela de hoje', async () => {
    /**
     * A barbearia sobe o Premium de R$ 149 para R$ 169. A fatura do assinante de
     * outubro continua sendo de R$ 149 — recalculá-la mudaria um mês fechado
     * sozinho, que é o defeito que a taxa do adquirente e a regra de comissão já
     * evitam cada uma no seu canto.
     */
    await assinaturaDe();
    await exec(`UPDATE club_plans SET price_cents = 16900 WHERE tenant_id = '${TENANT}';`);

    await emitirFaturas({ tenantId: TENANT, agora: VENCIMENTO });
    const [fatura] = await faturasDoClube(TENANT, { agora: VENCIMENTO });
    expect(fatura?.valorCents).toBe(14_900);
  });

  it('o ciclo seguinte ganha fatura própria', async () => {
    await assinaturaDe();
    await emitirFaturas({ tenantId: TENANT, agora: VENCIMENTO });
    await emitirFaturas({ tenantId: TENANT, agora: emDias(40) });

    expect(await faturasDoClube(TENANT, { agora: emDias(40) })).toHaveLength(2);
  });

  // -- a régua -----------------------------------------------------------------

  it('sem cartão salvo, a fatura não gasta degrau da escada', async () => {
    /**
     * É o caso comum de uma barbearia pequena: o assinante paga no balcão. Contar
     * isso como recusa faria o cliente receber "não conseguimos cobrar o seu
     * cartão" quando não há cartão nenhum — e a escada correria contra quem paga
     * em dia.
     */
    await assinaturaDe();
    const resultado = await aplicarReguaDoClube({ tenantId: TENANT, provider, agora: VENCIMENTO });

    expect(resultado).toMatchObject({ emitidas: 1, cobradas: 0, pagas: 0 });
    expect(provider.pedidos).toHaveLength(0);
    expect((await faturasDoClube(TENANT, { agora: VENCIMENTO }))[0]?.tentativas).toBe(0);
  });

  it('cobra no vencimento e dá baixa quando o cartão passa', async () => {
    const assinatura = await assinaturaDe();
    await comCartao(assinatura);
    provider.proximoResultado = { pago: true, cobrancaId: 'ch_1' };

    const resultado = await aplicarReguaDoClube({ tenantId: TENANT, provider, agora: VENCIMENTO });

    expect(resultado.pagas).toBe(1);
    expect(provider.pedidos[0]).toMatchObject({ valorCents: 14_900, tentativa: 1 });
    expect((await faturasDoClube(TENANT, { agora: VENCIMENTO }))[0]).toMatchObject({
      estado: 'paga',
      metodo: 'card',
    });
    expect(await estadoDa(assinatura)).toBe('ativa');
  });

  it('a suspensão é gradual: recusa avisa, marca inadimplente e só depois pausa', async () => {
    /**
     * *"Cortar o acesso no primeiro erro de cartão gera cancelamento por raiva,
     * não por preço."* O assinante inadimplente **continua cortando** — é o
     * degrau que existe para não perder o cliente por um cartão que passa na
     * quinta.
     */
    const assinatura = await assinaturaDe();
    await comCartao(assinatura);
    provider.proximoResultado = { pago: false, motivo: 'saldo insuficiente', definitiva: false };

    await aplicarReguaDoClube({ tenantId: TENANT, provider, agora: VENCIMENTO });
    expect(await estadoDa(assinatura)).toBe('ativa');

    await aplicarReguaDoClube({ tenantId: TENANT, provider, agora: VENCIMENTO });
    expect(await estadoDa(assinatura)).toBe('inadimplente');

    await aplicarReguaDoClube({ tenantId: TENANT, provider, agora: emDias(1) });
    expect(await estadoDa(assinatura)).toBe('inadimplente');
    expect(provider.pedidos).toHaveLength(2);

    await aplicarReguaDoClube({ tenantId: TENANT, provider, agora: emDias(15) });
    expect(await estadoDa(assinatura)).toBe('suspensa');
  });

  it('recusa definitiva não retenta, e ainda assim suspende no prazo', async () => {
    const assinatura = await assinaturaDe();
    await comCartao(assinatura);
    provider.proximoResultado = { pago: false, motivo: 'cartão cancelado', definitiva: true };

    await aplicarReguaDoClube({ tenantId: TENANT, provider, agora: VENCIMENTO });
    await aplicarReguaDoClube({ tenantId: TENANT, provider, agora: VENCIMENTO });
    expect(await estadoDa(assinatura)).toBe('inadimplente');

    await aplicarReguaDoClube({ tenantId: TENANT, provider, agora: emDias(7) });
    expect(provider.pedidos).toHaveLength(1);

    await aplicarReguaDoClube({ tenantId: TENANT, provider, agora: emDias(15) });
    expect(await estadoDa(assinatura)).toBe('suspensa');
  });

  it('o aviso nasce na mesma transação que muda o estado', async () => {
    /**
     * Enfileirar depois do commit abre a janela em que o plano foi pausado e
     * ninguém soube — que é exatamente a janela que a suspensão "avisada" da
     * SPEC §4.6 existe para fechar.
     */
    const assinatura = await assinaturaDe();
    await comCartao(assinatura);
    provider.proximoResultado = { pago: false, motivo: 'saldo insuficiente', definitiva: false };

    await aplicarReguaDoClube({ tenantId: TENANT, provider, agora: VENCIMENTO });
    await aplicarReguaDoClube({ tenantId: TENANT, provider, agora: VENCIMENTO });
    await aplicarReguaDoClube({ tenantId: TENANT, provider, agora: emDias(15) });

    const chaves = await avisosNaFila();
    expect(chaves.some((c) => c.includes('cobranca_recusada'))).toBe(true);
    expect(chaves.some((c) => c.includes(':inadimplente:'))).toBe(true);
    expect(chaves.some((c) => c.includes(':suspenso:'))).toBe(true);
  });

  it('pagar a fatura devolve o benefício a quem estava suspenso', async () => {
    const assinatura = await assinaturaDe();
    await comCartao(assinatura);
    provider.proximoResultado = { pago: false, motivo: 'saldo insuficiente', definitiva: false };
    await aplicarReguaDoClube({ tenantId: TENANT, provider, agora: VENCIMENTO });
    await aplicarReguaDoClube({ tenantId: TENANT, provider, agora: VENCIMENTO });
    await aplicarReguaDoClube({ tenantId: TENANT, provider, agora: emDias(15) });
    expect(await estadoDa(assinatura)).toBe('suspensa');

    const [fatura] = await faturasDoClube(TENANT, { agora: emDias(15) });
    if (!fatura) throw new Error('sem fatura');
    await registrarPagamentoDaFatura({
      tenantId: TENANT,
      faturaId: fatura.id,
      metodo: 'pix',
      ator,
      agora: emDias(16),
    });

    expect(await estadoDa(assinatura)).toBe('ativa');
  });

  it('a mesma fatura não é baixada duas vezes', async () => {
    // O estado no `WHERE` é quem impede a segunda baixa, e a contagem de linhas
    // afetadas é conferida: um `UPDATE` que não pegou ninguém e segue adiante
    // vira assinatura reativada sem pagamento.
    await assinaturaDe();
    await emitirFaturas({ tenantId: TENANT, agora: VENCIMENTO });
    const [fatura] = await faturasDoClube(TENANT, { agora: VENCIMENTO });
    if (!fatura) throw new Error('sem fatura');

    await registrarPagamentoDaFatura({
      tenantId: TENANT, faturaId: fatura.id, metodo: 'dinheiro', ator, agora: VENCIMENTO,
    });
    await expect(
      registrarPagamentoDaFatura({
        tenantId: TENANT, faturaId: fatura.id, metodo: 'dinheiro', ator, agora: VENCIMENTO,
      }),
    ).rejects.toMatchObject({ code: 'fatura_nao_encontrada' });
  });

  it('cancelar fatura exige motivo escrito, e a linha continua existindo', async () => {
    // Perdoar mensalidade é dar desconto com outro nome, e desconto tem dono na
    // trilha desde o bloco 18. A linha fica, com valor e data intactos.
    await assinaturaDe();
    await emitirFaturas({ tenantId: TENANT, agora: VENCIMENTO });
    const [fatura] = await faturasDoClube(TENANT, { agora: VENCIMENTO });
    if (!fatura) throw new Error('sem fatura');

    await expect(
      cancelarFatura({ tenantId: TENANT, faturaId: fatura.id, motivo: ' ', ator }),
    ).rejects.toMatchObject({ code: 'motivo_obrigatorio' });

    await cancelarFatura({
      tenantId: TENANT, faturaId: fatura.id, motivo: 'cliente saiu antes do ciclo', ator,
    });
    const [depois] = await faturasDoClube(TENANT, { agora: VENCIMENTO });
    expect(depois).toMatchObject({ estado: 'cancelada', valorCents: 14_900 });
  });

  it('perdoar a mensalidade de quem estava suspenso devolve o benefício', async () => {
    /**
     * A barbearia produzia sozinha uma assinatura sem saída: `suspensa` só é
     * desfeita quando uma fatura é **paga**, e cancelar era o caminho para não
     * haver mais nenhuma fatura aberta para pagar. A ficha do cliente continuava
     * dizendo "dar baixa na mensalidade em Clube devolve o benefício", e em
     * Clube não havia linha nenhuma daquele assinante.
     *
     * Destravava sozinho só na virada do ciclo, quando a régua emitisse a
     * fatura seguinte: até um mês depois.
     */
    const assinatura = await assinaturaDe();
    await comCartao(assinatura);
    provider.proximoResultado = { pago: false, motivo: 'saldo insuficiente', definitiva: false };
    await aplicarReguaDoClube({ tenantId: TENANT, provider, agora: VENCIMENTO });
    await aplicarReguaDoClube({ tenantId: TENANT, provider, agora: VENCIMENTO });
    await aplicarReguaDoClube({ tenantId: TENANT, provider, agora: emDias(15) });
    expect(await estadoDa(assinatura)).toBe('suspensa');

    const [fatura] = await faturasDoClube(TENANT, { agora: emDias(15) });
    if (!fatura) throw new Error('sem fatura');

    await cancelarFatura({
      tenantId: TENANT,
      faturaId: fatura.id,
      motivo: 'cliente ficou doente no mês, a casa perdoou',
      ator,
    });

    // Quem perdoa a mensalidade decidiu que aquele mês não é devido — e a
    // suspensão existia por causa dele.
    expect(await estadoDa(assinatura)).toBe('ativa');
    const [depois] = await faturasDoClube(TENANT, { agora: emDias(15) });
    expect(depois?.estado).toBe('cancelada');
  });

  // -- o cancelamento self-service --------------------------------------------

  it('o cancelamento vale até o fim do ciclo pago, e o benefício continua', async () => {
    /**
     * O cliente pagou o mês inteiro. Cortar no dia do pedido seria ficar com o
     * dinheiro e não entregar o serviço — o oposto do que o self-service da SPEC
     * §4.6 existe para permitir.
     */
    const assinatura = await assinaturaDe();
    const pedido = await agendarCancelamento({
      tenantId: TENANT,
      assinaturaId: assinatura,
      motivo: 'vou me mudar',
      ator: null,
      customerId: CARLOS,
      agora: emDias(10),
    });

    expect(pedido.valeAte).toBe('2026-12-01T09:00:00.000Z');
    expect(await estadoDa(assinatura)).toBe('ativa');

    const ainda = await assinaturaDoCliente(TENANT, CARLOS, emDias(10));
    expect(ainda?.estado).toBe('ativa');
  });

  it('quem pediu para sair não é cobrado pelo ciclo seguinte', async () => {
    // Sem isto o self-service seria uma promessa: a pessoa pede para sair no dia
    // 10, o ciclo vira no dia 1º, e o worker emite mais uma fatura de R$ 149.
    const assinatura = await assinaturaDe();
    await agendarCancelamento({
      tenantId: TENANT, assinaturaId: assinatura, motivo: 'vou me mudar',
      ator: null, customerId: CARLOS, agora: emDias(10),
    });

    await emitirFaturas({ tenantId: TENANT, agora: emDias(10) });
    await emitirFaturas({ tenantId: TENANT, agora: emDias(40) });

    const lista = await faturasDoClube(TENANT, { agora: emDias(40) });
    expect(lista).toHaveLength(1);
  });

  it('o ciclo pago acaba e a assinatura fecha', async () => {
    const assinatura = await assinaturaDe();
    await agendarCancelamento({
      tenantId: TENANT, assinaturaId: assinatura, motivo: 'vou me mudar',
      ator: null, customerId: CARLOS, agora: emDias(10),
    });

    expect(await encerrarCancelamentosVencidos({ tenantId: TENANT, agora: emDias(20) })).toBe(0);
    expect(await encerrarCancelamentosVencidos({ tenantId: TENANT, agora: emDias(40) })).toBe(1);
    expect(await estadoDa(assinatura)).toBe('cancelada');
  });

  it('o cliente muda de ideia antes do fim do ciclo', async () => {
    // Todo estado precisa de saída, e este é o mais valioso do produto para ter
    // uma: quem desfaz é receita que já estava contada como perdida.
    const assinatura = await assinaturaDe();
    await agendarCancelamento({
      tenantId: TENANT, assinaturaId: assinatura, motivo: 'caro demais',
      ator: null, customerId: CARLOS, agora: emDias(10),
    });
    await desfazerCancelamento({
      tenantId: TENANT, assinaturaId: assinatura, ator: null, customerId: CARLOS,
    });

    expect(await encerrarCancelamentosVencidos({ tenantId: TENANT, agora: emDias(40) })).toBe(0);
    expect(await estadoDa(assinatura)).toBe('ativa');
  });

  it('um cliente não cancela a assinatura de outro', async () => {
    /**
     * A RLS separa barbearias e **não separa clientes dentro de uma**. Sem o
     * filtro por `customer_id`, um id de assinatura vazado bastaria para
     * cancelar o plano de outra pessoa — e o self-service é rota pública.
     */
    const doCarlos = await assinaturaDe(CARLOS);
    await expect(
      agendarCancelamento({
        tenantId: TENANT, assinaturaId: doCarlos, motivo: 'tchau',
        ator: null, customerId: BRUNO, agora: emDias(1),
      }),
    ).rejects.toMatchObject({ code: 'assinatura_nao_encontrada' });

    expect(await estadoDa(doCarlos)).toBe('ativa');
  });

  it('um cliente não lê a fatura de outro', async () => {
    await assinaturaDe(CARLOS);
    await emitirFaturas({ tenantId: TENANT, agora: VENCIMENTO });

    expect(await minhasFaturas(TENANT, CARLOS, VENCIMENTO)).toHaveLength(1);
    expect(await minhasFaturas(TENANT, BRUNO, VENCIMENTO)).toHaveLength(0);
  });

  it('pedir cancelamento duas vezes não reinicia a contagem', async () => {
    const assinatura = await assinaturaDe();
    await agendarCancelamento({
      tenantId: TENANT, assinaturaId: assinatura, motivo: 'primeiro',
      ator: null, customerId: CARLOS, agora: emDias(10),
    });
    await expect(
      agendarCancelamento({
        tenantId: TENANT, assinaturaId: assinatura, motivo: 'segundo',
        ator: null, customerId: CARLOS, agora: emDias(11),
      }),
    ).rejects.toMatchObject({ code: 'assinatura_nao_encontrada' });
  });

  it('cancelar a assinatura leva o cartão salvo embora', async () => {
    // Assinatura cancelada não tem razão para guardar credencial cobrável. É a
    // segunda camada do achado da revisão; a primeira é o filtro abaixo.
    const assinatura = await assinaturaDe();
    await comCartao(assinatura);
    await cancelarAssinatura({
      tenantId: TENANT,
      assinaturaId: assinatura,
      motivo: 'pediu exclusão dos dados',
      ator,
      agora: emDias(1),
    });

    expect(await temCartao(assinatura)).toBe(false);
  });

  it('a régua não cobra o cartão de uma assinatura cancelada', async () => {
    /**
     * Achado da `/security-review`, e a camada que **não** depende de ninguém ter
     * lembrado de limpar a coluna: a fatura já emitida continua `aberta` depois
     * do cancelamento, e sem o estado da **assinatura** no filtro a régua da
     * madrugada apresentaria o token ao adquirente por mais quinze dias —
     * cobrando alguém que não é mais cliente, e em silêncio, porque o telefone
     * pode já ter sido apagado.
     *
     * O cartão é reposto por SQL de propósito: o teste é sobre o filtro, e uma
     * linha nesse estado chega por qualquer caminho que alguém escreva amanhã.
     */
    const assinatura = await assinaturaDe();
    await comCartao(assinatura);
    await emitirFaturas({ tenantId: TENANT, agora: VENCIMENTO });
    await cancelarAssinatura({
      tenantId: TENANT, assinaturaId: assinatura, motivo: 'saiu', ator, agora: emDias(1),
    });
    await exec(`
      UPDATE club_subscriptions SET payment_token = 'tok_sobrevivente'
       WHERE id = '${assinatura}';
    `);

    provider.proximoResultado = { pago: true, cobrancaId: 'ch_indevida' };
    await aplicarReguaDoClube({ tenantId: TENANT, provider, agora: emDias(2) });

    expect(provider.pedidos).toHaveLength(0);
  });

  it('a anonimização leva o cartão embora', async () => {
    /**
     * Credencial de pagamento é como token de sessão: some com a pessoa. Sem
     * isto, exercer o direito à exclusão deixaria para trás um token cobrável
     * amarrado a um cadastro que já não tem telefone para receber aviso nenhum.
     */
    const assinatura = await assinaturaDe();
    await comCartao(assinatura);

    await withTenant(TENANT, (tx) =>
      tx.$executeRaw`SELECT anonimizar_cliente(${CARLOS}::uuid, 'pedido do titular')`,
    );

    expect(await temCartao(assinatura)).toBe(false);
  });

  it('o motivo do perdão fica no balcão, e não vai para a tela do assinante', async () => {
    /**
     * Achado da `/security-review`. "Perdoado, cliente ameaçou ir ao Procon" é
     * exatamente o tipo de frase que alguém escreve sob permissão de dinheiro
     * sem imaginar que o titular vai lê-la — e ela chegava ao self-service
     * porque as duas telas liam o mesmo objeto.
     */
    await assinaturaDe();
    await emitirFaturas({ tenantId: TENANT, agora: VENCIMENTO });
    const [fatura] = await faturasDoClube(TENANT, { agora: VENCIMENTO });
    if (!fatura) throw new Error('sem fatura');

    const anotacao = 'perdoado, cliente ameaçou ir ao Procon';
    await cancelarFatura({ tenantId: TENANT, faturaId: fatura.id, motivo: anotacao, ator });

    const [noBalcao] = await faturasDoClube(TENANT, { agora: VENCIMENTO });
    expect(noBalcao?.motivoDoCancelamento).toBe(anotacao);

    const [doCliente] = await minhasFaturas(TENANT, CARLOS, VENCIMENTO);
    expect(JSON.stringify(doCliente)).not.toContain('Procon');
  });

  // -- o cartão ----------------------------------------------------------------

  it('avisa o cartão que vence, uma vez só', async () => {
    /**
     * Cartão vencido é o motivo nº 1 de cancelamento involuntário. Quinze dias de
     * "seu cartão vai vencer" é o que faz o canal ser ignorado — e canal ignorado
     * é pior que canal nenhum.
     */
    const assinatura = await assinaturaDe();
    await salvarCartaoDaAssinatura({
      tenantId: TENANT, assinaturaId: assinatura, token: 'tok_x',
      bandeira: 'visa', ultimosQuatro: '4242', mes: 11, ano: 2026,
    });

    const emMeadosDeNovembro = new Date('2026-11-20T12:00:00Z');
    expect(await avisarCartoesAVencer({ tenantId: TENANT, agora: emMeadosDeNovembro })).toBe(1);
    expect(await avisarCartoesAVencer({ tenantId: TENANT, agora: emMeadosDeNovembro })).toBe(0);
  });

  it('cartão com quatro últimos inválidos é recusado antes do banco', async () => {
    const assinatura = await assinaturaDe();
    await expect(
      salvarCartaoDaAssinatura({
        tenantId: TENANT, assinaturaId: assinatura, token: 'tok_x',
        bandeira: 'visa', ultimosQuatro: '42', mes: 11, ano: 2026,
      }),
    ).rejects.toMatchObject({ code: 'cartao_invalido' });
  });

  // -- a mensagem --------------------------------------------------------------

  it('a frase do aviso sai de core, com o nome do plano e o da barbearia', async () => {
    const assinatura = await assinaturaDe();
    const aviso = await montarAvisoDoClube({
      tenantId: TENANT,
      assinaturaId: assinatura,
      motivo: 'suspenso',
      agora: emDias(15),
    });

    expect(aviso?.telefone).toBe('+5571988887777');
    expect(aviso?.texto).toContain('Premium');
    expect(aviso?.texto).toContain('Domari');
  });

  it('assinatura que não existe mais não tem aviso a montar', async () => {
    // Entre o enfileiramento e o envio a pessoa pode ter pedido exclusão. A
    // tarefa conclui, porque não há o que repetir.
    const aviso = await montarAvisoDoClube({
      tenantId: TENANT,
      assinaturaId: '47474747-9999-9999-9999-999999999999',
      motivo: 'suspenso',
      agora: VENCIMENTO,
    });
    expect(aviso).toBeNull();
  });
});
