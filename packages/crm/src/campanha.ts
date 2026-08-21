import { withTenant } from '@barbearia/db';
import {
  campanhaParada,
  decidirDisparo,
  FILTROS_DE_CAMPANHA,
  ROTULO_DO_FILTRO,
  SEGMENTO_DO_FILTRO,
  TIPOS_DE_CAMPANHA,
  TIPOS_PROMOCIONAIS,
  tipoDeCampanhaValido,
  type EstadoDeCampanha,
  type FiltroDeCampanha,
  type Segmento,
  type TipoDeNotificacao,
} from '@barbearia/core';
import { audit } from '@barbearia/identity';
import { enfileirarPara } from '@barbearia/jobs';
import { churnDaBase } from './churn.js';
import { segmentosDaBase } from './segmento.js';

/**
 * Campanhas (bloco 57, SPEC §4.13).
 *
 * > *"Toda campanha reporta: enviados · entregues · lidos · cliques ·
 * > agendamentos gerados · receita atribuída. A última coluna é a única que
 * > importa."*
 *
 * ## O público é congelado na criação
 *
 * `campaign_targets` guarda **quem entrou**, não o filtro. Guardar o filtro
 * faria "quantos receberam" mudar toda vez que alguém fosse cadastrado — e a
 * receita atribuída, que é lida contra esse conjunto, mudaria junto. O filtro é
 * como se chegou ao público; o público é o fato.
 *
 * ## As proteções são as mesmas da automação
 *
 * Teto, opt-out, janela de silêncio e um-por-dia moram em `packages/core` desde
 * o bloco 20 e são **chamados** aqui, nunca reescritos. Uma campanha que
 * ignorasse o teto porque "foi o dono que mandou" seria a porta pela qual o
 * número da barbearia queima.
 */

/**
 * O vocabulário mora em `packages/core` desde o bloco 61 — aqui só se reexporta.
 *
 * Ele estava escrito duas vezes, aqui e dentro da tela de campanhas, e o bloco
 * que acrescentou três públicos teria deixado a tela oferecendo quatro com a API
 * aceitando sete. `FILTROS` continua com o nome antigo porque é o que a borda da
 * API importa para montar o `z.enum`.
 */
export const FILTROS = FILTROS_DE_CAMPANHA;
export type { FiltroDeCampanha };
export { ROTULO_DO_FILTRO };

/**
 * O segmento por trás do filtro, quando existe.
 *
 * O segmento depende da base inteira — "frequente" é ciclo abaixo da mediana
 * dela, "VIP" é o topo do decil de gasto — e a mediana de uma base não cabe numa
 * cláusula `WHERE` sobre uma linha. Escrevê-la em SQL seria regra de negócio na
 * consulta, onde o teste não alcança, e é a mesma razão de o ciclo ser calculado
 * em `packages/core`.
 */
function segmentoDoFiltro(filtro: FiltroDeCampanha): Segmento | null {
  return SEGMENTO_DO_FILTRO[filtro] ?? null;
}

export type CampanhaFailure = 'nao_encontrada' | 'invalida' | 'ja_enviada';

export class CampanhaError extends Error {
  constructor(
    readonly code: CampanhaFailure,
    message: string,
  ) {
    super(message);
    this.name = 'CampanhaError';
  }
}

export interface CampanhaNaTela {
  readonly id: string;
  readonly nome: string;
  readonly filtro: FiltroDeCampanha;
  readonly valorDoFiltro: number | null;
  readonly diaDaSemana: number | null;
  readonly tipo: TipoDeNotificacao;
  /**
   * O nome do texto que esta campanha manda (bloco 96).
   *
   * Nulo é campanha anterior ao bloco, que resolve por tipo. A lista dizia só
   * "Convite de retorno" — o nome do **tipo** — com três convites de retorno
   * diferentes cadastrados, e quem abre a tela para conferir o que saiu não
   * tinha como saber qual dos três foi.
   */
  readonly textoTitulo: string | null;
  readonly estado: 'rascunho' | 'enviando' | 'enviada';
  readonly criadaEm: string;
  /**
   * O disparo mais recente, ou a criação quando nada saiu.
   *
   * É o que `campanhaParada` compara com o relógio: `campaigns` não tem
   * `updated_at`, e uma coluna nova diria a mesma coisa que este `max` já diz.
   */
  readonly ultimoMovimentoEm: string;
  /** As seis colunas da SPEC §4.13. A última é a que importa. */
  readonly publico: number;
  readonly enviados: number;
  readonly entregues: number;
  readonly lidos: number;
  readonly cliques: number;
  readonly agendamentos: number;
  /**
   * Nulo para quem não pode ver receita (`finance.view`).
   *
   * Redigir e não recusar: o número atribuído é a única coisa financeira desta
   * lista, e somá-lo ao `@Exige` trancava a tela inteira para um papel
   * "Marketing" que criava e enviava campanha e não conseguia **ver** a que
   * enviou — estado sem saída na interface, criado por uma permissão que
   * protege uma coluna só.
   */
  readonly receitaCents: number | null;
  /**
   * Quantos saíram **pelo WhatsApp**, e não pelo canal de reserva (bloco 97).
   *
   * `enviarPeloWhatsApp` devolve nulo quando não há canal ligado — SPEC §4.12:
   * canal indisponível não lança, cai para o outro caminho —, e o alvo é
   * carimbado assim mesmo. A campanha aparecia verde, com "27 enviados", e
   * nada tinha chegado a ninguém.
   *
   * É a regra do número que ignora parte do dado: ele sai completo, com cara
   * de completo, e o dono decide em cima dele.
   */
  readonly enviadosPeloWhatsApp: number;
  /** Quantos foram pulados, por motivo. Vazio quando ninguém foi pulado. */
  readonly pulados: readonly { readonly motivo: string; readonly quantos: number }[];
}

/**
 * Uma pessoa que **não** recebeu, com o motivo (bloco 97).
 *
 * O motivo de cada pulo é gravado desde o bloco 20 e a tela mostrava só a
 * contagem: o dono lia "3 enviados · 27 pulados" e não tinha como saber quem
 * nem por quê sem ir ao banco. Dado que existe e ninguém lê é a §6 pergunta 4.
 */
export interface PuladoDaCampanha {
  readonly customerId: string;
  readonly nome: string;
  readonly motivo: string;
}

/**
 * A lista, com as seis colunas numa consulta só.
 *
 * Agregação e não laço: uma ida ao banco por campanha para contar entregues
 * seria o N+1 que a regra proíbe. `whatsapp_messages` entra por `LEFT JOIN`
 * porque entregue e lido são fato **da Meta**, e não nosso — quem os grava é o
 * webhook do bloco 55.
 */
export async function campanhasDaCasa(params: {
  readonly tenantId: string;
  /**
   * Quem chama pode ver receita (`finance.view`) — obrigatório, não opcional.
   *
   * Opcional, ele seria esquecido no primeiro chamador novo e a receita sairia
   * para quem a barbearia decidiu não dar, sem nada ficar vermelho.
   */
  readonly podeVerReceita: boolean;
}): Promise<readonly CampanhaNaTela[]> {
  return withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        name: string;
        filter: FiltroDeCampanha;
        filter_value: number | null;
        filter_weekday: number | null;
        kind: TipoDeNotificacao;
        texto_titulo: string | null;
        status: 'rascunho' | 'enviando' | 'enviada';
        created_at: Date;
        ultimo_movimento: Date;
        publico: bigint;
        enviados: bigint;
        entregues: bigint;
        lidos: bigint;
        cliques: bigint;
        agendamentos: bigint;
        receita: bigint | null;
        pelo_whatsapp: bigint;
        pulados: readonly { motivo: string; quantos: number }[] | null;
      }[]
    >`
      SELECT c.id, c.name, c.filter::text AS filter, c.filter_value, c.filter_weekday,
             c.kind::text AS kind, w.titulo AS texto_titulo,
             c.status::text AS status, c.created_at,
             COALESCE(max(t.sent_at), c.created_at) AS ultimo_movimento,
             count(t.id) AS publico,
             count(t.id) FILTER (WHERE t.sent_at IS NOT NULL) AS enviados,
             count(t.id) FILTER (WHERE m.delivered_at IS NOT NULL) AS entregues,
             count(t.id) FILTER (WHERE m.read_at IS NOT NULL) AS lidos,
             count(t.id) FILTER (WHERE t.clicked_at IS NOT NULL) AS cliques,
             count(t.id) FILTER (WHERE t.goal_met_at IS NOT NULL) AS agendamentos,
             COALESCE(sum(t.goal_amount_cents), 0) AS receita,
             -- Enviado **pelo WhatsApp** é o que tem wamid: sem canal ligado o
             -- alvo é carimbado do mesmo jeito e nada chega a ninguém.
             count(t.id) FILTER (WHERE t.wamid IS NOT NULL) AS pelo_whatsapp,
             COALESCE(mot.motivos, '[]'::jsonb) AS pulados
        FROM campaigns c
        LEFT JOIN campaign_targets t ON t.campaign_id = c.id
        LEFT JOIN whatsapp_messages m ON m.wamid = t.wamid
        LEFT JOIN whatsapp_templates w ON w.id = c.template_id
        -- Os motivos por campanha, dentro da **mesma** consulta: uma ida ao
        -- banco por linha da lista seria o N+1 que a regra proíbe.
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(jsonb_build_object('motivo', p.motivo, 'quantos', p.quantos)
                             ORDER BY p.quantos DESC, p.motivo) AS motivos
            FROM (SELECT ct.skipped_reason AS motivo, count(*)::int AS quantos
                    FROM campaign_targets ct
                   WHERE ct.campaign_id = c.id AND ct.skipped_reason IS NOT NULL
                   GROUP BY ct.skipped_reason) p
        ) mot ON true
       GROUP BY c.id, w.titulo, mot.motivos
       ORDER BY c.created_at DESC
    `;
    return linhas.map((l) => ({
      id: l.id,
      nome: l.name,
      filtro: l.filter,
      valorDoFiltro: l.filter_value,
      diaDaSemana: l.filter_weekday,
      tipo: l.kind,
      textoTitulo: l.texto_titulo,
      estado: l.status,
      criadaEm: l.created_at.toISOString(),
      ultimoMovimentoEm: l.ultimo_movimento.toISOString(),
      publico: Number(l.publico),
      enviados: Number(l.enviados),
      entregues: Number(l.entregues),
      lidos: Number(l.lidos),
      cliques: Number(l.cliques),
      agendamentos: Number(l.agendamentos),
      receitaCents: params.podeVerReceita ? Number(l.receita ?? 0) : null,
      enviadosPeloWhatsApp: Number(l.pelo_whatsapp),
      pulados: l.pulados ?? [],
    }));
  });
}

/**
 * Quem não recebeu, com o nome e o motivo (bloco 97).
 *
 * A contagem já vem na lista; o que faltava era **agir sobre ela**. "Vinte e
 * sete pulados" sem nomes obriga o dono a abrir a base e procurar um por um, e
 * é a lista que ninguém abre duas vezes.
 *
 * Curta de propósito: quem precisa falar com todos usa a campanha, que é o
 * botão ao lado. O teto é dito na tela, como manda a regra do limite de itens.
 *
 * Ordenada por motivo e nome para a lista não trocar de ordem entre dois
 * carregamentos — empate desempatado por campo estável, nunca pela consulta.
 */
export async function puladosDaCampanha(
  tenantId: string,
  campanhaId: string,
  limite = 50,
): Promise<readonly PuladoDaCampanha[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      { customer_id: string; nome: string | null; motivo: string }[]
    >`
      SELECT t.customer_id, c.name AS nome, t.skipped_reason AS motivo
        FROM campaign_targets t
        JOIN customers c ON c.id = t.customer_id
       WHERE t.campaign_id = ${campanhaId}::uuid AND t.skipped_reason IS NOT NULL
       ORDER BY t.skipped_reason, c.name
       LIMIT ${limite}
    `;
    return linhas.map((l) => ({
      customerId: l.customer_id,
      nome: l.nome ?? 'sem nome',
      motivo: l.motivo,
    }));
  });
}

/**
 * Cria a campanha e **congela o público** na mesma transação.
 *
 * As duas coisas juntas porque separá-las cria o estado em que a campanha
 * existe sem público — e é nele que alguém aperta "enviar" e não acontece nada,
 * sem erro. O filtro roda uma vez; depois disso o público é o que está gravado.
 */
export async function criarCampanha(params: {
  readonly tenantId: string;
  readonly nome: string;
  readonly filtro: FiltroDeCampanha;
  readonly valorDoFiltro: number | null;
  readonly diaDaSemana: number | null;
  /**
   * O tipo, quando não há texto escolhido.
   *
   * Opcional desde o bloco 96 e é o par de `templateId`: quem escolhe o texto
   * já disse o tipo, porque o texto tem um. Exigir os dois seria pedir duas
   * vezes a mesma coisa e aceitar que as respostas divirjam.
   */
  readonly tipo?: TipoDeNotificacao;
  /**
   * Qual texto esta campanha manda (bloco 96).
   *
   * A automação passou a escolher no bloco 94 e a campanha ficou para trás,
   * ainda resolvendo por **tipo** — e o motor pega o primeiro aprovado daquele
   * tipo com `LIMIT 1`. Com três textos de convite de retorno cadastrados, a
   * campanha para "quem costuma vir naquele horário" saía com "seu pacote está
   * acabando", para gente que nunca comprou pacote.
   *
   * O pior formato de defeito que este produto pode ter: a tela mostrava a
   * prévia de um texto, o motor mandava outro, e o único jeito de descobrir era
   * o cliente responder "que pacote?".
   *
   * Congelado como o público: trocar o texto depois não reescreve o que já saiu.
   */
  readonly templateId?: string | null;
  readonly janelaDias: number;
  readonly agora: Date;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<{ readonly id: string; readonly publico: number }> {
  if (params.nome.trim().length === 0) {
    throw new CampanhaError('invalida', 'Dê um nome para a campanha.');
  }
  if (params.filtro === 'celula_fria' && (params.diaDaSemana === null || params.valorDoFiltro === null)) {
    throw new CampanhaError('invalida', 'A célula precisa de dia e hora.');
  }
  /**
   * "Quem sumiu" sem número não é a base inteira — é recusa.
   *
   * O campo chegava vazio e virava zero na consulta, e "quem não vem há zero
   * dias" **é todo mundo**: a campanha ia para a base inteira, com o público
   * congelado, sem nada ter falhado e sem como desfazer. O jeito de descobrir
   * era a conta da mensagem no fim do mês.
   *
   * `celula_fria` já recusava por dia e hora desde o bloco 82; este é o outro
   * público que pede número, e ficou de fora.
   */
  if (params.filtro === 'inativos' && params.valorDoFiltro === null) {
    throw new CampanhaError('invalida', 'Diga a partir de quantos dias sem vir.');
  }
  /**
   * O tipo é conferido **aqui também**, e não só no schema da borda.
   *
   * A borda garante forma; que uma campanha só pode usar texto de campanha é
   * regra de domínio. Sem esta linha, qualquer segundo chamador — uma rota
   * nova, a API pública, um script — criaria a campanha com `senha_de_acesso`,
   * que é credencial, ou com `lembrete_24h`, que promete um horário que não
   * existe.
   */
  if (params.tipo !== undefined && !tipoDeCampanhaValido(params.tipo)) {
    throw new CampanhaError('invalida', 'Este texto não serve para campanha.');
  }

  return withTenant(params.tenantId, async (tx) => {
    /**
     * O tipo sai do texto escolhido, conferido sob RLS antes de gravar.
     *
     * A checagem de integridade referencial do Postgres ignora row security: a
     * chave estrangeira aceitaria o texto de outra barbearia sem reclamar. E o
     * tipo tem que vir dele, não de um campo ao lado — separados, a campanha
     * declararia um e mandaria o texto de outro, com o opt-out e o teto do mês
     * decididos pelo primeiro.
     */
    let tipo = params.tipo;
    if (params.templateId) {
      const doTexto = await tx.$queryRaw<{ kind: TipoDeNotificacao }[]>`
        SELECT kind::text AS kind FROM whatsapp_templates
         WHERE id = ${params.templateId}::uuid AND status = 'aprovado'
      `;
      const achado = doTexto[0];
      if (!achado) {
        // Aprovado também: a tela só oferece aprovados, mas a borda aceita
        // qualquer uuid — e uma campanha apontada para um rascunho sairia
        // com o público congelado e nenhuma mensagem, sem erro nenhum.
        throw new CampanhaError('invalida', 'Este texto não existe ou não foi aprovado.');
      }
      tipo = achado.kind;
      if (!tipoDeCampanhaValido(tipo)) {
        throw new CampanhaError('invalida', 'Este texto não serve para campanha.');
      }
    }
    if (tipo === undefined) {
      throw new CampanhaError('invalida', 'Escolha o texto que a campanha vai mandar.');
    }

    const criadas = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO campaigns
        (tenant_id, name, filter, filter_value, filter_weekday, kind, goal_window_days,
         created_by, template_id)
      VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid,
              ${params.nome.trim()}, ${params.filtro}::campaign_filter,
              ${params.valorDoFiltro}, ${params.diaDaSemana},
              ${tipo}::notification_kind, ${params.janelaDias},
              ${params.staffId}::uuid, ${params.templateId ?? null}::uuid)
      RETURNING id
    `;
    const campanha = criadas[0];
    if (!campanha) throw new CampanhaError('invalida', 'Não deu para criar a campanha.');

    /**
     * Quando o filtro é um segmento, quem escolhe é `packages/core`.
     *
     * A carga é uma só, dentro **desta** transação: o segmento depende da base
     * inteira, e ler a base fora dela deixaria a janela em que alguém é
     * cadastrado entre o cálculo e a gravação do público.
     */
    const segmento = segmentoDoFiltro(params.filtro);
    /**
     * `risco_de_abandono` sai do **score de churn**, não do ciclo individual.
     *
     * É a mesma lista que a tela de Retenção mostra, e ela não é a mesma gente
     * que `em_risco`: aquela tela apontava quarenta e uma pessoas e mandava
     * chamá-las por um filtro que alcançava catorze — vinte e duas já eram
     * `perdido` e cinco não tinham segmento nenhum. Duas telas classificando as
     * mesmas pessoas com a mesma palavra e discordando (§6, pergunta 6).
     *
     * A carga entra na **mesma transação** pelo motivo de sempre: o score
     * depende da base inteira, e lê-la fora daqui abre a janela em que alguém é
     * cadastrado entre o cálculo e a gravação do público.
     */
    const doChurn =
      params.filtro === 'risco_de_abandono'
        ? (await churnDaBase(params.tenantId, params.agora, tx))
            .filter((c) => c.faixa !== 'baixo')
            .map((c) => c.customerId)
        : [];

    const doSegmento =
      segmento === null
        ? []
        : (await segmentosDaBase(params.tenantId, params.agora, tx))
            .filter((c) => c.segmento === segmento)
            .map((c) => c.customerId);

    /**
     * O público, congelado agora.
     *
     * Todo filtro exclui quem foi anonimizado e quem não tem telefone: os dois
     * entrariam no público para serem pulados no envio, inflando "quantos
     * receberam" com gente que nunca poderia receber — e a receita atribuída
     * divide por esse número.
     */
    const publico = await tx.$executeRawUnsafe(
      `INSERT INTO campaign_targets (tenant_id, campaign_id, customer_id)
       SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid, $1::uuid, c.id
         FROM customers c
        WHERE c.anonymized_at IS NULL AND c.phone_e164 IS NOT NULL
          AND ${condicaoDoFiltro(params.filtro)}
       ON CONFLICT (campaign_id, customer_id) DO NOTHING`,
      campanha.id,
      params.agora,
      params.valorDoFiltro ?? 0,
      params.diaDaSemana ?? 0,
      params.filtro === 'risco_de_abandono' ? doChurn : doSegmento,
    );

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'campaign.created',
      entity: 'campaigns',
      entityId: campanha.id,
      after: { nome: params.nome, filtro: params.filtro, publico },
    });

    return { id: campanha.id, publico };
  });
}

/**
 * A condição de cada filtro, com os parâmetros na mesma ordem sempre.
 *
 * `$2` é o instante, `$3` o número do filtro, `$4` o dia da semana, `$5` a lista
 * do segmento — sempre, em todos os filtros, mesmo quando um deles não usa. Uma
 * ordem que mudasse por filtro faria o parâmetro certo chegar na posição errada,
 * e o erro seria um público silenciosamente diferente do pedido.
 *
 * Por isso todo caso menciona os quatro: um parâmetro que o Postgres nunca vê no
 * texto é um parâmetro sem tipo inferido, e a instrução é recusada.
 */
function condicaoDoFiltro(filtro: FiltroDeCampanha): string {
  /**
   * Todo caso menciona os quatro parâmetros, inclusive os que não usa.
   *
   * Não é adorno: a instrução vai com cinco valores sempre, e o Postgres recusa
   * um `bind` com mais parâmetros do que o texto declara. Antes de `$5` existir
   * isso já era assim para `$3` e `$4` — o que muda é que agora há uma frase
   * explicando por quê.
   */
  const naoUsados = `$2::timestamptz IS NOT NULL AND $3::int IS NOT NULL
                     AND $4::int IS NOT NULL AND $5::uuid[] IS NOT NULL`;
  switch (filtro) {
    case 'em_risco':
    case 'perdido':
    case 'vip':
    case 'risco_de_abandono':
      /**
       * A lista já veio decidida por `packages/core`, e ela sai de uma consulta
       * feita sob a RLS **desta** barbearia — ninguém de fora entra por aqui.
       * As condições de anonimizado e telefone continuam valendo por cima, como
       * em todo filtro.
       */
      return `c.id = ANY($5::uuid[]) AND $2::timestamptz IS NOT NULL
              AND $3::int IS NOT NULL AND $4::int IS NOT NULL`;
    case 'todos':
      return `(${naoUsados})`;
    case 'inativos':
      return `NOT EXISTS (
                SELECT 1 FROM appointments a
                 WHERE a.customer_id = c.id
                   AND a.starts_at > $2::timestamptz - ($3::int * interval '1 day')
              ) AND $4::int IS NOT NULL AND $5::uuid[] IS NOT NULL`;
    case 'aniversariantes':
      return `c.birth_date IS NOT NULL
              AND EXTRACT(MONTH FROM c.birth_date) = EXTRACT(MONTH FROM $2::timestamptz)
              AND $3::int IS NOT NULL AND $4::int IS NOT NULL
              AND $5::uuid[] IS NOT NULL`;
    case 'celula_fria':
      /**
       * Quem **costuma vir naquele horário** — e não quem já veio uma vez.
       *
       * A célula fria é uma hora que a barbearia quer encher; o público certo é
       * quem tem o hábito daquele horário, porque é quem pode voltar a ele. Uma
       * campanha para toda a base sobre uma terça às 14h é ruído para quem só
       * corta no sábado.
       */
      return `EXISTS (
                SELECT 1 FROM appointments a
                 JOIN locations l ON l.id = a.location_id
                 WHERE a.customer_id = c.id
                   AND a.status = 'completed'
                   AND a.starts_at > $2::timestamptz - interval '180 days'
                   AND EXTRACT(DOW FROM a.starts_at AT TIME ZONE l.timezone)::int = $4::int
                   AND EXTRACT(HOUR FROM a.starts_at AT TIME ZONE l.timezone)::int = $3::int
              ) AND $5::uuid[] IS NOT NULL`;
  }
}

export interface AlvoAEnviar {
  readonly id: string;
  readonly customerId: string;
  readonly telefone: string;
  readonly clienteNome: string;
  readonly barbearia: string;
  readonly tipo: TipoDeNotificacao;
  /**
   * O texto que esta campanha escolheu, congelado na criação (bloco 96).
   *
   * Ele viaja com o alvo e não é lido de novo no envio: quem trocar o texto da
   * campanha amanhã não reescreve o que já saiu, pela mesma razão de o público
   * ser congelado.
   */
  readonly templateId: string | null;
}

export async function alvosAEnviar(
  tenantId: string,
  campanhaId: string,
  limite = 200,
): Promise<readonly AlvoAEnviar[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        customer_id: string;
        phone_e164: string;
        name: string;
        barbearia: string;
        kind: TipoDeNotificacao;
        template_id: string | null;
      }[]
    >`
      SELECT t.id, t.customer_id, c.phone_e164, c.name, tn.name AS barbearia,
             ca.kind::text AS kind, ca.template_id
        FROM campaign_targets t
        JOIN campaigns ca ON ca.id = t.campaign_id
        JOIN customers c ON c.id = t.customer_id
        JOIN tenants tn ON tn.id = t.tenant_id
       WHERE t.campaign_id = ${campanhaId}::uuid
         AND t.sent_at IS NULL AND t.skipped_reason IS NULL
       LIMIT ${limite}
    `;
    return linhas.map((l) => ({
      id: l.id,
      customerId: l.customer_id,
      telefone: l.phone_e164,
      clienteNome: l.name,
      barbearia: l.barbearia,
      tipo: l.kind,
      templateId: l.template_id,
    }));
  });
}

/**
 * O botão "Enviar": marca a campanha e **enfileira** o despacho.
 *
 * ## Por que fila, e não a própria requisição
 *
 * Um público de trezentas pessoas é trezentas idas ao provedor de mensagem.
 * Numa requisição, o balcão fica com a tela girando e um `timeout` no meio
 * deixa metade enviada sem ninguém saber qual metade. A tarefa é enfileirada
 * **dentro da transação** que muda o estado, como todo o resto do produto:
 * enfileirar depois do commit abre a janela em que a campanha está "enviando"
 * e nada foi agendado.
 *
 * ## Por que o estado é a trava
 *
 * `AND status = 'rascunho'` no `WHERE` é o que segura o segundo toque — de
 * outro aparelho, de outra sessão, com outra chave de idempotência. Uma
 * campanha despachada duas vezes é a barbearia mandando a mesma promoção duas
 * vezes para a mesma pessoa, que é como se queima o número.
 */
export async function marcarParaEnvio(params: {
  readonly tenantId: string;
  readonly campanhaId: string;
  readonly staffId: string;
  readonly staffName: string;
}): Promise<boolean> {
  return withTenant(params.tenantId, async (tx) => {
    const afetadas = await tx.$executeRaw`
      -- sent_at aqui é quando foi mandado para a fila, e o despacho o mantém
      -- por COALESCE. É ele que impede o botão de retomar de aparecer sobre um
      -- envio que acabou de ser pedido.
      UPDATE campaigns SET status = 'enviando', sent_at = now()
       WHERE id = ${params.campanhaId}::uuid AND status = 'rascunho'
    `;
    if (afetadas !== 1) return false;

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'campaign.sent',
      entity: 'campaigns',
      entityId: params.campanhaId,
    });

    await enfileirarPara(tx, params.tenantId, {
      kind: 'campanha.enviar',
      // Id, nunca conteúdo: `jobs` não tem RLS, e o público é dado de cliente.
      payload: { campanhaId: params.campanhaId },
      idempotencyKey: `campanha:${params.campanhaId}`,
    });
    return true;
  });
}

/**
 * Decide e carimba cada alvo, com as mesmas proteções da automação.
 *
 * Devolve quantos saíram. O que **não** sai fica com o motivo escrito, pela
 * razão de sempre: "nada foi enviado" sem motivo transforma toda pergunta do
 * dono numa investigação.
 */
export async function despacharCampanha(params: {
  readonly tenantId: string;
  readonly campanhaId: string;
  readonly agora: Date;
  readonly timeZone: string;
  /**
   * Manda, e devolve o `wamid` quando a mensagem saiu pela Meta.
   *
   * `null` é envio pelo canal de reserva, e não falha. O id é o que liga o
   * alvo ao webhook de entrega — sem ele, "entregues" e "lidos" na tela da
   * campanha seriam zero para sempre, que é o indicador que nunca preenche da
   * §6 pergunta 5. A coluna existe desde o bloco 60 e ninguém a escrevia.
   */
  readonly enviar: (alvo: AlvoAEnviar) => Promise<string | null>;
}): Promise<{ readonly enviados: number; readonly pulados: number }> {
  const alvos = await alvosAEnviar(params.tenantId, params.campanhaId);
  let enviados = 0;
  let pulados = 0;

  for (const alvo of alvos) {
    const contagem = await withTenant(params.tenantId, async (tx) => {
      /**
       * As duas contagens saem de `notifications`, e o dia é o **da unidade**.
       *
       * Três consertos numa consulta só (bloco 108):
       *
       * 1. **O teto do mês contava zero.** Ele já lia `notifications`, e nem o
       *    despacho de campanha nem o de automação escreviam ali — só o envio
       *    avulso do balcão, cujo comentário diz, em letras, que a linha existe
       *    "para esta mensagem contar no teto: sem ela o envio avulso seria o
       *    furo do teto do mês, quatro pelo motor e quantas quisessem pelo
       *    balcão". Os quatro pelo motor não existiam. A tela de Automações
       *    promete "no máximo quatro promoções por mês" desde o bloco 100.
       *
       * 2. **E contava a coisa errada.** Sem filtro de tipo, ele somava
       *    confirmação e lembrete — que a Meta cobra como utilidade e que o
       *    cliente pediu ao marcar. Em produção, onde o lembrete de fato grava,
       *    quem tinha quatro agendamentos no mês ficava barrado de receber
       *    qualquer promoção. `TIPOS_PROMOCIONAIS` vem de `naturezaDe`, e não
       *    escrito aqui dentro.
       *
       * 3. **A regra de uma por dia era por mecanismo.** Contando
       *    `campaign_targets`, uma campanha e uma automação chegavam ao mesmo
       *    celular no mesmo dia, cada uma correta sozinha — que é exatamente o
       *    conjunto que a SPEC §4.11 chama de spam. Agora as duas escrevem no
       *    mesmo lugar e leem do mesmo lugar.
       *
       * E o corte do dia usa o fuso da unidade: em UTC−5 o dia virava às 19h
       * locais, abrindo duas horas em que a segunda mensagem saía.
       */
      const linhas = await tx.$queryRaw<{ hoje: bigint; no_mes: bigint; aceita: boolean }[]>`
        SELECT
          (SELECT count(*) FROM notifications n
            WHERE n.customer_id = ${alvo.customerId}::uuid AND n.status = 'sent'
              AND n.kind = ANY(${[...TIPOS_PROMOCIONAIS]}::notification_kind[])
              AND (n.sent_at AT TIME ZONE ${params.timeZone})::date
                = (${params.agora}::timestamptz AT TIME ZONE ${params.timeZone})::date) AS hoje,
          (SELECT count(*) FROM notifications n
            WHERE n.customer_id = ${alvo.customerId}::uuid AND n.status = 'sent'
              AND n.kind = ANY(${[...TIPOS_PROMOCIONAIS]}::notification_kind[])
              AND n.sent_at > ${params.agora}::timestamptz - interval '30 days') AS no_mes,
          (SELECT accepts_marketing FROM customers WHERE id = ${alvo.customerId}::uuid) AS aceita
      `;
      return linhas[0];
    });

    const decisao = decidirDisparo({
      ativa: true,
      tipo: alvo.tipo,
      /**
       * Campanha é promoção, sempre — nunca derivada do tipo.
       *
       * `naturezaDe` chama de transacional tudo que não é `retorno`, e o tipo
       * da campanha vem do formulário. Sem esta linha, uma campanha declarada
       * como `lembrete_24h` pulava a checagem de consentimento e o teto do mês
       * e mandava para a base inteira, incluindo quem revogou o marketing — o
       * `customer_consents` inteiro contornado por um seletor de tela.
       *
       * A borda também recusa o tipo (`TIPOS_DE_CAMPANHA`), e as duas camadas
       * existem porque uma delas é a que sobrevive: acrescentar um tipo àquela
       * lista sem mexer em `naturezaDe` reabriria o furo em silêncio.
       *
       * Achado da `/security-review` deste bloco.
       */
      natureza: 'promocional',
      jaDisparouPorEsteFato: false,
      jaRecebeuHoje: Number(contagem?.hoje ?? 0) > 0,
      temTelefone: true,
      aceitaPromocional: contagem?.aceita ?? false,
      promocionaisNoMes: Number(contagem?.no_mes ?? 0),
      atrasoMinutos: 0,
      fatoEm: params.agora,
      agora: params.agora,
      timeZone: params.timeZone,
    });

    if (!decisao.disparar || !decisao.quando || decisao.quando.getTime() > params.agora.getTime()) {
      await withTenant(params.tenantId, async (tx) => {
        await tx.$executeRaw`
          UPDATE campaign_targets SET skipped_reason = ${decisao.motivo ?? 'fora_da_janela'}
           WHERE id = ${alvo.id}::uuid AND sent_at IS NULL
        `;
      });
      pulados += 1;
      continue;
    }

    /**
     * O carimbo vem antes da mensagem — precedente do bloco 54 — e usa o
     * relógio **injetado**, não o `now()` do banco.
     *
     * A decisão logo acima já recebe `agora` por parâmetro, como manda a regra
     * do projeto. Carimbar com `now()` fazia as duas discordarem: a regra de
     * um-por-dia comparava a data do parâmetro com uma coluna gravada pelo
     * relógio do processo, e o teste flagrou — a segunda campanha do mesmo dia
     * saía porque as duas datas eram diferentes.
     */
    const nosso = await withTenant(params.tenantId, async (tx) => {
      const afetadas = await tx.$executeRaw`
        UPDATE campaign_targets SET sent_at = ${params.agora}
         WHERE id = ${alvo.id}::uuid AND sent_at IS NULL AND skipped_reason IS NULL
      `;
      if (afetadas !== 1) return false;

      /**
       * A linha em `notifications`, **na mesma transação do carimbo**.
       *
       * É ela que faz esta mensagem contar no teto do mês e na regra de uma por
       * dia — as duas leem daqui. Fora da transação, um processo que caísse
       * entre o carimbo e a gravação deixaria uma mensagem enviada que não
       * conta em lugar nenhum, e o teto voltaria a valer menos do que promete.
       */
      /**
       * `sent_at` sai do relógio **injetado**, e não do `DEFAULT now()`.
       *
       * O carimbo em `campaign_targets` logo acima usa `params.agora`; deixar
       * esta linha no relógio do banco faz as duas discordarem, e quem conta o
       * dia compara `agora` com uma coluna gravada por outro relógio. Foi assim
       * que a primeira versão deste conserto passou o teste do teto e reprovou
       * o de "uma por dia": a linha existia, com a data de hoje, e a pergunta
       * era sobre o dia de `AGORA`.
       */
      await tx.$executeRaw`
        INSERT INTO notifications (tenant_id, kind, customer_id, status, phone_masked, sent_at)
        VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid,
                ${alvo.tipo}::notification_kind, ${alvo.customerId}::uuid,
                'sent', NULL, ${params.agora})
      `;
      return true;
    });
    if (!nosso) continue;

    const wamid = await params.enviar(alvo);
    enviados += 1;

    /**
     * O `wamid` numa gravação **depois** do envio, e não junto do carimbo.
     *
     * O carimbo vem antes por decisão do bloco 54 — carimbar depois perde o
     * carimbo se o processo cair, e a volta seguinte remanda. O id só existe
     * depois de a Meta responder, então ele não cabe naquela instrução. Perdê-lo
     * custa a linha de "entregue" desta pessoa; perder o carimbo custaria a
     * mensagem duas vezes, e entre as duas o produto escolhe a primeira.
     */
    if (wamid) {
      await withTenant(params.tenantId, async (tx) => {
        await tx.$executeRaw`
          UPDATE campaign_targets SET wamid = ${wamid} WHERE id = ${alvo.id}::uuid
        `;
      });
    }
  }

  await withTenant(params.tenantId, async (tx) => {
    await tx.$executeRaw`
      UPDATE campaigns SET status = 'enviada', sent_at = COALESCE(sent_at, ${params.agora})
       WHERE id = ${params.campanhaId}::uuid
    `;
  });

  return { enviados, pulados };
}

/**
 * Retomar uma campanha que ficou parada em `enviando`.
 *
 * A saída que faltava. `enviando` só vira `enviada` no fim de
 * `despacharCampanha`; esgotadas as cinco tentativas da tarefa, a campanha
 * ficava ali para sempre, com a tela repetindo *"Na fila. As mensagens saem aos
 * poucos"* sobre uma fila que já tinha desistido.
 *
 * Retomar é seguro porque o despacho é idempotente por alvo: ele só lê quem
 * tem `sent_at IS NULL AND skipped_reason IS NULL`. Quem já recebeu não recebe
 * de novo.
 *
 * Quem decide se **pode** retomar é `campanhaParada`, em `packages/core`, e a
 * condição é o relógio: uma hora sem nada se mexer. O botão não aparece durante
 * um envio que está andando — duas voltas simultâneas leriam o mesmo alvo, e
 * mensagem repetida no celular do cliente é o único estrago irreversível deste
 * caminho.
 *
 * A chave da tarefa carrega o instante de propósito: a de `marcarParaEnvio` é
 * `campanha:<id>` e já foi consumida: reusá-la faria o `ON CONFLICT` descartar
 * a retomada em silêncio, que é o defeito que o filtro e o índice parcial já
 * cobraram neste repositório.
 */
export async function retomarCampanha(params: {
  readonly tenantId: string;
  readonly campanhaId: string;
  readonly staffId: string;
  readonly staffName: string;
  readonly agora: Date;
}): Promise<boolean> {
  return withTenant(params.tenantId, async (tx) => {
    /**
     * A trava primeiro, a agregação depois — **duas consultas, e é obrigatório**.
     *
     * O Postgres recusa `FOR UPDATE` sobre consulta com `GROUP BY`
     * (*"FOR UPDATE is not allowed with GROUP BY clause"*), e o erro só aparece
     * quando a consulta roda: a primeira versão desta função respondia 500 em
     * **toda** chamada, com o botão "Retomar o envio" desenhado na tela e a
     * suíte inteira verde — os testes novos eram unitários de `campanhaParada`,
     * que não toca o banco. É a regra do `CLAUDE.md` §1 em letras: *"SQL cru não
     * é conferido por ninguém até rodar"*.
     */
    const [travada] = await tx.$queryRaw<{ status: EstadoDeCampanha }[]>`
      SELECT status::text AS status FROM campaigns
       WHERE id = ${params.campanhaId}::uuid
       FOR UPDATE
    `;
    if (!travada) return false;

    /**
     * O último movimento inclui **o pedido de despacho**, não só o primeiro
     * alvo enviado.
     *
     * Sem `c.sent_at` no meio, uma campanha criada na segunda e disparada na
     * quarta era dada como parada no instante seguinte ao clique em "Enviar" —
     * o "último movimento" seria a criação, de dois dias antes. O botão de
     * retomar aparecia sobre um envio que a fila ainda nem tinha começado, e a
     * tela dizia "Na fila" e "Retomar" ao mesmo tempo.
     *
     * `marcarParaEnvio` passou a carimbar `sent_at` na entrada de `enviando`, e
     * `despacharCampanha` continua reescrevendo-o no fim por `COALESCE` — quem
     * chega primeiro fica, que é o que se quer nos dois casos.
     */
    const [linha] = await tx.$queryRaw<{ ultimo_movimento: Date }[]>`
      SELECT COALESCE(max(t.sent_at), c.sent_at, c.created_at) AS ultimo_movimento
        FROM campaigns c
        LEFT JOIN campaign_targets t ON t.campaign_id = c.id
       WHERE c.id = ${params.campanhaId}::uuid
       GROUP BY c.id
    `;
    if (!linha) return false;
    if (!campanhaParada(travada.status, linha.ultimo_movimento, params.agora)) return false;

    await audit(tx, {
      actorId: params.staffId,
      actorName: params.staffName,
      action: 'campaign.sent',
      entity: 'campaigns',
      entityId: params.campanhaId,
    });

    await enfileirarPara(tx, params.tenantId, {
      kind: 'campanha.enviar',
      payload: { campanhaId: params.campanhaId },
      idempotencyKey: `campanha:${params.campanhaId}:${params.agora.toISOString()}`,
    });
    return true;
  });
}

/**
 * A receita atribuída — *"a única coluna que importa"*.
 *
 * Congelada no momento da atribuição, e é a exceção da regra de valor derivado
 * deste schema. Recalcular na leitura faria o relatório de uma campanha de
 * março mudar quando alguém estornasse uma venda em maio, e a pergunta que a
 * coluna responde é "quanto esta campanha trouxe", não "quanto vale hoje".
 */
export async function atribuirReceita(params: {
  readonly tenantId: string;
  readonly agora: Date;
}): Promise<number> {
  return withTenant(params.tenantId, async (tx) => {
    /**
     * A venda mais próxima de cada envio, numa instrução só.
     *
     * `LATERAL` não enxerga a tabela que o `UPDATE` altera — o Postgres recusa
     * a referência —, então o cálculo vira uma subconsulta que já traz o id do
     * alvo. Um laço por alvo seria o N+1 que a regra proíbe, e aqui ele é sobre
     * o público inteiro de todas as campanhas.
     */
    const atribuidos = await tx.$executeRaw`
      UPDATE campaign_targets t
         SET goal_met_at = v.closed_at, goal_ref = v.venda, goal_amount_cents = v.total_cents
        FROM (
          SELECT tt.id AS alvo, o.id AS venda, o.closed_at, o.total_cents
            FROM campaign_targets tt
            JOIN campaigns c ON c.id = tt.campaign_id
            JOIN LATERAL (
              SELECT o.id, o.closed_at, o.total_cents
                FROM orders o
               WHERE o.customer_id = tt.customer_id
                 AND o.status = 'paid'
                 AND o.closed_at > tt.sent_at
                 AND o.closed_at <= tt.sent_at + (c.goal_window_days * interval '1 day')
               ORDER BY o.closed_at
               LIMIT 1
            ) o ON true
           WHERE tt.sent_at IS NOT NULL AND tt.goal_met_at IS NULL
        ) v
       WHERE t.id = v.alvo AND t.goal_met_at IS NULL
    `;
    return atribuidos;
  });
}
