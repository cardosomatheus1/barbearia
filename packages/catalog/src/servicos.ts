import { withTenant, type TransactionClient } from '@barbearia/db';
import { validateCombos } from '@barbearia/core';

/**
 * Catálogo, no dia a dia.
 *
 * `packages/onboarding` grava o cardápio **inteiro de uma vez**: desativa tudo
 * e recria, porque a pergunta dele é "monte a barbearia". A pergunta daqui é
 * outra — "mude o preço do corte" — e ela acontece toda semana.
 *
 * A diferença não é de estilo. Reenviar os nove serviços para mudar um preço
 * cria ids novos para os oito que não mudaram, e todo agendamento existente
 * passa a apontar para um serviço desativado. É por isso que existem dois
 * módulos sobre a mesma tabela, e por isso este nunca recria linha.
 *
 * **Nada aqui apaga.** Serviço sai de catálogo virando `active = false`: o
 * histórico que alimenta relatório e comissão aponta para ele, e apagar levaria
 * o passado junto.
 */

export type CatalogFailure =
  | 'service_not_found'
  | 'professional_not_found'
  | 'invalid_catalog'
  | 'name_taken'
  | 'category_not_found'
  // Bloco 58: a unidade tem nome, existe, e a última aberta não fecha.
  | 'invalid_location'
  | 'location_not_found'
  | 'ultima_unidade'
  // Bloco 73: o perfil público do barbeiro.
  | 'too_many_specialties'
  | 'invalid_public_slug';

export class CatalogError extends Error {
  constructor(
    readonly code: CatalogFailure,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'CatalogError';
  }
}

export interface Servico {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly priceCents: number;
  readonly durationMinutes: number;
  readonly bufferBeforeMinutes: number;
  readonly bufferAfterMinutes: number;
  readonly bookableOnline: boolean;
  readonly active: boolean;
  readonly photoUrl: string | null;
  /**
   * Este serviço sempre pede sinal, qualquer que seja o histórico do cliente.
   *
   * O quarto termo da SPEC §2.12, e ele existe para o serviço caro e demorado —
   * a coloração de três horas — em que a falta custa a tarde inteira,
   * independentemente de quem faltou.
   */
  readonly alwaysRequireDeposit: boolean;
  /** Componentes, quando este serviço é vendido como combo. */
  readonly componentIds: readonly string[];
  /** Ganho declarado por fazer os componentes na sequência, em minutos. */
  readonly comboToleranceMinutes: number;
  /** Quantos agendamentos futuros ainda apontam para ele. */
  readonly futureAppointments: number;
  /**
   * A ficha de consumo: quanto de cada insumo este serviço gasta (bloco 44).
   *
   * Vem junto do catálogo e não numa segunda chamada porque a tela que edita o
   * serviço é a mesma que edita a ficha — e uma ida ao banco por serviço seria
   * N+1 na tela que o dono mais abre depois do balcão.
   */
  readonly consumiveis: Readonly<Record<string, number>>;
}

export interface Categoria {
  readonly id: string;
  readonly name: string;
  readonly position: number;
}

interface ServicoRow {
  id: string;
  name: string;
  description: string | null;
  category_id: string | null;
  category_name: string | null;
  price_cents: number;
  duration_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  bookable_online: boolean;
  active: boolean;
  photo_url: string | null;
  always_require_deposit: boolean;
  component_ids: string[] | null;
  combo_tolerance_minutes: number | null;
  future_appointments: bigint;
  consumiveis: Record<string, number> | null;
}

function toServico(row: ServicoRow): Servico {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    categoryId: row.category_id,
    categoryName: row.category_name,
    priceCents: row.price_cents,
    durationMinutes: row.duration_minutes,
    bufferBeforeMinutes: row.buffer_before_minutes,
    bufferAfterMinutes: row.buffer_after_minutes,
    bookableOnline: row.bookable_online,
    active: row.active,
    photoUrl: row.photo_url,
    alwaysRequireDeposit: row.always_require_deposit,
    componentIds: row.component_ids ?? [],
    comboToleranceMinutes: row.combo_tolerance_minutes ?? 0,
    futureAppointments: Number(row.future_appointments),
    consumiveis: row.consumiveis ?? {},
  };
}

/**
 * O catálogo inteiro, ativo e inativo.
 *
 * Numa consulta só, com os componentes de combo e a contagem de agendamentos
 * futuros agregados por subconsulta. Buscar componentes por serviço num laço
 * seria N+1 na tela que o dono mais abre depois do balcão.
 *
 * A contagem de futuros existe para a tela poder avisar antes: desativar um
 * serviço com dez horários marcados não é o mesmo que desativar um que ninguém
 * pediu.
 */
export async function listServices(
  tenantId: string,
  now: Date = new Date(),
): Promise<{ readonly services: readonly Servico[]; readonly categories: readonly Categoria[] }> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<ServicoRow[]>`
      SELECT s.id, s.name, s.description, s.category_id, c.name AS category_name,
             s.price_cents, s.duration_minutes,
             s.buffer_before_minutes, s.buffer_after_minutes,
             s.bookable_online, s.active, s.photo_url, s.always_require_deposit,
             (SELECT array_agg(scc.service_id::text)
                FROM service_combos sc
                JOIN service_combo_components scc ON scc.combo_id = sc.id
               WHERE sc.name = s.name) AS component_ids,
             (SELECT sc.tolerance_minutes FROM service_combos sc
               WHERE sc.name = s.name) AS combo_tolerance_minutes,
             (SELECT count(*) FROM appointment_services aps
                JOIN appointments a ON a.id = aps.appointment_id
               WHERE aps.service_id = s.id
                 AND a.service_starts_at >= ${now}
                 AND a.status IN ('pending', 'confirmed', 'checked_in', 'waiting')
             ) AS future_appointments,
             (SELECT jsonb_object_agg(sc2.product_id::text, sc2.quantity)
                FROM service_consumables sc2
               WHERE sc2.service_id = s.id) AS consumiveis
      FROM services s
      LEFT JOIN service_categories c ON c.id = s.category_id
      ORDER BY s.active DESC, c.position NULLS LAST, c.name NULLS LAST, s.name
    `;

    const categorias = await tx.$queryRaw<{ id: string; name: string; position: number }[]>`
      SELECT id, name, position FROM service_categories ORDER BY position, name
    `;

    return {
      services: linhas.map(toServico),
      categories: categorias.map((c) => ({ id: c.id, name: c.name, position: c.position })),
    };
  });
}

export interface ServiceInput {
  readonly name: string;
  readonly description?: string | null;
  readonly categoryName: string;
  readonly priceCents: number;
  readonly durationMinutes: number;
  readonly bufferBeforeMinutes: number;
  readonly bufferAfterMinutes: number;
  readonly bookableOnline: boolean;
  /**
   * Sempre exigir sinal deste serviço (bloco 37).
   *
   * Opcional para que as telas que ainda não o mandam continuem funcionando, e
   * o padrão é `false` — que é o comportamento anterior, como manda a regra de
   * configuração que mexe em dinheiro.
   */
  readonly alwaysRequireDeposit?: boolean;
  /** Ids de serviços que este combina. Vazio significa serviço simples. */
  readonly componentIds?: readonly string[];
  /**
   * Quanto a casa ganha fazendo os serviços na sequência, em minutos.
   *
   * Entra por aqui porque a regra V1 do validador a exige (SPEC §5.7), e sem
   * origem de dado ela seria mais um campo que o motor aceita e ninguém
   * preenche. O padrão é zero: combo cadastrado sem ninguém pensar no assunto
   * **tem** que aparecer no validador — é o defeito D4.
   */
  readonly comboToleranceMinutes?: number;
}

/** Acha ou cria a categoria. Categoria é rótulo, não cadastro à parte. */
async function categoriaId(tx: TransactionClient, nome: string): Promise<string> {
  const linhas = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO service_categories (tenant_id, name, position)
    VALUES (
      NULLIF(current_setting('app.tenant_id', true), '')::uuid,
      ${nome},
      COALESCE((SELECT max(position) + 1 FROM service_categories), 0)
    )
    ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;
  const id = linhas[0]?.id;
  if (!id) throw new CatalogError('category_not_found', 'Não foi possível criar a categoria');
  return id;
}

/**
 * Confere a coerência de combo antes de gravar.
 *
 * O combo é lido do banco junto com o que está sendo salvo, porque a incoerência
 * pode nascer dos dois lados: encurtar o combo, ou **alongar uma parte dele**.
 * Validar só o que veio no formulário deixaria passar o segundo caso — e o
 * segundo é o que acontece na prática, porque ninguém abre a tela do combo para
 * mudar a duração da barba.
 *
 * É o defeito D4 (SPEC §2.2) barrado na edição, não só no cadastro inicial.
 */
async function exigirCombosCoerentes(
  tx: TransactionClient,
  alterado: { readonly id?: string; readonly durationMinutes: number; readonly priceCents: number },
  componentIdsDoAlterado: readonly string[] | undefined,
): Promise<void> {
  const linhas = await tx.$queryRaw<
    { id: string; duration_minutes: number; price_cents: number; component_ids: string[] | null }[]
  >`
    SELECT s.id, s.duration_minutes, s.price_cents,
           (SELECT array_agg(scc.service_id::text)
              FROM service_combos sc
              JOIN service_combo_components scc ON scc.combo_id = sc.id
             WHERE sc.name = s.name) AS component_ids
    FROM services s WHERE s.active
  `;

  const catalogo = linhas.map((linha) => ({
    key: linha.id,
    durationMinutes: linha.id === alterado.id ? alterado.durationMinutes : linha.duration_minutes,
    priceCents: linha.id === alterado.id ? alterado.priceCents : linha.price_cents,
    ...(linha.id === alterado.id
      ? componentIdsDoAlterado?.length
        ? { componentKeys: [...componentIdsDoAlterado] }
        : {}
      : linha.component_ids?.length
        ? { componentKeys: linha.component_ids }
        : {}),
  }));

  // Serviço novo ainda não está na tabela.
  if (!alterado.id) {
    catalogo.push({
      key: 'novo',
      durationMinutes: alterado.durationMinutes,
      priceCents: alterado.priceCents,
      ...(componentIdsDoAlterado?.length ? { componentKeys: [...componentIdsDoAlterado] } : {}),
    });
  }

  const problemas = validateCombos(catalogo);
  if (problemas.length > 0) {
    throw new CatalogError(
      'invalid_catalog',
      'Confira as durações: um combo está prometendo menos tempo do que as partes levam.',
      problemas,
    );
  }
}

/**
 * Confere, sob RLS, que todo id enviado é serviço **desta** barbearia.
 *
 * A chave estrangeira do Postgres não passa pela política: a documentação diz
 * que a checagem de integridade referencial sempre ignora row security. Sem
 * esta consulta, um id de serviço de outra barbearia entra em
 * `professional_services` ou em `service_combo_components` sem erro — o
 * `tenant_id` da linha vem de `current_setting`, então o `WITH CHECK` aprova, e
 * a única coisa que reprovaria seria a FK, que não olha.
 *
 * O estrago é duplo e nenhuma metade some sozinha: vira oráculo de existência
 * (id inexistente estoura, id de outra barbearia responde 201) e deixa uma
 * referência atravessada que a outra barbearia apaga em cascata sem saber.
 *
 * É a mesma checagem que `identificar()` faz no balcão antes de gravar
 * `appointments.customer_id`, e pelo mesmo motivo.
 */
export async function exigirServicosDoTenant(
  tx: TransactionClient,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;

  const encontrados = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM services WHERE id = ANY(${[...ids]}::uuid[])
  `;

  // Recusar, não descartar em silêncio: sumir com o id faria a tela mostrar uma
  // habilidade a menos sem dizer por quê, e quem enviou lixo continuaria sem
  // saber. E a mensagem não distingue "não existe" de "é de outra barbearia" —
  // a diferença é justamente o que o oráculo procurava.
  if (encontrados.length !== new Set(ids).size) {
    throw new CatalogError('service_not_found', 'Um dos serviços informados não existe.');
  }
}

/** Grava o vínculo de combo, sempre reescrevendo o conjunto de componentes. */
async function gravarCombo(
  tx: TransactionClient,
  nome: string,
  duracao: number,
  componentIds: readonly string[] | undefined,
  toleranciaMinutos = 0,
): Promise<void> {
  await tx.$executeRaw`
    DELETE FROM service_combos WHERE name = ${nome}
  `;
  if (!componentIds || componentIds.length < 2) return;
  await exigirServicosDoTenant(tx, componentIds);

  const criado = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO service_combos
      (tenant_id, name, declared_duration_minutes, tolerance_minutes)
    VALUES (
      NULLIF(current_setting('app.tenant_id', true), '')::uuid,
      ${nome}, ${duracao}, ${toleranciaMinutos}
    )
    RETURNING id
  `;
  const comboId = criado[0]?.id;
  if (!comboId) return;

  for (const componente of componentIds) {
    await tx.$executeRaw`
      INSERT INTO service_combo_components (combo_id, service_id, tenant_id)
      VALUES (${comboId}::uuid, ${componente}::uuid,
              NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      ON CONFLICT DO NOTHING
    `;
  }
}

export async function createService(
  tenantId: string,
  input: ServiceInput,
): Promise<{ readonly id: string }> {
  return withTenant(tenantId, async (tx) => {
    // Antes da coerência, não depois: a validação de combo rejeitaria um
    // componente invisível de tabela, mas por ser incoerente — e depender disso
    // amarraria o isolamento entre barbearias ao comportamento do validador de
    // duração, que existe para outra coisa.
    await exigirServicosDoTenant(tx, input.componentIds ?? []);
    await exigirCombosCoerentes(tx, input, input.componentIds);

    const categoria = await categoriaId(tx, input.categoryName);
    const linhas = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO services
        (tenant_id, category_id, name, description, price_cents, duration_minutes,
         buffer_before_minutes, buffer_after_minutes, bookable_online, active,
         always_require_deposit)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${categoria}::uuid, ${input.name}, ${input.description ?? null},
        ${input.priceCents}, ${input.durationMinutes},
        ${input.bufferBeforeMinutes}, ${input.bufferAfterMinutes},
        ${input.bookableOnline}, true, ${input.alwaysRequireDeposit ?? false}
      )
      RETURNING id
    `;
    const id = linhas[0]?.id;
    if (!id) throw new CatalogError('service_not_found', 'Não foi possível criar o serviço');

    await gravarCombo(
      tx,
      input.name,
      input.durationMinutes,
      input.componentIds,
      input.comboToleranceMinutes ?? 0,
    );

    // Serviço novo nasce habilitado para quem já faz tudo. Sem isto ele some da
    // grade e o dono descobre pela reclamação de que "o site não deixa marcar".
    await tx.$executeRaw`
      INSERT INTO professional_services (professional_id, service_id, tenant_id)
      SELECT p.id, ${id}::uuid, p.tenant_id
      FROM professionals p
      WHERE p.active AND p.kind = 'professional'
      ON CONFLICT DO NOTHING
    `;

    return { id };
  });
}

/**
 * Edita um serviço **no lugar**.
 *
 * O id sobrevive, e é isso que importa: `appointment_services` guarda o preço e
 * a duração praticados no momento da reserva, então mudar o catálogo não
 * reescreve o passado — mas só se a linha for a mesma.
 */
export async function updateService(
  tenantId: string,
  serviceId: string,
  input: ServiceInput,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const existe = await tx.$queryRaw<{ name: string }[]>`
      SELECT name FROM services WHERE id = ${serviceId}::uuid
    `;
    const anterior = existe[0];
    if (!anterior) throw new CatalogError('service_not_found', 'Serviço não encontrado.');

    await exigirServicosDoTenant(tx, input.componentIds ?? []);
    await exigirCombosCoerentes(tx, { id: serviceId, ...input }, input.componentIds);

    const categoria = await categoriaId(tx, input.categoryName);
    await tx.$executeRaw`
      UPDATE services SET
        category_id = ${categoria}::uuid,
        name = ${input.name},
        description = ${input.description ?? null},
        price_cents = ${input.priceCents},
        duration_minutes = ${input.durationMinutes},
        buffer_before_minutes = ${input.bufferBeforeMinutes},
        buffer_after_minutes = ${input.bufferAfterMinutes},
        bookable_online = ${input.bookableOnline},
        -- Ausente significa "não mexa", não "desligue".
        --
        -- O campo é opcional na borda e a tela de cardápio anterior não o
        -- manda. Escrevendo falso quando ele falta, qualquer edição sem relação
        -- — corrigir uma descrição, ajustar um preço — apagaria em silêncio a
        -- exigência de sinal da coloração, que é justamente o serviço em que a
        -- falta custa a tarde inteira. É o mesmo desenho de saveChangeWindow,
        -- que só escreve o que o formulário traz. Achado da revisão de
        -- segurança deste bloco.
        always_require_deposit = COALESCE(
          ${input.alwaysRequireDeposit ?? null}::boolean, always_require_deposit
        ),
        updated_at = now()
      WHERE id = ${serviceId}::uuid
    `;

    // O combo é ligado ao serviço pelo **nome**; renomear precisa levar o
    // vínculo junto, senão o combo antigo fica órfão e o novo nunca existe.
    if (anterior.name !== input.name) {
      await tx.$executeRaw`DELETE FROM service_combos WHERE name = ${anterior.name}`;
    }
    await gravarCombo(
      tx,
      input.name,
      input.durationMinutes,
      input.componentIds,
      input.comboToleranceMinutes ?? 0,
    );
  });
}

/**
 * Tira do catálogo, ou devolve.
 *
 * Nunca apaga. E devolve quantos agendamentos futuros continuam apontando para
 * ele: desativar não cancela nada — quem já marcou continua marcado, e é a
 * recepção que decide o que fazer com essa lista.
 */
export async function setServiceActive(
  tenantId: string,
  serviceId: string,
  active: boolean,
  now: Date = new Date(),
): Promise<{ readonly futureAppointments: number }> {
  return withTenant(tenantId, async (tx) => {
    const afetadas = await tx.$executeRaw`
      UPDATE services SET active = ${active}, updated_at = now()
      WHERE id = ${serviceId}::uuid
    `;
    if (afetadas === 0) throw new CatalogError('service_not_found', 'Serviço não encontrado.');

    const linhas = await tx.$queryRaw<{ total: bigint }[]>`
      SELECT count(*) AS total
      FROM appointment_services aps
      JOIN appointments a ON a.id = aps.appointment_id
      WHERE aps.service_id = ${serviceId}::uuid
        AND a.service_starts_at >= ${now}
        AND a.status IN ('pending', 'confirmed', 'checked_in', 'waiting')
    `;
    return { futureAppointments: Number(linhas[0]?.total ?? 0) };
  });
}
