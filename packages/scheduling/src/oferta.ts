import { createHash, randomBytes } from 'node:crypto';
import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  MINUTOS_DE_JANELA_EXCLUSIVA,
  fimDaJanelaExclusiva,
  formatHHMM,
  instantToLocal,
  ofertaAberta,
  ordenarPorPrioridade,
  type CandidatoNaFila,
  type EstadoDaOferta,
} from '@barbearia/core';
import { agendarVencimentoDaOferta } from '@barbearia/jobs';
import { candidatosDaVaga, vagaDoCancelamento } from './espera.js';

/**
 * A oferta de vaga com janela exclusiva (bloco 39, SPEC §2.9).
 *
 * O bloco 38 entregou a lista e o gatilho: um cancelamento abre uma vaga e o
 * produto sabe dizer quem a quer. Aqui a vaga é **oferecida** — ao topo da fila
 * por prioridade, com dez minutos de exclusividade e o horário segurado.
 *
 * ## Segurar o horário é o que torna "exclusivo" verdade
 *
 * Sem `slot_holds`, exclusividade é uma palavra na mensagem: nos dez minutos em
 * que a pessoa decide, qualquer visitante da página pública marca aquele
 * horário. O convite vira frustração, e a lista perde a razão de existir.
 *
 * ## Por que o token, e por que só o hash
 *
 * A oferta chega por mensagem e a pessoa não tem sessão. Pedir login antes de
 * aceitar é o mesmo atrito que fez a entrada na lista nascer sem login — e aqui
 * é pior, porque o relógio está correndo.
 *
 * Guardado como hash, como o token da fila presencial: quem lê a tabela não
 * aceita a oferta de ninguém. O valor em claro existe uma vez, dentro da
 * mensagem.
 */

export type OfertaFailure =
  | 'oferta_nao_encontrada'
  | 'oferta_encerrada'
  | 'vaga_ocupada';

export class OfertaError extends Error {
  constructor(readonly code: OfertaFailure, message: string) {
    super(message);
    this.name = 'OfertaError';
  }
}

/** 32 bytes de `randomBytes`, como o token da fila. Nunca `Math.random`. */
function novoToken(): { readonly token: string; readonly hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: createHash('sha256').update(token).digest('hex') };
}

export function hashDaOferta(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface OfertaCriada {
  readonly id: string;
  readonly entryId: string;
  readonly customerId: string;
  readonly customerNome: string;
  /** Em claro, **uma vez**: é o que vai na mensagem e não é gravado. */
  readonly token: string;
  readonly venceEm: Date;
  /** Data e hora locais da unidade, para a mensagem não repetir a conversão. */
  readonly dia: string;
  readonly hora: string;
  readonly profissionalNome: string;
}

/**
 * Oferece a vaga ao próximo da fila.
 *
 * Devolve `null` quando não há ninguém — o que é o caso comum, e não é erro.
 *
 * ## Quem já tem oferta viva não recebe outra
 *
 * Duas mensagens ao mesmo tempo, ambas exclusivas por dez minutos, e a pessoa
 * só consegue aceitar uma: a outra vira frustração com cara de defeito. O
 * índice do banco garante, e o filtro aqui evita a exceção.
 *
 * ## O relógio entra por parâmetro
 *
 * Como em todo o resto. A janela de dez minutos precisa ser provável sem
 * esperar dez minutos.
 */
export async function oferecerVaga(
  tx: TransactionClient,
  params: {
    readonly tenantId: string;
    readonly locationId: string;
    readonly professionalId: string;
    readonly inicio: Date;
    readonly fim: Date;
    readonly timezone: string;
    readonly agora: Date;
    /** Entradas que não devem receber a oferta — as que já recusaram esta vaga. */
    readonly exceto?: readonly string[];
  },
): Promise<OfertaCriada | null> {
  const vaga = vagaDoCancelamento({
    timezone: params.timezone,
    inicio: params.inicio,
    fim: params.fim,
    professionalId: params.professionalId,
  });

  const candidatos = await candidatosDaVaga(tx, {
    locationId: params.locationId,
    vaga,
    // O relógio do chamador, para a janela de doze meses do score ser a mesma
    // que o resto da transação enxerga.
    agora: params.agora,
  });
  if (candidatos.length === 0) return null;

  const excluidas = new Set(params.exceto ?? []);
  const comOfertaViva = await entradasComOfertaViva(tx);
  const elegiveis = candidatos.filter(
    (c) => !excluidas.has(c.id) && !comOfertaViva.has(c.id),
  );
  if (elegiveis.length === 0) return null;

  const medidas = await medirCandidatos(tx, elegiveis, params.agora);
  const duracao = Math.round((params.fim.getTime() - params.inicio.getTime()) / 60_000);
  const ordenados = ordenarPorPrioridade(medidas, duracao);

  const venceEm = fimDaJanelaExclusiva(params.agora);

  /**
   * O horário é segurado **antes** da oferta existir.
   *
   * A ordem importa: com a oferta gravada primeiro, um processo que caísse no
   * meio deixaria uma pessoa com convite exclusivo para um horário que ninguém
   * está segurando. É o mesmo raciocínio da cobrança online do bloco 37, em que
   * a linha nasce antes da chamada ao adquirente.
   *
   * O hold vence junto com a oferta: quem não responde devolve o horário à
   * grade sozinho, sem depender de a varredura ter rodado.
   */
  const holds = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO slot_holds (tenant_id, professional_id, starts_at, ends_at, expires_at)
    VALUES (${params.tenantId}::uuid, ${params.professionalId}::uuid,
            ${params.inicio}, ${params.fim}, ${venceEm})
    RETURNING id
  `;
  const holdId = holds[0]?.id ?? null;

  /**
   * Desce a fila até alguém aceitar a gravação.
   *
   * O `ON CONFLICT DO NOTHING` não distingue os dois índices parciais, e eles
   * querem coisas opostas: conflito de **vaga** significa que outra transação
   * ofereceu este horário e não há mais o que fazer; conflito de **entrada**
   * significa que esta pessoa já tem convite vivo, e a vaga ainda serve para o
   * próximo da fila. Tratar os dois como "não deu" fazia a vaga inteira ser
   * descartada em silêncio — com a fila cheia de gente que a queria. Achado da
   * revisão de segurança do bloco 39.
   */
  for (const posicao of ordenados) {
    const escolhido = elegiveis.find((c) => c.id === posicao.id);
    if (!escolhido) continue;

    const inicioDoServico = new Date(
      params.inicio.getTime() + (await bufferDeEntrada(tx, escolhido.id)) * 60_000,
    );
    const { token, hash } = novoToken();

    const criadas = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO waitlist_offers
        (tenant_id, entry_id, professional_id, starts_at, ends_at, service_starts_at,
         offered_at, expires_at, hold_id, token_hash)
      VALUES (
        ${params.tenantId}::uuid, ${escolhido.id}::uuid, ${params.professionalId}::uuid,
        ${params.inicio}, ${params.fim}, ${inicioDoServico},
        ${params.agora}, ${venceEm}, ${holdId}::uuid, ${hash}
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `;

    const id = criadas[0]?.id;
    if (!id) {
      if (await vagaJaOferecida(tx, params.professionalId, params.inicio)) break;
      continue;
    }

    const local = instantToLocal(params.timezone, inicioDoServico);
    return {
      id,
      entryId: escolhido.id,
      customerId: escolhido.customerId,
      customerNome: escolhido.customerNome,
      token,
      venceEm,
      dia: local.date,
      hora: formatHHMM(local.minutes),
      profissionalNome: escolhido.profissionalNome ?? '',
    };
  }

  // Ninguém ficou com a vaga. O hold recém-criado sai junto: sem isto ele
  // seguraria por dez minutos um horário que ninguém está oferecendo.
  if (holdId) await tx.$executeRaw`DELETE FROM slot_holds WHERE id = ${holdId}::uuid`;
  return null;
}

/**
 * Entradas que já têm convite vivo.
 *
 * O recorte é o **mesmo** do índice parcial do banco, de propósito: filtrar
 * também por prazo aqui deixaria elegível, entre o vencimento e a varredura,
 * quem o banco continua recusando.
 */
async function entradasComOfertaViva(
  tx: TransactionClient,
): Promise<ReadonlySet<string>> {
  const linhas = await tx.$queryRaw<{ entry_id: string }[]>`
    SELECT entry_id FROM waitlist_offers WHERE status IN ('aberta', 'aceitando')
  `;
  return new Set(linhas.map((l) => l.entry_id));
}

/** Alguém já está com esta vaga na mão? */
async function vagaJaOferecida(
  tx: TransactionClient,
  professionalId: string,
  inicio: Date,
): Promise<boolean> {
  const linhas = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM waitlist_offers
     WHERE professional_id = ${professionalId}::uuid
       AND starts_at = ${inicio}
       AND status IN ('aberta', 'aceitando')
  `;
  return linhas.length > 0;
}

/**
 * O buffer de preparo desta entrada, na política da unidade.
 *
 * É a distância entre o começo da janela ocupada — o que se segura — e o começo
 * do serviço — o que se anuncia e o que o motor de reserva recebe. Sai dos
 * serviços de **quem vai receber** a vaga: quem desmarcou pode ter escolhido
 * outra coisa, com outro preparo.
 */
async function bufferDeEntrada(tx: TransactionClient, entryId: string): Promise<number> {
  const linhas = await tx.$queryRaw<
    { policy: string; soma: number; maior: number }[]
  >`
    SELECT l.buffer_policy::text AS policy,
           COALESCE(sum(s.buffer_before_minutes), 0)::int AS soma,
           COALESCE(max(s.buffer_before_minutes), 0)::int AS maior
      FROM waitlist_entries e
      JOIN locations l ON l.id = e.location_id
      LEFT JOIN waitlist_entry_services es ON es.entry_id = e.id
      LEFT JOIN services s ON s.id = es.service_id
     WHERE e.id = ${entryId}::uuid
     GROUP BY l.buffer_policy
  `;
  const linha = linhas[0];
  if (!linha) return 0;
  return linha.policy === 'per_service' ? linha.soma : linha.maior;
}

/**
 * As medidas que a fórmula da SPEC §2.9 precisa, numa consulta.
 *
 * Visitas, confiabilidade e assinatura por candidato. Uma ida ao banco por
 * pessoa seria N+1 **dentro da transação do cancelamento**, com a recepção
 * esperando a tela responder.
 *
 * A confiabilidade vem do override quando existe, e do cálculo quando não —
 * exatamente como `confiancaDoCliente`, mas em lote. Repetir a fórmula aqui
 * seria a segunda cópia de uma regra que já mora em `packages/core`; o que se
 * repete é a **leitura**, e ela é trivial.
 */
async function medirCandidatos(
  tx: TransactionClient,
  candidatos: readonly {
    readonly id: string;
    readonly customerId: string;
    readonly inicio: string;
    readonly fim: string;
    readonly entrouEm: string;
  }[],
  agora: Date,
): Promise<readonly CandidatoNaFila[]> {
  const desde = new Date(agora);
  desde.setUTCMonth(desde.getUTCMonth() - 12);

  const clientes = candidatos.map((c) => c.customerId);
  const linhas = await tx.$queryRaw<
    {
      customer_id: string;
      visitas: bigint;
      faltas: bigint;
      considerados: bigint;
      override: number | null;
      assinante: boolean;
    }[]
  >`
    SELECT c.id AS customer_id,
           count(*) FILTER (WHERE a.status = 'completed') AS visitas,
           count(*) FILTER (
             WHERE a.status = 'no_show' AND a.service_starts_at >= ${desde}
           ) AS faltas,
           count(*) FILTER (
             WHERE a.status IN ('completed', 'no_show', 'cancelled_customer')
               AND a.service_starts_at >= ${desde}
           ) AS considerados,
           c.reliability_override AS override,
           -- O termo assinante do score (SPEC 2.9), entregue no bloco 45.
           --
           -- Era lacuna declarada desde o bloco 38: ele entrava constante e
           -- falso para todo mundo, e o efeito era o score inteiro caber em
           -- 0,8 em vez de 1,0 -- sem alterar a ordem de ninguem.
           --
           -- A leitura e feita aqui e nao por packages/finance porque a seta
           -- nao volta: scheduling nao depende de finance. Ler uma tabela para
           -- responder "esta pessoa assina?" e a mesma coisa que ler customers;
           -- o que mora em finance e a operacao de assinar.
           --
           -- Inadimplente conta junto de ativa, como no resto do produto: o
           -- cartao que falhou na terca costuma passar na quinta, e tirar a
           -- prioridade da fila no primeiro erro e a punicao que a SPEC 4.6
           -- manda evitar.
           EXISTS (
             SELECT 1 FROM club_subscriptions s
              WHERE s.customer_id = c.id AND s.status IN ('ativa', 'inadimplente')
           ) AS assinante
      FROM customers c
      LEFT JOIN appointments a ON a.customer_id = c.id
     WHERE c.id = ANY(${clientes}::uuid[])
     GROUP BY c.id, c.reliability_override
  `;

  const porCliente = new Map(linhas.map((l) => [l.customer_id, l]));

  return candidatos.map((candidato) => {
    const medida = porCliente.get(candidato.customerId);
    const considerados = Number(medida?.considerados ?? 0);
    const faltas = Number(medida?.faltas ?? 0);

    /**
     * A confiabilidade em forma reduzida, e a redução está escrita.
     *
     * A fórmula cheia do bloco 37 pesa falta, cancelamento tardio, cancelamento
     * avisado e atraso. Aqui entra só a taxa de falta, que é o termo dominante
     * — vale quatro vezes o segundo. Carregar os outros três exigiria trazer o
     * histórico inteiro de cada candidato para a memória **dentro da transação
     * do cancelamento**, e este número decide um décimo do score.
     *
     * O override do gerente vale por cima, como em toda leitura de
     * confiabilidade: quem o escreveu conhecia o caso.
     */
    const calculada =
      considerados < 3 ? 100 : Math.max(0, Math.round(100 - 100 * (faltas / considerados)));
    const confiabilidade = medida?.override ?? calculada;

    return {
      id: candidato.id,
      janelaPedida: {
        start: minutosDe(candidato.inicio),
        end: minutosDe(candidato.fim),
      },
      visitas: Number(medida?.visitas ?? 0),
      assinante: medida?.assinante ?? false,
      confiabilidade,
      entrouEm: new Date(candidato.entrouEm),
    };
  });
}

/** `HH:mm` para minutos desde a meia-noite. */
function minutosDe(hhmm: string): number {
  const [h = '0', m = '0'] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

export interface OfertaNaTela {
  readonly id: string;
  readonly estado: EstadoDaOferta;
  readonly venceEm: string;
  readonly dia: string;
  readonly hora: string;
  readonly profissionalNome: string;
  readonly servicos: readonly string[];
  readonly barbearia: string;
  readonly minutosRestantes: number;
}

/**
 * A oferta pelo token do link, para a tela que o cliente abre.
 *
 * Sem sessão: o token **é** a credencial, como o link de acompanhamento da fila
 * presencial. Ele é aleatório de 32 bytes e só o hash fica gravado.
 */
export async function ofertaPorToken(
  tenantId: string,
  token: string,
  agora: Date = new Date(),
): Promise<OfertaNaTela | null> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        status: EstadoDaOferta;
        expires_at: Date;
        service_starts_at: Date;
        professional_name: string;
        timezone: string;
        barbearia: string;
        services: string[] | null;
      }[]
    >`
      SELECT o.id, o.status::text AS status, o.expires_at, o.service_starts_at,
             p.name AS professional_name, l.timezone, t.name AS barbearia,
             array_remove(array_agg(s.name ORDER BY es.position), NULL) AS services
        FROM waitlist_offers o
        JOIN waitlist_entries e ON e.id = o.entry_id
        JOIN professionals p ON p.id = o.professional_id
        JOIN locations l ON l.id = e.location_id
        JOIN tenants t ON t.id = o.tenant_id
        LEFT JOIN waitlist_entry_services es ON es.entry_id = e.id
        LEFT JOIN services s ON s.id = es.service_id
       WHERE o.token_hash = ${hashDaOferta(token)}
       GROUP BY o.id, p.name, l.timezone, t.name
    `;

    const linha = linhas[0];
    if (!linha) return null;

    const local = instantToLocal(linha.timezone, linha.service_starts_at);
    const restantes = Math.max(
      0,
      Math.ceil((linha.expires_at.getTime() - agora.getTime()) / 60_000),
    );

    return {
      id: linha.id,
      // O estado gravado diz `aberta` até a varredura passar; o que a tela
      // mostra é o estado **de verdade**, que inclui o relógio.
      estado: ofertaAberta({ estado: linha.status, venceEm: linha.expires_at }, agora)
        ? 'aberta'
        : linha.status === 'aberta'
          ? 'vencida'
          : linha.status,
      venceEm: linha.expires_at.toISOString(),
      dia: local.date,
      hora: formatHHMM(local.minutes),
      profissionalNome: linha.professional_name,
      servicos: linha.services ?? [],
      barbearia: linha.barbearia,
      minutosRestantes: Math.min(MINUTOS_DE_JANELA_EXCLUSIVA, restantes),
    };
  });
}

export interface OfertaAceita {
  readonly appointmentId: string;
}

/**
 * Aceita a oferta e marca o horário.
 *
 * ## Tudo numa transação, e o hold sai primeiro
 *
 * O horário está segurado por um `slot_holds` que a própria oferta criou. Ele
 * precisa sair **antes** do `INSERT` do agendamento, senão a constraint de
 * exclusão barra a reserva contra o hold que existe para ela — é a mesma ordem
 * que a reserva com `holdId` já usa desde o bloco 5.
 *
 * ## O agendamento nasce com o que a entrada pediu
 *
 * Serviços e profissional saem da entrada e da oferta, nunca da requisição:
 * quem aceita clica num link, e o que o link autoriza é **aquela vaga**. Aceitar
 * um corpo com serviços deixaria a pessoa marcar outra coisa no horário que
 * conseguiu por prioridade.
 */
/**
 * Como o convite é encontrado.
 *
 * Pelo **token** quando a pessoa chega pelo link da mensagem, sem sessão — é o
 * caminho normal. Pela **entrada** quando ela chega pela própria tela, já
 * autenticada: o convite existe, o horário está guardado para ela e a mensagem
 * pode não ter chegado. Sem esta segunda porta o estado não tem saída na
 * interface, que é defeito de fluxo (CLAUDE.md §6).
 *
 * Nos dois casos o que autoriza é prova de identidade: a posse do token, ou a
 * sessão somada ao `customer_id` — porque a RLS separa barbearias e não separa
 * clientes dentro de uma.
 */
export type ComoAcharOConvite =
  | { readonly token: string }
  | { readonly entryId: string; readonly customerId: string };

export async function aceitarOferta(params: {
  readonly tenantId: string;
  readonly convite: ComoAcharOConvite;
  readonly agora?: Date;
  /**
   * Como o agendamento é criado, injetado.
   *
   * `createAppointment` mora em `booking.ts`, que já importa este arquivo pela
   * ponta da oferta — chamá-lo daqui fecharia um ciclo entre os dois módulos.
   * Quem liga as pontas é quem monta o caso de uso.
   */
  readonly marcar: (pedido: {
    /** Para a chave de idempotência do agendamento sair daqui, e não do token. */
    readonly ofertaId: string;
    readonly locationId: string;
    readonly professionalId: string;
    readonly serviceIds: readonly string[];
    readonly customerId: string;
    readonly date: string;
    readonly start: string;
    readonly holdId: string | null;
  }) => Promise<{ readonly id: string }>;
}): Promise<OfertaAceita> {
  const agora = params.agora ?? new Date();

  const hash = 'token' in params.convite ? hashDaOferta(params.convite.token) : null;
  const entryId = 'entryId' in params.convite ? params.convite.entryId : null;
  const customerId = 'customerId' in params.convite ? params.convite.customerId : null;

  const dados = await withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        status: EstadoDaOferta;
        expires_at: Date;
        service_starts_at: Date;
        professional_id: string;
        hold_id: string | null;
        entry_id: string;
        entry_status: string;
        customer_id: string;
        location_id: string;
        timezone: string;
        service_ids: string[] | null;
      }[]
    >`
      SELECT o.id, o.status::text AS status, o.expires_at, o.service_starts_at,
             o.professional_id, o.hold_id,
             e.id AS entry_id, e.status::text AS entry_status,
             e.customer_id, e.location_id, l.timezone,
             -- Os serviços vêm por subconsulta, e não por agregação com GROUP BY:
             -- o Postgres recusa FOR UPDATE junto de GROUP BY, e é o FOR UPDATE
             -- que serializa dois cliques no mesmo link.
             (SELECT array_remove(array_agg(es.service_id::text ORDER BY es.position), NULL)
                FROM waitlist_entry_services es
               WHERE es.entry_id = e.id) AS service_ids
        FROM waitlist_offers o
        JOIN waitlist_entries e ON e.id = o.entry_id
        JOIN locations l ON l.id = e.location_id
       -- Uma porta ou a outra, nunca as duas: o lado inativo entra nulo e o
       -- ramo inteiro some. Pela entrada exige-se o customer_id junto, porque a
       -- RLS separa barbearias e não separa clientes dentro de uma.
       WHERE (${hash}::text IS NOT NULL AND o.token_hash = ${hash}::text)
          OR (${entryId}::uuid IS NOT NULL
              AND o.entry_id = ${entryId}::uuid
              AND e.customer_id = ${customerId}::uuid)
       FOR UPDATE OF o
    `;

    const oferta = linhas[0];
    if (!oferta) {
      throw new OfertaError('oferta_nao_encontrada', 'Este convite não existe.');
    }
    if (!ofertaAberta({ estado: oferta.status, venceEm: oferta.expires_at }, agora)) {
      throw new OfertaError(
        'oferta_encerrada',
        'Este convite já venceu. Você continua na lista de espera.',
      );
    }
    /**
     * Quem saiu da lista não marca pelo convite antigo.
     *
     * Sair cancela as ofertas abertas (`sairDaEspera`), então na prática isto é
     * a segunda guarda. Ela fica porque a entrada também sai de `waiting` por
     * outros caminhos — expirar, e marcar o mesmo horário pelo site —, e um
     * convite que sobrevive a "não quero mais" é o pior tipo de surpresa.
     */
    if (oferta.entry_status !== 'waiting') {
      throw new OfertaError(
        'oferta_encerrada',
        'Esta espera já foi encerrada. O convite não vale mais.',
      );
    }

    /**
     * O resgate é gravado **aqui dentro**, e é o que a trava protege.
     *
     * Sem esta escrita a transação travada não mudava nada: a trava caía no
     * commit, o segundo pedido relia a mesma linha `aberta` e seguia adiante.
     * Os dois marcavam, e o segundo só era barrado na constraint de exclusão —
     * com "horário indisponível" para quem tinha exclusividade sobre ele.
     */
    const resgatadas = await tx.$executeRaw`
      UPDATE waitlist_offers
         SET status = 'aceitando', updated_at = now()
       WHERE id = ${oferta.id}::uuid AND status = 'aberta'
    `;
    if (resgatadas === 0) {
      throw new OfertaError('oferta_encerrada', 'Este convite já foi usado.');
    }

    const local = instantToLocal(oferta.timezone, oferta.service_starts_at);
    return {
      ofertaId: oferta.id,
      entryId: oferta.entry_id,
      customerId: oferta.customer_id,
      locationId: oferta.location_id,
      professionalId: oferta.professional_id,
      serviceIds: oferta.service_ids ?? [],
      holdId: oferta.hold_id,
      date: local.date,
      start: formatHHMM(local.minutes),
    };
  });

  /**
   * A marcação roda **fora** da transação da oferta, e é decisão.
   *
   * `createAppointment` abre a própria — aninhar duas seria pedir ao Prisma uma
   * transação dentro de outra, que ele não faz. O que fecha a janela é o estado
   * `aceitando`, gravado antes: o horário continua fora da grade, e nenhum
   * segundo pedido passa pelo mesmo convite.
   *
   * O hold vai **junto** para o motor, em vez de ser apagado antes. Ele já sabe
   * ignorar o próprio hold ao consultar a grade e apagá-lo depois de gravar, e
   * numa transação só — apagar aqui devolveria o horário à grade no instante em
   * que a marcação falhasse.
   */
  const marcado = await params
    .marcar({
      ofertaId: dados.ofertaId,
      locationId: dados.locationId,
      professionalId: dados.professionalId,
      serviceIds: dados.serviceIds,
      customerId: dados.customerId,
      date: dados.date,
      start: dados.start,
      holdId: dados.holdId,
    })
    .catch(async (erro: unknown) => {
      // A marcação falhou e o convite volta a valer pelo prazo que sobrou. Sem
      // isto, um erro de rede consumiria a exclusividade de quem não fez nada
      // errado — e a entrada ficaria presa em `aceitando` até a varredura.
      await withTenant(params.tenantId, async (tx) => {
        await tx.$executeRaw`
          UPDATE waitlist_offers
             SET status = 'aberta', updated_at = now()
           WHERE id = ${dados.ofertaId}::uuid AND status = 'aceitando'
        `;
      });
      throw erro;
    });

  await withTenant(params.tenantId, async (tx) => {
    await tx.$executeRaw`
      UPDATE waitlist_offers
         SET status = 'aceita', answered_at = ${agora},
             appointment_id = ${marcado.id}::uuid, hold_id = NULL, updated_at = now()
       WHERE id = ${dados.ofertaId}::uuid AND status = 'aceitando'
    `;
    // A entrada fecha junto. `createAppointment` já faz isso pela regra do
    // bloco 38, mas só quando a vaga casa com o pedido — e aqui ela casa por
    // construção. A linha é barata e não depende daquela.
    await tx.$executeRaw`
      UPDATE waitlist_entries
         SET status = 'booked', closed_at = ${agora},
             appointment_id = ${marcado.id}::uuid, updated_at = now()
       WHERE id = ${dados.entryId}::uuid AND status = 'waiting'
    `;
  });

  return { appointmentId: marcado.id };
}

export interface VagaParaOferecer {
  readonly tenantId: string;
  readonly locationId: string;
  readonly professionalId: string;
  readonly inicio: Date;
  readonly fim: Date;
  readonly timezone: string;
  /** Entradas que já receberam esta vaga e não responderam. */
  readonly exceto: readonly string[];
}

/**
 * Vence as ofertas sem resposta e diz quais vagas voltaram à mesa.
 *
 * Roda na varredura da fila de trabalho. Devolve o que precisa ser oferecido ao
 * próximo — quem faz a oferta é quem chama, porque oferecer manda mensagem e
 * `scheduling` não conhece o canal.
 *
 * O `exceto` é o que impede o laço: sem ele, a vaga voltaria para a mesma
 * pessoa que acabou de não responder, indefinidamente.
 */
export async function vencerOfertas(
  tenantId: string,
  agora: Date,
): Promise<readonly VagaParaOferecer[]> {
  return withTenant(tenantId, async (tx) => {
    const vencidas = await tx.$queryRaw<
      {
        id: string;
        entry_id: string;
        professional_id: string;
        starts_at: Date;
        ends_at: Date;
        hold_id: string | null;
        location_id: string;
        timezone: string;
      }[]
    >`
      -- A coluna hold_id continua preenchida aqui de propósito. RETURNING numa UPDATE
      -- devolve o valor **novo**: zerar a coluna na mesma instrução faria a
      -- lista de holds a apagar sair vazia, e o horário ficaria fora da grade
      -- até a limpeza passar. Quem zera a coluna é o ON DELETE SET NULL da
      -- própria chave estrangeira, logo abaixo.
      UPDATE waitlist_offers o
         SET status = 'vencida', answered_at = ${agora}, updated_at = now()
        FROM waitlist_entries e, locations l
       WHERE e.id = o.entry_id
         AND l.id = e.location_id
         -- O estado aceitando entra junto: um processo que morra entre o resgate do
         -- convite e o agendamento existir deixaria a oferta presa nesse estado,
         -- e com ela a entrada e a vaga, que os índices contam como vivas.
         AND o.status IN ('aberta', 'aceitando')
         AND o.expires_at <= ${agora}
      RETURNING o.id, o.entry_id, o.professional_id, o.starts_at, o.ends_at,
                o.hold_id, e.location_id, l.timezone
    `;
    if (vencidas.length === 0) return [];

    // Os holds saem junto: eles já venceram pelo próprio `expires_at`, mas
    // deixá-los na tabela faria a grade calcular sobre linha morta até a
    // limpeza passar.
    const holds = vencidas.map((v) => v.hold_id).filter((h): h is string => Boolean(h));
    if (holds.length > 0) {
      await tx.$executeRaw`DELETE FROM slot_holds WHERE id = ANY(${holds}::uuid[])`;
    }

    /**
     * Quem já recusou esta vaga não a recebe de novo.
     *
     * A lista sai do próprio banco, e não das linhas que acabaram de vencer:
     * a vaga pode ter passado por três pessoas antes, e oferecer à segunda
     * outra vez seria o laço que nunca termina.
     */
    const porVaga = new Map<string, VagaParaOferecer>();
    for (const vencida of vencidas) {
      const chave = `${vencida.professional_id}|${vencida.starts_at.toISOString()}`;
      const jaTentadas = await tx.$queryRaw<{ entry_id: string }[]>`
        SELECT entry_id FROM waitlist_offers
         WHERE professional_id = ${vencida.professional_id}::uuid
           AND starts_at = ${vencida.starts_at}
      `;
      porVaga.set(chave, {
        tenantId,
        locationId: vencida.location_id,
        professionalId: vencida.professional_id,
        inicio: vencida.starts_at,
        fim: vencida.ends_at,
        timezone: vencida.timezone,
        exceto: jaTentadas.map((t) => t.entry_id),
      });
    }

    return [...porVaga.values()];
  });
}

/**
 * Oferece a vaga e devolve o que a mensagem precisa dizer.
 *
 * É o que o worker chama. Abre a transação, oferece ao topo da fila e enfileira
 * o vencimento — as três coisas juntas, porque uma oferta sem vencimento
 * agendado seria exclusividade eterna: o horário ficaria fora da grade até
 * alguém reparar.
 *
 * A mensagem sai **fora** desta transação, e é quem chama que a manda: enviar
 * aqui dentro seguraria a transação enquanto se espera o provedor.
 */
export async function oferecerProximaVaga(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly professionalId: string;
  readonly inicio: Date;
  readonly fim: Date;
  readonly agora: Date;
  readonly exceto?: readonly string[];
}): Promise<
  | (OfertaCriada & { readonly telefone: string | null; readonly barbearia: string })
  | null
> {
  return withTenant(params.tenantId, async (tx) => {
    // O nome da barbearia sai daqui junto do fuso, e não de uma segunda ida ao
    // banco: quem manda a mensagem precisa dizer de quem ela é — sem isso o
    // WhatsApp chega assinado por ninguém.
    const unidades = await tx.$queryRaw<{ timezone: string; barbearia: string }[]>`
      SELECT l.timezone, t.name AS barbearia
        FROM locations l
        JOIN tenants t ON t.id = l.tenant_id
       WHERE l.id = ${params.locationId}::uuid
    `;
    const timezone = unidades[0]?.timezone;
    const barbearia = unidades[0]?.barbearia ?? '';
    if (!timezone) return null;

    const oferta = await oferecerVaga(tx, {
      tenantId: params.tenantId,
      locationId: params.locationId,
      professionalId: params.professionalId,
      inicio: params.inicio,
      fim: params.fim,
      timezone,
      agora: params.agora,
      ...(params.exceto ? { exceto: params.exceto } : {}),
    });
    if (!oferta) return null;

    // O vencimento na mesma transação da oferta: sem ele, quem não responde
    // segura o horário para sempre.
    await agendarVencimentoDaOferta(tx, { ofertaId: oferta.id, venceEm: oferta.venceEm });

    const contatos = await tx.$queryRaw<{ phone_e164: string | null }[]>`
      SELECT phone_e164 FROM customers WHERE id = ${oferta.customerId}::uuid
    `;
    return { ...oferta, telefone: contatos[0]?.phone_e164 ?? null, barbearia };
  });
}
