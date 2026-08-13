import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { linhaDoTempoDaPlataforma } from './serie.js';

/**
 * A linha do tempo da plataforma contra Postgres real (bloco 62).
 *
 * O que só o banco prova: que o MRR mês a mês sai das faturas de fato pagas, que
 * a proporcional de uma troca de plano não vira receita recorrente, e que a
 * safra segue quem entrou no mesmo mês em vez de recortar a base por data.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const AGORA = new Date('2026-06-15T12:00:00Z');
let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

const barbearia = (n: number) => `62620000-0000-0000-0000-${String(n).padStart(12, '0')}`;

async function abrir(n: number): Promise<void> {
  await exec(`INSERT INTO tenants (id, name) VALUES ('${barbearia(n)}', 'Barbearia ${n}')`);
}

async function fatura(opcoes: {
  n: number;
  mes: string;
  cents?: number;
  status?: 'paid' | 'open' | 'void';
  kind?: 'subscription' | 'proration';
}): Promise<void> {
  const { n, mes, cents = 9900, status = 'paid', kind = 'subscription' } = opcoes;
  await exec(`
    INSERT INTO invoices (tenant_id, kind, status, plan_code, amount_cents,
                          period_start, period_end, due_at, paid_at)
    VALUES ('${barbearia(n)}', '${kind}', '${status}', 'essencial', ${cents},
            '${mes}-01T00:00:00Z', '${mes}-01T00:00:00Z'::timestamptz + interval '1 month',
            '${mes}-05T00:00:00Z',
            ${status === 'paid' ? `'${mes}-05T00:00:00Z'` : 'NULL'})
  `);
}

describeIfDb('a linha do tempo da plataforma', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
  });

  it('o MRR de cada mês é o que de fato foi pago naquele mês', async () => {
    /**
     * Não é o preço do plano vigente vezes quem está ativo hoje: esse número
     * reescreveria o passado toda vez que alguém mudasse de plano. O MRR de
     * março é o que foi cobrado e pago em março, e ele não muda mais.
     */
    await abrir(1);
    await abrir(2);
    await fatura({ n: 1, mes: '2026-04', cents: 9900 });
    await fatura({ n: 1, mes: '2026-05', cents: 9900 });
    await fatura({ n: 2, mes: '2026-05', cents: 19900 });

    const linha = await linhaDoTempoDaPlataforma(AGORA);
    const abril = linha.mrr.find((m) => m.mes === '2026-04');
    const maio = linha.mrr.find((m) => m.mes === '2026-05');
    expect(abril?.mrrCents).toBe(9900);
    expect(abril?.barbeariasPagantes).toBe(1);
    expect(maio?.mrrCents).toBe(29800);
    expect(maio?.barbeariasPagantes).toBe(2);
  });

  it('fatura aberta não entra no MRR', async () => {
    // "Cobramos" e "recebemos" são coisas diferentes, e é a segunda que paga a
    // folha da plataforma.
    await abrir(1);
    await fatura({ n: 1, mes: '2026-05', status: 'open' });

    const linha = await linhaDoTempoDaPlataforma(AGORA);
    expect(linha.mrr.find((m) => m.mes === '2026-05')).toBeUndefined();
  });

  it('a proporcional de uma troca de plano não é receita recorrente', async () => {
    /**
     * Incluí-la faria o MRR dar um pico no mês em que várias barbearias subiram
     * de plano — e o pico some no mês seguinte, sem ninguém ter cancelado nada.
     */
    await abrir(1);
    await fatura({ n: 1, mes: '2026-05', cents: 9900 });
    await fatura({ n: 1, mes: '2026-05', cents: 4000, kind: 'proration' });

    const linha = await linhaDoTempoDaPlataforma(AGORA);
    expect(linha.mrr.find((m) => m.mes === '2026-05')?.mrrCents).toBe(9900);
  });

  it('a safra segue quem entrou no mesmo mês, mês a mês', async () => {
    /**
     * É a única leitura que separa "o produto está retendo melhor" de "entrou
     * muita gente nova": uma retenção global sobe sozinha num mês de muitas
     * assinaturas novas, porque ninguém cancela no primeiro mês.
     */
    // Três entraram em março. Duas ficaram em abril, uma em maio.
    for (const n of [1, 2, 3]) {
      await abrir(n);
      await fatura({ n, mes: '2026-03' });
    }
    await fatura({ n: 1, mes: '2026-04' });
    await fatura({ n: 2, mes: '2026-04' });
    await fatura({ n: 1, mes: '2026-05' });

    const linha = await linhaDoTempoDaPlataforma(AGORA);
    const marco = linha.safras.find((s) => s.safra === '2026-03');
    expect(marco?.entraram).toBe(3);
    expect(marco?.retidas[0]).toBe(3);
    expect(marco?.retidas[1]).toBe(2);
    expect(marco?.retidas[2]).toBe(1);
  });

  it('o mês em que a safra inteira sumiu é zero, não um buraco', async () => {
    /**
     * Um vetor esparso desenharia a célula vazia como se o dado não existisse.
     * "Todas saíram" e "não sabemos" são coisas diferentes, e a primeira é a que
     * o dono da plataforma precisa ver.
     */
    await abrir(1);
    await fatura({ n: 1, mes: '2026-03' });
    // Nada em abril; voltou em maio.
    await fatura({ n: 1, mes: '2026-05' });

    const linha = await linhaDoTempoDaPlataforma(AGORA);
    const marco = linha.safras.find((s) => s.safra === '2026-03');
    expect(marco?.retidas[1]).toBe(0);
    expect(marco?.retidas[2]).toBe(1);
  });

  it('a safra é a da primeira fatura paga, não a de qualquer fatura', async () => {
    // Uma fatura aberta e nunca paga em janeiro não faz de janeiro a safra
    // desta barbearia: ela nunca chegou a ser cliente pagante ali.
    await abrir(1);
    await fatura({ n: 1, mes: '2026-01', status: 'open' });
    await fatura({ n: 1, mes: '2026-04' });

    const linha = await linhaDoTempoDaPlataforma(AGORA);
    expect(linha.safras.map((s) => s.safra)).toEqual(['2026-04']);
  });

  it('base vazia devolve listas vazias, não erro', async () => {
    const linha = await linhaDoTempoDaPlataforma(AGORA);
    expect(linha.mrr).toEqual([]);
    expect(linha.safras).toEqual([]);
    expect(linha.maiorMrrCents).toBe(0);
  });
});
