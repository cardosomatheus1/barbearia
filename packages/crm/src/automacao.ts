import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  chaveDoFato,
  decidirDisparo,
  objetivoAlcancado,
  validarAutomacao,
  type Gatilho,
  type Objetivo,
  type TipoDeNotificacao,
  tipoDeCampanhaValido,
} from '@barbearia/core';
import { audit } from '@barbearia/identity';

/**
 * O motor de automação, do banco para a fila (bloco 56, SPEC §4.11).
 *
 * ## A varredura pergunta ao banco quem cruzou a condição
 *
 * É o oposto de uma lista estática: ninguém monta o público, e o público de
 * amanhã é diferente do de hoje sem ninguém mexer. Cada gatilho é uma consulta
 * com o mesmo formato — quem é, quando o fato aconteceu, e qual a chave que o
 * identifica.
 *
 * ## O disparo nasce marcado, não enviado
 *
 * A linha em `automation_sends` é criada com `scheduled_for` e sem `sent_at`. É
 * o que permite a janela de silêncio empurrar sem perder o disparo, e é o que
 * dá ao balcão a resposta para "por que o Carlos não recebeu?" — o motivo fica
 * escrito ao lado.
 */

export type AutomacaoFailure = 'nao_encontrada' | 'invalida';

export class AutomacaoError extends Error {
  constructor(
    readonly code: AutomacaoFailure,
    message: string,
  ) {
    super(message);
    this.name = 'AutomacaoError';
  }
}

export interface AutomacaoNaTela {
  readonly id: string;
  readonly nome: string;
  readonly gatilho: Gatilho;
  readonly limiar: number | null;
  readonly atrasoMinutos: number;
  readonly tipo: TipoDeNotificacao;
  readonly objetivo: Objetivo;
  readonly janelaDias: number;
  readonly ativa: boolean;
  /**
   * Qual texto ela manda, e o nome dele para a tela (bloco 94).
   *
   * Nulo é automação anterior ao bloco: ela resolve por tipo, e a tela diz isso
   * em letras em vez de deixar o campo em branco — campo vazio numa lista de
   * envio é a pessoa supondo qual mensagem sai.
   */
  readonly templateId: string | null;
  readonly textoTitulo: string | null;
  /** Quantas saíram e quantas alcançaram o objetivo. É o que decide desligar. */
  readonly enviadas: number;
  readonly alcancadas: number;
}

const COLUNAS = `a.id, a.name, a.trigger::text AS trigger, a.threshold, a.delay_minutes,
                 a.kind::text AS kind, a.goal::text AS goal, a.goal_window_days, a.active,
                 a.template_id`;

/**
 * O título do texto é só da tela, e por isso não entra em `COLUNAS`.
 *
 * A varredura lê as mesmas colunas e **não** junta `whatsapp_templates` — nem
 * precisa: ela decide quem dispara, e o nome do texto não entra nessa conta.
 * Numa constante compartilhada, ele quebrava a varredura com "missing
 * FROM-clause entry", que foi o que aconteceu.
 */
const TITULO_DO_TEXTO = `w.titulo AS texto_titulo`;

const paraTela = (l: {
  id: string;
  name: string;
  trigger: Gatilho;
  threshold: number | null;
  delay_minutes: number;
  kind: TipoDeNotificacao;
  goal: Objetivo;
  goal_window_days: number;
  active: boolean;
  template_id: string | null;
  texto_titulo: string | null;
  enviadas: bigint | number;
  alcancadas: bigint | number;
}): AutomacaoNaTela => ({
  id: l.id,
  nome: l.name,
  gatilho: l.trigger,
  limiar: l.threshold,
  atrasoMinutos: l.delay_minutes,
  tipo: l.kind,
  objetivo: l.goal,
  janelaDias: l.goal_window_days,
  ativa: l.active,
  templateId: l.template_id,
  textoTitulo: l.texto_titulo,
  enviadas: Number(l.enviadas),
  alcancadas: Number(l.alcancadas),
});

/**
 * A lista, já com o desfecho.
 *
 * Enviadas e alcançadas vêm na **mesma consulta**, por agregação: uma ida ao
 * banco por automação dentro do laço seria o N+1 que a regra proíbe — e a tela
 * sem esses dois números seria uma lista de automações que ninguém consegue
 * defender nem matar, que é o que a SPEC §4.11 proíbe em letras.
 */
export async function automacoesDaCasa(tenantId: string): Promise<readonly AutomacaoNaTela[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRawUnsafe<Parameters<typeof paraTela>[0][]>(
      `SELECT ${COLUNAS}, ${TITULO_DO_TEXTO},
              count(s.id) FILTER (WHERE s.sent_at IS NOT NULL) AS enviadas,
              count(s.id) FILTER (WHERE s.goal_met_at IS NOT NULL) AS alcancadas
         FROM automations a
         LEFT JOIN automation_sends s ON s.automation_id = a.id
         LEFT JOIN whatsapp_templates w ON w.id = a.template_id
        GROUP BY a.id, w.titulo
        ORDER BY a.created_at DESC`,
    );
    return linhas.map(paraTela);
  });
}

export async function salvarAutomacao(params: {
  readonly tenantId: string;
  readonly id?: string;
  readonly nome: string;
  readonly gatilho: Gatilho;
  readonly limiar: number | null;
  readonly atrasoMinutos: number;
  readonly tipo: TipoDeNotificacao;
  /**
   * Qual texto esta automação manda (bloco 94).
   *
   * Opcional para não trancar a automação criada antes deste bloco, que resolve
   * por tipo como sempre fez — é a decisão de `staff_locations`, onde ausência
   * significa o comportamento anterior. A tela pede na primeira edição.
   */
  readonly templateId?: string | null;
  readonly objetivo: Objetivo;
  readonly janelaDias: number;
  readonly ativa: boolean;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<{ readonly id: string }> {
  const falha = validarAutomacao({
    nome: params.nome,
    gatilho: params.gatilho,
    limiar: params.limiar,
    atrasoMinutos: params.atrasoMinutos,
    janelaDias: params.janelaDias,
  });
  if (falha) throw new AutomacaoError('invalida', falha);
  /**
   * Automação usa a **mesma** lista fechada da campanha, e faltava.
   *
   * `TIPOS_DE_CAMPANHA` nasceu porque um seletor com os seis tipos deixava a
   * campanha escolher `lembrete_24h` — transacional, que ignora o opt-out de
   * marketing — e mandar para a base inteira, inclusive para quem revogou o
   * consentimento. A automação ficou de fora do conserto, com o mesmo seletor e
   * a mesma consequência: ela dispara sozinha, o que é pior.
   *
   * E mente no texto pelo mesmo motivo do bloco 87: `MensagemDeAutomacao` não
   * carrega hora nem profissional — quem recebe uma automação **não tem horário
   * marcado**. Um `lembrete_24h` sairia como "seu corte é amanhã às  com ".
   *
   * `senha_de_acesso` é o caso mais grave: é credencial, e estava disponível
   * como peça de marketing recorrente.
   */
  if (!tipoDeCampanhaValido(params.tipo)) {
    throw new AutomacaoError('invalida', 'Este texto não serve para automação.');
  }

  return withTenant(params.tenantId, async (tx) => {
    /**
     * O tipo sai do **texto escolhido**, e não de um campo ao lado.
     *
     * Os dois viajavam separados no formulário, e separados eles divergem: a
     * automação declararia um tipo e mandaria o texto de outro, com o opt-out,
     * o teto do mês e a categoria na Meta sendo decididos pelo primeiro. É a
     * lista paralela de sempre, agora entre dois campos do mesmo envio.
     *
     * Conferido sob RLS antes de gravar, como todo id que vem do corpo: a
     * checagem de integridade referencial do Postgres ignora row security, e a
     * chave estrangeira aceitaria o texto de outra barbearia sem reclamar.
     */
    let tipo = params.tipo;
    if (params.templateId) {
      const doTexto = await tx.$queryRaw<{ kind: TipoDeNotificacao }[]>`
        SELECT kind::text AS kind FROM whatsapp_templates
         WHERE id = ${params.templateId}::uuid
      `;
      const achado = doTexto[0];
      if (!achado) throw new AutomacaoError('invalida', 'Este texto não existe.');
      tipo = achado.kind;
      if (!tipoDeCampanhaValido(tipo)) {
        throw new AutomacaoError('invalida', 'Este texto não serve para automação.');
      }
    }

    const linhas = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO automations
        (id, tenant_id, name, trigger, threshold, delay_minutes, kind, goal,
         goal_window_days, active, created_by, template_id)
      VALUES (COALESCE(${params.id ?? null}::uuid, gen_random_uuid()),
              NULLIF(current_setting('app.tenant_id', true), '')::uuid,
              ${params.nome.trim()}, ${params.gatilho}::automation_trigger,
              ${params.limiar}, ${params.atrasoMinutos},
              ${tipo}::notification_kind, ${params.objetivo}::automation_goal,
              ${params.janelaDias}, ${params.ativa}, ${params.staffId}::uuid,
              ${params.templateId ?? null}::uuid)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        threshold = EXCLUDED.threshold,
        delay_minutes = EXCLUDED.delay_minutes,
        kind = EXCLUDED.kind,
        goal = EXCLUDED.goal,
        goal_window_days = EXCLUDED.goal_window_days,
        active = EXCLUDED.active,
        -- COALESCE e nao EXCLUDED direto: quem liga e desliga pela porta
        -- propria nao manda o texto, e sobrescrever com nulo apagaria a escolha
        -- de quem montou a automacao. Trocar o texto e edicao, e ali ele vem.
        -- (Sem crase: isto esta dentro de um template literal, e a crase o fecha.)
        template_id = COALESCE(EXCLUDED.template_id, automations.template_id),
        updated_at = now()
      RETURNING id
    `;
    const linha = linhas[0];
    if (!linha) throw new AutomacaoError('nao_encontrada', 'Automação não encontrada.');

    /**
     * Auditado porque decide o que a casa manda para a base inteira.
     *
     * Não move centavo, então fica na trilha de gestão. A pergunta que ela
     * responde — "quem ligou a que manda mensagem todo aniversário?" — é de
     * quem administra, e aparece quando a conta da Meta sobe.
     */
    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'automation.changed',
      entity: 'automations',
      entityId: linha.id,
      after: { nome: params.nome, gatilho: params.gatilho, ativa: params.ativa },
    });
    return { id: linha.id };
  });
}

// ---------------------------------------------------------------------------
// A varredura
// ---------------------------------------------------------------------------

interface Candidato {
  readonly customerId: string;
  readonly referencia: string;
  readonly fatoEm: Date;
  readonly temTelefone: boolean;
  readonly aceitaPromocional: boolean;
}

/**
 * Quem cruzou a condição deste gatilho.
 *
 * Uma consulta por gatilho, todas com a mesma forma. Os gatilhos que dependem de
 * dado que este produto ainda não tem devolvem vazio **em silêncio** — e é a
 * lacuna declarada que diz qual bloco os traz, não um `throw` que derrubaria a
 * varredura inteira por causa de uma automação que alguém ligou.
 */
async function candidatos(
  tx: TransactionClient,
  gatilho: Gatilho,
  limiar: number | null,
  agora: Date,
): Promise<readonly Candidato[]> {
  const comum = `c.phone_e164 IS NOT NULL AS tem_telefone,
                 c.accepts_marketing AS aceita`;

  if (gatilho === 'sem_retorno') {
    const dias = limiar ?? 30;
    return (
      await tx.$queryRawUnsafe<
        { customer_id: string; referencia: string; fato_em: Date; tem_telefone: boolean; aceita: boolean }[]
      >(
        `SELECT c.id AS customer_id,
                to_char(max(a.starts_at), 'YYYY-MM-DD') AS referencia,
                max(a.starts_at) AS fato_em, ${comum}
           FROM customers c
           JOIN appointments a ON a.customer_id = c.id AND a.status = 'completed'
          WHERE c.anonymized_at IS NULL
          GROUP BY c.id
         HAVING max(a.starts_at) < $1::timestamptz - ($2::int * interval '1 day')
            AND max(a.starts_at) > $1::timestamptz - (($2::int + 7) * interval '1 day')`,
        agora,
        dias,
      )
    ).map((l) => ({
      customerId: l.customer_id,
      referencia: l.referencia,
      fatoEm: l.fato_em,
      temTelefone: l.tem_telefone,
      aceitaPromocional: l.aceita,
    }));
  }

  if (gatilho === 'aniversario') {
    const antes = limiar ?? 0;
    return (
      await tx.$queryRawUnsafe<
        { customer_id: string; referencia: string; fato_em: Date; tem_telefone: boolean; aceita: boolean }[]
      >(
        `SELECT c.id AS customer_id, to_char(c.birth_date, 'MM-DD') AS referencia,
                $1::timestamptz AS fato_em, ${comum}
           FROM customers c
          WHERE c.anonymized_at IS NULL
            AND c.birth_date IS NOT NULL
            AND to_char(c.birth_date, 'MM-DD')
              = to_char(($1::timestamptz + ($2::int * interval '1 day'))::date, 'MM-DD')`,
        agora,
        antes,
      )
    ).map((l) => ({
      customerId: l.customer_id,
      referencia: l.referencia,
      fatoEm: l.fato_em,
      temTelefone: l.tem_telefone,
      aceitaPromocional: l.aceita,
    }));
  }

  if (gatilho === 'primeiro_atendimento') {
    return (
      await tx.$queryRawUnsafe<
        { customer_id: string; referencia: string; fato_em: Date; tem_telefone: boolean; aceita: boolean }[]
      >(
        `SELECT c.id AS customer_id, min(a.id)::text AS referencia,
                min(a.starts_at) AS fato_em, ${comum}
           FROM customers c
           JOIN appointments a ON a.customer_id = c.id AND a.status = 'completed'
          WHERE c.anonymized_at IS NULL
          GROUP BY c.id
         HAVING count(a.id) = 1
            AND min(a.starts_at) > $1::timestamptz - interval '2 days'`,
        agora,
      )
    ).map((l) => ({
      customerId: l.customer_id,
      referencia: l.referencia,
      fatoEm: l.fato_em,
      temTelefone: l.tem_telefone,
      aceitaPromocional: l.aceita,
    }));
  }

  const simples = async (sql: string, ...args: unknown[]) =>
    (
      await tx.$queryRawUnsafe<
        {
          customer_id: string;
          referencia: string;
          fato_em: Date;
          tem_telefone: boolean;
          aceita: boolean;
        }[]
      >(sql, ...args)
    ).map((l) => ({
      customerId: l.customer_id,
      referencia: l.referencia,
      fatoEm: l.fato_em,
      temTelefone: l.tem_telefone,
      aceitaPromocional: l.aceita,
    }));

  /**
   * Os oito que faltavam (bloco 57).
   *
   * Todos têm a mesma forma — quem é, quando o fato aconteceu, qual a chave — e
   * todos olham só o passado recente: a varredura roda de hora em hora, e uma
   * consulta sem recorte de tempo reprocessaria a base inteira toda volta para
   * descobrir que já disparou. A unicidade por fato garante a corretude; o
   * recorte garante que ela não custe a base inteira.
   */
  if (gatilho === 'cancelamento') {
    return simples(
      `SELECT c.id AS customer_id, a.id::text AS referencia, a.cancelled_at AS fato_em, ${comum}
         FROM appointments a
         JOIN customers c ON c.id = a.customer_id
        WHERE a.status = 'cancelled_customer'
          AND a.cancelled_at > $1::timestamptz - interval '2 days'
          AND c.anonymized_at IS NULL`,
      agora,
    );
  }

  if (gatilho === 'avaliacao_positiva' || gatilho === 'avaliacao_negativa') {
    /**
     * O limiar é em estrelas, e o sentido muda com o gatilho: "a partir de
     * quantas" para a boa, "até quantas" para a ruim. É o mesmo campo com dois
     * significados — a razão de o rótulo morar em `core` e não na tela.
     */
    const positiva = gatilho === 'avaliacao_positiva';
    const estrelas = limiar ?? (positiva ? 4 : 3);
    return simples(
      `SELECT c.id AS customer_id, r.id::text AS referencia, r.created_at AS fato_em, ${comum}
         FROM reviews r
         JOIN customers c ON c.id = r.customer_id
        WHERE r.created_at > $1::timestamptz - interval '2 days'
          AND r.rating ${positiva ? '>=' : '<='} $2::int
          AND c.anonymized_at IS NULL`,
      agora,
      estrelas,
    );
  }

  if (gatilho === 'servico_realizado' || gatilho === 'produto_comprado') {
    const tipo = gatilho === 'servico_realizado' ? 'service' : 'product';
    return simples(
      `SELECT c.id AS customer_id, o.id::text AS referencia, o.closed_at AS fato_em, ${comum}
         FROM orders o
         JOIN customers c ON c.id = o.customer_id
        WHERE o.status = 'paid'
          AND o.closed_at > $1::timestamptz - interval '2 days'
          AND c.anonymized_at IS NULL
          AND EXISTS (
            SELECT 1 FROM order_items i
             WHERE i.order_id = o.id AND i.kind = $2::order_item_kind
          )`,
      agora,
      tipo,
    );
  }

  if (gatilho === 'pacote_acabando') {
    /**
     * "Faltam quantas unidades" — e o saldo é **derivado**, como manda a
     * convenção do produto: comprado menos consumido. Um contador responderia
     * mais rápido e estaria errado no dia em que alguém estornasse uma venda.
     */
    const restantes = limiar ?? 1;
    return simples(
      `SELECT c.id AS customer_id, p.id::text AS referencia, now() AS fato_em, ${comum}
         FROM customer_packages p
         JOIN customers c ON c.id = p.customer_id
        WHERE c.anonymized_at IS NULL
          AND p.status = 'active'
          AND p.quantity - (
                SELECT count(*) FROM package_uses u WHERE u.customer_package_id = p.id
              ) <= $2::int
          AND p.quantity - (
                SELECT count(*) FROM package_uses u WHERE u.customer_package_id = p.id
              ) > 0`,
      agora,
      restantes,
    );
  }

  if (gatilho === 'assinatura_vencendo') {
    const dias = limiar ?? 3;
    return simples(
      `SELECT c.id AS customer_id,
              to_char(f.due_at, 'YYYY-MM-DD') AS referencia, f.due_at AS fato_em, ${comum}
         FROM club_invoices f
         JOIN club_subscriptions s ON s.id = f.subscription_id
         JOIN customers c ON c.id = s.customer_id
        WHERE c.anonymized_at IS NULL
          AND f.status = 'aberta'
          AND f.due_at BETWEEN $1::timestamptz AND $1::timestamptz + ($2::int * interval '1 day')`,
      agora,
      dias,
    );
  }

  if (gatilho === 'vaga_na_espera') {
    return simples(
      `SELECT c.id AS customer_id, o.id::text AS referencia, o.created_at AS fato_em, ${comum}
         FROM waitlist_offers o
         JOIN waitlist_entries e ON e.id = o.entry_id
         JOIN customers c ON c.id = e.customer_id
        WHERE c.anonymized_at IS NULL
          AND o.created_at > $1::timestamptz - interval '1 day'`,
      agora,
    );
  }

  return [];
}

export interface ResultadoDaAutomacao {
  readonly marcados: number;
  readonly pulados: number;
}

/**
 * Uma volta da varredura para uma barbearia.
 *
 * Marca disparos; **não** manda mensagem. Quem manda é a tarefa da fila, depois
 * de a janela de silêncio ter passado — separar as duas é o que permite ao
 * balcão ver "vai sair às 8h" em vez de descobrir depois.
 */
export async function varrerAutomacoes(params: {
  readonly tenantId: string;
  readonly agora: Date;
  readonly timeZone: string;
}): Promise<ResultadoDaAutomacao> {
  return withTenant(params.tenantId, async (tx) => {
    const regras = await tx.$queryRawUnsafe<Parameters<typeof paraTela>[0][]>(
      `SELECT ${COLUNAS}, NULL AS texto_titulo, 0 AS enviadas, 0 AS alcancadas
         FROM automations a WHERE a.active`,
    );

    let marcados = 0;
    let pulados = 0;
    const ano = params.agora.getUTCFullYear();

    for (const bruta of regras) {
      const regra = paraTela(bruta);
      const lista = await candidatos(tx, regra.gatilho, regra.limiar, params.agora);
      if (lista.length === 0) continue;

      /**
       * Os três contadores do cliente, numa consulta só para o lote.
       *
       * Perguntá-los dentro do laço seria uma ida ao banco por candidato — o
       * N+1 que a regra proíbe, e aqui ele é sobre a base inteira de clientes.
       */
      const ids = lista.map((c) => c.customerId);
      const contagens = await tx.$queryRaw<
        { customer_id: string; hoje: bigint; no_mes: bigint }[]
      >`
        SELECT c.id AS customer_id,
               count(s.id) FILTER (
                 WHERE s.sent_at IS NOT NULL
                   AND (s.sent_at AT TIME ZONE 'UTC')::date
                     = (${params.agora}::timestamptz AT TIME ZONE 'UTC')::date
               ) AS hoje,
               count(n.id) FILTER (
                 WHERE n.sent_at > ${params.agora}::timestamptz - interval '30 days'
               ) AS no_mes
          FROM customers c
          LEFT JOIN automation_sends s ON s.customer_id = c.id
          LEFT JOIN notifications n ON n.customer_id = c.id AND n.status = 'sent'
         WHERE c.id = ANY(${ids}::uuid[])
         GROUP BY c.id
      `;
      const porCliente = new Map(
        contagens.map((c) => [c.customer_id, { hoje: Number(c.hoje), noMes: Number(c.no_mes) }]),
      );

      for (const candidato of lista) {
        const chave = chaveDoFato({
          gatilho: regra.gatilho,
          referencia: candidato.referencia,
          ano,
        });
        const contador = porCliente.get(candidato.customerId) ?? { hoje: 0, noMes: 0 };

        const decisao = decidirDisparo({
          ativa: regra.ativa,
          tipo: regra.tipo,
          // A unicidade no banco é quem garante de verdade; aqui a pergunta
          // evita gravar linha pulada por um fato que já disparou.
          jaDisparouPorEsteFato: false,
          jaRecebeuHoje: contador.hoje > 0,
          temTelefone: candidato.temTelefone,
          aceitaPromocional: candidato.aceitaPromocional,
          promocionaisNoMes: contador.noMes,
          atrasoMinutos: regra.atrasoMinutos,
          fatoEm: candidato.fatoEm,
          agora: params.agora,
          timeZone: params.timeZone,
        });

        /**
         * O disparo pulado **também** é gravado, com o motivo.
         *
         * É o que responde "por que o Carlos não recebeu?" sem investigação — a
         * mesma decisão de `notifications.reason`, do bloco 20. E o índice do
         * dia é parcial no enviado, então o pulado não ocupa a vaga de ninguém.
         */
        const gravadas = await tx.$executeRaw`
          INSERT INTO automation_sends
            (tenant_id, automation_id, customer_id, trigger_key, triggered_at,
             scheduled_for, skipped_reason)
          VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid,
                  ${regra.id}::uuid, ${candidato.customerId}::uuid, ${chave},
                  ${candidato.fatoEm}, ${decisao.quando ?? params.agora},
                  ${decisao.motivo})
          ON CONFLICT (automation_id, customer_id, trigger_key) DO NOTHING
        `;
        if (gravadas === 0) continue;
        if (decisao.disparar) marcados += 1;
        else pulados += 1;
      }
    }

    return { marcados, pulados };
  });
}

export interface DisparoAEnviar {
  readonly id: string;
  readonly customerId: string;
  readonly tipo: TipoDeNotificacao;
  /**
   * Qual texto esta automação manda (bloco 94).
   *
   * Nulo é automação anterior ao bloco, que resolve por tipo como antes. Sem
   * isto, as onze automações possíveis saíam todas com a mesma frase, porque o
   * motor pegava o único aprovado do tipo.
   */
  readonly templateId: string | null;
  readonly telefone: string;
  readonly clienteNome: string;
  /** O nome da casa, que é como a mensagem se apresenta. */
  readonly barbearia: string;
}

/** O que está marcado, já venceu e ainda não saiu. */
export async function disparosAEnviar(
  tenantId: string,
  agora: Date,
  limite = 50,
): Promise<readonly DisparoAEnviar[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        customer_id: string;
        kind: TipoDeNotificacao;
        template_id: string | null;
        phone_e164: string;
        name: string;
        barbearia: string;
      }[]
    >`
      SELECT s.id, s.customer_id, a.kind::text AS kind, a.template_id, c.phone_e164, c.name,
             t.name AS barbearia
        FROM automation_sends s
        JOIN automations a ON a.id = s.automation_id
        JOIN customers c ON c.id = s.customer_id
        JOIN tenants t ON t.id = s.tenant_id
       WHERE s.sent_at IS NULL AND s.skipped_reason IS NULL
         AND s.scheduled_for <= ${agora}::timestamptz
         AND c.phone_e164 IS NOT NULL
       ORDER BY s.scheduled_for
       LIMIT ${limite}
    `;
    return linhas.map((l) => ({
      id: l.id,
      customerId: l.customer_id,
      tipo: l.kind,
      templateId: l.template_id,
      telefone: l.phone_e164,
      clienteNome: l.name,
      barbearia: l.barbearia,
    }));
  });
}

/**
 * Carimba o envio **antes** de a mensagem sair.
 *
 * É o precedente do bloco 54, e a razão é a mesma: carimbar depois perde o
 * carimbo se o processo cair, e a volta seguinte remanda. Entre repetir e não
 * mandar, o produto escolhe não mandar.
 *
 * O índice do dia é único no enviado, então esta gravação é também quem barra a
 * segunda automação do mesmo cliente no mesmo dia — inclusive contra outro
 * processo, que a leitura da varredura não alcançaria.
 */
export async function marcarDisparoEnviado(params: {
  readonly tenantId: string;
  readonly disparoId: string;
}): Promise<boolean> {
  /**
   * A regra do dia é conferida **na própria instrução**, e não por exceção.
   *
   * A primeira versão tentava carimbar e pegava a violação do índice único num
   * `catch` dentro da transação — e não funcionava: no Postgres a transação
   * aborta na violação, e toda instrução seguinte é recusada com "current
   * transaction is aborted". O `catch` existia e não conseguia gravar o motivo.
   *
   * Com o `NOT EXISTS`, o caso normal — duas automações do mesmo cliente na
   * mesma volta — não gera exceção nenhuma: o `UPDATE` simplesmente não pega
   * linha, e o motivo é gravado depois, em transação limpa.
   *
   * O índice único continua sendo a última linha de defesa, para dois processos
   * varrendo ao mesmo tempo. Aí a exceção sobe, e ela é tratada **fora** da
   * transação — que é o único lugar em que dá para tratá-la.
   */
  const carimbar = () =>
    withTenant(params.tenantId, async (tx) => {
      const afetadas = await tx.$executeRaw`
        UPDATE automation_sends AS s SET sent_at = now()
         WHERE s.id = ${params.disparoId}::uuid
           AND s.sent_at IS NULL
           AND s.skipped_reason IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM automation_sends outro
              WHERE outro.customer_id = s.customer_id
                AND outro.sent_at IS NOT NULL
                AND (outro.sent_at AT TIME ZONE 'UTC')::date = (now() AT TIME ZONE 'UTC')::date
           )
      `;
      return afetadas === 1;
    });

  let carimbou = false;
  try {
    carimbou = await carimbar();
  } catch {
    // Dois processos ao mesmo tempo: o índice único recusou. Não é erro — é a
    // regra funcionando entre processos.
    carimbou = false;
  }
  if (carimbou) return true;

  /**
   * Não carimbou: o motivo fica escrito para o balcão poder ler.
   *
   * Em transação própria, porque a anterior pode ter abortado. Guardado por
   * `sent_at IS NULL` para não sobrescrever um disparo que de fato saiu.
   */
  await withTenant(params.tenantId, async (tx) => {
    await tx.$executeRaw`
      UPDATE automation_sends SET skipped_reason = 'ja_recebeu_hoje'
       WHERE id = ${params.disparoId}::uuid AND sent_at IS NULL AND skipped_reason IS NULL
    `;
  });
  return false;
}

/**
 * A atribuição: este disparo produziu o que prometeu?
 *
 * Roda depois, sobre a janela declarada. O fato conta se aconteceu **depois** do
 * envio e **dentro** da janela — sem a primeira ponta, um agendamento feito
 * antes da mensagem seria creditado a ela; sem a segunda, a automação levaria
 * crédito por um corte de dois meses depois.
 *
 * `goal_met_at IS NULL` no `WHERE` faz a volta seguinte não reescrever o que já
 * foi atribuído: a data do primeiro fato é a que importa.
 */
export async function atribuirObjetivos(params: {
  readonly tenantId: string;
  readonly agora: Date;
}): Promise<number> {
  return withTenant(params.tenantId, async (tx) => {
    const pendentes = await tx.$queryRaw<
      { id: string; customer_id: string; sent_at: Date; goal: Objetivo; janela: number }[]
    >`
      SELECT s.id, s.customer_id, s.sent_at, a.goal::text AS goal, a.goal_window_days AS janela
        FROM automation_sends s
        JOIN automations a ON a.id = s.automation_id
       WHERE s.sent_at IS NOT NULL AND s.goal_met_at IS NULL
         AND s.sent_at > ${params.agora}::timestamptz - interval '120 days'
       LIMIT 500
    `;

    let atribuidos = 0;
    for (const disparo of pendentes) {
      const fatos =
        disparo.goal === 'agendamento'
          ? await tx.$queryRaw<{ id: string; em: Date }[]>`
              SELECT id, created_at AS em FROM appointments
               WHERE customer_id = ${disparo.customer_id}::uuid
                 AND created_at > ${disparo.sent_at}::timestamptz
               ORDER BY created_at LIMIT 1
            `
          : disparo.goal === 'venda'
            ? await tx.$queryRaw<{ id: string; em: Date }[]>`
                SELECT id, closed_at AS em FROM orders
                 WHERE customer_id = ${disparo.customer_id}::uuid
                   AND status = 'paid' AND closed_at > ${disparo.sent_at}::timestamptz
                 ORDER BY closed_at LIMIT 1
              `
            : await tx.$queryRaw<{ id: string; em: Date }[]>`
                SELECT id, created_at AS em FROM reviews
                 WHERE customer_id = ${disparo.customer_id}::uuid
                   AND created_at > ${disparo.sent_at}::timestamptz
                 ORDER BY created_at LIMIT 1
              `;

      const fato = fatos[0];
      if (!fato) continue;
      if (!objetivoAlcancado({ enviadaEm: disparo.sent_at, fatoEm: fato.em, janelaDias: disparo.janela })) {
        continue;
      }

      await tx.$executeRaw`
        UPDATE automation_sends
           SET goal_met_at = ${fato.em}, goal_ref = ${fato.id}::uuid
         WHERE id = ${disparo.id}::uuid AND goal_met_at IS NULL
      `;
      atribuidos += 1;
    }
    return atribuidos;
  });
}

/**
 * Liga ou desliga uma automação, e **nada mais**.
 *
 * ## Por que é porta própria, e não o formulário inteiro
 *
 * O botão da lista reenviava o objeto completo com `ativa` virado, e isso
 * amarrou o freio à validação de tudo o mais. Quando o bloco 88 fechou o tipo
 * da automação em `TIPOS_DE_CAMPANHA` — decisão certa, porque `lembrete_24h`
 * numa automação fura o opt-out de marketing e `senha_de_acesso` é credencial
 * —, as linhas criadas antes passaram a ser **impossíveis de desligar**: o
 * reenvio carregava o tipo antigo e a borda recusava com 400.
 *
 * Ou seja, exatamente as automações que mais precisavam ser caladas eram as
 * únicas que não calavam. A única saída era um `UPDATE` à mão no banco.
 *
 * Reproduzido em produção e no piloto: tipo `lembrete_24h` devolve
 * "Parâmetro inválido: tipo" e a linha continua ligada; tipo `retorno` desliga.
 *
 * Freio de emergência não se valida contra regra que entrou depois dele. Esta
 * função toca uma coluna só, e por isso nenhuma regra futura sobre o **conteúdo**
 * da automação pode voltar a trancar a saída.
 *
 * O filtro por id é o único: a RLS separa barbearias, e a linha ou é desta casa
 * ou não existe para ela.
 */
export async function definirAutomacaoAtiva(params: {
  readonly tenantId: string;
  readonly id: string;
  readonly ativa: boolean;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<{ readonly id: string; readonly ativa: boolean }> {
  return withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ id: string; active: boolean }[]>`
      UPDATE automations
         SET active = ${params.ativa}, updated_at = now()
       WHERE id = ${params.id}::uuid
      RETURNING id, active
    `;
    const linha = linhas[0];
    if (!linha) throw new AutomacaoError('invalida', 'Esta automação não existe.');

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'automation.changed',
      entity: 'automations',
      entityId: linha.id,
      after: { ativa: params.ativa },
    });

    return { id: linha.id, ativa: linha.active };
  });
}
