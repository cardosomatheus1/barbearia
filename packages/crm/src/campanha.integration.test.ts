import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  atribuirReceita,
  campanhasDaCasa,
  criarCampanha,
  despacharCampanha,
  marcarParaEnvio,
} from './campanha.js';

/**
 * Campanhas contra Postgres real (bloco 57, SPEC §4.13).
 *
 * O que só o banco prova: que o público é **congelado** na criação, que a
 * campanha respeita as mesmas proteções da automação, e que a receita atribuída
 * — *"a única coluna que importa"* — só conta o que veio dentro da janela.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '57575757-1111-1111-1111-111111111111';
const LOCAL = 'a7575757-0000-0000-0000-000000000001';
const CARLOS = 'c7575757-0000-0000-0000-000000000001';
const BRUNO = 'c7575757-0000-0000-0000-000000000002';
const SUMIDO = 'c7575757-0000-0000-0000-000000000003';
const DONO = 'd7575757-0000-0000-0000-000000000001';
const RUAN = 'e7575757-0000-0000-0000-000000000001';

const AGORA = new Date('2026-09-20T15:00:00Z');
const operador = { staffId: DONO, staffName: 'Matheus' };

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

describeIfDb('campanhas', () => {
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

      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('${LOCAL}', '${TENANT}', 'Matriz', 'America/Bahia');

      INSERT INTO customers (id, tenant_id, name, phone_e164, accepts_marketing) VALUES
        ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777', true),
        ('${BRUNO}', '${TENANT}', 'Bruno Lima', '+5571977776666', true),
        ('${SUMIDO}', '${TENANT}', 'João Sumido', '+5571966665555', true);

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${DONO}', '${TENANT}', 'Matheus', 'dono@domari.com.br', 'x', 'owner');

      INSERT INTO professionals (id, tenant_id, location_id, name, kind)
      VALUES ('${RUAN}', '${TENANT}', '${LOCAL}', 'Ruan', 'professional');
    `);
  });

  const campanha = (extra: Record<string, unknown> = {}) =>
    criarCampanha({
      tenantId: TENANT,
      nome: 'Terça vazia',
      filtro: 'todos',
      valorDoFiltro: null,
      diaDaSemana: null,
      tipo: 'retorno',
      janelaDias: 7,
      agora: AGORA,
      ...operador,
      ...extra,
    });

  const atendimento = async (customerId: string, diasAtras: number, id: string) => {
    const inicio = new Date(AGORA.getTime() - diasAtras * 86_400_000);
    const fim = new Date(inicio.getTime() + 30 * 60_000);
    await exec(`
      INSERT INTO appointments
        (id, tenant_id, location_id, professional_id, customer_id, status,
         starts_at, ends_at, service_starts_at, service_ends_at)
      VALUES ('${id}', '${TENANT}', '${LOCAL}', '${RUAN}', '${customerId}', 'completed',
              '${inicio.toISOString()}', '${fim.toISOString()}',
              '${inicio.toISOString()}', '${fim.toISOString()}');
    `);
  };

  it('o público é congelado na criação', async () => {
    /**
     * Guardar o filtro faria "quantos receberam" mudar toda vez que alguém
     * fosse cadastrado — e a receita atribuída, que é lida contra esse
     * conjunto, mudaria junto.
     */
    const criada = await campanha();
    expect(criada.publico).toBe(3);

    await exec(`
      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('c7575757-0000-0000-0000-0000000000ff', '${TENANT}', 'Novo', '+5571900000001');
    `);

    const lista = await campanhasDaCasa(TENANT);
    expect(lista[0]?.publico).toBe(3);
  });

  it('quem foi anonimizado e quem não tem telefone ficam fora', async () => {
    // Eles entrariam no público para serem pulados no envio, inflando "quantos
    // receberam" com gente que nunca poderia receber.
    //
    // O telefone só pode ser nulo em quem foi anonimizado — há `CHECK` desde o
    // bloco 34 —, então o caminho do teste é o de verdade: anonimizar.
    /**
     * Numa transação só, e com o contexto local a ela — como `withTenant`.
     *
     * Duas chamadas soltas pegam **duas conexões do pool**, e `set_config` com
     * `false` é da sessão: a segunda chegava numa conexão sem tenant e a função
     * respondia "exige app.tenant_id no contexto". Falhava uma vez a cada
     * tantas execuções, conforme o pool distribuísse — o mesmo motivo pelo qual
     * o produto inteiro só fala com o banco por `withTenant`.
     */
    await admin.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${TENANT}', true)`);
      await tx.$executeRawUnsafe(
        `SELECT anonimizar_cliente('${BRUNO}'::uuid, 'pedido de exclusão do titular')`,
      );
    });
    const criada = await campanha();
    expect(criada.publico).toBe(2);
  });

  it('o filtro de inativos só pega quem sumiu', async () => {
    await atendimento(CARLOS, 2, '17575757-0000-4000-8000-000000000001');
    await atendimento(BRUNO, 5, '17575757-0000-4000-8000-000000000002');

    const criada = await campanha({ filtro: 'inativos', valorDoFiltro: 30 });
    expect(criada.publico).toBe(1);
  });

  it('a célula fria pega quem costuma vir naquele horário', async () => {
    /**
     * O público certo é quem tem o **hábito** daquele horário, porque é quem
     * pode voltar a ele. Uma campanha para toda a base sobre uma terça às 14h é
     * ruído para quem só corta no sábado.
     */
    // 2026-09-15 é uma terça; 11h UTC é 8h em Salvador.
    await exec(`
      INSERT INTO appointments
        (id, tenant_id, location_id, professional_id, customer_id, status,
         starts_at, ends_at, service_starts_at, service_ends_at)
      VALUES ('17575757-0000-4000-8000-000000000003', '${TENANT}', '${LOCAL}', '${RUAN}',
              '${CARLOS}', 'completed',
              '2026-09-15T11:00:00Z', '2026-09-15T11:30:00Z',
              '2026-09-15T11:00:00Z', '2026-09-15T11:30:00Z');
    `);

    const criada = await campanha({ filtro: 'celula_fria', diaDaSemana: 2, valorDoFiltro: 8 });
    expect(criada.publico).toBe(1);

    // Outra hora do mesmo dia não pega ninguém.
    const outra = await campanha({
      nome: 'Outra hora',
      filtro: 'celula_fria',
      diaDaSemana: 2,
      valorDoFiltro: 17,
    });
    expect(outra.publico).toBe(0);
  });

  it('célula sem dia e hora é recusada', async () => {
    await expect(campanha({ filtro: 'celula_fria' })).rejects.toMatchObject({ code: 'invalida' });
  });

  it('o envio respeita o opt-out, e o motivo fica escrito', async () => {
    // Uma campanha que ignorasse as proteções porque "foi o dono que mandou"
    // seria a porta pela qual o número da barbearia queima.
    await exec(`UPDATE customers SET accepts_marketing = false`);
    const criada = await campanha();

    const resultado = await despacharCampanha({
      tenantId: TENANT,
      campanhaId: criada.id,
      agora: AGORA,
      timeZone: 'America/Bahia',
      enviar: async () => {
        throw new Error('ninguém aceita promoção');
      },
    });
    expect(resultado).toMatchObject({ enviados: 0, pulados: 3 });

    const motivos = await admin.$queryRawUnsafe<{ skipped_reason: string }[]>(
      `SELECT DISTINCT skipped_reason FROM campaign_targets`,
    );
    expect(motivos[0]?.skipped_reason).toBe('optou_por_nao_receber');
  });

  it('quem já recebeu campanha hoje não recebe outra', async () => {
    const primeira = await campanha({ nome: 'A' });
    await despacharCampanha({
      tenantId: TENANT,
      campanhaId: primeira.id,
      agora: AGORA,
      timeZone: 'America/Bahia',
      enviar: async () => null,
    });

    const segunda = await campanha({ nome: 'B' });
    const resultado = await despacharCampanha({
      tenantId: TENANT,
      campanhaId: segunda.id,
      agora: AGORA,
      timeZone: 'America/Bahia',
      enviar: async () => {
        throw new Error('todo mundo já recebeu hoje');
      },
    });
    expect(resultado.enviados).toBe(0);
  });

  it('as seis colunas saem da mesma consulta', async () => {
    const criada = await campanha();
    await despacharCampanha({
      tenantId: TENANT,
      campanhaId: criada.id,
      agora: AGORA,
      timeZone: 'America/Bahia',
      enviar: async () => null,
    });

    const lista = await campanhasDaCasa(TENANT);
    expect(lista[0]).toMatchObject({
      publico: 3,
      enviados: 3,
      entregues: 0,
      lidos: 0,
      cliques: 0,
      agendamentos: 0,
      receitaCents: 0,
      estado: 'enviada',
    });
  });

  it('a receita atribuída conta a venda dentro da janela, e congela o valor', async () => {
    /**
     * *"A última coluna é a única que importa."* Ela é congelada porque
     * recalcular na leitura faria o relatório de março mudar quando alguém
     * estornasse uma venda em maio.
     */
    const criada = await campanha({ janelaDias: 7 });
    await despacharCampanha({
      tenantId: TENANT,
      campanhaId: criada.id,
      agora: AGORA,
      timeZone: 'America/Bahia',
      enviar: async () => null,
    });

    // O carimbo é o relógio injetado, então a janela é contada a partir dele.
    const depois = new Date(AGORA.getTime() + 2 * 86_400_000).toISOString();

    await exec(`
      INSERT INTO orders (id, tenant_id, location_id, customer_id, status,
                          business_day, closed_at, total_cents)
      VALUES ('27575757-0000-4000-8000-000000000001', '${TENANT}', '${LOCAL}', '${CARLOS}',
              'paid', current_date, '${depois}', 8900);
    `);

    expect(await atribuirReceita({ tenantId: TENANT, agora: AGORA })).toBe(1);

    const lista = await campanhasDaCasa(TENANT);
    expect(lista[0]).toMatchObject({ agendamentos: 1, receitaCents: 8900 });
  });

  it('a venda fora da janela não é creditada', async () => {
    const criada = await campanha({ janelaDias: 7 });
    await despacharCampanha({
      tenantId: TENANT,
      campanhaId: criada.id,
      agora: AGORA,
      timeZone: 'America/Bahia',
      enviar: async () => null,
    });

    const tarde = new Date(AGORA.getTime() + 60 * 86_400_000).toISOString();

    await exec(`
      INSERT INTO orders (id, tenant_id, location_id, customer_id, status,
                          business_day, closed_at, total_cents)
      VALUES ('27575757-0000-4000-8000-000000000002', '${TENANT}', '${LOCAL}', '${CARLOS}',
              'paid', current_date, '${tarde}', 8900);
    `);

    expect(await atribuirReceita({ tenantId: TENANT, agora: AGORA })).toBe(0);
  });

  /**
   * A frase da SPEC §4.4 contra o banco, pelos dois caminhos.
   *
   * > *"Cliente que corta a cada 45 dias não está em risco no dia 30; cliente
   * > que corta a cada 15 já está. Regra fixa de '60 dias sem voltar' dispara
   * > campanha errada para metade da base."*
   *
   * Não basta provar que o público novo acerta: o teste roda o filtro antigo
   * sobre a **mesma** base e mostra que ele erra os dois — pega quem nunca veio
   * e deixa de fora quem está atrasado. É a diferença entre um filtro novo e o
   * filtro certo.
   */
  const ritmos = async () => {
    // Carlos corta a cada 45 dias, veio há 30: está no ritmo dele.
    await atendimento(CARLOS, 30, 'f0000000-0000-0000-0000-000000000001');
    await atendimento(CARLOS, 75, 'f0000000-0000-0000-0000-000000000002');
    await atendimento(CARLOS, 120, 'f0000000-0000-0000-0000-000000000003');
    await atendimento(CARLOS, 165, 'f0000000-0000-0000-0000-000000000004');
    // João corta a cada 15 e sumiu há 28: quase o dobro do ritmo dele.
    await atendimento(SUMIDO, 28, 'f0000000-0000-0000-0000-000000000011');
    await atendimento(SUMIDO, 43, 'f0000000-0000-0000-0000-000000000012');
    await atendimento(SUMIDO, 58, 'f0000000-0000-0000-0000-000000000013');
    await atendimento(SUMIDO, 73, 'f0000000-0000-0000-0000-000000000014');
    // Bruno nunca veio.
  };

  const publicoDe = async (campanhaId: string): Promise<readonly string[]> => {
    const linhas = await admin.$queryRawUnsafe<{ customer_id: string }[]>(
      `SELECT customer_id FROM campaign_targets WHERE campaign_id = '${campanhaId}'`,
    );
    return linhas.map((l) => l.customer_id);
  };

  it('o público "em risco" sai do ritmo de cada um', async () => {
    await ritmos();

    const criada = await campanha({ nome: 'Senti sua falta', filtro: 'em_risco' });
    expect(await publicoDe(criada.id)).toEqual([SUMIDO]);
  });

  it('o filtro de dias fixos erra os dois na mesma base', async () => {
    await ritmos();

    // Sessenta dias, o número que a SPEC cita: pega quem nunca veio e deixa
    // escapar exatamente quem está atrasado.
    const fixo = await campanha({ nome: 'Sumiu há 60 dias', filtro: 'inativos', valorDoFiltro: 60 });
    expect(await publicoDe(fixo.id)).toEqual([BRUNO]);
  });

  it('o público "quem mais gasta" precisa de base para existir', async () => {
    /**
     * Três clientes não têm decil superior — "o topo dos dez por cento" de três
     * pessoas é uma frase sobre uma. Com a base pequena o corte é nulo, ninguém
     * é VIP, e a campanha nasce com público zero em vez de nascer com o cliente
     * mais rico de uma base que não dá para comparar.
     */
    await ritmos();
    await exec(`
      INSERT INTO orders (tenant_id, location_id, customer_id, status,
                          subtotal_cents, total_cents, closed_at)
      VALUES ('${TENANT}', '${LOCAL}', '${CARLOS}', 'paid', 90000, 90000, now())
    `);

    const criada = await campanha({ nome: 'Obrigado', filtro: 'vip' });
    expect(criada.publico).toBe(0);
  });

  it('campanha é promoção mesmo com tipo transacional — o opt-out vale', async () => {
    /**
     * O furo que a `/security-review` deste bloco achou, e por que nenhum
     * teste podia pegá-lo antes: `naturezaDe` chama de **transacional** tudo
     * que não é `retorno`, e o opt-out e o teto do mês só rodam sobre
     * promocional. Com o seletor da tela oferecendo os seis tipos, uma
     * campanha declarada `lembrete_24h` mandava para a base inteira, incluindo
     * quem revogou o consentimento de marketing.
     *
     * O teste que existia — "o envio respeita o opt-out" — passava porque o
     * helper `campanha()` fixa `tipo: 'retorno'`, que é justamente o único
     * gated. **A semente precisa satisfazer tudo menos a regra sob teste**: aqui
     * ela cria a campanha pelo caminho que a borda recusaria, para provar a
     * camada de baixo.
     */
    await exec(`UPDATE customers SET accepts_marketing = false`);

    const criada = await campanha();
    // A borda e `criarCampanha` recusam o tipo transacional; a gravação direta
    // é o que permite exercitar a segunda camada, que é a que sobrevive a
    // alguém acrescentar um tipo à lista sem mexer em `naturezaDe`.
    await exec(`UPDATE campaigns SET kind = 'lembrete_24h' WHERE id = '${criada.id}'`);

    const resultado = await despacharCampanha({
      tenantId: TENANT,
      campanhaId: criada.id,
      agora: AGORA,
      timeZone: 'America/Bahia',
      enviar: async () => {
        throw new Error('não pode sair para quem revogou o marketing');
      },
    });

    expect(resultado.enviados).toBe(0);
    const motivos = await admin.$queryRawUnsafe<{ skipped_reason: string }[]>(
      `SELECT DISTINCT skipped_reason FROM campaign_targets`,
    );
    expect(motivos.map((m) => m.skipped_reason)).toEqual(['optou_por_nao_receber']);
  });

  it('a borda do domínio recusa texto que não é de campanha', async () => {
    // "Seu horário é amanhã" para quem não tem horário, e a senha de primeiro
    // acesso — que é credencial — como peça de marketing.
    await expect(campanha({ tipo: 'lembrete_24h' })).rejects.toThrow(/não serve para campanha/);
    await expect(campanha({ tipo: 'senha_de_acesso' })).rejects.toThrow(/não serve para campanha/);
  });

  it('o botão "Enviar" enfileira o despacho dentro da própria transação', async () => {
    /**
     * As três coisas são o mesmo fato: a campanha sai de rascunho, a trilha
     * registra quem mandou, e a tarefa nasce. Enfileirar depois do commit
     * abriria a janela em que a tela diz "enviando" e nada está agendado.
     */
    const criada = await campanha();
    expect(await marcarParaEnvio({ tenantId: TENANT, campanhaId: criada.id, ...operador })).toBe(
      true,
    );

    const tarefas = await admin.$queryRawUnsafe<{ kind: string; payload: { campanhaId: string } }[]>(
      `SELECT kind, payload FROM jobs WHERE tenant_id = '${TENANT}'::uuid`,
    );
    expect(tarefas).toEqual([
      { kind: 'campanha.enviar', payload: { campanhaId: criada.id } },
    ]);

    const trilha = await admin.$queryRawUnsafe<{ action: string }[]>(
      `SELECT action FROM audit_log WHERE entity = 'campaigns' ORDER BY created_at`,
    );
    expect(trilha.map((l) => l.action)).toEqual(['campaign.created', 'campaign.sent']);
  });

  it('o segundo toque não manda a mesma promoção de novo', async () => {
    /**
     * Quem barra é o **estado**, não uma chave: `AND status = 'rascunho'` no
     * `WHERE` segura o toque de outro aparelho, de outra sessão e com chave
     * nova — que é o que uma chave gerada pelo cliente não garante. É o
     * precedente do registro de sinal do bloco 38.
     *
     * Mandar duas vezes é como se queima o número: a mesma promoção chegando
     * em duplicidade é o que faz o cliente marcar como spam, e o índice de
     * qualidade caindo faz a Meta pausar o template da casa inteira.
     */
    const criada = await campanha();
    await marcarParaEnvio({ tenantId: TENANT, campanhaId: criada.id, ...operador });
    expect(await marcarParaEnvio({ tenantId: TENANT, campanhaId: criada.id, ...operador })).toBe(
      false,
    );

    const tarefas = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM jobs WHERE kind = 'campanha.enviar'`,
    );
    expect(Number(tarefas[0]!.n)).toBe(1);
  });

  it('campanha de outra barbearia não é despachável — a RLS não vê a linha', async () => {
    const criada = await campanha();
    const RIVAL = '57575757-2222-2222-2222-222222222222';
    await exec(`INSERT INTO tenants (id, name) VALUES ('${RIVAL}', 'Rival')`);

    expect(
      await marcarParaEnvio({ tenantId: RIVAL, campanhaId: criada.id, ...operador }),
    ).toBe(false);
  });

  it('o wamid volta para o alvo — é ele que liga o envio ao "entregue"', async () => {
    /**
     * A coluna existe desde o bloco 60 e ninguém a escrevia: "entregues" e
     * "lidos" na tela da campanha saem de um `JOIN` com `whatsapp_messages`
     * por `wamid`, e sem ele os dois números eram zero para sempre. Indicador
     * que nunca preenche é pior que indicador ausente — ele ocupa espaço
     * prometendo uma resposta que nunca vem (§6, pergunta 5).
     */
    const criada = await campanha();
    await despacharCampanha({
      tenantId: TENANT,
      campanhaId: criada.id,
      agora: AGORA,
      timeZone: 'America/Bahia',
      enviar: async (alvo) => `wamid.${alvo.customerId}`,
    });

    const alvos = await admin.$queryRawUnsafe<{ wamid: string | null }[]>(
      `SELECT wamid FROM campaign_targets ORDER BY wamid`,
    );
    expect(alvos.every((a) => a.wamid?.startsWith('wamid.'))).toBe(true);
  });

  it('envio pelo canal de reserva não inventa wamid', async () => {
    // `null` é o canal de reserva, e não falha: a SPEC §4.12 pede fallback em
    // letras. Um id inventado faria a tela contar como "entregue" o que a Meta
    // nunca viu.
    const criada = await campanha();
    await despacharCampanha({
      tenantId: TENANT,
      campanhaId: criada.id,
      agora: AGORA,
      timeZone: 'America/Bahia',
      enviar: async () => null,
    });

    const alvos = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM campaign_targets WHERE wamid IS NOT NULL`,
    );
    expect(Number(alvos[0]!.n)).toBe(0);
  });

  it('crédito exige mensagem enviada — o banco recusa o contrário', async () => {
    const criada = await campanha();
    void criada;
    await expect(
      admin.$executeRawUnsafe(`UPDATE campaign_targets SET goal_met_at = now()`),
    ).rejects.toThrow();
  });
});
