import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@barbearia/db';
import {
  ImportacaoError,
  analisarImportacao,
  aplicarImportacao,
  lerImportacao,
  listarImportacoes,
  reverterImportacao,
  varrerPreviewsVencidos,
} from './importacao.js';

/**
 * A importação de base contra Postgres real.
 *
 * Mock não prova nada do que importa aqui: a deduplicação é um índice único, o
 * isolamento é RLS, a reversão é um `DELETE` que precisa saber o que a
 * importação criou, e a idempotência é uma constraint parcial. Todos são
 * garantias do banco.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];

const TENANT = '11111111-1111-1111-1111-111111111111';
const RIVAL = '22222222-2222-2222-2222-222222222222';
const LOCATION = 'aaaaaaaa-0000-0000-0000-000000000001';
const RUAN = 'bbbbbbbb-0000-0000-0000-000000000001';
const GESTOR = 'dddddddd-0000-0000-0000-000000000001';
const AGORA = new Date('2026-08-08T12:00:00Z');
const ANO = 2026;

let admin: PrismaClient;
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

async function exec(client: PrismaClient, sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await client.$executeRawUnsafe(parte);
  }
}

/** Conteúdo real de exportação: acento, formato misto, linha estragada. */
const ARQUIVO = [
  'Nome;Celular;Data de Nascimento;Observações',
  'José Antônio da Silva;(71) 98888-7777;07/09/1985;Corta na tesoura',
  'Ana Paula;71 97777-6666;1990-03-12;',
  'Bruno Carvalho;(71) 8888-5555;;Sempre atrasa',
].join('\n');

describeIfDb('importação de base', () => {
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
      VALUES ('${RUAN}', '${TENANT}', '${LOCATION}', 'Ruan', 'professional');

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${GESTOR}', '${TENANT}', 'Matheus Cardoso', 'dono@domari.com.br', 'x', 'owner');
    `);
  });

  const analisar = (
    conteudo = ARQUIVO,
    tenantId = TENANT,
    fileName = 'clientes.csv',
    agora = AGORA,
  ) =>
    analisarImportacao({
      tenantId,
      staffId: GESTOR,
      fileName,
      conteudo,
      anoLimite: ANO,
      agora,
    });

  const aplicar = (importId: string, tenantId = TENANT) =>
    aplicarImportacao({
      tenantId,
      importId,
      staffId: GESTOR,
      staffName: 'Matheus Cardoso',
      agora: AGORA,
    });

  const reverter = (importId: string, tenantId = TENANT) =>
    reverterImportacao({
      tenantId,
      importId,
      staffId: GESTOR,
      staffName: 'Matheus Cardoso',
      agora: AGORA,
    });

  const clientes = () =>
    withTenant(TENANT, (tx) =>
      tx.$queryRaw<
        { name: string; phone_e164: string; birth_date: Date | null; accepts_marketing: boolean }[]
      >`SELECT name, phone_e164, birth_date, accepts_marketing FROM customers ORDER BY name`,
    );

  // -- o preview ---------------------------------------------------------------

  it('lê a exportação de verdade e conta o que vai entrar', async () => {
    const preview = await analisar();

    expect(preview.total).toBe(3);
    expect(preview.resumo.novo).toBe(3);
    expect(preview.separator).toBe(';');
    expect(preview.colunas).toMatchObject({ nome: 0, telefone: 1, nascimento: 2, observacao: 3 });
    expect(preview.status).toBe('previewed');
  });

  it('o preview não grava cliente nenhum', async () => {
    // "Preview antes de aplicar" só vale se o preview de fato não aplicar.
    await analisar();
    expect(await clientes()).toHaveLength(0);
  });

  it('recusa arquivo sem a coluna de telefone, dizendo qual falta', async () => {
    // Sem telefone não há identidade nem como avisar ninguém — importar seria
    // criar uma base que não serve para nada.
    const erro = await analisar('Nome;Endereço\nZé;Rua A').catch((e: ImportacaoError) => e);
    expect((erro as ImportacaoError).code).toBe('sem_coluna_de_telefone');
  });

  it('recusa arquivo só com cabeçalho', async () => {
    const erro = await analisar('Nome;Celular').catch((e: ImportacaoError) => e);
    expect((erro as ImportacaoError).code).toBe('arquivo_vazio');
  });

  it('recusa arquivo que não é CSV', async () => {
    const erro = await analisar('').catch((e: ImportacaoError) => e);
    expect((erro as ImportacaoError).code).toBe('csv_invalido');
  });

  it('mostra as linhas que pedem olho humano, não a base inteira', async () => {
    const preview = await analisar(
      [
        'Nome;Celular',
        'Zé;71988887777',
        'Ana;telefone-quebrado',
        ';71977776666',
        'Outro Nome;71988887777',
      ].join('\n'),
    );

    expect(preview.problemas.map((p) => p.veredito)).toEqual([
      'telefone_invalido',
      'sem_nome',
      'conflito',
    ]);
  });

  it('o preview sobrevive ao redirecionamento da tela', async () => {
    // A tela redireciona depois do envio e o arquivo não existe mais do outro
    // lado. Sem isto, o passo "confira antes de aplicar" mostraria a contagem
    // sem as linhas que pedem decisão — que são o motivo de o passo existir.
    const preview = await analisar(
      ['Nome;Celular', 'Zé;71988887777', 'Ana;telefone-quebrado'].join('\n'),
    );

    const relido = await lerImportacao({ tenantId: TENANT, importId: preview.id });
    expect(relido.status).toBe('previewed');
    expect(relido.resumo.novo).toBe(1);
    expect(relido.problemas.map((p) => p.veredito)).toEqual(['telefone_invalido']);
  });

  it('depois de aplicada, a importação não devolve mais nome nem telefone', async () => {
    const preview = await analisar();
    await aplicar(preview.id);

    const relido = await lerImportacao({ tenantId: TENANT, importId: preview.id });
    expect(relido.problemas).toEqual([]);
    expect(JSON.stringify(relido)).not.toContain('José');
  });

  it('a observação do sistema antigo vira a anotação da ficha', async () => {
    // Sem isto a coluna seria lida, aparada e jogada fora — campo que o motor
    // aceita e ninguém preenche. "Sempre atrasa" é o que o barbeiro precisa ler
    // antes de atender, e é onde essa frase mora desde o bloco 16.
    const preview = await analisar();
    await aplicar(preview.id);

    const fichas = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ observacoes: string; phone_e164: string }[]>`
        SELECT p.observacoes, c.phone_e164
          FROM customer_preferences p
          JOIN customers c ON c.id = p.customer_id
         ORDER BY c.phone_e164
      `,
    );

    expect(fichas).toHaveLength(2);
    expect(fichas.map((f) => f.observacoes)).toEqual(['Sempre atrasa', 'Corta na tesoura']);
  });

  it('a anotação do barbeiro vence a que veio do arquivo', async () => {
    await exec(admin, `
      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('cccccccc-0000-0000-0000-000000000001', '${TENANT}', 'Zé', '+5571988887777');

      INSERT INTO customer_preferences (customer_id, tenant_id, observacoes)
      VALUES ('cccccccc-0000-0000-0000-000000000001', '${TENANT}', 'Não usar navalha');
    `);

    const preview = await analisar();
    await aplicar(preview.id);

    const ficha = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ observacoes: string }[]>`
        SELECT observacoes FROM customer_preferences
         WHERE customer_id = 'cccccccc-0000-0000-0000-000000000001'::uuid
      `,
    );
    expect(ficha[0]?.observacoes).toBe('Não usar navalha');
  });

  it('preview abandonado não guarda dado pessoal para sempre', async () => {
    // O `payload` some ao aplicar, e o banco cobra. Faltava o caso de quem
    // confere e desiste: a cópia ficava sem prazo nenhum.
    const abandonado = await analisar();
    await admin.$executeRawUnsafe(`
      UPDATE imports SET created_at = now() - interval '30 days' WHERE id = '${abandonado.id}'
    `);

    // Qualquer importação nova faz a faxina.
    await analisar('Nome;Celular\nOutro;71966665555', TENANT, 'outra.csv');

    const guardado = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ payload: unknown; status: string }[]>`
        SELECT payload, status FROM imports WHERE id = ${abandonado.id}::uuid
      `,
    );
    expect(guardado[0]?.status).toBe('previewed');
    expect(guardado[0]?.payload).toBeNull();
  });

  it('preview recente continua conferível', async () => {
    // A faxina não pode comer o preview que a pessoa está olhando agora.
    const recente = await analisar();
    await analisar('Nome;Celular\nOutro;71966665555', TENANT, 'outra.csv');

    const relido = await lerImportacao({ tenantId: TENANT, importId: recente.id });
    expect(relido.status).toBe('previewed');

    const resultado = await aplicar(recente.id);
    expect(resultado.criados).toBe(3);
  });

  it('importação de outra barbearia não é legível', async () => {
    const preview = await analisar();
    const erro = await lerImportacao({ tenantId: RIVAL, importId: preview.id }).catch(
      (e: ImportacaoError) => e,
    );
    expect((erro as ImportacaoError).code).toBe('nao_encontrada');
  });

  // -- idempotência ------------------------------------------------------------

  it('reenviar o mesmo arquivo devolve a importação de antes, não uma nova', async () => {
    const primeira = await analisar();
    const segunda = await analisar(ARQUIVO, TENANT, 'clientes (1).csv');

    expect(segunda.id).toBe(primeira.id);
    expect(segunda.repetida).toBe(true);
    expect(await listarImportacoes({ tenantId: TENANT })).toHaveLength(1);
  });

  it('arquivo diferente é importação diferente', async () => {
    const primeira = await analisar();
    const segunda = await analisar('Nome;Celular\nOutro;71966665555', TENANT, 'outros.csv');

    expect(segunda.id).not.toBe(primeira.id);
  });

  it('aplicar duas vezes a mesma importação é recusado', async () => {
    const preview = await analisar();
    await aplicar(preview.id);

    const erro = await aplicar(preview.id).catch((e: ImportacaoError) => e);
    expect((erro as ImportacaoError).code).toBe('ja_aplicada');
    expect(await clientes()).toHaveLength(3);
  });

  // -- a aplicação -------------------------------------------------------------

  it('grava os clientes com telefone normalizado e aniversário', async () => {
    const preview = await analisar();
    const resultado = await aplicar(preview.id);

    expect(resultado).toEqual({ criados: 3, atualizados: 0 });

    const base = await clientes();
    expect(base.map((c) => c.phone_e164)).toEqual([
      '+5571977776666', // Ana Paula
      // Bruno veio com oito dígitos e ganhou o nono.
      '+5571988885555',
      '+5571988887777', // José Antônio
    ]);
    expect(base[2]?.birth_date?.toISOString().slice(0, 10)).toBe('1985-09-07');
  });

  it('nunca liga o consentimento de marketing', async () => {
    // É o que impede o erro que a SPEC §5.8 nomeia: importar mil e duzentos
    // clientes e disparar mil e duzentas mensagens no primeiro dia. Nenhuma
    // coluna do arquivo pode ligá-lo, porque consentimento precisa de data, IP
    // e versão do texto — e nada disso atravessa uma exportação.
    const preview = await analisar(
      'Nome;Celular;Aceita marketing;accepts_marketing\nZé;71988887777;SIM;true',
    );
    await aplicar(preview.id);

    const base = await clientes();
    expect(base[0]?.accepts_marketing).toBe(false);
  });

  it('quem já está na base não vira cliente novo', async () => {
    await exec(admin, `
      INSERT INTO customers (tenant_id, name, phone_e164)
      VALUES ('${TENANT}', 'Zé do bairro', '+5571988887777');
    `);

    const preview = await analisar();
    expect(preview.resumo.ja_existe).toBe(1);
    expect(preview.resumo.novo).toBe(2);

    const resultado = await aplicar(preview.id);
    expect(resultado).toEqual({ criados: 2, atualizados: 1 });
  });

  it('completa o que está vazio e não sobrescreve o que a casa já sabe', async () => {
    // O arquivo preenche buraco. Ele não corrige o nome que a recepção digitou
    // depois — o sistema antigo é a fonte mais velha, não a mais confiável.
    await exec(admin, `
      INSERT INTO customers (tenant_id, name, phone_e164)
      VALUES ('${TENANT}', 'Zé do bairro', '+5571988887777');
    `);

    const preview = await analisar();
    await aplicar(preview.id);

    const base = await clientes();
    const ze = base.find((c) => c.phone_e164 === '+5571988887777');
    expect(ze?.name).toBe('Zé do bairro');
    // O aniversário estava vazio, então entra.
    expect(ze?.birth_date?.toISOString().slice(0, 10)).toBe('1985-09-07');
  });

  it('o mesmo telefone em três formatos entra como uma pessoa só', async () => {
    const preview = await analisar(
      [
        'Nome;Celular',
        'Zé da Silva;(71) 98888-7777',
        'Zé da Silva;71988887777',
        'Zé da Silva;+55 71 98888-7777',
      ].join('\n'),
    );
    await aplicar(preview.id);

    expect(await clientes()).toHaveLength(1);
  });

  it('a cópia dos dados pessoais some quando a importação é aplicada', async () => {
    const preview = await analisar();
    await aplicar(preview.id);

    const guardado = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ payload: unknown }[]>`
        SELECT payload FROM imports WHERE id = ${preview.id}::uuid
      `,
    );
    expect(guardado[0]?.payload).toBeNull();
  });

  it('a aplicação fica na trilha, com a contagem e sem os nomes', async () => {
    const preview = await analisar();
    await aplicar(preview.id);

    const eventos = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ action: string; actor_name: string; after: unknown }[]>`
        SELECT action, actor_name, after FROM audit_log ORDER BY id DESC LIMIT 1
      `,
    );

    expect(eventos[0]).toMatchObject({ action: 'import.applied', actor_name: 'Matheus Cardoso' });
    expect(eventos[0]?.after).toMatchObject({ criados: 3 });
    expect(JSON.stringify(eventos[0]?.after)).not.toContain('José');
  });

  // -- a reversão --------------------------------------------------------------

  it('desfaz a importação inteira', async () => {
    const preview = await analisar();
    await aplicar(preview.id);

    const { apagados } = await reverter(preview.id);
    expect(apagados).toBe(3);
    expect(await clientes()).toHaveLength(0);
  });

  it('desfazer não apaga quem já era cliente antes', async () => {
    // Ele foi completado pela importação, não criado por ela. Apagá-lo seria
    // usar o desfazer para sumir com gente da casa.
    await exec(admin, `
      INSERT INTO customers (tenant_id, name, phone_e164)
      VALUES ('${TENANT}', 'Zé do bairro', '+5571988887777');
    `);

    const preview = await analisar();
    await aplicar(preview.id);
    const { apagados } = await reverter(preview.id);

    expect(apagados).toBe(2);
    const base = await clientes();
    expect(base).toHaveLength(1);
    expect(base[0]?.name).toBe('Zé do bairro');
  });

  it('recusa desfazer quando algum importado já marcou horário', async () => {
    const preview = await analisar();
    await aplicar(preview.id);

    const alvo = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM customers WHERE phone_e164 = '+5571988887777'
      `,
    );

    await exec(admin, `
      INSERT INTO appointments
        (tenant_id, location_id, customer_id, professional_id,
         starts_at, ends_at, service_starts_at, service_ends_at)
      VALUES ('${TENANT}', '${LOCATION}', '${alvo[0]?.id}', '${RUAN}',
              '2026-08-10T13:00:00Z', '2026-08-10T13:30:00Z',
              '2026-08-10T13:00:00Z', '2026-08-10T13:30:00Z');
    `);

    const erro = await reverter(preview.id).catch((e: ImportacaoError) => e);
    expect((erro as ImportacaoError).code).toBe('tem_movimento');
    expect((erro as ImportacaoError).detalhe).toEqual({ clientes: 1 });

    // Recusou inteira: ninguém foi apagado.
    expect(await clientes()).toHaveLength(3);
  });

  it('não desfaz o que nunca foi aplicado', async () => {
    const preview = await analisar();
    const erro = await reverter(preview.id).catch((e: ImportacaoError) => e);
    expect((erro as ImportacaoError).code).toBe('nao_aplicada');
  });

  it('não desfaz duas vezes', async () => {
    const preview = await analisar();
    await aplicar(preview.id);
    await reverter(preview.id);

    const erro = await reverter(preview.id).catch((e: ImportacaoError) => e);
    expect((erro as ImportacaoError).code).toBe('nao_aplicada');
  });

  it('depois de desfeita, o mesmo arquivo pode ser importado de novo', async () => {
    const primeira = await analisar();
    await aplicar(primeira.id);
    await reverter(primeira.id);

    const segunda = await analisar();
    expect(segunda.id).not.toBe(primeira.id);
    expect(segunda.repetida).toBe(false);
  });

  it('a reversão fica na trilha', async () => {
    const preview = await analisar();
    await aplicar(preview.id);
    await reverter(preview.id);

    const eventos = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ action: string }[]>`
        SELECT action FROM audit_log ORDER BY id DESC LIMIT 1
      `,
    );
    expect(eventos[0]?.action).toBe('import.reverted');
  });

  // -- tenant ------------------------------------------------------------------

  it('a importação de uma barbearia não é vista nem desfeita pela outra', async () => {
    const preview = await analisar();
    await aplicar(preview.id);

    expect(await listarImportacoes({ tenantId: RIVAL })).toHaveLength(0);

    // Id conhecido, tenant errado: a RLS esconde a linha e o caso vira "não
    // existe" — nunca "existe e você não pode".
    const erro = await reverter(preview.id, RIVAL).catch((e: ImportacaoError) => e);
    expect((erro as ImportacaoError).code).toBe('nao_encontrada');
    expect(await clientes()).toHaveLength(3);
  });

  it('a rival importa o mesmo arquivo sem ver os clientes da vizinha', async () => {
    const preview = await analisar();
    await aplicar(preview.id);

    // Mesmo conteúdo, outra barbearia: a trava de idempotência é por tenant.
    const dela = await analisar(ARQUIVO, RIVAL);
    expect(dela.resumo.novo).toBe(3);
    expect(dela.repetida).toBe(false);
  });

  describe('o preview abandonado vence', () => {
    /**
     * O caso que nenhuma das duas metades pegava sozinha.
     *
     * A limpeza pegava carona no início da **próxima** análise, então só
     * alcançava quem volta. A barbearia que sobe o CSV, olha a conferência e
     * some — que é o caso mais provável — deixava nome, telefone e aniversário
     * da base legada inteira guardados para sempre, de gente que talvez nunca
     * vire cliente.
     */
    it('a varredura diária apaga o payload de quem nunca mais voltou', async () => {
      const preview = await analisar();

      const guardado = () =>
        withTenant(TENANT, (tx) =>
          tx.$queryRaw<{ tem: boolean; status: string; criado: Date }[]>`
            SELECT payload IS NOT NULL AS tem, status, created_at AS criado
              FROM imports WHERE id = ${preview.id}::uuid
          `,
        );

      const linha = (await guardado())[0];
      expect(linha?.tem, 'o preview nasce com o arquivo guardado').toBe(true);

      /**
       * O relógio da varredura é ancorado no **`created_at` da linha**, não no
       * `AGORA` do teste.
       *
       * `created_at` é escrito pelo `DEFAULT` do banco, com o relógio do
       * processo — e `AGORA` é uma data fixa duas semanas no passado. Somar oito
       * dias a ela dá um instante **anterior** ao da linha, e a varredura não
       * pegaria nada: o teste mediria zero achando que mede a expiração.
       */
      const nasceu = linha!.criado.getTime();

      // Seis dias depois ainda serve: o dono foi conferir com alguém e volta.
      await varrerPreviewsVencidos(TENANT, new Date(nasceu + 6 * 86400000));
      expect((await guardado())[0]?.tem, 'seis dias estão dentro do prazo').toBe(true);

      const linhas = await varrerPreviewsVencidos(TENANT, new Date(nasceu + 8 * 86400000));
      expect(linhas).toBe(1);

      const depois = (await guardado())[0];
      expect(depois?.tem).toBe(false);
      // A linha fica: é ela que torna a importação reversível por `import_id`.
      expect(depois?.status).toBe('previewed');
    });

    it('não alcança a barbearia vizinha', async () => {
      // `imports` tem RLS, e é por isso que isto é tarefa por barbearia e não
      // varredura de plataforma. O teste é o de sempre: mandar o id da vizinha.
      const preview = await analisar();
      const nasceu = (
        await withTenant(TENANT, (tx) =>
          tx.$queryRaw<{ criado: Date }[]>`
            SELECT created_at AS criado FROM imports WHERE id = ${preview.id}::uuid
          `,
        )
      )[0]!.criado.getTime();

      // Vencido de sobra: o zero abaixo só pode ser a RLS. Com o relógio errado
      // ele seria zero pelo prazo, e o teste passaria pelo motivo errado.
      const linhas = await varrerPreviewsVencidos(RIVAL, new Date(nasceu + 8 * 86400000));
      expect(linhas).toBe(0);

      const ainda = await withTenant(TENANT, (tx) =>
        tx.$queryRaw<{ tem: boolean }[]>`
          SELECT payload IS NOT NULL AS tem FROM imports WHERE id = ${preview.id}::uuid
        `,
      );
      expect(ainda[0]?.tem).toBe(true);
    });
  });
});
