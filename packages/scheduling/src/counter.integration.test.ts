import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getCounterCatalog, searchCustomers } from './counter.js';
import { getAvailabilityRange } from './service.js';
import { createAppointment } from './booking.js';

/**
 * Busca de cliente no balcão.
 *
 * O que se prova aqui: que a busca acha pelo pedaço que a recepção digita, que
 * ela não devolve a base para quem digita pouco (ou curinga), e que não
 * atravessa a parede entre barbearias.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];

const TENANT = '11111111-1111-1111-1111-111111111111';
const RIVAL = '22222222-2222-2222-2222-222222222222';
const LOCATION = 'aaaaaaaa-0000-0000-0000-000000000001';
const RUAN = 'bbbbbbbb-0000-0000-0000-000000000001';
const JOAO = 'cccccccc-0000-0000-0000-000000000001';

let admin: PrismaClient;

const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

async function exec(client: PrismaClient, sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await client.$executeRawUnsafe(parte);
  }
}

describeIfDb('balcão — busca de cliente', () => {
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

      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('${LOCATION}', '${TENANT}', 'Matriz', 'America/Bahia');

      INSERT INTO professionals (id, tenant_id, location_id, name, kind)
      VALUES ('${RUAN}', '${TENANT}', '${LOCATION}', 'Ruan Nascimento', 'professional');

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes)
      VALUES ('eeeeeeee-0000-0000-0000-000000000001', '${TENANT}', 'Cabelo', 4900, 20);

      INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
        ('${JOAO}', '${TENANT}', 'João da Silva', '+5571988887777'),
        ('cccccccc-0000-0000-0000-000000000002', '${TENANT}', 'Maria Silveira', '+5571977776666'),
        ('cccccccc-0000-0000-0000-000000000003', '${TENANT}', 'Pedro Souza', '+5571966665555');

      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('cccccccc-0000-0000-0000-000000000009', '${RIVAL}', 'João do Rival', '+5571955554444');
    `);
  });

  const buscar = (query: string) => searchCustomers({ tenantId: TENANT, query });

  it('acha pelo trecho do nome, não só pelo começo', async () => {
    // A recepção conhece o cliente pelo sobrenome. Busca por prefixo erraria
    // exatamente o caso mais comum.
    const achados = await buscar('silva');
    expect(achados.map((c) => c.name)).toEqual(['João da Silva']);
  });

  it('acha sem acento e sem caixa, do jeito que se digita com pressa', async () => {
    // No Brasil metade dos nomes tem acento e ninguém o digita no balcão. Uma
    // busca que exige "João" não acha o cliente que está de pé na frente da
    // recepcionista.
    for (const digitado of ['JOAO', 'joao', 'João', 'da silva']) {
      const achados = await buscar(digitado);
      expect(achados.map((c) => c.name), `busca por "${digitado}"`).toEqual([
        'João da Silva',
      ]);
    }
  });

  it('acha pelos últimos dígitos do celular', async () => {
    // Ninguém dita o DDI. O que a pessoa fala são os quatro últimos.
    const achados = await buscar('7777');
    expect(achados.map((c) => c.id)).toEqual([JOAO]);
  });

  it('acha pelo número digitado com máscara', async () => {
    const achados = await buscar('(71) 98888-7777');
    expect(achados.map((c) => c.id)).toEqual([JOAO]);
  });

  it('nunca devolve o telefone inteiro', async () => {
    // A tela do balcão fica virada para o salão. O número completo na lista é
    // dado pessoal exposto a quem passar na frente do notebook.
    const achados = await buscar('silva');
    expect(achados[0]?.phoneMasked).toBe('+55719****7777');
    expect(JSON.stringify(achados)).not.toContain('+5571988887777');
  });

  it('cadastro anonimizado não é achável no balcão, nem por nome', async () => {
    /**
     * Bloco 32. A anonimização corta o vínculo com a pessoa — e a busca do
     * balcão é a única tela onde esse vínculo é usado todo dia.
     *
     * O apelido (`cliente_anonimizado_xxxx`) não bate com "silva", mas o teste
     * não confia nisso: ele procura pelo **apelido**, que é o termo que
     * realmente encontraria a linha se o filtro não existisse. E o telefone
     * ficou nulo, então a busca por dígitos já não alcança — o que este caso
     * prova é a outra metade, a do nome.
     */
    await exec(admin, `
      UPDATE customers
         SET name = 'cliente_anonimizado_cccc', phone_e164 = NULL, anonymized_at = now()
       WHERE id = '${JOAO}'
    `);

    expect(await buscar('anonimizado')).toHaveLength(0);

    // E os outros continuam sendo achados: o filtro é sobre a linha apagada,
    // não sobre a consulta inteira.
    const outros = await buscar('silv');
    expect(outros.map((c) => c.name)).toEqual(['Maria Silveira']);
  });

  it('não lista a base para quem digita pouco', async () => {
    expect(await buscar('jo')).toEqual([]);
    expect(await buscar('')).toEqual([]);
  });

  it('curinga não vira listagem completa', async () => {
    // `%` sem escape casaria com tudo — a base de clientes entregue por uma
    // tecla.
    expect(await buscar('%%%')).toEqual([]);
    expect(await buscar('___')).toEqual([]);
  });

  it('curinga de largura inteira também não vira listagem completa', async () => {
    // O buraco que o escape em JavaScript deixava passar: `unaccent` converte
    // `％` (U+FF05) em `%` **depois** do escape, e o padrão virava `%%%%%`.
    // Escapar antes de uma transformação que produz o caractere escapado não
    // protege nada.
    expect(await buscar('％％％'), 'porcentagem de largura inteira').toEqual([]);
    expect(await buscar('＿＿＿'), 'sublinhado de largura inteira').toEqual([]);
    expect(await buscar('％a％'), 'curinga em volta de uma letra').toEqual([]);
  });

  it('termo terminado em barra não quebra a consulta', async () => {
    // `＼` vira `\` pelo mesmo caminho. Sem o `ESCAPE` explícito, o padrão
    // termina com escape pendurado e o Postgres recusa com 22025 — a busca
    // viraria erro genérico na tela em vez de "ninguém encontrado".
    await expect(buscar('silva＼')).resolves.toEqual([]);
    await expect(buscar('silva\\')).resolves.toEqual([]);
  });

  it('não atravessa a parede entre barbearias', async () => {
    const achados = await buscar('João');
    expect(achados.map((c) => c.name)).toEqual(['João da Silva']);
  });

  it('mostra a última visita e quantas vezes faltou', async () => {
    // É o que faz a recepção pedir confirmação antes de segurar o horário.
    await exec(admin, `
      INSERT INTO appointments
        (tenant_id, location_id, customer_id, professional_id,
         starts_at, ends_at, service_starts_at, service_ends_at, status, price_cents)
      VALUES
        ('${TENANT}', '${LOCATION}', '${JOAO}', '${RUAN}',
         '2026-07-01T12:00:00Z', '2026-07-01T12:20:00Z',
         '2026-07-01T12:00:00Z', '2026-07-01T12:20:00Z', 'completed', 4900),
        ('${TENANT}', '${LOCATION}', '${JOAO}', '${RUAN}',
         '2026-07-08T12:00:00Z', '2026-07-08T12:20:00Z',
         '2026-07-08T12:00:00Z', '2026-07-08T12:20:00Z', 'no_show', 4900);
    `);

    const achados = await buscar('silva');
    expect(achados[0]?.lastVisitAt).toBe('2026-07-01T12:00:00.000Z');
    expect(achados[0]?.noShows).toBe(1);
    // O cancelado e o futuro não contam como visita.
    expect(achados[0]?.lastVisitAt).not.toBe('2026-07-08T12:00:00.000Z');
  });

  it('catálogo do balcão traz só o que está ativo', async () => {
    await exec(admin, `
      INSERT INTO services (tenant_id, name, price_cents, duration_minutes, active)
      VALUES ('${TENANT}', 'Serviço desativado', 1000, 10, false);

      INSERT INTO professionals (tenant_id, location_id, name, kind, active)
      VALUES ('${TENANT}', '${LOCATION}', 'Ex-barbeiro', 'professional', false);
    `);

    const catalogo = await getCounterCatalog(TENANT, LOCATION);
    expect(catalogo.services.map((s) => s.name)).toEqual(['Cabelo']);
    expect(catalogo.professionals.map((p) => p.name)).toEqual(['Ruan Nascimento']);
  });
});

/**
 * A grade do balcão e a do site são a mesma coisa com uma diferença: as guardas
 * de autoatendimento. Aqui o relógio entra por parâmetro, então a prova não
 * depende da hora em que a suíte roda.
 */
describeIfDb('balcão — o que a antecedência mínima não alcança', () => {
  const CABELO = 'eeeeeeee-0000-0000-0000-000000000001';
  // Terça-feira, 09:00 na barbearia (America/Bahia, UTC-3) = 12:00 UTC.
  const TERCA = '2026-08-11';
  const NOVE_DA_MANHA = new Date('2026-08-11T12:00:00Z');

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
      INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Domari');

      -- 12 horas de antecedência mínima: nenhum horário de hoje sobra no site.
      INSERT INTO locations (id, tenant_id, name, timezone, granularity_minutes,
                             min_lead_minutes, max_lead_days)
      VALUES ('${LOCATION}', '${TENANT}', 'Matriz', 'America/Bahia', 20, 720, 30);

      INSERT INTO professionals (id, tenant_id, location_id, name, kind)
      VALUES ('${RUAN}', '${TENANT}', '${LOCATION}', 'Ruan Nascimento', 'professional');

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes)
      VALUES ('${CABELO}', '${TENANT}', 'Cabelo', 4900, 20);

      INSERT INTO professional_services (professional_id, service_id, tenant_id)
      VALUES ('${RUAN}', '${CABELO}', '${TENANT}');

      INSERT INTO work_schedules (tenant_id, professional_id, weekday, start_minute, end_minute)
      SELECT '${TENANT}', '${RUAN}', d.weekday, 480, 1200
      FROM (VALUES (0), (1), (2), (3), (4), (5), (6)) AS d(weekday);
    `);
  });

  const grade = (atCounter: boolean, date = TERCA) =>
    getAvailabilityRange({
      tenantId: TENANT,
      locationId: LOCATION,
      serviceIds: [CABELO],
      professionalId: RUAN,
      dateFrom: date,
      now: NOVE_DA_MANHA,
      ...(atCounter ? { atCounter: true } : {}),
    });

  it('o site não oferece o resto do dia; o balcão oferece', async () => {
    const site = await grade(false);
    expect(site.days[0]?.slots).toEqual([]);
    expect(site.days[0]?.unavailableReason).toBe('past_cutoff');

    const balcao = await grade(true);
    expect(balcao.days[0]?.slots.length).toBeGreaterThan(0);
    expect(balcao.days[0]?.slots[0]?.start).toBe('09:00');
  });

  it('o balcão também não oferece o que já passou', async () => {
    // Desligar a antecedência não é desligar o relógio: 08:00 já foi.
    const balcao = await grade(true);
    expect(balcao.days[0]?.slots.map((s) => s.start)).not.toContain('08:00');
  });

  it('a gravação aceita o que a grade do balcão ofereceu', async () => {
    // A recusa que este teste guarda é a pior de todas: a tela oferece, o
    // operador clica com o cliente na frente, e o servidor diz não.
    const balcao = await grade(true);
    const horario = balcao.days[0]?.slots[0]?.start;
    expect(horario).toBeDefined();

    await expect(
      createAppointment({
        tenantId: TENANT,
        locationId: LOCATION,
        professionalId: RUAN,
        serviceIds: [CABELO],
        date: TERCA,
        start: horario as string,
        source: 'reception',
        atCounter: true,
        now: NOVE_DA_MANHA,
      }),
    ).resolves.toMatchObject({ status: 'pending' });
  });

  it('sem o balcão, a mesma gravação é recusada', async () => {
    await expect(
      createAppointment({
        tenantId: TENANT,
        locationId: LOCATION,
        professionalId: RUAN,
        serviceIds: [CABELO],
        date: TERCA,
        start: '09:00',
        now: NOVE_DA_MANHA,
      }),
    ).rejects.toMatchObject({ code: 'slot_not_available' });
  });

  it('o balcão marca além da janela de agendamento do site', async () => {
    // O cliente fiel marca o Natal em julho, na recepção. A janela de 30 dias
    // existe para o site não encher a agenda de meses à frente.
    const longe = '2026-10-06'; // terça, 56 dias à frente

    const site = await grade(false, longe);
    expect(site.days[0]?.unavailableReason).toBe('beyond_booking_window');

    const balcao = await grade(true, longe);
    expect(balcao.days[0]?.slots.length).toBeGreaterThan(0);
  });
});
