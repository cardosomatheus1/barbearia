import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  ehEspecialidade,
  formatHHMM,
  instantToLocal,
  MAXIMO_DE_ESPECIALIDADES,
  slugDoBarbeiro,
} from '@barbearia/core';
import { CatalogError, exigirServicosDoTenant } from './servicos.js';

/**
 * Equipe e jornada, no dia a dia.
 *
 * O onboarding grava a equipe inteira de uma vez e aplica **a mesma jornada
 * para todo mundo** — foi lacuna declarada desde o bloco 10. Aqui cada pessoa
 * tem a dela, porque é assim que barbearia funciona: um entra às sete, outro
 * folga na terça.
 *
 * E, como no catálogo, nada recria linha. `saveProfessionals` do onboarding
 * desativa a equipe inteira e insere de novo com ids novos; feito no dia a dia,
 * isso deixaria todo agendamento existente apontando para um profissional
 * inativo.
 */

export interface Profissional {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly bookableOnline: boolean;
  readonly dailyLimit: number | null;
  readonly active: boolean;
  readonly photoUrl: string | null;
  readonly bio: string | null;
  /** Ids dos serviços que esta pessoa executa. */
  readonly serviceIds: readonly string[];
  /** Dias da semana em que trabalha, para a lista dizer quem tem grade. */
  readonly weekdays: readonly number[];
  readonly futureAppointments: number;
  /** Já tem conta de acesso ligada a esta cadeira. Uma cadeira, uma conta. */
  readonly hasAccount: boolean;
  /** Para onde o convite vai. Guardado na cadeira para o reenvio não repetir. */
  readonly phone: string | null;
  /** Se a pessoa tem página pública, e onde ela mora (bloco 73, SPEC §5.2). */
  readonly perfilPublico: boolean;
  readonly perfilSlug: string | null;
  readonly especialidades: readonly string[];
}

export async function listProfessionals(
  tenantId: string,
  locationId: string,
  now: Date = new Date(),
): Promise<readonly Profissional[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        name: string;
        kind: string;
        bookable_online: boolean;
        daily_limit: number | null;
        active: boolean;
        photo_url: string | null;
        bio: string | null;
        service_ids: string[] | null;
        weekdays: number[] | null;
        future_appointments: bigint;
        has_account: boolean;
        phone_e164: string | null;
        public_profile: boolean;
        public_slug: string | null;
        specialties: string[];
      }[]
    >`
      SELECT p.id, p.name, p.kind, p.bookable_online, p.daily_limit, p.active,
             p.photo_url, p.bio,
             (SELECT array_agg(ps.service_id::text)
                FROM professional_services ps WHERE ps.professional_id = p.id) AS service_ids,
             (SELECT array_agg(DISTINCT ws.weekday)
                FROM work_schedules ws WHERE ws.professional_id = p.id) AS weekdays,
             (SELECT count(*) FROM appointments a
               WHERE a.professional_id = p.id
                 AND a.service_starts_at >= ${now}
                 AND a.status IN ('pending', 'confirmed', 'checked_in', 'waiting')
             ) AS future_appointments,
             EXISTS (SELECT 1 FROM staff_users s WHERE s.professional_id = p.id) AS has_account,
             p.phone_e164, p.public_profile, p.public_slug, p.specialties
      FROM professionals p
      WHERE p.location_id = ${locationId}::uuid
      ORDER BY p.active DESC, p.name
    `;

    return linhas.map((linha) => ({
      id: linha.id,
      name: linha.name,
      kind: linha.kind,
      bookableOnline: linha.bookable_online,
      dailyLimit: linha.daily_limit,
      active: linha.active,
      photoUrl: linha.photo_url,
      bio: linha.bio,
      serviceIds: linha.service_ids ?? [],
      weekdays: [...(linha.weekdays ?? [])].sort((a, b) => a - b),
      futureAppointments: Number(linha.future_appointments),
      hasAccount: linha.has_account,
      phone: linha.phone_e164,
      perfilPublico: linha.public_profile,
      perfilSlug: linha.public_slug,
      especialidades: linha.specialties,
    }));
  });
}

export interface ProfessionalInput {
  readonly name: string;
  readonly bio?: string | null;
  /**
   * `professional` entra em ocupação e comissão; `station` e `room` não.
   *
   * É o defeito D12 (SPEC §1.4): no sistema analisado, dois dos quatro
   * "profissionais" eram contas de balcão com jornada 08:00–23:00, e isso
   * destruía qualquer relatório de ocupação.
   */
  readonly kind: 'professional' | 'station' | 'room';
  readonly bookableOnline: boolean;
  readonly dailyLimit?: number | null;
  /** Serviços que executa. Vazio significa "faz tudo" e é gravado como tudo. */
  readonly serviceIds?: readonly string[];
}

async function gravarHabilidades(
  tx: TransactionClient,
  professionalId: string,
  serviceIds: readonly string[] | undefined,
): Promise<void> {
  await tx.$executeRaw`
    DELETE FROM professional_services WHERE professional_id = ${professionalId}::uuid
  `;

  // A FK de `service_id` não passa pela RLS. Sem esta checagem, um id de
  // serviço de outra barbearia entra aqui sem erro — ver `exigirServicosDoTenant`.
  await exigirServicosDoTenant(tx, serviceIds ?? []);

  if (!serviceIds || serviceIds.length === 0) {
    // Vazio é "faz tudo", e é gravado como tudo em vez de virar ausência: a
    // grade lê esta tabela, e ausência de linha significa "não executa".
    await tx.$executeRaw`
      INSERT INTO professional_services (professional_id, service_id, tenant_id)
      SELECT ${professionalId}::uuid, s.id, s.tenant_id
      FROM services s WHERE s.active
      ON CONFLICT DO NOTHING
    `;
    return;
  }

  for (const servicoId of serviceIds) {
    await tx.$executeRaw`
      INSERT INTO professional_services (professional_id, service_id, tenant_id)
      VALUES (${professionalId}::uuid, ${servicoId}::uuid,
              NULLIF(current_setting('app.tenant_id', true), '')::uuid)
      ON CONFLICT DO NOTHING
    `;
  }
}

export async function createProfessional(
  tenantId: string,
  locationId: string,
  input: ProfessionalInput,
): Promise<{ readonly id: string }> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO professionals
        (tenant_id, location_id, name, bio, kind, bookable_online, daily_limit, active)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${locationId}::uuid, ${input.name}, ${input.bio ?? null},
        ${input.kind}::professional_kind, ${input.bookableOnline},
        ${input.dailyLimit ?? null}, true
      )
      RETURNING id
    `;
    const id = linhas[0]?.id;
    if (!id) {
      throw new CatalogError('professional_not_found', 'Não foi possível criar o profissional');
    }

    await gravarHabilidades(tx, id, input.serviceIds);
    return { id };
  });
}

export async function updateProfessional(
  tenantId: string,
  professionalId: string,
  input: ProfessionalInput,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const afetadas = await tx.$executeRaw`
      UPDATE professionals SET
        name = ${input.name},
        bio = ${input.bio ?? null},
        kind = ${input.kind}::professional_kind,
        bookable_online = ${input.bookableOnline},
        daily_limit = ${input.dailyLimit ?? null},
        updated_at = now()
      WHERE id = ${professionalId}::uuid
    `;
    if (afetadas === 0) {
      throw new CatalogError('professional_not_found', 'Profissional não encontrado.');
    }

    await gravarHabilidades(tx, professionalId, input.serviceIds);
  });
}

/**
 * Liga ou desliga a página pública do profissional (bloco 73, SPEC §5.2).
 *
 * Rota própria em vez de um campo em `updateProfessional`: aquela função grava
 * o cadastro inteiro, e chamá-la para mexer num interruptor exigiria reenviar
 * nome, tipo, limite diário e a lista de habilidades — o caminho em que um
 * campo vazio apaga o que ninguém queria apagar. É a mesma razão de a vitrine e
 * o segundo fator terem rota própria.
 *
 * O endereço é **permanente**: gravado só enquanto está nulo. Trocá-lo mudaria
 * o link de uma página indexada, e o endereço que o cliente salvou morreria —
 * é o precedente de `tenant_slugs`, que adiciona e nunca substitui.
 */
export async function definirPerfilPublico(
  tenantId: string,
  locationId: string,
  professionalId: string,
  input: {
    readonly ligado: boolean;
    readonly especialidades: readonly string[];
    readonly bio?: string | undefined;
  },
): Promise<{ readonly slug: string | null }> {
  const especialidades = input.especialidades.filter(ehEspecialidade);
  if (especialidades.length > MAXIMO_DE_ESPECIALIDADES) {
    throw new CatalogError('too_many_specialties', 'Escolha no máximo seis especialidades.');
  }

  return withTenant(tenantId, async (tx) => {
    /**
     * A unidade é conferida **no domínio**, e a recusa é a de inexistente.
     *
     * A RLS separa barbearias e não separa lojas dentro de uma: sem este
     * filtro, o gerente escopado a uma filial publicava a página de um barbeiro
     * da matriz mandando o id alheio — e o id sai na página pública da casa,
     * então não há nem o que adivinhar. O que ele publicaria é nome, foto e
     * biografia de uma pessoa numa página indexada, que é justamente a decisão
     * que esta coluna existe para deixar com ela.
     *
     * Achado da `/security-review` deste bloco, e é o mesmo do 58 e do 68.
     */
    const linhas = await tx.$queryRaw<{ name: string; public_slug: string | null }[]>`
      SELECT name, public_slug FROM professionals
       WHERE id = ${professionalId}::uuid AND location_id = ${locationId}::uuid
    `;
    const atual = linhas[0];
    if (!atual) throw new CatalogError('professional_not_found', 'Profissional não encontrado.');

    /**
     * O endereço nasce do nome e nunca muda depois.
     *
     * Quando o nome já foi usado por outro colega, entra o sufixo — dois "João"
     * na mesma casa é caso comum, e recusar o segundo perfil por causa disso
     * seria transformar cadastro de equipe numa corrida por nome.
     */
    let slug = atual.public_slug;
    if (!slug && input.ligado) {
      const base = slugDoBarbeiro(atual.name);
      if (!base) {
        throw new CatalogError('invalid_public_slug', 'O nome não gera um endereço público.');
      }
      slug = await enderecoLivre(tx, base);
    }

    const afetadas = await tx.$executeRaw`
      UPDATE professionals SET
        public_profile = ${input.ligado},
        public_slug = COALESCE(public_slug, ${slug}),
        specialties = ${especialidades},
        bio = COALESCE(${input.bio ?? null}, bio),
        updated_at = now()
      WHERE id = ${professionalId}::uuid AND location_id = ${locationId}::uuid
    `;
    if (afetadas === 0) {
      throw new CatalogError('professional_not_found', 'Profissional não encontrado.');
    }
    return { slug: input.ligado ? slug : atual.public_slug };
  });
}

/** O primeiro endereço livre a partir da base, dentro desta barbearia. */
async function enderecoLivre(tx: TransactionClient, base: string): Promise<string> {
  for (let i = 0; i < 50; i += 1) {
    const candidato = i === 0 ? base : `${base.slice(0, 56)}-${i + 1}`;
    const ocupados = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM professionals WHERE public_slug = ${candidato}
    `;
    if (Number(ocupados[0]?.n ?? 0) === 0) return candidato;
  }
  throw new CatalogError('invalid_public_slug', 'Não foi possível gerar um endereço público.');
}

// -- Jornada ------------------------------------------------------------------

export interface FaixaDoDia {
  readonly weekday: number;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly breaks: readonly { readonly start: number; readonly end: number }[];
}

export async function getSchedule(
  tenantId: string,
  professionalId: string,
): Promise<readonly FaixaDoDia[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      { weekday: number; start_minute: number; end_minute: number; breaks: unknown }[]
    >`
      SELECT weekday, start_minute, end_minute, breaks
      FROM work_schedules WHERE professional_id = ${professionalId}::uuid
      ORDER BY weekday, start_minute
    `;

    return linhas.map((linha) => ({
      weekday: linha.weekday,
      startMinute: linha.start_minute,
      endMinute: linha.end_minute,
      breaks: Array.isArray(linha.breaks)
        ? (linha.breaks as { start: number; end: number }[])
        : [],
    }));
  });
}

/**
 * Agendamento que a jornada nova deixaria de fora.
 *
 * Encolher a terça de 09–18 para 09–12 não cancela o corte das 15h — ele
 * continua no banco, e some da grade. Sem este aviso, o dono descobre pelo
 * cliente que apareceu e não tinha barbeiro.
 */
export interface ForaDaJornada {
  readonly appointmentId: string;
  readonly startsAt: string;
  readonly date: string;
  readonly time: string;
  readonly customerName: string | null;
}

/**
 * O que a jornada proposta deixaria descoberto.
 *
 * Só olha o futuro: o passado já aconteceu, e alertar sobre ele seria ruído em
 * toda edição. Compara no fuso da unidade, nunca no do servidor.
 */
export async function conflitosDaJornada(params: {
  readonly tenantId: string;
  readonly professionalId: string;
  readonly faixas: readonly FaixaDoDia[];
  readonly now?: Date;
}): Promise<readonly ForaDaJornada[]> {
  const now = params.now ?? new Date();

  return withTenant(params.tenantId, async (tx) => {
    const unidades = await tx.$queryRaw<{ timezone: string }[]>`
      SELECT l.timezone FROM locations l
      JOIN professionals p ON p.location_id = l.id
      WHERE p.id = ${params.professionalId}::uuid
    `;
    const timezone = unidades[0]?.timezone;
    if (!timezone) return [];

    const linhas = await tx.$queryRaw<
      {
        id: string;
        service_starts_at: Date;
        service_ends_at: Date;
        customer_name: string | null;
      }[]
    >`
      SELECT a.id, a.service_starts_at, a.service_ends_at, c.name AS customer_name
      FROM appointments a
      LEFT JOIN customers c ON c.id = a.customer_id
      WHERE a.professional_id = ${params.professionalId}::uuid
        AND a.service_starts_at >= ${now}
        AND a.status IN ('pending', 'confirmed', 'checked_in', 'waiting')
      ORDER BY a.service_starts_at
    `;

    const porDia = new Map<number, FaixaDoDia[]>();
    for (const faixa of params.faixas) {
      const doDia = porDia.get(faixa.weekday) ?? [];
      doDia.push(faixa);
      porDia.set(faixa.weekday, doDia);
    }

    const fora: ForaDaJornada[] = [];
    for (const linha of linhas) {
      const inicio = instantToLocal(timezone, linha.service_starts_at);
      const fim = instantToLocal(timezone, linha.service_ends_at);
      const weekday = new Date(`${inicio.date}T12:00:00Z`).getUTCDay();

      const cabe = (porDia.get(weekday) ?? []).some((faixa) => {
        // O fim do atendimento também precisa caber: um corte que começa às
        // 11:50 e termina 12:20 não cabe numa jornada que fecha ao meio-dia.
        const dentro = inicio.minutes >= faixa.startMinute && fim.minutes <= faixa.endMinute;
        if (!dentro) return false;
        return !faixa.breaks.some(
          (intervalo) => inicio.minutes < intervalo.end && fim.minutes > intervalo.start,
        );
      });

      if (!cabe) {
        fora.push({
          appointmentId: linha.id,
          startsAt: linha.service_starts_at.toISOString(),
          date: inicio.date,
          time: formatHHMM(inicio.minutes),
          customerName: linha.customer_name,
        });
      }
    }

    return fora;
  });
}

/**
 * Grava a jornada da semana inteira desta pessoa.
 *
 * Substitui o conjunto de propósito: a jornada é uma coisa só, e editar dia a
 * dia deixaria linha órfã do dia que o dono tirou do formulário.
 *
 * `conflitosDaJornada` roda **antes**, na mesma transação: quem chama decide se
 * grava assim mesmo, mas ninguém grava sem ter a lista na mão.
 */
export async function saveSchedule(params: {
  readonly tenantId: string;
  readonly professionalId: string;
  readonly faixas: readonly FaixaDoDia[];
}): Promise<void> {
  await withTenant(params.tenantId, async (tx) => {
    const existe = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM professionals WHERE id = ${params.professionalId}::uuid
    `;
    if (!existe[0]) {
      throw new CatalogError('professional_not_found', 'Profissional não encontrado.');
    }

    await tx.$executeRaw`
      DELETE FROM work_schedules WHERE professional_id = ${params.professionalId}::uuid
    `;

    for (const faixa of params.faixas) {
      if (faixa.startMinute >= faixa.endMinute) {
        throw new CatalogError(
          'invalid_catalog',
          'A hora de entrada precisa ser antes da hora de saída.',
        );
      }
      await tx.$executeRaw`
        INSERT INTO work_schedules
          (tenant_id, professional_id, weekday, start_minute, end_minute, breaks)
        VALUES (
          NULLIF(current_setting('app.tenant_id', true), '')::uuid,
          ${params.professionalId}::uuid, ${faixa.weekday},
          ${faixa.startMinute}, ${faixa.endMinute},
          ${JSON.stringify(faixa.breaks)}::jsonb
        )
      `;
    }
  });
}

/**
 * Desliga (ou religa) alguém da agenda.
 *
 * Devolve os agendamentos futuros que ficam sem dono. Desativar não cancela
 * nada — e é justamente por isso que a lista precisa aparecer: o cliente marcou
 * com essa pessoa, e alguém tem que decidir se remarca ou avisa.
 */
export async function setProfessionalActive(params: {
  readonly tenantId: string;
  readonly professionalId: string;
  readonly active: boolean;
  readonly now?: Date;
}): Promise<{ readonly futuros: readonly ForaDaJornada[] }> {
  const now = params.now ?? new Date();

  return withTenant(params.tenantId, async (tx) => {
    const afetadas = await tx.$executeRaw`
      UPDATE professionals SET active = ${params.active}, updated_at = now()
      WHERE id = ${params.professionalId}::uuid
    `;
    if (afetadas === 0) {
      throw new CatalogError('professional_not_found', 'Profissional não encontrado.');
    }
    if (params.active) return { futuros: [] };

    const unidades = await tx.$queryRaw<{ timezone: string }[]>`
      SELECT l.timezone FROM locations l
      JOIN professionals p ON p.location_id = l.id
      WHERE p.id = ${params.professionalId}::uuid
    `;
    const timezone = unidades[0]?.timezone ?? 'UTC';

    const linhas = await tx.$queryRaw<
      { id: string; service_starts_at: Date; customer_name: string | null }[]
    >`
      SELECT a.id, a.service_starts_at, c.name AS customer_name
      FROM appointments a
      LEFT JOIN customers c ON c.id = a.customer_id
      WHERE a.professional_id = ${params.professionalId}::uuid
        AND a.service_starts_at >= ${now}
        AND a.status IN ('pending', 'confirmed', 'checked_in', 'waiting')
      ORDER BY a.service_starts_at
    `;

    return {
      futuros: linhas.map((linha) => {
        const local = instantToLocal(timezone, linha.service_starts_at);
        return {
          appointmentId: linha.id,
          startsAt: linha.service_starts_at.toISOString(),
          date: local.date,
          time: formatHHMM(local.minutes),
          customerName: linha.customer_name,
        };
      }),
    };
  });
}
