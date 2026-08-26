import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WhatsAppDeliveryUnknownError } from '@barbearia/core';
import { withTenant } from '@barbearia/db';
import {
  cancelarTarefas,
  concluirTarefa,
  enfileirar,
  enfileirarAvulso,
  esperaDaTentativa,
  falharTarefa,
  saudeDaFila,
  soltarOrfas,
  tomarTarefas,
} from './fila.js';
import {
  agendarAvisosDoAgendamento,
  cancelarTarefasDoAgendamento,
  executarAvisoDeAgendamento,
  FakeNotificationProvider,
} from './notificacoes.js';
import { agendarFalta, marcarFalta } from './faltas.js';
import {
  agendarVarreduraDeRetorno,
  lerPreferenciasDeAviso,
  salvarPreferenciasDeAviso,
} from './preferencias.js';
import { varrerRetornos } from './notificacoes.js';
import { rodada, type Contexto } from './worker.js';
import { alertasDaBarbearia } from './alertas.js';

/**
 * A fila contra Postgres real.
 *
 * É a primeira coisa do produto que roda sem ninguém esperando, e por isso a
 * primeira em que "duas vezes" não é hipótese: reentrega, worker reiniciado,
 * dois processos disputando a mesma tarefa. Mock não prova nada sobre
 * `FOR UPDATE SKIP LOCKED`.
 */

const SEED_URL = process.env['SEED_DATABASE_URL'];
const APP_URL = process.env['APP_DATABASE_URL'];

const TENANT = '11111111-1111-1111-1111-111111111111';
const RIVAL = '22222222-2222-2222-2222-222222222222';
const LOCATION = 'aaaaaaaa-0000-0000-0000-000000000001';
const RUAN = 'bbbbbbbb-0000-0000-0000-000000000001';
const CARLOS = 'cccccccc-0000-0000-0000-000000000001';
const AGENDAMENTO = 'dddddddd-0000-0000-0000-000000000001';

let admin: PrismaClient;
const describeIfDb = SEED_URL && APP_URL ? describe : describe.skip;

/** O corte é amanhã às 15h de Salvador. */
const COMECA_EM = new Date('2026-09-11T18:00:00Z');
const AGORA = new Date('2026-09-10T13:00:00Z'); // 10h em Salvador

/**
 * A semente inteira numa transação só.
 *
 * Statement a statement, a limpeza e os `INSERT` eram passos independentes: se
 * um deles confirmasse e a chamada fosse repetida — o cliente repete quando a
 * conexão hesita, e o portão roda dez suítes contra o mesmo Postgres —, a
 * repetição encontrava a linha gravada e estourava chave duplicada. A falha
 * caía em duas execuções de cada três, ora num pacote ora noutro, sempre em
 * testes diferentes: retrato de corrida, não de regra errada.
 *
 * Atômica, a repetição recomeça do banco limpo.
 */
async function exec(client: PrismaClient, sql: string): Promise<void> {
  await client.$transaction(
    sql
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean)
      .map((parte) => client.$executeRawUnsafe(parte)),
  );
}


/**
 * O que a plataforma liga no worker, de mentira.
 *
 * `jobs` não conhece `@barbearia/platform` de propósito — o aviso de cobrança
 * fala **pela plataforma com a barbearia**, ao contrário de tudo o mais nesta
 * fila. Aqui esse contrato aparece como duas funções injetadas, e é o que
 * permite provar que o handler chama a certa com o que veio no `payload`.
 */
const avisosDeCobranca: { tenantId: string; faturaId: string; assunto: string }[] = [];
let reguasRodadas = 0;
const vitrinesRefeitas: { tenantId: string; agora: Date }[] = [];
const atribuicoesRodadas: { tenantId: string; agora: Date }[] = [];
const comissoesCobradas: { tenantId: string; agora: Date }[] = [];
/** As varreduras de retenção que o worker mandou rodar, por barbearia. */
const retencoesRodadas: { tenantId: string; agora: Date }[] = [];
const esperasExpiradas: { tenantId: string; agora: Date }[] = [];
const vagasOferecidas: { tenantId: string; professionalId: string }[] = [];
const ofertasVencidas: { tenantId: string; agora: Date }[] = [];
const recadosRespondidos: { tenantId: string; recadoId: string }[] = [];
/** Os alertas que o worker mandou o canal do gestor entregar. */
const alertasEntregues: { tenantId: string; quantos: number }[] = [];
/** As conferências de cobrança online que o worker mandou rodar (bloco 35). */
const conciliacoesRodadas: { tenantId: string; agora: Date }[] = [];

const cobrancasDoClube: { tenantId: string; agora: Date }[] = [];
const liquidacoesRodadas: { tenantId: string; agora: Date }[] = [];
const avisosDoClube: { tenantId: string; assinaturaId: string; motivo: string }[] = [];

let notasProcessadas: { tenantId: string; invoiceId: string }[] = [];
let conciliacoesDeNota: { tenantId: string }[] = [];
let entregasDeNota: { tenantId: string; agora: Date }[] = [];
let respostasDeWhatsApp: { tenantId: string; inboundId: string }[] = [];
let conciliacoesDeWhatsApp: { tenantId: string; agora: Date }[] = [];
let automacoesRodadas: { tenantId: string; agora: Date }[] = [];
let campanhasDespachadas: { tenantId: string; campanhaId: string }[] = [];
let estadoDaNotaDoFake: 'pendente' | 'processando' | 'autorizada' | 'rejeitada' | 'cancelada' =
  'autorizada';

const ligacoesDaPlataforma = () => ({
  processarNota: async (tenantId: string, invoiceId: string) => {
    notasProcessadas.push({ tenantId, invoiceId });
    return estadoDaNotaDoFake;
  },
  entregarNotas: async (tenantId: string, agora: Date) => {
    entregasDeNota.push({ tenantId, agora });
  },
  conciliarNotas: async (tenantId: string) => {
    conciliacoesDeNota.push({ tenantId });
  },
  responderWhatsApp: async (tenantId: string, inboundId: string) => {
    respostasDeWhatsApp.push({ tenantId, inboundId });
  },
  conciliarWhatsApp: async (tenantId: string, agora: Date) => {
    conciliacoesDeWhatsApp.push({ tenantId, agora });
    return { promovido: false, templates: 0 };
  },
  rodarAutomacoes: async (tenantId: string, agora: Date) => {
    automacoesRodadas.push({ tenantId, agora });
  },
  enviarCampanha: async (tenantId: string, campanhaId: string) => {
    campanhasDespachadas.push({ tenantId, campanhaId });
  },
  avisarDeCobranca: async (aviso: {
    readonly tenantId: string;
    readonly faturaId: string;
    readonly assunto: string;
  }) => {
    avisosDeCobranca.push({
      tenantId: aviso.tenantId,
      faturaId: aviso.faturaId,
      assunto: aviso.assunto,
    });
  },
  rodarRegua: async () => {
    reguasRodadas += 1;
  },
  varrerRetencao: async (tenantId: string, agora: Date) => {
    retencoesRodadas.push({ tenantId, agora });
    return { avisados: 0, anonimizados: 0 };
  },
  atualizarVitrine: async (tenantId: string, agora: Date) => {
    vitrinesRefeitas.push({ tenantId, agora });
    return 0;
  },
  atribuirClientesNovos: async (tenantId: string, agora: Date) => {
    atribuicoesRodadas.push({ tenantId, agora });
    return 0;
  },
  cobrarComissaoDoMarketplace: async (tenantId: string, agora: Date) => {
    comissoesCobradas.push({ tenantId, agora });
  },
  expirarEsperas: async (tenantId: string, agora: Date) => {
    esperasExpiradas.push({ tenantId, agora });
    return 0;
  },
  oferecerVagaDaEspera: async (
    tenantId: string,
    vaga: { locationId: string; professionalId: string; inicio: Date; fim: Date },
  ) => {
    vagasOferecidas.push({ tenantId, professionalId: vaga.professionalId });
    return true;
  },
  vencerOfertasDaEspera: async (tenantId: string, agora: Date) => {
    ofertasVencidas.push({ tenantId, agora });
    return 0;
  },
  responderRecadoDoCliente: async (tenantId: string, recadoId: string) => {
    recadosRespondidos.push({ tenantId, recadoId });
    return true;
  },
  avisarDaOperacao: async (tenantId: string, alertas: readonly unknown[]) => {
    alertasEntregues.push({ tenantId, quantos: alertas.length });
  },
  conciliarCobrancas: async (tenantId: string, agora: Date) => {
    conciliacoesRodadas.push({ tenantId, agora });
    return { pagas: 0, encerradas: 0 };
  },
  liquidarRepasses: async (tenantId: string, agora: Date) => {
    liquidacoesRodadas.push({ tenantId, agora });
    return { repassados: 0, retidos: 0 };
  },
  rodarCobrancaDoClube: async (tenantId: string, agora: Date) => {
    cobrancasDoClube.push({ tenantId, agora });
    return { cobradas: 0, suspensas: 0 };
  },
  avisarDoClube: async (tenantId: string, assinaturaId: string, motivo: string) => {
    avisosDoClube.push({ tenantId, assinaturaId, motivo });
    return true;
  },
});

describeIfDb('fila de trabalho', () => {
  let provider: FakeNotificationProvider;
  let contexto: Contexto;
  /** Ligado por padrão, como o catálogo. Um teste abaixo desliga de propósito. */
  let recursosLigados = true;

  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    await exec(admin, `
      TRUNCATE tenants CASCADE;
      TRUNCATE jobs;
      INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Domari'), ('${RIVAL}', 'Rival');

      INSERT INTO locations (id, tenant_id, name, timezone, no_show_after_minutes)
      VALUES ('${LOCATION}', '${TENANT}', 'Matriz', 'America/Bahia', 20);

      INSERT INTO professionals (id, tenant_id, location_id, name, kind)
      VALUES ('${RUAN}', '${TENANT}', '${LOCATION}', 'Ruan', 'professional');

      INSERT INTO customers (id, tenant_id, name, phone_e164)
      VALUES ('${CARLOS}', '${TENANT}', 'Carlos Souza', '+5571988887777');

      INSERT INTO appointments
        (id, tenant_id, location_id, customer_id, professional_id,
         starts_at, ends_at, service_starts_at, service_ends_at, price_cents, status)
      VALUES ('${AGENDAMENTO}', '${TENANT}', '${LOCATION}', '${CARLOS}', '${RUAN}',
              '${COMECA_EM.toISOString()}', '2026-09-11T18:30:00Z',
              '${COMECA_EM.toISOString()}', '2026-09-11T18:30:00Z', 5000, 'confirmed');
    `);

    provider = new FakeNotificationProvider();
    avisosDeCobranca.length = 0;
    retencoesRodadas.length = 0;
    esperasExpiradas.length = 0;
    vagasOferecidas.length = 0;
    ofertasVencidas.length = 0;
    recadosRespondidos.length = 0;
    alertasEntregues.length = 0;
    conciliacoesRodadas.length = 0;
    cobrancasDoClube.length = 0;
    liquidacoesRodadas.length = 0;
    avisosDoClube.length = 0;
    contexto = {
      provider,
      relogio: { agora: () => AGORA },
      recursoLigado: async () => recursosLigados,
      entregarWebhook: async () => 'entregue' as const,
      varrerWebhooks: async () => [],
      varrerVitrine: async () => 0,
      limparUsoDaApi: async () => 0,
      ...ligacoesDaPlataforma(),
    };
  });

  const enfileirarNoTenant = (tarefa: Parameters<typeof enfileirar>[1]) =>
    withTenant(TENANT, (tx) => enfileirar(tx, tarefa));

  const quantasNaFila = async (status = 'pending'): Promise<number> => {
    const linhas = await admin.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM jobs WHERE status = '${status}'`,
    );
    return Number(linhas[0]?.n ?? 0);
  };

  // -- a fila -----------------------------------------------------------------

  it('a mesma chave não entra duas vezes', async () => {
    // Reentrega do mesmo evento não pode virar duas mensagens.
    await enfileirarNoTenant({ kind: 'x', idempotencyKey: 'k' });
    await enfileirarNoTenant({ kind: 'x', idempotencyKey: 'k' });
    expect(await quantasNaFila()).toBe(1);
  });

  it('sem chave, repetir é legítimo', async () => {
    await enfileirarNoTenant({ kind: 'varredura' });
    await enfileirarNoTenant({ kind: 'varredura' });
    expect(await quantasNaFila()).toBe(2);
  });

  it('tarefa do futuro não é tomada', async () => {
    // É isto que transforma a fila em agendador: o lembrete de 24h nasce hoje
    // com `run_after` para amanhã.
    await enfileirarNoTenant({
      kind: 'x',
      rodarApos: new Date(AGORA.getTime() + 60 * 60_000),
    });
    expect(await tomarTarefas(10, 'w', AGORA)).toHaveLength(0);
  });

  it('dois workers não pegam a mesma tarefa', async () => {
    /**
     * A garantia que só o banco dá. Sem `SKIP LOCKED`, o segundo worker ficaria
     * bloqueado atrás do primeiro — dois processos com a vazão de um. Com
     * `SELECT` comum sem trava, os dois pegariam a mesma tarefa e o cliente
     * receberia duas mensagens.
     */
    for (const i of [1, 2, 3, 4]) {
      await enfileirarNoTenant({ kind: 'x', idempotencyKey: `k${i}` });
    }

    const [a, b] = await Promise.all([
      tomarTarefas(2, 'worker-a', AGORA),
      tomarTarefas(2, 'worker-b', AGORA),
    ]);

    const ids = [...a.map((t) => t.id), ...b.map((t) => t.id)];
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });

  it('tomar conta a tentativa', async () => {
    await enfileirarNoTenant({ kind: 'x', idempotencyKey: 'k' });
    const [tarefa] = await tomarTarefas(1, 'w', AGORA);
    expect(tarefa?.attempts).toBe(1);
  });

  it('falha devolve à fila com espera crescente', async () => {
    await enfileirarNoTenant({ kind: 'x', idempotencyKey: 'k' });
    const [tarefa] = await tomarTarefas(1, 'w', AGORA);
    if (!tarefa) throw new Error('nada na fila');

    expect(await falharTarefa(tarefa, 'provedor caiu', AGORA)).toBe('retry');
    expect(await quantasNaFila()).toBe(1);
    // E não está pronta agora: a espera é o que impede o laço apertado.
    expect(await tomarTarefas(1, 'w', AGORA)).toHaveLength(0);
  });

  it('esgotado o teto, a tarefa fica visível como falha', async () => {
    // Mensagem que ninguém enviou e ninguém soube é a pior das duas falhas: a
    // barbearia acha que avisou.
    await enfileirarNoTenant({ kind: 'x', idempotencyKey: 'k', maxAttempts: 1 });
    const [tarefa] = await tomarTarefas(1, 'w', AGORA);
    if (!tarefa) throw new Error('nada na fila');

    expect(await falharTarefa(tarefa, 'erro final', AGORA)).toBe('failed');
    expect(await quantasNaFila('failed')).toBe(1);

    const linhas = await admin.$queryRawUnsafe<{ last_error: string }[]>(
      `SELECT last_error FROM jobs WHERE status = 'failed'`,
    );
    expect(linhas[0]?.last_error).toBe('erro final');
  });

  it('a espera cresce e tem teto', () => {
    expect(esperaDaTentativa(1)).toBe(60_000);
    expect(esperaDaTentativa(2)).toBe(2 * 60_000);
    expect(esperaDaTentativa(3)).toBe(4 * 60_000);
    // Indisponibilidade longa não empurra a tarefa para daqui a dois dias.
    expect(esperaDaTentativa(20)).toBe(60 * 60_000);
  });

  it('órfã de worker morto volta para a fila', async () => {
    // Worker morto no meio deixa a tarefa presa para sempre — e "para sempre"
    // aqui é um cliente que nunca é avisado.
    await enfileirarNoTenant({ kind: 'x', idempotencyKey: 'k' });
    const antes = new Date(AGORA.getTime() - 60 * 60_000);
    await tomarTarefas(1, 'worker-morto', antes);

    expect(await quantasNaFila('running')).toBe(1);
    expect(await soltarOrfas(15, AGORA)).toBe(1);
    expect(await quantasNaFila()).toBe(1);
  });

  it('a órfã não zera o teto de tentativas', async () => {
    // Handler que derruba o processo toda vez precisa acabar em `failed`, não
    // reiniciar o worker eternamente.
    await enfileirarNoTenant({ kind: 'x', idempotencyKey: 'k' });
    const antes = new Date(AGORA.getTime() - 60 * 60_000);
    await tomarTarefas(1, 'worker-morto', antes);
    await soltarOrfas(15, AGORA);

    const [tarefa] = await tomarTarefas(1, 'w', AGORA);
    expect(tarefa?.attempts).toBe(2);
  });

  it('claim antiga não conclui tarefa que outro worker retomou', async () => {
    await enfileirarNoTenant({ kind: 'x', idempotencyKey: 'fencing' });
    const umaHoraAntes = new Date(AGORA.getTime() - 60 * 60_000);
    const [antiga] = await tomarTarefas(1, 'worker-a', umaHoraAntes);
    if (!antiga) throw new Error('nada na fila');

    await soltarOrfas(15, AGORA);
    const [atual] = await tomarTarefas(1, 'worker-b', AGORA);
    if (!atual) throw new Error('tarefa não foi retomada');
    expect(atual.claimToken).not.toBe(antiga.claimToken);

    await concluirTarefa(antiga);
    expect(await quantasNaFila('running')).toBe(1);

    await concluirTarefa(atual);
    expect(await quantasNaFila('done')).toBe(1);
  });

  it('concluir tira da fila', async () => {
    await enfileirarNoTenant({ kind: 'x', idempotencyKey: 'k' });
    const [tarefa] = await tomarTarefas(1, 'w', AGORA);
    if (!tarefa) throw new Error('nada na fila');
    await concluirTarefa(tarefa);
    expect(await quantasNaFila('done')).toBe(1);
  });

  it('cancelar apaga só o que ainda não saiu', async () => {
    await enfileirarNoTenant({ kind: 'x', idempotencyKey: 'k1' });
    await enfileirarNoTenant({ kind: 'x', idempotencyKey: 'k2' });
    await tomarTarefas(1, 'w', AGORA); // uma vira `running`

    const apagadas = await withTenant(TENANT, (tx) =>
      cancelarTarefas(tx, { chaves: ['k1', 'k2'] }),
    );
    expect(apagadas).toBe(1);
    expect(await quantasNaFila('running')).toBe(1);
  });

  // -- os avisos --------------------------------------------------------------

  const LIGADOS = {
    confirmacao: true,
    lembrete_24h: true,
    lembrete_2h: true,
    sua_vez: false,
    senha_de_acesso: false,
    retorno: false,
    link_atualizado: false,
  } as const;

  it('um agendamento programa confirmação e os dois lembretes', async () => {
    await withTenant(TENANT, (tx) =>
      agendarAvisosDoAgendamento(tx, {
        appointmentId: AGENDAMENTO,
        comecaEm: COMECA_EM,
        timeZone: 'America/Bahia',
        agora: AGORA,
        ligados: LIGADOS,
      }),
    );
    expect(await quantasNaFila()).toBe(3);
  });

  it('aviso desligado na unidade não é programado', async () => {
    await withTenant(TENANT, (tx) =>
      agendarAvisosDoAgendamento(tx, {
        appointmentId: AGENDAMENTO,
        comecaEm: COMECA_EM,
        timeZone: 'America/Bahia',
        agora: AGORA,
        ligados: { ...LIGADOS, lembrete_2h: false },
      }),
    );
    expect(await quantasNaFila()).toBe(2);
  });

  it('cancelar o agendamento apaga os avisos pendentes', async () => {
    // Quem desmarcou não pode receber "não esqueça do seu horário".
    await withTenant(TENANT, (tx) =>
      agendarAvisosDoAgendamento(tx, {
        appointmentId: AGENDAMENTO,
        comecaEm: COMECA_EM,
        timeZone: 'America/Bahia',
        agora: AGORA,
        ligados: LIGADOS,
      }),
    );
    await withTenant(TENANT, (tx) => cancelarTarefasDoAgendamento(tx, AGENDAMENTO));
    expect(await quantasNaFila()).toBe(0);
  });

  it('o aviso sai e fica registrado', async () => {
    const resultado = await executarAvisoDeAgendamento({
      tenantId: TENANT,
      appointmentId: AGENDAMENTO,
      tipo: 'lembrete_24h',
      provider,
      agora: new Date(COMECA_EM.getTime() - 24 * 60 * 60_000),
    });

    expect(resultado.enviado).toBe(true);
    expect(provider.agendamentos[0]?.clienteNome).toBe('Carlos Souza');

    const linhas = await admin.$queryRawUnsafe<{ status: string; phone_masked: string }[]>(
      `SELECT status, phone_masked FROM notifications WHERE tenant_id = '${TENANT}'`,
    );
    expect(linhas[0]?.status).toBe('sent');
    // O número inteiro não é copiado para o registro de envio.
    expect(linhas[0]?.phone_masked).not.toContain('988887777');
  });

  it('o handler reconfere o estado: cancelado entre a fila e o envio não sai', async () => {
    /**
     * A segunda defesa. Cancelar a tarefa é a primeira e resolve o caso comum;
     * esta cobre o cancelamento que aconteceu com a tarefa já em execução.
     */
    await admin.$executeRawUnsafe(
      `UPDATE appointments SET status = 'cancelled_customer' WHERE id = '${AGENDAMENTO}'`,
    );

    const resultado = await executarAvisoDeAgendamento({
      tenantId: TENANT,
      appointmentId: AGENDAMENTO,
      tipo: 'lembrete_24h',
      provider,
      agora: new Date(COMECA_EM.getTime() - 24 * 60 * 60_000),
    });

    expect(resultado.enviado).toBe(false);
    expect(resultado.motivo).toBe('cancelado');
    expect(provider.agendamentos).toHaveLength(0);
  });

  it('o motivo de não enviar fica registrado, não só o silêncio', async () => {
    // "Nada foi enviado" sem motivo transforma toda pergunta do dono numa
    // investigação; com motivo, vira uma linha na tela.
    // `customers.phone_e164` é NOT NULL: cliente sem telefone não existe. O
    // caso real é o **agendamento sem cliente** — o encaixe que o balcão marcou
    // sem cadastrar ninguém.
    await admin.$executeRawUnsafe(
      `UPDATE appointments SET customer_id = NULL WHERE id = '${AGENDAMENTO}'`,
    );
    await executarAvisoDeAgendamento({
      tenantId: TENANT,
      appointmentId: AGENDAMENTO,
      tipo: 'lembrete_24h',
      provider,
      agora: new Date(COMECA_EM.getTime() - 24 * 60 * 60_000),
    });

    const linhas = await admin.$queryRawUnsafe<{ status: string; reason: string }[]>(
      `SELECT status, reason FROM notifications WHERE tenant_id = '${TENANT}'`,
    );
    expect(linhas[0]).toMatchObject({ status: 'skipped', reason: 'sem_telefone' });
  });

  it('o mesmo aviso não sai duas vezes', async () => {
    const quando = new Date(COMECA_EM.getTime() - 24 * 60 * 60_000);
    const uma = { tenantId: TENANT, appointmentId: AGENDAMENTO, tipo: 'lembrete_24h' as const, provider, agora: quando };

    await executarAvisoDeAgendamento(uma);
    const segunda = await executarAvisoDeAgendamento(uma);

    expect(segunda.motivo).toBe('ja_enviada');
    expect(provider.agendamentos).toHaveLength(1);
  });


  it('resposta ambígua do WhatsApp não repete o lembrete automático', async () => {
    const ambiguo = new FakeNotificationProvider();
    ambiguo.enviarDeAgendamento = async (mensagem) => {
      // Simula a pior janela: a Meta aceitou, mas a resposta se perdeu.
      ambiguo.agendamentos.push(mensagem);
      throw new WhatsAppDeliveryUnknownError('Meta pode ter recebido');
    };
    const quando = new Date(COMECA_EM.getTime() - 24 * 60 * 60_000);
    const entrada = {
      tenantId: TENANT,
      appointmentId: AGENDAMENTO,
      tipo: 'lembrete_24h' as const,
      provider: ambiguo,
      agora: quando,
    };

    const primeira = await executarAvisoDeAgendamento(entrada);
    const segunda = await executarAvisoDeAgendamento(entrada);

    expect(primeira).toEqual({ enviado: false, motivo: 'entrega_incerta' });
    expect(segunda).toEqual({ enviado: false, motivo: 'entrega_incerta' });
    expect(ambiguo.agendamentos).toHaveLength(1);

    const linhas = await withTenant(TENANT, (tx) => tx.$queryRaw<{ status: string; reason: string | null }[]>`
      SELECT status::text AS status, reason
        FROM notifications
       WHERE appointment_id = ${AGENDAMENTO}::uuid AND kind = 'lembrete_24h'
    `);
    expect(linhas).toEqual([{ status: 'failed', reason: 'entrega_incerta' }]);
  });

  // -- o worker ---------------------------------------------------------------

  it('a rodada executa e conclui', async () => {
    await enfileirarNoTenant({
      kind: 'notificacao.lembrete_24h',
      payload: { appointmentId: AGENDAMENTO },
      idempotencyKey: 'lembrete_24h:ap',
    });

    const resultado = await rodada({
      provider,
      relogio: { agora: () => new Date(COMECA_EM.getTime() - 24 * 60 * 60_000) },
      recursoLigado: async () => recursosLigados,
      entregarWebhook: async () => 'entregue' as const,
      varrerWebhooks: async () => [],
      varrerVitrine: async () => 0,
      limparUsoDaApi: async () => 0,
      ...ligacoesDaPlataforma(),
    });

    expect(resultado).toMatchObject({ tomadas: 1, concluidas: 1, falhadas: 0 });
    expect(provider.agendamentos).toHaveLength(1);
  });

  it('com o recurso de avisos desligado, a tarefa é concluída sem mandar nada', async () => {
    // O interruptor do bloco 26. A checagem é **na hora de enviar** e não na de
    // enfileirar, porque o que custa mensagem é o lembrete que já está na fila
    // para amanhã — e é justamente ele que continuaria saindo.
    //
    // Concluída, e não devolvida à fila: a mensagem não vai sair depois, então
    // deixá-la pendente encheria a fila de trabalho que nunca acontece.
    await enfileirarNoTenant({
      kind: 'notificacao.lembrete_24h',
      payload: { appointmentId: AGENDAMENTO },
      idempotencyKey: 'lembrete_24h:ap',
    });

    recursosLigados = false;
    try {
      const resultado = await rodada({
        provider,
        relogio: { agora: () => new Date(COMECA_EM.getTime() - 24 * 60 * 60_000) },
        recursoLigado: async () => recursosLigados,
      entregarWebhook: async () => 'entregue' as const,
      varrerWebhooks: async () => [],
      varrerVitrine: async () => 0,
      limparUsoDaApi: async () => 0,
        ...ligacoesDaPlataforma(),
      });

      expect(resultado).toMatchObject({ tomadas: 1, concluidas: 1, falhadas: 0 });
      expect(provider.agendamentos).toHaveLength(0);
    } finally {
      recursosLigados = true;
    }
  });

  it('a resposta ao recado chega a quem sabe entregá-la', async () => {
    // O handler não sabe o que foi respondido nem a quem: `jobs` não conhece
    // `crm`. Ele carrega o id e chama quem sabe — e o payload guarda só isso.
    await enfileirarNoTenant({
      kind: 'recado.responder',
      payload: { recadoId: 'f0404040-0000-0000-0000-000000000001' },
      idempotencyKey: 'recado-resposta:f0404040',
    });

    const resultado = await rodada({
      provider,
      relogio: { agora: () => COMECA_EM },
      recursoLigado: async () => recursosLigados,
      entregarWebhook: async () => 'entregue' as const,
      varrerWebhooks: async () => [],
      varrerVitrine: async () => 0,
      limparUsoDaApi: async () => 0,
      ...ligacoesDaPlataforma(),
    });

    expect(resultado).toMatchObject({ tomadas: 1, concluidas: 1, falhadas: 0 });
    expect(recadosRespondidos).toEqual([
      { tenantId: TENANT, recadoId: 'f0404040-0000-0000-0000-000000000001' },
    ]);
  });

  it('com avisos desligados, a resposta ao recado não sai', async () => {
    /**
     * Quem desligou as mensagens responde pelo próprio WhatsApp. O que não pode
     * acontecer é o produto mandar mensagem por um canal que a barbearia
     * desligou — e a resposta gravada continua sendo o registro do que foi dito.
     */
    await enfileirarNoTenant({
      kind: 'recado.responder',
      payload: { recadoId: 'f0404040-0000-0000-0000-000000000002' },
      idempotencyKey: 'recado-resposta:f0404040-2',
    });

    recursosLigados = false;
    try {
      const resultado = await rodada({
        provider,
        relogio: { agora: () => COMECA_EM },
        recursoLigado: async () => recursosLigados,
      entregarWebhook: async () => 'entregue' as const,
      varrerWebhooks: async () => [],
      varrerVitrine: async () => 0,
      limparUsoDaApi: async () => 0,
        ...ligacoesDaPlataforma(),
      });
      expect(resultado).toMatchObject({ tomadas: 1, concluidas: 1, falhadas: 0 });
      expect(recadosRespondidos).toHaveLength(0);
    } finally {
      recursosLigados = true;
    }
  });

  it('a régua do clube chega a quem sabe cobrar', async () => {
    // O handler não sabe o que é uma fatura: `jobs` não conhece `finance` nem o
    // adquirente. Uma tarefa por barbearia, porque `club_invoices` tem RLS.
    await enfileirarNoTenant({
      kind: 'clube.cobranca',
      idempotencyKey: 'clube:tenant:2026-11-01',
    });

    const resultado = await rodada({
      provider,
      relogio: { agora: () => COMECA_EM },
      recursoLigado: async () => recursosLigados,
      entregarWebhook: async () => 'entregue' as const,
      varrerWebhooks: async () => [],
      varrerVitrine: async () => 0,
      limparUsoDaApi: async () => 0,
      ...ligacoesDaPlataforma(),
    });

    expect(resultado).toMatchObject({ tomadas: 1, concluidas: 1, falhadas: 0 });
    expect(cobrancasDoClube).toEqual([{ tenantId: TENANT, agora: COMECA_EM }]);
  });

  it('com avisos desligados, o aviso do clube não sai — mas a régua continua', async () => {
    /**
     * A distinção é do produto e não do canal: cobrar é obrigação contratual e
     * roda de qualquer jeito; **avisar** passa pelo interruptor de mensagens,
     * como toda mensagem ao cliente. Quem desligou avisa pelo próprio WhatsApp,
     * e o estado gravado continua sendo o registro do que aconteceu.
     */
    await enfileirarNoTenant({
      kind: 'clube.aviso',
      payload: { subscriptionId: 'c1c1c1c1-0000-0000-0000-000000000001', motivo: 'suspenso' },
      idempotencyKey: 'clube.aviso:c1c1:suspenso:1',
    });
    await enfileirarNoTenant({
      kind: 'clube.cobranca',
      idempotencyKey: 'clube:tenant:2026-11-02',
    });

    recursosLigados = false;
    try {
      const resultado = await rodada({
        provider,
        relogio: { agora: () => COMECA_EM },
        recursoLigado: async () => recursosLigados,
      entregarWebhook: async () => 'entregue' as const,
      varrerWebhooks: async () => [],
      varrerVitrine: async () => 0,
      limparUsoDaApi: async () => 0,
        ...ligacoesDaPlataforma(),
      });
      expect(resultado).toMatchObject({ tomadas: 2, concluidas: 2, falhadas: 0 });
      expect(avisosDoClube).toHaveLength(0);
      expect(cobrancasDoClube).toHaveLength(1);
    } finally {
      recursosLigados = true;
    }
  });

  it('o aviso do clube carrega só o id e o motivo', async () => {
    // `jobs` não tem RLS: o payload guarda id, nunca conteúdo. O texto da
    // mensagem é montado do outro lado, com tenant no contexto.
    await enfileirarNoTenant({
      kind: 'clube.aviso',
      payload: { subscriptionId: 'c1c1c1c1-0000-0000-0000-000000000002', motivo: 'inadimplente' },
      idempotencyKey: 'clube.aviso:c1c1-2:inadimplente:1',
    });

    const resultado = await rodada({
      provider,
      relogio: { agora: () => COMECA_EM },
      recursoLigado: async () => recursosLigados,
      entregarWebhook: async () => 'entregue' as const,
      varrerWebhooks: async () => [],
      varrerVitrine: async () => 0,
      limparUsoDaApi: async () => 0,
      ...ligacoesDaPlataforma(),
    });

    expect(resultado).toMatchObject({ tomadas: 1, concluidas: 1, falhadas: 0 });
    expect(avisosDoClube).toEqual([
      {
        tenantId: TENANT,
        assinaturaId: 'c1c1c1c1-0000-0000-0000-000000000002',
        motivo: 'inadimplente',
      },
    ]);
  });

  it('a liquidação de repasses chega a quem sabe repassar', async () => {
    // O handler não sabe o que é um repasse: `jobs` não conhece `finance` nem o
    // adquirente. Uma tarefa por barbearia, porque `payment_splits` tem RLS.
    await enfileirarNoTenant({
      kind: 'split.liquidar',
      idempotencyKey: 'split:tenant:2026-11-01',
    });

    const resultado = await rodada({
      provider,
      relogio: { agora: () => COMECA_EM },
      recursoLigado: async () => recursosLigados,
      entregarWebhook: async () => 'entregue' as const,
      varrerWebhooks: async () => [],
      varrerVitrine: async () => 0,
      limparUsoDaApi: async () => 0,
      ...ligacoesDaPlataforma(),
    });

    expect(resultado).toMatchObject({ tomadas: 1, concluidas: 1, falhadas: 0 });
    expect(liquidacoesRodadas).toEqual([{ tenantId: TENANT, agora: COMECA_EM }]);
  });

  it('a nota vai ao emissor pela fila, fora da transação da comanda', async () => {
    /**
     * A prefeitura pode levar minutos e pode estar fora do ar, e o cliente está
     * esperando o troco. Pendurá-la na frente do balcão é o defeito que a SPEC
     * §3.11 evita ao delegar a um emissor — e que o bloco 50 já aprendeu com o
     * KYC do profissional.
     */
    notasProcessadas = [];
    estadoDaNotaDoFake = 'autorizada';
    await enfileirarNoTenant({
      kind: 'fiscal.emitir',
      payload: { invoiceId: 'ff000000-0000-0000-0000-000000000001' },
      idempotencyKey: 'fiscal:ff1',
    });

    const resultado = await rodada({
      provider,
      relogio: { agora: () => COMECA_EM },
      recursoLigado: async () => recursosLigados,
      entregarWebhook: async () => 'entregue' as const,
      varrerWebhooks: async () => [],
      varrerVitrine: async () => 0,
      limparUsoDaApi: async () => 0,
      ...ligacoesDaPlataforma(),
    });

    expect(resultado).toMatchObject({ tomadas: 1, concluidas: 1, falhadas: 0 });
    expect(notasProcessadas).toEqual([
      { tenantId: TENANT, invoiceId: 'ff000000-0000-0000-0000-000000000001' },
    ]);
  });

  it('nota ainda na prefeitura reprograma a própria tarefa', async () => {
    /**
     * A tarefa se reprograma enquanto a nota não tem desfecho, como a varredura
     * de retorno do bloco 22. É por isso que não existe varredura de plataforma
     * para notas pendentes: `fiscal_invoices` tem RLS, e um processo sem tenant
     * no contexto enxergaria zero linhas — sempre.
     */
    notasProcessadas = [];
    estadoDaNotaDoFake = 'processando';
    await enfileirarNoTenant({
      kind: 'fiscal.emitir',
      payload: { invoiceId: 'ff000000-0000-0000-0000-000000000002' },
      idempotencyKey: 'fiscal:ff2',
    });

    await rodada({
      provider,
      relogio: { agora: () => COMECA_EM },
      recursoLigado: async () => recursosLigados,
      entregarWebhook: async () => 'entregue' as const,
      varrerWebhooks: async () => [],
      varrerVitrine: async () => 0,
      limparUsoDaApi: async () => 0,
      ...ligacoesDaPlataforma(),
    });

    const proximas = await admin.$queryRawUnsafe<{ kind: string; run_after: Date }[]>(
      `SELECT kind, run_after FROM jobs
        WHERE kind = 'fiscal.emitir' AND status = 'pending'`,
    );
    expect(proximas).toHaveLength(1);
    // Cinco minutos: é a ordem de grandeza da resposta municipal, e o emissor
    // cobra por chamada.
    expect(proximas[0]!.run_after.getTime()).toBe(COMECA_EM.getTime() + 5 * 60_000);
    estadoDaNotaDoFake = 'autorizada';
  });

  it('a tarefa de campanha leva o id para quem sabe despachar', async () => {
    /**
     * O que este teste prende é a **ligação**, e ela é a razão do bloco:
     * `despacharCampanha` existia, tinha suíte verde e não tinha chamador
     * nenhum. O botão "Enviar" punha a campanha em `enviando` e ninguém
     * recebia nada.
     *
     * O id vai no payload e não o público: `jobs` não tem RLS, e telefone de
     * cliente numa tabela sem política é dado pessoal legível sem tenant.
     */
    campanhasDespachadas = [];
    await enfileirarNoTenant({
      kind: 'campanha.enviar',
      payload: { campanhaId: 'cc000000-0000-0000-0000-000000000001' },
      idempotencyKey: 'campanha:cc1',
    });

    await rodada({
      provider,
      relogio: { agora: () => COMECA_EM },
      recursoLigado: async () => recursosLigados,
      entregarWebhook: async () => 'entregue' as const,
      varrerWebhooks: async () => [],
      varrerVitrine: async () => 0,
      limparUsoDaApi: async () => 0,
      ...ligacoesDaPlataforma(),
    });

    expect(campanhasDespachadas).toEqual([
      { tenantId: TENANT, campanhaId: 'cc000000-0000-0000-0000-000000000001' },
    ]);
  });

  it('provedor fora do ar devolve a tarefa à fila', async () => {
    await enfileirarNoTenant({
      kind: 'notificacao.lembrete_24h',
      payload: { appointmentId: AGENDAMENTO },
      idempotencyKey: 'lembrete_24h:ap',
    });
    provider.falharProxima = true;

    const resultado = await rodada({
      provider,
      relogio: { agora: () => new Date(COMECA_EM.getTime() - 24 * 60 * 60_000) },
      recursoLigado: async () => recursosLigados,
      entregarWebhook: async () => 'entregue' as const,
      varrerWebhooks: async () => [],
      varrerVitrine: async () => 0,
      limparUsoDaApi: async () => 0,
      ...ligacoesDaPlataforma(),
    });

    expect(resultado).toMatchObject({ concluidas: 0, reagendadas: 1 });
    expect(await quantasNaFila()).toBe(1);
  });

  it('tarefa de tipo desconhecido falha em vez de sumir', async () => {
    // Marcar como feita esconderia que alguém enfileirou algo que este worker
    // não sabe fazer.
    await enfileirarNoTenant({ kind: 'tipo.que.nao.existe', idempotencyKey: 'k', maxAttempts: 1 });
    const resultado = await rodada(contexto);

    expect(resultado.falhadas).toBe(1);
    expect(await quantasNaFila('failed')).toBe(1);
  });

  // -- falta automática -------------------------------------------------------

  /** A tolerância da unidade é de 20 minutos; um minuto depois ela venceu. */
  const VENCEU = new Date(COMECA_EM.getTime() + 21 * 60_000);
  const AINDA_DA = new Date(COMECA_EM.getTime() + 19 * 60_000);

  it('quem passou da tolerância vira falta sozinho', async () => {
    /**
     * A lacuna aberta no bloco 11: `no_show_after_minutes` existia, o painel
     * mostrava o relógio correndo, e quem virava o status era uma pessoa. O
     * horário ficava ocupado por quem não veio.
     */
    expect(await marcarFalta(TENANT, AGENDAMENTO, VENCEU)).toBe(true);

    const linhas = await admin.$queryRawUnsafe<{ status: string }[]>(
      `SELECT status FROM appointments WHERE id = '${AGENDAMENTO}'`,
    );
    expect(linhas[0]?.status).toBe('no_show');
  });

  it('dentro da tolerância ninguém é marcado', async () => {
    // A tarefa pode chegar adiantada, ou a unidade pode ter aumentado o prazo
    // depois de ela ser criada: a conferência é refeita na execução.
    expect(await marcarFalta(TENANT, AGENDAMENTO, AINDA_DA)).toBe(false);
  });

  it('tolerância zero desliga a falta automática', async () => {
    // Barbearia que prefere resolver falta na mão não pode ter o status virado
    // pelas costas.
    await admin.$executeRawUnsafe(
      `UPDATE locations SET no_show_after_minutes = 0 WHERE id = '${LOCATION}'`,
    );
    expect(await marcarFalta(TENANT, AGENDAMENTO, VENCEU)).toBe(false);
  });

  it('quem já fez check-in nunca vira falta', async () => {
    // Marcar falta de quem chegou é pior que não marcar: ele vê a punição do
    // próprio comparecimento.
    await admin.$executeRawUnsafe(
      `UPDATE appointments SET status = 'checked_in' WHERE id = '${AGENDAMENTO}'`,
    );
    expect(await marcarFalta(TENANT, AGENDAMENTO, VENCEU)).toBe(false);
  });

  it('a tolerância conta da hora combinada, não da ocupação da cadeira', async () => {
    // `starts_at` inclui o preparo antes do serviço. Contar dali puniria o
    // cliente por um tempo que não é dele — e faria o status virar num instante
    // diferente do que o painel do dia mostra desde o bloco 11.
    await admin.$executeRawUnsafe(
      `UPDATE appointments SET starts_at = service_starts_at - interval '15 minutes'
        WHERE id = '${AGENDAMENTO}'`,
    );
    const entreOsDois = new Date(COMECA_EM.getTime() + 10 * 60_000);
    expect(await marcarFalta(TENANT, AGENDAMENTO, entreOsDois)).toBe(false);
  });

  it('a falta é programada junto com o agendamento, para o fim da tolerância', async () => {
    // Sem isto o motor teria a regra e ninguém a dispararia — que é exatamente
    // o estado em que `no_show_after_minutes` passou oito blocos.
    await withTenant(TENANT, (tx) =>
      agendarFalta(tx, {
        appointmentId: AGENDAMENTO,
        comecaEm: COMECA_EM,
        toleranciaMinutos: 20,
      }),
    );

    const linhas = await admin.$queryRawUnsafe<{ run_after: Date; kind: string }[]>(
      `SELECT run_after, kind FROM jobs WHERE idempotency_key = 'falta:${AGENDAMENTO}'`,
    );
    expect(linhas[0]?.kind).toBe('agendamento.marcar_falta');
    expect(linhas[0]?.run_after.toISOString()).toBe(
      new Date(COMECA_EM.getTime() + 20 * 60_000).toISOString(),
    );
  });

  it('tolerância zero não gasta fila', async () => {
    const criou = await withTenant(TENANT, (tx) =>
      agendarFalta(tx, { appointmentId: AGENDAMENTO, comecaEm: COMECA_EM, toleranciaMinutos: 0 }),
    );
    expect(criou).toBe(false);
    expect(await quantasNaFila()).toBe(0);
  });

  it('cancelar o agendamento tira a falta da fila junto com os avisos', async () => {
    // A falta é a única tarefa daqui que escreve no agendamento. Deixá-la
    // pendente depois do cancelamento seria confiar no `WHERE` de status como
    // única defesa.
    await withTenant(TENANT, async (tx) => {
      await agendarFalta(tx, {
        appointmentId: AGENDAMENTO,
        comecaEm: COMECA_EM,
        toleranciaMinutos: 20,
      });
      await agendarAvisosDoAgendamento(tx, {
        appointmentId: AGENDAMENTO,
        comecaEm: COMECA_EM,
        timeZone: 'America/Bahia',
        agora: AGORA,
        ligados: LIGADOS,
      });
    });
    expect(await quantasNaFila()).toBeGreaterThan(1);

    await withTenant(TENANT, (tx) => cancelarTarefasDoAgendamento(tx, AGENDAMENTO));
    expect(await quantasNaFila()).toBe(0);
  });

  // -- a parede entre barbearias ----------------------------------------------

  it('o aviso de uma barbearia não é executado pelo tenant da outra', async () => {
    // O handler abre `withTenant` com o tenant da tarefa; com o errado, o
    // agendamento simplesmente não existe — e a RLS é quem diz isso.
    const resultado = await executarAvisoDeAgendamento({
      tenantId: RIVAL,
      appointmentId: AGENDAMENTO,
      tipo: 'lembrete_24h',
      provider,
      agora: new Date(COMECA_EM.getTime() - 24 * 60 * 60_000),
    });

    expect(resultado.enviado).toBe(false);
    expect(provider.agendamentos).toHaveLength(0);
  });

  it('o registro de envio de uma barbearia não aparece na outra', async () => {
    await executarAvisoDeAgendamento({
      tenantId: TENANT,
      appointmentId: AGENDAMENTO,
      tipo: 'lembrete_24h',
      provider,
      agora: new Date(COMECA_EM.getTime() - 24 * 60 * 60_000),
    });

    const daRival = await withTenant(RIVAL, async (tx) =>
      tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM notifications`,
    );
    expect(Number(daRival[0]?.n)).toBe(0);
  });

  it('o aviso de cobrança é repassado à plataforma, com a fatura do payload', async () => {
    // O handler não sabe cobrar nem escrever mensagem: quem lê a fatura, confere
    // se ela ainda está aberta e respeita a janela de silêncio da unidade é a
    // plataforma. Aqui ficaria a segunda cópia dessas regras.
    await enfileirarAvulso(TENANT, {
      kind: 'cobranca.aviso',
      payload: { faturaId: '11111111-2222-3333-4444-555555555555', assunto: 'venceu' },
      idempotencyKey: 'cobranca:teste:venceu',
    });

    const resultado = await rodada(contexto);

    expect(resultado.concluidas).toBe(1);
    expect(avisosDeCobranca).toEqual([
      {
        tenantId: TENANT,
        faturaId: '11111111-2222-3333-4444-555555555555',
        assunto: 'venceu',
      },
    ]);
  });

  it('aviso sem fatura falha em vez de sumir da fila', async () => {
    // Tarefa que some marcada como feita leva junto o aviso de que alguém
    // enfileirou algo quebrado — e o dono nunca soube que a conta venceu.
    await enfileirarAvulso(TENANT, {
      kind: 'cobranca.aviso',
      payload: { assunto: 'venceu' },
      idempotencyKey: 'cobranca:sem-fatura',
    });

    const resultado = await rodada(contexto);

    expect(resultado.concluidas).toBe(0);
    expect(avisosDeCobranca).toHaveLength(0);
  });

  it('a varredura diária expira a lista de espera na mesma volta', async () => {
    /**
     * `expired` seria um estado que ninguém escreve se isto não acontecesse: a
     * entrada continuaria ocupando uma das três vagas do cliente para sempre, e
     * a lista dele mostraria um sábado que já passou.
     *
     * Junto da retenção e não numa tarefa própria porque é a mesma natureza —
     * varredura diária, uma por barbearia, escrevendo de madrugada — e uma
     * segunda cadeia de agendamento seria mais peça para manter do que trabalho
     * para fazer.
     */
    await enfileirarAvulso(TENANT, {
      kind: 'lgpd.retencao',
      payload: {},
      idempotencyKey: 'retencao:teste:hoje',
    });

    const resultado = await rodada(contexto);

    expect(resultado.concluidas).toBe(1);
    expect(retencoesRodadas).toHaveLength(1);
    expect(esperasExpiradas.map((e) => e.tenantId)).toEqual([TENANT]);
    /**
     * E a vitrine do marketplace na mesma volta (bloco 70).
     *
     * A revisão de segurança daquele bloco apontou que a varredura prometida
     * pelo cabeçalho da migração **não tinha chamador nenhum** — preço e nota do
     * card só se atualizariam quando alguém publicasse de novo. Isto é o
     * chamador, e este teste é o que impede que ele se perca outra vez.
     */
    expect(vitrinesRefeitas.map((v) => v.tenantId)).toEqual([TENANT]);
    /**
     * A comissão do marketplace sai na mesma volta, e nesta ordem (bloco 72):
     * atribuir antes de cobrar, senão a emissão do mês fechado não encontra as
     * linhas do último dia e a barbearia recebe a fatura de agosto com um
     * cliente de julho dentro.
     */
    expect(atribuicoesRodadas.map((a) => a.tenantId)).toEqual([TENANT]);
    expect(comissoesCobradas.map((c) => c.tenantId)).toEqual([TENANT]);
  });

  it('a falta entra na fila como tarefa da própria barbearia', async () => {
    await enfileirarAvulso(TENANT, {
      kind: 'agendamento.marcar_falta',
      payload: { appointmentId: AGENDAMENTO },
      idempotencyKey: `falta:${AGENDAMENTO}`,
    });

    const resultado = await rodada({
      provider,
      relogio: { agora: () => VENCEU },
      recursoLigado: async () => true,
      entregarWebhook: async () => 'entregue' as const,
      varrerWebhooks: async () => [],
      varrerVitrine: async () => 0,
      limparUsoDaApi: async () => 0,
      ...ligacoesDaPlataforma(),
    });
    expect(resultado.concluidas).toBe(1);

    const linhas = await admin.$queryRawUnsafe<{ status: string }[]>(
      `SELECT status FROM appointments WHERE id = '${AGENDAMENTO}'`,
    );
    expect(linhas[0]?.status).toBe('no_show');
  });
  // -- o convite de retorno ----------------------------------------------------

  /**
   * A única mensagem promocional do bloco, e a única varredura.
   *
   * Tudo o mais nasce de um evento. Esta nasce de uma **ausência**, e por isso é
   * a única que precisa de opt-in, teto mensal e prazo mínimo.
   */
  const SUMIU_HA = (dias: number) => new Date(AGORA.getTime() - dias * 24 * 60 * 60_000);

  const marcarVisita = async (quando: Date): Promise<void> => {
    await admin.$executeRawUnsafe(`
      UPDATE appointments SET status = 'completed',
             starts_at = '${quando.toISOString()}',
             service_starts_at = '${quando.toISOString()}'
       WHERE id = '${AGENDAMENTO}'
    `);
  };

  const aceitaPromocao = async (): Promise<void> => {
    await admin.$executeRawUnsafe(
      `UPDATE customers SET accepts_marketing = true WHERE id = '${CARLOS}'`,
    );
  };

  const ligarRetorno = async (dias = 45): Promise<void> => {
    await admin.$executeRawUnsafe(
      `UPDATE locations SET notify_comeback = true, comeback_after_days = ${dias}`,
    );
  };

  it('quem sumiu além do prazo e aceitou promoção recebe o convite', async () => {
    await ligarRetorno(45);
    await aceitaPromocao();
    await marcarVisita(SUMIU_HA(60));

    const { enviados } = await varrerRetornos({ tenantId: TENANT, provider, agora: AGORA });
    expect(enviados).toBe(1);
    expect(provider.agendamentos[0]?.tipo).toBe('retorno');
  });

  it('resposta ambígua da Meta não repete o convite de retorno', async () => {
    await ligarRetorno(45);
    await aceitaPromocao();
    await marcarVisita(SUMIU_HA(60));

    const incerto = new FakeNotificationProvider();
    let chamadas = 0;
    incerto.enviarDeAgendamento = async (mensagem) => {
      chamadas += 1;
      incerto.agendamentos.push(mensagem);
      throw new WhatsAppDeliveryUnknownError('Meta pode ter aceitado');
    };

    const primeira = await varrerRetornos({ tenantId: TENANT, provider: incerto, agora: AGORA });
    expect(primeira.enviados).toBe(0);
    expect(chamadas).toBe(1);

    // A tarefa roda de novo no dia seguinte. A mensagem não pode sair de novo:
    // a intenção ambígua da mesma ausência é a trava conservadora.
    const amanha = new Date(AGORA.getTime() + 24 * 60 * 60_000);
    const segunda = await varrerRetornos({ tenantId: TENANT, provider: incerto, agora: amanha });
    expect(segunda.enviados).toBe(0);
    expect(chamadas).toBe(1);

    const linhas = await admin.$queryRawUnsafe<{ status: string; reason: string | null }[]>(
      `SELECT status, reason FROM notifications WHERE customer_id = '${CARLOS}' AND kind = 'retorno'`,
    );
    expect(linhas).toEqual([{ status: 'failed', reason: 'entrega_incerta' }]);

    const intencoes = await admin.$queryRawUnsafe<{ status: string }[]>(
      `SELECT status FROM notification_send_intents WHERE tenant_id = '${TENANT}' AND intent_key LIKE 'retorno:${CARLOS}:%'`,
    );
    expect(intencoes).toEqual([{ status: 'uncertain' }]);
  });

  it('quem não aceitou promoção nunca recebe o convite', async () => {
    // Consentimento de marketing é separado do necessário para o serviço: esta
    // pessoa continua recebendo o lembrete do próprio corte.
    await ligarRetorno(45);
    await marcarVisita(SUMIU_HA(60));

    const { enviados } = await varrerRetornos({ tenantId: TENANT, provider, agora: AGORA });
    expect(enviados).toBe(0);
  });

  it('base recém-importada não dispara mil convites no primeiro dia', async () => {
    /**
     * O erro que a SPEC §5.8 nomeia: "importar 1.200 clientes e mandar 1.200
     * mensagens de 'sentimos sua falta' no primeiro dia é o erro que queima o
     * número de WhatsApp e a conta da barbearia".
     *
     * O que impede não é uma exceção na varredura — é o consentimento. Ele
     * precisa de data, IP e versão do texto, e nada disso atravessa uma
     * exportação, então o importador nunca o liga. A varredura filtra
     * `accepts_marketing` e a base inteira fica de fora sozinha.
     *
     * O teste importa gente de verdade pelo mesmo caminho da tela, com visita
     * antiga, e conta quantas mensagens saem.
     */
    await ligarRetorno(45);
    await marcarVisita(SUMIU_HA(60));

    await admin.$executeRawUnsafe(`
      INSERT INTO imports (id, tenant_id, file_name, file_sha256, separator, status, applied_at)
      VALUES ('99999999-0000-0000-0000-000000000001', '${TENANT}', 'base.csv',
              repeat('f', 64), ';', 'applied', now())
    `);

    /**
     * Cada importado ganha uma visita antiga e concluída — e isso é o teste, não
     * cenário. A primeira versão deixava os importados **sem histórico nenhum**,
     * e aí a varredura os pulava por `sem visita anterior`, não por
     * consentimento: o teste ficava verde mesmo com a regra de consentimento
     * arrancada dos dois lugares onde ela mora. Com visita antiga, a única coisa
     * que os segura é o `accepts_marketing` falso que o importador escreve.
     */
    for (let i = 0; i < 5; i += 1) {
      const cliente = `99999999-1111-0000-0000-00000000000${i}`;
      await admin.$executeRawUnsafe(`
        INSERT INTO customers (id, tenant_id, name, phone_e164, import_id)
        VALUES ('${cliente}', '${TENANT}', 'Importado ${i}', '+55719000000${i}0',
                '99999999-0000-0000-0000-000000000001')
      `);
      const inicio = SUMIU_HA(200 + i).toISOString();
      const fim = new Date(SUMIU_HA(200 + i).getTime() + 30 * 60_000).toISOString();
      await admin.$executeRawUnsafe(`
        INSERT INTO appointments
          (tenant_id, location_id, customer_id, professional_id,
           starts_at, ends_at, service_starts_at, service_ends_at, status)
        VALUES ('${TENANT}', '${LOCATION}', '${cliente}', '${RUAN}',
                '${inicio}', '${fim}', '${inicio}', '${fim}', 'completed')
      `);
    }

    const { enviados } = await varrerRetornos({ tenantId: TENANT, provider, agora: AGORA });
    expect(enviados).toBe(0);
    expect(provider.agendamentos).toHaveLength(0);
  });

  it('quem voltou dentro do prazo não é chamado de volta', async () => {
    await ligarRetorno(45);
    await aceitaPromocao();
    await marcarVisita(SUMIU_HA(10));

    const { enviados } = await varrerRetornos({ tenantId: TENANT, provider, agora: AGORA });
    expect(enviados).toBe(0);
  });

  it('barbearia com duas unidades não manda o convite em dobro', async () => {
    /**
     * `customers` é do tenant, não da unidade. Com um `JOIN` comum sobre
     * `locations`, a mesma pessoa aparecia duas vezes na varredura — e as duas
     * linhas liam `ja_enviada = false` na mesma consulta.
     */
    await ligarRetorno(45);
    await aceitaPromocao();
    await marcarVisita(SUMIU_HA(60));
    await admin.$executeRawUnsafe(`
      INSERT INTO locations (tenant_id, name, timezone, notify_comeback)
      VALUES ('${TENANT}', 'Filial', 'America/Bahia', true)
    `);

    const { enviados } = await varrerRetornos({ tenantId: TENANT, provider, agora: AGORA });
    expect(enviados).toBe(1);
    expect(provider.agendamentos).toHaveLength(1);
  });

  it('o convite não repete enquanto o anterior for recente', async () => {
    await ligarRetorno(45);
    await aceitaPromocao();
    await marcarVisita(SUMIU_HA(60));

    await varrerRetornos({ tenantId: TENANT, provider, agora: AGORA });
    provider.clear();
    // A varredura roda todo dia; sem a trava, todo dia seria uma mensagem.
    const segunda = await varrerRetornos({ tenantId: TENANT, provider, agora: AGORA });
    expect(segunda.enviados).toBe(0);
  });

  it('ligar o convite na tela é o que cria a varredura', async () => {
    // Não há varredura de plataforma possível: `locations` tem RLS, e sem tenant
    // no contexto nada revela quem quer a mensagem.
    expect(await quantasNaFila()).toBe(0);

    await salvarPreferenciasDeAviso(
      TENANT,
      LOCATION,
      {
        confirmacao: true,
        lembrete24h: true,
        lembrete2h: true,
        retorno: true,
        diasParaRetorno: 30,
      },
      AGORA,
    );

    const linhas = await admin.$queryRawUnsafe<{ idempotency_key: string }[]>(
      `SELECT idempotency_key FROM jobs WHERE kind = 'notificacao.retorno'`,
    );
    expect(linhas[0]?.idempotency_key).toBe(`retorno:${TENANT}:2026-09-10`);
    expect(await lerPreferenciasDeAviso(TENANT, LOCATION)).toMatchObject({
      retorno: true,
      diasParaRetorno: 30,
    });
  });

  it('com o convite desligado a cadeia para de se reprogramar', async () => {
    // Sem isto, desligar na tela deixaria a varredura rodando para sempre.
    const criou = await withTenant(TENANT, (tx) =>
      agendarVarreduraDeRetorno(tx, { tenantId: TENANT, quando: AGORA }),
    );
    expect(criou).toBe(false);
    expect(await quantasNaFila()).toBe(0);
  });

  it('a chave da varredura inclui a barbearia, não só o dia', async () => {
    /**
     * O índice único de `jobs` é global — `jobs` não tem RLS de propósito.
     * `retorno:2026-09-10` sozinho deixaria a primeira barbearia do dia
     * bloquear a varredura de todas as outras.
     */
    await ligarRetorno(45);
    await admin.$executeRawUnsafe(`
      INSERT INTO locations (tenant_id, name, timezone, notify_comeback)
      VALUES ('${RIVAL}', 'Matriz da rival', 'America/Bahia', true)
    `);

    for (const tenant of [TENANT, RIVAL]) {
      await withTenant(tenant, (tx) => agendarVarreduraDeRetorno(tx, { tenantId: tenant, quando: AGORA }));
    }
    expect(await quantasNaFila()).toBe(2);
  });
});

describeIfDb('alertas de negócio, com os números vindos do banco', () => {
  /**
   * As regras já têm teste puro em `packages/core`. O que se prova aqui é a
   * **coleta**: se a consulta pega o dia errado, conta o tenant errado ou soma
   * tarefa agendada como atrasada, a regra continua correta e o alerta sai
   * errado — e ninguém percebe, porque o teste puro continua verde.
   */
  const AGORA_ALERTA = new Date('2026-09-10T13:00:00Z');

  /**
   * O horário do corte é irrelevante para esta conta — o que se mede é
   * `created_at` —, mas ele não pode se repetir: a constraint anti-overbooking
   * recusa dois cortes no mesmo profissional na mesma faixa, e é ela que este
   * produto inteiro existe para ter. O contador espalha os horários em anos
   * futuros para nunca colidirem.
   */
  let proximoHorario = 0;
  const LONGE = Date.UTC(2030, 0, 1);

  const marcarEm = (quando: Date, quantos: number, tenant = TENANT) =>
    exec(
      admin,
      Array.from({ length: quantos }, () => {
        const desloca = LONGE + proximoHorario++ * 3_600_000;
        const inicio = new Date(desloca).toISOString();
        const fim = new Date(desloca + 1_800_000).toISOString();
        return `INSERT INTO appointments
          (tenant_id, location_id, customer_id, professional_id,
           starts_at, ends_at, service_starts_at, service_ends_at,
           status, source, price_cents, created_at)
         VALUES ('${tenant}', '${LOCATION}', '${CARLOS}', '${RUAN}',
           '${inicio}', '${fim}', '${inicio}', '${fim}',
           'pending', 'website', 4900, '${quando.toISOString()}')`;
      }).join(';'),
    );

  beforeEach(async () => {
    await admin.$executeRawUnsafe(`DELETE FROM appointments WHERE tenant_id = '${TENANT}'`);
  });

  it('compara com o mesmo dia da semana passada, não com ontem', async () => {
    // Vinte na semana passada, seis hoje: queda de 70%.
    await marcarEm(new Date('2026-09-03T12:00:00Z'), 20);
    await marcarEm(new Date('2026-09-10T09:00:00Z'), 6);
    // Ontem teve trinta. Se a coleta comparasse com ontem, o número seria outro
    // — e num sábado contra domingo ela inventaria queda toda semana.
    await marcarEm(new Date('2026-09-09T12:00:00Z'), 30);

    const alertas = await alertasDaBarbearia(TENANT, AGORA_ALERTA);
    const volume = alertas.find((a) => a.regra === 'agendamento.volume_caiu');

    expect(volume?.severidade).toBe('critico');
    expect(volume?.valor).toBe(6);
    expect(volume?.referencia).toBe(20);
  });

  it('recorta hoje pelo fuso da unidade, inclusive antes da meia-noite UTC virar no balcão', async () => {
    // 01:00Z ainda é 22:00 do dia 9 na Bahia. O coletor antigo por UTC chamava
    // o dia 10 de "hoje" três horas cedo e podia disparar/sumir com o alerta.
    const agoraLocal = new Date('2026-09-10T01:00:00Z');
    await marcarEm(new Date('2026-09-03T00:30:00Z'), 20); // 02/09 21:30 local
    await marcarEm(new Date('2026-09-10T00:30:00Z'), 6);  // 09/09 21:30 local
    await marcarEm(new Date('2026-09-10T03:30:00Z'), 30); // 10/09 00:30 local: outro dia

    const alertas = await alertasDaBarbearia(TENANT, agoraLocal);
    const volume = alertas.find((a) => a.regra === 'agendamento.volume_caiu');

    expect(volume?.valor).toBe(6);
    expect(volume?.referencia).toBe(20);
  });

  it('o movimento da barbearia vizinha não entra na conta', async () => {
    await marcarEm(new Date('2026-09-03T12:00:00Z'), 20);
    // A rival teve o mesmo movimento hoje. Sem o recorte por tenant, ele
    // encobriria a queda desta — e o alerta que mais importa some.
    await marcarEm(new Date('2026-09-10T09:00:00Z'), 20, RIVAL);

    const alertas = await alertasDaBarbearia(TENANT, AGORA_ALERTA);

    expect(alertas.find((a) => a.regra === 'agendamento.volume_caiu')?.valor).toBe(0);
  });

  it('tarefa agendada para amanhã não é fila travada', async () => {
    await admin.$executeRawUnsafe('TRUNCATE jobs');
    await exec(
      admin,
      `INSERT INTO jobs (tenant_id, kind, payload, run_after)
       VALUES ('${TENANT}', 'aviso', '{}'::jsonb, '2026-09-11T12:00:00Z')`,
    );

    // Pendente e no futuro: é o lembrete de amanhã, não worker morto. Contá-lo
    // faria toda barbearia com aviso ligado parecer travada.
    const alertas = await alertasDaBarbearia(TENANT, AGORA_ALERTA);
    expect(alertas.find((a) => a.regra === 'fila.travada')).toBeUndefined();
  });

  it('tarefa vencida há uma hora é fila travada', async () => {
    await admin.$executeRawUnsafe('TRUNCATE jobs');
    await exec(
      admin,
      `INSERT INTO jobs (tenant_id, kind, payload, run_after)
       VALUES ('${TENANT}', 'aviso', '{}'::jsonb, '2026-09-10T11:30:00Z')`,
    );

    const alertas = await alertasDaBarbearia(TENANT, AGORA_ALERTA);
    const fila = alertas.find((a) => a.regra === 'fila.travada');

    expect(fila?.severidade).toBe('critico');
    expect(fila?.valor).toBe(90);
  });
});

/**
 * A fila está andando? (bloco 101)
 *
 * Nenhuma tela do produto sabia responder: a campanha dizia "entrou na fila", a
 * automação prometia "rodam de hora em hora" e a de WhatsApp mostrava o canal
 * de pé — com trinta e três mensagens paradas e o processo fora do ar. As
 * quatro afirmavam o contrário do que estava acontecendo.
 */
describeIfDb('a saúde da fila', () => {
  const AGORA = new Date('2026-09-20T15:00:00Z');
  const haMinutos = (n: number) => new Date(AGORA.getTime() - n * 60_000).toISOString();

  beforeAll(async () => {
    if (!SEED_URL) throw new Error('SEED_DATABASE_URL é obrigatória');
    admin = new PrismaClient({ datasources: { db: { url: SEED_URL } } });
  });

  afterAll(async () => {
    await admin?.$disconnect();
  });

  beforeEach(async () => {
    /**
     * Só a fila, e **não** `tenants CASCADE`.
     *
     * Truncar os tenants aqui derrubava a semente dos blocos vizinhos — os
     * agendamentos deles apontam para uma unidade que deixava de existir, e
     * duas suítes de alerta ficavam vermelhas por um teste que não é sobre
     * elas. As barbearias já vêm da semente do primeiro bloco.
     */
    await exec(admin, `
      TRUNCATE jobs;
      INSERT INTO tenants (id, name) VALUES ('${TENANT}', 'Domari'), ('${RIVAL}', 'Rival')
        ON CONFLICT (id) DO NOTHING;
    `);
  });

  const tarefa = (extra: string) => exec(admin, `
    INSERT INTO jobs (tenant_id, kind, ${extra});
  `);

  it('fila vazia não é fila parada', async () => {
    /**
     * A barbearia sem nada a fazer tem a fila vazia e silenciosa, e isso é o
     * certo. Alarme que dispara à toa é alarme que se aprende a ignorar.
     */
    const saude = await saudeDaFila(TENANT, AGORA, 'America/Bahia');
    expect(saude).toMatchObject({ atrasadas: 0, agendadas: 0, parada: false });
  });

  it('tarefa esperando a hora não é alarme', async () => {
    // O lembrete de amanhã nasce hoje com `run_after` no futuro. É o desenho da
    // fila desde o bloco 20, e não tem nada de errado.
    await tarefa(`status, run_after) VALUES ('${TENANT}', 'lembrete_24h', 'pending', '${haMinutos(-600)}'`);
    const saude = await saudeDaFila(TENANT, AGORA, 'America/Bahia');
    expect(saude).toMatchObject({ atrasadas: 0, agendadas: 1, parada: false });
  });

  it('tarefa vencida com a fila andando também não é alarme', async () => {
    /**
     * A semente satisfaz **tudo menos** a regra sob teste: há tarefa vencida, e
     * o que impede o alarme é a conclusão recente. Sem este caso, o de baixo
     * passaria com o alarme ligado para todo mundo.
     */
    await tarefa(`status, run_after) VALUES ('${TENANT}', 'campanha.enviar', 'pending', '${haMinutos(30)}'`);
    await tarefa(`status, run_after, finished_at) VALUES ('${TENANT}', 'campanha.enviar', 'done', '${haMinutos(40)}', '${haMinutos(2)}'`);

    const saude = await saudeDaFila(TENANT, AGORA, 'America/Bahia');
    expect(saude.atrasadas).toBe(1);
    expect(saude.parada).toBe(false);
  });

  it('tarefa vencida e nada concluído há muito tempo é a fila parada', async () => {
    await tarefa(`status, run_after) VALUES ('${TENANT}', 'campanha.enviar', 'pending', '${haMinutos(30)}'`);
    await tarefa(`status, run_after, finished_at) VALUES ('${TENANT}', 'campanha.enviar', 'done', '${haMinutos(200)}', '${haMinutos(180)}'`);

    const saude = await saudeDaFila(TENANT, AGORA, 'America/Bahia');
    expect(saude).toMatchObject({ atrasadas: 1, parada: true });
    expect(saude.ultimaConclusao).toBe(new Date(haMinutos(180)).toISOString());
  });

  it('fila que nunca concluiu nada, com tarefa vencida, é a fila parada', async () => {
    // É o caso da instalação nova em que o worker nunca subiu — exatamente o
    // que a avaliação encontrou.
    await tarefa(`status, run_after) VALUES ('${TENANT}', 'campanha.enviar', 'pending', '${haMinutos(30)}'`);
    const saude = await saudeDaFila(TENANT, AGORA, 'America/Bahia');
    expect(saude).toMatchObject({ atrasadas: 1, ultimaConclusao: null, parada: true });
  });

  it('na janela de silêncio, tarefa parada é o certo e não vira alarme', async () => {
    /**
     * Entre 21h e 8h nada sai, de propósito. Sem esta distinção toda barbearia
     * acenderia o aviso às 21h01 — e o alarme que dispara à toa é o que se
     * aprende a ignorar.
     *
     * 23h no fuso da unidade: `AGORA` é 15:00Z, que em `Pacific/Kiritimati`
     * (UTC+14) são 5h da manhã, dentro do silêncio.
     */
    await tarefa(`status, run_after) VALUES ('${TENANT}', 'campanha.enviar', 'pending', '${haMinutos(30)}'`);
    const dormindo = await saudeDaFila(TENANT, AGORA, 'Pacific/Kiritimati');
    expect(dormindo).toMatchObject({ atrasadas: 1, emSilencio: true, parada: false });

    // A mesma fila, no fuso em que já é dia, acusa.
    const acordada = await saudeDaFila(TENANT, AGORA, 'America/Bahia');
    expect(acordada).toMatchObject({ atrasadas: 1, emSilencio: false, parada: true });
  });

  /**
   * A tarefa que desistiu, e o buraco que ela ocupava (bloco 102).
   *
   * A primeira versão desta função contava só `pending`. Isso não era detalhe:
   * a barbearia de produção tinha 84 `automacao.varrer` **falhadas**, nenhuma
   * pendente, e conclusões recentes de outros tipos — então `atrasadas` era
   * zero, `parada` era falso, e o aviso que existe para dizer "as mensagens
   * não estão saindo" afirmava saúde sobre um motor morto havia quatro dias.
   */
  it('tarefa que esgotou as tentativas acende o aviso mesmo com a fila andando', async () => {
    /**
     * A semente satisfaz **tudo menos** a regra sob teste: a fila anda (há
     * conclusão de dois minutos atrás) e nada está vencido. Sem estas duas
     * linhas, o caso passaria por `parada`, que é outra coisa.
     */
    await tarefa(`status, run_after, finished_at) VALUES ('${TENANT}', 'campanha.enviar', 'done', '${haMinutos(40)}', '${haMinutos(2)}'`);
    await tarefa(`status, run_after, finished_at, attempts) VALUES ('${TENANT}', 'automacao.varrer', 'failed', '${haMinutos(60)}', '${haMinutos(55)}', 3`);

    const saude = await saudeDaFila(TENANT, AGORA, 'America/Bahia');
    expect(saude).toMatchObject({ atrasadas: 0, parada: false, falhadas: 1, desistiu: true });
  });

  it('a falha de anteontem não acende nada — o aviso não fica ligado para sempre', async () => {
    // Alarme que nunca apaga é alarme que se aprende a ignorar. A janela é de
    // 48h: o que falhou e ninguém tentou de novo é fato encerrado.
    await tarefa(`status, run_after, finished_at) VALUES ('${TENANT}', 'automacao.varrer', 'failed', '${haMinutos(5000)}', '${haMinutos(4400)}'`);
    const saude = await saudeDaFila(TENANT, AGORA, 'America/Bahia');
    expect(saude).toMatchObject({ falhadas: 0, desistiu: false });
  });

  it('a falha acende mesmo dentro da janela de silêncio', async () => {
    /**
     * Silêncio explica tarefa **esperando**; não explica tarefa que desistiu.
     * Uma falha às 22h continua sendo uma falha às 8h, e escondê-la até lá é
     * adiar a única notícia que importa.
     */
    await tarefa(`status, run_after, finished_at) VALUES ('${TENANT}', 'automacao.varrer', 'failed', '${haMinutos(60)}', '${haMinutos(55)}'`);
    const dormindo = await saudeDaFila(TENANT, AGORA, 'Pacific/Kiritimati');
    expect(dormindo).toMatchObject({ emSilencio: true, desistiu: true });
  });

  it('a tarefa falhada da vizinha não acende o alarme desta barbearia', async () => {
    // Mesmo motivo do caso de baixo: `jobs` não tem RLS, e o filtro por
    // barbearia é escrito na consulta. O contador novo precisa dele também.
    await tarefa(`status, run_after, finished_at) VALUES ('${RIVAL}', 'automacao.varrer', 'failed', '${haMinutos(60)}', '${haMinutos(55)}'`);
    const saude = await saudeDaFila(TENANT, AGORA, 'America/Bahia');
    expect(saude).toMatchObject({ falhadas: 0, desistiu: false });
  });

  it('a fila parada da vizinha não acende o alarme desta barbearia', async () => {
    /**
     * `jobs` **não tem RLS** — é decisão do bloco 20, e o filtro por barbearia
     * é escrito na consulta. Sem ele, uma barbearia com o worker parado faria a
     * tela de todas as outras acusar.
     */
    await tarefa(`status, run_after) VALUES ('${RIVAL}', 'campanha.enviar', 'pending', '${haMinutos(30)}'`);
    const saude = await saudeDaFila(TENANT, AGORA, 'America/Bahia');
    expect(saude).toMatchObject({ atrasadas: 0, parada: false });
  });
});
