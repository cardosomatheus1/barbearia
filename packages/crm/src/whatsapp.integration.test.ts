import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeWhatsAppProvider, montarPayload } from '@barbearia/core';
import {
  cadastroDoWhatsApp,
  enviarPeloWhatsApp,
  executarResposta,
  fecharResposta,
  registrarEstadoDaMensagem,
  registrarResposta,
  respostaAExecutar,
  tenantDoNumero,
  salvarCadastroDoWhatsApp,
  submeterTemplate,
  templatesDaUnidade,
  templatesEmCurso,
  gravarRespostaDoTemplate,
  desconectarNumero,
} from './whatsapp.js';

/**
 * WhatsApp oficial contra Postgres real (bloco 55, SPEC §4.12).
 *
 * O que só o banco prova: que o token nunca volta pela leitura, que o botão só
 * age sobre o horário de **quem tocou**, e que a reentrega da Meta não duplica
 * nada.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '55555555-1111-1111-1111-111111111111';
const RIVAL = '55555555-2222-2222-2222-222222222222';
const LOCAL = 'a5555555-0000-0000-0000-000000000001';
const LOCAL_RIVAL = 'a5555555-0000-0000-0000-000000000002';
const CARLOS = 'c5555555-0000-0000-0000-000000000001';
const BRUNO = 'c5555555-0000-0000-0000-000000000002';
const DONO = 'd5555555-0000-0000-0000-000000000001';
const RUAN = 'e5555555-0000-0000-0000-000000000001';
const CORTE = 'f5555555-0000-0000-0000-000000000001';
const HORARIO_DO_CARLOS = '15555555-0000-4000-8000-000000000001';
const HORARIO_DO_BRUNO = '25555555-0000-4000-8000-000000000002';

const TELEFONE_DO_CARLOS = '+5571988887777';
const TELEFONE_DO_BRUNO = '+5571977776666';
const AGORA = new Date('2026-09-20T15:00:00Z');
const operador = { staffId: DONO, staffName: 'Matheus' };

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

describeIfDb('WhatsApp oficial', () => {
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

      INSERT INTO locations (id, tenant_id, name, timezone) VALUES
        ('${LOCAL}', '${TENANT}', 'Matriz', 'America/Bahia'),
        ('${LOCAL_RIVAL}', '${RIVAL}', 'Deles', 'America/Bahia');

      INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
        ('${CARLOS}', '${TENANT}', 'Carlos Souza', '${TELEFONE_DO_CARLOS}'),
        ('${BRUNO}', '${TENANT}', 'Bruno Lima', '${TELEFONE_DO_BRUNO}');

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role) VALUES
        ('${DONO}', '${TENANT}', 'Matheus', 'dono@domari.com.br', 'x', 'owner');

      INSERT INTO professionals (id, tenant_id, location_id, name, kind)
      VALUES ('${RUAN}', '${TENANT}', '${LOCAL}', 'Ruan', 'professional');

      INSERT INTO services (id, tenant_id, name, price_cents, duration_minutes)
      VALUES ('${CORTE}', '${TENANT}', 'Corte', 5000, 30);

      INSERT INTO appointments
        (id, tenant_id, location_id, professional_id, customer_id, status,
         starts_at, ends_at, service_starts_at, service_ends_at)
      VALUES
        ('${HORARIO_DO_CARLOS}', '${TENANT}', '${LOCAL}', '${RUAN}', '${CARLOS}', 'confirmed',
         '2026-09-21T12:00:00Z', '2026-09-21T12:30:00Z',
         '2026-09-21T12:00:00Z', '2026-09-21T12:30:00Z'),
        ('${HORARIO_DO_BRUNO}', '${TENANT}', '${LOCAL}', '${RUAN}', '${BRUNO}', 'confirmed',
         '2026-09-21T14:00:00Z', '2026-09-21T14:30:00Z',
         '2026-09-21T14:00:00Z', '2026-09-21T14:30:00Z');
    `);
  });

  const cadastrar = (token: string | null = 'EAAG-token-da-meta') =>
    salvarCadastroDoWhatsApp({
      tenantId: TENANT,
      locationId: LOCAL,
      phoneNumberId: '109876543210987',
      wabaId: '102030405060708',
      numeroVisivel: '+55 71 3333-4444',
      token,
      ...operador,
    });

  const ativar = async () => {
    await cadastrar();
    await exec(
      `UPDATE whatsapp_settings SET status = 'ativo', verified_at = now()
        WHERE location_id = '${LOCAL}'`,
    );
  };

  const aprovarTemplate = async (
    tipo = 'lembrete_24h',
    corpo = 'Olá {{1}}, seu corte é amanhã às {{2}}.',
  ) => {
    const provedor = new FakeWhatsAppProvider();
    provedor.proximoEstadoDoTemplate = 'aprovado';
    return submeterTemplate({
      tenantId: TENANT,
      locationId: LOCAL,
      tipo: tipo as 'lembrete_24h',
      nome: `${tipo}_v1`,
      corpo,
      provider: provedor,
      ...operador,
    });
  };

  // -- o cadastro ------------------------------------------------------------

  it('o token é cifrado, e a leitura devolve só que ele existe', async () => {
    /**
     * O token manda mensagem em nome da barbearia para a base inteira de
     * clientes dela. Devolvê-lo na leitura faria toda abertura da tela de
     * configurações mandar uma credencial viva pela rede, para dentro de um HTML
     * que fica no histórico do navegador.
     */
    const salvo = await cadastrar('EAAG-token-secreto');
    expect(salvo.temToken).toBe(true);
    expect(JSON.stringify(salvo)).not.toContain('EAAG-token-secreto');

    const guardado = await admin.$queryRawUnsafe<{ access_token_cipher: string }[]>(
      `SELECT access_token_cipher FROM whatsapp_settings WHERE location_id = '${LOCAL}'`,
    );
    expect(guardado[0]?.access_token_cipher).not.toContain('EAAG-token-secreto');
    // AES-256-GCM: nonce, tag e dados, como o segredo do segundo fator.
    expect(guardado[0]?.access_token_cipher.split('.')).toHaveLength(3);
  });

  it('salvar sem token não apaga o que já estava', async () => {
    // Ausente é "não mexa": a tela não devolve o token, então não pode
    // reenviá-lo, e escrever nulo por omissão apagaria a credencial toda vez
    // que alguém corrigisse o número visível.
    await cadastrar('EAAG-token-secreto');
    const depois = await salvarCadastroDoWhatsApp({
      tenantId: TENANT,
      locationId: LOCAL,
      phoneNumberId: '109876543210987',
      wabaId: '102030405060708',
      numeroVisivel: '+55 71 3333-5555',
      ...operador,
    });
    expect(depois.temToken).toBe(true);
    expect(depois.numeroVisivel).toBe('+55 71 3333-5555');
  });

  it('o estado não vem do corpo da requisição', async () => {
    // Deixar a tela mandar `ativo` faria "está ativo?" ser opinião do cliente
    // HTTP. Com token, o cadastro entra em espera — quem promove é a Meta.
    const salvo = await cadastrar();
    expect(salvo.estado).toBe('aguardando_verificacao');
  });

  it('a trilha guarda que o token mudou, e nunca qual é', async () => {
    await cadastrar('EAAG-token-secreto');
    const trilha = await admin.$queryRawUnsafe<{ before: unknown; after: unknown }[]>(
      `SELECT before, after FROM audit_log WHERE action = 'whatsapp.settings_changed'`,
    );
    expect(trilha).toHaveLength(1);
    expect(JSON.stringify(trilha[0])).not.toContain('EAAG-token-secreto');
  });

  it('o cadastro de uma barbearia não é lido pela outra', async () => {
    await cadastrar();
    expect(await cadastroDoWhatsApp(RIVAL, LOCAL)).toBeNull();
  });

  it('unidade de outra barbearia é recusada', async () => {
    await expect(
      salvarCadastroDoWhatsApp({
        tenantId: TENANT,
        locationId: LOCAL_RIVAL,
        phoneNumberId: '109876543210987',
        wabaId: '102030405060708',
        numeroVisivel: null,
        token: 'x',
        ...operador,
      }),
    ).rejects.toMatchObject({ code: 'nao_configurado' });
  });

  // -- os templates ----------------------------------------------------------

  it('o template nasce pendente e a resposta da Meta o move', async () => {
    const provedor = new FakeWhatsAppProvider();
    const criado = await submeterTemplate({
      tenantId: TENANT,
      locationId: LOCAL,
      tipo: 'lembrete_24h',
      nome: 'lembrete_24h_v1',
      corpo: 'Olá {{1}}',
      provider: provedor,
      ...operador,
    });
    expect(criado.estado).toBe('pendente');
    expect(provedor.submetidos).toHaveLength(1);

    // Os botões saem do tipo do aviso, não do formulário: o que a Meta aprova
    // precisa ser o que o motor manda.
    expect(provedor.submetidos[0]?.botoes).toEqual(['confirmar', 'remarcar', 'cancelar']);

    await gravarRespostaDoTemplate({
      tenantId: TENANT,
      templateId: criado.id,
      resposta: { metaId: 'meta.1', estado: 'aprovado', motivoDaRecusa: null },
    });
    const depois = await templatesDaUnidade(TENANT, LOCAL);
    expect(depois[0]?.estado).toBe('aprovado');
  });

  it('o pendente entra na fila de conciliação e o aprovado sai', async () => {
    const provedor = new FakeWhatsAppProvider();
    const criado = await submeterTemplate({
      tenantId: TENANT,
      locationId: LOCAL,
      tipo: 'confirmacao',
      nome: 'confirmacao_v1',
      corpo: 'Olá {{1}}',
      provider: provedor,
      ...operador,
    });
    expect(await templatesEmCurso(TENANT)).toHaveLength(1);

    await gravarRespostaDoTemplate({
      tenantId: TENANT,
      templateId: criado.id,
      resposta: { metaId: 'meta.1', estado: 'aprovado', motivoDaRecusa: null },
    });
    expect(await templatesEmCurso(TENANT)).toHaveLength(0);
  });

  it('nome fora do formato da Meta é recusado antes do banco', async () => {
    await expect(
      submeterTemplate({
        tenantId: TENANT,
        locationId: LOCAL,
        tipo: 'lembrete_24h',
        nome: 'Lembrete 24h',
        corpo: 'x',
        provider: new FakeWhatsAppProvider(),
        ...operador,
      }),
    ).rejects.toMatchObject({ code: 'nome_invalido' });
  });

  // -- o envio ---------------------------------------------------------------

  it('sem cadastro ativo, o envio devolve nulo em vez de lançar', async () => {
    /**
     * Quem chama é o motor de aviso, que tem canal de reserva. Transformar
     * "canal indisponível" em exceção faria a tarefa da fila morrer em vez de
     * cair para o outro caminho — e a SPEC §4.12 pede o contrário em letras.
     */
    await cadastrar();
    await aprovarTemplate();
    const resultado = await enviarPeloWhatsApp({
      tenantId: TENANT,
      locationId: LOCAL,
      tipo: 'lembrete_24h',
      telefone: TELEFONE_DO_CARLOS,
      variaveis: ['Carlos', '15h'],
      customerId: CARLOS,
      appointmentId: HORARIO_DO_CARLOS,
      provider: new FakeWhatsAppProvider(),
    });
    expect(resultado).toBeNull();
  });

  /**
   * Texto sem variável nenhuma é texto válido, e precisa **sair**.
   *
   * "Seu agendamento está confirmado, te esperamos em breve!" é o que uma
   * barbearia escreve, e a Meta aprova. O envio mandava as três variáveis do
   * motor assim mesmo, e a Meta recusa quando a quantidade não bate com a do
   * template — aprovado na tela, falhando em todo envio, que é a pior
   * combinação possível: a tela diz "aprovado" e o cliente não recebe nada.
   */
  it('texto sem variável sai com zero parâmetros', async () => {
    await ativar();
    await aprovarTemplate('lembrete_24h', 'Seu agendamento está confirmado, te esperamos!');

    const provedor = new FakeWhatsAppProvider();
    const resultado = await enviarPeloWhatsApp({
      tenantId: TENANT,
      locationId: LOCAL,
      tipo: 'lembrete_24h',
      telefone: TELEFONE_DO_CARLOS,
      // O motor sempre oferece as três; quem manda é o texto aprovado.
      variaveis: ['Carlos', '15h', 'Gleidson'],
      customerId: CARLOS,
      appointmentId: HORARIO_DO_CARLOS,
      provider: provedor,
    });

    expect(resultado).not.toBeNull();
    expect(provedor.enviadas.at(-1)?.variaveis).toEqual([]);
  });

  it('texto com duas variáveis leva duas, não as três do motor', async () => {
    await ativar();
    await aprovarTemplate();

    const provedor = new FakeWhatsAppProvider();
    await enviarPeloWhatsApp({
      tenantId: TENANT,
      locationId: LOCAL,
      tipo: 'lembrete_24h',
      telefone: TELEFONE_DO_CARLOS,
      variaveis: ['Carlos', '15h', 'Gleidson'],
      customerId: CARLOS,
      appointmentId: HORARIO_DO_CARLOS,
      provider: provedor,
    });

    expect(provedor.enviadas.at(-1)?.variaveis).toEqual(['Carlos', '15h']);
  });

  it('sem template aprovado, o envio devolve nulo', async () => {
    await ativar();
    const resultado = await enviarPeloWhatsApp({
      tenantId: TENANT,
      locationId: LOCAL,
      tipo: 'lembrete_24h',
      telefone: TELEFONE_DO_CARLOS,
      variaveis: ['Carlos'],
      customerId: CARLOS,
      appointmentId: HORARIO_DO_CARLOS,
      provider: new FakeWhatsAppProvider(),
    });
    expect(resultado).toBeNull();
  });

  it('com cadastro ativo e template aprovado, a mensagem sai com os botões', async () => {
    await ativar();
    await aprovarTemplate();
    const provedor = new FakeWhatsAppProvider();

    const enviada = await enviarPeloWhatsApp({
      tenantId: TENANT,
      locationId: LOCAL,
      tipo: 'lembrete_24h',
      telefone: TELEFONE_DO_CARLOS,
      variaveis: ['Carlos', '9h'],
      customerId: CARLOS,
      appointmentId: HORARIO_DO_CARLOS,
      provider: provedor,
    });

    expect(enviada?.wamid).toBeTruthy();
    // O botão carrega **qual** horário ele mexe: sem o id, não haveria como
    // saber o que cancelar.
    expect(provedor.enviadas[0]?.respostas.map((r) => r.payload)).toEqual([
      `confirmar:${HORARIO_DO_CARLOS}`,
      `remarcar:${HORARIO_DO_CARLOS}`,
      `cancelar:${HORARIO_DO_CARLOS}`,
    ]);

    const gravadas = await admin.$queryRawUnsafe<{ wamid: string }[]>(
      `SELECT wamid FROM whatsapp_messages`,
    );
    expect(gravadas).toHaveLength(1);
  });

  // -- o que a Meta conta de volta -------------------------------------------

  it('o estado da mensagem só avança', async () => {
    /**
     * A Meta entrega os eventos fora de ordem com frequência. Um `lida`
     * chegando antes do `entregue` não pode fazer a mensagem voltar — é o mesmo
     * cuidado do espelho de consentimento, que só avança se a decisão for a
     * mais recente.
     */
    await ativar();
    await aprovarTemplate();
    const enviada = await enviarPeloWhatsApp({
      tenantId: TENANT,
      locationId: LOCAL,
      tipo: 'lembrete_24h',
      telefone: TELEFONE_DO_CARLOS,
      // As duas que o texto aprovado pede. Com uma só, o canal fica
      // indisponível de propósito — a Meta recusa quando falta parâmetro —, e
      // este teste é sobre a ordem dos eventos, não sobre isso.
      variaveis: ['Carlos', '15h'],
      customerId: CARLOS,
      appointmentId: HORARIO_DO_CARLOS,
      provider: new FakeWhatsAppProvider(),
    });

    expect(await registrarEstadoDaMensagem({ tenantId: TENANT, wamid: enviada!.wamid, estado: 'lida' })).toBe(true);
    // O `entregue` atrasado não desfaz o `lida`.
    expect(await registrarEstadoDaMensagem({ tenantId: TENANT, wamid: enviada!.wamid, estado: 'entregue' })).toBe(
      false,
    );

    const linha = await admin.$queryRawUnsafe<{ status: string }[]>(
      `SELECT status::text AS status FROM whatsapp_messages WHERE wamid = '${enviada!.wamid}'`,
    );
    expect(linha[0]?.status).toBe('lida');
  });

  it('o número resolve a barbearia antes de qualquer leitura com RLS', async () => {
    /**
     * O webhook da Meta chega **antes** de existir tenant no contexto: ela
     * manda o `phone_number_id`, não o nosso id de barbearia. A primeira versão
     * disto usava `semTenant` direto na tabela de mensagens, e o `UPDATE` não
     * achava nada — a política de RLS não casa com linha nenhuma sem tenant, e
     * a função devolvia `false` em silêncio.
     */
    await cadastrar();
    expect(await tenantDoNumero('109876543210987')).toEqual({
      tenantId: TENANT,
      locationId: LOCAL,
    });
    expect(await tenantDoNumero('000000000000000')).toBeNull();
  });

  // -- o botão ---------------------------------------------------------------

  it('o toque no botão vira uma linha e uma tarefa, na mesma transação', async () => {
    const resultado = await registrarResposta({
      tenantId: TENANT,
      wamid: 'wamid.1',
      telefone: TELEFONE_DO_CARLOS,
      payload: montarPayload('cancelar', HORARIO_DO_CARLOS),
      texto: null,
    });
    expect(resultado.novo).toBe(true);

    const tarefas = await admin.$queryRawUnsafe<{ kind: string }[]>(
      `SELECT kind FROM jobs WHERE kind = 'whatsapp.responder'`,
    );
    expect(tarefas).toHaveLength(1);
  });

  it('a reentrega da Meta não vira segunda tarefa', async () => {
    // Reentregar é comportamento normal dela, e sem a unicidade o mesmo
    // cancelamento chegaria duas vezes.
    const primeira = {
      tenantId: TENANT,
      wamid: 'wamid.1',
      telefone: TELEFONE_DO_CARLOS,
      payload: montarPayload('cancelar', HORARIO_DO_CARLOS),
      texto: null,
    };
    expect((await registrarResposta(primeira)).novo).toBe(true);
    expect((await registrarResposta(primeira)).novo).toBe(false);

    const tarefas = await admin.$queryRawUnsafe<{ kind: string }[]>(
      `SELECT kind FROM jobs WHERE kind = 'whatsapp.responder'`,
    );
    expect(tarefas).toHaveLength(1);
  });

  it('o botão não alcança o horário de outro cliente da mesma barbearia', async () => {
    /**
     * Achado da `/security-review` deste bloco, e é a regra escrita do projeto:
     * a RLS separa barbearias e **não separa clientes dentro de uma**. O payload
     * volta pelo aparelho do cliente e chega por um endereço público — gravá-lo
     * direto na chave estrangeira confiaria num id que veio de fora, e a
     * checagem de integridade referencial do Postgres ignora row security.
     *
     * Carlos responde com o id do horário do Bruno. A linha é gravada — o
     * rastro do caso suspeito é justamente o que não se pode perder — mas sem
     * agendamento: nada para cancelar.
     */
    await registrarResposta({
      tenantId: TENANT,
      wamid: 'wamid.alheio',
      telefone: TELEFONE_DO_CARLOS,
      payload: montarPayload('cancelar', HORARIO_DO_BRUNO),
      texto: null,
    });

    const linha = await admin.$queryRawUnsafe<{ appointment_id: string | null }[]>(
      `SELECT appointment_id FROM whatsapp_inbound WHERE wamid = 'wamid.alheio'`,
    );
    expect(linha[0]?.appointment_id).toBeNull();
  });

  it('o botão não alcança horário de outra barbearia', async () => {
    await exec(`
      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('c5555555-0000-0000-0000-0000000000ff', '${RIVAL}', 'Cliente deles', '+5571900000099');

      INSERT INTO professionals (id, tenant_id, location_id, name, kind)
      VALUES ('e5555555-0000-0000-0000-0000000000ff', '${RIVAL}', '${LOCAL_RIVAL}', 'Outro', 'professional');

      INSERT INTO appointments
        (id, tenant_id, location_id, professional_id, customer_id, status,
         starts_at, ends_at, service_starts_at, service_ends_at)
      VALUES ('35555555-0000-4000-8000-0000000000ff', '${RIVAL}', '${LOCAL_RIVAL}',
              'e5555555-0000-0000-0000-0000000000ff', 'c5555555-0000-0000-0000-0000000000ff',
              'confirmed', '2026-09-21T16:00:00Z', '2026-09-21T16:30:00Z',
              '2026-09-21T16:00:00Z', '2026-09-21T16:30:00Z');
    `);

    await registrarResposta({
      tenantId: TENANT,
      wamid: 'wamid.outra-casa',
      telefone: TELEFONE_DO_CARLOS,
      payload: montarPayload('cancelar', '35555555-0000-4000-8000-0000000000ff'),
      texto: null,
    });

    const linha = await admin.$queryRawUnsafe<{ appointment_id: string | null }[]>(
      `SELECT appointment_id FROM whatsapp_inbound WHERE wamid = 'wamid.outra-casa'`,
    );
    expect(linha[0]?.appointment_id).toBeNull();
  });

  it('o próprio horário passa, e é o caminho normal', async () => {
    await registrarResposta({
      tenantId: TENANT,
      wamid: 'wamid.meu',
      telefone: TELEFONE_DO_CARLOS,
      payload: montarPayload('cancelar', HORARIO_DO_CARLOS),
      texto: null,
    });

    const resposta = await respostaAExecutar(TENANT, (await primeiraResposta()).id);
    expect(resposta).toMatchObject({
      botao: 'cancelar',
      agendamentoId: HORARIO_DO_CARLOS,
      customerId: CARLOS,
    });
  });

  async function primeiraResposta(): Promise<{ id: string }> {
    const linhas = await admin.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM whatsapp_inbound ORDER BY received_at LIMIT 1`,
    );
    return linhas[0]!;
  }

  it('cancelar chama a ação com o cliente junto, e fecha a resposta', async () => {
    await registrarResposta({
      tenantId: TENANT,
      wamid: 'wamid.cancelar',
      telefone: TELEFONE_DO_CARLOS,
      payload: montarPayload('cancelar', HORARIO_DO_CARLOS),
      texto: null,
    });
    const { id } = await primeiraResposta();

    const cancelados: { appointmentId: string; customerId: string }[] = [];
    const desfecho = await executarResposta({
      tenantId: TENANT,
      inboundId: id,
      agora: AGORA,
      cancelar: async (e) => {
        cancelados.push({ appointmentId: e.appointmentId, customerId: e.customerId });
      },
      confirmar: async () => {},
    });

    expect(cancelados).toEqual([{ appointmentId: HORARIO_DO_CARLOS, customerId: CARLOS }]);
    expect(desfecho).toContain('cancelado');

    // Fechada: a volta seguinte da fila não repete a ação.
    const denovo = await executarResposta({
      tenantId: TENANT,
      inboundId: id,
      agora: AGORA,
      cancelar: async () => {
        throw new Error('não deveria cancelar duas vezes');
      },
      confirmar: async () => {},
    });
    expect(denovo).toBe('ja tratada');
  });

  it('texto livre não vira ação, e fica para alguém ler', async () => {
    // Gente escreve para o número da barbearia o tempo todo. Anônimo de ação é
    // resultado legítimo, não caso degradado.
    await registrarResposta({
      tenantId: TENANT,
      wamid: 'wamid.texto',
      telefone: TELEFONE_DO_CARLOS,
      payload: null,
      texto: 'vocês abrem no feriado?',
    });
    const { id } = await primeiraResposta();

    const desfecho = await executarResposta({
      tenantId: TENANT,
      inboundId: id,
      agora: AGORA,
      cancelar: async () => {
        throw new Error('texto não cancela nada');
      },
      confirmar: async () => {},
    });
    expect(desfecho).toContain('sem ação automática');
  });

  it('quem não está no cadastro não move horário nenhum', async () => {
    await registrarResposta({
      tenantId: TENANT,
      wamid: 'wamid.desconhecido',
      telefone: '+5571900000000',
      payload: montarPayload('cancelar', HORARIO_DO_CARLOS),
      texto: null,
    });
    const { id } = await primeiraResposta();

    const desfecho = await executarResposta({
      tenantId: TENANT,
      inboundId: id,
      agora: AGORA,
      cancelar: async () => {
        throw new Error('sem cadastro não se cancela nada');
      },
      confirmar: async () => {},
    });
    expect(desfecho).toContain('não está no cadastro');
  });

  it('a recusa do domínio vira desfecho, não falha da tarefa', async () => {
    /**
     * "Cancelou depois do prazo" é resposta legítima. Relançá-la faria a tarefa
     * ser retentada até esgotar — cinco chamadas que já sabem a resposta — e a
     * linha ficaria para sempre sem desfecho na caixa de entrada.
     */
    await registrarResposta({
      tenantId: TENANT,
      wamid: 'wamid.tarde',
      telefone: TELEFONE_DO_CARLOS,
      payload: montarPayload('cancelar', HORARIO_DO_CARLOS),
      texto: null,
    });
    const { id } = await primeiraResposta();

    const desfecho = await executarResposta({
      tenantId: TENANT,
      inboundId: id,
      agora: AGORA,
      cancelar: async () => {
        throw new Error('fora do prazo de cancelamento');
      },
      confirmar: async () => {},
    });
    expect(desfecho).toContain('fora do prazo');

    const linha = await admin.$queryRawUnsafe<{ handled_at: Date | null }[]>(
      `SELECT handled_at FROM whatsapp_inbound WHERE wamid = 'wamid.tarde'`,
    );
    expect(linha[0]?.handled_at).not.toBeNull();
  });

  it('fechar duas vezes não engana ninguém', async () => {
    await registrarResposta({
      tenantId: TENANT,
      wamid: 'wamid.fechar',
      telefone: TELEFONE_DO_CARLOS,
      payload: null,
      texto: 'oi',
    });
    const { id } = await primeiraResposta();
    expect(await fecharResposta({ tenantId: TENANT, inboundId: id, desfecho: 'lida' })).toBe(true);
    expect(await fecharResposta({ tenantId: TENANT, inboundId: id, desfecho: 'lida' })).toBe(false);
  });

  // -- LGPD ------------------------------------------------------------------

  it('a anonimização tira a pessoa de dentro da caixa de entrada', async () => {
    /**
     * `whatsapp_inbound` guarda o telefone em claro — é ele que identifica quem
     * respondeu — e o texto que a pessoa digitou. Achado da `/security-review`
     * deste bloco: a migração prometia que saía na anonimização e nada tirava.
     */
    await registrarResposta({
      tenantId: TENANT,
      wamid: 'wamid.lgpd',
      telefone: TELEFONE_DO_CARLOS,
      payload: null,
      texto: 'aqui é o Carlos, quero remarcar',
    });

    // Numa transação só, com o contexto local a ela — como `withTenant`. Duas
    // chamadas soltas pegam duas conexões do pool, e o `set_config` da sessão
    // não atravessa: a função responde "exige app.tenant_id no contexto" numa
    // execução a cada tantas, conforme o pool distribuir.
    await admin.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${TENANT}', true)`);
      await tx.$executeRawUnsafe(
        `SELECT anonimizar_cliente('${CARLOS}'::uuid, 'pedido de exclusão do titular')`,
      );
    });

    const linha = await admin.$queryRawUnsafe<
      { from_phone: string | null; body: string | null; customer_id: string | null }[]
    >(`SELECT from_phone, body, customer_id FROM whatsapp_inbound WHERE wamid = 'wamid.lgpd'`);
    expect(linha[0]).toMatchObject({ from_phone: null, body: null, customer_id: null });
  });

  describe('a Meta desconecta o número (bloco 85)', () => {
    /**
     * Na coexistência o número continua no aplicativo WhatsApp Business — e se
     * o cliente registrar o aplicativo em outro aparelho, a Meta desfaz o
     * pareamento e manda `ACCOUNT_OFFBOARDED`.
     *
     * Sem tratar isso, a tela continuaria dizendo **Ativo** com toda mensagem
     * caindo no canal de reserva: o barbeiro troca de celular numa terça e a
     * barbearia descobre pela falta que os clientes não confirmam mais.
     */
    it('tira o número do ar com o motivo escrito, e não apaga o token', async () => {
      await ativar();

      const mudou = await desconectarNumero({
        tenantId: TENANT,
        phoneNumberId: '109876543210987',
        motivo: 'A Meta desconectou este número.',
      });
      expect(mudou).toBe(true);

      const linhas = await admin.$queryRawUnsafe<
        { status: string; status_reason: string; tem_token: boolean }[]
      >(
        `SELECT status::text AS status, status_reason,
                (access_token_cipher IS NOT NULL) AS tem_token
           FROM whatsapp_settings WHERE location_id = '${LOCAL}'`,
      );
      expect(linhas[0]?.status).toBe('suspenso');
      expect(linhas[0]?.status_reason).toBe('A Meta desconectou este número.');
      // O token fica: reconectar é refazer o fluxo, e apagá-lo aqui só tiraria
      // a informação de que ele existiu.
      expect(linhas[0]?.tem_token).toBe(true);
    });

    it('a reentrega do mesmo evento não conta duas vezes', async () => {
      // A Meta reentrega, e é normal. `status <> 'suspenso'` no WHERE é o que
      // faz a segunda passada não mexer em nada.
      await ativar();
      const primeira = await desconectarNumero({
        tenantId: TENANT,
        phoneNumberId: '109876543210987',
        motivo: 'motivo',
      });
      const segunda = await desconectarNumero({
        tenantId: TENANT,
        phoneNumberId: '109876543210987',
        motivo: 'motivo',
      });
      expect([primeira, segunda]).toEqual([true, false]);
    });

    it('o número da barbearia vizinha não é desconectado por esta', async () => {
      // A RLS separa barbearias, e o webhook chega **antes** de existir tenant
      // no contexto: quem o abre é `tenantDoNumero`. Se o tenant errado chegar
      // aqui, a política é a última linha.
      await ativar();
      const mudou = await desconectarNumero({
        tenantId: RIVAL,
        phoneNumberId: '109876543210987',
        motivo: 'motivo',
      });
      expect(mudou).toBe(false);
    });
  });
});
