import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  atribuirObjetivos,
  automacoesDaCasa,
  disparosAEnviar,
  marcarDisparoEnviado,
  definirAutomacaoAtiva,
  salvarAutomacao,
  varrerAutomacoes,
} from './automacao.js';

/**
 * O motor de automação contra Postgres real (bloco 56, SPEC §4.11).
 *
 * O que só o banco prova: que o mesmo fato não dispara duas vezes, que o
 * cliente não recebe duas automações no mesmo dia **nem por processos
 * diferentes**, e que o objetivo só é creditado dentro da janela.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '56565656-1111-1111-1111-111111111111';
const RIVAL = '56565656-2222-2222-2222-222222222222';
const LOCAL = 'a6565656-0000-0000-0000-000000000001';
const CARLOS = 'c6565656-0000-0000-0000-000000000001';
const BRUNO = 'c6565656-0000-0000-0000-000000000002';
const DONO = 'd6565656-0000-0000-0000-000000000001';
const RUAN = 'e6565656-0000-0000-0000-000000000001';
/** A automação de tipo que o produto passou a proibir, criada antes da guarda. */
const ANTIGA = 'f6565656-0000-0000-0000-000000000001';
/** Dois textos aprovados do mesmo tipo — o que o bloco 94 passou a permitir. */
const TEXTO_A = 'a7565656-0000-0000-0000-000000000001';
const TEXTO_B = 'a7565656-0000-0000-0000-000000000002';

const AGORA = new Date('2026-09-20T15:00:00Z');
const operador = { staffId: DONO, staffName: 'Matheus' };

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

describeIfDb('automação', () => {
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
      INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Domari'), ('${RIVAL}', 'Vizinha');

      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('${LOCAL}', '${TENANT}', 'Matriz', 'America/Bahia');

      INSERT INTO customers (id, tenant_id, name, phone_e164, accepts_marketing) VALUES
        ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777', true),
        ('${BRUNO}', '${TENANT}', 'Bruno Lima', '+5571977776666', true);

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role)
      VALUES ('${DONO}', '${TENANT}', 'Matheus', 'dono@domari.com.br', 'x', 'owner');

      INSERT INTO professionals (id, tenant_id, location_id, name, kind)
      VALUES ('${RUAN}', '${TENANT}', '${LOCAL}', 'Ruan', 'professional');
    `);
  });

  const automacao = (extra: Record<string, unknown> = {}) =>
    salvarAutomacao({
      tenantId: TENANT,
      nome: 'Volta, Carlos',
      gatilho: 'sem_retorno',
      limiar: 30,
      atrasoMinutos: 0,
      tipo: 'retorno',
      objetivo: 'agendamento',
      janelaDias: 7,
      ativa: true,
      ...operador,
      ...extra,
    });

  /**
   * Automação não manda texto transacional, e o motivo é o mesmo da campanha.
   *
   * `lembrete_24h` ignora o opt-out de marketing por ser o serviço contratado.
   * Numa automação — que dispara sozinha, para quem **não tem horário marcado**
   * — ele vira promoção mandada a quem revogou o consentimento, com um texto
   * que promete um horário que não existe. E `senha_de_acesso` é credencial.
   *
   * A campanha fechou essa lista no bloco 82; a automação ficou de fora, com o
   * mesmo seletor e a mesma consequência.
   */
  it('automação recusa texto que não é de campanha', async () => {
    await expect(automacao({ tipo: 'lembrete_24h' })).rejects.toMatchObject({ code: 'invalida' });
    await expect(automacao({ tipo: 'senha_de_acesso' })).rejects.toMatchObject({
      code: 'invalida',
    });
  });

  /**
   * Desligar não pode depender de o resto da linha ainda ser válido.
   *
   * O botão da lista reenviava o objeto inteiro com `ativa` virado. Quando o
   * bloco 88 fechou o tipo da automação em `TIPOS_DE_CAMPANHA`, as linhas
   * criadas antes passaram a responder "Parâmetro inválido: tipo" e a
   * **continuar ligadas** — sem saída pela tela, só por `UPDATE` no banco.
   *
   * Exatamente as automações que mais precisavam ser caladas — as de tipo que o
   * produto passou a proibir — eram as únicas que não calavam. É a §6 pergunta
   * 3 produzida por uma guarda que entrou depois.
   *
   * A semente escreve direto no banco de propósito: `salvarAutomacao` recusa o
   * tipo antigo, que é o ponto — a linha existe e o caminho novo precisa
   * alcançá-la mesmo assim.
   */
  it('automação de tipo hoje proibido continua podendo ser desligada', async () => {
    await exec(`
      INSERT INTO automations (id, tenant_id, name, trigger, threshold, delay_minutes,
                               kind, goal, goal_window_days, active)
      VALUES ('${ANTIGA}', '${TENANT}', 'Lembrete antigo', 'sem_retorno', 30, 0,
              'lembrete_24h', 'agendamento', 7, true);
    `);

    const depois = await definirAutomacaoAtiva({
      tenantId: TENANT,
      id: ANTIGA,
      ativa: false,
      ...operador,
    });

    expect(depois.ativa).toBe(false);
    const linhas = await admin.$queryRawUnsafe<{ active: boolean }[]>(
      `SELECT active FROM automations WHERE id = '${ANTIGA}'`,
    );
    expect(linhas[0]?.active).toBe(false);
  });

  /**
   * A automação aponta para **um texto**, e é o que faz onze gatilhos deixarem
   * de mandar a mesma frase.
   *
   * Até o bloco 94 só `retorno` era permitido, o nome do texto saía do tipo, e
   * um índice único impunha um aprovado por tipo. "Avisa quando a assinatura
   * está vencendo" e "avisa quando o pacote está acabando" saíam com a mesma
   * mensagem — e os gatilhos existem justamente porque as situações são
   * diferentes.
   */
  it('duas automações do mesmo tipo mandam textos diferentes', async () => {
    await exec(`
      INSERT INTO whatsapp_templates
        (id, tenant_id, location_id, kind, name, titulo, language, status, body)
      VALUES
        ('${TEXTO_A}', '${TENANT}', '${LOCAL}', 'retorno', 'volta_carlos',
         'Volta, sentimos falta', 'pt_BR', 'aprovado', 'Oi {{1}}, volte à {{2}}!'),
        ('${TEXTO_B}', '${TENANT}', '${LOCAL}', 'retorno', 'pacote_acabando',
         'Seu pacote está no fim', 'pt_BR', 'aprovado', 'Oi {{1}}, seu pacote na {{2}} acaba.');
    `);

    const a = await automacao({ nome: 'Sumiu', templateId: TEXTO_A });
    const b = await automacao({ nome: 'Pacote', templateId: TEXTO_B });

    const linhas = await admin.$queryRawUnsafe<{ id: string; template_id: string }[]>(
      `SELECT id, template_id FROM automations WHERE id IN ('${a.id}', '${b.id}')`,
    );
    const porId = new Map(linhas.map((l) => [l.id, l.template_id]));
    expect(porId.get(a.id)).toBe(TEXTO_A);
    expect(porId.get(b.id)).toBe(TEXTO_B);
    expect(porId.get(a.id)).not.toBe(porId.get(b.id));
  });

  /**
   * Salvar sem mandar texto **preserva** o que já estava escolhido.
   *
   * O formulário só desenha o rádio de texto quando há texto aprovado, então
   * ele chega vazio em duas situações reais: a barbearia que ainda não aprovou
   * nenhum, e a edição feita numa tela que não carregou a lista. Sem o
   * `COALESCE` no `ON CONFLICT`, o primeiro salvamento nessas condições zeraria
   * a escolha, e a automação voltaria a mandar a frase de outro texto — sem
   * nada falhar e sem ninguém decidir isso.
   *
   * A primeira versão deste teste usava ligar-e-desligar e passava com e sem o
   * conserto: aquele caminho é a porta estreita do bloco 92, que toca uma coluna
   * só e nunca chegou perto do `ON CONFLICT`.
   */
  it('salvar sem texto não apaga o texto já escolhido', async () => {
    await exec(`
      INSERT INTO whatsapp_templates
        (id, tenant_id, location_id, kind, name, titulo, language, status, body)
      VALUES ('${TEXTO_A}', '${TENANT}', '${LOCAL}', 'retorno', 'volta_carlos',
              'Volta, sentimos falta', 'pt_BR', 'aprovado', 'Oi {{1}}!');
    `);
    const criada = await automacao({ templateId: TEXTO_A });

    // O mesmo formulário, salvo de novo sem o campo de texto.
    await automacao({ id: criada.id, templateId: null });

    const linhas = await admin.$queryRawUnsafe<{ template_id: string | null }[]>(
      `SELECT template_id FROM automations WHERE id = '${criada.id}'`,
    );
    expect(linhas[0]?.template_id).toBe(TEXTO_A);
  });

  /** Um atendimento concluído há tantos dias. */
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

  const varrer = (agora = AGORA) =>
    varrerAutomacoes({ tenantId: TENANT, agora, timeZone: 'America/Bahia' });

  // -- o cadastro ------------------------------------------------------------

  it('gatilho que pede número sem número é recusado antes do banco', async () => {
    await expect(automacao({ limiar: null })).rejects.toMatchObject({ code: 'invalida' });
  });

  it('a lista traz enviadas e alcançadas, que é o que decide desligar', async () => {
    await automacao();
    const lista = await automacoesDaCasa(TENANT);
    expect(lista[0]).toMatchObject({ nome: 'Volta, Carlos', enviadas: 0, alcancadas: 0 });
  });

  it('a automação de uma barbearia não é lida pela outra', async () => {
    await automacao();
    expect(await automacoesDaCasa(RIVAL)).toHaveLength(0);
  });

  // -- a varredura -----------------------------------------------------------

  it('quem sumiu há mais dias que o limiar é marcado', async () => {
    await automacao({ limiar: 30 });
    await atendimento(CARLOS, 35, '16565656-0000-4000-8000-000000000001');
    expect(await varrer()).toMatchObject({ marcados: 1 });

    const fila = await disparosAEnviar(TENANT, AGORA);
    expect(fila).toHaveLength(1);
    expect(fila[0]?.customerId).toBe(CARLOS);
  });

  it('quem veio ontem não é marcado', async () => {
    await automacao({ limiar: 30 });
    await atendimento(CARLOS, 1, '16565656-0000-4000-8000-000000000002');
    expect(await varrer()).toMatchObject({ marcados: 0 });
  });

  it('o mesmo fato não dispara duas vezes, mesmo varrendo de hora em hora', async () => {
    /**
     * A varredura roda a cada hora. Sem a unicidade por fato, "sumiu há 30
     * dias" mandaria uma mensagem por hora enquanto a pessoa continuasse
     * sumida — e a barbearia descobriria pela conta da Meta.
     */
    await automacao({ limiar: 30 });
    await atendimento(CARLOS, 35, '16565656-0000-4000-8000-000000000003');
    expect(await varrer()).toMatchObject({ marcados: 1 });
    expect(await varrer(new Date(AGORA.getTime() + 3_600_000))).toMatchObject({ marcados: 0 });

    const total = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM automation_sends`,
    );
    expect(Number(total[0]?.n)).toBe(1);
  });

  it('a automação desligada não marca ninguém', async () => {
    await automacao({ limiar: 30, ativa: false });
    await atendimento(CARLOS, 35, '16565656-0000-4000-8000-000000000004');
    expect(await varrer()).toMatchObject({ marcados: 0 });
  });

  it('quem pediu para não receber promoção é pulado, com o motivo escrito', async () => {
    await automacao({ limiar: 30 });
    await exec(`UPDATE customers SET accepts_marketing = false WHERE id = '${CARLOS}'`);
    await atendimento(CARLOS, 35, '16565656-0000-4000-8000-000000000005');

    expect(await varrer()).toMatchObject({ marcados: 0, pulados: 1 });
    const linha = await admin.$queryRawUnsafe<{ skipped_reason: string | null }[]>(
      `SELECT skipped_reason FROM automation_sends`,
    );
    // "Nada foi enviado" sem motivo transforma toda pergunta do dono numa
    // investigação — é a decisão de `notifications.reason`, do bloco 20.
    expect(linha[0]?.skipped_reason).toBe('optou_por_nao_receber');
  });

  it('o disparo pulado não ocupa a vaga do dia', async () => {
    /**
     * O índice do dia é parcial no enviado. Sem isso, a automação que não saiu
     * porque a pessoa optou por não receber bloquearia a que sairia — e a
     * barbearia veria o silêncio sem entender.
     */
    await automacao({ limiar: 30, nome: 'A' });
    await exec(`UPDATE customers SET accepts_marketing = false WHERE id = '${CARLOS}'`);
    await atendimento(CARLOS, 35, '16565656-0000-4000-8000-000000000006');
    await varrer();

    await exec(`UPDATE customers SET accepts_marketing = true WHERE id = '${CARLOS}'`);
    await automacao({ limiar: 31, nome: 'B' });
    expect(await varrer()).toMatchObject({ marcados: 1 });
  });

  // -- o envio ---------------------------------------------------------------

  it('o carimbo vem antes da mensagem, e não carimba duas vezes', async () => {
    await automacao({ limiar: 30 });
    await atendimento(CARLOS, 35, '16565656-0000-4000-8000-000000000007');
    await varrer();
    const [disparo] = await disparosAEnviar(TENANT, AGORA);

    expect(await marcarDisparoEnviado({ tenantId: TENANT, disparoId: disparo!.id })).toBe(true);
    expect(await marcarDisparoEnviado({ tenantId: TENANT, disparoId: disparo!.id })).toBe(false);
    expect(await disparosAEnviar(TENANT, AGORA)).toHaveLength(0);
  });

  it('a segunda automação do dia é barrada pelo banco, não só pela leitura', async () => {
    /**
     * A regra da SPEC é por cliente e por dia. A leitura da varredura já a
     * respeita, mas ela não alcança outro processo varrendo ao mesmo tempo —
     * quem garante é o índice único, e o disparo barrado fica com o motivo
     * escrito em vez de sumir.
     */
    await automacao({ limiar: 30, nome: 'A' });
    await automacao({ limiar: 31, nome: 'B' });
    await atendimento(CARLOS, 35, '16565656-0000-4000-8000-000000000008');
    await varrer();

    const fila = await disparosAEnviar(TENANT, AGORA);
    expect(fila.length).toBeGreaterThanOrEqual(1);

    // O primeiro passa; o segundo, do mesmo cliente e mesmo dia, é recusado.
    const carimbados: boolean[] = [];
    for (const disparo of fila) {
      carimbados.push(await marcarDisparoEnviado({ tenantId: TENANT, disparoId: disparo.id }));
    }
    expect(carimbados.filter(Boolean)).toHaveLength(1);
  });

  // -- os outros gatilhos (bloco 57) ------------------------------------------

  it('cada gatilho novo acha de fato quem cruzou a condição', async () => {
    /**
     * Uma consulta que nunca é exercida é uma consulta que passa no portão e
     * falha em produção. Este teste dispara **um** gatilho de cada, com o fato
     * plantado, e cobra que a varredura encontre — é o que separa "a consulta
     * compila" de "a consulta funciona".
     */
    // Cancelamento: o cliente desmarcou ontem.
    const ontem = new Date(AGORA.getTime() - 86_400_000).toISOString();
    const fimOntem = new Date(AGORA.getTime() - 86_400_000 + 1_800_000).toISOString();
    await exec(`
      INSERT INTO appointments
        (id, tenant_id, location_id, professional_id, customer_id, status,
         starts_at, ends_at, service_starts_at, service_ends_at, cancelled_at)
      VALUES ('36565656-0000-4000-8000-000000000001', '${TENANT}', '${LOCAL}', '${RUAN}',
              '${CARLOS}', 'cancelled_customer', '${ontem}', '${fimOntem}',
              '${ontem}', '${fimOntem}', '${ontem}');
    `);

    await salvarAutomacao({
      tenantId: TENANT,
      nome: 'Voltou atrás?',
      gatilho: 'cancelamento',
      limiar: null,
      atrasoMinutos: 0,
      tipo: 'retorno',
      objetivo: 'agendamento',
      janelaDias: 7,
      ativa: true,
      ...operador,
    });

    expect(await varrer()).toMatchObject({ marcados: 1 });
  });

  it('avaliação boa e ruim usam o mesmo campo com sentidos opostos', async () => {
    // "A partir de quantas estrelas" e "até quantas": é o mesmo número com dois
    // significados, e a razão de o rótulo morar em `core`.
    await exec(`
      INSERT INTO reviews (id, tenant_id, customer_id, professional_id, rating, created_at)
      VALUES ('46565656-0000-4000-8000-000000000001', '${TENANT}', '${CARLOS}', '${RUAN}', 5,
              '${new Date(AGORA.getTime() - 3_600_000).toISOString()}');
    `);

    await salvarAutomacao({
      tenantId: TENANT,
      nome: 'Obrigado pela nota',
      gatilho: 'avaliacao_positiva',
      limiar: 4,
      atrasoMinutos: 0,
      tipo: 'retorno',
      objetivo: 'agendamento',
      janelaDias: 7,
      ativa: true,
      ...operador,
    });
    expect(await varrer()).toMatchObject({ marcados: 1 });

    // A ruim, com o mesmo cinco, não pega ninguém.
    await exec(`DELETE FROM automation_sends; DELETE FROM automations`);
    await salvarAutomacao({
      tenantId: TENANT,
      nome: 'Desculpa',
      gatilho: 'avaliacao_negativa',
      limiar: 3,
      atrasoMinutos: 0,
      tipo: 'retorno',
      objetivo: 'agendamento',
      janelaDias: 7,
      ativa: true,
      ...operador,
    });
    expect(await varrer()).toMatchObject({ marcados: 0 });
  });

  // -- a atribuição ----------------------------------------------------------

  it('o agendamento dentro da janela é creditado à mensagem', async () => {
    await automacao({ limiar: 30, objetivo: 'agendamento', janelaDias: 7 });
    await atendimento(CARLOS, 35, '16565656-0000-4000-8000-000000000009');
    await varrer();
    const [disparo] = await disparosAEnviar(TENANT, AGORA);
    await marcarDisparoEnviado({ tenantId: TENANT, disparoId: disparo!.id });

    /**
     * O fato é derivado do carimbo **de verdade**, não do relógio do teste.
     *
     * `marcarDisparoEnviado` grava `now()` do banco, e `AGORA` é uma data
     * futura escolhida para a semente. Criar o agendamento a partir de `AGORA`
     * o poria semanas depois do envio real, fora da janela — o teste falharia
     * por desencontro de relógio, não por regra quebrada.
     */
    const carimbo = await admin.$queryRawUnsafe<{ sent_at: Date }[]>(
      `SELECT sent_at FROM automation_sends WHERE id = '${disparo!.id}'`,
    );
    const enviadaEm = carimbo[0]!.sent_at.getTime();
    /**
     * Hora **fixa** e fora do expediente, e o dia é o que importa.
     *
     * Carregando os minutos do relógio, este horário caía por cima do que outra
     * semente já criou para a mesma cadeira às 15h — e a constraint
     * anti-overbooking recusava a linha inteira. Só falhava quando a suíte
     * rodava perto das 15h20: intermitente, e portanto do tipo que ensina todo
     * mundo a reexecutar em vez de olhar.
     *
     * É a cicatriz que o `CLAUDE.md` escreve: *semente que cria agendamento no
     * relógio colide com o que outra semeadura já criou para a mesma cadeira.
     * Hora fixa e fora do expediente.* A janela de atribuição conta em dias, e o
     * dia continua sendo o mesmo.
     */
    const diaDepois = new Date(enviadaEm + 2 * 86_400_000).toISOString().slice(0, 10);
    const depois = `${diaDepois}T03:00:00.000Z`;
    const fimDepois = `${diaDepois}T03:30:00.000Z`;
    await exec(`
      INSERT INTO appointments
        (id, tenant_id, location_id, professional_id, customer_id, status,
         starts_at, ends_at, service_starts_at, service_ends_at, created_at)
      VALUES ('26565656-0000-4000-8000-000000000001', '${TENANT}', '${LOCAL}', '${RUAN}',
              '${CARLOS}', 'confirmed', '${depois}', '${fimDepois}', '${depois}', '${fimDepois}',
              '${depois}');
    `);

    expect(
      await atribuirObjetivos({ tenantId: TENANT, agora: new Date(enviadaEm + 3 * 86_400_000) }),
    ).toBe(1);

    const lista = await automacoesDaCasa(TENANT);
    expect(lista[0]).toMatchObject({ enviadas: 1, alcancadas: 1 });
  });

  it('o agendamento fora da janela não é creditado', async () => {
    // Dois meses depois a pessoa marcaria de qualquer jeito. Atribuição frouxa
    // é pior que nenhuma, porque tem número.
    await automacao({ limiar: 30, objetivo: 'agendamento', janelaDias: 7 });
    await atendimento(CARLOS, 35, '16565656-0000-4000-8000-00000000000a');
    await varrer();
    const [disparo] = await disparosAEnviar(TENANT, AGORA);
    await marcarDisparoEnviado({ tenantId: TENANT, disparoId: disparo!.id });

    const carimbo = await admin.$queryRawUnsafe<{ sent_at: Date }[]>(
      `SELECT sent_at FROM automation_sends WHERE id = '${disparo!.id}'`,
    );
    const enviadaEm = carimbo[0]!.sent_at.getTime();
    const tarde = new Date(enviadaEm + 60 * 86_400_000).toISOString();
    const fimTarde = new Date(enviadaEm + 60 * 86_400_000 + 1_800_000).toISOString();
    await exec(`
      INSERT INTO appointments
        (id, tenant_id, location_id, professional_id, customer_id, status,
         starts_at, ends_at, service_starts_at, service_ends_at, created_at)
      VALUES ('26565656-0000-4000-8000-000000000002', '${TENANT}', '${LOCAL}', '${RUAN}',
              '${CARLOS}', 'confirmed', '${tarde}', '${fimTarde}', '${tarde}', '${fimTarde}',
              '${tarde}');
    `);

    expect(
      await atribuirObjetivos({
        tenantId: TENANT,
        agora: new Date(enviadaEm + 61 * 86_400_000),
      }),
    ).toBe(0);
  });

  it('crédito exige mensagem enviada — o banco recusa o contrário', async () => {
    /**
     * Crédito a mensagem que não saiu é atribuição inventada, e ela apareceria
     * como sucesso no relatório. A `CHECK` é quem garante.
     */
    await automacao({ limiar: 30 });
    await atendimento(CARLOS, 35, '16565656-0000-4000-8000-00000000000b');
    await varrer();
    await expect(
      admin.$executeRawUnsafe(`UPDATE automation_sends SET goal_met_at = now()`),
    ).rejects.toThrow();
  });
});
