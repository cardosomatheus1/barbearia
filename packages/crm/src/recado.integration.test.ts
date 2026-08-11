import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '@barbearia/db';
import { MAXIMO_DO_RECADO } from '@barbearia/core';
import {
  RecadoError,
  assumirRecado,
  encerrarRecado,
  recadoPorId,
  recadosDaCasa,
  registrarRecado,
  responderRecado,
  respostaParaEnviar,
  TAREFA_DE_RESPOSTA,
} from './recado.js';
import { anonimizarCliente } from './anonimizacao.js';

/**
 * O canal de recados contra Postgres real (bloco 40).
 *
 * O que só o banco prova: que a reclamação anônima existe de verdade, que a
 * resposta e a tarefa que a entrega nascem na **mesma** transação, que a
 * anonimização solta o vínculo sem levar a melhoria junto — e que não há
 * caminho de código capaz de apagar uma reclamação.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

const TENANT = '40404040-1111-1111-1111-111111111111';
const RIVAL = '40404040-2222-2222-2222-222222222222';
const LOCAL = 'a0404040-0000-0000-0000-000000000001';
const LOCAL_RIVAL = 'a0404040-0000-0000-0000-000000000002';
const CARLOS = 'c0404040-0000-0000-0000-000000000001';
const BRUNO = 'c0404040-0000-0000-0000-000000000002';
const DONO = 'd0404040-0000-0000-0000-000000000001';
const RUAN = 'd0404040-0000-0000-0000-000000000002';

const AGORA = new Date('2026-09-20T15:00:00Z');
const ator = { id: DONO, name: 'Matheus' };

let admin: PrismaClient;

async function exec(sql: string): Promise<void> {
  for (const parte of sql.split(';').map((p) => p.trim()).filter(Boolean)) {
    await admin.$executeRawUnsafe(parte);
  }
}

describeIfDb('recados do cliente', () => {
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
        ('${LOCAL_RIVAL}', '${RIVAL}', 'Filial da vizinha', 'America/Bahia');

      INSERT INTO customers (id, tenant_id, name, phone_e164) VALUES
        ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777'),
        ('${BRUNO}', '${TENANT}', 'Bruno Lima', '+5571977776666');

      INSERT INTO staff_users (id, tenant_id, name, email, password_hash, role) VALUES
        ('${DONO}', '${TENANT}', 'Matheus', 'dono@domari.com.br', 'x', 'owner'),
        ('${RUAN}', '${TENANT}', 'Ruan', 'ruan@domari.com.br', 'x', 'professional');
    `);
  });

  const mandar = (extra: Record<string, unknown> = {}) =>
    registrarRecado({
      tenantId: TENANT,
      locationId: LOCAL,
      tipo: 'reclamacao',
      texto: 'Esperei quarenta minutos e ninguém me avisou nada.',
      ...extra,
    });

  const tarefas = () =>
    admin.$queryRaw<{ kind: string; payload: unknown }[]>`
      SELECT kind, payload FROM jobs ORDER BY created_at
    `;

  // -- registrar ---------------------------------------------------------------

  it('a reclamação anônima existe, sem cliente e sem atendimento', async () => {
    /**
     * É a mais honesta que há, e a mais fácil de perder: quem desistiu da fila e
     * foi embora não tem cadastro nem agendamento. Exigir qualquer um dos dois
     * apagaria justamente quem mais tem o que contar.
     */
    const { id } = await mandar();
    const recado = await recadoPorId(TENANT, id, AGORA);

    expect(recado).toMatchObject({
      tipo: 'reclamacao',
      estado: 'aberto',
      clienteId: null,
      temContato: false,
    });
  });

  it('texto curto não vira recado', async () => {
    await expect(mandar({ texto: 'ruim' })).rejects.toMatchObject({ code: 'texto_curto' });
  });

  it('texto sem fim é recusado na borda do domínio, não pela constraint', async () => {
    await expect(mandar({ texto: 'a'.repeat(MAXIMO_DO_RECADO + 1) })).rejects.toBeInstanceOf(
      RecadoError,
    );
  });

  it('tipo que não existe não chega ao banco', async () => {
    await expect(mandar({ tipo: 'processo' })).rejects.toMatchObject({ code: 'tipo_invalido' });
  });

  it('unidade de outra barbearia não recebe recado', async () => {
    // A RLS já esconde a unidade alheia; a recusa explícita é o que impede a
    // linha de nascer apontando para o nada.
    await expect(mandar({ locationId: LOCAL_RIVAL })).rejects.toMatchObject({
      code: 'unidade_desconhecida',
    });
  });

  it('atendimento de outra pessoa não gruda no recado', async () => {
    /**
     * A checagem de integridade referencial do Postgres ignora row security, e
     * a chave estrangeira aceitaria o id. Sem conferir o **dono**, alguém
     * amarraria a própria reclamação ao atendimento de terceiro — e a ficha
     * daquela pessoa passaria a exibir um texto que ela não escreveu.
     */
    await exec(`
      INSERT INTO professionals (id, tenant_id, location_id, name)
      VALUES ('b0404040-0000-0000-0000-000000000001', '${TENANT}', '${LOCAL}', 'Ruan');
      INSERT INTO appointments
        (id, tenant_id, location_id, professional_id, customer_id,
         starts_at, ends_at, service_starts_at, service_ends_at, price_cents)
      VALUES ('e0404040-0000-0000-0000-000000000001', '${TENANT}', '${LOCAL}',
              'b0404040-0000-0000-0000-000000000001', '${BRUNO}',
              '2026-09-21T12:00:00Z', '2026-09-21T12:30:00Z',
              '2026-09-21T12:00:00Z', '2026-09-21T12:30:00Z', 4900);
    `);

    const { id } = await mandar({
      customerId: CARLOS,
      appointmentId: 'e0404040-0000-0000-0000-000000000001',
    });
    expect((await recadoPorId(TENANT, id, AGORA))?.agendamentoId).toBeNull();
  });

  // -- a fila de triagem -------------------------------------------------------

  it('a fila põe a reclamação na frente do elogio mais antigo', async () => {
    await mandar({ tipo: 'elogio', texto: 'O Ruan cortou muito bem, valeu demais.' });
    await mandar({ tipo: 'reclamacao' });

    const fila = await recadosDaCasa(TENANT, { locationId: LOCAL, agora: AGORA });
    expect(fila.map((r) => r.tipo)).toEqual(['reclamacao', 'elogio']);
  });

  it('a fila não mostra o recado da barbearia vizinha', async () => {
    await mandar();
    const daVizinha = await recadosDaCasa(RIVAL, { locationId: LOCAL, agora: AGORA });
    expect(daVizinha).toHaveLength(0);
  });

  it('encerrado sai da fila, mas continua existindo', async () => {
    const { id } = await mandar();
    await encerrarRecado({ tenantId: TENANT, recadoId: id, ator, agora: AGORA });

    expect(await recadosDaCasa(TENANT, { locationId: LOCAL, agora: AGORA })).toHaveLength(0);
    expect(
      await recadosDaCasa(TENANT, { locationId: LOCAL, incluirEncerrados: true, agora: AGORA }),
    ).toHaveLength(1);
  });

  // -- assumir -----------------------------------------------------------------

  it('assumir tira o recado da triagem e registra na trilha', async () => {
    const { id } = await mandar();
    await assumirRecado({ tenantId: TENANT, recadoId: id, responsavelId: RUAN, ator });

    const recado = await recadoPorId(TENANT, id, AGORA);
    expect(recado).toMatchObject({ estado: 'em_analise', responsavelNome: 'Ruan' });

    const trilha = await withTenant(TENANT, (tx) =>
      tx.$queryRaw<{ action: string }[]>`SELECT action FROM audit_log`,
    );
    expect(trilha.map((t) => t.action)).toContain('feedback.assigned');
  });

  it('quem não é da equipe não vira responsável', async () => {
    const { id } = await mandar();
    await expect(
      assumirRecado({
        tenantId: TENANT,
        recadoId: id,
        responsavelId: 'd0404040-0000-0000-0000-00000000dead',
        ator,
      }),
    ).rejects.toMatchObject({ code: 'responsavel_desconhecido' });
  });

  it('recado encerrado não volta a ser assumido', async () => {
    const { id } = await mandar();
    await encerrarRecado({ tenantId: TENANT, recadoId: id, ator, agora: AGORA });
    await expect(
      assumirRecado({ tenantId: TENANT, recadoId: id, responsavelId: RUAN, ator }),
    ).rejects.toMatchObject({ code: 'transicao_invalida' });
  });

  // -- responder ---------------------------------------------------------------

  it('responder grava a resposta e enfileira o envio na mesma transação', async () => {
    /**
     * É a razão de `crm` depender de `jobs`. Em transações separadas existe a
     * janela em que o balcão lê "respondido" e o cliente nunca recebe nada — e
     * este canal existe para a mensagem chegar.
     */
    const { id } = await mandar({ customerId: CARLOS });
    await responderRecado({
      tenantId: TENANT,
      recadoId: id,
      resposta: 'Desculpe pela espera. Reforçamos a escala de sábado.',
      ator,
      agora: AGORA,
    });

    const recado = await recadoPorId(TENANT, id, AGORA);
    expect(recado).toMatchObject({ estado: 'respondido' });
    expect(recado?.resposta).toContain('Reforçamos');

    const fila = await tarefas();
    expect(fila.map((t) => t.kind)).toContain(TAREFA_DE_RESPOSTA);
    // Id, nunca conteúdo: `jobs` não tem RLS, e a resposta a uma reclamação é
    // conversa entre o cliente e a casa.
    expect(JSON.stringify(fila)).not.toContain('Reforçamos');
  });

  it('recado anônimo não é dado como respondido', async () => {
    /**
     * Sem cliente não há telefone, e sem telefone não há resposta. Gravar
     * "respondido" seria o pior tipo de indicador: o que diz que a casa
     * respondeu quando ninguém foi respondido.
     */
    const { id } = await mandar();
    await expect(
      responderRecado({ tenantId: TENANT, recadoId: id, resposta: 'Obrigado!', ator }),
    ).rejects.toMatchObject({ code: 'sem_contato' });

    expect((await recadoPorId(TENANT, id, AGORA))?.estado).toBe('aberto');
  });

  it('quem pediu exclusão deixa de ter para onde responder', async () => {
    /**
     * O cadastro sem telefone não existe neste produto — há `CHECK` que só o
     * admite depois de anonimizado, e foi ele que corrigiu a primeira versão
     * deste teste. Sobra o caso de verdade: a pessoa mandou a reclamação e
     * pediu exclusão antes de a casa responder.
     */
    const { id } = await mandar({ customerId: BRUNO });
    await anonimizarCliente({
      tenantId: TENANT, customerId: BRUNO, motivo: 'pedido do titular', ator,
    });

    await expect(
      responderRecado({ tenantId: TENANT, recadoId: id, resposta: 'Obrigado!', ator }),
    ).rejects.toMatchObject({ code: 'sem_contato' });
  });

  it('resposta em branco é recusada', async () => {
    const { id } = await mandar({ customerId: CARLOS });
    await expect(
      responderRecado({ tenantId: TENANT, recadoId: id, resposta: '   ', ator }),
    ).rejects.toMatchObject({ code: 'resposta_vazia' });
  });

  it('a mensagem sai com o texto da resposta e o nome de quem recebe', async () => {
    const { id } = await mandar({ customerId: CARLOS });
    await responderRecado({
      tenantId: TENANT,
      recadoId: id,
      resposta: 'Já trocamos a cadeira.',
      ator,
      agora: AGORA,
    });

    expect(await respostaParaEnviar(TENANT, id)).toMatchObject({
      telefone: '+5571988887777',
      clienteNome: 'Carlos Souza',
      resposta: 'Já trocamos a cadeira.',
    });
  });

  it('responder de novo depois de encerrado é recusado', async () => {
    const { id } = await mandar({ customerId: CARLOS });
    await encerrarRecado({ tenantId: TENANT, recadoId: id, ator, agora: AGORA });
    await expect(
      responderRecado({ tenantId: TENANT, recadoId: id, resposta: 'Oi', ator }),
    ).rejects.toMatchObject({ code: 'transicao_invalida' });
  });

  // -- o limite ético ----------------------------------------------------------

  it('não existe caminho de código que apague uma reclamação', async () => {
    /**
     * O limite da SPEC §4.10 escrito onde não depende de ninguém lembrar. A
     * tentativa passa pelo mesmo role que a aplicação usa — e é recusada pelo
     * banco, não por um `if`.
     */
    const { id } = await mandar();
    await expect(
      withTenant(TENANT, (tx) => tx.$executeRaw`DELETE FROM feedbacks WHERE id = ${id}::uuid`),
    ).rejects.toThrow();

    expect(await recadoPorId(TENANT, id, AGORA)).not.toBeNull();
  });

  it('anonimizar solta o vínculo e mantém a melhoria', async () => {
    // As duas coisas são verdadeiras ao mesmo tempo: a pessoa sai, e a barbearia
    // continua sabendo que a cadeira do fundo está bamba.
    const { id } = await mandar({
      customerId: CARLOS,
      texto: 'A cadeira do fundo está bamba faz meses.',
    });

    await anonimizarCliente({ tenantId: TENANT, customerId: CARLOS, motivo: 'pedido do titular', ator });

    const recado = await recadoPorId(TENANT, id, AGORA);
    expect(recado?.clienteId).toBeNull();
    expect(recado?.texto).toContain('cadeira do fundo');
  });

  it('a resposta pendente de quem se anonimizou não sai', async () => {
    // A tarefa foi enfileirada antes do pedido de exclusão. O worker pergunta de
    // novo no momento de enviar, e a resposta é "não há para quem".
    const { id } = await mandar({ customerId: CARLOS });
    await responderRecado({
      tenantId: TENANT, recadoId: id, resposta: 'Obrigado pelo aviso.', ator, agora: AGORA,
    });
    await anonimizarCliente({ tenantId: TENANT, customerId: CARLOS, motivo: 'pedido do titular', ator });

    expect(await respostaParaEnviar(TENANT, id)).toBeNull();
  });
});
