import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@barbearia/db';
import { cancelAppointment, createAppointment } from './booking.js';
import {
  EsperaError,
  entrarNaEspera,
  esperasDoCliente,
  expirarEsperas,
  quemEstaEsperando,
  sairDaEspera,
} from './espera.js';

/**
 * A lista de espera contra Postgres real (bloco 38, SPEC §2.9).
 *
 * O que só o banco prova: que o teto de três é aplicado de verdade, que o duplo
 * toque não põe a pessoa duas vezes, que um cliente não tira outro da lista, e
 * — o que dá sentido a tudo — que o cancelamento devolve **quem quer a vaga**
 * dentro da própria transação que a abriu.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '38383838-1111-1111-1111-111111111111';
const LOCATION = '38383838-aaaa-0000-0000-000000000001';
const RUAN = '38383838-bbbb-0000-0000-000000000001';
const GLEIDSON = '38383838-bbbb-0000-0000-000000000002';
const CABELO = '38383838-eeee-0000-0000-000000000001';
const CARLOS = '38383838-cccc-0000-0000-000000000001';
const BRUNO = '38383838-cccc-0000-0000-000000000002';
/** Sem espera nenhuma: é quem marca o horário que depois será cancelado. */
const DANIEL = '38383838-cccc-0000-0000-000000000003';

/** Terça. O fuso da unidade é America/Bahia, UTC-3. */
const TERCA = '2026-09-08';
const AGORA = new Date('2026-09-07T12:00:00Z');

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

describeIfDb('lista de espera', () => {
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

      INSERT INTO locations (id, tenant_id, name, timezone, granularity_minutes)
      VALUES ('${LOCATION}', '${TENANT}', 'Matriz', 'America/Bahia', 30);

      INSERT INTO professionals (id, tenant_id, location_id, name) VALUES
        ('${RUAN}', '${TENANT}', '${LOCATION}', 'Ruan'),
        ('${GLEIDSON}', '${TENANT}', '${LOCATION}', 'Gleidson');

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes)
      VALUES ('${CABELO}', '${TENANT}', 'Cabelo', 4900, 30);

      INSERT INTO professional_services (professional_id, service_id, tenant_id) VALUES
        ('${RUAN}', '${CABELO}', '${TENANT}'),
        ('${GLEIDSON}', '${CABELO}', '${TENANT}');

      INSERT INTO work_schedules (tenant_id, professional_id, weekday, start_minute, end_minute)
      SELECT '${TENANT}', p.id, d.weekday, 480, 1080
        FROM (VALUES ('${RUAN}'::uuid), ('${GLEIDSON}'::uuid)) AS p(id),
             (VALUES (0), (1), (2), (3), (4), (5), (6)) AS d(weekday);

      INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
        ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777'),
        ('${BRUNO}', '${TENANT}', 'Bruno Lima', '+5571977776666'),
        ('${DANIEL}', '${TENANT}', 'Daniel Rocha', '+5571966665555');
    `);
  });

  const esperar = (extra: Partial<Parameters<typeof entrarNaEspera>[0]> = {}) =>
    entrarNaEspera({
      tenantId: TENANT,
      locationId: LOCATION,
      customerId: CARLOS,
      serviceIds: [CABELO],
      de: TERCA,
      ate: TERCA,
      inicioMinuto: 8 * 60,
      fimMinuto: 12 * 60,
      now: AGORA,
      ...extra,
    });

  // -- entrar e sair -----------------------------------------------------------

  it('entra na lista com o que o cliente pediu, e a duração vem do catálogo', async () => {
    /**
     * A duração é somada do catálogo e nunca da requisição — mesma regra da
     * reserva. Aceitá-la do cliente deixaria alguém pedir "me avise de qualquer
     * buraco de 5 minutos" e ganhar prioridade sobre a agenda inteira.
     */
    const entrada = await esperar();

    expect(entrada).toMatchObject({
      status: 'waiting',
      de: TERCA,
      ate: TERCA,
      inicio: '08:00',
      fim: '12:00',
      duracaoMinutos: 30,
      profissionalId: null,
      servicos: ['Cabelo'],
    });
  });

  it('o duplo toque devolve a mesma entrada', async () => {
    const primeira = await esperar({ idempotencyKey: 'toque-1' });
    const segunda = await esperar({ idempotencyKey: 'toque-1' });
    expect(segunda.id).toBe(primeira.id);
    expect(await esperasDoCliente(TENANT, CARLOS)).toHaveLength(1);
  });

  it('pedir de novo a mesma coisa devolve a que já existe, não uma segunda', async () => {
    // A chave de idempotência resolve o duplo toque; isto resolve o pedido
    // repetido dias depois, que ela não alcança. Sem o índice parcial, quem
    // esquece que já se inscreveu gasta duas das três vagas e recebe o aviso
    // em dobro.
    const primeira = await esperar();
    const segunda = await esperar();
    expect(segunda.id).toBe(primeira.id);
    expect(await esperasDoCliente(TENANT, CARLOS)).toHaveLength(1);
  });

  it('a quarta entrada ativa é recusada', async () => {
    await esperar({ de: '2026-09-08', ate: '2026-09-08' });
    await esperar({ de: '2026-09-09', ate: '2026-09-09' });
    await esperar({ de: '2026-09-10', ate: '2026-09-10' });

    await expect(esperar({ de: '2026-09-11', ate: '2026-09-11' })).rejects.toMatchObject({
      code: 'limite_atingido',
    });
  });

  it('quem saiu da lista libera a vaga do próprio limite', async () => {
    const uma = await esperar({ de: '2026-09-08', ate: '2026-09-08' });
    await esperar({ de: '2026-09-09', ate: '2026-09-09' });
    await esperar({ de: '2026-09-10', ate: '2026-09-10' });

    await sairDaEspera({ tenantId: TENANT, customerId: CARLOS, entryId: uma.id });
    await expect(esperar({ de: '2026-09-11', ate: '2026-09-11' })).resolves.toMatchObject({
      status: 'waiting',
    });
  });

  it('um cliente não tira outro da lista', async () => {
    /**
     * A RLS separa barbearias e **não** separa clientes dentro de uma. Sem o
     * filtro por `customer_id`, qualquer cliente autenticado tiraria qualquer
     * outro da fila bastando o id — e o id viaja na própria tela de quem
     * espera.
     */
    const doCarlos = await esperar();

    await expect(
      sairDaEspera({ tenantId: TENANT, customerId: BRUNO, entryId: doCarlos.id }),
    ).rejects.toBeInstanceOf(EsperaError);

    expect(await esperasDoCliente(TENANT, CARLOS)).toHaveLength(1);
  });

  it('a lista de um cliente não aparece para o outro', async () => {
    await esperar();
    expect(await esperasDoCliente(TENANT, BRUNO)).toHaveLength(0);
  });

  it('sem serviço nenhum não entra', async () => {
    // Duração zero casaria com qualquer buraco da grade, inclusive os que não
    // existem — e a CHECK do banco recusa antes, mas a borda precisa dizer o
    // que faltou.
    await expect(esperar({ serviceIds: [] })).rejects.toMatchObject({
      code: 'janela_invalida',
    });
  });

  // -- o que a revisão de segurança cobrou -------------------------------------

  describe('a fronteira entre barbearias, que a chave estrangeira não segura', () => {
    /**
     * A checagem de integridade referencial do Postgres **ignora row security**:
     * a chave estrangeira aceitaria de bom grado um serviço ou um profissional
     * de outra barbearia. Os dois achados são da revisão deste bloco.
     */
    const RIVAL = '38383838-9999-9999-9999-999999999999';
    const RUAN_RIVAL = '38383838-bbbb-9999-0000-000000000001';
    const CABELO_RIVAL = '38383838-eeee-9999-0000-000000000001';

    beforeEach(async () => {
      await exec(`
        INSERT INTO tenants (id, name) VALUES ('${RIVAL}', 'Vizinha');

        INSERT INTO locations (id, tenant_id, name, timezone)
        VALUES ('38383838-aaaa-9999-0000-000000000001', '${RIVAL}', 'Outra', 'America/Bahia');

        INSERT INTO professionals (id, tenant_id, location_id, name)
        VALUES ('${RUAN_RIVAL}', '${RIVAL}', '38383838-aaaa-9999-0000-000000000001', 'Outro');

        INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes)
        VALUES ('${CABELO_RIVAL}', '${RIVAL}', 'Cabelo da vizinha', 4900, 30);
      `);
    });

    it('serviço de outra barbearia é recusado, mesmo misturado com um legítimo', async () => {
      // Só a **soma** não pega isto: um pedido com um serviço legítimo e um
      // alheio dá duração positiva, passa, e grava a referência estrangeira.
      await expect(esperar({ serviceIds: [CABELO_RIVAL] })).rejects.toMatchObject({
        code: 'servico_desconhecido',
      });
      await expect(esperar({ serviceIds: [CABELO, CABELO_RIVAL] })).rejects.toMatchObject({
        code: 'servico_desconhecido',
      });
    });

    it('profissional de outra barbearia é recusado', async () => {
      /**
       * A consequência aqui era pior que uma linha estranha. A chave tem
       * `ON DELETE SET NULL`: quando a outra barbearia apagasse aquele
       * profissional, a entrada plantada viraria em silêncio um "qualquer
       * barbeiro" — e passaria a casar com toda vaga que abrisse.
       */
      await expect(esperar({ professionalId: RUAN_RIVAL })).rejects.toMatchObject({
        code: 'profissional_desconhecido',
      });
    });

    it('profissional de outra unidade da mesma barbearia também é recusado', async () => {
      // A conferência é por unidade, não só por barbearia: a entrada é da
      // unidade, e um profissional que não atende ali nunca abriria a vaga.
      await exec(`
        INSERT INTO locations (id, tenant_id, name, timezone)
        VALUES ('38383838-aaaa-0000-0000-000000000002', '${TENANT}', 'Filial', 'America/Bahia');

        INSERT INTO professionals (id, tenant_id, location_id, name)
        VALUES ('38383838-bbbb-0000-0000-000000000009', '${TENANT}',
                '38383838-aaaa-0000-0000-000000000002', 'Da filial')
      `);

      await expect(
        esperar({ professionalId: '38383838-bbbb-0000-0000-000000000009' }),
      ).rejects.toMatchObject({ code: 'profissional_desconhecido' });
    });
  });

  describe('o recorte por profissional na lista do balcão', () => {
    /**
     * Achado da revisão. Sem o recorte, o barbeiro que enxerga só a própria
     * agenda lia a lista da barbearia inteira por esta porta — inclusive as
     * entradas que nomeiam um colega.
     */
    it('quem vê só a própria agenda vê as entradas dele e as sem dono', async () => {
      await esperar({ professionalId: RUAN, de: '2026-09-08', ate: '2026-09-08' });
      await esperar({ professionalId: GLEIDSON, de: '2026-09-09', ate: '2026-09-09' });
      await esperar({ de: '2026-09-10', ate: '2026-09-10' });

      const doRuan = await quemEstaEsperando(TENANT, LOCATION, RUAN);
      // A sem profissional aparece: qualquer um pode atendê-la, e escondê-la
      // seria esconder do barbeiro justamente o cliente que ele consegue pegar.
      expect(doRuan.map((e) => e.profissionalId)).toEqual([RUAN, null]);

      // Sem recorte, a barbearia inteira.
      expect(await quemEstaEsperando(TENANT, LOCATION)).toHaveLength(3);
    });
  });

  // -- expiração ---------------------------------------------------------------

  it('expira quando o último dia pedido passa, no fuso da unidade', async () => {
    /**
     * O recorte é do banco, com a data local calculada a partir do fuso da
     * unidade. Comparar com a data do processo expiraria o sábado da barbearia
     * de Salvador às 21h de sexta, quando o servidor em UTC já virou o dia.
     */
    await esperar({ de: TERCA, ate: TERCA });

    // 21h da própria terça em Salvador é 00h de quarta em UTC. Nada expira.
    await expirarEsperas(TENANT, new Date('2026-09-09T00:00:00Z'));
    expect(await esperasDoCliente(TENANT, CARLOS)).toHaveLength(1);

    // Já na quarta pela manhã, na unidade, a entrada sai.
    const quantas = await expirarEsperas(TENANT, new Date('2026-09-09T13:00:00Z'));
    expect(quantas).toBe(1);
    expect(await esperasDoCliente(TENANT, CARLOS)).toHaveLength(0);
  });

  // -- o gatilho ---------------------------------------------------------------

  /**
   * Marca para o Daniel por padrão, e ele **não está em lista nenhuma**.
   *
   * Desde que marcar fecha a espera que o horário satisfaz, usar quem espera
   * como quem marca faria o cancelamento seguinte encontrar a lista já vazia —
   * e o teste provaria o contrário do que diz.
   */
  const marcar = (start: string, customerId = DANIEL) =>
    createAppointment({
      tenantId: TENANT,
      locationId: LOCATION,
      professionalId: RUAN,
      serviceIds: [CABELO],
      date: TERCA,
      start,
      customerId,
      now: AGORA,
    });

  it('o cancelamento devolve quem quer a vaga, na mesma transação', async () => {
    /**
     * É o que dá sentido à lista inteira. Perguntar depois do commit criaria a
     * janela em que o horário está livre e ninguém sabe — e é justamente a
     * janela em que outro cliente marca pelo site.
     */
    const naLista = await esperar();
    const marcado = await marcar('09:00');

    const desfecho = await cancelAppointment({
      tenantId: TENANT,
      appointmentId: marcado.id,
      by: 'business',
      now: AGORA,
    });

    expect(desfecho.esperando).toHaveLength(1);
    expect(desfecho.esperando[0]).toMatchObject({
      id: naLista.id,
      customerId: CARLOS,
      customerNome: 'Carlos Souza',
      // Só os quatro últimos: a tela do balcão fica virada para o salão.
      customerTelefoneFinal: '7777',
    });
  });

  describe('quem consegue marcar sai da lista', () => {
    /**
     * A SPEC §2.9 pede: "cliente sai da fila **automaticamente** ao conseguir
     * agendar". Sem isto, `booked` seria um estado que nada escreve — a pessoa
     * marcaria o sábado pelo site, continuaria na lista do sábado, e seria
     * chamada para uma vaga que já não quer. Achado na leitura de fluxo (§6),
     * com o portão inteiro verde.
     */
    it('marcar dentro do que se esperava fecha a espera e liga o agendamento', async () => {
      const naLista = await esperar();
      const marcado = await marcar('09:00', CARLOS);

      expect(await esperasDoCliente(TENANT, CARLOS)).toHaveLength(0);

      const linhas = await withTenant(TENANT, (tx) =>
        tx.$queryRaw<{ status: string; appointment_id: string | null }[]>`
          SELECT status::text AS status, appointment_id
            FROM waitlist_entries WHERE id = ${naLista.id}::uuid
        `,
      );
      expect(linhas[0]).toMatchObject({ status: 'booked', appointment_id: marcado.id });
    });

    it('marcar fora do que se esperava não fecha nada', async () => {
      // Quem esperava a manhã e conseguiu a tarde continua esperando a manhã:
      // era o que ela pediu, e desistir por ela seria decidir no lugar dela.
      await esperar({ inicioMinuto: 8 * 60, fimMinuto: 12 * 60 });
      await marcar('14:00', CARLOS);
      expect(await esperasDoCliente(TENANT, CARLOS)).toHaveLength(1);
    });

    it('a espera de outro cliente não fecha quando este marca', async () => {
      // O filtro por `customer_id` é o que segura isto — a RLS separa
      // barbearias, não clientes dentro de uma.
      await esperar({ customerId: CARLOS });
      await marcar('09:00', BRUNO);
      expect(await esperasDoCliente(TENANT, CARLOS)).toHaveLength(1);
    });
  });

  it('quem pediu a tarde não é chamado para uma vaga da manhã', async () => {
    await esperar({ inicioMinuto: 14 * 60, fimMinuto: 18 * 60 });
    const marcado = await marcar('09:00');

    const desfecho = await cancelAppointment({
      tenantId: TENANT,
      appointmentId: marcado.id,
      by: 'business',
      now: AGORA,
    });
    expect(desfecho.esperando).toHaveLength(0);
  });

  it('quem pediu outro barbeiro não é chamado', async () => {
    // Avisar quem pediu o Gleidson sobre uma vaga do Ruan é o jeito mais rápido
    // de a pessoa aprender a ignorar o aviso.
    await esperar({ professionalId: GLEIDSON });
    const marcado = await marcar('09:00');

    const desfecho = await cancelAppointment({
      tenantId: TENANT,
      appointmentId: marcado.id,
      by: 'business',
      now: AGORA,
    });
    expect(desfecho.esperando).toHaveLength(0);
  });

  it('quem pediu outro dia não é chamado', async () => {
    await esperar({ de: '2026-09-09', ate: '2026-09-09' });
    const marcado = await marcar('09:00');

    const desfecho = await cancelAppointment({
      tenantId: TENANT,
      appointmentId: marcado.id,
      by: 'business',
      now: AGORA,
    });
    expect(desfecho.esperando).toHaveLength(0);
  });

  it('a ordem é a de entrada na fila', async () => {
    /**
     * É o décimo do score da SPEC §2.9, e a única parte dele que este bloco
     * tem. O resto — aderência, recorrência, assinatura, confiabilidade — é o
     * bloco 39, junto da janela exclusiva de dez minutos.
     */
    const primeiro = await esperar({ customerId: CARLOS });
    const segundo = await entrarNaEspera({
      tenantId: TENANT,
      locationId: LOCATION,
      customerId: BRUNO,
      serviceIds: [CABELO],
      de: TERCA,
      ate: TERCA,
      inicioMinuto: 8 * 60,
      fimMinuto: 12 * 60,
      now: AGORA,
    });

    // Quem marca é o Daniel, que não espera nada: se fosse um dos dois, marcar
    // fecharia a espera dele e o teste provaria o contrário do que diz.
    const marcado = await marcar('09:00');
    const desfecho = await cancelAppointment({
      tenantId: TENANT,
      appointmentId: marcado.id,
      by: 'business',
      now: AGORA,
    });

    expect(desfecho.esperando.map((e) => e.id)).toEqual([primeiro.id, segundo.id]);
  });

  it('quem já saiu da lista não é chamado', async () => {
    const saiu = await esperar();
    await sairDaEspera({ tenantId: TENANT, customerId: CARLOS, entryId: saiu.id });

    const marcado = await marcar('09:00');
    const desfecho = await cancelAppointment({
      tenantId: TENANT,
      appointmentId: marcado.id,
      by: 'business',
      now: AGORA,
    });
    expect(desfecho.esperando).toHaveLength(0);
  });

  it('a espera some quando o cadastro é anonimizado', async () => {
    // Sem isto, a entrada sobreviveria viva: quando uma vaga abrisse, o balcão
    // veria "cliente_anonimizado_a3f1" na lista de quem chamar, sem telefone
    // para chamar — e a pessoa pediu justamente para sair.
    await esperar();
    await withTenant(TENANT, (tx) =>
      tx.$queryRaw`SELECT anonimizar_cliente(${CARLOS}::uuid, 'pedido do titular')`,
    );
    expect(await esperasDoCliente(TENANT, CARLOS)).toHaveLength(0);
  });
});
