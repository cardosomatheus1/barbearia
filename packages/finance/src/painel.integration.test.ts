import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { abrirCaixa } from './caixa.js';
import { abrirComanda, adicionarItem, ajustarComanda, fecharComanda } from './comanda.js';
import {
  painelDeDinheiro,
  painelDeDinheiroDoPeriodo,
  painelOperacional,
  painelOperacionalDoPeriodo,
} from './painel.js';

/**
 * O painel do proprietário contra Postgres real — SPEC §5.9.
 *
 * O que se prova aqui: que a comparação é com o **mesmo dia da semana** (sábado
 * com sábado, não sábado com sexta), que ocupação é tempo e não contagem, e que
 * o painel de uma barbearia não enxerga a outra.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];

const TENANT = '11111111-1111-1111-1111-111111111111';
const RIVAL = '22222222-2222-2222-2222-222222222222';
const LOCATION = 'aaaaaaaa-0000-0000-0000-000000000001';
const LOCAL_RIVAL = 'aaaaaaaa-0000-0000-0000-000000000002';
const RUAN = 'bbbbbbbb-0000-0000-0000-000000000001';
const CABELO = 'eeeeeeee-0000-0000-0000-000000000001';
const CARLOS = 'cccccccc-0000-0000-0000-000000000001';
const JOAO = 'cccccccc-0000-0000-0000-000000000002';
const STAFF = 'ffffffff-0000-0000-0000-000000000001';

let admin: PrismaClient;
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const operador = { staffId: STAFF, staffName: 'Matheus Dono' };
/** Sábado. O anterior, 2026-09-05, também é sábado. */
const SABADO = '2026-09-12';
const SABADO_ANTES = '2026-09-05';

async function exec(client: PrismaClient, sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await client.$executeRawUnsafe(parte);
  }
}

describeIfDb('painel do proprietário', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await exec(admin, `
      INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Domari'), ('${RIVAL}', 'Rival');

      INSERT INTO locations (id, tenant_id, name, timezone) VALUES
        ('${LOCATION}', '${TENANT}', 'Matriz', 'America/Bahia'),
        ('${LOCAL_RIVAL}', '${RIVAL}', 'Rival', 'America/Bahia');

      INSERT INTO professionals (id, tenant_id, location_id, name, kind)
      VALUES ('${RUAN}', '${TENANT}', '${LOCATION}', 'Ruan', 'professional');

      -- Sábado (6) das 9h às 17h, com uma hora de almoço: 480 - 60 = 420
      -- minutos de capacidade.
      --
      -- A pausa entra na semente de propósito. Sem ela, a asserção de ocupação
      -- passava **idêntica** com e sem o desconto no denominador — teste que
      -- passaria mesmo com a regra removida —, e foi assim que o painel ficou
      -- discordando da métrica sobre a mesma cadeira.
      INSERT INTO work_schedules (tenant_id, professional_id, weekday, start_minute, end_minute, breaks)
      VALUES ('${TENANT}', '${RUAN}', 6, 540, 1020,
              '[{"start": 720, "end": 780}]'::jsonb);

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes)
      VALUES ('${CABELO}', '${TENANT}', 'Corte', 5000, 30);

      INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
        ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777'),
        ('${JOAO}', '${TENANT}', 'Joao Lima', '+5571977776666');

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${STAFF}', '${TENANT}', 'Matheus', 'dono@domari.com.br', 'x', 'owner');
    `);
  });

  /** Um atendimento no dia, com duração e status. */
  async function agendou(params: {
    readonly id: string;
    readonly dia: string;
    readonly hora: number;
    readonly minutos?: number;
    readonly status?: string;
    readonly customerId?: string;
  }): Promise<void> {
    const minutos = params.minutos ?? 30;
    const inicio = `${params.dia}T${String(params.hora).padStart(2, '0')}:00:00Z`;
    const fim = new Date(new Date(inicio).getTime() + minutos * 60_000).toISOString();
    await exec(admin, `
      INSERT INTO appointments
        (id, tenant_id, location_id, customer_id, professional_id,
         starts_at, ends_at, service_starts_at, service_ends_at, price_cents, status)
      VALUES ('${params.id}', '${TENANT}', '${LOCATION}',
              '${params.customerId ?? CARLOS}', '${RUAN}',
              '${inicio}', '${fim}', '${inicio}', '${fim}', 5000,
              '${params.status ?? 'completed'}')
    `);
  }

  async function vendeu(precoCents: number, dia: string): Promise<void> {
    await abrirCaixa({ tenantId: TENANT, locationId: LOCATION, openingCents: 0, ...operador })
      .catch(() => undefined);
    const aberta = await abrirComanda({
      tenantId: TENANT, locationId: LOCATION, customerId: CARLOS, staffId: STAFF,
    });
    await adicionarItem({
      tenantId: TENANT, locationId: LOCATION, orderId: aberta.id,
      tipo: 'service', serviceId: CABELO, descricao: 'Corte',
      quantidade: 1, precoUnitarioCents: precoCents, professionalId: RUAN,
    });
    await fecharComanda({
      tenantId: TENANT, locationId: LOCATION, orderId: aberta.id,
      pagamentos: [{ forma: 'cash', valorCents: precoCents }],
      hojeNaUnidade: dia, ...operador,
    });
  }

  const operacao = (dia = SABADO) =>
    painelOperacional({ tenantId: TENANT, locationId: LOCATION, dia });
  const dinheiro = (dia = SABADO) =>
    painelDeDinheiro({ tenantId: TENANT, locationId: LOCATION, dia });

  const uuid = (n: number) => `f0000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

  it('compara com o mesmo dia da semana, não com ontem', async () => {
    /**
     * Barbearia tem semana com forma: sábado é o dobro de terça. Comparar
     * sábado com sexta produziria alta toda semana e queda toda segunda — ruído
     * que ninguém consegue usar.
     */
    const painel = await operacao();
    expect(painel.comparadoCom).toBe(SABADO_ANTES);
  });

  it('conta agendamentos do dia e compara com o sábado anterior', async () => {
    await agendou({ id: uuid(1), dia: SABADO, hora: 12 });
    await agendou({ id: uuid(2), dia: SABADO, hora: 13 });
    await agendou({ id: uuid(3), dia: SABADO_ANTES, hora: 12 });

    const painel = await operacao();
    expect(painel.agendamentos.valor).toBe(2);
    expect(painel.agendamentos.anterior).toBe(1);
    expect(painel.agendamentos.variacao).toBe(100);
  });

  it('ocupação é tempo, não contagem', async () => {
    /**
     * Um corte de 30 e uma coloração de 120 não ocupam a casa do mesmo jeito.
     * Contar cabeças esconderia isso — e ocupação é a métrica que decide se
     * vale contratar.
     */
    await agendou({ id: uuid(1), dia: SABADO, hora: 12, minutos: 120 });
    await agendou({ id: uuid(2), dia: SABADO, hora: 15, minutos: 120 });

    /**
     * 240 minutos vendidos sobre **420** de jornada — 480 menos a hora de
     * almoço. Sem descontar a pausa daria 50, e é esse o número que o painel
     * mostrava enquanto a métrica ao lado mostrava 57 (§6, pergunta 6).
     */
    expect((await operacao()).ocupacao.valor).toBe(57);
  });

  it('sem jornada no dia, a ocupação é zero e não infinito', async () => {
    // Domingo: a casa não abre, e dividir por zero não pode virar a métrica.
    const domingo = await painelOperacional({
      tenantId: TENANT, locationId: LOCATION, dia: '2026-09-13',
    });
    expect(domingo.ocupacao.valor).toBe(0);
    expect(Number.isFinite(domingo.ocupacao.valor)).toBe(true);
  });

  it('a falta entra na taxa, não some da conta', async () => {
    await agendou({ id: uuid(1), dia: SABADO, hora: 12 });
    await agendou({ id: uuid(2), dia: SABADO, hora: 13, status: 'no_show' });
    await agendou({ id: uuid(3), dia: SABADO, hora: 14, status: 'no_show' });

    // Duas faltas em três esperados.
    expect((await operacao()).noShow.valor).toBe(67);
  });

  it('cliente novo é o que apareceu pela primeira vez, não o cadastro do dia', async () => {
    /**
     * Contar cadastro criado hoje contaria também quem a recepção digitou de
     * novo por engano — e o número que interessa é quantas pessoas novas
     * sentaram na cadeira.
     */
    await agendou({ id: uuid(1), dia: SABADO_ANTES, hora: 12, customerId: CARLOS });
    await agendou({ id: uuid(2), dia: SABADO, hora: 12, customerId: CARLOS });
    await agendou({ id: uuid(3), dia: SABADO, hora: 13, customerId: JOAO });

    const painel = await operacao();
    // Carlos já tinha vindo; só o João é novo hoje.
    expect(painel.novosClientes.valor).toBe(1);
    expect(painel.novosClientes.anterior).toBe(1);
  });

  it('o remarcado não conta duas vezes', async () => {
    // `rescheduled` aponta para o novo agendamento; contar os dois inflaria o
    // dia com um atendimento que não existe.
    await agendou({ id: uuid(1), dia: SABADO, hora: 12, status: 'rescheduled' });
    await agendou({ id: uuid(2), dia: SABADO, hora: 13 });

    expect((await operacao()).agendamentos.valor).toBe(1);
  });

  it('o faturamento sai da comanda fechada, no dia da unidade', async () => {
    await vendeu(12000, SABADO);
    await vendeu(8000, SABADO_ANTES);

    const painel = await dinheiro();
    expect(painel.faturamentoCents.valor).toBe(12000);
    expect(painel.faturamentoCents.anterior).toBe(8000);
    expect(painel.faturamentoCents.variacao).toBe(50);
  });

  it('a gorjeta não entra no faturamento — ela não é da casa', async () => {
    /**
     * `total_cents` é subtotal − desconto + gorjeta, e o painel somava o total
     * inteiro. O efeito era duas telas discordando sobre o mesmo mês: o painel
     * dizia R$ 13.480 e o DRE dizia R$ 13.268, e a diferença era exatamente a
     * gorjeta — sem que nenhuma das duas explicasse nada (§6, pergunta 6).
     *
     * `somarComanda` já soma a gorjeta **por fora** justamente porque ela não é
     * da casa: aplicá-la sobre o total descontado faria o barbeiro receber
     * menos quando a barbearia dá desconto. O painel é a última tela que ainda
     * a tratava como receita — e é ela que compara com a meta do mês, o que
     * tornava a meta batível com dinheiro de outra pessoa.
     */
    const aberta = await abrirComanda({
      tenantId: TENANT, locationId: LOCATION, customerId: CARLOS, staffId: STAFF,
    });
    await adicionarItem({
      tenantId: TENANT, locationId: LOCATION, orderId: aberta.id,
      tipo: 'service', serviceId: CABELO, descricao: 'Corte',
      quantidade: 1, precoUnitarioCents: 5000, professionalId: RUAN,
    });
    await ajustarComanda({
      locationId: LOCATION,
      tenantId: TENANT, orderId: aberta.id, desconto: null, gorjetaCents: 1000,
      staffId: STAFF, staffName: 'Maria',
    });
    await abrirCaixa({ tenantId: TENANT, locationId: LOCATION, openingCents: 0, ...operador })
      .catch(() => undefined);
    await fecharComanda({
      tenantId: TENANT, locationId: LOCATION, orderId: aberta.id,
      pagamentos: [{ forma: 'cash', valorCents: 6000 }],
      hojeNaUnidade: SABADO, ...operador,
    });

    const painel = await dinheiro();
    expect(painel.faturamentoCents.valor).toBe(5000);
  });

  it('o ticket médio divide pelo número de comandas', async () => {
    await vendeu(10000, SABADO);
    await vendeu(6000, SABADO);

    expect((await dinheiro()).ticketMedioCents.valor).toBe(8000);
  });

  it('dia sem venda não devolve NaN', async () => {
    const painel = await dinheiro();
    expect(painel.faturamentoCents.valor).toBe(0);
    expect(painel.ticketMedioCents.valor).toBe(0);
    // Sem base anterior não há comparação: "primeiro dia" não é "caiu 100%".
    expect(painel.faturamentoCents.variacao).toBeNull();
  });

  it('o painel de uma barbearia não enxerga a outra', async () => {
    await agendou({ id: uuid(1), dia: SABADO, hora: 12 });
    await vendeu(12000, SABADO);

    const daRival = await painelOperacional({
      tenantId: RIVAL, locationId: LOCAL_RIVAL, dia: SABADO,
    });
    const dinheiroDaRival = await painelDeDinheiro({
      tenantId: RIVAL, locationId: LOCAL_RIVAL, dia: SABADO,
    });

    expect(daRival.agendamentos.valor).toBe(0);
    expect(dinheiroDaRival.faturamentoCents.valor).toBe(0);
  });

  /**
   * O recorte de semana e de mês, que nenhum teste executava (bloco 103).
   *
   * Cinco consultas cruas de `painel.ts` — `operacionalDoPeriodo`,
   * `capacidadeDoPeriodo`, `dinheiroDoPeriodo`, `serieDeFaturamento` e
   * `metaDaCasa` — só são alcançáveis por estas duas funções, e nenhum teste do
   * repositório passava `periodo`. Elas passaram por typecheck, por build e pelo
   * portão inteiro sem nunca tocar um banco.
   *
   * `$queryRaw` é string: o TypeScript não a lê e o Prisma não a confere. Foi
   * assim que três consultas quebradas derrubaram a varredura de automação por
   * quatro dias em produção nesta mesma semana. O que este caso garante não é
   * um número — é que o SQL **roda**.
   */
  it('o recorte de semana e de mês executa as consultas de período', async () => {
    await agendou({ id: uuid(1), dia: SABADO, hora: 12, minutos: 120 });

    /**
     * A ocupação esperada por recorte, e ela discrimina os dois jeitos.
     *
     * Ruan só trabalha sábado. A janela de 7 dias (06 a 12/09) tem **um**
     * sábado: 120 sobre 420 dá 29. A do mês (01 a 12/09) tem **dois**: 120
     * sobre 840 dá 14. Sem descontar o almoço os mesmos casos dariam 25 e 13,
     * então os dois números continuam separando o certo do errado.
     */
    const ESPERADO: Readonly<Record<'7d' | 'mes', number>> = { '7d': 29, mes: 14 };

    for (const periodo of ['7d', 'mes'] as const) {
      const operacao = await painelOperacionalDoPeriodo({
        tenantId: TENANT, locationId: LOCATION, dia: SABADO, periodo,
      });
      const dinheiro = await painelDeDinheiroDoPeriodo({
        tenantId: TENANT, locationId: LOCATION, dia: SABADO, periodo,
      });

      expect(operacao.agendamentos.valor, periodo).toBeGreaterThanOrEqual(1);
      // A ocupação do período sai do mesmo denominador com pausa descontada.
      expect(operacao.ocupacao.valor, periodo).toBe(ESPERADO[periodo]);
      expect(dinheiro.faturamentoCents.valor, periodo).toBeGreaterThanOrEqual(0);
      expect(dinheiro.serie?.length ?? 0, periodo).toBeGreaterThan(0);
    }
  });

  it('id de unidade alheia não vaza o dado da casa', async () => {
    // Id de unidade é entrada externa. Com o tenant da rival e a unidade da
    // casa, a RLS devolve zero — o filtro por unidade não substitui a política.
    await agendou({ id: uuid(1), dia: SABADO, hora: 12 });

    const cruzado = await painelOperacional({
      tenantId: RIVAL, locationId: LOCATION, dia: SABADO,
    });
    expect(cruzado.agendamentos.valor).toBe(0);
  });
});
