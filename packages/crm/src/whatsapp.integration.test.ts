import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeWhatsAppProvider, montarPayload, podeGerenciarTemplates } from '@barbearia/core';
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
  entregarTemplateNaMeta,
  liberarTemplatesAbandonados,
  templateDaUnidade,
  templatesDaUnidade,
  conciliarNumero,
  templatesEmCurso,
  gravarRespostaDoTemplate,
  desconectarNumero,
} from './whatsapp.js';
import { enviarMensagemAvulsa } from './mensagem-avulsa.js';
import { semTenant, withTenant } from '@barbearia/db';
import type { TemplateNaTela } from './whatsapp.js';
import type { WhatsAppProvider } from '@barbearia/core';

/**
 * O caminho inteiro do balcão, agora em dois passos (bloco 133).
 *
 * A requisição reserva a linha e **enfileira**; quem fala com a Meta é o
 * worker. Quase todo teste deste arquivo quer o desfecho, então o helper
 * percorre os dois — e o faz do jeito que a produção faz: o `claim` sai da
 * tarefa que a reserva enfileirou, não de uma variável passada por baixo.
 *
 * Isso é de propósito. Se alguém tirar o `enfileirar` de dentro da transação da
 * reserva, o `claim` some, a entrega não acha alvo e **os vinte testes** que
 * usam este helper ficam vermelhos — em vez de um só, escrito à parte, que
 * poderia ser apagado junto com o defeito.
 */
async function submeterEEntregar(
  params: Parameters<typeof submeterTemplate>[0] & { readonly provider: WhatsAppProvider },
): Promise<TemplateNaTela> {
  const { provider, ...pedido } = params;
  const criado = await submeterTemplate(pedido);
  const claim = await semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<{ claim: string }[]>`
      SELECT payload->>'claim' AS claim
        FROM jobs
       WHERE kind = 'whatsapp.submeter_template'
         AND payload->>'templateId' = ${criado.id}
       ORDER BY created_at DESC
       LIMIT 1
    `;
    return linhas[0]?.claim ?? null;
  });
  if (!claim) throw new Error('a reserva não enfileirou a ida à Meta');
  await entregarTemplateNaMeta({
    tenantId: params.tenantId,
    templateId: criado.id,
    claim,
    provider,
  });
  const depois = await templateDaUnidade(params.tenantId, criado.id);
  if (!depois) throw new Error('o texto sumiu depois da entrega');
  return depois;
}

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

  /**
   * `nome` por parâmetro desde o bloco 96: dois textos do **mesmo tipo** é o
   * caso que este bloco existe para cobrir, e com o nome derivado do tipo os
   * dois colidiriam na chave da Meta — o teste falharia por outro motivo que
   * não a regra sob prova.
   */
  /**
   * Empurra a reserva para trás no tempo: o relógio é o do banco.
   *
   * `withTenant` e não `semTenant`: `whatsapp_templates` tem política por
   * tenant, e um `UPDATE` sem tenant no contexto alcança **zero linhas, em
   * silêncio**. Escrito com `semTenant`, este auxiliar não envelhecia nada — e
   * o teste da varredura falhava acusando a varredura, que estava certa.
   */
  const envelhecerSubmissao = (templateId: string, quanto: string) =>
    withTenant(TENANT, async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE whatsapp_templates
            SET submission_updated_at = now() - interval '${quanto}'
          WHERE id = $1::uuid`,
        templateId,
      );
    });

  const aprovarTemplate = async (
    tipo = 'lembrete_24h',
    corpo = 'Olá {{1}}, seu corte é amanhã às {{2}}.',
    nome = `${tipo}_v1`,
  ) => {
    const provedor = new FakeWhatsAppProvider();
    provedor.proximoEstadoDoTemplate = 'aprovado';
    return submeterEEntregar({
      tenantId: TENANT,
      locationId: LOCAL,
      tipo: tipo as 'lembrete_24h',
      nome,
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

  // -- os escopos concedidos (bloco 88) --------------------------------------

  it('o token que só envia é gravado como tal, e a leitura o devolve', async () => {
    /**
     * É o cadastro que conecta sem erro nenhum e não cria template. Antes deste
     * bloco os escopos só existiam no log do servidor, e a tela não tinha como
     * avisar — a pessoa escrevia o texto inteiro para receber da Meta "esta
     * conta não pode criar um novo modelo", que não nomeia permissão nenhuma.
     */
    const salvo = await salvarCadastroDoWhatsApp({
      tenantId: TENANT,
      locationId: LOCAL,
      phoneNumberId: '109876543210987',
      wabaId: '102030405060708',
      numeroVisivel: null,
      token: 'EAAG',
      escopos: ['whatsapp_business_messaging'],
      ...operador,
    });
    expect(salvo.escopos).toEqual(['whatsapp_business_messaging']);
    expect(podeGerenciarTemplates(salvo.escopos)).toBe(false);
  });

  it('cadastro pelo formulário não declara escopo, e isso não é "não pode"', async () => {
    // O caminho de escape do bloco 55 nunca fala com a Meta. Se a ausência
    // virasse `false`, a tela acusaria de falta de acesso justamente quem está
    // com o acesso funcionando.
    const salvo = await cadastrar();
    expect(salvo.escopos).toBeNull();
    expect(podeGerenciarTemplates(salvo.escopos)).toBeNull();
  });

  it('corrigir o número visível não apaga o escopo que a Meta declarou', async () => {
    /**
     * Mesma regra do token, e pelo mesmo motivo: ausente é "não mexa". Sem o
     * `COALESCE`, corrigir o número pela tela — que não manda escopo nenhum,
     * porque não fala com a Meta — apagaria o que o Embedded Signup descobriu, e
     * o aviso sumiria da tela sem ninguém ter reconectado nada.
     */
    await salvarCadastroDoWhatsApp({
      tenantId: TENANT,
      locationId: LOCAL,
      phoneNumberId: '109876543210987',
      wabaId: '102030405060708',
      numeroVisivel: null,
      token: 'EAAG',
      escopos: ['whatsapp_business_messaging'],
      ...operador,
    });

    const depois = await salvarCadastroDoWhatsApp({
      tenantId: TENANT,
      locationId: LOCAL,
      phoneNumberId: '109876543210987',
      wabaId: '102030405060708',
      numeroVisivel: '+55 71 3333-9999',
      ...operador,
    });
    expect(depois.escopos).toEqual(['whatsapp_business_messaging']);
  });

  // -- a promoção a ativo (bloco 90) -----------------------------------------

  const estadoNoBanco = async () =>
    (
      await admin.$queryRawUnsafe<{ status: string; display_phone: string | null }[]>(
        `SELECT status::text AS status, display_phone FROM whatsapp_settings
          WHERE location_id = '${LOCAL}'`,
      )
    )[0];

  it('a Meta confirmando o número é o que promove o cadastro a ativo', async () => {
    /**
     * O estado que nunca chegava: nada no produto escrevia `ativo`, e o
     * checklist da tela — que lê `estado === 'ativo'` — ficava para sempre em
     * "Passo 1: conectar o número", com o número conectado e mandando mensagem.
     */
    await cadastrar();
    expect((await estadoNoBanco())?.status).toBe('aguardando_verificacao');

    const provedor = new FakeWhatsAppProvider();
    provedor.numeroVerificado = true;
    const r = await conciliarNumero({
      tenantId: TENANT,
      locationId: LOCAL,
      provider: provedor,
      agora: new Date('2026-09-01T12:00:00Z'),
    });

    expect(r).toEqual({ verificado: true, promovido: true });
    expect((await estadoNoBanco())?.status).toBe('ativo');
  });

  it('número ainda não confirmado não promove nada', async () => {
    // O fake nasce **não** verificado de propósito: é o estado real de um número
    // recém-conectado, e um fake otimista faria este caminho nunca ser exercido.
    await cadastrar();
    const r = await conciliarNumero({
      tenantId: TENANT,
      locationId: LOCAL,
      provider: new FakeWhatsAppProvider(),
      agora: new Date('2026-09-01T12:00:00Z'),
    });

    expect(r).toEqual({ verificado: false, promovido: false });
    expect((await estadoNoBanco())?.status).toBe('aguardando_verificacao');
  });

  it('a conciliação é a única que tira um número da suspensão', async () => {
    /**
     * Quem suspende é a Meta, e quem desfaz é quem fala com ela.
     *
     * Salvar o cadastro **não** ressuscita — isso é o caso logo abaixo. A
     * conciliação sim, porque ela acabou de perguntar: um `ACCOUNT_RECONNECTED`
     * depois de um offboarding chega por aqui, e recusá-lo tornaria a suspensão
     * permanente sem que ninguém tivesse decidido isso. O motivo sai junto,
     * porque ele só explica enquanto vale.
     */
    await cadastrar();
    await exec(
      `UPDATE whatsapp_settings SET status = 'suspenso',
              status_reason = 'qualidade baixa' WHERE location_id = '${LOCAL}'`,
    );

    const provedor = new FakeWhatsAppProvider();
    provedor.numeroVerificado = true;
    const r = await conciliarNumero({
      tenantId: TENANT,
      locationId: LOCAL,
      provider: provedor,
      agora: new Date('2026-09-01T12:00:00Z'),
    });

    expect(r).toEqual({ verificado: true, promovido: true });
    expect((await estadoNoBanco())?.status).toBe('ativo');
  });

  // -- salvar não rebaixa o que já foi provado (bloco 91) ---------------------

  it('trocar o token de um canal ativo não o devolve para "falta confirmar"', async () => {
    /**
     * Aconteceu em produção: a conciliação promoveu o cadastro a `ativo`, o dono
     * salvou o token permanente minutos depois, e o painel voltou a dizer que
     * faltava confirmar o número — com `verified_at` preenchido na mesma linha.
     *
     * Rotação de credencial é operação normal de segurança, e ela não pode
     * desfazer uma posse já provada: `verified_at` é fato do passado.
     */
    await cadastrar();
    const provedor = new FakeWhatsAppProvider();
    provedor.numeroVerificado = true;
    await conciliarNumero({
      tenantId: TENANT,
      locationId: LOCAL,
      provider: provedor,
      agora: new Date('2026-09-01T12:00:00Z'),
    });
    expect((await estadoNoBanco())?.status).toBe('ativo');

    const depois = await cadastrar('EAAG-token-permanente');
    expect(depois.estado).toBe('ativo');
    expect(depois.verificadoEm).not.toBeNull();
  });

  it('salvar não ressuscita um número que a Meta suspendeu, e o motivo fica', async () => {
    /**
     * O outro lado da mesma escada. `suspenso` é decisão da Meta, e quem sai
     * dela é a conciliação — a única que fala com ela. E o motivo precisa
     * sobreviver: a CHECK recusa suspenso sem motivo, então limpá-lo aqui faria
     * salvar o cadastro morrer com erro de banco no balcão.
     */
    await cadastrar();
    await exec(
      `UPDATE whatsapp_settings SET status = 'suspenso',
              status_reason = 'qualidade baixa' WHERE location_id = '${LOCAL}'`,
    );

    const depois = await cadastrar('EAAG-token-novo');
    expect(depois.estado).toBe('suspenso');
    expect(depois.motivo).toBe('qualidade baixa');
  });

  // -- a rota do webhook, ao trocar de número (bloco 88) ----------------------

  const rotas = () =>
    admin.$queryRawUnsafe<{ phone_number_id: string; location_id: string }[]>(
      `SELECT phone_number_id, location_id FROM whatsapp_numbers ORDER BY phone_number_id`,
    );

  it('trocar de número apaga a rota do antigo', async () => {
    /**
     * O caso real: a barbearia perde a conta na Meta, cria outra e reconecta com
     * número novo. `whatsapp_settings` é por unidade e o `ON CONFLICT` sobrescreve
     * a linha inteira — a rota velha ficava órfã, apontando para esta barbearia
     * por um `phone_number_id` que já não é dela.
     *
     * Hoje é estado morto. No dia em que a Meta reciclar aquele id para outra
     * empresa, o webhook dela cai aqui dentro: telefone e texto de cliente
     * alheio gravados sob o nosso tenant.
     */
    await cadastrar();
    await salvarCadastroDoWhatsApp({
      tenantId: TENANT,
      locationId: LOCAL,
      phoneNumberId: '111111111111111',
      wabaId: '102030405060708',
      numeroVisivel: null,
      ...operador,
    });

    expect(await rotas()).toEqual([{ phone_number_id: '111111111111111', location_id: LOCAL }]);
  });

  it('a rota que outra unidade assumiu não é apagada junto', async () => {
    /**
     * O `location_id` no `DELETE` não é defesa repetida — é a regra.
     *
     * Numa rede, a unidade que ficou com o número antigo é dona legítima daquela
     * linha. Sem o filtro, a matriz reconectando com um número novo apagaria a
     * rota da filial, e o webhook dela passaria a chegar sem dono — sem erro,
     * sem log, e sem nada na tela que explicasse por que as mensagens de uma
     * loja pararam de ser recebidas.
     */
    const OUTRA = 'a5555555-0000-0000-0000-000000000003';
    await exec(`INSERT INTO locations (id, tenant_id, name, timezone)
                VALUES ('${OUTRA}', '${TENANT}', 'Filial', 'America/Bahia')`);

    await cadastrar();
    // A filial assume o número que era da matriz.
    await salvarCadastroDoWhatsApp({
      tenantId: TENANT,
      locationId: OUTRA,
      phoneNumberId: '109876543210987',
      wabaId: '102030405060708',
      numeroVisivel: null,
      token: 'EAAG',
      ...operador,
    });
    // E a matriz conecta um número novo.
    await salvarCadastroDoWhatsApp({
      tenantId: TENANT,
      locationId: LOCAL,
      phoneNumberId: '111111111111111',
      wabaId: '102030405060708',
      numeroVisivel: null,
      ...operador,
    });

    expect(await rotas()).toEqual([
      { phone_number_id: '109876543210987', location_id: OUTRA },
      { phone_number_id: '111111111111111', location_id: LOCAL },
    ]);
  });

  // -- os templates ----------------------------------------------------------

  it('o template nasce pendente e a resposta da Meta o move', async () => {
    const provedor = new FakeWhatsAppProvider();
    const criado = await submeterEEntregar({
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

  it('o balcão não espera a Meta: a requisição reserva, enfileira e volta', async () => {
    /**
     * O bloco 133 inteiro em um teste.
     *
     * Medido em produção, o `POST` que fazia a viagem à Meta dentro da
     * requisição levava 7.039 ms contra o teto de 10 s do `web` — e estourar
     * significava a tela dizer "não deu" sobre um texto que a Meta **já tinha
     * recebido**, com a tentativa seguinte batendo em "nome repetido".
     *
     * A prova não é o tempo: é que a linha volta em `pendente` **na fila**, com
     * a tarefa gravada, e que nada foi à Meta até alguém entregar.
     */
    const criado = await submeterTemplate({
      tenantId: TENANT,
      locationId: LOCAL,
      tipo: 'retorno',
      titulo: 'Volta que a gente sente falta',
      corpo: 'Olá {{1}}, a barbearia {{2}} sente sua falta.',
      ...operador,
    });
    expect(criado.estado).toBe('pendente');
    expect(criado.naFila).toBe(true);

    const tarefas = await semTenant(async (tx) =>
      tx.$queryRaw<{ kind: string; payload: unknown }[]>`
        SELECT kind, payload FROM jobs WHERE payload->>'templateId' = ${criado.id}
      `,
    );
    expect(tarefas).toHaveLength(1);
    expect(tarefas[0]?.kind).toBe('whatsapp.submeter_template');
    /**
     * Ids, nunca o texto: `jobs` não tem RLS, e o que a barbearia escreveu é
     * dela. Quem lê o corpo é o handler, sob `withTenant`.
     */
    expect(JSON.stringify(tarefas[0]?.payload)).not.toContain('sente sua falta');

    const claim = String((tarefas[0]?.payload as { claim?: unknown })?.claim ?? '');
    const provedor = new FakeWhatsAppProvider();
    await entregarTemplateNaMeta({
      tenantId: TENANT,
      templateId: criado.id,
      claim,
      provider: provedor,
    });
    expect(provedor.submetidos).toHaveLength(1);
    expect(provedor.submetidos[0]?.corpo).toContain('sente sua falta');

    // E a tela para de dizer "na fila" quando ela deixa de estar.
    expect((await templateDaUnidade(TENANT, criado.id))?.naFila).toBe(false);
  });

  it('a entrega atrasada não escreve sobre a reserva de outra tentativa', async () => {
    /**
     * A tarefa pode chegar depois de a barbearia ter corrigido o texto.
     *
     * Sem a conferência do claim, a entrega velha gravaria a resposta da Meta
     * sobre a reserva nova — e o texto certo ficaria com o desfecho do errado,
     * sem nada ficar vermelho.
     */
    const criado = await submeterTemplate({
      tenantId: TENANT,
      locationId: LOCAL,
      tipo: 'retorno',
      titulo: 'Volta',
      corpo: 'primeira versão {{1}}',
      ...operador,
    });
    const provedor = new FakeWhatsAppProvider();
    await entregarTemplateNaMeta({
      tenantId: TENANT,
      templateId: criado.id,
      claim: '00000000-0000-4000-8000-000000000000',
      provider: provedor,
    });
    expect(provedor.submetidos).toHaveLength(0);
    expect((await templateDaUnidade(TENANT, criado.id))?.naFila).toBe(true);
  });

  it('o texto preso pela tarefa que desistiu volta a rascunho, e não fica para sempre', async () => {
    /**
     * `sending` é o estado que **recusa a submissão seguinte**. Sem esta
     * varredura, a tarefa esgotada deixaria a barbearia sem o texto e sem o
     * caminho de refazê-lo — sem erro e sem alerta.
     *
     * O relógio é o do banco, então o teste envelhece a linha à mão: é o único
     * jeito determinístico de atravessar duas horas.
     */
    const criado = await submeterTemplate({
      tenantId: TENANT,
      locationId: LOCAL,
      tipo: 'retorno',
      titulo: 'Preso',
      corpo: 'Olá {{1}}',
      ...operador,
    });
    expect((await templateDaUnidade(TENANT, criado.id))?.naFila).toBe(true);

    // Ainda dentro do prazo: soltar aqui duplicaria a submissão que o claim
    // existe para impedir.
    expect(await liberarTemplatesAbandonados(TENANT)).toBe(0);

    await envelhecerSubmissao(criado.id, '3 hours');
    expect(await liberarTemplatesAbandonados(TENANT)).toBe(1);

    const solto = await templateDaUnidade(TENANT, criado.id);
    expect(solto?.estado).toBe('rascunho');
    expect(solto?.naFila).toBe(false);
    // O texto continua inteiro: o que se perde é a tentativa, não o trabalho.
    expect(solto?.corpo).toBe('Olá {{1}}');
  });

  it('o texto que a Meta já conhece não é solto pela varredura', async () => {
    /**
     * Com `meta_id`, quem resolve é a conciliação por nome. Soltar aqui criaria
     * a segunda submissão de um texto que a Meta já tem — e ela recusa por nome
     * repetido, com uma frase que não explica nada disso.
     */
    const criado = await submeterTemplate({
      tenantId: TENANT,
      locationId: LOCAL,
      tipo: 'retorno',
      titulo: 'Ja na meta',
      corpo: 'Olá {{1}}',
      ...operador,
    });
    // `withTenant` pelo mesmo motivo de `envelhecerSubmissao`: sem tenant no
    // contexto, este `UPDATE` não alcançaria linha nenhuma e o teste passaria
    // pelo motivo errado.
    await withTenant(TENANT, async (tx) => {
      await tx.$executeRaw`
        UPDATE whatsapp_templates SET meta_id = 'meta.9' WHERE id = ${criado.id}::uuid
      `;
    });
    await envelhecerSubmissao(criado.id, '3 hours');
    expect(await liberarTemplatesAbandonados(TENANT)).toBe(0);
  });

  it('o pendente entra na fila de conciliação e o aprovado sai', async () => {
    const provedor = new FakeWhatsAppProvider();
    const criado = await submeterEEntregar({
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
      submeterEEntregar({
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

  /**
   * A segunda submissão do mesmo aviso **edita**, e não cria.
   *
   * O nome é derivado do tipo desde o bloco 89, então corrigir uma vírgula num
   * texto já enviado cai sempre neste caso. Criar sobre um nome que a Meta já
   * conhece é recusado por ela — e a frase que voltava não explicava nada, o
   * que fazia "não atualiza as mensagens já aprovadas" parecer defeito da tela.
   */
  it('reenviar o mesmo aviso edita o texto na Meta em vez de criar outro', async () => {
    await cadastrar();
    const provedor = new FakeWhatsAppProvider();
    provedor.proximoEstadoDoTemplate = 'aprovado';

    await submeterEEntregar({
      tenantId: TENANT,
      locationId: LOCAL,
      tipo: 'retorno',
      corpo: 'Olá {{1}}, sentimos sua falta na {{2}}.',
      provider: provedor,
      ...operador,
    });
    expect(provedor.submetidos).toHaveLength(1);
    expect(provedor.editados).toHaveLength(0);

    await submeterEEntregar({
      tenantId: TENANT,
      locationId: LOCAL,
      tipo: 'retorno',
      corpo: 'Olá {{1}}, sentimos sua falta na {{2}}!',
      provider: provedor,
      ...operador,
    });

    expect(provedor.editados).toHaveLength(1);
    expect(provedor.editados[0]?.corpo).toContain('!');
  });

  /**
   * A barbearia escolhe os botões, dentro do que aquele aviso aceita.
   *
   * A regra antiga era categórica — botão sai do tipo, nunca do formulário —, e
   * existia por um mecanismo: o motor montava os botões na hora do envio, e a
   * Meta casa a resposta pela **posição**. Um texto aprovado com dois botões
   * recebendo três faria o cliente apertar "Confirmar" e o produto entender
   * "Cancelar".
   *
   * O motor passou a ler os botões da linha do template, que é o que a Meta
   * aprovou. A divergência deixou de ser possível, e com ela caiu o motivo de a
   * escolha não existir.
   */
  it('a barbearia escolhe os botões do texto', async () => {
    await cadastrar();
    const provedor = new FakeWhatsAppProvider();

    await submeterEEntregar({
      tenantId: TENANT,
      locationId: LOCAL,
      tipo: 'lembrete_24h',
      corpo: 'Oi {{1}}, amanhã às {{2}} com {{3}}.',
      botoes: ['confirmar', 'cancelar'],
      provider: provedor,
      ...operador,
    });

    expect(provedor.submetidos.at(-1)?.botoes).toEqual(['confirmar', 'cancelar']);
  });

  /**
   * E não escolhe o que aquele aviso não aceita.
   *
   * `confirmar` mexe num agendamento provado, e quem recebe campanha não tem
   * nenhum: aprovado assim, o cliente aperta, o produto responde "o horário não
   * é de quem respondeu", e nada acontece sem que ninguém saiba por quê.
   */
  it('botão que o aviso não aceita é recusado antes de ir à Meta', async () => {
    await cadastrar();
    const provedor = new FakeWhatsAppProvider();

    await expect(
      submeterEEntregar({
        tenantId: TENANT,
        locationId: LOCAL,
        tipo: 'retorno',
        corpo: 'Oi {{1}}, volte à {{2}}.',
        botoes: ['confirmar'],
        provider: provedor,
        ...operador,
      }),
    ).rejects.toMatchObject({ code: 'botao_invalido' });

    expect(provedor.submetidos).toHaveLength(0);
  });

  /**
   * Os botões que **levam a algum lugar**, com o destino do cadastro da casa.
   *
   * A Meta aceita três tipos e o produto só usava um. `agendar_novamente` é
   * resposta rápida: quem aperta **não vai a lugar nenhum** — o produto registra
   * a intenção e a pessoa fica parada na conversa. O de link resolve isso.
   *
   * O endereço não é digitado: sai do slug, que é permanente desde o bloco 1. Um
   * campo livre seria um link errado mandado para mil pessoas.
   */
  it('o botão de agendar leva para a página da barbearia', async () => {
    await cadastrar();
    /**
     * A semente satisfaz tudo menos a regra sob teste: o destino sai do slug e
     * do endereço público, e sem os dois o que se mede é a recusa, não o link.
     */
    await exec(`
      INSERT INTO tenant_slugs (slug, tenant_id) VALUES ('domari', '${TENANT}')
      ON CONFLICT DO NOTHING;
    `);
    process.env['WEB_URL'] = 'https://barbearia.exemplo';
    const provedor = new FakeWhatsAppProvider();

    await submeterEEntregar({
      tenantId: TENANT,
      locationId: LOCAL,
      tipo: 'retorno',
      corpo: 'Oi {{1}}, volte à {{2}}!',
      acoes: ['abrir_agenda'],
      provider: provedor,
      ...operador,
    });

    const enviado = provedor.submetidos.at(-1);
    expect(enviado?.acoes).toHaveLength(1);
    expect(enviado?.acoes?.[0]?.botao).toBe('abrir_agenda');
    expect(enviado?.acoes?.[0]?.destino).toBe('https://barbearia.exemplo/domari');
  });

  /**
   * Sem telefone cadastrado, o botão de ligação é **recusado**.
   *
   * Sair vazio seria pior: a Meta aprovaria um botão que não disca, e o cliente
   * apertaria sem nada acontecer — a classe de defeito que o produto já pagou
   * três vezes hoje, com o botão desenhado na tela e inerte no aparelho.
   */
  it('sem telefone da unidade, o botão de ligar é recusado antes de ir à Meta', async () => {
    await cadastrar();
    await exec(`UPDATE locations SET phone_e164 = NULL WHERE id = '${LOCAL}'`);
    const provedor = new FakeWhatsAppProvider();

    await expect(
      submeterEEntregar({
        tenantId: TENANT,
        locationId: LOCAL,
        tipo: 'retorno',
        corpo: 'Oi {{1}}, volte à {{2}}!',
        acoes: ['ligar'],
        provider: provedor,
        ...operador,
      }),
    ).rejects.toMatchObject({ code: 'sem_telefone_da_casa' });

    expect(provedor.submetidos).toHaveLength(0);
  });

  // -- a mensagem avulsa (bloco 92) -------------------------------------------

  /**
   * O envio avulso passa pelas **mesmas** guardas do automático.
   *
   * A tentação é isentá-lo: tem gente decidindo, então seria "de verdade". Mas
   * consentimento é lei, o teto do mês existe para o número não ser queimado, e
   * a janela de silêncio é sobre o cliente dormindo — nenhuma das três some
   * porque quem apertou foi uma pessoa. Isento, o manual viraria o caminho mais
   * curto para furar as três, e o caminho mais curto é o que todo mundo usa.
   */
  it('mensagem avulsa respeita quem revogou o marketing', async () => {
    await ativar();
    await aprovarTemplate('retorno', 'Olá {{1}}, sentimos sua falta na {{2}}.');
    await exec(`UPDATE customers SET accepts_marketing = false WHERE id = '${CARLOS}'`);

    let saiu = false;
    const resultado = await enviarMensagemAvulsa({
      tenantId: TENANT,
      locationId: LOCAL,
      customerId: CARLOS,
      tipo: 'retorno',
      idempotencyKey: 'avulsa-optout',
      agora: new Date('2026-09-20T15:00:00Z'),
      timeZone: 'America/Bahia',
      ...operador,
      enviar: async () => {
        saiu = true;
        return 'wamid.x';
      },
    });

    expect(resultado.enviado).toBe(false);
    expect(resultado.motivo).toBeTruthy();
    expect(saiu).toBe(false);
  });

  it('mensagem avulsa sai e conta no teto do mês', async () => {
    await ativar();
    await aprovarTemplate('retorno', 'Olá {{1}}, sentimos sua falta na {{2}}.');
    // A semente satisfaz tudo menos a regra sob teste: `accepts_marketing`
    // nasce falso nesta suíte, e sem isto o que se mede é o opt-out de novo.
    await exec(`UPDATE customers SET accepts_marketing = true WHERE id = '${CARLOS}'`);

    const resultado = await enviarMensagemAvulsa({
      tenantId: TENANT,
      locationId: LOCAL,
      customerId: CARLOS,
      tipo: 'retorno',
      idempotencyKey: 'avulsa-conta',
      agora: new Date('2026-09-20T15:00:00Z'),
      timeZone: 'America/Bahia',
      ...operador,
      enviar: async () => 'wamid.avulsa',
    });

    expect(resultado.enviado).toBe(true);

    /**
     * A linha em `notifications` é o que faz esta mensagem contar.
     *
     * Sem ela o envio avulso seria o furo do teto: quatro pelo motor e quantas
     * quisessem pelo balcão, com a Meta somando todas do lado dela.
     */
    const linhas = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM notifications WHERE customer_id = '${CARLOS}' AND status = 'sent'`,
    );
    expect(Number(linhas[0]?.n ?? 0)).toBe(1);
  });

  /**
   * A ficha manda **o texto que o balcão apertou** (bloco 96).
   *
   * Ela listava os três convites de retorno aprovados com um botão cada, e os
   * três mandavam o mesmo: o formulário postava o `tipo`, e o motor pegava o
   * primeiro aprovado dele. A recepção lia "volte que sentimos sua falta",
   * apertava, e o cliente recebia "seu pacote está acabando".
   */
  it('mensagem avulsa manda o texto escolhido, e não o primeiro do tipo', async () => {
    await ativar();
    await exec(`UPDATE customers SET accepts_marketing = true WHERE id = '${CARLOS}'`);
    await aprovarTemplate('retorno', 'Volte, {{1}}! Sentimos sua falta na {{2}}.');
    const segundo = await aprovarTemplate(
      'retorno',
      'Oi {{1}}, seu pacote na {{2}} está acabando.',
      'pacote_acabando',
    );

    let escolhido: string | null = 'nada';
    const resultado = await enviarMensagemAvulsa({
      tenantId: TENANT,
      locationId: LOCAL,
      customerId: CARLOS,
      templateId: segundo.id,
      idempotencyKey: 'avulsa-escolhido',
      agora: new Date('2026-09-20T15:00:00Z'),
      timeZone: 'America/Bahia',
      ...operador,
      enviar: async (destino) => {
        escolhido = destino.templateId;
        return 'wamid.escolhido';
      },
    });

    expect(resultado.enviado).toBe(true);
    // O segundo, e não o primeiro que a consulta por tipo acharia.
    expect(escolhido).toBe(segundo.id);
  });

  it('mensagem avulsa recusa o texto da barbearia vizinha', async () => {
    /**
     * A checagem de integridade referencial do Postgres ignora row security: a
     * chave estrangeira aceitaria o id alheio sem reclamar.
     *
     * Quem recusa aqui é a **política**, e não uma cláusula escrita — a leitura
     * roda dentro de `withTenant`, e a linha da vizinha não existe para ela. O
     * caso que prova o filtro escrito é o de baixo, o da outra loja: ali a
     * política enxerga a linha, porque a RLS separa barbearias e não separa
     * lojas dentro de uma.
     */
    await ativar();
    await exec(`UPDATE customers SET accepts_marketing = true WHERE id = '${CARLOS}'`);
    // A semente satisfaz **tudo menos** a regra sob teste: sem um `retorno`
    // aprovado aqui, a recusa viria da falta de texto e o caso passaria verde
    // com a conferência removida.
    await aprovarTemplate('retorno', 'Volte, {{1}}! Sentimos sua falta na {{2}}.');
    await exec(`
      INSERT INTO whatsapp_templates (id, tenant_id, location_id, kind, name, status, body)
      VALUES ('b5555555-0000-4000-8000-0000000000ff', '${RIVAL}', '${LOCAL_RIVAL}',
              'retorno', 'deles_v1', 'aprovado', 'Oi {{1}}, na {{2}}.');
    `);

    await expect(
      enviarMensagemAvulsa({
        tenantId: TENANT,
        locationId: LOCAL,
        customerId: CARLOS,
        templateId: 'b5555555-0000-4000-8000-0000000000ff',
        idempotencyKey: 'avulsa-rival',
        agora: new Date('2026-09-20T15:00:00Z'),
        timeZone: 'America/Bahia',
        ...operador,
        enviar: async () => 'wamid.nao',
      }),
    ).rejects.toMatchObject({ code: 'sem_texto_aprovado' });
  });

  it('mensagem avulsa recusa o texto aprovado no número da outra loja', async () => {
    /**
     * A RLS separa barbearias e **não** separa lojas dentro de uma: a leitura
     * sob RLS acha o texto da filial sem reclamar. Quem recusa é o filtro por
     * unidade, e é ele que este caso prova — o da vizinha passa pela política e
     * não exercita esta linha.
     *
     * Importa porque o template é aprovado **por número**: mandar o da filial
     * pelo número da matriz é a Meta recusando a mensagem no balcão.
     */
    await ativar();
    await exec(`UPDATE customers SET accepts_marketing = true WHERE id = '${CARLOS}'`);
    // Mesma razão do caso da vizinha: sem um `retorno` aprovado nesta unidade,
    // a recusa viria da falta de texto e não do filtro por unidade.
    await aprovarTemplate('retorno', 'Volte, {{1}}! Sentimos sua falta na {{2}}.');
    const FILIAL = 'a5555555-0000-0000-0000-000000000004';
    await exec(`
      INSERT INTO locations (id, tenant_id, name, timezone)
      VALUES ('${FILIAL}', '${TENANT}', 'Filial', 'America/Bahia');

      INSERT INTO whatsapp_templates (id, tenant_id, location_id, kind, name, status, body)
      VALUES ('b5555555-0000-4000-8000-0000000000fe', '${TENANT}', '${FILIAL}',
              'retorno', 'da_filial_v1', 'aprovado', 'Oi {{1}}, na {{2}}.');
    `);

    await expect(
      enviarMensagemAvulsa({
        tenantId: TENANT,
        locationId: LOCAL,
        customerId: CARLOS,
        templateId: 'b5555555-0000-4000-8000-0000000000fe',
        idempotencyKey: 'avulsa-filial',
        // Recusado antes de qualquer envio: se a conferência sumir, esta
        // chamada acontece e o caso fica vermelho por não ter lançado.
        agora: new Date('2026-09-20T15:00:00Z'),
        timeZone: 'America/Bahia',
        ...operador,
        enviar: async () => 'wamid.nao',
      }),
    ).rejects.toMatchObject({ code: 'sem_texto_aprovado' });
  });

  it('mensagem avulsa recusa texto que fala de horário marcado', async () => {
    await ativar();
    await expect(
      enviarMensagemAvulsa({
        tenantId: TENANT,
        locationId: LOCAL,
        customerId: CARLOS,
        tipo: 'lembrete_24h',
        idempotencyKey: 'avulsa-tipo-invalido',
        agora: new Date('2026-09-20T15:00:00Z'),
        timeZone: 'America/Bahia',
        ...operador,
        enviar: async () => null,
      }),
    ).rejects.toMatchObject({ code: 'tipo_invalido' });
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

    // Nem um `failed` atrasado/contraditório: depois de lida existe prova
    // positiva de entrega, então a falha só pode ser aceita enquanto estava
    // apenas em `enviada`.
    expect(
      await registrarEstadoDaMensagem({ tenantId: TENANT, wamid: enviada!.wamid, estado: 'falhou' }),
    ).toBe(false);

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
