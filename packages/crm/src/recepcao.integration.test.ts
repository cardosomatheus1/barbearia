import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  expirarTextoDaRecepcao,
  lacunasDaRecepcao,
  registrarLacuna,
  resolverLacuna,
} from './recepcao.js';

/**
 * O registro de lacunas contra Postgres real (bloco 66, SPEC §4.17).
 *
 * O que só o banco prova: que a mesma pergunta escrita de dois jeitos vira uma
 * linha com contador, que resolver é estado e não `DELETE`, e que perguntar de
 * novo reabre.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '66666666-1111-1111-1111-111111111111';
const DONO = 'd6666666-0000-0000-0000-000000000001';
const AGORA = new Date('2026-05-10T12:00:00Z');

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

describeIfDb('o registro de lacunas da recepção', () => {
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
      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${DONO}', '${TENANT}', 'Matheus', 'dono@domari.com.br', 'x', 'owner')
    `);
  });

  it('a mesma pergunta escrita de dois jeitos vira uma linha com contador', async () => {
    /**
     * Sem o agrupamento a lista teria cinquenta linhas de uma coisa só — que é
     * exatamente a tela que ninguém olha, e o oposto de "essa lista é, sozinha,
     * um produto útil".
     */
    await registrarLacuna(TENANT, 'Vocês abrem domingo?', AGORA);
    await registrarLacuna(TENANT, 'abrem no domingo', AGORA);
    await registrarLacuna(TENANT, 'VCS ABREM DOMINGO', AGORA);

    const lacunas = await lacunasDaRecepcao(TENANT);
    expect(lacunas).toHaveLength(1);
    expect(lacunas[0]?.vezes).toBe(3);
  });

  it('o texto mostrado é o mais recente, como a pessoa escreveu', async () => {
    // "vcs abre dmg" diz ao dono mais sobre o público dele que a versão que
    // alguém digitou certo três meses atrás.
    await registrarLacuna(TENANT, 'Vocês abrem domingo?', AGORA);
    await registrarLacuna(TENANT, 'vcs abrem domingo', AGORA);

    const lacunas = await lacunasDaRecepcao(TENANT);
    expect(lacunas[0]?.pergunta).toBe('vcs abrem domingo');
  });

  it('a lista vem da mais perguntada para a menos', async () => {
    await registrarLacuna(TENANT, 'aceitam pix', AGORA);
    for (let i = 0; i < 4; i += 1) await registrarLacuna(TENANT, 'posso levar meu filho', AGORA);

    const lacunas = await lacunasDaRecepcao(TENANT);
    expect(lacunas[0]?.pergunta).toContain('filho');
    expect(lacunas[0]?.vezes).toBe(4);
  });

  it('resolver é estado, e a linha continua no banco', async () => {
    /**
     * Apagar a pergunta que ninguém soube responder é apagar exatamente o dado
     * que esta tabela existe para produzir. E a aplicação nem tem o direito: há
     * `REVOKE DELETE`.
     */
    await registrarLacuna(TENANT, 'aceitam pix', AGORA);
    const [lacuna] = await lacunasDaRecepcao(TENANT);

    expect(
      await resolverLacuna({ tenantId: TENANT, lacunaId: lacuna!.id, staffUserId: DONO }),
    ).toBe(true);
    expect(await lacunasDaRecepcao(TENANT)).toHaveLength(0);

    const noBanco = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM reception_gaps`,
    );
    expect(Number(noBanco[0]?.n ?? 0)).toBe(1);
  });

  it('resolver duas vezes devolve falso na segunda', async () => {
    // O `UPDATE` é guardado por estado, e a contagem de linhas afetadas é
    // conferida — senão a tela diria "resolvido" sobre nada.
    await registrarLacuna(TENANT, 'aceitam pix', AGORA);
    const [lacuna] = await lacunasDaRecepcao(TENANT);
    await resolverLacuna({ tenantId: TENANT, lacunaId: lacuna!.id, staffUserId: DONO });
    expect(
      await resolverLacuna({ tenantId: TENANT, lacunaId: lacuna!.id, staffUserId: DONO }),
    ).toBe(false);
  });

  it('perguntar de novo reabre a lacuna resolvida', async () => {
    /**
     * O dono marcou como resolvida e alguém continua sem resposta: ela volta para
     * a lista. Sem isto, resolver errado esconde a pergunta para sempre — e o
     * cliente seguinte continua sem resposta, invisível.
     */
    await registrarLacuna(TENANT, 'aceitam pix', AGORA);
    const [lacuna] = await lacunasDaRecepcao(TENANT);
    await resolverLacuna({ tenantId: TENANT, lacunaId: lacuna!.id, staffUserId: DONO });
    expect(await lacunasDaRecepcao(TENANT)).toHaveLength(0);

    await registrarLacuna(TENANT, 'vocês aceitam pix?', AGORA);
    const depois = await lacunasDaRecepcao(TENANT);
    expect(depois).toHaveLength(1);
    expect(depois[0]?.vezes).toBe(2);
  });

  it('a aplicação não consegue apagar a lacuna', async () => {
    await registrarLacuna(TENANT, 'aceitam pix', AGORA);
    // O role da aplicação não tem `DELETE` nesta tabela — a garantia mora no
    // banco, não numa validação que alguém pode esquecer.
    const direito = await admin.$queryRawUnsafe<{ tem: boolean }[]>(
      `SELECT has_table_privilege('barbearia_app', 'reception_gaps', 'DELETE') AS tem`,
    );
    expect(direito[0]?.tem).toBe(false);
  });

  it('pergunta que não vira chave não é registrada', async () => {
    // "???" agruparia toda pergunta ininteligível numa linha só, escondendo que
    // são coisas diferentes e enchendo a tela com o que não dá para agir.
    await registrarLacuna(TENANT, '???', AGORA);
    await registrarLacuna(TENANT, 'oi', AGORA);
    expect(await lacunasDaRecepcao(TENANT)).toHaveLength(0);
  });

  it('o texto cru vence, e a linha continua contando', async () => {
    /**
     * Nada impede alguém de digitar "meu nome é Ana, telefone tal" dentro da
     * pergunta — e sem `customer_id` esse texto não é alcançável por
     * `anonimizar_cliente` nem sai na exportação do titular. Cópia de dado
     * pessoal fora de `customers` vive com prazo, como `imports.payload`.
     *
     * O que **não** vence é a chave nem o contador: eles são o produto, e não
     * identificam ninguém.
     */
    await registrarLacuna(TENANT, 'meu nome é Ana, posso levar meu filho?', AGORA);
    const noventaEUmDias = new Date(AGORA.getTime() + 91 * 86_400_000);

    expect(await expirarTextoDaRecepcao({ tenantId: TENANT, agora: noventaEUmDias })).toBe(1);

    const [lacuna] = await lacunasDaRecepcao(TENANT);
    expect(lacuna?.pergunta).toBeNull();
    expect(lacuna?.chave).toContain('filho');
    expect(lacuna?.vezes).toBe(1);
  });

  it('o texto de quem ainda perguntam este mês não vence', async () => {
    // O prazo conta da **última vez** que perguntaram: uma pergunta que continua
    // chegando continua descrevendo o público de hoje.
    await registrarLacuna(TENANT, 'aceitam pix', AGORA);
    const dezDias = new Date(AGORA.getTime() + 10 * 86_400_000);

    expect(await expirarTextoDaRecepcao({ tenantId: TENANT, agora: dezDias })).toBe(0);
    expect((await lacunasDaRecepcao(TENANT))[0]?.pergunta).toBe('aceitam pix');
  });

  it('perguntar de novo devolve o texto, com prazo novo', async () => {
    // Ele volta porque é novo — e é a mesma instrução de sempre, sem caminho
    // especial para "ressuscitar" nada.
    await registrarLacuna(TENANT, 'aceitam pix', AGORA);
    const depois = new Date(AGORA.getTime() + 91 * 86_400_000);
    await expirarTextoDaRecepcao({ tenantId: TENANT, agora: depois });
    expect((await lacunasDaRecepcao(TENANT))[0]?.pergunta).toBeNull();

    await registrarLacuna(TENANT, 'vocês aceitam pix?', depois);
    expect((await lacunasDaRecepcao(TENANT))[0]?.pergunta).toBe('vocês aceitam pix?');
  });

  it('a barbearia vizinha não vê a lacuna desta', async () => {
    await registrarLacuna(TENANT, 'aceitam pix', AGORA);
    const daVizinha = await lacunasDaRecepcao('66666666-9999-9999-9999-999999999999');
    expect(daVizinha).toHaveLength(0);
  });
});
