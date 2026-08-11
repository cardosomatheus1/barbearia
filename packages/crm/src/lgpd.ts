import { withTenant, type TransactionClient } from '@barbearia/db';
import { audit } from '@barbearia/identity';
import { anonimizarCliente } from './anonimizacao.js';

/**
 * Os direitos do titular (bloco 31, SPEC Parte 1 §1.8).
 *
 * ## Quem é quem, e por que isso decide o desenho
 *
 * A barbearia é **controladora**; a plataforma é **operadora**. Quem coletou o
 * dado foi ela, e é a ela que o titular pede acesso ou exclusão. Por isso tudo
 * aqui roda `withTenant` e nada roda sem tenant: não existe função neste
 * arquivo capaz de exportar a base de outra barbearia, nem por engano.
 *
 * ## Consentir é inserir, revogar também
 *
 * `customer_consents` é append-only desde a migração 0033. A revogação é uma
 * linha nova com `granted = false`, nunca a remoção da concessão — porque
 * "quando ele consentiu" e "quando ele revogou" são perguntas diferentes, e é o
 * par que responde a uma contestação.
 */

export const FINALIDADES = ['service', 'marketing', 'photos', 'photos_public'] as const;
export type Finalidade = (typeof FINALIDADES)[number];

export class LgpdError extends Error {
  constructor(
    readonly code:
      | 'customer_not_found'
      | 'invalid_purpose'
      | 'version_required'
      | 'exclusao_tem_caminho_proprio',
    message: string,
  ) {
    super(message);
    this.name = 'LgpdError';
  }
}

export interface DecisaoDeConsentimento {
  readonly finalidade: Finalidade;
  readonly concedido: boolean;
  readonly versaoDoTexto: string;
  readonly decididoEm: Date;
  readonly ip: string | null;
  /** Nulo é o próprio titular; preenchido é alguém da barbearia registrando. */
  readonly registradoPor: string | null;
}

interface LinhaDeConsentimento {
  purpose: Finalidade;
  granted: boolean;
  text_version: string;
  decided_at: Date;
  ip: string | null;
  recorded_by: string | null;
}

const paraDecisao = (l: LinhaDeConsentimento): DecisaoDeConsentimento => ({
  finalidade: l.purpose,
  concedido: l.granted,
  versaoDoTexto: l.text_version,
  decididoEm: l.decided_at,
  ip: l.ip,
  registradoPor: l.recorded_by,
});

/**
 * Registra uma decisão do titular.
 *
 * A versão do texto é **obrigatória** e não tem padrão. Sem ela o consentimento
 * não é comprovável: "ele aceitou" sem dizer o que ele leu não responde nada
 * numa contestação, e um padrão silencioso do tipo `'v1'` seria pior que a
 * ausência — daria a aparência de prova.
 *
 * O IP entra como texto e o banco o converte para `inet`, que recusa lixo. Um
 * IP inventado é pior que nenhum, e é por isso que o tipo do banco decide.
 */
export async function registrarConsentimento(entrada: {
  readonly tenantId: string;
  readonly customerId: string;
  readonly finalidade: Finalidade;
  readonly concedido: boolean;
  readonly versaoDoTexto: string;
  readonly ip?: string | null;
  readonly registradoPor?: { readonly id: string; readonly name: string } | null;
}): Promise<DecisaoDeConsentimento> {
  const versao = entrada.versaoDoTexto.trim();
  if (versao.length === 0) {
    throw new LgpdError('version_required', 'A versão do texto aceito é obrigatória');
  }
  if (!FINALIDADES.includes(entrada.finalidade)) {
    throw new LgpdError('invalid_purpose', 'Finalidade desconhecida');
  }

  return withTenant(entrada.tenantId, async (tx) => {
    const existe = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM customers WHERE id = ${entrada.customerId}::uuid
    `;
    if (existe.length === 0) {
      throw new LgpdError('customer_not_found', 'Cliente não encontrado');
    }

    const linhas = await tx.$queryRaw<LinhaDeConsentimento[]>`
      INSERT INTO customer_consents (customer_id, tenant_id, purpose, granted,
                                     text_version, ip, recorded_by)
      VALUES (
        ${entrada.customerId}::uuid,
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${entrada.finalidade}::consent_purpose,
        ${entrada.concedido},
        ${versao},
        ${entrada.ip ?? null}::inet,
        ${entrada.registradoPor?.id ?? null}::uuid
      )
      RETURNING purpose, granted, text_version, decided_at, ip::text AS ip, recorded_by
    `;
    const criada = linhas[0];
    if (!criada) throw new LgpdError('customer_not_found', 'Cliente não encontrado');

    /**
     * Auditado quando é a barbearia que registra, dentro da mesma transação.
     *
     * A decisão do próprio titular pela página pública não vira linha de
     * auditoria interna: `audit_log` é a trilha de **quem da casa** mexeu em
     * quê, e enchê-la com a ação do cliente é como uma trilha deixa de ser
     * lida. A prova do titular é a própria linha do histórico, com IP e versão.
     */
    if (entrada.registradoPor) {
      await audit(tx, {
        actorId: entrada.registradoPor.id,
        actorName: entrada.registradoPor.name,
        action: 'customer.consent_recorded',
        entity: 'customers',
        entityId: entrada.customerId,
        after: {
          finalidade: entrada.finalidade,
          concedido: entrada.concedido,
          versaoDoTexto: versao,
        },
      });
    }

    return paraDecisao(criada);
  });
}

export interface ConsentimentosDoCliente {
  /** A decisão que vale hoje para cada finalidade. Ausente é "nunca decidiu". */
  readonly atuais: Readonly<Partial<Record<Finalidade, DecisaoDeConsentimento>>>;
  /** Tudo, da mais recente para a mais antiga. É o que se mostra numa disputa. */
  readonly historico: readonly DecisaoDeConsentimento[];
}

/**
 * O estado atual e a história, numa consulta só.
 *
 * Uma consulta e não duas: são a mesma leitura, e o "atual" é derivado dela em
 * memória. Duas idas ao banco para responder à mesma tela é o N+1 disfarçado de
 * "são só duas".
 */
export async function consentimentosDoCliente(
  tenantId: string,
  customerId: string,
): Promise<ConsentimentosDoCliente> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<LinhaDeConsentimento[]>`
      SELECT purpose, granted, text_version, decided_at, ip::text AS ip, recorded_by
        FROM customer_consents
       WHERE customer_id = ${customerId}::uuid
       ORDER BY decided_at DESC, id DESC
       LIMIT 200
    `;

    const historico = linhas.map(paraDecisao);
    const atuais: Partial<Record<Finalidade, DecisaoDeConsentimento>> = {};
    // A lista já vem da mais recente: a primeira de cada finalidade é a que vale.
    for (const decisao of historico) {
      if (!(decisao.finalidade in atuais)) atuais[decisao.finalidade] = decisao;
    }

    return { atuais, historico };
  });
}

// ---------------------------------------------------------------------------
// Exportação
// ---------------------------------------------------------------------------

export interface DadosDoTitular {
  readonly geradoEm: string;
  readonly barbearia: { readonly nome: string; readonly encarregado: string | null };
  readonly cadastro: Record<string, unknown>;
  readonly consentimentos: readonly Record<string, unknown>[];
  readonly preferencias: Record<string, unknown> | null;
  readonly agendamentos: readonly Record<string, unknown>[];
  readonly compras: readonly Record<string, unknown>[];
  readonly fiado: readonly Record<string, unknown>[];
  readonly mensagens: readonly Record<string, unknown>[];
  readonly filas: readonly Record<string, unknown>[];
}

/**
 * Tudo que a barbearia tem sobre uma pessoa, em formato legível (SPEC §1.8.4).
 *
 * ## O que entra, e por que a lista é explícita
 *
 * Nove consultas nomeadas, não uma varredura de catálogo. Varrer `information_
 * schema` atrás de `customer_id` pareceria mais completo e seria pior: entraria
 * dado de outra pessoa que só menciona esta (o `updated_by` de uma ficha, por
 * exemplo), e sairia dado que não tem a coluna mas é dela mesmo assim. A lista
 * escrita é conferível; a varredura é uma promessa.
 *
 * **A tabela que entrar depois não entra sozinha aqui.** É custo aceito e está
 * dito: há teste que compara esta lista com as tabelas que têm `customer_id`, e
 * ele reprova quando alguém cria uma e esquece de exportá-la.
 *
 * ## O que fica de fora, de propósito
 *
 * `customer_sessions` — token de sessão é credencial, não dado pessoal do
 * titular, e exportá-lo entregaria um acesso vivo num arquivo que vai por
 * e-mail. `audit_log` também não: é a trilha de quem da casa mexeu em quê, e
 * traz o nome de funcionários que não são o titular deste pedido.
 */
export async function exportarDadosDoTitular(
  tenantId: string,
  customerId: string,
  agora: Date = new Date(),
): Promise<DadosDoTitular> {
  return withTenant(tenantId, async (tx) => {
    const clientes = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT c.id, c.name, c.phone_e164, c.accepts_marketing,
             c.balance_cents, c.credit_limit_cents, c.created_at, c.updated_at,
             t.name AS barbearia, t.dpo_name, t.dpo_email
        FROM customers c
        JOIN tenants t ON t.id = c.tenant_id
       WHERE c.id = ${customerId}::uuid
    `;
    const cliente = clientes[0];
    if (!cliente) throw new LgpdError('customer_not_found', 'Cliente não encontrado');

    const consentimentos = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT purpose, granted, text_version, decided_at, ip::text AS ip
        FROM customer_consents WHERE customer_id = ${customerId}::uuid
       ORDER BY decided_at
    `;

    const preferencias = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT maquina_laterais, tipo_degrade, topo, barba_estilo, produtos_evitar,
             conversa, observacoes, updated_at
        FROM customer_preferences WHERE customer_id = ${customerId}::uuid
    `;

    const agendamentos = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT a.id, a.starts_at, a.ends_at, a.status::text AS status,
             a.source::text AS source, a.created_at, p.name AS profissional
        FROM appointments a
        LEFT JOIN professionals p ON p.id = a.professional_id
       WHERE a.customer_id = ${customerId}::uuid
       ORDER BY a.starts_at
    `;

    const compras = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT id, status::text AS status, business_day, subtotal_cents,
             discount_cents, total_cents, closed_at
        FROM orders WHERE customer_id = ${customerId}::uuid
       ORDER BY opened_at
    `;

    const fiado = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT kind::text AS kind, amount_cents, note, created_at
        FROM customer_ledger WHERE customer_id = ${customerId}::uuid
       ORDER BY created_at
    `;

    /**
     * O conteúdo da mensagem **não** é exportado, e é decisão.
     *
     * `notifications` guarda que uma mensagem saiu, de que tipo e quando — que é
     * o que o titular tem direito de saber. O texto renderizado seria uma cópia
     * do template com o nome dele dentro, e reproduzi-lo num arquivo que
     * circula por e-mail multiplica o dado pessoal sem informar nada de novo.
     */
    const mensagens = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT kind::text AS kind, status::text AS status, reason, phone_masked, sent_at
        FROM notifications WHERE customer_id = ${customerId}::uuid
       ORDER BY sent_at
    `;

    const filas = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT status::text AS status, joined_at, called_at, started_at, finished_at, notes
        FROM queue_entries WHERE customer_id = ${customerId}::uuid
       ORDER BY joined_at
    `;

    /**
     * A lista de espera (bloco 38).
     *
     * Entrou aqui porque o teste de completude cobrou: `waitlist_entries` tem
     * `customer_id`, e toda tabela com essa coluna ou é exportada ou tem
     * exceção escrita. E é dado do titular de verdade — "eu pedi para ser
     * avisado do sábado de manhã e nunca me avisaram" é exatamente o tipo de
     * pergunta que a exportação existe para responder.
     */
    const esperas = await tx.$queryRaw<Record<string, unknown>[]>`
      SELECT e.status::text AS status, e.wanted_from, e.wanted_to,
             e.window_start_minute, e.window_end_minute, e.duration_minutes,
             p.name AS profissional, e.joined_at, e.closed_at
        FROM waitlist_entries e
        LEFT JOIN professionals p ON p.id = e.professional_id
       WHERE e.customer_id = ${customerId}::uuid
       ORDER BY e.joined_at
    `;

    const preferencia = preferencias[0] ?? null;

    return {
      geradoEm: agora.toISOString(),
      barbearia: {
        nome: String(cliente['barbearia'] ?? ''),
        encarregado: encarregado(cliente),
      },
      cadastro: {
        nome: cliente['name'],
        telefone: cliente['phone_e164'],
        aceitaMarketing: cliente['accepts_marketing'],
        saldoCents: cliente['balance_cents'],
        limiteDeFiadoCents: cliente['credit_limit_cents'],
        criadoEm: cliente['created_at'],
        atualizadoEm: cliente['updated_at'],
      },
      consentimentos,
      preferencias: preferencia,
      agendamentos,
      compras,
      fiado,
      mensagens,
      filas,
      esperas,
    };
  });
}

/** "Fulano <e-mail>", ou nulo enquanto a barbearia não cadastrou encarregado. */
function encarregado(linha: Record<string, unknown>): string | null {
  const nome = linha['dpo_name'];
  const email = linha['dpo_email'];
  if (typeof nome !== 'string' || nome.length === 0) return null;
  return typeof email === 'string' && email.length > 0 ? `${nome} <${email}>` : nome;
}

// ---------------------------------------------------------------------------
// O pedido do titular
// ---------------------------------------------------------------------------

/** Quinze dias, da SPEC §1.8.4. Gravado no pedido, não calculado na leitura. */
export const PRAZO_DO_PEDIDO_DIAS = 15;

export interface PedidoDoTitular {
  readonly id: string;
  readonly tipo: 'export' | 'deletion';
  readonly estado: 'open' | 'done' | 'refused';
  readonly customerId: string | null;
  readonly pedidoEm: Date;
  readonly venceEm: Date;
  readonly encerradoEm: Date | null;
  readonly nota: string | null;
}

interface LinhaDePedido {
  id: string;
  kind: 'export' | 'deletion';
  status: 'open' | 'done' | 'refused';
  customer_id: string | null;
  requested_at: Date;
  due_at: Date;
  settled_at: Date | null;
  note: string | null;
}

const paraPedido = (l: LinhaDePedido): PedidoDoTitular => ({
  id: l.id,
  tipo: l.kind,
  estado: l.status,
  customerId: l.customer_id,
  pedidoEm: l.requested_at,
  venceEm: l.due_at,
  encerradoEm: l.settled_at,
  nota: l.note,
});

const COLUNAS = `id, kind, status, customer_id, requested_at, due_at, settled_at, note`;

/**
 * Abre um pedido de acesso ou de exclusão.
 *
 * O prazo é gravado agora e não calculado depois: mudar a regra de 15 para 20
 * dias não pode mover o vencimento de um pedido que já foi feito sob a regra
 * antiga.
 *
 * ## Pedir duas vezes devolve o mesmo pedido
 *
 * O mesmo direito chega pelos dois caminhos: o titular manda no WhatsApp, a
 * recepção registra, e ele clica no botão da tela dele achando que o primeiro
 * não passou. Duas linhas fariam o mesmo prazo ter duas respostas, e a segunda
 * ainda reiniciaria a contagem — o que é pior do que duplicar, porque **atrasa**
 * a obrigação.
 *
 * A garantia é o índice único parcial do banco; este `ON CONFLICT` é o que
 * transforma a colisão em resposta em vez de erro.
 */
export async function abrirPedidoDoTitular(entrada: {
  readonly tenantId: string;
  readonly customerId: string;
  readonly tipo: 'export' | 'deletion';
  readonly agora?: Date;
}): Promise<PedidoDoTitular> {
  const agora = entrada.agora ?? new Date();
  const vence = new Date(agora.getTime() + PRAZO_DO_PEDIDO_DIAS * 86_400_000);

  return withTenant(entrada.tenantId, async (tx) => {
    const existe = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM customers WHERE id = ${entrada.customerId}::uuid
    `;
    if (existe.length === 0) {
      throw new LgpdError('customer_not_found', 'Cliente não encontrado');
    }

    const criadas = await tx.$queryRaw<LinhaDePedido[]>`
      INSERT INTO data_requests (tenant_id, customer_id, kind, requested_at, due_at)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${entrada.customerId}::uuid,
        ${entrada.tipo}::data_request_kind,
        ${agora},
        ${vence}
      )
      ON CONFLICT DO NOTHING
      RETURNING id, kind, status, customer_id, requested_at, due_at, settled_at, note
    `;
    const criado = criadas[0];
    if (criado) return paraPedido(criado);

    const abertas = await tx.$queryRaw<LinhaDePedido[]>`
      SELECT id, kind, status, customer_id, requested_at, due_at, settled_at, note
        FROM data_requests
       WHERE customer_id = ${entrada.customerId}::uuid
         AND kind = ${entrada.tipo}::data_request_kind
         AND status = 'open'
    `;
    const aberto = abertas[0];
    if (!aberto) throw new LgpdError('customer_not_found', 'Cliente não encontrado');
    return paraPedido(aberto);
  });
}

/** Os pedidos abertos, de quem vence primeiro — é a fila de quem responde. */
export async function pedidosDoTitular(
  tenantId: string,
  incluirEncerrados = false,
): Promise<readonly PedidoDoTitular[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = incluirEncerrados
      ? await tx.$queryRaw<LinhaDePedido[]>`
          SELECT id, kind, status, customer_id, requested_at, due_at, settled_at, note
            FROM data_requests ORDER BY due_at LIMIT 200
        `
      : await tx.$queryRaw<LinhaDePedido[]>`
          SELECT id, kind, status, customer_id, requested_at, due_at, settled_at, note
            FROM data_requests WHERE status = 'open' ORDER BY due_at LIMIT 200
        `;
    return linhas.map(paraPedido);
  });
}

/**
 * Encerra o pedido: atendido ou recusado.
 *
 * Recusar exige motivo escrito, no banco e aqui. A LGPD admite recusa — pedido
 * de exclusão que conflita com obrigação legal de guarda, por exemplo —, mas
 * recusa sem motivo registrado é a que não se defende depois.
 *
 * ## Pedido de exclusão não é atendido por aqui (bloco 32)
 *
 * Marcar "atendido" num pedido de exclusão sem apagar nada seria a prova por
 * escrito de um descumprimento — e apagar aqui dentro faria a rota de encerrar
 * pedidos, que é `settings.manage`, destruir cadastro. São duas coisas
 * diferentes com permissões diferentes, então são duas funções:
 * `atenderExclusao` faz a exclusão e fecha o pedido junto.
 *
 * **Recusar** um pedido de exclusão continua aqui, e está certo: recusar não
 * destrói nada, e é a resposta legítima quando a guarda fiscal obriga.
 */
export async function encerrarPedidoDoTitular(entrada: {
  readonly tenantId: string;
  readonly pedidoId: string;
  readonly atendido: boolean;
  readonly nota?: string | null;
  readonly ator: { readonly id: string; readonly name: string };
}): Promise<void> {
  const nota = (entrada.nota ?? '').trim();
  if (!entrada.atendido && nota.length < 3) {
    throw new LgpdError('version_required', 'Escreva o motivo da recusa');
  }

  await withTenant(entrada.tenantId, async (tx) => {
    const abertos = await tx.$queryRaw<{ kind: string }[]>`
      SELECT kind FROM data_requests
       WHERE id = ${entrada.pedidoId}::uuid AND status = 'open'
       FOR UPDATE
    `;
    const pedido = abertos[0];
    if (!pedido) {
      throw new LgpdError('customer_not_found', 'Pedido inexistente ou já encerrado');
    }

    /**
     * A recusa de encerrar exclusão por aqui, e o porquê de ela ser explícita.
     *
     * Silenciar — marcar atendido e não apagar — é o pior resultado: a
     * barbearia acredita ter cumprido, e o registro diz que cumpriu. O erro
     * aponta para o caminho certo, que exige a permissão de destruir.
     */
    if (pedido.kind === 'deletion' && entrada.atendido) {
      throw new LgpdError(
        'exclusao_tem_caminho_proprio',
        'Pedido de exclusão é atendido apagando o cadastro, não marcando a linha',
      );
    }

    await tx.$executeRaw`
      UPDATE data_requests
         SET status = ${entrada.atendido ? 'done' : 'refused'}::data_request_status,
             settled_at = now(),
             note = ${nota.length > 0 ? nota : null}
       WHERE id = ${entrada.pedidoId}::uuid AND status = 'open'
    `;

    await audit(tx, {
      actorId: entrada.ator.id,
      actorName: entrada.ator.name,
      action: entrada.atendido ? 'lgpd.request_fulfilled' : 'lgpd.request_refused',
      entity: 'data_requests',
      entityId: entrada.pedidoId,
      after: { nota: nota.length > 0 ? nota : null },
    });
  });
}

/**
 * Atende um pedido de exclusão: apaga a pessoa e fecha o pedido, junto.
 *
 * As duas coisas na **mesma transação**, porque separá-las cria os dois estados
 * ruins e nenhum é detectável depois: o pedido fechado sobre um cadastro
 * intacto (a barbearia acredita ter cumprido) e o cadastro apagado com o pedido
 * ainda na fila (alguém apaga de novo, e o prazo continua correndo sobre uma
 * obrigação já cumprida).
 *
 * Funciona **sem** pedido aberto, de propósito: a pessoa que pede exclusão no
 * balcão, na frente do barbeiro, não deveria precisar que alguém abra um
 * chamado antes. Quando existe pedido aberto, ele é fechado; quando não existe,
 * a trilha da anonimização é o registro.
 */
export async function atenderExclusao(entrada: {
  readonly tenantId: string;
  readonly customerId: string;
  readonly motivo: string;
  readonly ator: { readonly id: string; readonly name: string };
}): Promise<{ readonly anonimizou: boolean; readonly pedidosFechados: number }> {
  return withTenant(entrada.tenantId, async (tx) => {
    const resultado = await anonimizarCliente({
      tenantId: entrada.tenantId,
      customerId: entrada.customerId,
      motivo: entrada.motivo,
      ator: entrada.ator,
      tx,
    });

    if (!resultado.anonimizado) {
      return { anonimizou: false, pedidosFechados: 0 };
    }

    const fechados = await tx.$executeRaw`
      UPDATE data_requests
         SET status = 'done', settled_at = now(),
             note = COALESCE(note, 'Cadastro anonimizado')
       WHERE customer_id = ${entrada.customerId}::uuid
         AND kind = 'deletion' AND status = 'open'
    `;

    if (fechados > 0) {
      await audit(tx, {
        actorId: entrada.ator.id,
        actorName: entrada.ator.name,
        action: 'lgpd.request_fulfilled',
        entity: 'customers',
        entityId: entrada.customerId,
        after: { apelido: resultado.apelido },
      });
    }

    return { anonimizou: true, pedidosFechados: fechados };
  });
}

export type { TransactionClient };
