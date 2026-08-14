import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  adotarItemDoPadrao,
  despublicarItemDoPadrao,
  franquiaDaCasa,
  padraoDaFranquia,
  publicarItemDoPadrao,
} from './franquia.js';

/**
 * Franquia contra Postgres real (bloco 76).
 *
 * O que só o banco prova: que a franqueada **não** escreve o padrão, que o
 * padrão de uma rede não vaza para outra, e que republicar não move o preço de
 * ninguém — que é a regra do bloco inteiro.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const DONA = '76767676-1111-1111-1111-111111111111';
const FILHA = '76767676-2222-2222-2222-222222222222';
const ALHEIA = '76767676-3333-3333-3333-333333333333';
const REDE = '76767676-aaaa-1111-1111-111111111111';
const OUTRA_REDE = '76767676-bbbb-1111-1111-111111111111';

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

describeIfDb('o padrão da franquia', () => {
  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await admin.$executeRawUnsafe('TRUNCATE tenants CASCADE');
    await admin.$executeRawUnsafe('TRUNCATE franchises CASCADE');
    await exec(`
      INSERT INTO tenants (id, name) VALUES
        ('${DONA}', 'Barbearia Dock'),
        ('${FILHA}', 'Dock Feira'),
        ('${ALHEIA}', 'Outra Casa');

      INSERT INTO franchises (id, name) VALUES
        ('${REDE}', 'Rede Dock'),
        ('${OUTRA_REDE}', 'Rede Vizinha');

      INSERT INTO franchise_tenants (tenant_id, franchise_id, role) VALUES
        ('${DONA}', '${REDE}', 'franqueadora'),
        ('${FILHA}', '${REDE}', 'franqueada'),
        ('${ALHEIA}', '${OUTRA_REDE}', 'franqueadora')
    `);
  });

  it('a franqueadora publica; a franqueada lê e não publica', async () => {
    const id = await publicarItemDoPadrao(DONA, {
      nome: 'Corte social',
      descricao: 'Máquina e tesoura',
      referenciaCents: 5500,
      duracaoMinutos: 30,
      categoria: 'Cabelo',
      posicao: 0,
    });
    expect(id).toBeTruthy();

    const daFilha = await padraoDaFranquia(FILHA);
    expect(daFilha.map((i) => i.nome)).toEqual(['Corte social']);
    expect(daFilha[0]?.referenciaCents).toBe(5500);

    await expect(
      publicarItemDoPadrao(FILHA, {
        nome: 'Corte de graça',
        descricao: null,
        referenciaCents: 0,
        duracaoMinutos: 30,
        categoria: null,
        posicao: 0,
      }),
    ).rejects.toThrow(/franqueadora/i);
  });

  it('o padrão de uma rede não aparece na outra', async () => {
    // A RLS separa franquias pela participação, e a consulta roda sem filtro de
    // propósito: um `WHERE` repetido mascararia política ausente.
    await publicarItemDoPadrao(DONA, {
      nome: 'Só da Dock',
      descricao: null,
      referenciaCents: 5500,
      duracaoMinutos: 30,
      categoria: null,
      posicao: 0,
    });
    await publicarItemDoPadrao(ALHEIA, {
      nome: 'Só da Vizinha',
      descricao: null,
      referenciaCents: 4500,
      duracaoMinutos: 30,
      categoria: null,
      posicao: 0,
    });

    expect((await padraoDaFranquia(DONA)).map((i) => i.nome)).toEqual(['Só da Dock']);
    expect((await padraoDaFranquia(ALHEIA)).map((i) => i.nome)).toEqual(['Só da Vizinha']);
  });

  it('adotar copia o preço uma vez, e republicar não o move nunca', async () => {
    /**
     * A regra do bloco. A franqueada adota a R$ 55, baixa para R$ 45 porque é o
     * preço da praça dela, e a franqueadora sobe o padrão para R$ 75. Se o
     * preço dela mudasse, a barbearia descobriria pelo cliente que o corte subiu
     * — e isso é imposição de preço de revenda, que é infração à ordem econômica
     * (Lei 12.529/2011 art. 36 §3º IX).
     */
    const item = await publicarItemDoPadrao(DONA, {
      nome: 'Corte social',
      descricao: 'Máquina e tesoura',
      referenciaCents: 5500,
      duracaoMinutos: 30,
      categoria: 'Cabelo',
      posicao: 0,
    });

    const { serviceId, novo } = await adotarItemDoPadrao(FILHA, item);
    expect(novo).toBe(true);

    const [criado] = await admin.$queryRawUnsafe<{ price_cents: number; name: string }[]>(
      `SELECT price_cents, name FROM services WHERE id = '${serviceId}'`,
    );
    expect(Number(criado?.price_cents)).toBe(5500);

    await exec(`UPDATE services SET price_cents = 4500 WHERE id = '${serviceId}'`);

    await publicarItemDoPadrao(DONA, {
      id: item,
      nome: 'Corte social premium',
      descricao: 'Máquina, tesoura e navalha',
      referenciaCents: 7500,
      duracaoMinutos: 40,
      categoria: 'Cabelo',
      posicao: 0,
    });

    const [depois] = await admin.$queryRawUnsafe<{ price_cents: number; name: string }[]>(
      `SELECT price_cents, name FROM services WHERE id = '${serviceId}'`,
    );
    expect(Number(depois?.price_cents)).toBe(4500);
    // Nem o nome desce sozinho: um lado publica, o outro decide se aplica.
    expect(depois?.name).toBe('Corte social');

    // E a tela mostra a distância, sem adjetivo.
    const visto = await padraoDaFranquia(FILHA);
    expect(visto[0]?.adotadoComo?.praticadoCents).toBe(4500);
    expect(visto[0]?.adotadoComo?.distancia?.sentido).toBe('abaixo');
    expect(visto[0]?.adotadoComo?.distancia?.relevante).toBe(true);

    // Readotar aplica nome e duração — e continua não aplicando o preço.
    const denovo = await adotarItemDoPadrao(FILHA, item);
    expect(denovo.novo).toBe(false);
    const [aplicado] = await admin.$queryRawUnsafe<{ price_cents: number; name: string }[]>(
      `SELECT price_cents, name FROM services WHERE id = '${serviceId}'`,
    );
    expect(aplicado?.name).toBe('Corte social premium');
    expect(Number(aplicado?.price_cents)).toBe(4500);
  });

  it('o item de outra franquia não é adotável', async () => {
    /**
     * A chave estrangeira aceita o id alheio sem reclamar: a checagem de
     * integridade referencial do Postgres roda como dono e ignora row security.
     * Quem recusa é a leitura sob RLS, feita antes de gravar.
     */
    const alheio = await publicarItemDoPadrao(ALHEIA, {
      nome: 'Da vizinha',
      descricao: null,
      referenciaCents: 4500,
      duracaoMinutos: 30,
      categoria: null,
      posicao: 0,
    });

    await expect(adotarItemDoPadrao(FILHA, alheio)).rejects.toThrow(/não encontrado/i);
  });

  it('despublicar tira do padrão e deixa quem já vende vendendo', async () => {
    const item = await publicarItemDoPadrao(DONA, {
      nome: 'Corte social',
      descricao: null,
      referenciaCents: 5500,
      duracaoMinutos: 30,
      categoria: null,
      posicao: 0,
    });
    const { serviceId } = await adotarItemDoPadrao(FILHA, item);

    await despublicarItemDoPadrao(DONA, item);

    const [servico] = await admin.$queryRawUnsafe<{ active: boolean }[]>(
      `SELECT active FROM services WHERE id = '${serviceId}'`,
    );
    expect(servico?.active).toBe(true);
    expect((await padraoDaFranquia(FILHA)).filter((i) => i.ativo)).toHaveLength(0);
  });

  it('barbearia fora de franquia não vê padrão nenhum, e não quebra', async () => {
    await exec(`DELETE FROM franchise_tenants WHERE tenant_id = '${FILHA}'`);
    expect(await franquiaDaCasa(FILHA)).toBeNull();
    expect(await padraoDaFranquia(FILHA)).toEqual([]);
  });
});
