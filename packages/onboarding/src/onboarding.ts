import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  SERVICE_TEMPLATES,
  validateCombos,
  type ServiceTemplate,
} from '@barbearia/core';

/**
 * Onboarding da barbearia, em seis etapas.
 *
 * A meta da SPEC (Parte 1 §1.5) é da conta ao link publicado em menos de dez
 * minutos, e cada etapa é gravada sozinha: quem cadastra barbearia faz isso no
 * celular, entre um cliente e outro, e abandonar no passo 4 não pode custar os
 * passos 1 a 3.
 *
 * Por isso não existe "salvar tudo no fim" aqui. Cada função grava a sua etapa
 * e avança o contador — e o contador só avança, nunca retrocede, para que voltar
 * a uma etapa anterior para corrigir algo não desfaça o que já foi feito.
 */

export type OnboardingFailure =
  | 'unknown_tenant'
  | 'invalid_catalog'
  | 'nothing_to_publish'
  | 'slug_taken';

export class OnboardingError extends Error {
  constructor(
    readonly code: OnboardingFailure,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'OnboardingError';
  }
}

/** Lista fechada: texto livre viraria vocabulário divergente entre barbearias. */
export const PAYMENT_METHODS = ['pix', 'card', 'cash', 'online'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const AMENITIES = ['wifi', 'card', 'pix', 'cash', 'parking', 'accessible'] as const;

export interface OnboardingState {
  readonly tenantId: string;
  readonly businessName: string;
  readonly slug: string;
  readonly step: number;
  readonly publishedAt: string | null;
  readonly locationId: string;
  readonly counts: {
    readonly services: number;
    readonly professionals: number;
    readonly schedules: number;
  };
}

/** Onde o dono parou. É o que permite retomar do celular no dia seguinte. */
export async function getOnboardingState(tenantId: string): Promise<OnboardingState | null> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        name: string;
        onboarding_step: number;
        published_at: Date | null;
        slug: string;
        location_id: string;
        services: bigint;
        professionals: bigint;
        schedules: bigint;
      }[]
    >`
      SELECT t.name, t.onboarding_step, t.published_at,
             s.slug, l.id AS location_id,
             (SELECT count(*) FROM services WHERE active) AS services,
             (SELECT count(*) FROM professionals WHERE active AND kind = 'professional')
               AS professionals,
             (SELECT count(*) FROM work_schedules) AS schedules
      FROM tenants t
      JOIN tenant_slugs s ON s.tenant_id = t.id AND s.is_primary
      JOIN locations l ON l.tenant_id = t.id
      ORDER BY l.created_at
      LIMIT 1
    `;

    const linha = linhas[0];
    if (!linha) return null;

    return {
      tenantId,
      businessName: linha.name,
      slug: linha.slug,
      step: linha.onboarding_step,
      publishedAt: linha.published_at?.toISOString() ?? null,
      locationId: linha.location_id,
      counts: {
        services: Number(linha.services),
        professionals: Number(linha.professionals),
        schedules: Number(linha.schedules),
      },
    };
  });
}

/**
 * O contador só sobe.
 *
 * Voltar à etapa 2 para corrigir o endereço não pode reabrir as etapas 3 a 6 —
 * quem já publicou continuaria publicado, mas o painel diria que o cadastro
 * está pela metade.
 */
async function advance(tx: TransactionClient, step: number): Promise<void> {
  await tx.$executeRaw`
    UPDATE tenants SET onboarding_step = GREATEST(onboarding_step, ${step}), updated_at = now()
  `;
}

// -- Etapa 2: empresa --------------------------------------------------------

export interface BusinessInput {
  readonly tenantId: string;
  readonly name: string;
  readonly street?: string;
  readonly district?: string;
  readonly city?: string;
  readonly state?: string;
  readonly postalCode?: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly phone?: string;
  readonly whatsapp?: string;
  readonly instagram?: string;
  readonly about?: string;
  readonly timezone?: string;
  readonly amenities?: readonly string[];
}

/**
 * Grava os dados da empresa.
 *
 * Renomear **adiciona** slug, nunca substitui: o link na bio do Instagram não
 * pode quebrar. Foi o que o próprio concorrente acertou — trocou de Box Seis
 * para Domari e o slug antigo continua resolvendo.
 */
export async function saveBusiness(input: BusinessInput): Promise<{ slug: string }> {
  return withTenant(input.tenantId, async (tx) => {
    await tx.$executeRaw`
      UPDATE tenants SET name = ${input.name}, instagram = ${input.instagram ?? null},
                         updated_at = now()
    `;

    await tx.$executeRaw`
      UPDATE locations SET
        name = ${input.name},
        street = ${input.street ?? null},
        district = ${input.district ?? null},
        city = ${input.city ?? null},
        state = ${input.state ?? null},
        postal_code = ${input.postalCode ?? null},
        latitude = ${input.latitude ?? null},
        longitude = ${input.longitude ?? null},
        phone_e164 = ${input.phone ?? null},
        whatsapp_e164 = ${input.whatsapp ?? null},
        about = ${input.about ?? null},
        timezone = COALESCE(${input.timezone ?? null}, timezone),
        amenities = ${[...(input.amenities ?? [])]},
        updated_at = now()
    `;

    await advance(tx, 2);

    const slugs = await tx.$queryRaw<{ slug: string }[]>`
      SELECT slug FROM tenant_slugs WHERE is_primary LIMIT 1
    `;
    return { slug: slugs[0]?.slug ?? '' };
  });
}

// -- Etapa 3: serviços -------------------------------------------------------

export interface ServiceInput {
  readonly key: string;
  readonly name: string;
  readonly description?: string;
  readonly category: string;
  readonly durationMinutes: number;
  readonly bufferAfterMinutes: number;
  readonly priceCents: number;
  readonly componentKeys?: readonly string[];
}

export function templatesForOnboarding(): readonly ServiceTemplate[] {
  return SERVICE_TEMPLATES;
}

/**
 * Grava o cardápio.
 *
 * Valida antes de escrever: um combo que promete menos tempo que as partes é o
 * defeito D4, e ele nasce exatamente aqui, no cadastro manual sem conferência.
 * Recusar na origem é mais barato que descobrir com o barbeiro atrasado.
 *
 * Substitui o cardápio inteiro em vez de mesclar. A etapa é "estes são os meus
 * serviços", e mesclar deixaria para trás o que o dono removeu da lista.
 */
export async function saveServices(
  tenantId: string,
  services: readonly ServiceInput[],
): Promise<{ created: number }> {
  const problemas = validateCombos(
    services.map((s) => ({
      key: s.key,
      durationMinutes: s.durationMinutes,
      priceCents: s.priceCents,
      ...(s.componentKeys ? { componentKeys: s.componentKeys } : {}),
    })),
  );
  if (problemas.length > 0) {
    throw new OnboardingError(
      'invalid_catalog',
      'Confira as durações: um combo está prometendo menos tempo do que as partes levam.',
      problemas,
    );
  }

  return withTenant(tenantId, async (tx) => {
    // Desativa em vez de apagar: agendamento antigo aponta para o serviço, e
    // apagar levaria junto o histórico que alimenta relatório e comissão.
    await tx.$executeRaw`UPDATE services SET active = false, updated_at = now()`;
    await tx.$executeRaw`DELETE FROM service_combo_components`;
    await tx.$executeRaw`DELETE FROM service_combos`;

    const categorias = new Map<string, string>();
    let posicao = 0;
    for (const categoria of new Set(services.map((s) => s.category))) {
      const linhas = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO service_categories (tenant_id, name, position)
        VALUES (${tenantId}::uuid, ${categoria}, ${posicao})
        ON CONFLICT (tenant_id, name) DO UPDATE SET position = EXCLUDED.position
        RETURNING id
      `;
      const id = linhas[0]?.id;
      if (id) categorias.set(categoria, id);
      posicao += 1;
    }

    const idPorChave = new Map<string, string>();
    for (const servico of services) {
      const linhas = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO services
          (tenant_id, category_id, name, description, price_cents, duration_minutes,
           buffer_after_minutes, active, bookable_online)
        VALUES (${tenantId}::uuid, ${categorias.get(servico.category) ?? null}::uuid,
                ${servico.name}, ${servico.description ?? null}, ${servico.priceCents},
                ${servico.durationMinutes}, ${servico.bufferAfterMinutes}, true, true)
        RETURNING id
      `;
      const id = linhas[0]?.id;
      if (id) idPorChave.set(servico.key, id);
    }

    // Combos: o vínculo com as partes é o que faz a tela do cliente avisar
    // quando a escolha avulsa sai mais cara (bloco 9).
    for (const servico of services) {
      if (!servico.componentKeys || servico.componentKeys.length < 2) continue;
      const comboServiceId = idPorChave.get(servico.key);
      if (!comboServiceId) continue;

      const criado = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO service_combos
          (tenant_id, name, declared_duration_minutes, sold_as_service_id)
        VALUES (${tenantId}::uuid, ${servico.name}, ${servico.durationMinutes},
                ${comboServiceId}::uuid)
        RETURNING id
      `;
      const comboId = criado[0]?.id;
      if (!comboId) continue;

      for (const chave of servico.componentKeys) {
        const parte = idPorChave.get(chave);
        if (!parte) continue;
        await tx.$executeRaw`
          INSERT INTO service_combo_components (combo_id, service_id, tenant_id)
          VALUES (${comboId}::uuid, ${parte}::uuid, ${tenantId}::uuid)
        `;
      }
    }

    await advance(tx, 3);
    return { created: idPorChave.size };
  });
}

// -- Etapa 4: profissionais --------------------------------------------------

export interface ProfessionalInput {
  readonly name: string;
  readonly bio?: string;
  readonly phone?: string;
  /** Jornada por dia da semana. Sem ela o profissional não aparece na grade. */
  readonly schedule: readonly {
    readonly weekday: number;
    readonly startMinute: number;
    readonly endMinute: number;
  }[];
  /** Vazio significa "faz tudo": é o caso da barbearia pequena. */
  readonly serviceNames?: readonly string[];
}

/**
 * Grava a equipe e a jornada de cada um.
 *
 * `kind = 'professional'` sempre: agenda de balcão é outra coisa e entra pelo
 * admin. Foi a mistura das duas que destruiu o relatório de ocupação do sistema
 * analisado (defeito D12), e o onboarding não pode ser a porta de entrada disso.
 */
export async function saveProfessionals(
  tenantId: string,
  locationId: string,
  professionals: readonly ProfessionalInput[],
): Promise<{ created: number }> {
  return withTenant(tenantId, async (tx) => {
    const servicos = await tx.$queryRaw<{ id: string; name: string }[]>`
      SELECT id, name FROM services WHERE active
    `;
    const idPorNome = new Map(servicos.map((s) => [s.name, s.id]));

    await tx.$executeRaw`
      UPDATE professionals SET active = false, updated_at = now()
      WHERE kind = 'professional'
    `;

    let criados = 0;
    for (const pessoa of professionals) {
      const linhas = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO professionals
          (tenant_id, location_id, name, bio, kind, active, bookable_online)
        VALUES (${tenantId}::uuid, ${locationId}::uuid, ${pessoa.name},
                ${pessoa.bio ?? null}, 'professional', true, true)
        RETURNING id
      `;
      const id = linhas[0]?.id;
      if (!id) continue;
      criados += 1;

      const habilitados = pessoa.serviceNames?.length
        ? pessoa.serviceNames.map((nome) => idPorNome.get(nome)).filter((v): v is string => !!v)
        : servicos.map((s) => s.id);

      for (const servicoId of habilitados) {
        await tx.$executeRaw`
          INSERT INTO professional_services (professional_id, service_id, tenant_id)
          VALUES (${id}::uuid, ${servicoId}::uuid, ${tenantId}::uuid)
          ON CONFLICT DO NOTHING
        `;
      }

      for (const dia of pessoa.schedule) {
        await tx.$executeRaw`
          INSERT INTO work_schedules
            (tenant_id, professional_id, weekday, start_minute, end_minute)
          VALUES (${tenantId}::uuid, ${id}::uuid, ${dia.weekday},
                  ${dia.startMinute}, ${dia.endMinute})
        `;
      }
    }

    await advance(tx, 4);
    return { created: criados };
  });
}

// -- Etapa 5: pagamentos -----------------------------------------------------

export async function savePayments(
  tenantId: string,
  methods: readonly PaymentMethod[],
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.$executeRaw`
      UPDATE locations SET payment_methods = ${[...methods]}, updated_at = now()
    `;
    await advance(tx, 5);
  });
}

// -- Etapa 6: publicar -------------------------------------------------------

export interface PublishResult {
  readonly slug: string;
  readonly publishedAt: string;
}

/**
 * Publica o link.
 *
 * Recusa publicar catálogo vazio ou equipe sem jornada. Um link no ar que abre
 * "nenhum horário disponível" é pior que link nenhum: o cliente conclui que a
 * barbearia está fechada e não volta.
 */
export async function publish(tenantId: string): Promise<PublishResult> {
  const estado = await getOnboardingState(tenantId);
  if (!estado) throw new OnboardingError('unknown_tenant', 'Barbearia não encontrada');

  if (estado.counts.services === 0 || estado.counts.professionals === 0) {
    throw new OnboardingError(
      'nothing_to_publish',
      'Cadastre pelo menos um serviço e um profissional antes de publicar.',
    );
  }
  if (estado.counts.schedules === 0) {
    throw new OnboardingError(
      'nothing_to_publish',
      'Defina o horário de trabalho da equipe: sem jornada, a agenda nasce vazia.',
    );
  }

  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ published_at: Date }[]>`
      UPDATE tenants
      SET published_at = COALESCE(published_at, now()),
          onboarding_step = 6,
          updated_at = now()
      RETURNING published_at
    `;
    const quando = linhas[0]?.published_at;
    if (!quando) throw new OnboardingError('unknown_tenant', 'Barbearia não encontrada');
    return { slug: estado.slug, publishedAt: quando.toISOString() };
  });
}

// -- Configuração da unidade -------------------------------------------------

export interface ChangeWindowInput {
  readonly cancelMinHours: number;
  readonly rescheduleMinHours: number;
  readonly maxReschedules: number;
  readonly cancellationPolicy?: string;
  /**
   * Teto de desconto por comanda, em pontos-base (bloco 30).
   *
   * Vive na mesma tela que a janela de cancelamento porque é a mesma coisa: uma
   * política da casa que a operação obedece. Opcional na entrada para que a tela
   * de janela do bloco 9 continue funcionando sem mandá-lo.
   */
  readonly maxDiscountBps?: number;

  /**
   * Onde o fiado vale: na rede ou só na loja em que a dívida nasceu (bloco 59).
   *
   * Vive nesta tela pela mesma razão do teto de desconto: é política da casa que
   * a operação obedece. Opcional pelo mesmo motivo — não mandar é "não mexa".
   */
  readonly creditScope?: 'empresa' | 'unidade';

  /**
   * O encarregado de dados (bloco 31).
   *
   * Fica na mesma tela porque é do mesmo tipo: uma decisão da casa que a
   * operação e a página pública obedecem. String vazia é "apagar" — é como a
   * tela diz que a barbearia trocou de encarregado e ainda não tem outro.
   */
  readonly dpoName?: string | null;
  readonly dpoEmail?: string | null;

  /**
   * A política de sinal da unidade (bloco 37).
   *
   * Mora nesta tela e não numa própria pelo mesmo critério do teto de desconto:
   * é uma decisão da casa que a operação obedece, e ela é irmã da janela de
   * cancelamento — uma diz se o cliente **pode** desmarcar, a outra se ele leva
   * o dinheiro de volta. Separá-las faria o gerente configurar metade da regra
   * numa tela e metade noutra, e as duas metades se contradizerem em silêncio.
   */
  readonly deposit?: DepositPolicyInput;
}

export interface DepositPolicyInput {
  readonly mode: 'nenhum' | 'fixo' | 'percentual' | 'total';
  readonly fixedCents: number;
  readonly percentBps: number;
  readonly scoreThreshold: number;
  readonly ticketOverCents: number;
  readonly refundHours: number;
}

/**
 * Janela de cancelamento e remarcação.
 *
 * Estava declarada como lacuna do bloco 9: as colunas existiam e a API já as
 * aplicava, mas só dava para mudá-las por SQL.
 */
export async function saveChangeWindow(
  tenantId: string,
  input: ChangeWindowInput,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.$executeRaw`
      UPDATE locations SET
        cancel_min_hours = ${input.cancelMinHours},
        reschedule_min_hours = ${input.rescheduleMinHours},
        max_reschedules = ${input.maxReschedules},
        cancellation_policy = ${input.cancellationPolicy ?? null},
        updated_at = now()
    `;

    // Só quando vem: `COALESCE` manteria o valor atual de qualquer jeito, mas
    // o `UPDATE` separado deixa explícito que não mandar é "não mexa nisso", e
    // não "volte ao padrão".
    if (input.maxDiscountBps !== undefined) {
      await tx.$executeRaw`
        UPDATE tenants SET max_discount_bps = ${input.maxDiscountBps}, updated_at = now()
         WHERE id = ${tenantId}::uuid
      `;
    }

    if (input.creditScope !== undefined) {
      await tx.$executeRaw`
        UPDATE tenants SET credit_scope = ${input.creditScope}::escopo_multiunidade,
                           updated_at = now()
         WHERE id = ${tenantId}::uuid
      `;
    }

    /**
     * O sinal, e por que os valores são zerados quando a modalidade sai.
     *
     * O banco recusa `fixo` sem valor e `percentual` sem alíquota, mas aceita
     * valor guardado com a modalidade `nenhum` — e é aí que mora a armadilha:
     * a barbearia desliga o sinal, o R$ 50 fica na coluna, e meses depois
     * alguém religa "só para testar" e o cliente vê uma cobrança de cinquenta
     * reais que ninguém decidiu hoje. Desligar apaga o número junto.
     */
    if (input.deposit) {
      const d = input.deposit;
      const fixo = d.mode === 'fixo' ? d.fixedCents : 0;
      const percentual = d.mode === 'percentual' ? d.percentBps : 0;
      await tx.$executeRaw`
        UPDATE locations SET
          deposit_mode = ${d.mode}::deposit_mode,
          deposit_fixed_cents = ${fixo},
          deposit_percent_bps = ${percentual},
          deposit_score_threshold = ${d.scoreThreshold},
          deposit_ticket_over_cents = ${d.ticketOverCents},
          deposit_refund_hours = ${d.refundHours},
          updated_at = now()
      `;
    }

    // Os dois juntos, e não um campo por vez: encarregado é nome **e** contato,
    // e salvar metade deixaria o e-mail do antecessor apontando para o nome do
    // sucessor. Vazio vira nulo — a CHECK do banco recusa `''` como e-mail.
    if (input.dpoName !== undefined || input.dpoEmail !== undefined) {
      const nome = (input.dpoName ?? '').trim();
      const email = (input.dpoEmail ?? '').trim();
      await tx.$executeRaw`
        UPDATE tenants SET dpo_name = ${nome.length > 0 ? nome : null},
                           dpo_email = ${email.length > 0 ? email : null},
                           updated_at = now()
         WHERE id = ${tenantId}::uuid
      `;
    }
  });
}

/** O que a tela de políticas mostra preenchido. */
export async function getPolicies(tenantId: string): Promise<{
  readonly cancelMinHours: number;
  readonly rescheduleMinHours: number;
  readonly maxReschedules: number;
  readonly cancellationPolicy: string | null;
  readonly maxDiscountBps: number;
  readonly creditScope: 'empresa' | 'unidade';
  readonly dpoName: string | null;
  readonly dpoEmail: string | null;
  readonly deposit: DepositPolicyInput;
} | null> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        cancel_min_hours: number;
        reschedule_min_hours: number;
        max_reschedules: number;
        cancellation_policy: string | null;
        max_discount_bps: number;
        credit_scope: 'empresa' | 'unidade';
        dpo_name: string | null;
        dpo_email: string | null;
        deposit_mode: DepositPolicyInput['mode'];
        deposit_fixed_cents: number;
        deposit_percent_bps: number;
        deposit_score_threshold: number;
        deposit_ticket_over_cents: number;
        deposit_refund_hours: number;
      }[]
    >`
      SELECT l.cancel_min_hours, l.reschedule_min_hours, l.max_reschedules,
             l.cancellation_policy, t.max_discount_bps, t.credit_scope,
             t.dpo_name, t.dpo_email,
             l.deposit_mode, l.deposit_fixed_cents, l.deposit_percent_bps,
             l.deposit_score_threshold, l.deposit_ticket_over_cents,
             l.deposit_refund_hours
        FROM locations l
        JOIN tenants t ON t.id = l.tenant_id
       ORDER BY l.created_at
       LIMIT 1
    `;
    const linha = linhas[0];
    if (!linha) return null;
    return {
      cancelMinHours: linha.cancel_min_hours,
      rescheduleMinHours: linha.reschedule_min_hours,
      maxReschedules: linha.max_reschedules,
      cancellationPolicy: linha.cancellation_policy,
      maxDiscountBps: linha.max_discount_bps,
      creditScope: linha.credit_scope,
      dpoName: linha.dpo_name,
      dpoEmail: linha.dpo_email,
      deposit: {
        mode: linha.deposit_mode,
        fixedCents: linha.deposit_fixed_cents,
        percentBps: linha.deposit_percent_bps,
        scoreThreshold: linha.deposit_score_threshold,
        ticketOverCents: linha.deposit_ticket_over_cents,
        refundHours: linha.deposit_refund_hours,
      },
    };
  });
}

// -- Fotos --------------------------------------------------------------------

export interface PhotoInput {
  readonly coverUrl?: string | null;
  readonly logoUrl?: string | null;
  readonly professionals?: readonly { readonly id: string; readonly photoUrl?: string | null }[];
  readonly services?: readonly { readonly id: string; readonly photoUrl?: string | null }[];
}

export interface PhotoTargets {
  readonly coverUrl: string | null;
  readonly logoUrl: string | null;
  readonly professionals: readonly { readonly id: string; readonly name: string; readonly photoUrl: string | null }[];
  readonly services: readonly { readonly id: string; readonly name: string; readonly photoUrl: string | null }[];
}

/** O que a tela de fotos precisa listar, com o que já está preenchido. */
export async function getPhotoTargets(tenantId: string): Promise<PhotoTargets | null> {
  return withTenant(tenantId, async (tx) => {
    const unidades = await tx.$queryRaw<{ cover_url: string | null }[]>`
      SELECT cover_url FROM locations ORDER BY created_at LIMIT 1
    `;
    const unidade = unidades[0];
    if (!unidade) return null;

    const marcas = await tx.$queryRaw<{ logo_url: string | null }[]>`
      SELECT logo_url FROM tenants WHERE id = ${tenantId}::uuid
    `;

    const equipe = await tx.$queryRaw<{ id: string; name: string; photo_url: string | null }[]>`
      SELECT id, name, photo_url FROM professionals
      WHERE active AND kind = 'professional' ORDER BY name
    `;

    const servicos = await tx.$queryRaw<{ id: string; name: string; photo_url: string | null }[]>`
      SELECT id, name, photo_url FROM services WHERE active ORDER BY name
    `;

    return {
      coverUrl: unidade.cover_url,
      logoUrl: marcas[0]?.logo_url ?? null,
      professionals: equipe.map((p) => ({ id: p.id, name: p.name, photoUrl: p.photo_url })),
      services: servicos.map((s) => ({ id: s.id, name: s.name, photoUrl: s.photo_url })),
    };
  });
}

/**
 * Grava os endereços das fotos.
 *
 * As colunas existiam desde o bloco 1 e o perfil público já as devolvia — nunca
 * houve por onde preenchê-las, e a página de barbearia ficava sem uma única
 * imagem num negócio em que a escolha do cliente é visual. É a mesma falha que
 * `blocks` teve por oito blocos, com a diferença de que aqui ela estava à vista
 * de qualquer visitante.
 *
 * Fica separada das outras etapas de propósito: a meta de dez minutos do
 * onboarding não sobrevive a nove campos de URL, e foto é o tipo de coisa que a
 * barbearia volta para ajustar depois.
 *
 * Cada `UPDATE` de profissional e serviço é por id, sob a RLS. Um id de outra
 * barbearia não encontra linha — a política filtra antes do `WHERE`.
 */
export async function savePhotos(
  tenantId: string,
  input: PhotoInput,
): Promise<{ readonly saved: number }> {
  return withTenant(tenantId, async (tx) => {
    let gravadas = 0;

    if (input.coverUrl !== undefined) {
      await tx.$executeRaw`
        UPDATE locations SET cover_url = ${input.coverUrl}, updated_at = now()
        WHERE id = (SELECT id FROM locations ORDER BY created_at LIMIT 1)
      `;
      if (input.coverUrl) gravadas += 1;
    }

    if (input.logoUrl !== undefined) {
      await tx.$executeRaw`
        UPDATE tenants SET logo_url = ${input.logoUrl}, updated_at = now()
        WHERE id = ${tenantId}::uuid
      `;
      if (input.logoUrl) gravadas += 1;
    }

    for (const pessoa of input.professionals ?? []) {
      if (pessoa.photoUrl === undefined) continue;
      await tx.$executeRaw`
        UPDATE professionals SET photo_url = ${pessoa.photoUrl}, updated_at = now()
        WHERE id = ${pessoa.id}::uuid
      `;
      if (pessoa.photoUrl) gravadas += 1;
    }

    for (const servico of input.services ?? []) {
      if (servico.photoUrl === undefined) continue;
      await tx.$executeRaw`
        UPDATE services SET photo_url = ${servico.photoUrl}, updated_at = now()
        WHERE id = ${servico.id}::uuid
      `;
      if (servico.photoUrl) gravadas += 1;
    }

    return { saved: gravadas };
  });
}
