import { ehMotivoDeComissao } from '@barbearia/core';
import { semTenant, withTenant } from '@barbearia/db';
import {
  comissaoDoMarketplace,
  decidirAtribuicao,
  JANELA_DE_ATRIBUICAO_DIAS,
  TETO_DA_COMISSAO_BPS,
  type RecusaDaAtribuicao,
} from '@barbearia/core';
import { audit } from '@barbearia/identity';
import { PlataformaError, registrarNaTrilha } from './plataforma.js';

/**
 * A comissão do marketplace, do atendimento à fatura (bloco 72, SPEC §5.2).
 *
 * ## Varredura, e não gancho no fechamento do atendimento
 *
 * A atribuição podia nascer dentro da transação que marca o atendimento como
 * `completed` — é o que este repositório faz com quase todo fato. Aqui ela não
 * nasce, por duas razões escritas:
 *
 * 1. **A seta não pode voltar.** `packages/platform` passou a depender de
 *    `scheduling` no bloco 71, para rodar o motor em lote. Um gancho no
 *    fechamento faria `scheduling` precisar da alíquota, que mora em
 *    `tenant_platform` e é escrita só por `platform` — ciclo.
 * 2. **Aquele caminho não aceita exceção.** `fecharComanda` roda na transação
 *    do webhook do Pix, e uma exceção ali volta atrás com o dinheiro sem
 *    registro nenhum. Pendurar cálculo de comissão de plataforma nele é
 *    aumentar a superfície do caminho mais perigoso do produto por um número
 *    que só é cobrado no fim do mês.
 *
 * A defasagem é de um dia e não custa nada: a cobrança é mensal.
 */

export interface AtribuicaoPendente {
  readonly id: string;
  readonly customerId: string;
  readonly clienteNome: string;
  readonly appointmentId: string;
  readonly baseCents: number;
  readonly feeBps: number;
  readonly feeCents: number;
  readonly quando: Date;
  readonly status: 'pendente' | 'faturada' | 'cancelada';
}

interface Candidata {
  readonly appointment_id: string;
  readonly customer_id: string;
  readonly criado_em: Date;
  readonly cadastrado_em: Date;
  readonly veio_pela_busca: boolean;
  readonly primeiro_agendamento: boolean;
  readonly comanda_anterior: boolean;
  readonly base_cents: number;
  readonly atendido_em: Date;
}

/**
 * Grava as atribuições de uma barbearia.
 *
 * Devolve quantas foram criadas. Quem já tem linha não é recontado — o índice
 * único `(tenant_id, customer_id)` é a promessa da SPEC imposta pelo banco, e o
 * `ON CONFLICT DO NOTHING` respeita quem já decidiu, inclusive a linha que a
 * barbearia cancelou contestando.
 */
export async function atribuirDaBarbearia(tenantId: string, agora: Date): Promise<number> {
  const aliquota = await semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<{ bps: number }[]>`
      SELECT marketplace_fee_bps AS bps FROM tenant_platform
       WHERE tenant_id = ${tenantId}::uuid
    `;
    return Number(linhas[0]?.bps ?? 0);
  });

  // Alíquota zero é como toda barbearia nasce, e é a maioria: não vale abrir
  // transação nem varrer agenda para gravar uma linha de R$ 0,00.
  if (aliquota <= 0) return 0;

  const desde = new Date(agora.getTime() - 2 * JANELA_DE_ATRIBUICAO_DIAS * 86_400_000);

  return withTenant(tenantId, async (tx) => {
    /**
     * Uma consulta para o intervalo inteiro, com os três fatos que decidem.
     *
     * `primeiro_agendamento` e `comanda_anterior` saem de subconsultas
     * correlacionadas com `NOT EXISTS`, que param no primeiro achado — contar
     * tudo para depois comparar com zero é varrer o histórico inteiro de quem
     * corta ali há dez anos.
     *
     * O recorte de tempo é o dobro da janela: mais que isso é agenda que a
     * varredura de ontem já olhou, e menos deixaria de fora o atendimento
     * marcado com trinta dias de antecedência.
     */
    const candidatas = await tx.$queryRaw<Candidata[]>`
      SELECT a.id            AS appointment_id,
             a.customer_id,
             a.created_at    AS criado_em,
             c.created_at    AS cadastrado_em,
             a.source = 'marketplace' AS veio_pela_busca,
             -- Status rescheduled nao conta como agendamento anterior: remarcar e
             -- mover o mesmo compromisso, nao voltar mais uma vez. Sem esta
             -- linha, o balcao apagava a comissao remarcando o horario um
             -- minuto antes de conclui-lo — sem rastro, com uma permissao que
             -- a recepcao ja tem, e indistinguivel de trabalho legitimo.
             -- Historico de verdade continua contando: um agendamento antigo
             -- que foi remarcado tem sucessor, e o sucessor aparece aqui.
             NOT EXISTS (
               SELECT 1 FROM appointments anterior
                WHERE anterior.customer_id = a.customer_id
                  AND anterior.id <> a.id
                  AND anterior.status <> 'rescheduled'
                  AND anterior.created_at < a.created_at
             ) AS primeiro_agendamento,
             -- opened_at, e nao created_at: e quando a comanda foi aberta, que
             -- e o instante em que a pessoa estava na barbearia.
             EXISTS (
               SELECT 1 FROM orders o
                WHERE o.customer_id = a.customer_id
                  AND o.opened_at < a.created_at
             ) AS comanda_anterior,
             a.price_cents   AS base_cents,
             a.starts_at     AS atendido_em
        FROM appointments a
        JOIN customers c ON c.id = a.customer_id
       WHERE a.status = 'completed'
         AND a.source = 'marketplace'
         AND a.starts_at >= ${desde}
         AND NOT EXISTS (
           SELECT 1 FROM marketplace_attributions m WHERE m.customer_id = a.customer_id
         )
       ORDER BY a.starts_at
    `;

    let criadas = 0;
    for (const candidata of candidatas) {
      const decisao = decidirAtribuicao({
        criadoEm: candidata.criado_em,
        cadastradoEm: candidata.cadastrado_em,
        veioPelaBusca: candidata.veio_pela_busca,
        primeiroAgendamento: candidata.primeiro_agendamento,
        comandaAnterior: candidata.comanda_anterior,
      });
      if (!decisao.atribui) continue;

      const base = Number(candidata.base_cents ?? 0);
      const comissao = comissaoDoMarketplace({ baseCents: base, feeBps: aliquota });

      /**
       * A origem do cliente é carimbada junto, e só enquanto está nula.
       *
       * `acquired_via` é congelada por gatilho: escrevê-la aqui é o que faz a
       * coluna da SPEC §2.11 existir de verdade em vez de ser um campo que
       * ninguém preenche. Quem já tem origem não é tocado — a primeira resposta
       * é a que vale.
       */
      await tx.$executeRaw`
        UPDATE customers
           SET acquired_via = 'marketplace', acquired_at = ${candidata.criado_em}
         WHERE id = ${candidata.customer_id}::uuid AND acquired_via IS NULL
      `;

      const gravadas = await tx.$executeRaw`
        INSERT INTO marketplace_attributions
          (tenant_id, customer_id, appointment_id, base_cents, fee_bps, fee_cents, attributed_at)
        VALUES (
          NULLIF(current_setting('app.tenant_id', true), '')::uuid,
          ${candidata.customer_id}::uuid, ${candidata.appointment_id}::uuid,
          ${base}, ${aliquota}, ${comissao}, ${candidata.atendido_em}
        )
        ON CONFLICT (tenant_id, customer_id) DO NOTHING
      `;
      criadas += gravadas;
    }

    return criadas;
  });
}

/** Prazo da fatura de comissão, em dias. O mesmo da mensalidade. */
const DIAS_DE_PRAZO = 5;

/** Piso do motivo escrito da contestação. O mesmo do override do score. */
const MOTIVO_MINIMO = 10;

/**
 * O mês fechado anterior a `agora`, em UTC.
 *
 * A comissão é cobrada **por mês de calendário**, e não no aniversário da
 * adesão como a mensalidade. As duas coisas não são o mesmo fato: o ciclo da
 * assinatura existe para não dar meio mês de graça a quem assina no dia 28, e
 * aqui não há nada proporcional — são atendimentos que aconteceram em datas
 * conhecidas. O mês de calendário é também o que a barbearia consegue conferir
 * contra a própria agenda sem fazer conta.
 */
function mesFechado(agora: Date): { readonly inicio: Date; readonly fim: Date } {
  const fim = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 1));
  const inicio = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() - 1, 1));
  return { inicio, fim };
}

/**
 * Emite a fatura de comissão do mês fechado, se houver o que cobrar.
 *
 * Documento **próprio**, nunca somado à mensalidade: uma fatura de assinatura
 * dizendo R$ 258,00 sobre um plano de R$ 199,00 obriga a barbearia a acreditar
 * na diferença. Aqui ela abre a lista e confere cliente por cliente — que é o
 * discurso de venda inteiro do bloco.
 *
 * As linhas são marcadas como faturadas **na mesma transação** que cria a
 * fatura. Marcar depois abriria a janela em que a barbearia foi cobrada e as
 * linhas continuam pendentes: a emissão do mês seguinte as cobraria de novo.
 */
export async function emitirComissaoDoMarketplace(entrada: {
  readonly tenantId: string;
  readonly agora: Date;
}): Promise<{ readonly invoiceId: string; readonly valorCents: number } | null> {
  const { inicio, fim } = mesFechado(entrada.agora);
  const vencimento = new Date(entrada.agora.getTime() + DIAS_DE_PRAZO * 86_400_000);

  /**
   * Três passos, e a divisão é imposta pela política de `invoices`.
   *
   * Fatura só se escreve **sem tenant** desde o bloco 30: *"uma barbearia que
   * pudesse escrever aqui se daria baixa sozinha"*. As atribuições, ao
   * contrário, têm RLS de tenant, porque carregam `customer_id`. As duas coisas
   * não cabem na mesma transação, e forçar a mistura seria afrouxar uma das
   * políticas por conveniência de código.
   *
   * O que substitui a atomicidade é a **reentrância**: se o processo cair entre
   * o segundo e o terceiro passo, a fatura existe e as linhas continuam
   * pendentes — e a volta seguinte encontra a fatura já emitida, não cria a
   * segunda, e marca as linhas que faltavam. É o mesmo desenho da régua, que
   * roda a cada volta do laço de propósito.
   */
  /**
   * **Todo pendente já vencido**, e não a janela do mês passado.
   *
   * A janela parecia igual e não era. `attributed_at` é a data do
   * **atendimento**, e a varredura roda todo dia: a atribuição de julho nasce
   * no dia 2 de agosto, quando o balcão conclui os atendimentos do fim do mês.
   * Ela caía na janela de julho, encontrava a fatura de julho já emitida no dia
   * 1º e era carimbada `faturada` contra um valor que nunca a incluiu.
   *
   * Comissão que ninguém cobra e que os dois lados veem como paga — a
   * barbearia lê "Faturada" no extrato dela, a plataforma lê a fatura fechada,
   * e ninguém investiga. O `UPDATE` por id, escrito para consertar isto, fecha
   * a corrida **dentro** de uma execução; entre execuções ela continuava.
   *
   * `reverterContestacao` produzia o espelho: ela devolve a linha para
   * `pendente` mantendo o `attributed_at` antigo, e num mês posterior essa
   * linha nunca mais caía na janela de emissão nenhuma — pendente para sempre,
   * contando no "Total pendente" da tela e nunca virando fatura.
   *
   * Sem a ponta de baixo, as duas somem: o que está pendente e pertence a um
   * mês já encerrado entra na emissão desta volta. A linha carrega a própria
   * data, então a lista que a barbearia confere continua explicando cada uma.
   */
  const somadas = await withTenant(entrada.tenantId, async (tx) =>
    tx.$queryRaw<{ id: string; fee_cents: number }[]>`
      SELECT id, fee_cents
        FROM marketplace_attributions
       WHERE status = 'pendente' AND attributed_at < ${fim}
    `,
  );
  const total = somadas.reduce((soma, l) => soma + Number(l.fee_cents), 0);

  // Nada a cobrar não vira fatura de R$ 0,00: é um documento que não se paga e
  // que a régua persegue até bloquear uma barbearia que não deve nada.
  if (total <= 0) return null;

  const fatura = await semTenant(async (tx) => {
    const planos = await tx.$queryRaw<{ plan_code: string }[]>`
      SELECT plan_code FROM subscriptions WHERE tenant_id = ${entrada.tenantId}::uuid
    `;
    const planCode = planos[0]?.plan_code;
    if (!planCode) return null;

    await tx.$executeRaw`
      INSERT INTO invoices (tenant_id, kind, plan_code, amount_cents,
                            period_start, period_end, due_at)
      VALUES (${entrada.tenantId}::uuid, 'marketplace', ${planCode}, ${total},
              ${inicio}, ${fim}, ${vencimento})
      ON CONFLICT (tenant_id, period_start) WHERE kind = 'marketplace' DO NOTHING
    `;

    /**
     * Lida depois do `INSERT`, e não devolvida por ele.
     *
     * `ON CONFLICT DO NOTHING` não devolve linha quando não insere, e é
     * justamente o caso da volta que precisa consertar o passo perdido: sem
     * este `SELECT`, as linhas ficariam pendentes para sempre e o mês seguinte
     * as cobraria de novo.
     */
    const linhas = await tx.$queryRaw<{ id: string; amount_cents: number }[]>`
      SELECT id, amount_cents FROM invoices
       WHERE tenant_id = ${entrada.tenantId}::uuid
         AND kind = 'marketplace' AND period_start = ${inicio}
    `;
    return linhas[0] ?? null;
  });

  if (!fatura) return null;

  /**
   * Marca **exatamente** as linhas que entraram na soma, por id.
   *
   * Marcar pela janela de datas parecia igual e não é: uma atribuição de julho
   * pode nascer no dia 2 de agosto, quando o balcão conclui os atendimentos do
   * fim do mês. Pela janela, ela seria carimbada como faturada contra uma
   * fatura cujo valor nunca a incluiu — comissão que ninguém cobra e que os
   * dois lados veem como paga, então ninguém investiga. Por id, ela fica
   * pendente e entra na emissão seguinte. Achado da `/security-review` deste
   * bloco.
   */
  /**
   * A fatura que já existia só recebe carimbo se **a conta bate**.
   *
   * `ON CONFLICT DO NOTHING` esconde a diferença entre dois casos que precisam
   * de respostas opostas:
   *
   * - **A volta que conserta o passo perdido.** O processo caiu entre criar a
   *   fatura e marcar as linhas: a fatura vale exatamente o que está pendente,
   *   e marcar é o certo.
   * - **A linha que chegou depois.** A fatura foi emitida ontem com R$ 5,00 e
   *   hoje há R$ 14,00 pendentes: marcar carimbaria R$ 9,00 contra um documento
   *   que não os contém, e ninguém cobraria nunca.
   *
   * A conta que distingue os dois é **o que já está anexado mais o que se quer
   * anexar**, contra o valor da fatura. Comparar só o pendente com o valor
   * seria enganado pelo caso em que as duas somas coincidem por acaso — duas
   * comissões do mesmo ticket dão o mesmo número, e foi assim que a primeira
   * versão desta guarda passou verde no teste que a cobra.
   *
   * Não batendo, as linhas ficam pendentes e entram na emissão do período
   * seguinte — carregando a própria data, que é o que a lista mostra à
   * barbearia.
   */
  const jaAnexado = await withTenant(entrada.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ soma: bigint }[]>`
      SELECT coalesce(sum(fee_cents), 0)::bigint AS soma
        FROM marketplace_attributions
       WHERE invoice_id = ${fatura.id}::uuid
    `;
    return Number(linhas[0]?.soma ?? 0);
  });
  if (jaAnexado + total !== Number(fatura.amount_cents)) return null;

  const ids = somadas.map((l) => l.id);
  const marcadas = await withTenant(entrada.tenantId, async (tx) =>
    tx.$executeRaw`
      UPDATE marketplace_attributions
         SET status = 'faturada', invoice_id = ${fatura.id}::uuid
       WHERE status = 'pendente' AND id = ANY(${ids}::uuid[])
    `,
  );

  // Zero marcadas é a volta que já tinha feito tudo: a fatura existe e as
  // linhas já estavam faturadas. Não é emissão nova.
  if (marcadas === 0) return null;
  return { invoiceId: fatura.id, valorCents: Number(fatura.amount_cents) };
}

/**
 * A plataforma define a alíquota de uma barbearia.
 *
 * `tenant_platform` e não `tenants`: é termo comercial **do produto**, e numa
 * coluna da barbearia a rota do painel dela deixaria o cliente definir o preço
 * que paga — zerá-la desligaria a receita sem nada falhar. Achado da
 * `/security-review` do bloco 49, e a razão de esta função morar aqui.
 *
 * A gravação passa pela trilha da plataforma, como toda ação de `operator`:
 * mudar quanto uma barbearia paga é decisão que precisa de autor e data.
 */
export async function definirComissaoDoMarketplace(entrada: {
  readonly adminId: string;
  readonly tenantId: string;
  readonly feeBps: number;
}): Promise<void> {
  if (!Number.isInteger(entrada.feeBps) || entrada.feeBps < 0 || entrada.feeBps > TETO_DA_COMISSAO_BPS) {
    throw new PlataformaError('invalid_fee', 'Alíquota fora da faixa permitida');
  }

  await semTenant(async (tx) => {
    const mudadas = await tx.$executeRaw`
      UPDATE tenant_platform SET marketplace_fee_bps = ${entrada.feeBps}
       WHERE tenant_id = ${entrada.tenantId}::uuid
    `;
    if (mudadas === 0) throw new PlataformaError('unknown_tenant', 'Barbearia não encontrada');

    await registrarNaTrilha(tx, entrada.adminId, entrada.tenantId, 'marketplace.fee_changed', {
      feeBps: entrada.feeBps,
    });
  });
}

/**
 * O que o marketplace trouxe para esta barbearia.
 *
 * Lida `withTenant` porque a tabela tem RLS e carrega `customer_id`: é a lista
 * de **quem** a plataforma diz ter trazido, e a barbearia precisa ver nome por
 * nome para poder discordar. Um total sem nomes seria uma cobrança que não se
 * confere.
 */
export async function atribuicoesDaBarbearia(
  tenantId: string,
): Promise<readonly AtribuicaoPendente[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        customer_id: string;
        nome: string;
        appointment_id: string;
        base_cents: number;
        fee_bps: number;
        fee_cents: number;
        attributed_at: Date;
        status: 'pendente' | 'faturada' | 'cancelada';
      }[]
    >`
      SELECT m.id, m.customer_id, c.name AS nome, m.appointment_id,
             m.base_cents, m.fee_bps, m.fee_cents, m.attributed_at, m.status::text AS status
        FROM marketplace_attributions m
        JOIN customers c ON c.id = m.customer_id
       ORDER BY m.attributed_at DESC
       LIMIT 200
    `;
    return linhas.map((l) => ({
      id: l.id,
      customerId: l.customer_id,
      clienteNome: l.nome,
      appointmentId: l.appointment_id,
      baseCents: Number(l.base_cents),
      feeBps: Number(l.fee_bps),
      feeCents: Number(l.fee_cents),
      quando: l.attributed_at,
      status: l.status,
    }));
  });
}

/**
 * O total pendente, sem teto de leitura.
 *
 * A lista da tela tem `LIMIT`, e somar sobre ela daria um total menor que o da
 * fatura assim que a barbearia passasse de duzentos clientes novos — a tela
 * prometendo um valor e a cobrança mandando outro.
 */
export async function pendenteDoMarketplace(tenantId: string): Promise<number> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ total: number | null }[]>`
      SELECT sum(fee_cents)::int AS total
        FROM marketplace_attributions WHERE status = 'pendente'
    `;
    return Number(linhas[0]?.total ?? 0);
  });
}

/**
 * A barbearia contesta uma linha.
 *
 * Cancelar é **estado**, nunca `DELETE` — a tabela nem tem a permissão. O que a
 * casa contesta precisa continuar existindo para a conversa ter documento, e a
 * linha cancelada continua ocupando o índice único: aquele cliente não volta a
 * gerar comissão numa varredura seguinte.
 *
 * Só o que ainda não foi faturado. Depois da fatura emitida o caminho é o
 * cancelamento da fatura, que já existe desde o bloco 30 e tem trilha própria —
 * mexer aqui deixaria a fatura cobrando um valor que a soma das linhas não
 * explica mais.
 */
export async function contestarAtribuicao(entrada: {
  readonly tenantId: string;
  readonly staffUserId: string;
  readonly staffNome: string;
  readonly atribuicaoId: string;
  /** A categoria, de lista fechada. É a única coisa que a plataforma lê. */
  readonly categoria: string;
  readonly motivo: string;
}): Promise<boolean> {
  if (!ehMotivoDeComissao(entrada.categoria)) {
    throw new PlataformaError('missing_reason', 'Escolha um dos motivos da lista');
  }
  const motivo = entrada.motivo.trim();
  /**
   * Piso na borda, no domínio e por `CHECK`, como o override do score.
   *
   * Contestar reduz o que a plataforma recebe e o efeito é **permanente** — o
   * índice único faz aquele cliente nunca mais gerar comissão. Sem motivo
   * escrito, um laço de cliques sobre a lista é evasão de cem por cento da
   * receita, e nada distingue isso de uma discordância legítima. Achado da
   * `/security-review` deste bloco.
   */
  if (motivo.length < MOTIVO_MINIMO) {
    throw new PlataformaError('missing_reason', 'Escreva o motivo da contestação');
  }

  return withTenant(entrada.tenantId, async (tx) => {
    const mudadas = await tx.$executeRaw`
      UPDATE marketplace_attributions
         SET status = 'cancelada',
             contest_reason = ${entrada.categoria}::attribution_contest_reason,
             contested_reason = ${motivo}
       WHERE id = ${entrada.atribuicaoId}::uuid AND status = 'pendente'
    `;
    if (mudadas !== 1) return false;

    /**
     * Auditada **dentro da transação** que muda o estado, como toda trilha
     * deste produto.
     *
     * A **categoria** entra; a nota escrita, não. Ela é texto sobre um cliente,
     * e `audit_log` é append-only, fora do alcance da anonimização e fora da
     * exportação do titular — o pior destino possível para dado pessoal.
     */
    await audit(tx, {
      actorId: entrada.staffUserId,
      actorName: entrada.staffNome,
      action: 'marketplace.attribution_contested',
      entity: 'marketplace_attribution',
      entityId: entrada.atribuicaoId,
      after: { categoria: entrada.categoria, caracteresDoMotivo: motivo.length },
    });
    return true;
  });
}

export type { RecusaDaAtribuicao };

// ---------------------------------------------------------------------------
// A plataforma revisa o que a barbearia contestou (bloco 75)
// ---------------------------------------------------------------------------

export interface ContestacaoNaPlataforma {
  readonly id: string;
  readonly tenantId: string;
  readonly barbearia: string;
  readonly motivo: string | null;
  readonly baseCents: number;
  readonly feeCents: number;
  readonly quando: Date;
}

/**
 * As contestações, para o outro lado do contrato poder olhar.
 *
 * Lida `semTenant` — a política de `marketplace_attributions` tem o ramo do
 * `IS NULL` desde o bloco 72, e foi acrescentado justamente porque sem ele a
 * plataforma enxergava zero linhas: uma tabela em que só um dos lados vê o
 * próprio contrato não é isolamento, é cegueira.
 *
 * O nome do **cliente** não sai. A barbearia precisa dele para conferir a
 * conta; a plataforma não — para ela a pergunta é "esta renúncia se explica?",
 * e o que responde isso é o motivo escrito, não quem é a pessoa.
 */
export async function contestacoesNaPlataforma(): Promise<readonly ContestacaoNaPlataforma[]> {
  return semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        tenant_id: string;
        nome: string;
        contest_reason: string | null;
        base_cents: number;
        fee_cents: number;
        attributed_at: Date;
      }[]
    >`
      -- contest_reason (a categoria), nunca contested_reason (a nota).
      -- A segunda é texto que o balcão escreve sobre um cliente, e a plataforma
      -- é operadora — não responde por dado que não é dela.
      SELECT a.id, a.tenant_id, t.name AS nome, a.contest_reason,
             a.base_cents, a.fee_cents, a.attributed_at
        FROM marketplace_attributions a
        -- tenant_platform e nao tenants: aquela tem RLS estrita, e esta leitura
        -- roda sem tenant no contexto. O espelho do nome existe ali desde o
        -- bloco 21 exatamente para o painel da plataforma poder ler.
        JOIN tenant_platform t ON t.tenant_id = a.tenant_id
       WHERE a.status = 'cancelada'
       ORDER BY a.attributed_at DESC
       LIMIT 200
    `;
    return linhas.map((l) => ({
      id: l.id,
      tenantId: l.tenant_id,
      barbearia: l.nome,
      motivo: l.contest_reason,
      baseCents: Number(l.base_cents),
      feeCents: Number(l.fee_cents),
      quando: l.attributed_at,
    }));
  });
}

/**
 * A plataforma reverte uma contestação indevida.
 *
 * Fecha a lacuna do bloco 72: a renúncia era **definitiva** do lado da
 * barbearia, porque o índice único faz aquele cliente nunca mais gerar
 * comissão. Sem esta rota, uma contestação errada — ou de má-fé — não tinha
 * conserto, e o freio era só o motivo escrito.
 *
 * Volta para `pendente`, nunca para `faturada`: a linha entra na emissão do mês
 * seguinte pelo caminho normal, e forçá-la a faturada apontaria para uma fatura
 * cujo valor nunca a incluiu — o defeito que a revisão do bloco 72 achou.
 *
 * O motivo escrito é exigido dos dois lados. Quem contesta explica; quem
 * reverte também, e a trilha guarda os dois: é uma cobrança de volta, e uma
 * cobrança de volta sem explicação é o que gera a ligação para o suporte.
 */
export async function reverterContestacao(entrada: {
  readonly adminId: string;
  readonly atribuicaoId: string;
  readonly motivo: string;
}): Promise<void> {
  const motivo = entrada.motivo.trim();
  if (motivo.length < MOTIVO_MINIMO) {
    throw new PlataformaError('missing_reason', 'Escreva o motivo da reversão');
  }

  await semTenant(async (tx) => {
    /**
     * `contested_reason` fica, e é de propósito.
     *
     * O que a barbearia escreveu é a metade dela da conversa; apagar ao
     * reverter deixaria o registro contando só o lado de quem reverteu. A
     * trilha guarda a outra metade.
     */
    const linhas = await tx.$queryRaw<{ tenant_id: string }[]>`
      UPDATE marketplace_attributions
         SET status = 'pendente'
       WHERE id = ${entrada.atribuicaoId}::uuid AND status = 'cancelada'
      RETURNING tenant_id
    `;
    const linha = linhas[0];
    if (!linha) {
      throw new PlataformaError('unknown_attribution', 'Contestação não encontrada ou já revertida');
    }

    await registrarNaTrilha(
      tx,
      entrada.adminId,
      linha.tenant_id,
      'marketplace.contestation_reverted',
      { motivo },
    );
  });
}
