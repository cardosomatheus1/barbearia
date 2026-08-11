import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  MAXIMO_DA_RESPOSTA,
  MAXIMO_DO_RECADO,
  MINIMO_DO_RECADO,
  diasEsperando,
  foraDoSilencio,
  ordenarTriagem,
  podeRegistrarRecado,
  transicaoDoRecado,
  type EstadoDoRecado,
  type TipoDeRecado,
} from '@barbearia/core';
import { audit } from '@barbearia/identity';
import { enfileirar } from '@barbearia/jobs';

/**
 * O canal de recados, do banco para a decisão (bloco 40, ROADMAP §R2).
 *
 * ## Por que `crm` passa a depender de `jobs`
 *
 * Pelo mesmo motivo de `finance` e de `platform`: `enfileirar()`. A resposta ao
 * cliente sai por mensagem, e a tarefa que a manda precisa nascer **dentro da
 * transação** que grava a resposta. Enfileirar depois do commit abre a janela em
 * que o balcão vê "respondido" e o cliente nunca recebe nada — e é a janela em
 * que o produto perde a única coisa que este canal entrega.
 *
 * A seta não volta: `jobs` continua sem saber que existe recado, e recebe o que
 * precisa do `Contexto` do worker.
 *
 * ## Por que `identity`
 *
 * `audit()`, também dentro da transação. Assumir e responder um recado são atos
 * de uma pessoa da casa em nome dela, e a trilha do que foi respondido a quem é
 * o que sustenta o limite ético: ninguém apaga reclamação, e ninguém responde em
 * nome de outro sem deixar registro.
 */

export const TAREFA_DE_RESPOSTA = 'recado.responder';

export type RecadoFailure =
  | 'recado_nao_encontrado'
  | 'texto_curto'
  | 'texto_longo'
  | 'tipo_invalido'
  | 'resposta_vazia'
  | 'resposta_longa'
  | 'transicao_invalida'
  | 'sem_contato'
  | 'unidade_desconhecida'
  | 'responsavel_desconhecido';

export class RecadoError extends Error {
  constructor(readonly code: RecadoFailure, message: string) {
    super(message);
    this.name = 'RecadoError';
  }
}

const MENSAGEM: Readonly<Record<RecadoFailure, string>> = {
  recado_nao_encontrado: 'Este recado não existe.',
  texto_curto: `Escreva pelo menos ${MINIMO_DO_RECADO} caracteres.`,
  texto_longo: `O texto passa de ${MAXIMO_DO_RECADO} caracteres.`,
  tipo_invalido: 'Escolha sugestão, reclamação ou elogio.',
  resposta_vazia: 'Escreva a resposta.',
  resposta_longa: `A resposta passa de ${MAXIMO_DA_RESPOSTA} caracteres.`,
  transicao_invalida: 'Este recado já está encerrado.',
  sem_contato: 'Este recado é anônimo — não há para onde responder.',
  unidade_desconhecida: 'Unidade não encontrada.',
  responsavel_desconhecido: 'Esta pessoa não faz parte da equipe.',
};

/**
 * Declaração e não arrow: só a primeira estreita o tipo depois da chamada.
 *
 * Com `const recusar = (): never => …` o compilador continua achando que a linha
 * seguinte é alcançável, e o código enche de `!` para calar — que é justamente
 * o que este repositório não faz.
 */
function recusar(code: RecadoFailure): never {
  throw new RecadoError(code, MENSAGEM[code]);
}

export interface Recado {
  readonly id: string;
  readonly tipo: TipoDeRecado;
  readonly estado: EstadoDoRecado;
  readonly texto: string;
  readonly resposta: string | null;
  readonly respondidoEm: string | null;
  readonly criadoEm: string;
  readonly diasEsperando: number;
  readonly responsavelId: string | null;
  readonly responsavelNome: string | null;
  readonly clienteId: string | null;
  readonly clienteNome: string | null;
  /** Falso no recado anônimo: não há para onde responder, e a tela precisa dizer. */
  readonly temContato: boolean;
  readonly agendamentoId: string | null;
}

interface LinhaDoRecado {
  readonly id: string;
  readonly kind: TipoDeRecado;
  readonly status: EstadoDoRecado;
  readonly body: string;
  readonly answer: string | null;
  readonly answered_at: Date | null;
  readonly created_at: Date;
  readonly assigned_to: string | null;
  readonly assigned_name: string | null;
  readonly customer_id: string | null;
  readonly customer_name: string | null;
  readonly customer_phone: string | null;
  readonly appointment_id: string | null;
}

function daLinha(linha: LinhaDoRecado, agora: Date): Recado {
  return {
    id: linha.id,
    tipo: linha.kind,
    estado: linha.status,
    texto: linha.body,
    resposta: linha.answer,
    respondidoEm: linha.answered_at?.toISOString() ?? null,
    criadoEm: linha.created_at.toISOString(),
    diasEsperando: diasEsperando(linha.created_at, agora),
    responsavelId: linha.assigned_to,
    responsavelNome: linha.assigned_name,
    clienteId: linha.customer_id,
    clienteNome: linha.customer_name,
    temContato: Boolean(linha.customer_phone),
    agendamentoId: linha.appointment_id,
  };
}

const SELECT_DO_RECADO = `
  SELECT f.id, f.kind, f.status::text AS status, f.body, f.answer, f.answered_at,
         f.created_at, f.assigned_to, s.name AS assigned_name,
         f.customer_id, c.name AS customer_name, c.phone_e164 AS customer_phone,
         f.appointment_id
    FROM feedbacks f
    LEFT JOIN staff_users s ON s.id = f.assigned_to
    LEFT JOIN customers c ON c.id = f.customer_id
`;

export interface PedidoDeRecado {
  readonly tenantId: string;
  readonly locationId: string;
  readonly tipo: string;
  readonly texto: string;
  /** Nulo é o recado anônimo, e ele é legítimo — ver a migração 0043. */
  readonly customerId?: string | null;
  readonly appointmentId?: string | null;
  readonly now?: Date;
}

/**
 * Registra o recado.
 *
 * ## O agendamento é conferido, e sob RLS
 *
 * `appointment_id` vem de fora, e a checagem de integridade referencial do
 * Postgres **ignora row security**: a chave estrangeira aceitaria de bom grado o
 * id de um atendimento de outra barbearia. É o mesmo cuidado que a lista de
 * espera documenta desde o bloco 38 — e aqui há um segundo motivo, mais
 * específico: sem conferir também o **dono**, alguém amarraria a própria
 * reclamação ao atendimento de terceiro, e a ficha daquela pessoa passaria a
 * exibir um texto que ela não escreveu.
 */
export async function registrarRecado(pedido: PedidoDeRecado): Promise<{ readonly id: string }> {
  const decisao = podeRegistrarRecado({ tipo: pedido.tipo, texto: pedido.texto });
  if (!decisao.aceito) recusar(decisao.recusa);

  return withTenant(pedido.tenantId, async (tx) => {
    const unidades = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM locations WHERE id = ${pedido.locationId}::uuid
    `;
    if (!unidades[0]) recusar('unidade_desconhecida');

    let agendamentoId: string | null = null;
    if (pedido.appointmentId && pedido.customerId) {
      const encontrados = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM appointments
         WHERE id = ${pedido.appointmentId}::uuid
           AND customer_id = ${pedido.customerId}::uuid
      `;
      agendamentoId = encontrados[0]?.id ?? null;
    }

    const criados = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO feedbacks (tenant_id, location_id, customer_id, appointment_id, kind, body)
      VALUES (
        ${pedido.tenantId}::uuid, ${pedido.locationId}::uuid,
        ${pedido.customerId ?? null}::uuid, ${agendamentoId}::uuid,
        ${pedido.tipo}::feedback_kind, ${pedido.texto.trim()}
      )
      RETURNING id
    `;

    const id = criados[0]?.id;
    if (id === undefined) recusar('recado_nao_encontrado');
    return { id };
  });
}

/**
 * A fila de triagem do balcão.
 *
 * A ordem é do domínio (`ordenarTriagem`), não do `ORDER BY`: reclamação antes
 * de elogio é regra de produto, e regra de produto que mora no SQL é regra que
 * ninguém encontra quando quer discuti-la.
 *
 * Numa consulta, com nome de quem assumiu e do cliente. Uma ida ao banco por
 * recado seria N+1 numa tela que o dono abre para saber o que está pegando.
 */
export async function recadosDaCasa(
  tenantId: string,
  params: {
    readonly locationId: string;
    readonly incluirEncerrados?: boolean;
    readonly agora?: Date;
  },
): Promise<readonly Recado[]> {
  const agora = params.agora ?? new Date();
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRawUnsafe<LinhaDoRecado[]>(
      `${SELECT_DO_RECADO}
        WHERE f.location_id = $1::uuid
          AND ($2::boolean OR f.status <> 'encerrado')
        ORDER BY f.created_at DESC
        LIMIT 200`,
      params.locationId,
      params.incluirEncerrados ?? false,
    );
    // A ordem é do domínio, e ele pensa em `Date`. A conversão de ida e volta
    // fica aqui, na borda do banco, e não vaza para a regra.
    const paraOrdenar = linhas.map((linha) => ({
      ...daLinha(linha, agora),
      criadoEm: linha.created_at,
    }));
    return ordenarTriagem(paraOrdenar).map((recado) => ({
      ...recado,
      criadoEm: recado.criadoEm.toISOString(),
    }));
  });
}

/** Um recado, para a tela de resposta. */
export async function recadoPorId(
  tenantId: string,
  id: string,
  agora: Date = new Date(),
): Promise<Recado | null> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRawUnsafe<LinhaDoRecado[]>(
      `${SELECT_DO_RECADO} WHERE f.id = $1::uuid`,
      id,
    );
    const linha = linhas[0];
    return linha ? daLinha(linha, agora) : null;
  });
}

export interface Ator {
  readonly id: string;
  readonly name: string;
}

/**
 * Assume o recado.
 *
 * "Assumir" e não "atribuir": quem opera o balcão pega para si, e a tela do
 * bloco 40 só oferece isso. Passar para outra pessoa existe — o parâmetro
 * aceita qualquer id da equipe —, e o id é conferido sob RLS pelo mesmo motivo
 * do agendamento acima.
 */
export async function assumirRecado(entrada: {
  readonly tenantId: string;
  readonly recadoId: string;
  readonly responsavelId: string | null;
  readonly ator: Ator;
}): Promise<void> {
  await withTenant(entrada.tenantId, async (tx) => {
    if (entrada.responsavelId) {
      const existe = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM staff_users WHERE id = ${entrada.responsavelId}::uuid
      `;
      if (!existe[0]) recusar('responsavel_desconhecido');
    }

    const atual = await estadoAtual(tx, entrada.recadoId);
    if (atual === 'encerrado') recusar('transicao_invalida');

    const afetados = await tx.$executeRaw`
      UPDATE feedbacks
         SET assigned_to = ${entrada.responsavelId}::uuid,
             status = CASE WHEN status = 'aberto' THEN 'em_analise'::feedback_status
                           ELSE status END,
             updated_at = now()
       WHERE id = ${entrada.recadoId}::uuid AND status <> 'encerrado'
    `;
    if (afetados === 0) recusar('recado_nao_encontrado');

    await audit(tx, {
      actorId: entrada.ator.id,
      actorName: entrada.ator.name,
      action: 'feedback.assigned',
      entity: 'feedbacks',
      entityId: entrada.recadoId,
      after: { responsavelId: entrada.responsavelId },
    });
  });
}

export interface RespostaEnviada {
  readonly enviada: boolean;
}

/**
 * Responde ao cliente.
 *
 * ## A tarefa nasce dentro da transação
 *
 * É a razão de `crm` depender de `jobs`. Gravar a resposta e enfileirar o envio
 * em transações separadas cria a janela em que o balcão lê "respondido" e o
 * cliente nunca recebe nada — e o canal inteiro existe para essa mensagem
 * chegar.
 *
 * ## Recado anônimo não é respondido, e a recusa é explícita
 *
 * Sem cliente não há telefone, e sem telefone não há resposta. Gravar "resposta
 * enviada" sobre um recado anônimo seria o pior tipo de indicador: o que diz
 * que a casa respondeu quando ninguém foi respondido.
 */
export async function responderRecado(entrada: {
  readonly tenantId: string;
  readonly recadoId: string;
  readonly resposta: string;
  readonly ator: Ator;
  readonly agora?: Date;
}): Promise<RespostaEnviada> {
  const resposta = entrada.resposta.trim();
  if (resposta.length === 0) recusar('resposta_vazia');
  if (resposta.length > MAXIMO_DA_RESPOSTA) recusar('resposta_longa');

  const agora = entrada.agora ?? new Date();

  return withTenant(entrada.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        status: EstadoDoRecado;
        customer_id: string | null;
        phone: string | null;
        timezone: string;
      }[]
    >`
      SELECT f.status::text AS status, f.customer_id, c.phone_e164 AS phone, l.timezone
        FROM feedbacks f
        JOIN locations l ON l.id = f.location_id
        LEFT JOIN customers c ON c.id = f.customer_id
       WHERE f.id = ${entrada.recadoId}::uuid
       FOR UPDATE OF f
    `;
    const atual = linhas[0];
    if (atual === undefined) return recusar('recado_nao_encontrado');
    if (!transicaoDoRecado(atual.status, 'respondido')) recusar('transicao_invalida');
    if (!atual.customer_id || !atual.phone) recusar('sem_contato');

    await tx.$executeRaw`
      UPDATE feedbacks
         SET status = 'respondido', answer = ${resposta}, answered_at = ${agora},
             answered_by = ${entrada.ator.id}::uuid, updated_at = now()
       WHERE id = ${entrada.recadoId}::uuid
    `;

    /**
     * O payload guarda **id**, nunca conteúdo: `jobs` não tem RLS, e o texto de
     * uma resposta a uma reclamação é conversa entre o cliente e a casa.
     *
     * A janela de silêncio empurra a **tarefa**, no fuso da unidade e nunca no
     * do servidor. A recepção responde às 22h porque é quando ela tem tempo; o
     * cliente recebe às 8h, que é quando ele quer receber. O recado esperou três
     * dias na fila — pode esperar até de manhã.
     */
    await enfileirar(tx, {
      kind: TAREFA_DE_RESPOSTA,
      payload: { recadoId: entrada.recadoId },
      rodarApos: foraDoSilencio(agora, atual.timezone),
      idempotencyKey: `recado-resposta:${entrada.recadoId}`,
      maxAttempts: 3,
    });

    await audit(tx, {
      actorId: entrada.ator.id,
      actorName: entrada.ator.name,
      action: 'feedback.answered',
      entity: 'feedbacks',
      entityId: entrada.recadoId,
      after: { caracteres: resposta.length },
    });

    return { enviada: true };
  });
}

/**
 * Encerra o recado.
 *
 * Encerrar **não** é apagar, e a diferença é o bloco inteiro: o texto continua
 * lá, contando para a leitura do trimestre. A tabela não tem `DELETE` para a
 * aplicação, então não existe caminho de código que faça o contrário.
 */
export async function encerrarRecado(entrada: {
  readonly tenantId: string;
  readonly recadoId: string;
  readonly ator: Ator;
  readonly agora?: Date;
}): Promise<void> {
  const agora = entrada.agora ?? new Date();
  await withTenant(entrada.tenantId, async (tx) => {
    const atual = await estadoAtual(tx, entrada.recadoId);
    if (atual === null) return recusar('recado_nao_encontrado');
    if (!transicaoDoRecado(atual, 'encerrado')) recusar('transicao_invalida');

    await tx.$executeRaw`
      UPDATE feedbacks
         SET status = 'encerrado', closed_at = ${agora}, updated_at = now()
       WHERE id = ${entrada.recadoId}::uuid AND status <> 'encerrado'
    `;

    await audit(tx, {
      actorId: entrada.ator.id,
      actorName: entrada.ator.name,
      action: 'feedback.closed',
      entity: 'feedbacks',
      entityId: entrada.recadoId,
      after: { de: atual },
    });
  });
}

async function estadoAtual(
  tx: TransactionClient,
  id: string,
): Promise<EstadoDoRecado | null> {
  const linhas = await tx.$queryRaw<{ status: EstadoDoRecado }[]>`
    SELECT status::text AS status FROM feedbacks WHERE id = ${id}::uuid
  `;
  return linhas[0]?.status ?? null;
}

export interface RespostaParaEnviar {
  readonly telefone: string;
  readonly clienteNome: string;
  readonly tipo: TipoDeRecado;
  readonly resposta: string;
  readonly customerId: string;
  /** Quem está respondendo. Sem o nome, a mensagem chega assinada por ninguém. */
  readonly barbearia: string;
}

/**
 * O que a mensagem de resposta precisa dizer, para o worker.
 *
 * Devolve `null` quando o recado deixou de ser respondível entre o enfileiramento
 * e a execução — a pessoa pediu exclusão nesse meio-tempo, por exemplo, e o
 * `customer_id` foi desatado.
 */
export async function respostaParaEnviar(
  tenantId: string,
  recadoId: string,
): Promise<RespostaParaEnviar | null> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        kind: TipoDeRecado;
        answer: string | null;
        customer_id: string | null;
        name: string;
        phone: string | null;
        barbearia: string;
      }[]
    >`
      SELECT f.kind, f.answer, f.customer_id, c.name, c.phone_e164 AS phone,
             t.name AS barbearia
        FROM feedbacks f
        JOIN customers c ON c.id = f.customer_id
        JOIN tenants t ON t.id = f.tenant_id
       WHERE f.id = ${recadoId}::uuid AND f.status = 'respondido'
    `;
    const linha = linhas[0];
    if (!linha || !linha.answer || !linha.phone || !linha.customer_id) return null;
    return {
      telefone: linha.phone,
      clienteNome: linha.name,
      tipo: linha.kind,
      resposta: linha.answer,
      customerId: linha.customer_id,
      barbearia: linha.barbearia,
    };
  });
}
