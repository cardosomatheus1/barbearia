import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { atualizarVitrine, buscarComHorario } from './vitrine.js';
import type { FiltroDaBusca } from '@barbearia/core';

/**
 * O "próximo horário" do card, em lote e contra Postgres real (bloco 71).
 *
 * O que só o banco prova: que o horário anunciado sai do **mesmo motor** que a
 * reserva valida, que ele é do serviço que deu o preço do card, que a agenda
 * cheia produz card mudo em vez de card errado, e que os dois filtros novos
 * separam coisas diferentes.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const CEDO = '71707070-1111-1111-1111-111111111111';
const TARDE = '71707070-2222-2222-2222-222222222222';
const LOCAL_CEDO = '71aaaaaa-0000-0000-0000-000000000001';
const LOCAL_TARDE = '71aaaaaa-0000-0000-0000-000000000002';
const CORTE_CEDO = '71eeeeee-0000-0000-0000-000000000001';
const RUAN = '71bbbbbb-0000-0000-0000-000000000001';

/** Salvador, Rio Vermelho. */
const AQUI = { latitude: -12.9899, longitude: -38.4767 };

/**
 * Quinta-feira, 13:00 em Salvador (UTC−3).
 *
 * Fixo porque toda a suíte deste repositório injeta o relógio: com `new Date()`
 * o teste passaria hoje e falharia num domingo, e "disponível hoje" é
 * exatamente a regra que depende do dia da semana.
 */
const AGORA = new Date('2026-08-20T16:00:00Z');

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

const filtro = (parcial: Partial<FiltroDaBusca> = {}): FiltroDaBusca => ({
  de: AQUI,
  raioKm: 5,
  ordem: 'distancia',
  notaMinimaBps: null,
  precoMaximoCents: null,
  comodidades: [],
  somenteComClube: false,
  ...parcial,
});

const atualizarAmbas = async () => {
  await atualizarVitrine({ tenantId: CEDO, locationId: LOCAL_CEDO, agora: AGORA });
  await atualizarVitrine({ tenantId: TARDE, locationId: LOCAL_TARDE, agora: AGORA });
};

describeIfDb('o próximo horário do card', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  }, 30_000);

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await exec(`
      INSERT INTO tenants (id, name, published_at) VALUES
        ('${CEDO}', 'Barbearia da Manhã', now()),
        ('${TARDE}', 'Barbearia da Noite', now());

      INSERT INTO tenant_slugs (tenant_id, slug, is_primary) VALUES
        ('${CEDO}', 'barbearia-da-manha', true),
        ('${TARDE}', 'barbearia-da-noite', true);

      INSERT INTO locations (id, tenant_id, name, timezone, city, state, latitude, longitude)
      VALUES
        ('${LOCAL_CEDO}', '${CEDO}', 'Matriz', 'America/Bahia', 'Salvador', 'BA',
         ${AQUI.latitude}, ${AQUI.longitude}),
        ('${LOCAL_TARDE}', '${TARDE}', 'Única', 'America/Bahia', 'Salvador', 'BA',
         ${AQUI.latitude + 0.002}, ${AQUI.longitude});

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes) VALUES
        ('${CORTE_CEDO}', '${CEDO}', 'Corte', 5000, 30),
        ('71eeeeee-0000-0000-0000-000000000002', '${TARDE}', 'Corte', 6000, 30);

      INSERT INTO professionals (id, tenant_id, location_id, name, kind) VALUES
        ('${RUAN}', '${CEDO}', '${LOCAL_CEDO}', 'Ruan', 'professional'),
        ('71bbbbbb-0000-0000-0000-000000000002', '${TARDE}', '${LOCAL_TARDE}', 'Gleidson', 'professional');

      INSERT INTO professional_services (professional_id, service_id, tenant_id) VALUES
        ('${RUAN}', '${CORTE_CEDO}', '${CEDO}'),
        ('71bbbbbb-0000-0000-0000-000000000002', '71eeeeee-0000-0000-0000-000000000002', '${TARDE}');

      -- Quinta-feira (4). A da manhã abre 09:00–12:00 e portanto já fechou às
      -- 13:00. A da noite abre 14:00–20:00 e tem vaga daqui a uma hora.
      -- Sem ponto e vírgula dentro de comentário: o exec daqui parte por ele.
      INSERT INTO work_schedules (tenant_id, professional_id, weekday, start_minute, end_minute)
      VALUES
        ('${CEDO}', '${RUAN}', 4, 540, 720),
        ('${TARDE}', '71bbbbbb-0000-0000-0000-000000000002', 4, 840, 1200);

      -- Sexta-feira (5), para a da manhã ter "amanhã".
      INSERT INTO work_schedules (tenant_id, professional_id, weekday, start_minute, end_minute)
      VALUES ('${CEDO}', '${RUAN}', 5, 540, 720)
    `);
  }, 30_000);

  it('o card anuncia a próxima vaga, e ela é do mesmo motor da reserva', async () => {
    await atualizarAmbas();
    const busca = await buscarComHorario(filtro(), 'qualquer', AGORA);

    const noite = busca.resultados.find((r) => r.slug === 'barbearia-da-noite');
    // 14:00 na unidade é o primeiro horário depois das 13:00 de agora.
    expect(noite?.proximoHorario?.hora).toBe('14:00');
    expect(noite?.proximoHorario?.hoje).toBe(true);
  });

  it('quem já fechou hoje anuncia amanhã, não "sem horário"', async () => {
    /**
     * Quem busca às 13h e vê "sem horário" conclui que a barbearia não serve.
     * Amanhã às 09:00 é a informação que faz a pessoa clicar — e é por isso que
     * a janela do lote é de dois dias e não de um.
     */
    await atualizarAmbas();
    const busca = await buscarComHorario(filtro(), 'qualquer', AGORA);

    const manha = busca.resultados.find((r) => r.slug === 'barbearia-da-manha');
    expect(manha?.proximoHorario?.hoje).toBe(false);
    expect(manha?.proximoHorario?.hora).toBe('09:00');
  });

  it('"disponível hoje" tira quem só tem vaga amanhã', async () => {
    await atualizarAmbas();
    const hoje = await buscarComHorario(filtro(), 'hoje', AGORA);

    expect(hoje.resultados.map((r) => r.slug)).toEqual(['barbearia-da-noite']);
  });

  it('"disponível agora" é mais estreito que "hoje"', async () => {
    /**
     * A da noite abre às 14:00 — daqui a uma hora, dentro da janela do "agora".
     * Empurrando a abertura para as 17:00, ela continua tendo vaga **hoje** e
     * deixa de ter vaga **agora**: se os dois filtros dessem sempre a mesma
     * resposta, um deles não precisaria existir.
     */
    await exec(`
      UPDATE work_schedules SET start_minute = 1020
       WHERE tenant_id = '${TARDE}' AND weekday = 4
    `);
    await atualizarAmbas();

    const hoje = await buscarComHorario(filtro(), 'hoje', AGORA);
    const agora = await buscarComHorario(filtro(), 'agora', AGORA);

    expect(hoje.resultados.map((r) => r.slug)).toEqual(['barbearia-da-noite']);
    expect(agora.resultados).toEqual([]);
  });

  it('o horário é o do serviço que deu o preço do card', async () => {
    /**
     * Preço e horário no mesmo card falam da mesma coisa. Aqui a barba é mais
     * barata que o corte e só é vendida de manhã: o card tem que anunciar o
     * horário **da barba**, senão ele promete 14:00 por R$ 30 sobre um serviço
     * que às 14:00 não existe.
     */
    await exec(`
      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes)
      VALUES ('71eeeeee-0000-0000-0000-000000000009', '${TARDE}', 'Barba', 3000, 20);

      INSERT INTO professionals (id, tenant_id, location_id, name, kind)
      VALUES ('71bbbbbb-0000-0000-0000-000000000009', '${TARDE}', '${LOCAL_TARDE}', 'Só de manhã', 'professional');

      INSERT INTO professional_services (professional_id, service_id, tenant_id)
      VALUES ('71bbbbbb-0000-0000-0000-000000000009', '71eeeeee-0000-0000-0000-000000000009', '${TARDE}');

      -- Esta cadeira trabalha só na sexta: a barba não tem horário hoje.
      INSERT INTO work_schedules (tenant_id, professional_id, weekday, start_minute, end_minute)
      VALUES ('${TARDE}', '71bbbbbb-0000-0000-0000-000000000009', 5, 480, 600)
    `);
    await atualizarAmbas();

    const busca = await buscarComHorario(filtro(), 'qualquer', AGORA);
    const noite = busca.resultados.find((r) => r.slug === 'barbearia-da-noite');

    expect(noite?.precoDeCents).toBe(3000);
    // Amanhã às 08:00, que é quando a barba existe — nunca 14:00, que é o corte.
    expect(noite?.proximoHorario?.hoje).toBe(false);
    expect(noite?.proximoHorario?.hora).toBe('08:00');
  });

  it('barbearia sem nada vendável online aparece com o card mudo', async () => {
    // Card mudo é a verdade; card com horário inventado é a agenda vendida duas
    // vezes. Ela continua na lista: quem quer só quem tem vaga usa o filtro.
    await exec(`UPDATE services SET bookable_online = false WHERE tenant_id = '${CEDO}'`);
    await atualizarAmbas();

    const busca = await buscarComHorario(filtro(), 'qualquer', AGORA);
    const manha = busca.resultados.find((r) => r.slug === 'barbearia-da-manha');

    expect(manha).toBeDefined();
    expect(manha?.proximoHorario).toBeNull();
    expect(manha?.precoDeCents).toBeNull();
  });

  it('a agenda de uma barbearia não vaza para o card da outra', async () => {
    /**
     * O lote abre uma transação por barbearia justamente porque a RLS é fixada
     * por transação. Um vazamento aqui apareceria como a casa fechada
     * anunciando o horário da vizinha — e a pessoa clicaria para não achar
     * nada.
     */
    await exec(`DELETE FROM work_schedules WHERE tenant_id = '${CEDO}'`);
    await atualizarAmbas();

    const busca = await buscarComHorario(filtro(), 'qualquer', AGORA);
    const manha = busca.resultados.find((r) => r.slug === 'barbearia-da-manha');
    const noite = busca.resultados.find((r) => r.slug === 'barbearia-da-noite');

    expect(manha?.proximoHorario).toBeNull();
    expect(noite?.proximoHorario?.hora).toBe('14:00');
  });
});
