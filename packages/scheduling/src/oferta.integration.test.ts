import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@barbearia/db';
import { MINUTOS_DE_JANELA_EXCLUSIVA } from '@barbearia/core';
import { createAppointment } from './booking.js';
import { entrarNaEspera, sairDaEspera } from './espera.js';
import {
  OfertaError,
  aceitarOferta,
  ofertaPorToken,
  oferecerProximaVaga,
  vencerOfertas,
} from './oferta.js';

/**
 * A oferta com janela exclusiva contra Postgres real (bloco 39, SPEC §2.9).
 *
 * O que só o banco prova: que o horário fica **de fato** segurado durante os
 * dez minutos, que duas ofertas vivas não coexistem para a mesma vaga, que a
 * vaga passa ao próximo quando ninguém responde — e que ela não volta para quem
 * já deixou passar, que é o laço que nunca termina.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '39393939-1111-1111-1111-111111111111';
const LOCATION = '39393939-aaaa-0000-0000-000000000001';
const RUAN = '39393939-bbbb-0000-0000-000000000001';
const CABELO = '39393939-eeee-0000-0000-000000000001';
const CARLOS = '39393939-cccc-0000-0000-000000000001';
const BRUNO = '39393939-cccc-0000-0000-000000000002';
const DANIEL = '39393939-cccc-0000-0000-000000000003';

const TERCA = '2026-09-08';
const AGORA = new Date('2026-09-07T12:00:00Z');
/** 09:00 na unidade (America/Bahia, UTC-3) é 12:00 UTC. */
const VAGA_INICIO = new Date('2026-09-08T12:00:00Z');
const VAGA_FIM = new Date('2026-09-08T12:30:00Z');

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

describeIfDb('oferta de vaga com janela exclusiva', () => {
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

      INSERT INTO professionals (id, tenant_id, location_id, name)
      VALUES ('${RUAN}', '${TENANT}', '${LOCATION}', 'Ruan');

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes)
      VALUES ('${CABELO}', '${TENANT}', 'Cabelo', 4900, 30);

      INSERT INTO professional_services (professional_id, service_id, tenant_id)
      VALUES ('${RUAN}', '${CABELO}', '${TENANT}');

      INSERT INTO work_schedules (tenant_id, professional_id, weekday, start_minute, end_minute)
      SELECT '${TENANT}', '${RUAN}', d.weekday, 480, 1080
        FROM (VALUES (0), (1), (2), (3), (4), (5), (6)) AS d(weekday);

      INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
        ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777'),
        ('${BRUNO}', '${TENANT}', 'Bruno Lima', '+5571977776666'),
        ('${DANIEL}', '${TENANT}', 'Daniel Rocha', '+5571966665555');
    `);
  });

  /** Entra na lista pedindo a manhã de terça. */
  const esperar = (customerId: string, extra: Record<string, unknown> = {}) =>
    entrarNaEspera({
      tenantId: TENANT,
      locationId: LOCATION,
      customerId,
      serviceIds: [CABELO],
      de: TERCA,
      ate: TERCA,
      inicioMinuto: 8 * 60,
      fimMinuto: 12 * 60,
      now: AGORA,
      ...extra,
    });

  const oferecer = (agora = AGORA, exceto?: readonly string[]) =>
    oferecerProximaVaga({
      tenantId: TENANT,
      locationId: LOCATION,
      professionalId: RUAN,
      inicio: VAGA_INICIO,
      fim: VAGA_FIM,
      agora,
      ...(exceto ? { exceto } : {}),
    });

  const marcar = (pedido: {
    locationId: string;
    professionalId: string;
    serviceIds: readonly string[];
    customerId: string;
    date: string;
    start: string;
    holdId: string | null;
  }) =>
    createAppointment({
      tenantId: TENANT,
      locationId: pedido.locationId,
      professionalId: pedido.professionalId,
      serviceIds: [...pedido.serviceIds],
      customerId: pedido.customerId,
      date: pedido.date,
      start: pedido.start,
      atCounter: true,
      now: AGORA,
      // O hold da oferta atravessa: o motor sabe ignorar o próprio hold ao
      // consultar a grade e apagá-lo depois de gravar, numa transação só.
      ...(pedido.holdId ? { holdId: pedido.holdId } : {}),
    });

  const holds = () =>
    withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ id: string; expires_at: Date }[]>`
        SELECT id, expires_at FROM slot_holds
      `,
    );

  // -- oferecer ----------------------------------------------------------------

  it('sem ninguém na lista, não há oferta — e isso não é erro', async () => {
    expect(await oferecer()).toBeNull();
    expect(await holds()).toHaveLength(0);
  });

  it('oferece ao topo da fila e segura o horário pelos dez minutos', async () => {
    /**
     * Segurar é o que torna "exclusivo" verdade. Sem o hold, nos dez minutos em
     * que a pessoa decide qualquer visitante da página pública marca aquele
     * horário — e o convite vira frustração.
     */
    await esperar(CARLOS);
    const oferta = await oferecer();

    expect(oferta).toMatchObject({ customerId: CARLOS, customerNome: 'Carlos Souza' });
    expect(oferta?.token).toHaveLength(43);
    expect(oferta?.venceEm.getTime()).toBe(
      AGORA.getTime() + MINUTOS_DE_JANELA_EXCLUSIVA * 60_000,
    );

    const segurados = await holds();
    expect(segurados).toHaveLength(1);
    expect(segurados[0]?.expires_at.getTime()).toBe(oferta?.venceEm.getTime());
  });

  it('o token vai em claro uma vez e só o hash fica gravado', async () => {
    // Ele é a credencial que aceita a oferta sem sessão. Em claro na tabela,
    // quem a lesse marcaria o horário de qualquer pessoa.
    await esperar(CARLOS);
    const oferta = await oferecer();

    const linhas = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ token_hash: string }[]>`SELECT token_hash FROM waitlist_offers`,
    );
    expect(linhas[0]?.token_hash).not.toBe(oferta?.token);
    expect(linhas[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('quem já tem oferta viva não recebe uma segunda', async () => {
    // Duas mensagens ao mesmo tempo, ambas exclusivas por dez minutos, e a
    // pessoa só consegue aceitar uma: a outra vira frustração com cara de
    // defeito do sistema.
    await esperar(CARLOS);
    await oferecer();

    const outraVaga = await oferecerProximaVaga({
      tenantId: TENANT,
      locationId: LOCATION,
      professionalId: RUAN,
      inicio: new Date('2026-09-08T13:00:00Z'),
      fim: new Date('2026-09-08T13:30:00Z'),
      agora: AGORA,
    });
    expect(outraVaga).toBeNull();
  });

  it('a mesma vaga não é oferecida duas vezes ao mesmo tempo', async () => {
    await esperar(CARLOS);
    await esperar(BRUNO);

    const primeira = await oferecer();
    const segunda = await oferecer();

    expect(primeira).not.toBeNull();
    // O Bruno está livre, mas a **vaga** já tem dono por dez minutos.
    expect(segunda).toBeNull();
    expect(await holds()).toHaveLength(1);
  });

  // -- a ordem por prioridade --------------------------------------------------

  it('quem pediu a janela mais justa recebe primeiro, mesmo entrando depois', async () => {
    /**
     * É o desenho da SPEC §2.9. A fila por chegada pura entrega a vaga das 9h a
     * quem aceitava a manhã inteira e deixa sem horário quem só pode às 9h —
     * as duas pessoas ficam mal atendidas de uma vez.
     */
    await esperar(CARLOS, { inicioMinuto: 8 * 60, fimMinuto: 12 * 60 });
    await esperar(BRUNO, { inicioMinuto: 9 * 60, fimMinuto: 9 * 60 + 30 });

    const oferta = await oferecer();
    expect(oferta?.customerId).toBe(BRUNO);
  });

  it('entre pedidos idênticos, quem entrou primeiro recebe', async () => {
    await esperar(CARLOS);
    await esperar(BRUNO);
    expect((await oferecer())?.customerId).toBe(CARLOS);
  });

  // -- a tela do cliente -------------------------------------------------------

  it('o link mostra a vaga e o tempo que resta', async () => {
    await esperar(CARLOS);
    const oferta = await oferecer();

    const naTela = await ofertaPorToken(TENANT, oferta!.token, AGORA);
    expect(naTela).toMatchObject({
      estado: 'aberta',
      dia: TERCA,
      hora: '09:00',
      profissionalNome: 'Ruan',
      servicos: ['Cabelo'],
      barbearia: 'Domari',
      minutosRestantes: MINUTOS_DE_JANELA_EXCLUSIVA,
    });
  });

  it('token inventado não acha nada', async () => {
    await esperar(CARLOS);
    await oferecer();
    expect(await ofertaPorToken(TENANT, 'token-que-nao-existe', AGORA)).toBeNull();
  });

  it('passado o prazo, a tela já diz vencida — sem esperar a varredura', async () => {
    /**
     * O estado gravado continua `aberta` até a varredura passar. Mostrar o
     * gravado faria a tela oferecer um botão que a gravação vai recusar — e a
     * pessoa clicaria no minuto onze achando que ainda dava.
     */
    await esperar(CARLOS);
    const oferta = await oferecer();

    const depois = new Date(oferta!.venceEm.getTime() + 1_000);
    expect((await ofertaPorToken(TENANT, oferta!.token, depois))?.estado).toBe('vencida');
  });

  // -- aceitar -----------------------------------------------------------------

  it('aceitar marca o horário, fecha a espera e libera o hold', async () => {
    const naLista = await esperar(CARLOS);
    const oferta = await oferecer();

    const { appointmentId } = await aceitarOferta({
      tenantId: TENANT,
      convite: { token: oferta!.token },
      agora: AGORA,
      marcar,
    });

    expect(appointmentId).toBeTruthy();
    // O hold sai: ele existia só para segurar enquanto ela decidia.
    expect(await holds()).toHaveLength(0);

    const linhas = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ status: string; appointment_id: string | null }[]>`
        SELECT status::text AS status, appointment_id FROM waitlist_offers
      `,
    );
    expect(linhas[0]).toMatchObject({ status: 'aceita', appointment_id: appointmentId });

    const entrada = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ status: string }[]>`
        SELECT status::text AS status FROM waitlist_entries WHERE id = ${naLista.id}::uuid
      `,
    );
    expect(entrada[0]?.status).toBe('booked');
  });

  it('o mesmo convite não vale duas vezes', async () => {
    // Sem isto, reenviar o formulário criaria dois agendamentos no mesmo
    // horário — e o segundo bateria na constraint de exclusão com erro de
    // banco, que é o pior jeito de recusar.
    await esperar(CARLOS);
    const oferta = await oferecer();

    await aceitarOferta({ tenantId: TENANT, convite: { token: oferta!.token }, agora: AGORA, marcar });
    await expect(
      aceitarOferta({ tenantId: TENANT, convite: { token: oferta!.token }, agora: AGORA, marcar }),
    ).rejects.toMatchObject({ code: 'oferta_encerrada' });
  });

  it('dois cliques ao mesmo tempo produzem um agendamento só', async () => {
    /**
     * O duplo toque no link é o caso comum, não o exótico: rede lenta, a pessoa
     * clica de novo. Antes, os dois pedidos passavam pela mesma checagem de
     * "ainda está aberta?" — a trava do banco não separava nada, porque nada era
     * escrito dentro dela — e o segundo só era barrado na constraint de
     * exclusão, devolvendo "horário indisponível" para quem tinha exclusividade
     * sobre ele. Achado da revisão de segurança do bloco 39.
     */
    await esperar(CARLOS);
    const oferta = await oferecer();

    const respostas = await Promise.allSettled([
      aceitarOferta({ tenantId: TENANT, convite: { token: oferta!.token }, agora: AGORA, marcar }),
      aceitarOferta({ tenantId: TENANT, convite: { token: oferta!.token }, agora: AGORA, marcar }),
    ]);

    expect(respostas.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const recusada = respostas.find((r) => r.status === 'rejected');
    // Recusa do domínio, com frase para a pessoa — não erro de banco.
    expect((recusada as PromiseRejectedResult | undefined)?.reason).toBeInstanceOf(
      OfertaError,
    );

    const quantos = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM appointments`,
    );
    expect(Number(quantos[0]?.n)).toBe(1);
  });

  it('convite vencido não marca nada', async () => {
    await esperar(CARLOS);
    const oferta = await oferecer();
    const depois = new Date(oferta!.venceEm.getTime() + 1_000);

    await expect(
      aceitarOferta({ tenantId: TENANT, convite: { token: oferta!.token }, agora: depois, marcar }),
    ).rejects.toBeInstanceOf(OfertaError);
  });

  it('token de uma barbearia não vale na outra', async () => {
    // A RLS recorta a busca pelo hash: o token existe, mas não nesta barbearia.
    await esperar(CARLOS);
    const oferta = await oferecer();
    const outra = '39393939-9999-9999-9999-999999999999';
    await exec(`INSERT INTO tenants (id, name) VALUES ('${outra}', 'Vizinha')`);

    expect(await ofertaPorToken(outra, oferta!.token, AGORA)).toBeNull();
  });

  // -- passar ao próximo -------------------------------------------------------

  it('sem resposta, a vaga vence e volta para a mesa', async () => {
    await esperar(CARLOS);
    const oferta = await oferecer();
    const depois = new Date(oferta!.venceEm.getTime() + 1_000);

    const vagas = await vencerOfertas(TENANT, depois);
    expect(vagas).toHaveLength(1);
    expect(vagas[0]).toMatchObject({ professionalId: RUAN, locationId: LOCATION });

    // O hold sai junto: deixá-lo faria a grade calcular sobre linha morta.
    expect(await holds()).toHaveLength(0);
  });

  it('a vaga vai ao próximo, e não volta para quem deixou passar', async () => {
    /**
     * O `exceto` é o que impede o laço. Sem ele, a vaga voltaria para a mesma
     * pessoa que acabou de não responder, indefinidamente — e ninguém mais
     * seria chamado.
     */
    const doCarlos = await esperar(CARLOS);
    await esperar(BRUNO);

    const primeira = await oferecer();
    expect(primeira?.customerId).toBe(CARLOS);

    const depois = new Date(primeira!.venceEm.getTime() + 1_000);
    const vagas = await vencerOfertas(TENANT, depois);
    expect(vagas[0]?.exceto).toContain(doCarlos.id);

    const segunda = await oferecer(depois, vagas[0]?.exceto);
    expect(segunda?.customerId).toBe(BRUNO);
  });

  it('esgotada a fila, a vaga simplesmente fica livre', async () => {
    // Nem erro nem laço: ninguém mais quer, e o horário volta à grade para quem
    // aparecer pela página pública.
    const doCarlos = await esperar(CARLOS);
    const primeira = await oferecer();
    const depois = new Date(primeira!.venceEm.getTime() + 1_000);

    await vencerOfertas(TENANT, depois);
    expect(await oferecer(depois, [doCarlos.id])).toBeNull();
    expect(await holds()).toHaveLength(0);
  });

  it('vencer não mexe em oferta já aceita', async () => {
    await esperar(CARLOS);
    const oferta = await oferecer();
    await aceitarOferta({ tenantId: TENANT, convite: { token: oferta!.token }, agora: AGORA, marcar });

    const depois = new Date(oferta!.venceEm.getTime() + 1_000);
    expect(await vencerOfertas(TENANT, depois)).toHaveLength(0);

    const linhas = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ status: string }[]>`SELECT status::text AS status FROM waitlist_offers`,
    );
    expect(linhas[0]?.status).toBe('aceita');
  });

  it('a vaga não some quando o topo da fila tem convite vencido e não varrido', async () => {
    /**
     * A janela entre o vencimento e a varredura é rotina — o worker atrasa numa
     * reimplantação e as tarefas correm um minuto depois. Nela, o topo da fila
     * está livre pelo relógio e ocupado pelo índice parcial, que só olha o
     * estado. Com os dois discordando, a gravação batia no `ON CONFLICT` e a
     * vaga era descartada **em silêncio**, com a fila cheia de gente que a
     * queria. Achado da revisão de segurança do bloco 39.
     */
    await esperar(CARLOS);
    await esperar(BRUNO);

    const outra = await oferecerProximaVaga({
      tenantId: TENANT,
      locationId: LOCATION,
      professionalId: RUAN,
      inicio: new Date('2026-09-08T13:00:00Z'),
      fim: new Date('2026-09-08T13:30:00Z'),
      agora: AGORA,
    });
    expect(outra?.customerId).toBe(CARLOS);

    // Vencida pelo relógio, e a varredura **não** rodou.
    const depois = new Date(outra!.venceEm.getTime() + 1_000);
    expect(await oferecer(depois)).toMatchObject({ customerId: BRUNO });
  });

  it('a marcação que falha devolve o convite, com o prazo que sobrou', async () => {
    // Um erro de rede não pode consumir a exclusividade de quem não fez nada
    // errado — nem deixar a entrada presa esperando a varredura.
    await esperar(CARLOS);
    const oferta = await oferecer();

    await expect(
      aceitarOferta({
        tenantId: TENANT,
        convite: { token: oferta!.token },
        agora: AGORA,
        marcar: () => Promise.reject(new Error('banco fora do ar')),
      }),
    ).rejects.toThrow('banco fora do ar');

    expect((await ofertaPorToken(TENANT, oferta!.token, AGORA))?.estado).toBe('aberta');
    // O horário continua segurado: a pessoa ainda tem os minutos que sobraram.
    expect(await holds()).toHaveLength(1);

    const segunda = await aceitarOferta({
      tenantId: TENANT,
      convite: { token: oferta!.token },
      agora: AGORA,
      marcar,
    });
    expect(segunda.appointmentId).toBeTruthy();
  });

  it('sair da lista cancela o convite e devolve o horário à grade', async () => {
    /**
     * Sem isto, quem disse "não quero mais" fica com um link vivo e resgatável,
     * e o horário segue fora da grade de todo mundo por uma espera que já não
     * existe. Achado da revisão de segurança do bloco 39.
     */
    const naLista = await esperar(CARLOS);
    const oferta = await oferecer();

    await sairDaEspera({ tenantId: TENANT, customerId: CARLOS, entryId: naLista.id });

    expect((await ofertaPorToken(TENANT, oferta!.token, AGORA))?.estado).toBe('cancelada');
    expect(await holds()).toHaveLength(0);
    await expect(
      aceitarOferta({ tenantId: TENANT, convite: { token: oferta!.token }, agora: AGORA, marcar }),
    ).rejects.toMatchObject({ code: 'oferta_encerrada' });
  });

  it('com buffer de preparo, o convite anuncia a hora do corte — não a da arrumação', async () => {
    /**
     * A vaga guardada é a janela **ocupada**, com buffers: é o buraco de verdade
     * na grade, e é ela que precisa ser segurada. Mas o que a pessoa combina é a
     * hora do corte, e é ela que o motor de reserva recebe.
     *
     * Anunciar o ocupado mandava "terça às 08:30" para um corte das 08:40 — e o
     * aceite marcava dez minutos antes do combinado, numa janela que ninguém
     * segurou. Achado da revisão de segurança do bloco 39.
     */
    await exec(`UPDATE services SET buffer_before_minutes = 10 WHERE id = '${CABELO}'`);
    await esperar(CARLOS);

    const oferta = await oferecerProximaVaga({
      tenantId: TENANT,
      locationId: LOCATION,
      professionalId: RUAN,
      // Ocupado 08:30–09:10 na unidade; o corte começa 08:40.
      inicio: new Date('2026-09-08T11:30:00Z'),
      fim: new Date('2026-09-08T12:10:00Z'),
      agora: AGORA,
    });

    expect(oferta?.hora).toBe('08:40');
    expect((await ofertaPorToken(TENANT, oferta!.token, AGORA))?.hora).toBe('08:40');

    const { appointmentId } = await aceitarOferta({
      tenantId: TENANT,
      convite: { token: oferta!.token },
      agora: AGORA,
      marcar,
    });

    const marcado = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ starts_at: Date; service_starts_at: Date }[]>`
        SELECT starts_at, service_starts_at FROM appointments
         WHERE id = ${appointmentId}::uuid
      `,
    );
    // O ocupado é o que foi segurado; o serviço é o que foi anunciado.
    expect(marcado[0]?.starts_at.toISOString()).toBe('2026-09-08T11:30:00.000Z');
    expect(marcado[0]?.service_starts_at.toISOString()).toBe('2026-09-08T11:40:00.000Z');
  });

  it('o horário segurado some da grade para quem não foi convidado', async () => {
    /**
     * A prova de que a exclusividade não é só uma palavra: enquanto o convite
     * está de pé, o horário não pode ser marcado por outra pessoa.
     */
    await esperar(CARLOS);
    await oferecer();

    await expect(
      createAppointment({
        tenantId: TENANT,
        locationId: LOCATION,
        professionalId: RUAN,
        serviceIds: [CABELO],
        customerId: DANIEL,
        date: TERCA,
        start: '09:00',
        atCounter: true,
        now: AGORA,
      }),
    ).rejects.toMatchObject({ code: 'slot_not_available' });
  });
});
