import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inicioDaJanela, resumoDaPlataforma, saudeDasBarbearias, ultimoDiaComMetricas } from './metricas.js';

/**
 * As métricas globais contra Postgres real.
 *
 * O agregado é escrito por `@barbearia/jobs`, que tem a própria suíte provando
 * que os números batem com a agenda. **Aqui** o que se prova é o outro lado: que
 * a leitura global soma o que deve, ignora o que deve, e não vira mais um
 * caminho para uma barbearia enxergar a outra.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const DOMARI = '25252525-aaaa-1111-1111-111111111111';
const RIVAL = '25252525-bbbb-2222-2222-222222222222';
const PARADA = '25252525-cccc-3333-3333-333333333333';

const ATE = '2026-09-30';

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

/** Um dia apurado, com os números que o teste quer distinguir. */
async function dia(
  tenantId: string,
  data: string,
  n: {
    agendamentos: number;
    online?: number;
    faltas?: number;
    vendidos?: number;
    disponiveis?: number;
    receita?: number;
  },
): Promise<void> {
  await exec(`
    INSERT INTO tenant_metrics_daily
      (tenant_id, business_day, appointments_total, appointments_online, no_shows,
       minutes_sold, minutes_available, revenue_cents)
    VALUES ('${tenantId}', '${data}', ${n.agendamentos}, ${n.online ?? 0}, ${n.faltas ?? 0},
            ${n.vendidos ?? 0}, ${n.disponiveis ?? 0}, ${n.receita ?? 0})
  `);
}

describe('a janela', () => {
  it('inclui as duas pontas — trinta dias até 30/09 começam em 01/09', () => {
    // Um erro de um dia aqui muda o denominador de todas as métricas do painel.
    expect(inicioDaJanela('2026-09-30', 30)).toBe('2026-09-01');
    expect(inicioDaJanela('2026-09-30', 1)).toBe('2026-09-30');
  });

  it('atravessa a virada do ano', () => {
    expect(inicioDaJanela('2026-01-05', 10)).toBe('2025-12-27');
  });
});

describeIfDb('métricas globais da plataforma', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await admin.$executeRawUnsafe('TRUNCATE tenant_lifecycle');

    // As três nasceram antes da janela: quem entrou no meio não deve pesar no
    // denominador do churn.
    await exec(`
      INSERT INTO tenants (id, name, created_at) VALUES
        ('${DOMARI}', 'Domari', '2026-01-10T12:00:00Z'),
        ('${RIVAL}', 'Rival', '2026-02-10T12:00:00Z'),
        ('${PARADA}', 'Parada', '2026-03-10T12:00:00Z');

      UPDATE tenant_platform SET created_at = '2026-01-10T12:00:00Z' WHERE tenant_id = '${DOMARI}';
      UPDATE tenant_platform SET created_at = '2026-02-10T12:00:00Z' WHERE tenant_id = '${RIVAL}';
      UPDATE tenant_platform SET created_at = '2026-03-10T12:00:00Z' WHERE tenant_id = '${PARADA}';

      UPDATE tenant_platform SET plan_id = (SELECT id FROM plans WHERE code = 'completo')
       WHERE tenant_id = '${DOMARI}';
      UPDATE tenant_platform SET plan_id = (SELECT id FROM plans WHERE code = 'essencial')
       WHERE tenant_id = '${RIVAL}';
    `);
  });

  it('usa o último dia realmente consolidado e não um dia apenas esperado pelo relógio', async () => {
    await dia(DOMARI, '2026-09-28', { agendamentos: 2 });
    await dia(RIVAL, '2026-09-29', { agendamentos: 3 });

    expect(await ultimoDiaComMetricas('2026-09-30')).toBe('2026-09-29');
  });

  it('sem métrica alguma preserva o fallback do corte operacional', async () => {
    expect(await ultimoDiaComMetricas('2026-09-30')).toBe('2026-09-30');
  });

  // -- assinatura -------------------------------------------------------------

  it('o MRR é a soma dos planos contratados, em centavos', async () => {
    const resumo = await resumoDaPlataforma({ ate: ATE });

    // Completo (19900) + Essencial (9900). A terceira está sem plano.
    expect(resumo.mrrCents).toBe(29800);
    expect(resumo.barbeariasAtivas).toBe(3);
    expect(resumo.semPlano).toBe(1);
  });

  it('conta bloqueada sai do MRR no mesmo instante', async () => {
    // MRR que inclui quem não paga é o número preferido de quem quer se
    // enganar. Ele tem que cair quando a conta cai.
    await exec(`
      UPDATE tenant_platform SET blocked_at = now(), blocked_reason = 'inadimplente'
       WHERE tenant_id = '${DOMARI}'
    `);

    const resumo = await resumoDaPlataforma({ ate: ATE });

    expect(resumo.mrrCents).toBe(9900);
    expect(resumo.barbeariasAtivas).toBe(2);
    expect(resumo.barbeariasBloqueadas).toBe(1);
  });

  // -- churn ------------------------------------------------------------------

  it('o churn é quem saiu no período sobre quem havia no começo dele', async () => {
    await exec(`
      INSERT INTO tenant_lifecycle (tenant_id, event, happened_at) VALUES
        ('${DOMARI}', 'blocked', '2026-09-15T12:00:00Z')
    `);

    const resumo = await resumoDaPlataforma({ ate: ATE });

    expect(resumo.saidasNoPeriodo).toBe(1);
    // 1 de 3 = 33%.
    expect(resumo.churnEmPontos).toBe(33);
  });

  it('quem entrou no meio do período não infla o denominador', async () => {
    // Contar sobre o total de hoje daria um churn **menor** que o real: quem
    // chegou depois nunca teve chance de sair no período, e ainda assim
    // engordaria a base. É como se maquia churn sem mentir em nenhum número.
    await exec(`
      INSERT INTO tenants (id, name, created_at)
      VALUES ('25252525-dddd-4444-4444-444444444444', 'Nova', '2026-09-20T12:00:00Z');
      UPDATE tenant_platform SET created_at = '2026-09-20T12:00:00Z'
       WHERE tenant_id = '25252525-dddd-4444-4444-444444444444';

      INSERT INTO tenant_lifecycle (tenant_id, event, happened_at) VALUES
        ('${DOMARI}', 'blocked', '2026-09-15T12:00:00Z')
    `);

    const resumo = await resumoDaPlataforma({ ate: ATE });

    expect(resumo.barbeariasAtivas).toBe(4);
    // Continua 1 de 3, não 1 de 4.
    expect(resumo.churnEmPontos).toBe(33);
  });

  it('saída fora da janela não entra na conta do período', async () => {
    await exec(`
      INSERT INTO tenant_lifecycle (tenant_id, event, happened_at) VALUES
        ('${DOMARI}', 'blocked', '2026-07-15T12:00:00Z')
    `);

    expect((await resumoDaPlataforma({ ate: ATE })).saidasNoPeriodo).toBe(0);
  });

  it('e a saída do último dia da janela entra — o intervalo é fechado nas duas pontas', async () => {
    // Uma janela aberta no fim perderia sempre o dia de ontem, que é o mais
    // recente que existe apurado. O erro passaria despercebido para sempre.
    await exec(`
      INSERT INTO tenant_lifecycle (tenant_id, event, happened_at) VALUES
        ('${DOMARI}', 'blocked', '2026-09-30T22:00:00Z')
    `);

    expect((await resumoDaPlataforma({ ate: ATE })).saidasNoPeriodo).toBe(1);
  });

  // -- operação ---------------------------------------------------------------

  it('soma a operação de todas as barbearias e calcula adoção, ocupação e falta', async () => {
    await dia(DOMARI, '2026-09-10', {
      agendamentos: 10, online: 6, faltas: 1, vendidos: 300, disponiveis: 600, receita: 50000,
    });
    await dia(RIVAL, '2026-09-10', {
      agendamentos: 10, online: 2, faltas: 3, vendidos: 100, disponiveis: 400, receita: 30000,
    });

    const resumo = await resumoDaPlataforma({ ate: ATE });

    expect(resumo.agendamentos).toBe(20);
    expect(resumo.adocaoOnlineEmPontos).toBe(40);
    expect(resumo.ocupacaoEmPontos).toBe(40);
    expect(resumo.faltasEmPontos).toBe(20);
    expect(resumo.receitaCents).toBe(80000);
    expect(resumo.barbeariasComMovimento).toBe(2);
  });

  it('dia fora da janela não é somado', async () => {
    await dia(DOMARI, '2026-09-10', { agendamentos: 10 });
    await dia(DOMARI, '2026-07-10', { agendamentos: 999 });

    expect((await resumoDaPlataforma({ ate: ATE, dias: 30 })).agendamentos).toBe(10);
  });

  it('plataforma sem nenhum dia apurado responde zero, não erro', async () => {
    // O estado do primeiro dia de operação, e o do worker parado. A tela precisa
    // dos dois desenhados, então a API não pode explodir em nenhum.
    const resumo = await resumoDaPlataforma({ ate: ATE });

    expect(resumo.agendamentos).toBe(0);
    expect(resumo.ocupacaoEmPontos).toBe(0);
    expect(resumo.adocaoOnlineEmPontos).toBe(0);
  });

  // -- a lista por barbearia --------------------------------------------------

  it('lista todas, inclusive quem não teve movimento nenhum', async () => {
    await dia(DOMARI, '2026-09-10', { agendamentos: 10, online: 5, receita: 50000 });

    const saude = await saudeDasBarbearias({ ate: ATE });

    expect(saude).toHaveLength(3);
    const parada = saude.find((s) => s.tenantId === PARADA);
    expect(parada?.agendamentos).toBe(0);
    // Nunca apurou nada: é diferente de ter apurado zero, e a tela mostra os
    // dois de forma diferente.
    expect(parada?.ultimoDia).toBeNull();
  });

  it('quem tem menos movimento vem primeiro, porque é quem está saindo', async () => {
    // Ordenar por faturamento — a ordem natural de quem constrói painel —
    // colocaria a barbearia prestes a cancelar no fim, onde ninguém rola.
    await dia(DOMARI, '2026-09-10', { agendamentos: 40 });
    await dia(RIVAL, '2026-09-10', { agendamentos: 5 });

    const saude = await saudeDasBarbearias({ ate: ATE });

    expect(saude.map((s) => s.tenantId)).toEqual([PARADA, RIVAL, DOMARI]);
  });

  it('cada linha traz o próprio número, não o da plataforma', async () => {
    await dia(DOMARI, '2026-09-10', {
      agendamentos: 10, online: 8, faltas: 1, vendidos: 300, disponiveis: 600, receita: 50000,
    });
    await dia(RIVAL, '2026-09-10', {
      agendamentos: 10, online: 1, faltas: 5, vendidos: 60, disponiveis: 600, receita: 10000,
    });

    const saude = await saudeDasBarbearias({ ate: ATE });
    const domari = saude.find((s) => s.tenantId === DOMARI);
    const rival = saude.find((s) => s.tenantId === RIVAL);

    expect(domari).toMatchObject({
      adocaoOnlineEmPontos: 80,
      ocupacaoEmPontos: 50,
      faltasEmPontos: 10,
      receitaCents: 50000,
      ultimoDia: '2026-09-10',
    });
    expect(rival).toMatchObject({
      adocaoOnlineEmPontos: 10,
      ocupacaoEmPontos: 10,
      faltasEmPontos: 50,
      receitaCents: 10000,
    });
  });

  it('o último dia é o último **com movimento**, não a última linha gravada', async () => {
    // O worker grava zeros todo dia, inclusive na barbearia que parou. Se o
    // "último dia" fosse a última linha, ninguém nunca pareceria parado — que é
    // exatamente o sinal que esta tela existe para dar.
    await dia(DOMARI, '2026-09-10', { agendamentos: 8 });
    await dia(DOMARI, '2026-09-29', { agendamentos: 0 });

    const saude = await saudeDasBarbearias({ ate: ATE });
    expect(saude.find((s) => s.tenantId === DOMARI)?.ultimoDia).toBe('2026-09-10');
  });
});
