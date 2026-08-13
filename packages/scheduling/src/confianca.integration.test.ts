import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  avaliarSinal,
  confiancaDoCliente,
  confiancaDeVarios,
  conferirMarcacaoOnline,
  historicoDoCliente,
  recusasRecentes,
} from './confianca.js';
import { horaCheia } from './ocupacao.js';
import { withTenant } from '@barbearia/db';

/**
 * O sinal seletivo contra banco de verdade (bloco 37).
 *
 * O que os testes puros de `packages/core` não alcançam está aqui: a tradução de
 * `status` em desfecho, o recorte da janela feito pela consulta, o override do
 * gerente vindo de `customers`, e o isolamento — o histórico de uma barbearia
 * não pode influenciar o score que a outra calcula para a **mesma pessoa**.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'] ?? process.env['DATABASE_URL'];

const TENANT = '11111111-1111-1111-1111-111111111111';
const RIVAL = '22222222-2222-2222-2222-222222222222';
const LOCATION = 'aaaaaaaa-0000-0000-0000-000000000001';
const LOCATION_RIVAL = 'aaaaaaaa-0000-0000-0000-000000000002';
const RUAN = 'bbbbbbbb-0000-0000-0000-000000000001';
const RUAN_RIVAL = 'bbbbbbbb-0000-0000-0000-000000000002';
const CABELO = 'eeeeeeee-0000-0000-0000-000000000001';
const COLORACAO = 'eeeeeeee-0000-0000-0000-000000000002';
const CARLOS = 'cccccccc-0000-0000-0000-000000000001';
/** O mesmo telefone em duas barbearias é a mesma pessoa, com dois cadastros. */
const CARLOS_NO_RIVAL = 'cccccccc-0000-0000-0000-000000000002';

const AGORA = new Date('2026-08-11T12:00:00Z');

let admin: PrismaClient;
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

/** Um agendamento a `diasAtras` dias, no estado pedido. */
function agendamento(opcoes: {
  id: string;
  tenant?: string;
  location?: string;
  professional?: string;
  customer?: string;
  diasAtras: number;
  status: string;
  canceladoHorasAntes?: number | null;
  chegouMinutosDepois?: number | null;
}): string {
  const {
    id,
    tenant = TENANT,
    location = LOCATION,
    professional = RUAN,
    customer = CARLOS,
    diasAtras,
    status,
    canceladoHorasAntes = null,
    chegouMinutosDepois = null,
  } = opcoes;

  const comeca = new Date(AGORA.getTime() - diasAtras * 86_400_000);
  const termina = new Date(comeca.getTime() + 30 * 60_000);
  const cancelado =
    canceladoHorasAntes === null
      ? 'NULL'
      : `'${new Date(comeca.getTime() - canceladoHorasAntes * 3_600_000).toISOString()}'`;
  const chegou =
    chegouMinutosDepois === null
      ? 'NULL'
      : `'${new Date(comeca.getTime() + chegouMinutosDepois * 60_000).toISOString()}'`;

  return `
    INSERT INTO appointments
      (id, tenant_id, location_id, customer_id, professional_id,
       starts_at, ends_at, service_starts_at, service_ends_at,
       status, cancelled_at, checked_in_at)
    VALUES ('${id}', '${tenant}', '${location}', '${customer}', '${professional}',
            '${comeca.toISOString()}', '${termina.toISOString()}',
            '${comeca.toISOString()}', '${termina.toISOString()}',
            '${status}', ${cancelado}, ${chegou})`;
}

const idDe = (n: number) => `dddddddd-0000-0000-0000-${String(n).padStart(12, '0')}`;

describeIfDb('sinal seletivo', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await exec(`
      TRUNCATE appointments, customers, services, professionals, locations, tenants
        RESTART IDENTITY CASCADE;

      INSERT INTO tenants (id, name) VALUES
        ('${TENANT}', 'Domari'), ('${RIVAL}', 'Vizinha');

      INSERT INTO locations (id, tenant_id, name, timezone) VALUES
        ('${LOCATION}', '${TENANT}', 'Centro', 'America/Bahia'),
        ('${LOCATION_RIVAL}', '${RIVAL}', 'Outra', 'America/Bahia');

      INSERT INTO professionals (id, tenant_id, location_id, name) VALUES
        ('${RUAN}', '${TENANT}', '${LOCATION}', 'Ruan'),
        ('${RUAN_RIVAL}', '${RIVAL}', '${LOCATION_RIVAL}', 'Outro');

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes) VALUES
        ('${CABELO}', '${TENANT}', 'Cabelo', 4900, 30),
        ('${COLORACAO}', '${TENANT}', 'Coloração', 19900, 180);

      INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
        ('${CARLOS}', '${TENANT}', 'Carlos', '+5571988887777'),
        ('${CARLOS_NO_RIVAL}', '${RIVAL}', 'Carlos', '+5571988887777');
    `);
  });

  const historico = () =>
    withTenant(TENANT, (tx) => historicoDoCliente(tx, CARLOS, AGORA));
  const confianca = () => withTenant(TENANT, (tx) => confiancaDoCliente(tx, CARLOS, AGORA));

  const ligarSinal = (extra = '') =>
    exec(`UPDATE locations
             SET deposit_mode = 'fixo', deposit_fixed_cents = 2000 ${extra}
           WHERE id = '${LOCATION}'`);

  // -- tradução de status ------------------------------------------------------

  it('traduz cada status no desfecho que o score entende', async () => {
    await exec([
      agendamento({ id: idDe(1), diasAtras: 10, status: 'completed' }),
      agendamento({ id: idDe(2), diasAtras: 20, status: 'no_show' }),
      agendamento({ id: idDe(3), diasAtras: 30, status: 'cancelled_business', canceladoHorasAntes: 1 }),
      agendamento({ id: idDe(4), diasAtras: 40, status: 'cancelled_customer', canceladoHorasAntes: 48 }),
      agendamento({ id: idDe(5), diasAtras: 50, status: 'cancelled_customer', canceladoHorasAntes: 1 }),
    ].join(';'));

    const linhas = await historico();
    expect(linhas.map((l) => l.desfecho).sort()).toEqual([
      'cancelado_pela_casa',
      'cancelou_cedo',
      'cancelou_em_cima',
      'compareceu',
      'faltou',
    ]);
  });

  it('o que ainda não aconteceu não entra no histórico', async () => {
    // `pending` e `confirmed` são intenção, não desfecho. Contá-los como
    // comparecimento inflaria o score de quem só marca.
    await exec([
      agendamento({ id: idDe(6), diasAtras: 1, status: 'pending' }),
      agendamento({ id: idDe(7), diasAtras: 2, status: 'confirmed' }),
      agendamento({ id: idDe(8), diasAtras: 3, status: 'in_progress' }),
    ].join(';'));

    expect(await historico()).toHaveLength(0);
  });

  it('o remarcado não entra — ele virou outro agendamento', async () => {
    /**
     * Contá-lo somaria duas vezes a mesma intenção do cliente, e como
     * `rescheduled` nunca tem desfecho próprio, ele entraria como evento neutro
     * diluindo a taxa de falta de quem falta.
     */
    await exec([
      agendamento({ id: idDe(9), diasAtras: 5, status: 'rescheduled' }),
      agendamento({ id: idDe(10), diasAtras: 4, status: 'no_show' }),
    ].join(';'));

    const linhas = await historico();
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.desfecho).toBe('faltou');
  });

  it('cancelamento sem carimbo conta como avisado, não como em cima da hora', async () => {
    // Agendamento anterior à migração 0039. Reter dinheiro por causa de um
    // registro que a casa não fez seria cobrar pelo próprio buraco.
    await exec(
      agendamento({ id: idDe(11), diasAtras: 7, status: 'cancelled_customer', canceladoHorasAntes: null }),
    );
    expect((await historico())[0]?.desfecho).toBe('cancelou_cedo');
  });

  it('mede o atraso da chegada, e trata chegada ausente como ausência de dado', async () => {
    await exec([
      agendamento({ id: idDe(12), diasAtras: 3, status: 'completed', chegouMinutosDepois: 25 }),
      agendamento({ id: idDe(13), diasAtras: 4, status: 'completed', chegouMinutosDepois: -5 }),
      agendamento({ id: idDe(14), diasAtras: 5, status: 'completed' }),
    ].join(';'));

    const porDia = await historico();
    const atrasos = porDia.map((l) => l.atrasoMinutos);
    expect(atrasos).toContain(25);
    // Chegou antes da hora: zero, nunca negativo.
    expect(atrasos).toContain(0);
    expect(atrasos).toContain(null);
  });

  // -- janela e isolamento -----------------------------------------------------

  it('a consulta não traz o que está fora da janela de doze meses', async () => {
    await exec([
      agendamento({ id: idDe(15), diasAtras: 400, status: 'no_show' }),
      agendamento({ id: idDe(16), diasAtras: 10, status: 'completed' }),
    ].join(';'));

    const linhas = await historico();
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.desfecho).toBe('compareceu');
  });

  it('o histórico de uma barbearia não mexe no score que a outra calcula', async () => {
    /**
     * A mesma pessoa, dois cadastros, duas barbearias. Se o score vazasse, a
     * barbearia B passaria a pedir sinal por causa de faltas que aconteceram na
     * A — e o cliente não teria como saber por quê. É o isolamento de tenant
     * valendo sobre um dado que **parece** ser da pessoa e é da relação.
     */
    await exec([
      agendamento({ id: idDe(17), diasAtras: 5, status: 'no_show', tenant: RIVAL, location: LOCATION_RIVAL, professional: RUAN_RIVAL, customer: CARLOS_NO_RIVAL }),
      agendamento({ id: idDe(18), diasAtras: 6, status: 'no_show', tenant: RIVAL, location: LOCATION_RIVAL, professional: RUAN_RIVAL, customer: CARLOS_NO_RIVAL }),
      agendamento({ id: idDe(19), diasAtras: 7, status: 'no_show', tenant: RIVAL, location: LOCATION_RIVAL, professional: RUAN_RIVAL, customer: CARLOS_NO_RIVAL }),
      agendamento({ id: idDe(20), diasAtras: 8, status: 'completed' }),
      agendamento({ id: idDe(21), diasAtras: 9, status: 'completed' }),
      agendamento({ id: idDe(22), diasAtras: 10, status: 'completed' }),
    ].join(';'));

    const nossa = await confianca();
    expect(nossa.score).toBe(100);
    expect(nossa.considerados).toBe(3);
  });

  // -- override do gerente -----------------------------------------------------

  it('o override do gerente substitui o cálculo, e se identifica', async () => {
    await exec([
      agendamento({ id: idDe(23), diasAtras: 3, status: 'no_show' }),
      agendamento({ id: idDe(24), diasAtras: 4, status: 'no_show' }),
      agendamento({ id: idDe(25), diasAtras: 5, status: 'no_show' }),
    ].join(';'));

    const semOverride = await confianca();
    expect(semOverride.score).toBe(0);
    expect(semOverride.ajustadoAMao).toBe(false);

    await exec(`UPDATE customers
                   SET reliability_override = 100,
                       reliability_override_reason = 'faltou por internação, comprovada na recepção',
                       reliability_override_at = now()
                 WHERE id = '${CARLOS}'`);

    const comOverride = await confianca();
    expect(comOverride.score).toBe(100);
    // Um número que a fórmula não explica precisa poder ser identificado na
    // tela — senão o gerente seguinte não entende por que aquele cliente não
    // paga sinal.
    expect(comOverride.ajustadoAMao).toBe(true);
  });

  it('o override vale mesmo sem o mínimo de histórico', async () => {
    // O mínimo de três protege de estatística rasa, não da decisão de alguém
    // que conheceu o caso.
    await exec(`UPDATE customers
                   SET reliability_override = 10,
                       reliability_override_reason = 'sumiu com a chave da barbearia',
                       reliability_override_at = now()
                 WHERE id = '${CARLOS}'`);

    const resultado = await confianca();
    expect(resultado).toMatchObject({ score: 10, temEfeito: true, ajustadoAMao: true });
  });

  // -- a decisão completa ------------------------------------------------------

  const avaliar = (extra: Partial<Parameters<typeof avaliarSinal>[0]> = {}) =>
    avaliarSinal({
      tenantId: TENANT,
      locationId: LOCATION,
      customerId: CARLOS,
      serviceIds: [CABELO],
      ticketCents: 4900,
      now: AGORA,
      ...extra,
    });

  it('com a política desligada não pede sinal de ninguém', async () => {
    await exec([
      agendamento({ id: idDe(26), diasAtras: 3, status: 'no_show' }),
      agendamento({ id: idDe(27), diasAtras: 4, status: 'no_show' }),
      agendamento({ id: idDe(28), diasAtras: 5, status: 'no_show' }),
      agendamento({ id: idDe(29), diasAtras: 6, status: 'no_show' }),
    ].join(';'));

    expect((await avaliar()).exigido).toBe(false);
  });

  it('quem falta muito paga, e o motivo é o histórico', async () => {
    await ligarSinal();
    await exec([
      agendamento({ id: idDe(30), diasAtras: 3, status: 'no_show' }),
      agendamento({ id: idDe(31), diasAtras: 4, status: 'no_show' }),
      agendamento({ id: idDe(32), diasAtras: 5, status: 'no_show' }),
      agendamento({ id: idDe(33), diasAtras: 6, status: 'no_show' }),
    ].join(';'));

    const decisao = await avaliar();
    expect(decisao).toMatchObject({ exigido: true, motivo: 'score', valorCents: 2000 });
  });

  it('sem cliente identificado não há sinal', async () => {
    /**
     * O balcão marca para quem chegou sem cadastro, e o score de alguém que não
     * existe é o score de ninguém. Cobrar ali seria cobrar de quem a barbearia
     * acabou de conhecer — o oposto do seletivo.
     */
    await ligarSinal();
    expect((await avaliar({ customerId: null })).exigido).toBe(false);
  });

  it('serviço marcado como sempre exige cobra de quem tem histórico bom', async () => {
    await ligarSinal();
    await exec(`UPDATE services SET always_require_deposit = true WHERE id = '${COLORACAO}'`);
    await exec([
      agendamento({ id: idDe(34), diasAtras: 3, status: 'completed' }),
      agendamento({ id: idDe(35), diasAtras: 4, status: 'completed' }),
      agendamento({ id: idDe(36), diasAtras: 5, status: 'completed' }),
      agendamento({ id: idDe(37), diasAtras: 6, status: 'no_show' }),
    ].join(';'));

    // Uma falta em quatro: score 75. Acima do limiar do sinal, abaixo da
    // dispensa — é a faixa em que só o serviço decide.
    const comum = await avaliar({ serviceIds: [CABELO] });
    const caro = await avaliar({ serviceIds: [CABELO, COLORACAO], ticketCents: 24800 });
    expect(comum.exigido).toBe(false);
    expect(caro).toMatchObject({ exigido: true, motivo: 'servico' });
  });

  it('cliente impecável não paga nem no serviço que sempre exige', async () => {
    await ligarSinal();
    await exec(`UPDATE services SET always_require_deposit = true WHERE id = '${COLORACAO}'`);
    await exec(
      [30, 31, 32, 33].map((n, i) =>
        agendamento({ id: idDe(40 + i), diasAtras: n, status: 'completed' }),
      ).join(';'),
    );

    const decisao = await avaliar({ serviceIds: [COLORACAO], ticketCents: 19900 });
    expect(decisao.confianca.score).toBe(100);
    expect(decisao.exigido).toBe(false);
  });

  it('a política de outra unidade não vale para esta', async () => {
    // A do centro cobra; a do bairro, não. Duas unidades, dois movimentos.
    await ligarSinal();
    await exec([
      agendamento({ id: idDe(50), diasAtras: 3, status: 'no_show' }),
      agendamento({ id: idDe(51), diasAtras: 4, status: 'no_show' }),
      agendamento({ id: idDe(52), diasAtras: 5, status: 'no_show' }),
      agendamento({ id: idDe(53), diasAtras: 6, status: 'no_show' }),
    ].join(';'));

    expect((await avaliar()).exigido).toBe(true);
    // A unidade da vizinha não é visível sob a RLS desta barbearia: a política
    // não é encontrada, e o que não é encontrado não cobra.
    expect((await avaliar({ locationId: LOCATION_RIVAL })).exigido).toBe(false);
  });

  // -- a recusa de marcação online em hora cheia (bloco 60) --------------------

  /**
   * A semente sintética: oito semanas de movimento numa hora, para a grade de
   * ocupação existir.
   *
   * Sem ela o heatmap não tem o que medir e **nenhuma hora é de pico** — a
   * recusa nunca dispararia, e o teste ficaria verde provando nada. É o mesmo
   * cuidado da medição, que precisa de conteúdo real para a tela dizer a
   * verdade: aqui o conteúdo é histórico.
   *
   * Cada repetição vai para um profissional diferente, e não para o mesmo com
   * minutos de diferença: a constraint anti-overbooking recusa dois
   * atendimentos que se sobrepõem na mesma cadeira, e ela está certa. Hora cheia
   * de verdade é várias cadeiras ocupadas ao mesmo tempo.
   */
  /**
   * A multidão que enche a hora **não é o cliente do teste**.
   *
   * Usando CARLOS, os dezesseis comparecimentos da semente consertavam a
   * reputação de quem o teste queria ver recusado: três faltas em vinte
   * agendamentos dão score 85, e a recusa nunca disparava. A semente existe
   * para produzir **ocupação**, e ocupação é de outra gente.
   */
  const MULTIDAO = 'cccccccc-0000-0000-0000-000000000009';

  async function encherAHora(alvo: Date): Promise<void> {
    await admin.$executeRawUnsafe(
      `INSERT INTO customers (id, tenant_id, name, phone_e164)
       VALUES ($1::uuid, $2::uuid, 'Gente que enche a hora', '+5571900000009')
       ON CONFLICT DO NOTHING`,
      MULTIDAO,
      TENANT,
    );
    /**
     * As oito semanas **anteriores ao mesmo instante**, e não uma data montada
     * com dia da semana e hora.
     *
     * A primeira versão calculava `date_trunc('week') + dias + horas` em UTC e
     * o produto lê a hora **no fuso da unidade**: a semente enchia as onze da
     * manhã e o teste perguntava pelas duas da tarde. Subtraindo semanas do
     * próprio instante que o teste consulta, não há aritmética de fuso para
     * errar — e é o mesmo instante nos dois lados.
     */
    await admin.$executeRawUnsafe(
      `INSERT INTO appointments
         (tenant_id, location_id, professional_id, customer_id, status,
          starts_at, ends_at, service_starts_at, service_ends_at)
       SELECT $1::uuid, $2::uuid, p.id, $3::uuid, 'completed',
              d.quando, d.quando + interval '50 minutes',
              d.quando, d.quando + interval '50 minutes'
         FROM generate_series(1, 8) AS semana,
              LATERAL (SELECT $4::timestamptz - (semana || ' weeks')::interval AS quando) AS d,
              LATERAL (
                SELECT id FROM professionals
                 WHERE location_id = $2::uuid AND active ORDER BY created_at
              ) AS p`,
      TENANT,
      LOCATION,
      MULTIDAO,
      alvo,
    );
  }

  /** Terça, duas da tarde no fuso da unidade. */
  const TERCA_CHEIA = new Date('2026-08-11T17:00:00Z');

  it('a hora só vira de pico depois de movimento medido, e não antes', async () => {
    /**
     * O pico é derivado do movimento (bloco 57), nunca cadastrado. Este teste
     * prova que a semente sintética produz o que a regra do bloco 60 consome —
     * sem ele, "nenhuma hora é de pico" faria toda a recusa passar verde sem
     * nunca disparar.
     */
    expect(await withTenant(TENANT, (tx) => horaCheia(tx, LOCATION, TERCA_CHEIA, AGORA))).toBe(false);

    await encherAHora(TERCA_CHEIA);
    expect(await withTenant(TENANT, (tx) => horaCheia(tx, LOCATION, TERCA_CHEIA, AGORA))).toBe(true);
  });

  it('quem falta muito não marca sozinho na hora cheia, e o balcão marca', async () => {
    await encherAHora(TERCA_CHEIA);
    await exec(`UPDATE locations SET online_block_score = 40 WHERE id = '${LOCATION}'`);
    await exec([
      agendamento({ id: idDe(70), diasAtras: 3, status: 'no_show' }),
      agendamento({ id: idDe(71), diasAtras: 4, status: 'no_show' }),
      agendamento({ id: idDe(72), diasAtras: 5, status: 'no_show' }),
      agendamento({ id: idDe(73), diasAtras: 6, status: 'completed' }),
    ].join(';'));

    const pedido = {
      locationId: LOCATION,
      customerId: CARLOS,
      comecaEm: TERCA_CHEIA,
      now: AGORA,
    };

    const online = await withTenant(TENANT, (tx) =>
      conferirMarcacaoOnline(tx, { ...pedido, peloBalcao: false }),
    );
    expect(online.pode).toBe(false);

    // "só recepção": o canal decide, e a pessoa continua sendo atendida.
    const balcao = await withTenant(TENANT, (tx) =>
      conferirMarcacaoOnline(tx, { ...pedido, peloBalcao: true }),
    );
    expect(balcao.pode).toBe(true);
  });

  it('fora da hora cheia a mesma pessoa marca sozinha', async () => {
    await encherAHora(TERCA_CHEIA);
    await exec(`UPDATE locations SET online_block_score = 40 WHERE id = '${LOCATION}'`);
    await exec([
      agendamento({ id: idDe(80), diasAtras: 3, status: 'no_show' }),
      agendamento({ id: idDe(81), diasAtras: 4, status: 'no_show' }),
      agendamento({ id: idDe(82), diasAtras: 5, status: 'no_show' }),
    ].join(';'));

    // Sete da manhã de terça: a semente encheu as duas da tarde.
    const terca7h = new Date('2026-08-11T10:00:00Z');
    const fora = await withTenant(TENANT, (tx) =>
      conferirMarcacaoOnline(tx, {
        locationId: LOCATION,
        customerId: CARLOS,
        comecaEm: terca7h,
        peloBalcao: false,
        now: AGORA,
      }),
    );
    expect(fora.pode).toBe(true);
  });

  it('desligado é o padrão, e desligado não recusa ninguém', async () => {
    await encherAHora(TERCA_CHEIA);
    await exec([
      agendamento({ id: idDe(90), diasAtras: 3, status: 'no_show' }),
      agendamento({ id: idDe(91), diasAtras: 4, status: 'no_show' }),
      agendamento({ id: idDe(92), diasAtras: 5, status: 'no_show' }),
    ].join(';'));

    const desligado = await withTenant(TENANT, (tx) =>
      conferirMarcacaoOnline(tx, {
        locationId: LOCATION,
        customerId: CARLOS,
        comecaEm: TERCA_CHEIA,
        peloBalcao: false,
        now: AGORA,
      }),
    );
    expect(desligado.pode).toBe(true);
  });

  it('remarcar não é a porta dos fundos da recusa', async () => {
    /**
     * Achado da `/security-review` do bloco 60, e o caminho era o normal da
     * tela: marcar uma hora vazia, remarcar para a cheia, ficar com ela. Dois
     * cliques, sem requisição forjada — e a lista de recusas mostrava "duas"
     * enquanto as mesmas pessoas ocupavam o pico.
     */
    await encherAHora(TERCA_CHEIA);
    await exec(`UPDATE locations SET online_block_score = 40 WHERE id = '${LOCATION}'`);
    await exec([
      agendamento({ id: idDe(60), diasAtras: 3, status: 'no_show' }),
      agendamento({ id: idDe(61), diasAtras: 4, status: 'no_show' }),
      agendamento({ id: idDe(62), diasAtras: 5, status: 'no_show' }),
    ].join(';'));

    const naHoraCheia = await withTenant(TENANT, (tx) =>
      conferirMarcacaoOnline(tx, {
        locationId: LOCATION,
        customerId: CARLOS,
        comecaEm: TERCA_CHEIA,
        peloBalcao: false,
        now: AGORA,
      }),
    );
    expect(naHoraCheia.pode).toBe(false);
  });

  it('a lista de recusas não devolve o score nem o limiar', async () => {
    /**
     * Ler o score é `finance.deposit` desde o bloco 37, e esta rota é
     * `appointments.view` + `customers.view` — que a recepção e o barbeiro têm.
     * Nenhuma tela mostrava os dois campos: eles estavam sendo enviados para
     * ninguém. Achado da `/security-review`.
     */
    await exec(
      `INSERT INTO online_blocks (tenant_id, location_id, customer_id, score, threshold, wanted_at)
       VALUES ('${TENANT}', '${LOCATION}', '${CARLOS}', 12, 40, now())`,
    );

    const lista = await recusasRecentes(TENANT);
    expect(lista).toHaveLength(1);
    expect(Object.keys(lista[0] ?? {})).toEqual(['id', 'clienteNome', 'quando', 'queria']);
  });

  it('o override manual vale na lista de espera, e não só no sinal', async () => {
    /**
     * Sem isto o mesmo cliente tinha **dois scores** conforme a consequência: o
     * gerente zerava a reputação de quem sumiu com a chave da barbearia e a
     * pessoa continuava furando a fila, porque o histórico calculado estava
     * limpo. Duas fontes de verdade para o mesmo número.
     */
    await exec(
      // A CHECK do bloco 39 exige motivo escrito **e** carimbo: override sem os
      // dois é um número que ninguém consegue defender seis meses depois.
      `UPDATE customers SET reliability_override = 10,
                            reliability_override_reason = 'sumiu com a chave da barbearia',
                            reliability_override_at = now()
        WHERE id = '${CARLOS}'`,
    );

    const mapa = await withTenant(TENANT, (tx) => confiancaDeVarios(tx, [CARLOS], AGORA));
    expect(mapa.get(CARLOS)).toMatchObject({ score: 10, temEfeito: true });
  });
});
