import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  conflitosDaJornada,
  createProfessional,
  createService,
  getSchedule,
  listProfessionals,
  listResources,
  listServices,
  saveResources,
  saveSchedule,
  setProfessionalActive,
  setServiceActive,
  setServiceResources,
  updateProfessional,
  updateService,
} from './index.js';

/**
 * CRUD do admin, contra Postgres real.
 *
 * O que se prova aqui: que editar **não recria linha** — porque recriar deixaria
 * todo agendamento existente apontando para um cadastro morto —, que a incoerência
 * de combo é barrada também na edição, e que encolher jornada avisa antes em vez
 * de descobrir pelo cliente que apareceu e não tinha barbeiro.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];

const TENANT = '11111111-1111-1111-1111-111111111111';
const RIVAL = '22222222-2222-2222-2222-222222222222';
const LOCATION = 'aaaaaaaa-0000-0000-0000-000000000001';
const RUAN = 'bbbbbbbb-0000-0000-0000-000000000001';
const LOCAL_RIVAL = 'aaaaaaaa-0000-0000-0000-000000000002';
const PRO_RIVAL = 'bbbbbbbb-0000-0000-0000-000000000002';

let admin: PrismaClient;

const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

async function exec(client: PrismaClient, sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await client.$executeRawUnsafe(parte);
  }
}

const corte = {
  name: 'Corte',
  categoryName: 'Cabelo',
  priceCents: 4900,
  durationMinutes: 30,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 5,
  bookableOnline: true,
};

describeIfDb('CRUD do catálogo', () => {
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

      INSERT INTO locations (id, tenant_id, name, timezone, granularity_minutes)
      VALUES ('${LOCATION}', '${TENANT}', 'Matriz', 'America/Bahia', 15);

      INSERT INTO locations (id, tenant_id, name, timezone, granularity_minutes)
      VALUES ('${LOCAL_RIVAL}', '${RIVAL}', 'Rival', 'America/Bahia', 15);

      INSERT INTO professionals (id, tenant_id, location_id, name, kind)
      VALUES ('${RUAN}', '${TENANT}', '${LOCATION}', 'Ruan', 'professional'),
             ('${PRO_RIVAL}', '${RIVAL}', '${LOCAL_RIVAL}', 'Barbeiro do rival', 'professional');
    `);
  });

  // -- catálogo --------------------------------------------------------------

  it('editar mantém o mesmo id, e é isso que salva o histórico', async () => {
    // `saveServices` do onboarding desativa tudo e recria: reenviar os nove
    // serviços para mudar um preço criaria ids novos para os oito que não
    // mudaram, e todo agendamento existente apontaria para um serviço morto.
    const { id } = await createService(TENANT, corte);

    await updateService(TENANT, id, { ...corte, priceCents: 5500, name: 'Corte na tesoura' });

    const { services } = await listServices(TENANT);
    expect(services).toHaveLength(1);
    expect(services[0]?.id).toBe(id);
    expect(services[0]?.priceCents).toBe(5500);
    expect(services[0]?.name).toBe('Corte na tesoura');
  });

  it('editar um serviço não apaga a exigência de sinal em silêncio', async () => {
    /**
     * O campo é opcional na borda e a tela de cardápio anterior não o manda.
     * Escrevendo `false` quando ele falta, corrigir uma descrição apagaria a
     * exigência de sinal da coloração — o serviço em que a falta custa a tarde
     * inteira, e o único que a barbearia marcou de propósito.
     *
     * Achado da `/security-review` do bloco 37: fail-open num controle de
     * receita, sem ninguém ficar sabendo.
     */
    const { id } = await createService(TENANT, { ...corte, alwaysRequireDeposit: true });

    await updateService(TENANT, id, { ...corte, description: 'Agora com toalha quente' });

    const depois = (await listServices(TENANT)).services.find((s) => s.id === id);
    expect(depois?.alwaysRequireDeposit).toBe(true);

    // E desligar continua sendo possível — o que muda é que precisa ser dito.
    await updateService(TENANT, id, { ...corte, alwaysRequireDeposit: false });
    const desligado = (await listServices(TENANT)).services.find((s) => s.id === id);
    expect(desligado?.alwaysRequireDeposit).toBe(false);
  });

  it('mudar o preço não reescreve o que já foi vendido', async () => {
    // `appointment_services` guarda o praticado no momento da reserva. A prova
    // de que o passado sobrevive é o id continuar o mesmo.
    const { id } = await createService(TENANT, corte);
    await exec(admin, `
      INSERT INTO appointments
        (id, tenant_id, location_id, professional_id,
         starts_at, ends_at, service_starts_at, service_ends_at, status, price_cents)
      VALUES ('dddddddd-0000-0000-0000-000000000001', '${TENANT}', '${LOCATION}', '${RUAN}',
              '2026-07-01T12:00:00Z', '2026-07-01T12:30:00Z',
              '2026-07-01T12:00:00Z', '2026-07-01T12:30:00Z', 'completed', 4900);

      INSERT INTO appointment_services
        (appointment_id, service_id, tenant_id, position, price_cents, duration_minutes)
      VALUES ('dddddddd-0000-0000-0000-000000000001', '${id}', '${TENANT}', 0, 4900, 30);
    `);

    await updateService(TENANT, id, { ...corte, priceCents: 9900 });

    const vendido = await admin.$queryRawUnsafe<{ price_cents: number }[]>(
      `SELECT price_cents FROM appointment_services WHERE service_id = '${id}'`,
    );
    expect(vendido[0]?.price_cents).toBe(4900);
  });

  it('desativar tira da grade sem apagar, e diz quantos já estão marcados', async () => {
    const { id } = await createService(TENANT, corte);
    await exec(admin, `
      INSERT INTO appointments
        (id, tenant_id, location_id, professional_id,
         starts_at, ends_at, service_starts_at, service_ends_at, status, price_cents)
      VALUES ('dddddddd-0000-0000-0000-000000000002', '${TENANT}', '${LOCATION}', '${RUAN}',
              '2099-07-01T12:00:00Z', '2099-07-01T12:30:00Z',
              '2099-07-01T12:00:00Z', '2099-07-01T12:30:00Z', 'pending', 4900);

      INSERT INTO appointment_services
        (appointment_id, service_id, tenant_id, position, price_cents, duration_minutes)
      VALUES ('dddddddd-0000-0000-0000-000000000002', '${id}', '${TENANT}', 0, 4900, 30);
    `);

    // Desativar não cancela nada: quem já marcou continua marcado, e é a
    // recepção que decide o que fazer com essa lista.
    const { futureAppointments } = await setServiceActive(TENANT, id, false);
    expect(futureAppointments).toBe(1);

    const { services } = await listServices(TENANT);
    expect(services[0]?.active).toBe(false);
    expect(services).toHaveLength(1);
  });

  it('serviço novo já nasce habilitado para quem faz tudo', async () => {
    // Sem isto ele some da grade e o dono descobre pela reclamação de que "o
    // site não deixa marcar".
    const { id } = await createService(TENANT, corte);

    const habilidades = await admin.$queryRawUnsafe<{ total: bigint }[]>(
      `SELECT count(*) AS total FROM professional_services WHERE service_id = '${id}'`,
    );
    expect(Number(habilidades[0]?.total)).toBe(1);
  });

  // -- combo -----------------------------------------------------------------

  it('recusa combo mais curto que a soma das partes', async () => {
    const cabelo = await createService(TENANT, corte);
    const barba = await createService(TENANT, {
      ...corte,
      name: 'Barba',
      durationMinutes: 25,
      priceCents: 3500,
    });

    await expect(
      createService(TENANT, {
        ...corte,
        name: 'Corte + Barba',
        durationMinutes: 40,
        priceCents: 7000,
        componentIds: [cabelo.id, barba.id],
      }),
    ).rejects.toMatchObject({ code: 'invalid_catalog' });
  });

  it('alongar uma parte torna o combo incoerente, e a edição barra', async () => {
    // O caso que a validação só no formulário deixaria passar: ninguém abre a
    // tela do combo para mudar a duração da barba. É o defeito D4 barrado na
    // edição, não só no cadastro.
    const cabelo = await createService(TENANT, corte);
    const barba = await createService(TENANT, {
      ...corte,
      name: 'Barba',
      durationMinutes: 25,
      priceCents: 3500,
    });
    await createService(TENANT, {
      ...corte,
      name: 'Corte + Barba',
      durationMinutes: 55,
      priceCents: 7000,
      componentIds: [cabelo.id, barba.id],
    });

    await expect(
      updateService(TENANT, barba.id, { ...corte, name: 'Barba', durationMinutes: 45, priceCents: 3500 }),
    ).rejects.toMatchObject({ code: 'invalid_catalog' });
  });

  it('renomear o combo leva o vínculo junto', async () => {
    // O combo é ligado ao serviço pelo nome; sem levar, o antigo fica órfão e o
    // novo nunca existe — e o combo some da grade sem aviso.
    const cabelo = await createService(TENANT, corte);
    const barba = await createService(TENANT, {
      ...corte, name: 'Barba', durationMinutes: 25, priceCents: 3500,
    });
    const combo = await createService(TENANT, {
      ...corte, name: 'Corte + Barba', durationMinutes: 55, priceCents: 7000,
      componentIds: [cabelo.id, barba.id],
    });

    await updateService(TENANT, combo.id, {
      ...corte, name: 'O Completo', durationMinutes: 55, priceCents: 7000,
      componentIds: [cabelo.id, barba.id],
    });

    const { services } = await listServices(TENANT);
    const renomeado = services.find((s) => s.name === 'O Completo');
    expect(renomeado?.componentIds).toHaveLength(2);

    const orfaos = await admin.$queryRawUnsafe<{ total: bigint }[]>(
      `SELECT count(*) AS total FROM service_combos WHERE name = 'Corte + Barba'`,
    );
    expect(Number(orfaos[0]?.total)).toBe(0);
  });

  // -- equipe ----------------------------------------------------------------

  it('editar profissional mantém o id', async () => {
    // `saveProfessionals` do onboarding desativa a equipe inteira e insere de
    // novo: adicionar um barbeiro deixaria os agendamentos dos outros apontando
    // para cadastros inativos.
    await createService(TENANT, corte);
    const { id } = await createProfessional(TENANT, LOCATION, {
      name: 'Gleidson',
      kind: 'professional',
      bookableOnline: true,
    });

    await updateProfessional(TENANT, LOCATION, id, {
      name: 'Gleidson Araújo',
      kind: 'professional',
      bookableOnline: false,
      bio: 'Tesoura e navalha.',
    });

    const equipe = await listProfessionals(TENANT, LOCATION);
    const dele = equipe.find((p) => p.id === id);
    expect(dele?.name).toBe('Gleidson Araújo');
    expect(dele?.bookableOnline).toBe(false);
    // E o Ruan da semente continua lá, ativo.
    expect(equipe.filter((p) => p.active)).toHaveLength(2);
  });

  it('habilidade vazia significa faz tudo, e é gravada como tudo', async () => {
    // A grade lê `professional_services`; ausência de linha significa "não
    // executa", não "executa tudo".
    await createService(TENANT, corte);
    await createService(TENANT, { ...corte, name: 'Barba' });

    const { id } = await createProfessional(TENANT, LOCATION, {
      name: 'Gleidson', kind: 'professional', bookableOnline: true,
    });

    const equipe = await listProfessionals(TENANT, LOCATION);
    expect(equipe.find((p) => p.id === id)?.serviceIds).toHaveLength(2);
  });

  it('desligar profissional devolve os agendamentos que ficam sem dono', async () => {
    await exec(admin, `
      INSERT INTO appointments
        (tenant_id, location_id, professional_id,
         starts_at, ends_at, service_starts_at, service_ends_at, status, price_cents)
      VALUES ('${TENANT}', '${LOCATION}', '${RUAN}',
              '2099-07-01T12:00:00Z', '2099-07-01T12:30:00Z',
              '2099-07-01T12:00:00Z', '2099-07-01T12:30:00Z', 'confirmed', 4900);
    `);

    const { futuros } = await setProfessionalActive({
      podeVerCliente: true,
      tenantId: TENANT, locationId: LOCATION, professionalId: RUAN, active: false,
    });

    // Desativar não cancela: o cliente marcou com essa pessoa, e alguém tem que
    // decidir se remarca ou avisa.
    expect(futuros).toHaveLength(1);
    expect(futuros[0]?.time).toBe('09:00');
  });

  // -- jornada ---------------------------------------------------------------

  it('cada pessoa tem a própria jornada', async () => {
    // O onboarding aplica a mesma para toda a equipe — foi lacuna declarada
    // desde o bloco 10.
    const gleidson = await createProfessional(TENANT, LOCATION, {
      name: 'Gleidson', kind: 'professional', bookableOnline: true,
    });

    await saveSchedule({
      tenantId: TENANT,
      locationId: LOCATION,
      professionalId: RUAN,
      faixas: [{ weekday: 2, startMinute: 420, endMinute: 1080, breaks: [] }],
    });
    await saveSchedule({
      tenantId: TENANT,
      locationId: LOCATION,
      professionalId: gleidson.id,
      faixas: [{ weekday: 3, startMinute: 600, endMinute: 1200, breaks: [{ start: 720, end: 780 }] }],
    });

    const doRuan = await getSchedule(TENANT, LOCATION, RUAN);
    expect(doRuan).toEqual([{ weekday: 2, startMinute: 420, endMinute: 1080, breaks: [] }]);

    const doGleidson = await getSchedule(TENANT, LOCATION, gleidson.id);
    expect(doGleidson[0]?.weekday).toBe(3);
    expect(doGleidson[0]?.breaks).toEqual([{ start: 720, end: 780 }]);
  });

  it('encolher a jornada avisa quais horários ficam de fora', async () => {
    // Encolher a terça de 09–18 para 09–12 não cancela o corte das 15h: ele
    // continua no banco e some da grade. Sem o aviso, o dono descobre pelo
    // cliente que apareceu e não tinha barbeiro.
    await exec(admin, `
      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('cccccccc-0000-0000-0000-000000000001', '${TENANT}', 'João da Silva', '+5571988887777');

      INSERT INTO appointments
        (tenant_id, location_id, professional_id, customer_id,
         starts_at, ends_at, service_starts_at, service_ends_at, status, price_cents)
      VALUES
        -- terça, 15:00 local (18:00 UTC)
        ('${TENANT}', '${LOCATION}', '${RUAN}', 'cccccccc-0000-0000-0000-000000000001',
         '2099-08-11T18:00:00Z', '2099-08-11T18:30:00Z',
         '2099-08-11T18:00:00Z', '2099-08-11T18:30:00Z', 'confirmed', 4900),
        -- terça, 10:00 local: continua cabendo
        ('${TENANT}', '${LOCATION}', '${RUAN}', 'cccccccc-0000-0000-0000-000000000001',
         '2099-08-11T13:00:00Z', '2099-08-11T13:30:00Z',
         '2099-08-11T13:00:00Z', '2099-08-11T13:30:00Z', 'confirmed', 4900);
    `);

    const fora = await conflitosDaJornada({
      podeVerCliente: true,
      tenantId: TENANT,
      locationId: LOCATION,
      professionalId: RUAN,
      faixas: [{ weekday: 2, startMinute: 540, endMinute: 720, breaks: [] }],
    });

    expect(fora).toHaveLength(1);
    expect(fora[0]?.time).toBe('15:00');
    expect(fora[0]?.customerName).toBe('João da Silva');
  });

  it('o fim do atendimento também precisa caber', async () => {
    // Um corte que começa às 11:50 e termina 12:20 não cabe numa jornada que
    // fecha ao meio-dia, mesmo com o início dentro.
    await exec(admin, `
      INSERT INTO appointments
        (tenant_id, location_id, professional_id,
         starts_at, ends_at, service_starts_at, service_ends_at, status, price_cents)
      VALUES ('${TENANT}', '${LOCATION}', '${RUAN}',
              '2099-08-11T14:50:00Z', '2099-08-11T15:20:00Z',
              '2099-08-11T14:50:00Z', '2099-08-11T15:20:00Z', 'confirmed', 4900);
    `);

    const fora = await conflitosDaJornada({
      podeVerCliente: true,
      tenantId: TENANT,
      locationId: LOCATION,
      professionalId: RUAN,
      faixas: [{ weekday: 2, startMinute: 540, endMinute: 720, breaks: [] }],
    });
    expect(fora).toHaveLength(1);
    expect(fora[0]?.time).toBe('11:50');
  });

  it('intervalo no meio do dia também descobre horário', async () => {
    await exec(admin, `
      INSERT INTO appointments
        (tenant_id, location_id, professional_id,
         starts_at, ends_at, service_starts_at, service_ends_at, status, price_cents)
      VALUES ('${TENANT}', '${LOCATION}', '${RUAN}',
              '2099-08-11T15:30:00Z', '2099-08-11T16:00:00Z',
              '2099-08-11T15:30:00Z', '2099-08-11T16:00:00Z', 'confirmed', 4900);
    `);

    // 12:30 local cai dentro do almoço proposto.
    const fora = await conflitosDaJornada({
      podeVerCliente: true,
      tenantId: TENANT,
      locationId: LOCATION,
      professionalId: RUAN,
      faixas: [
        { weekday: 2, startMinute: 540, endMinute: 1080, breaks: [{ start: 720, end: 840 }] },
      ],
    });
    expect(fora).toHaveLength(1);
    expect(fora[0]?.time).toBe('12:30');
  });

  it('o passado não vira conflito', async () => {
    // Alertar sobre o que já aconteceu seria ruído em toda edição.
    await exec(admin, `
      INSERT INTO appointments
        (tenant_id, location_id, professional_id,
         starts_at, ends_at, service_starts_at, service_ends_at, status, price_cents)
      VALUES ('${TENANT}', '${LOCATION}', '${RUAN}',
              '2020-08-11T18:00:00Z', '2020-08-11T18:30:00Z',
              '2020-08-11T18:00:00Z', '2020-08-11T18:30:00Z', 'completed', 4900);
    `);

    const fora = await conflitosDaJornada({
      podeVerCliente: true,
      tenantId: TENANT,
      locationId: LOCATION,
      professionalId: RUAN,
      faixas: [{ weekday: 2, startMinute: 540, endMinute: 600, breaks: [] }],
    });
    expect(fora).toEqual([]);
  });

  it('recusa jornada invertida antes de tocar no banco', async () => {
    await expect(
      saveSchedule({
        tenantId: TENANT,
        locationId: LOCATION,
        professionalId: RUAN,
        faixas: [{ weekday: 2, startMinute: 1080, endMinute: 540, breaks: [] }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_catalog' });
  });

  // -- recursos --------------------------------------------------------------

  it('cadastra recurso e o que cada serviço consome', async () => {
    // As duas tabelas existem desde o bloco 1 e nada nunca as preencheu: uma
    // barbearia com um lavatório só oferecia lavagens simultâneas sem limite.
    const { id } = await createService(TENANT, corte);

    await saveResources({
      tenantId: TENANT,
      locationId: LOCATION,
      pools: [
        { resourceType: 'cadeira', capacity: 3 },
        { resourceType: 'lavatório', capacity: 1 },
      ],
    });
    await setServiceResources({
      tenantId: TENANT,
      locationId: LOCATION,
      serviceId: id,
      requirements: [{ resourceType: 'lavatório', quantity: 1 }],
    });

    const recursos = await listResources(TENANT, LOCATION);
    expect(recursos.map((r) => r.resourceType)).toEqual(['cadeira', 'lavatório']);
    expect(recursos.find((r) => r.resourceType === 'lavatório')?.usedBy).toEqual([
      { serviceId: id, quantity: 1 },
    ]);
  });

  it('recusa exigir recurso que a barbearia não tem', async () => {
    // Aceitar criaria exigência de algo que o motor nunca encontra, e o serviço
    // sumiria da grade sem ninguém entender por quê.
    const { id } = await createService(TENANT, corte);
    await expect(
      setServiceResources({
        tenantId: TENANT,
        locationId: LOCATION,
        serviceId: id,
        requirements: [{ resourceType: 'helicóptero', quantity: 1 }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_catalog' });
  });

  it('remover um recurso leva junto as exigências que apontavam para ele', async () => {
    const { id } = await createService(TENANT, corte);
    await saveResources({
      tenantId: TENANT, locationId: LOCATION,
      pools: [{ resourceType: 'lavatório', capacity: 1 }],
    });
    await setServiceResources({
      tenantId: TENANT, locationId: LOCATION, serviceId: id,
      requirements: [{ resourceType: 'lavatório', quantity: 1 }],
    });

    await saveResources({
      tenantId: TENANT, locationId: LOCATION,
      pools: [{ resourceType: 'cadeira', capacity: 2 }],
    });

    // Exigência órfã faria o motor procurar capacidade de um recurso que não
    // existe mais e recusar todos os horários daquele serviço.
    const sobrou = await admin.$queryRawUnsafe<{ total: bigint }[]>(
      `SELECT count(*) AS total FROM service_resource_requirements`,
    );
    expect(Number(sobrou[0]?.total)).toBe(0);
  });

  it('mudar a capacidade não duplica o recurso', async () => {
    await saveResources({
      tenantId: TENANT, locationId: LOCATION,
      pools: [{ resourceType: 'cadeira', capacity: 2 }],
    });
    await saveResources({
      tenantId: TENANT, locationId: LOCATION,
      pools: [{ resourceType: 'cadeira', capacity: 4 }],
    });

    const recursos = await listResources(TENANT, LOCATION);
    expect(recursos).toHaveLength(1);
    expect(recursos[0]?.capacity).toBe(4);
  });

  // -- isolamento ------------------------------------------------------------

  it('nada disso atravessa a parede entre barbearias', async () => {
    const { id } = await createService(TENANT, corte);

    expect((await listServices(RIVAL)).services).toEqual([]);
    expect(await listProfessionals(RIVAL, LOCATION)).toEqual([]);

    await expect(
      updateService(RIVAL, id, { ...corte, priceCents: 1 }),
    ).rejects.toMatchObject({ code: 'service_not_found' });

    await expect(
      setProfessionalActive({ podeVerCliente: true, tenantId: RIVAL, locationId: LOCAL_RIVAL, professionalId: RUAN, active: false }),
    ).rejects.toMatchObject({ code: 'professional_not_found' });

    // E o preço do vizinho continua o que era.
    const { services } = await listServices(TENANT);
    expect(services[0]?.priceCents).toBe(4900);
  });

  /**
   * O id vem no **corpo**, não na URL — e é por aí que a parede tinha buraco.
   *
   * A checagem de integridade referencial do Postgres ignora row security por
   * definição. Então a FK de `professional_services.service_id` aceitava um
   * serviço de outra barbearia: o `tenant_id` da linha vinha de
   * `current_setting`, o `WITH CHECK` aprovava, e nada mais olhava.
   *
   * Os testes acima passavam porque todos mandavam o id de fora **na URL**, que
   * é resolvido por `SELECT` sob RLS. Um id de fora no payload não passava por
   * nenhum `SELECT`.
   */
  it('id de serviço de outra barbearia no corpo do pedido é recusado', async () => {
    const { id: doVizinho } = await createService(TENANT, corte);

    await expect(
      createProfessional(RIVAL, LOCAL_RIVAL, {
        name: 'Aproveitador',
        kind: 'professional',
        bookableOnline: true,
        serviceIds: [doVizinho],
      }),
    ).rejects.toMatchObject({ code: 'service_not_found' });

    await expect(
      updateProfessional(RIVAL, LOCAL_RIVAL, PRO_RIVAL, {
        name: 'Barbeiro do rival',
        kind: 'professional',
        bookableOnline: true,
        serviceIds: [doVizinho],
      }),
    ).rejects.toMatchObject({ code: 'service_not_found' });

    // E nenhuma linha atravessada ficou para trás.
    const atravessadas = await admin.$queryRawUnsafe<{ total: bigint }[]>(
      `SELECT count(*) AS total FROM professional_services ps
         JOIN services s ON s.id = ps.service_id
        WHERE ps.tenant_id <> s.tenant_id`,
    );
    expect(Number(atravessadas[0]?.total ?? 0)).toBe(0);
  });

  it('componente de combo de outra barbearia é recusado', async () => {
    const { id: doVizinho } = await createService(TENANT, corte);
    const { id: proprio } = await createService(RIVAL, { ...corte, name: 'Corte do rival' });

    await expect(
      createService(RIVAL, {
        ...corte,
        name: 'Combo esperto',
        durationMinutes: 120,
        componentIds: [proprio, doVizinho],
      }),
    ).rejects.toMatchObject({ code: 'service_not_found' });

    const atravessados = await admin.$queryRawUnsafe<{ total: bigint }[]>(
      `SELECT count(*) AS total FROM service_combo_components scc
         JOIN services s ON s.id = scc.service_id
        WHERE scc.tenant_id <> s.tenant_id`,
    );
    expect(Number(atravessados[0]?.total ?? 0)).toBe(0);
  });
});
