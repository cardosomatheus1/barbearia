import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  DIAS_MAXIMOS_DE_ESPERA,
  LIMITE_DE_ESPERAS_ATIVAS,
  formatHHMM,
  instantToLocal,
  podeEsperar,
  temPrioridadeNaEspera,
  vagaServe,
  type PedidoDeEspera,
  type RecusaDeEspera,
  type VagaAberta,
} from '@barbearia/core';
import { confiancaDeVarios, limiaresDoScore } from './confianca.js';

/**
 * A lista de espera, do banco para a decisão (bloco 38, SPEC §2.9).
 *
 * A regra de compatibilidade mora em `packages/core` e não sabe que existe
 * banco. Aqui se carrega o estado, se chama o domínio e se grava o resultado.
 *
 * ## O gatilho roda dentro da transação do cancelamento
 *
 * `appointment.cancelled` abre uma vaga, e é nesse instante que se pergunta
 * quem a quer. Perguntar depois do commit criaria a janela em que o horário
 * está livre e ninguém sabe — e é justamente a janela em que outro cliente
 * marca pelo site, deixando a lista de espera sem função no único momento em
 * que ela serviria.
 */

export type EsperaFailure =
  | 'espera_nao_encontrada'
  | 'unidade_desconhecida'
  | 'servico_desconhecido'
  | 'profissional_desconhecido'
  | RecusaDeEspera;

export class EsperaError extends Error {
  constructor(readonly code: EsperaFailure, message: string) {
    super(message);
    this.name = 'EsperaError';
  }
}

export interface EntradaDeEspera {
  readonly id: string;
  readonly status: 'waiting' | 'booked' | 'left' | 'expired';
  readonly de: string;
  readonly ate: string;
  /** `HH:mm` locais, para a tela não repetir a conversão. */
  readonly inicio: string;
  readonly fim: string;
  readonly duracaoMinutos: number;
  readonly profissionalId: string | null;
  readonly profissionalNome: string | null;
  readonly servicos: readonly string[];
  readonly entrouEm: string;
}

interface LinhaDaEspera {
  readonly id: string;
  readonly status: EntradaDeEspera['status'];
  readonly wanted_from: Date;
  readonly wanted_to: Date;
  readonly window_start_minute: number;
  readonly window_end_minute: number;
  readonly duration_minutes: number;
  readonly professional_id: string | null;
  readonly professional_name: string | null;
  readonly services: string[] | null;
  readonly joined_at: Date;
}

/**
 * `date` do Postgres volta como `Date` à meia-noite UTC pelo driver.
 *
 * Formatar com o fuso do processo devolveria o dia anterior a oeste de
 * Greenwich — que é o Brasil inteiro. O recorte da string é o que mantém
 * "sábado" sendo sábado.
 */
const diaDe = (valor: Date): string => valor.toISOString().slice(0, 10);

function daLinha(linha: LinhaDaEspera): EntradaDeEspera {
  return {
    id: linha.id,
    status: linha.status,
    de: diaDe(linha.wanted_from),
    ate: diaDe(linha.wanted_to),
    inicio: formatHHMM(linha.window_start_minute),
    fim: formatHHMM(linha.window_end_minute),
    duracaoMinutos: linha.duration_minutes,
    profissionalId: linha.professional_id,
    profissionalNome: linha.professional_name,
    servicos: linha.services ?? [],
    entrouEm: linha.joined_at.toISOString(),
  };
}

const SELECT_DA_ESPERA = `
  SELECT e.id, e.status::text AS status, e.wanted_from, e.wanted_to,
         e.window_start_minute, e.window_end_minute, e.duration_minutes,
         e.professional_id, p.name AS professional_name, e.joined_at,
         array_remove(array_agg(s.name ORDER BY es.position), NULL) AS services
    FROM waitlist_entries e
    LEFT JOIN professionals p ON p.id = e.professional_id
    LEFT JOIN waitlist_entry_services es ON es.entry_id = e.id
    LEFT JOIN services s ON s.id = es.service_id
`;

export interface PedidoDeEntrada {
  readonly tenantId: string;
  readonly locationId: string;
  readonly customerId: string;
  readonly serviceIds: readonly string[];
  readonly professionalId?: string | null;
  /** Datas locais da unidade, `YYYY-MM-DD`. */
  readonly de: string;
  readonly ate: string;
  /** Minutos locais desde a meia-noite. */
  readonly inicioMinuto: number;
  readonly fimMinuto: number;
  readonly idempotencyKey?: string;
  readonly now?: Date;
}

/**
 * Põe alguém na lista.
 *
 * A duração é somada **do catálogo**, nunca da requisição — mesma regra da
 * reserva: aceitar duração do cliente deixaria alguém pedir "quero ser avisado
 * de qualquer buraco de 5 minutos" e ganhar prioridade sobre a agenda inteira.
 */
export async function entrarNaEspera(pedido: PedidoDeEntrada): Promise<EntradaDeEspera> {
  return withTenant(pedido.tenantId, async (tx) => {
    const agora = pedido.now ?? new Date();

    const unidades = await tx.$queryRaw<{ timezone: string }[]>`
      SELECT timezone FROM locations WHERE id = ${pedido.locationId}::uuid
    `;
    const timezone = unidades[0]?.timezone;
    if (!timezone) {
      throw new EsperaError('unidade_desconhecida', 'Unidade não encontrada.');
    }

    if (pedido.idempotencyKey) {
      const anterior = await porChave(tx, pedido.idempotencyKey);
      if (anterior) return anterior;
    }

    /**
     * Duração **e contagem** dos serviços, numa consulta.
     *
     * A contagem é o que importa aqui, e foi achado da revisão de segurança: a
     * checagem de integridade referencial do Postgres **ignora row security**,
     * então a chave estrangeira aceitaria de bom grado um `service_id` de outra
     * barbearia. Somente a soma não pega isso — um pedido misturando um serviço
     * legítimo com dois alheios dá soma positiva, passa, e grava as referências
     * estrangeiras.
     *
     * É o mesmo cuidado que `salvarPreferencias` documenta desde o bloco 21.
     */
    const servicos = await tx.$queryRaw<{ total: number | null; quantos: bigint }[]>`
      SELECT sum(duration_minutes + buffer_before_minutes + buffer_after_minutes)::int AS total,
             count(*) AS quantos
        FROM services WHERE id = ANY(${[...pedido.serviceIds]}::uuid[]) AND active
    `;
    const duracaoMinutos = servicos[0]?.total ?? 0;
    if (Number(servicos[0]?.quantos ?? 0) !== pedido.serviceIds.length) {
      throw new EsperaError('servico_desconhecido', 'Serviço não encontrado.');
    }

    /**
     * O profissional, conferido sob RLS e **na unidade pedida**.
     *
     * Pelo mesmo motivo dos serviços. E a consequência aqui era pior: a chave
     * estrangeira tem `ON DELETE SET NULL`, então quando a outra barbearia
     * apagasse aquele profissional, a entrada plantada aqui viraria em silêncio
     * um "qualquer barbeiro" — passando a casar com toda vaga que abrisse.
     */
    if (pedido.professionalId) {
      const existe = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM professionals
         WHERE id = ${pedido.professionalId}::uuid
           AND location_id = ${pedido.locationId}::uuid
           AND active
      `;
      if (!existe[0]) {
        throw new EsperaError('profissional_desconhecido', 'Profissional não encontrado.');
      }
    }

    const ativas = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM waitlist_entries
       WHERE customer_id = ${pedido.customerId}::uuid AND status = 'waiting'
    `;

    const hoje = diaLocal(timezone, agora);
    const decisao = podeEsperar({
      pedido: {
        de: pedido.de,
        ate: pedido.ate,
        janela: { start: pedido.inicioMinuto, end: pedido.fimMinuto },
        profissionalId: pedido.professionalId ?? null,
        duracaoMinutos,
      },
      ativasDoCliente: Number(ativas[0]?.n ?? 0),
      hojeNaUnidade: hoje,
      ultimoDiaAceito: somarDias(hoje, DIAS_MAXIMOS_DE_ESPERA),
    });

    if (!decisao.aceito && decisao.recusa) {
      throw new EsperaError(decisao.recusa, MENSAGEM[decisao.recusa]);
    }
    if (duracaoMinutos <= 0) {
      throw new EsperaError('janela_invalida', 'Escolha ao menos um serviço.');
    }

    const criadas = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO waitlist_entries
        (tenant_id, location_id, customer_id, professional_id,
         wanted_from, wanted_to, window_start_minute, window_end_minute,
         duration_minutes, idempotency_key)
      VALUES (
        ${pedido.tenantId}::uuid, ${pedido.locationId}::uuid,
        ${pedido.customerId}::uuid, ${pedido.professionalId ?? null}::uuid,
        ${pedido.de}::date, ${pedido.ate}::date,
        ${pedido.inicioMinuto}, ${pedido.fimMinuto},
        ${duracaoMinutos}, ${pedido.idempotencyKey ?? null}
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `;

    const id = criadas[0]?.id;
    if (!id) {
      // O índice parcial recusou uma entrada igual que já está esperando.
      // Devolver a que existe é mais certo que erro: a pessoa queria estar na
      // lista, e ela está.
      const existente = await mesmoPedido(tx, pedido);
      if (existente) return existente;
      throw new EsperaError('limite_atingido', MENSAGEM['limite_atingido']);
    }

    for (const [posicao, serviceId] of pedido.serviceIds.entries()) {
      await tx.$executeRaw`
        INSERT INTO waitlist_entry_services (entry_id, service_id, tenant_id, position)
        VALUES (${id}::uuid, ${serviceId}::uuid, ${pedido.tenantId}::uuid, ${posicao})
        ON CONFLICT DO NOTHING
      `;
    }

    const criada = await porId(tx, id);
    if (!criada) throw new EsperaError('espera_nao_encontrada', 'Entrada não encontrada.');
    return criada;
  });
}

const MENSAGEM: Readonly<Record<RecusaDeEspera, string>> = {
  janela_invalida: 'O horário final precisa ser depois do inicial.',
  periodo_invertido: 'A data final precisa ser depois da inicial.',
  periodo_longo_demais: `A lista de espera vai até ${DIAS_MAXIMOS_DE_ESPERA} dias à frente.`,
  dia_no_passado: 'Escolha um dia que ainda não passou.',
  limite_atingido: `Você já está em ${LIMITE_DE_ESPERAS_ATIVAS} listas de espera. Saia de uma para entrar em outra.`,
};

async function porId(tx: TransactionClient, id: string): Promise<EntradaDeEspera | null> {
  const linhas = await tx.$queryRawUnsafe<LinhaDaEspera[]>(
    `${SELECT_DA_ESPERA} WHERE e.id = $1::uuid GROUP BY e.id, p.name`,
    id,
  );
  const linha = linhas[0];
  return linha ? daLinha(linha) : null;
}

async function porChave(
  tx: TransactionClient,
  chave: string,
): Promise<EntradaDeEspera | null> {
  const linhas = await tx.$queryRawUnsafe<LinhaDaEspera[]>(
    `${SELECT_DA_ESPERA} WHERE e.idempotency_key = $1 GROUP BY e.id, p.name`,
    chave,
  );
  const linha = linhas[0];
  return linha ? daLinha(linha) : null;
}

/** A entrada idêntica que o índice parcial acabou de recusar. */
async function mesmoPedido(
  tx: TransactionClient,
  pedido: PedidoDeEntrada,
): Promise<EntradaDeEspera | null> {
  const linhas = await tx.$queryRawUnsafe<LinhaDaEspera[]>(
    `${SELECT_DA_ESPERA}
      WHERE e.customer_id = $1::uuid AND e.status = 'waiting'
        AND e.wanted_from = $2::date AND e.wanted_to = $3::date
        AND e.window_start_minute = $4 AND e.window_end_minute = $5
        AND e.professional_id IS NOT DISTINCT FROM $6::uuid
      GROUP BY e.id, p.name`,
    pedido.customerId,
    pedido.de,
    pedido.ate,
    pedido.inicioMinuto,
    pedido.fimMinuto,
    pedido.professionalId ?? null,
  );
  const linha = linhas[0];
  return linha ? daLinha(linha) : null;
}

/**
 * As esperas de um cliente.
 *
 * Filtra por `customer_id` porque a RLS separa barbearias e **não** separa
 * clientes dentro de uma. Sem isto, qualquer cliente autenticado leria a lista
 * de espera de qualquer outro.
 */
export async function esperasDoCliente(
  tenantId: string,
  customerId: string,
  agora: Date = new Date(),
): Promise<readonly (EntradaDeEspera & { readonly convite: ConviteVivo | null })[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRawUnsafe<
      (LinhaDaEspera & {
        convite_em: Date | null;
        convite_vence: Date | null;
        timezone: string;
      })[]
    >(
      /**
       * O convite vivo vem junto, e é o que dá **saída** a este estado na tela.
       *
       * O convite chega por mensagem, e o token existe em claro uma única vez,
       * dentro dela. Se a mensagem não chega — janela de silêncio, provedor fora
       * do ar, ou o provedor de console, que é o que roda até o WhatsApp oficial
       * entrar no bloco 55 —, a pessoa fica com um horário guardado para ela e
       * nenhum caminho até ele. Aqui ela vê e aceita pela própria sessão, sem
       * token nenhum.
       */
      `SELECT e.id, e.status::text AS status, e.wanted_from, e.wanted_to,
              e.window_start_minute, e.window_end_minute, e.duration_minutes,
              e.professional_id, p.name AS professional_name, e.joined_at,
              l.timezone,
              o.service_starts_at AS convite_em, o.expires_at AS convite_vence,
              array_remove(array_agg(s.name ORDER BY es.position), NULL) AS services
         FROM waitlist_entries e
         JOIN locations l ON l.id = e.location_id
         LEFT JOIN professionals p ON p.id = e.professional_id
         LEFT JOIN waitlist_entry_services es ON es.entry_id = e.id
         LEFT JOIN services s ON s.id = es.service_id
         LEFT JOIN waitlist_offers o
                ON o.entry_id = e.id AND o.status = 'aberta' AND o.expires_at > now()
        WHERE e.customer_id = $1::uuid AND e.status = 'waiting'
        GROUP BY e.id, p.name, l.timezone, o.service_starts_at, o.expires_at
        ORDER BY e.wanted_from, e.window_start_minute`,
      customerId,
    );
    return linhas.map((linha) => ({
      ...daLinha(linha),
      convite: conviteDaLinha(linha, agora),
    }));
  });
}

/**
 * Sai da lista.
 *
 * `customerId` é obrigatório e não opcional: esta operação parte sempre do
 * cliente, e um parâmetro opcional aqui seria esquecido no primeiro chamador
 * novo — tirando qualquer pessoa da lista de qualquer outra, bastando o id.
 */
export async function sairDaEspera(params: {
  readonly tenantId: string;
  readonly customerId: string;
  readonly entryId: string;
}): Promise<void> {
  await withTenant(params.tenantId, async (tx) => {
    const afetadas = await tx.$executeRaw`
      UPDATE waitlist_entries
         SET status = 'left', closed_at = now(), updated_at = now()
       WHERE id = ${params.entryId}::uuid
         AND customer_id = ${params.customerId}::uuid
         AND status = 'waiting'
    `;
    if (afetadas === 0) {
      // Não distingue "não existe" de "não é sua": a RLS já tornou invisível o
      // que é de outra barbearia, e diferenciar aqui viraria oráculo.
      throw new EsperaError('espera_nao_encontrada', 'Esta espera não existe ou já terminou.');
    }

    /**
     * O convite morre junto, e o horário volta à grade.
     *
     * Sem isto, quem sai da lista fica com um link vivo e resgatável — a pessoa
     * disse "não quero mais" e continua conseguindo marcar por ele. Pior: o
     * horário segue segurado pelos dez minutos, fora da grade de todo mundo, por
     * uma espera que já não existe. Achado da revisão de segurança do bloco 39.
     *
     * Na mesma transação da saída: se a saída volta atrás, o convite continua
     * valendo.
     */
    const canceladas = await tx.$queryRaw<{ hold_id: string | null }[]>`
      UPDATE waitlist_offers
         SET status = 'cancelada', answered_at = now(), updated_at = now()
       WHERE entry_id = ${params.entryId}::uuid
         AND status = 'aberta'
      RETURNING hold_id
    `;
    const holds = canceladas
      .map((linha) => linha.hold_id)
      .filter((id): id is string => Boolean(id));
    if (holds.length > 0) {
      await tx.$executeRaw`DELETE FROM slot_holds WHERE id = ANY(${holds}::uuid[])`;
    }
  });
}

/**
 * O **balcão** tira alguém da lista de espera.
 *
 * Existe separada de `sairDaEspera` porque a autorização é outra: lá quem age é
 * o cliente e o filtro obrigatório é `customer_id`, porque a RLS separa
 * barbearias e não separa clientes dentro de uma; aqui quem age é a barbearia,
 * e o recorte é a **unidade** — pela mesma razão, uma loja acima: a RLS também
 * não separa lojas dentro de uma barbearia.
 *
 * Ela faltava, e o custo era concreto. A lista aparecia no painel com nome,
 * telefone e convite vivo, e **sem um único controle**: o cliente ligava
 * dizendo "já resolvi" e a recepção não tinha o que apertar. A pessoa continuava
 * recebendo convite, e cada convite nasce com um `slot_holds` que tira o
 * horário da grade pública por dez minutos — vaga vendável segurada por uma
 * espera que já não existe. A única saída era o cliente entrar na conta dele.
 *
 * O corpo é o mesmo de `sairDaEspera` de propósito: o convite morre junto e o
 * hold é apagado na mesma transação. Duas formas de sair que fizessem coisas
 * diferentes seriam duas noções de "sair da lista".
 */
export async function tirarDaEspera(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly entryId: string;
}): Promise<void> {
  await withTenant(params.tenantId, async (tx) => {
    const afetadas = await tx.$executeRaw`
      UPDATE waitlist_entries
         SET status = 'left', closed_at = now(), updated_at = now()
       WHERE id = ${params.entryId}::uuid
         AND location_id = ${params.locationId}::uuid
         AND status = 'waiting'
    `;
    if (afetadas === 0) {
      // Mesma mensagem de inexistente: "existe, mas não é da sua loja" confirma
      // o id para quem o adivinhou.
      throw new EsperaError('espera_nao_encontrada', 'Esta espera não existe ou já terminou.');
    }

    const canceladas = await tx.$queryRaw<{ hold_id: string | null }[]>`
      UPDATE waitlist_offers
         SET status = 'cancelada', answered_at = now(), updated_at = now()
       WHERE entry_id = ${params.entryId}::uuid
         AND status = 'aberta'
      RETURNING hold_id
    `;
    const holds = canceladas
      .map((linha) => linha.hold_id)
      .filter((id): id is string => Boolean(id));
    if (holds.length > 0) {
      await tx.$executeRaw`DELETE FROM slot_holds WHERE id = ANY(${holds}::uuid[])`;
    }
  });
}

export interface CandidatoDaVaga extends EntradaDeEspera {
  readonly customerId: string;
  readonly customerNome: string;
  /** Só os quatro últimos: a tela do balcão fica virada para o salão. */
  readonly customerTelefoneFinal: string | null;
}

/**
 * O mesmo candidato, do jeito que ele chega à tela — com o id podendo ser nulo.
 *
 * `CandidatoDaVaga` é o do domínio: ele nasce **dentro** da transação, e o
 * motor de convite precisa do id para segurar o horário e mandar a mensagem.
 * Quem devolve a lista para o balcão é que redige, e sem este tipo o `null`
 * não caberia — foi assim que a redação do painel do dia apagou nome e
 * telefone e deixou o id passar. O id é identidade: com ele se abre a ficha, o
 * extrato de fiado e o saldo de fidelidade.
 */
export interface CandidatoNaTela extends Omit<CandidatoDaVaga, 'customerId'> {
  readonly customerId: string | null;
}

/**
 * Quem quer esta vaga.
 *
 * Chamada **dentro da transação do cancelamento**. O recorte grosso é do banco
 * — unidade, dia dentro do período pedido, ainda esperando — servido pelo
 * índice parcial da migração 0041; o casamento fino é do domínio, que é onde a
 * regra pode ser lida e discutida.
 *
 * ## A ordem: confiabilidade primeiro, chegada depois (bloco 60)
 *
 * > *"score ≥ 85 → prioridade na fila de espera"* — SPEC §2.13.
 *
 * E **só entre iguais**: quem não cabe na vaga continua não cabendo. Ordenar por
 * confiabilidade antes do casamento ofereceria o horário a quem não pode usá-lo,
 * e a oferta viraria ligação inútil — o defeito que o `contains` do bloco 38
 * existe para fechar. Por isso o filtro vem antes da ordenação, sempre.
 *
 * Dentro do grupo dos que cabem, quem sempre aparece passa na frente. Empate
 * volta a ser a ordem de chegada, que é o décimo do score da SPEC §2.9.
 * Aderência, recorrência e assinatura continuam sendo dívida declarada.
 */
export async function candidatosDaVaga(
  tx: TransactionClient,
  params: {
    readonly locationId: string;
    readonly vaga: VagaAberta;
    /** O relógio, para a janela de doze meses do score. */
    readonly agora?: Date;
  },
): Promise<readonly CandidatoDaVaga[]> {
  const linhas = await tx.$queryRawUnsafe<
    (LinhaDaEspera & {
      customer_id: string;
      customer_name: string;
      customer_phone: string | null;
    })[]
  >(
    `SELECT e.id, e.status::text AS status, e.wanted_from, e.wanted_to,
            e.window_start_minute, e.window_end_minute, e.duration_minutes,
            e.professional_id, p.name AS professional_name, e.joined_at,
            e.customer_id, c.name AS customer_name, c.phone_e164 AS customer_phone,
            array_remove(array_agg(s.name ORDER BY es.position), NULL) AS services
       FROM waitlist_entries e
       JOIN customers c ON c.id = e.customer_id
       LEFT JOIN professionals p ON p.id = e.professional_id
       LEFT JOIN waitlist_entry_services es ON es.entry_id = e.id
       LEFT JOIN services s ON s.id = es.service_id
      WHERE e.location_id = $1::uuid
        AND e.status = 'waiting'
        AND e.wanted_from <= $2::date
        AND e.wanted_to >= $2::date
      GROUP BY e.id, p.name, c.name, c.phone_e164
      ORDER BY e.joined_at`,
    params.locationId,
    params.vaga.dia,
  );

  /** O casamento fino vem **antes** da ordem: quem não cabe não é ordenado. */
  const cabem = linhas.filter((linha) =>
    vagaServe(
      {
        de: diaDe(linha.wanted_from),
        ate: diaDe(linha.wanted_to),
        janela: { start: linha.window_start_minute, end: linha.window_end_minute },
        profissionalId: linha.professional_id,
        duracaoMinutos: linha.duration_minutes,
      },
      params.vaga,
    ),
  );
  if (cabem.length === 0) return [];

  const agora = params.agora ?? new Date();
  const limiar = (await limiaresDoScore(tx, params.locationId)).confiavelNaEspera;
  const confiancas = await confiancaDeVarios(
    tx,
    cabem.map((l) => l.customer_id),
    agora,
  );

  return cabem
    .map((linha) => ({
      linha,
      // Ausente é impossível: `confiancaDeVarios` devolve uma entrada por id
      // pedido. O `??` existe porque o tipo não sabe disso, e um `!` para calar
      // o compilador é o que este projeto não aceita.
      prioritario: temPrioridadeNaEspera(
        confiancas.get(linha.customer_id) ?? { score: 100, considerados: 0, temEfeito: false },
        limiar,
      ),
    }))
    .sort((a, b) => {
      // Confiabilidade primeiro; empate volta a ser a ordem de chegada, que o
      // `ORDER BY` do banco já garantiu — `sort` do JavaScript é estável.
      if (a.prioritario !== b.prioritario) return a.prioritario ? -1 : 1;
      return 0;
    })
    .map(({ linha }) => ({
      ...daLinha(linha),
      customerId: linha.customer_id,
      customerNome: linha.customer_name,
      customerTelefoneFinal: linha.customer_phone ? linha.customer_phone.slice(-4) : null,
    }));
}

/**
 * Fecha as esperas que este agendamento acabou de satisfazer.
 *
 * A SPEC §2.9 pede: "cliente sai da fila **automaticamente** ao conseguir
 * agendar". Sem isto, `booked` seria um estado que nada escreve — a pessoa
 * marcaria o sábado pelo site, continuaria na lista de espera do sábado, e
 * seria chamada para uma vaga que ela já não quer. Pior: a entrada seguiria
 * ocupando uma das três vagas dela.
 *
 * Fecha **só o que o agendamento de fato satisfaz**, pela mesma regra que casa
 * vaga com pedido. Quem esperava sábado de manhã e conseguiu marcar sábado à
 * tarde continua esperando a manhã — era o que ela pediu, e desistir por ela
 * seria decidir no lugar dela.
 *
 * Na mesma transação da reserva: se o horário entra, a espera fecha; se a
 * transação volta atrás, a espera continua viva.
 */
export async function fecharEsperasAtendidas(
  tx: TransactionClient,
  params: {
    readonly customerId: string;
    readonly locationId: string;
    readonly appointmentId: string;
    readonly vaga: VagaAberta;
  },
): Promise<number> {
  const linhas = await tx.$queryRawUnsafe<LinhaDaEspera[]>(
    `${SELECT_DA_ESPERA}
      WHERE e.customer_id = $1::uuid
        AND e.location_id = $2::uuid
        AND e.status = 'waiting'
        AND e.wanted_from <= $3::date
        AND e.wanted_to >= $3::date
      GROUP BY e.id, p.name`,
    params.customerId,
    params.locationId,
    params.vaga.dia,
  );

  const atendidas = linhas.filter((linha) =>
    vagaServe(
      {
        de: diaDe(linha.wanted_from),
        ate: diaDe(linha.wanted_to),
        janela: { start: linha.window_start_minute, end: linha.window_end_minute },
        profissionalId: linha.professional_id,
        duracaoMinutos: linha.duration_minutes,
      },
      params.vaga,
    ),
  );
  if (atendidas.length === 0) return 0;

  return tx.$executeRaw`
    UPDATE waitlist_entries
       SET status = 'booked', closed_at = now(),
           appointment_id = ${params.appointmentId}::uuid, updated_at = now()
     WHERE id = ANY(${atendidas.map((a) => a.id)}::uuid[])
       AND status = 'waiting'
  `;
}

/**
 * Quem quer a vaga que este cancelamento acabou de abrir.
 *
 * Chamada dos **dois** caminhos de cancelamento — a tela do cliente e o painel
 * do balcão —, e sempre dentro da transação que abriu a vaga. Uma cópia em cada
 * um deixaria os dois divergirem no primeiro ajuste da regra, e o balcão é
 * justamente onde a maioria dos cancelamentos acontece.
 *
 * Erro aqui **não derruba o cancelamento**: desmarcar é a operação que a pessoa
 * pediu, e ela não pode falhar porque uma consulta auxiliar falhou. Lista vazia
 * é indistinguível de "ninguém quer", e é o pior que acontece.
 */
export async function quemQuerAVagaLiberada(
  tx: TransactionClient,
  appointmentId: string,
  /** O relógio do cancelamento, para a janela de doze meses do score (bloco 60). */
  agora?: Date,
): Promise<readonly CandidatoDaVaga[]> {
  const linhas = await tx.$queryRaw<
    {
      location_id: string;
      professional_id: string;
      starts_at: Date;
      ends_at: Date;
      timezone: string;
    }[]
  >`
    SELECT a.location_id, a.professional_id, a.starts_at, a.ends_at, l.timezone
      FROM appointments a
      JOIN locations l ON l.id = a.location_id
     WHERE a.id = ${appointmentId}::uuid
  `;
  const linha = linhas[0];
  if (!linha) return [];

  return candidatosDaVaga(tx, {
    locationId: linha.location_id,
    vaga: vagaDoCancelamento({
      timezone: linha.timezone,
      inicio: linha.starts_at,
      fim: linha.ends_at,
      professionalId: linha.professional_id,
    }),
    ...(agora ? { agora } : {}),
  });
}

/**
 * A vaga que este cancelamento abriu, no fuso da unidade.
 *
 * A janela é a **ocupada**, com buffers — é o buraco de verdade na grade, e é o
 * que outro atendimento poderia preencher. Usar a janela de serviço deixaria de
 * fora os minutos de arrumação, e a vaga anunciada não caberia.
 */
export function vagaDoCancelamento(params: {
  readonly timezone: string;
  readonly inicio: Date;
  readonly fim: Date;
  readonly professionalId: string;
}): VagaAberta {
  const de = instantToLocal(params.timezone, params.inicio);
  const ate = instantToLocal(params.timezone, params.fim);
  return {
    dia: de.date,
    janela: { start: de.minutes, end: ate.minutes },
    profissionalId: params.professionalId,
  };
}

/**
 * Quem está esperando, para o balcão.
 *
 * Ordenada por dia pedido e depois por entrada na fila: a barbearia lê "quem
 * quer o sábado" antes de "quem entrou primeiro", porque a primeira pergunta é
 * a que ela consegue responder com a agenda na frente.
 *
 * Numa consulta, com nome e serviços agregados. Uma ida ao banco por entrada
 * seria N+1 numa tela que o dono abre para decidir se vale abrir mais um
 * horário no sábado.
 */
/**
 * O convite que esta pessoa tem na mão agora (bloco 39).
 *
 * Sem isto, o balcão lê "seis pessoas esperando o sábado" e não sabe que uma
 * delas já foi chamada para as 9h — e liga para oferecer o mesmo horário que o
 * produto está segurando para ela. O horário some da grade e ninguém sabe por
 * quê, que é o pior jeito de a exclusividade aparecer.
 */
export interface ConviteVivo {
  /** `HH:mm` local da unidade — a hora do corte, não a da arrumação. */
  readonly hora: string;
  readonly dia: string;
  /** Zero quando o prazo já passou e a varredura ainda não rodou. */
  readonly minutosRestantes: number;
}

export interface QuemEspera extends CandidatoDaVaga {
  readonly convite: ConviteVivo | null;
}

export async function quemEstaEsperando(
  tenantId: string,
  locationId: string,
  /**
   * Restringe a uma agenda só, como `getDayBoard` e `getAgenda`.
   *
   * A entrada **sem profissional** aparece de qualquer jeito: qualquer um pode
   * atendê-la, e escondê-la do barbeiro seria esconder justamente o cliente que
   * ele consegue pegar. A que nomeia um colega, não — sem o recorte, quem
   * enxerga só a própria agenda lia a lista da barbearia inteira por esta
   * porta. Achado da revisão de segurança deste bloco.
   */
  onlyProfessionalId: string | null = null,
  agora: Date = new Date(),
): Promise<readonly QuemEspera[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRawUnsafe<
      (LinhaDaEspera & {
        customer_id: string;
        customer_name: string;
        customer_phone: string | null;
        convite_em: Date | null;
        convite_vence: Date | null;
        timezone: string;
      })[]
    >(
      `SELECT e.id, e.status::text AS status, e.wanted_from, e.wanted_to,
              e.window_start_minute, e.window_end_minute, e.duration_minutes,
              e.professional_id, p.name AS professional_name, e.joined_at,
              e.customer_id, c.name AS customer_name, c.phone_e164 AS customer_phone,
              l.timezone,
              o.service_starts_at AS convite_em, o.expires_at AS convite_vence,
              array_remove(array_agg(s.name ORDER BY es.position), NULL) AS services
         FROM waitlist_entries e
         JOIN customers c ON c.id = e.customer_id
         JOIN locations l ON l.id = e.location_id
         LEFT JOIN professionals p ON p.id = e.professional_id
         LEFT JOIN waitlist_entry_services es ON es.entry_id = e.id
         LEFT JOIN services s ON s.id = es.service_id
         -- O convite vivo entra na mesma consulta: uma ida ao banco por pessoa
         -- seria N+1 numa tela que o dono abre para decidir o sábado.
         LEFT JOIN waitlist_offers o
                ON o.entry_id = e.id AND o.status IN ('aberta', 'aceitando')
        WHERE e.location_id = $1::uuid AND e.status = 'waiting'
          AND ($2::uuid IS NULL
               OR e.professional_id IS NULL
               OR e.professional_id = $2::uuid)
        GROUP BY e.id, p.name, c.name, c.phone_e164, l.timezone,
                 o.service_starts_at, o.expires_at
        ORDER BY e.wanted_from, e.window_start_minute, e.joined_at`,
      locationId,
      onlyProfessionalId,
    );

    return linhas.map((linha) => ({
      ...daLinha(linha),
      customerId: linha.customer_id,
      customerNome: linha.customer_name,
      customerTelefoneFinal: linha.customer_phone ? linha.customer_phone.slice(-4) : null,
      convite: conviteDaLinha(linha, agora),
    }));
  });
}

function conviteDaLinha(
  linha: { convite_em: Date | null; convite_vence: Date | null; timezone: string },
  agora: Date,
): ConviteVivo | null {
  if (!linha.convite_em || !linha.convite_vence) return null;
  const local = instantToLocal(linha.timezone, linha.convite_em);
  return {
    dia: local.date,
    hora: formatHHMM(local.minutes),
    minutosRestantes: Math.max(
      0,
      Math.ceil((linha.convite_vence.getTime() - agora.getTime()) / 60_000),
    ),
  };
}

/**
 * Marca como expirada toda entrada cujo último dia já passou.
 *
 * Roda na varredura diária. O recorte é feito **no banco**, com a data local da
 * unidade calculada pelo próprio Postgres a partir do fuso dela: comparar com a
 * data do processo expiraria o sábado da barbearia de Salvador às 21h de sexta,
 * quando o servidor em UTC já virou o dia.
 */
export async function expirarEsperas(tenantId: string, agora: Date): Promise<number> {
  return withTenant(tenantId, async (tx) => {
    return tx.$executeRaw`
      UPDATE waitlist_entries e
         SET status = 'expired', closed_at = ${agora}, updated_at = now()
        FROM locations l
       WHERE l.id = e.location_id
         AND e.status = 'waiting'
         AND e.wanted_to < (${agora} AT TIME ZONE l.timezone)::date
    `;
  });
}

/** `YYYY-MM-DD` do instante, no fuso da unidade. */
function diaLocal(timezone: string, agora: Date): string {
  return instantToLocal(timezone, agora).date;
}

/** Soma dias a uma data `YYYY-MM-DD`, sem trazer fuso para dentro da conta. */
function somarDias(dia: string, dias: number): string {
  const base = new Date(`${dia}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + dias);
  return base.toISOString().slice(0, 10);
}
