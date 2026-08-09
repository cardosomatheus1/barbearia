import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { semTenant } from '@barbearia/db';
import {
  aplicarRegua,
  bloquearBarbearia,
  cancelarFatura,
  emitirFatura,
  executarAvisoDeCobranca,
  FakeCobrancaProvider,
  FakeGestorProvider,
  faturasDaBarbearia,
  MOTIVO_DO_BLOQUEIO,
  pagarFatura,
  planosParaODono,
  PlataformaError,
  trocarPlanoPeloDono,
  assinaturaDaBarbearia,
  bloqueioDaBarbearia,
} from './index.js';

/**
 * A cobrança contra Postgres real (bloco 28).
 *
 * A régua é lógica pura e tem suíte própria em `packages/core`. O que **esta**
 * acrescenta é o que só o banco responde: que a emissão é idempotente sob o
 * índice, que o aviso entra na fila junto com a mudança de estado, que o
 * bloqueio automático é distinguível do bloqueio posto por gente, e que pagar
 * devolve a barbearia ao ar.
 *
 * O relógio entra por parâmetro em todo lugar. Nenhum teste daqui espera o
 * tempo passar — o que é a diferença entre provar a régua e provar que a suíte
 * aguenta um `sleep`.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const DOMARI = '28282828-aaaa-1111-1111-111111111111';
const RIVAL = '28282828-bbbb-2222-2222-222222222222';
const LOCAL = 'a8282828-0000-0000-0000-000000000001';
const ADMIN = 'd8282828-0000-0000-0000-000000000001';

const DIA = 86_400_000;
/** O fim do teste da barbearia, e a âncora de todas as datas desta suíte. */
const FIM_DO_TESTE = new Date('2026-06-01T12:00:00Z');
const depois = (dias: number): Date => new Date(FIM_DO_TESTE.getTime() + dias * DIA);

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

const tarefas = (kind: string) =>
  semTenant(
    (tx) => tx.$queryRaw<{ payload: Record<string, unknown>; tenant_id: string }[]>`
      SELECT payload, tenant_id FROM jobs WHERE kind = ${kind} ORDER BY created_at
    `,
  );

describeIfDb('cobrança da assinatura', () => {
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

    await exec(`
      INSERT INTO platform_admins (id, email_key, name, password_hash)
      VALUES ('${ADMIN}', 'chave-28', 'Super', 'hash');

      INSERT INTO tenants (id, name) VALUES ('${DOMARI}', 'Domari'), ('${RIVAL}', 'Rival');

      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('${LOCAL}', '${DOMARI}', 'Matriz', 'America/Bahia');

      INSERT INTO staff_users (tenant_id, name, email, phone_e164, password_hash, role)
      VALUES ('${DOMARI}', 'Rafael', 'dono@domari.com.br', '+5571988887777', 'hash', 'owner');

      UPDATE subscriptions
         SET period_start = '2026-05-18T12:00:00Z', period_end = '${FIM_DO_TESTE.toISOString()}'
       WHERE tenant_id IN ('${DOMARI}', '${RIVAL}');

      -- A vizinha nasce cancelada para que as contagens da régua falem de uma
      -- barbearia só. O teste de isolamento a reativa, que é onde ela importa.
      UPDATE subscriptions
         SET status = 'canceled', canceled_at = now(), cancel_reason = 'fora do teste'
       WHERE tenant_id = '${RIVAL}';
    `);
  });

  // -- emissão ----------------------------------------------------------------

  it('a fatura cobre o período seguinte, não o teste que já foi entregue', async () => {
    const fatura = await emitirFatura({ tenantId: DOMARI, agora: depois(-2) });

    expect(fatura).toMatchObject({ tipo: 'subscription', estado: 'open', valorCents: 9900 });
    expect(fatura?.periodoInicio.toISOString()).toBe(FIM_DO_TESTE.toISOString());
    // Cinco dias de prazo a partir do começo do período cobrado.
    expect(fatura?.vencimento.toISOString()).toBe(depois(5).toISOString());
  });

  it('emitir duas vezes o mesmo período não cobra duas vezes', async () => {
    await emitirFatura({ tenantId: DOMARI, agora: depois(-2) });
    expect(await emitirFatura({ tenantId: DOMARI, agora: depois(-1) })).toBeNull();
    expect(await faturasDaBarbearia(DOMARI)).toHaveLength(1);
  });

  it('a emissão avisa o dono na mesma transação', async () => {
    const fatura = await emitirFatura({ tenantId: DOMARI, agora: depois(-2) });
    const fila = await tarefas('cobranca.aviso');

    expect(fila).toHaveLength(1);
    expect(fila[0]).toMatchObject({ tenant_id: DOMARI });
    expect(fila[0]?.payload).toEqual({ faturaId: fatura?.id, assunto: 'emitida' });
  });

  it('assinatura cancelada não é cobrada', async () => {
    await exec(`
      UPDATE subscriptions SET status = 'canceled', canceled_at = now(), cancel_reason = 'saiu'
       WHERE tenant_id = '${DOMARI}'
    `);
    expect(await emitirFatura({ tenantId: DOMARI, agora: depois(-2) })).toBeNull();
  });

  it('plano sem preço de tabela não vira fatura de R$ 0,00', async () => {
    await exec(`
      UPDATE subscriptions SET plan_code = 'enterprise', price_cents = 0
       WHERE tenant_id = '${DOMARI}'
    `);
    expect(await emitirFatura({ tenantId: DOMARI, agora: depois(-2) })).toBeNull();
  });

  // -- a régua ----------------------------------------------------------------

  it('a régua emite, avisa, marca vencida e só então suspende', async () => {
    const provider = new FakeCobrancaProvider();

    // Três dias antes do fim do período: emite, e a fatura ainda não vence.
    expect(await aplicarRegua({ agora: depois(-3), provider })).toMatchObject({ emitidas: 1 });

    // Vencimento é em depois(5); o aviso sai três dias antes.
    expect(await aplicarRegua({ agora: depois(2), provider })).toMatchObject({ avisadas: 1 });
    // De novo no mesmo dia não manda o segundo aviso.
    expect(await aplicarRegua({ agora: depois(2), provider })).toMatchObject({ avisadas: 0 });

    expect(await aplicarRegua({ agora: depois(5), provider })).toMatchObject({ vencidas: 1 });
    expect((await assinaturaDaBarbearia(DOMARI))?.estado).toBe('past_due');
    // Vencida não é bloqueada, e essa distinção é o bloco inteiro.
    expect(await bloqueioDaBarbearia(DOMARI)).toMatchObject({ bloqueada: false });

    expect(await aplicarRegua({ agora: depois(6), provider })).toMatchObject({ cobradas: 1 });
    expect(provider.tentativas).toHaveLength(1);

    // Vencimento em depois(5) mais 21 dias de janela: a suspensão é em depois(26).
    expect(await aplicarRegua({ agora: depois(26), provider })).toMatchObject({ bloqueadas: 1 });
    expect(await bloqueioDaBarbearia(DOMARI)).toMatchObject({
      bloqueada: true,
      motivo: MOTIVO_DO_BLOQUEIO,
    });
  });

  it('o bloqueio automático fica na trilha, com autor nulo', async () => {
    const provider = new FakeCobrancaProvider();
    await aplicarRegua({ agora: depois(-3), provider });
    await aplicarRegua({ agora: depois(30), provider });

    const trilha = await semTenant(
      (tx) => tx.$queryRaw<{ admin_id: string | null; detail: Record<string, unknown> }[]>`
        SELECT admin_id, detail FROM platform_audit WHERE action = 'tenant.blocked'
      `,
    );
    expect(trilha).toHaveLength(1);
    expect(trilha[0]?.admin_id).toBeNull();
    expect(trilha[0]?.detail['por']).toBe('regua');
  });

  it('o aviso do bloqueio entra na fila junto com o bloqueio', async () => {
    const provider = new FakeCobrancaProvider();
    await aplicarRegua({ agora: depois(-3), provider });
    await aplicarRegua({ agora: depois(30), provider });

    const assuntos = (await tarefas('cobranca.aviso')).map((t) => t.payload['assunto']);
    expect(assuntos).toContain('bloqueada');
  });

  it('a régua repetida no mesmo dia não adianta a escada nem suspende mais cedo', async () => {
    const provider = new FakeCobrancaProvider();
    await aplicarRegua({ agora: depois(-3), provider });
    await aplicarRegua({ agora: depois(5), provider });

    for (let i = 0; i < 4; i++) await aplicarRegua({ agora: depois(6), provider });

    // Uma só tentativa, porque a escada é lida da fatura e não do laço.
    expect(provider.tentativas).toHaveLength(1);
    expect(await bloqueioDaBarbearia(DOMARI)).toMatchObject({ bloqueada: false });
  });

  it('cobrança aprovada quita a fatura e devolve a assinatura ao normal', async () => {
    const provider = new FakeCobrancaProvider();
    await aplicarRegua({ agora: depois(-3), provider });
    await aplicarRegua({ agora: depois(5), provider });

    provider.aprovarProxima = true;
    expect(await aplicarRegua({ agora: depois(6), provider })).toMatchObject({ pagas: 1 });

    const assinatura = await assinaturaDaBarbearia(DOMARI);
    expect(assinatura?.estado).toBe('active');
    // O período andou para o que foi pago.
    expect(assinatura?.periodoAte.toISOString()).toBe(depois(30).toISOString());
  });

  it('pagar destranca a barbearia suspensa pela régua', async () => {
    const provider = new FakeCobrancaProvider();
    await aplicarRegua({ agora: depois(-3), provider });
    await aplicarRegua({ agora: depois(30), provider });
    expect(await bloqueioDaBarbearia(DOMARI)).toMatchObject({ bloqueada: true });

    const [fatura] = await faturasDaBarbearia(DOMARI);
    await pagarFatura({ adminId: ADMIN, faturaId: fatura!.id, metodo: 'manual' });

    expect(await bloqueioDaBarbearia(DOMARI)).toMatchObject({ bloqueada: false });
    expect((await assinaturaDaBarbearia(DOMARI))?.estado).toBe('active');
  });

  /**
   * O caminho triste que importa: pagar a mensalidade não pode desfazer um
   * bloqueio posto por gente. Fraude, ordem judicial e abuso não têm boleto.
   */
  it('pagar não destranca quem foi bloqueado por decisão de gente', async () => {
    await emitirFatura({ tenantId: DOMARI, agora: depois(-2) });
    await bloquearBarbearia({ adminId: ADMIN, tenantId: DOMARI, motivo: 'Suspeita de fraude' });

    const [fatura] = await faturasDaBarbearia(DOMARI);
    await pagarFatura({ adminId: ADMIN, faturaId: fatura!.id, metodo: 'manual' });

    expect(await bloqueioDaBarbearia(DOMARI)).toMatchObject({
      bloqueada: true,
      motivo: 'Suspeita de fraude',
    });
  });

  it('cancelar a fatura exige motivo e não conta como dinheiro entrado', async () => {
    await emitirFatura({ tenantId: DOMARI, agora: depois(-2) });
    const [fatura] = await faturasDaBarbearia(DOMARI);

    await expect(
      cancelarFatura({ adminId: ADMIN, faturaId: fatura!.id, motivo: ' ' }),
    ).rejects.toBeInstanceOf(PlataformaError);

    await cancelarFatura({ adminId: ADMIN, faturaId: fatura!.id, motivo: 'Cortesia de migração' });
    const [depoisDoCancelamento] = await faturasDaBarbearia(DOMARI);
    expect(depoisDoCancelamento).toMatchObject({ estado: 'void', pagaEm: null });
    // Perdoada também avança o período: sem isso a régua reemitiria para sempre.
    expect((await assinaturaDaBarbearia(DOMARI))?.periodoAte.toISOString()).toBe(
      depois(30).toISOString(),
    );
  });

  it('fatura já encerrada não é paga duas vezes', async () => {
    await emitirFatura({ tenantId: DOMARI, agora: depois(-2) });
    const [fatura] = await faturasDaBarbearia(DOMARI);
    await pagarFatura({ adminId: ADMIN, faturaId: fatura!.id, metodo: 'manual' });

    await expect(
      pagarFatura({ adminId: ADMIN, faturaId: fatura!.id, metodo: 'manual' }),
    ).rejects.toBeInstanceOf(PlataformaError);
  });

  // -- o aviso ao gestor ------------------------------------------------------

  it('o aviso chega ao dono com o que falta para a suspensão', async () => {
    const gestor = new FakeGestorProvider();
    await emitirFatura({ tenantId: DOMARI, agora: depois(-2) });
    const [fatura] = await faturasDaBarbearia(DOMARI);

    await executarAvisoDeCobranca({
      tenantId: DOMARI,
      faturaId: fatura!.id,
      assunto: 'venceu',
      provider: gestor,
      agora: depois(6),
    });

    expect(gestor.avisos).toHaveLength(1);
    expect(gestor.avisos[0]).toMatchObject({
      email: 'dono@domari.com.br',
      barbearia: 'Domari',
      valorCents: 9900,
      assunto: 'venceu',
      diasAteOBloqueio: 20,
    });
  });

  /**
   * A tarefa foi criada em outra volta da régua. Entre lá e agora o dono pode
   * ter pago — e "sua conta venceu" para quem acabou de pagar é o tipo de
   * mensagem que destrói a confiança nas seguintes.
   */
  it('não manda cobrança de fatura que já foi paga', async () => {
    const gestor = new FakeGestorProvider();
    await emitirFatura({ tenantId: DOMARI, agora: depois(-2) });
    const [fatura] = await faturasDaBarbearia(DOMARI);
    await pagarFatura({ adminId: ADMIN, faturaId: fatura!.id, metodo: 'manual' });

    await executarAvisoDeCobranca({
      tenantId: DOMARI,
      faturaId: fatura!.id,
      assunto: 'venceu',
      provider: gestor,
      agora: depois(6),
    });

    expect(gestor.avisos).toHaveLength(0);
  });

  /**
   * A janela de silêncio vem da unidade, nunca do processo — é o defeito D2, e
   * aqui ele mandaria cobrança de madrugada. A tarefa não some: ela se
   * reprograma para as 8h, porque a cobrança de amanhã continua valendo.
   */
  it('de madrugada o aviso se reprograma em vez de sair', async () => {
    const gestor = new FakeGestorProvider();
    await emitirFatura({ tenantId: DOMARI, agora: depois(-2) });
    const [fatura] = await faturasDaBarbearia(DOMARI);
    await semTenant((tx) => tx.$executeRaw`DELETE FROM jobs`);

    // 05:00 em America/Bahia (UTC-3) é 08:00Z.
    const madrugada = new Date('2026-06-08T08:00:00Z');
    await executarAvisoDeCobranca({
      tenantId: DOMARI,
      faturaId: fatura!.id,
      assunto: 'venceu',
      provider: gestor,
      agora: madrugada,
    });

    expect(gestor.avisos).toHaveLength(0);
    expect(await tarefas('cobranca.aviso')).toHaveLength(1);
  });

  // -- troca de plano pelo dono ----------------------------------------------

  it('a vitrine do dono mostra o que cada troca custaria agora', async () => {
    // Metade do período de 14 dias: 7 dias corridos, 7 restantes.
    const planos = await planosParaODono({ tenantId: DOMARI, agora: depois(-7) });
    const business = planos.find((p) => p.code === 'business');

    expect(planos.map((p) => p.code)).toEqual(['starter', 'pro', 'business']);
    expect(planos.find((p) => p.code === 'pro')?.atual).toBe(true);
    expect(business?.rateio).toMatchObject({ diasRestantes: 7, diasDoPeriodo: 14 });
    // 24900*7/14 = 12450 a cobrar; 9900*7/14 = 4950 de crédito.
    expect(business?.rateio.cobrarCents).toBe(7500);
  });

  it('subir de plano emite o acerto do que falta do período', async () => {
    const { rateio, faturaId } = await trocarPlanoPeloDono({
      tenantId: DOMARI,
      planoCode: 'business',
      agora: depois(-7),
    });

    expect(rateio.cobrarCents).toBe(7500);
    expect(faturaId).not.toBeNull();

    const [fatura] = await faturasDaBarbearia(DOMARI);
    expect(fatura).toMatchObject({ tipo: 'proration', valorCents: 7500, planoCode: 'business' });
    expect((await assinaturaDaBarbearia(DOMARI))?.planoCode).toBe('business');
  });

  it('descer de plano vira crédito, e o crédito abate a próxima mensalidade', async () => {
    await exec(`
      UPDATE subscriptions SET plan_code = 'business', price_cents = 24900
       WHERE tenant_id = '${DOMARI}'
    `);

    const { rateio, faturaId } = await trocarPlanoPeloDono({
      tenantId: DOMARI,
      planoCode: 'pro',
      agora: depois(-7),
    });
    expect(rateio.creditarCents).toBe(7500);
    // Crédito não vira fatura negativa: é documento que ninguém sabe pagar.
    expect(faturaId).toBeNull();

    const fatura = await emitirFatura({ tenantId: DOMARI, agora: depois(-1) });
    expect(fatura?.valorCents).toBe(9900 - 7500);
  });

  it('a equipe maior que o teto impede a descida, com o número na mensagem', async () => {
    await exec(`
      UPDATE subscriptions SET plan_code = 'business', price_cents = 24900
       WHERE tenant_id = '${DOMARI}';
      INSERT INTO professionals (tenant_id, location_id, name, kind)
      SELECT '${DOMARI}', '${LOCAL}', 'Barbeiro ' || n, 'professional'
        FROM generate_series(1, 3) AS n;
    `);

    const planos = await planosParaODono({ tenantId: DOMARI, agora: depois(-7) });
    expect(planos.find((p) => p.code === 'starter')?.impedimento).toContain('3 cadeiras');

    await expect(
      trocarPlanoPeloDono({ tenantId: DOMARI, planoCode: 'starter', agora: depois(-7) }),
    ).rejects.toMatchObject({ code: 'chairs_exceed_plan' });
  });

  it('o dono não contrata o plano que é vendido por conversa', async () => {
    await expect(
      trocarPlanoPeloDono({ tenantId: DOMARI, planoCode: 'enterprise', agora: depois(-7) }),
    ).rejects.toMatchObject({ code: 'plan_not_self_service' });
  });

  it('trocar para o plano em que já se está é recusado', async () => {
    await expect(
      trocarPlanoPeloDono({ tenantId: DOMARI, planoCode: 'pro', agora: depois(-7) }),
    ).rejects.toMatchObject({ code: 'same_plan' });
  });

  // -- isolamento -------------------------------------------------------------

  it('a régua de uma barbearia não mexe na outra', async () => {
    await exec(`
      UPDATE subscriptions SET status = 'trialing', canceled_at = NULL, cancel_reason = NULL
       WHERE tenant_id = '${RIVAL}'
    `);
    const provider = new FakeCobrancaProvider();
    await aplicarRegua({ agora: depois(-3), provider });
    await aplicarRegua({ agora: depois(30), provider });

    // As duas nasceram no mesmo período, então as duas são bloqueadas — o que
    // importa é que o extrato de cada uma seja o dela.
    const daDomari = await faturasDaBarbearia(DOMARI);
    const doRival = await faturasDaBarbearia(RIVAL);
    expect(daDomari.every((f) => f.tenantId === DOMARI)).toBe(true);
    expect(doRival.every((f) => f.tenantId === RIVAL)).toBe(true);
  });
});
