import { withTenant } from '@barbearia/db';
import { maskPhone } from '@barbearia/core';

/**
 * O que o balcão precisa para marcar alguém que chegou sem horário.
 *
 * Duas coisas: achar quem já é cliente (para não criar o terceiro cadastro da
 * mesma pessoa) e saber o que a casa vende.
 */

/**
 * Piso da busca.
 *
 * Uma letra devolveria quase a base inteira a cada tecla — e a base de clientes
 * de uma barbearia é o ativo dela. Três caracteres é o que separa "procurar"
 * de "listar".
 */
export const MIN_SEARCH_LENGTH = 3;

/**
 * Neutraliza os curingas do LIKE, **em SQL e depois de `sem_acento`**.
 *
 * A primeira versão escapava em TypeScript, antes da consulta, e não valia
 * nada: `unaccent` transforma `％` (U+FF05, o sinal de porcentagem de largura
 * inteira) em `%`, e `＿` em `_`. Como não são ASCII, o escape em JavaScript não
 * os via; a transformação vinha **depois** e devolvia o curinga já dentro do
 * padrão. Buscar `％％％` virava `LIKE '%%%%%'` e entregava a base inteira da
 * barbearia — exatamente o que o piso de três caracteres existe para impedir.
 *
 * A lição é a ordem, não o alfabeto: escapar antes de uma transformação que
 * pode **produzir** o caractere escapado não protege nada. Por isso o escape
 * mora dentro da consulta, como último passo do padrão — ver `searchCustomers`.
 *
 * A barra invertida é escapada primeiro, senão as barras que o próprio escape
 * introduz seriam escapadas de novo. E é ela que exige o `ESCAPE '\'` explícito
 * no fim: sem isso, um termo terminado em barra deixaria o padrão com escape
 * pendurado e o Postgres devolveria 22025, que a tela veria como erro genérico.
 */

export interface CustomerHit {
  readonly id: string;
  readonly name: string;
  /** Mascarado: a tela do balcão fica virada para o salão. */
  /**
   * Nulo depois da anonimização (bloco 32).
   *
   * Na prática a busca não devolve cadastro anonimizado — as duas consultas o
   * excluem. O tipo aceita nulo mesmo assim porque a coluna aceita, e um tipo
   * que mente sobre o banco é como o `.slice(-4)` da ficha quebrou.
   */
  readonly phoneMasked: string | null;
  readonly lastVisitAt: string | null;
  /** Quantas vezes faltou. É o que faz a recepção pedir confirmação. */
  readonly noShows: number;
}

interface CustomerRow {
  id: string;
  name: string;
  phone_e164: string | null;
  last_visit: Date | null;
  no_shows: bigint;
}

function toHit(row: CustomerRow): CustomerHit {
  return {
    id: row.id,
    name: row.name,
    phoneMasked: row.phone_e164 === null ? null : maskPhone(row.phone_e164),
    lastVisitAt: row.last_visit?.toISOString() ?? null,
    noShows: Number(row.no_shows),
  };
}

/**
 * Acha o cliente pelo que a recepção tem em mãos: um pedaço do nome ou os
 * últimos dígitos do celular.
 *
 * O nome é comparado sem acento e sem caixa, pela mesma expressão que está no
 * índice — "joao" acha "João". Comparar de um jeito e indexar de outro daria
 * varredura sequencial silenciosa.
 *
 * São duas consultas distintas de propósito, não uma com `CASE` no `WHERE`: o
 * planejador não consegue provar qual ramo vale e acabaria varrendo a tabela nos
 * dois casos, perdendo os índices da migração 0015.
 *
 * Nenhuma delas repete `tenant_id` no filtro — quem separa barbearias é a RLS
 * (CLAUDE.md §2). O índice de telefone carrega a coluna porque o B-tree precisa
 * dela como prefixo, não porque a consulta filtra por ela.
 */
export async function searchCustomers(params: {
  readonly tenantId: string;
  readonly query: string;
  readonly limit?: number;
}): Promise<readonly CustomerHit[]> {
  const termo = params.query.trim();
  if (termo.length < MIN_SEARCH_LENGTH) return [];

  const limite = Math.min(params.limit ?? 10, 25);
  const digitos = termo.replace(/\D/g, '');
  // Só trata como telefone o que **é** telefone. "R2D2" tem dígitos e não é.
  const porTelefone = digitos.length >= 4 && /^[\d\s()+.\-]+$/.test(termo);

  return withTenant(params.tenantId, async (tx) => {
    // Histórico numa lateral só: duas subconsultas por linha seriam duas idas
    // ao mesmo índice para responder à mesma pergunta.
    const linhas = porTelefone
      ? await tx.$queryRaw<CustomerRow[]>`
          SELECT c.id, c.name, c.phone_e164, h.last_visit, h.no_shows
          FROM customers c
          LEFT JOIN LATERAL (
            SELECT max(service_starts_at) FILTER (WHERE status = 'completed') AS last_visit,
                   count(*) FILTER (WHERE status = 'no_show') AS no_shows
            FROM appointments WHERE customer_id = c.id
          ) h ON true
          WHERE c.anonymized_at IS NULL
            AND reverse(c.phone_e164) LIKE ${`${[...digitos].reverse().join('')}%`}
          ORDER BY c.name
          LIMIT ${limite}
        `
      : await tx.$queryRaw<CustomerRow[]>`
          SELECT c.id, c.name, c.phone_e164, h.last_visit, h.no_shows
          FROM customers c
          LEFT JOIN LATERAL (
            SELECT max(service_starts_at) FILTER (WHERE status = 'completed') AS last_visit,
                   count(*) FILTER (WHERE status = 'no_show') AS no_shows
            FROM appointments WHERE customer_id = c.id
          ) h ON true
          -- Cadastro anonimizado não é achável no balcão (bloco 32). Cortar o
          -- vínculo com a pessoa e continuar devolvendo a linha na busca seria
          -- desfazer a anonimização na única tela onde ela importa.
          WHERE c.anonymized_at IS NULL
            AND sem_acento(lower(c.name)) LIKE
                '%' || replace(replace(replace(
                  sem_acento(lower(${termo})), '\\', '\\\\'), '%', '\\%'), '_', '\\_'
                ) || '%' ESCAPE '\\'
          ORDER BY c.name
          LIMIT ${limite}
        `;

    return linhas.map(toHit);
  });
}

/**
 * Confirma que o cliente é **desta** barbearia, e devolve o nome.
 *
 * Indispensável antes de gravar um agendamento com `customer_id` vindo da tela.
 * A chave estrangeira de `appointments.customer_id` aponta para `customers.id`
 * sem passar pelo tenant, e a checagem de integridade referencial do Postgres
 * não é filtrada pela RLS — um id de cliente de outra barbearia seria aceito
 * pelo banco. Aqui a leitura passa pela política, então id alheio volta `null`.
 */
export async function findCustomer(
  tenantId: string,
  customerId: string,
): Promise<{ readonly id: string; readonly name: string } | null> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ id: string; name: string }[]>`
      SELECT id, name FROM customers WHERE id = ${customerId}::uuid
    `;
    return linhas[0] ?? null;
  });
}

export interface CounterCatalog {
  readonly services: readonly {
    readonly id: string;
    readonly name: string;
    readonly durationMinutes: number;
    readonly priceCents: number;
  }[];
  readonly professionals: readonly { readonly id: string; readonly name: string }[];
}

/** Serviços e equipe ativos da unidade, para montar a marcação pelo balcão. */
export async function getCounterCatalog(
  tenantId: string,
  locationId: string,
): Promise<CounterCatalog> {
  return withTenant(tenantId, async (tx) => {
    const servicos = await tx.$queryRaw<
      { id: string; name: string; duration_minutes: number; price_cents: number }[]
    >`
      SELECT id, name, duration_minutes, price_cents
      FROM services WHERE active ORDER BY name
    `;

    const equipe = await tx.$queryRaw<{ id: string; name: string }[]>`
      SELECT id, name FROM professionals
      WHERE location_id = ${locationId}::uuid AND active AND kind = 'professional'
      ORDER BY name
    `;

    return {
      services: servicos.map((s) => ({
        id: s.id,
        name: s.name,
        durationMinutes: s.duration_minutes,
        priceCents: s.price_cents,
      })),
      professionals: equipe,
    };
  });
}
