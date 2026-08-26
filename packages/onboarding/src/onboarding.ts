import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  COMODIDADES,
  MEIOS_ACEITOS,
  resolverCoordenada,
  SERVICE_TEMPLATES,
  validateCombos,
  type MeioAceito,
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
  | 'location_not_found'
  /**
   * A etapa que **substitui** o conjunto, pedida depois de a casa estar no ar.
   *
   * As etapas 3 e 4 trocam o catálogo e a equipe inteiros — é o certo para quem
   * está abrindo e o errado a partir do dia seguinte, e o `CLAUDE.md` já diz
   * isso em letras sobre `catalog` × `onboarding`. O produto continuava
   * oferecendo o caminho: `?e=3` é alcançável enquanto a trilha existir, e do
   * outro lado havia um `UPDATE services SET active = false` sem `WHERE`.
   */
  | 'ja_publicada'
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

/**
 * Lista fechada: texto livre viraria vocabulário divergente entre barbearias.
 *
 * Mora em `packages/core` desde o bloco 127, porque a recepção automática
 * precisa dela para responder "aceitam Pix?" e `core` não depende de ninguém.
 * Aqui fica o nome de sempre, reexportado — dois arranjos com os mesmos quatro
 * valores é a lista paralela que este repositório já pagou cinco vezes.
 */
export const PAYMENT_METHODS = MEIOS_ACEITOS;
export type PaymentMethod = MeioAceito;

/**
 * Reexportada de `core`, como `PAYMENT_METHODS` acima.
 *
 * Escrita à mão aqui, ela era a lista longa contra a lista curta de
 * `COMODIDADES` — a borda aceitava seis e o formulário desenhava três, e como a
 * gravação é absoluta, salvar a etapa 2 apagava `card`, `pix` e `cash`.
 */
export const AMENITIES = COMODIDADES;

export interface OnboardingState {
  readonly tenantId: string;
  readonly businessName: string;
  readonly slug: string;
  readonly step: number;
  readonly publishedAt: string | null;
  readonly locationId: string;
  /**
   * O cadastro da unidade, para a etapa 2 **vir preenchida**.
   *
   * Ela nasceu como formulário de cadastro e continuou como formulário de
   * cadastro: só o nome vinha preenchido, e voltar para corrigir o telefone
   * apagava endereço, bairro, cidade, UF, Instagram e as comodidades — porque o
   * que a tela não mostra, ela não manda. Com o `COALESCE` do outro lado o
   * estrago parou; com o formulário preenchido a pessoa passa a ver o que está
   * prestes a mudar, que é o que uma tela de edição faz.
   */
  readonly empresa: {
    readonly street: string | null;
    readonly district: string | null;
    readonly city: string | null;
    readonly state: string | null;
    readonly postalCode: string | null;
    readonly phone: string | null;
    readonly whatsapp: string | null;
    readonly instagram: string | null;
    readonly about: string | null;
    readonly timezone: string;
    readonly amenities: readonly string[];
    /** O ponto no mapa, para a tela dizer se a casa aparece na busca. */
    readonly latitude: number | null;
    readonly longitude: number | null;
  };
  readonly counts: {
    readonly services: number;
    readonly professionals: number;
    readonly schedules: number;
  };
}

/**
 * Onde o dono parou. É o que permite retomar do celular no dia seguinte.
 *
 * `locationId` é **a unidade da sessão**, e a ausência dela cai na mais antiga —
 * que é o comportamento de antes do bloco 58, e o certo para a barbearia de uma
 * loja só. Com ele, a etapa 2 mostra e edita a loja em que a pessoa está: sem
 * isso, o gerente da filial abriria o cadastro da matriz preenchido e o
 * salvaria por cima do dele.
 */
export async function getOnboardingState(
  tenantId: string,
  locationId?: string,
): Promise<OnboardingState | null> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        name: string;
        onboarding_step: number;
        published_at: Date | null;
        slug: string;
        location_id: string;
        street: string | null;
        district: string | null;
        city: string | null;
        state: string | null;
        postal_code: string | null;
        phone_e164: string | null;
        whatsapp_e164: string | null;
        instagram: string | null;
        about: string | null;
        timezone: string;
        amenities: string[];
        latitude: string | null;
        longitude: string | null;
        services: bigint;
        professionals: bigint;
        schedules: bigint;
      }[]
    >`
      SELECT t.name, t.onboarding_step, t.published_at, t.instagram,
             s.slug, l.id AS location_id,
             l.street, l.district, l.city, l.state, l.postal_code,
             l.phone_e164, l.whatsapp_e164, l.about, l.timezone, l.amenities,
             l.latitude, l.longitude,
             (SELECT count(*) FROM services WHERE active) AS services,
             (SELECT count(*) FROM professionals p
                WHERE p.active AND p.kind = 'professional' AND p.location_id = l.id)
               AS professionals,
             (SELECT count(*) FROM work_schedules w
                JOIN professionals p ON p.id = w.professional_id
               WHERE p.location_id = l.id) AS schedules
      FROM tenants t
      JOIN tenant_slugs s ON s.tenant_id = t.id AND s.is_primary
      JOIN locations l ON l.tenant_id = t.id
      WHERE ${locationId ?? null}::uuid IS NULL OR l.id = ${locationId ?? null}::uuid
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
      empresa: {
        street: linha.street,
        district: linha.district,
        city: linha.city,
        state: linha.state,
        postalCode: linha.postal_code,
        phone: linha.phone_e164,
        whatsapp: linha.whatsapp_e164,
        instagram: linha.instagram,
        about: linha.about,
        timezone: linha.timezone,
        amenities: linha.amenities,
        latitude: linha.latitude === null ? null : Number(linha.latitude),
        longitude: linha.longitude === null ? null : Number(linha.longitude),
      },
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

/**
 * A etapa que substitui o conjunto só vale enquanto a casa não abriu.
 *
 * `saveServices` desativa todos os serviços e recria; `saveProfessionals`
 * desativa toda a equipe. Isso é o certo para quem está montando a barbearia e
 * destrói o cadastro de quem já está operando: `appointment_services` aponta
 * para `services.id`, e recriar o catálogo desfaz o vínculo com o que já foi
 * vendido. O `CLAUDE.md` já explicava por que `catalog` e `onboarding` são
 * pacotes separados; o que faltava era o produto **impedir** o segundo caminho
 * depois do primeiro dia.
 *
 * Conferida no domínio e não na tela: `?e=3` continua sendo um endereço, e ele
 * fica no autocompletar do navegador de quem fez o cadastro uma vez.
 */
async function recusarSeJaPublicada(tx: TransactionClient, onde: string): Promise<void> {
  const linhas = await tx.$queryRaw<{ published_at: Date | null }[]>`
    SELECT published_at FROM tenants LIMIT 1 FOR UPDATE
  `;
  if (linhas[0]?.published_at) {
    throw new OnboardingError(
      'ja_publicada',
      `Sua barbearia já está no ar. Para mudar isto, use ${onde} — o cadastro do primeiro dia substituiria tudo que já foi vendido.`,
    );
  }
}

/**
 * Qual coordenada gravar, e quando não mexer na que está lá.
 *
 * A ordem é a da precisão: o número explícito, o link colado, o centro da
 * capital. Nenhum dos três presente devolve `undefined` nos dois campos — que é
 * "não mexa", e não "apague": corrigir o telefone não pode tirar a barbearia do
 * mapa.
 */
function coordenadaParaGravar(input: BusinessInput): {
  readonly latitude: number | null | undefined;
  readonly longitude: number | null | undefined;
} {
  if (input.latitude !== undefined || input.longitude !== undefined) {
    return { latitude: input.latitude, longitude: input.longitude };
  }

  const resolvida = resolverCoordenada({
    ...(input.linkDoMapa !== undefined ? { linkDoMapa: input.linkDoMapa } : {}),
    ...(input.state !== undefined ? { estado: input.state } : {}),
  });
  if (!resolvida) return { latitude: undefined, longitude: undefined };

  return { latitude: resolvida.latitude, longitude: resolvida.longitude };
}

// -- Etapa 2: empresa --------------------------------------------------------

export interface BusinessInput {
  readonly tenantId: string;
  /**
   * Qual unidade este cadastro edita.
   *
   * Obrigatória, e não opcional com padrão: opcional, o primeiro chamador novo
   * a esquecer voltaria ao `UPDATE` sem `WHERE` que reescrevia a rede inteira,
   * e nada ficaria vermelho.
   */
  readonly locationId: string;
  readonly name: string;
  /**
   * `undefined` é "não mandou"; `null` é "apague".
   *
   * A distinção existe porque a etapa 2 passou a vir preenchida: antes, todo
   * campo chegava vazio e "vazio" não podia significar nada. Sem ela, não havia
   * caminho no produto para tirar da página pública um telefone que a pessoa
   * cadastrou por engano — ela apagava o campo, lia "salvo" e o número
   * continuava lá.
   */
  readonly street?: string | null;
  readonly district?: string | null;
  readonly city?: string | null;
  readonly state?: string | null;
  readonly postalCode?: string | null;
  readonly latitude?: number | null;
  readonly longitude?: number | null;
  /**
   * O link do mapa que a pessoa colou (bloco 115).
   *
   * É por aqui que a coordenada entra no produto: latitude e longitude cruas
   * são campo que ninguém preenche, e um provedor de geocodificação exige conta
   * contratada. Todo mundo sabe achar a própria barbearia no Google Maps e
   * copiar o endereço da barra — e ele já carrega o ponto.
   */
  readonly linkDoMapa?: string | null;
  readonly phone?: string | null;
  readonly whatsapp?: string | null;
  readonly instagram?: string | null;
  readonly about?: string | null;
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
      UPDATE tenants SET name = ${input.name},
                         instagram = CASE WHEN ${input.instagram === undefined}::boolean
                                          THEN instagram ELSE ${input.instagram ?? null} END,
                         updated_at = now()
    `;

    /**
     * Uma unidade, e **ausente significa "não mexa"**.
     *
     * Duas coisas erradas de uma vez viviam aqui, e as duas apagavam cadastro:
     *
     * - **Sem `WHERE`**, o `UPDATE` alcançava a rede inteira. A filial de Rio
     *   Branco, cadastrada com o próprio fuso justamente porque "hoje" lá é
     *   outro dia, passava a se chamar como a matriz, no endereço da matriz e no
     *   fuso da matriz — e o dia da venda dela passava a ser calculado errado. O
     *   seletor do balcão ficava com duas linhas idênticas.
     * - **`?? null`** transformava campo omitido em campo apagado. A borda já
     *   omite o que a tela não manda (`acaoEmpresa`), então corrigir o telefone
     *   levava junto endereço, bairro, cidade, UF, Instagram, o texto "sobre" e
     *   as comodidades. É a convenção do bloco 37 quebrada no cadastro mais
     *   básico do produto: campo opcional ausente é "não mexa", nunca "desligue".
     *
     * O `CASE` e não `COALESCE` porque as duas coisas precisam existir: ausente
     * preserva, **vazio apaga**. Só com `COALESCE`, o número que a pessoa
     * cadastrou por engano não teria como sair da página indexada — ela apagaria
     * o campo, leria "salvo", e ele continuaria no ar.
     *
     * `amenities` é a exceção e por isso continua absoluto: a tela manda a lista
     * inteira das caixas marcadas, e desmarcar todas é uma decisão. O que a
     * torna segura é o formulário passar a vir preenchido — sem isso, abrir a
     * tela já era desmarcar tudo.
     */
    /**
     * A coordenada sai do link colado, ou do centro da capital.
     *
     * Resolvida **dentro** da transação que grava o endereço: fora dela, a
     * unidade ficaria um instante com UF nova e ponto antigo, e a vitrine —
     * atualizada logo em seguida pelo controller — copiaria o par errado.
     *
     * Latitude e longitude explícitas ainda vencem, para quem já as tem; a
     * ausência das três preserva o que está lá, como todo campo desta função.
     */
    const daCoordenada = coordenadaParaGravar(input);

    const afetadas = await tx.$executeRaw`
      UPDATE locations SET
        -- Em rede, o nome da unidade é cadastro próprio, e o nome da empresa
        -- não pode transformar "Shopping" em "Barbearia X" ao editar endereço.
        -- Sem ponto e vírgula aqui: a guarda corta a instrução no primeiro, e
        -- deixaria de enxergar o WHERE lá embaixo.
        name = CASE WHEN (SELECT count(*) FROM locations) = 1
                    THEN ${input.name} ELSE name END,
        street = CASE WHEN ${input.street === undefined}::boolean
                    THEN street ELSE ${input.street ?? null} END,
        district = CASE WHEN ${input.district === undefined}::boolean
                    THEN district ELSE ${input.district ?? null} END,
        city = CASE WHEN ${input.city === undefined}::boolean
                    THEN city ELSE ${input.city ?? null} END,
        state = CASE WHEN ${input.state === undefined}::boolean
                    THEN state ELSE ${input.state ?? null} END,
        postal_code = CASE WHEN ${input.postalCode === undefined}::boolean
                    THEN postal_code ELSE ${input.postalCode ?? null} END,
        latitude = CASE WHEN ${daCoordenada.latitude === undefined}::boolean
                    THEN latitude ELSE ${daCoordenada.latitude ?? null} END,
        longitude = CASE WHEN ${daCoordenada.longitude === undefined}::boolean
                    THEN longitude ELSE ${daCoordenada.longitude ?? null} END,
        phone_e164 = CASE WHEN ${input.phone === undefined}::boolean
                    THEN phone_e164 ELSE ${input.phone ?? null} END,
        whatsapp_e164 = CASE WHEN ${input.whatsapp === undefined}::boolean
                    THEN whatsapp_e164 ELSE ${input.whatsapp ?? null} END,
        about = CASE WHEN ${input.about === undefined}::boolean
                    THEN about ELSE ${input.about ?? null} END,
        timezone = COALESCE(${input.timezone ?? null}, timezone),
        amenities = CASE WHEN ${input.amenities === undefined}::boolean
                    THEN amenities ELSE ${[...(input.amenities ?? [])]} END,
        updated_at = now()
      WHERE id = ${input.locationId}::uuid
    `;
    if (afetadas === 0) {
      throw new OnboardingError('location_not_found', 'Unidade não encontrada.');
    }

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
function validarEstruturaDoCatalogoInicial(services: readonly ServiceInput[]): void {
  const chaves = new Set<string>();
  const nomes = new Set<string>();
  const todas = new Set(services.map((s) => s.key.trim()));

  for (const servico of services) {
    const chave = servico.key.trim();
    const nome = servico.name.trim().toLocaleLowerCase('pt-BR');
    if (chaves.has(chave)) {
      throw new OnboardingError('invalid_catalog', `A chave "${chave}" aparece mais de uma vez.`);
    }
    if (nomes.has(nome)) {
      throw new OnboardingError('invalid_catalog', `O serviço "${servico.name}" aparece mais de uma vez.`);
    }
    chaves.add(chave);
    nomes.add(nome);

    const componentes = servico.componentKeys ?? [];
    if (new Set(componentes).size !== componentes.length) {
      throw new OnboardingError('invalid_catalog', `O combo "${servico.name}" repete um componente.`);
    }
    for (const componente of componentes) {
      if (!todas.has(componente.trim())) {
        throw new OnboardingError('invalid_catalog', `O combo "${servico.name}" referencia um serviço que não existe.`);
      }
    }
  }
}

export async function saveServices(
  tenantId: string,
  services: readonly ServiceInput[],
): Promise<{ created: number }> {
  validarEstruturaDoCatalogoInicial(services);
  const problemas = validateCombos(
    services.map((s) => ({
      key: s.key.trim(),
      durationMinutes: s.durationMinutes,
      priceCents: s.priceCents,
      ...(s.componentKeys ? { componentKeys: s.componentKeys.map((k) => k.trim()) } : {}),
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
    await recusarSeJaPublicada(tx, 'a tela de Catálogo');

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
      if (id) idPorChave.set(servico.key.trim(), id);
    }

    // Combos: o vínculo com as partes é o que faz a tela do cliente avisar
    // quando a escolha avulsa sai mais cara (bloco 9).
    for (const servico of services) {
      if (!servico.componentKeys || servico.componentKeys.length < 2) continue;
      const comboServiceId = idPorChave.get(servico.key.trim());
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
        const parte = idPorChave.get(chave.trim());
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
    await recusarSeJaPublicada(tx, 'a tela de Profissionais');

    // A FK não aplica RLS. Conferir a unidade sob RLS impede criar uma cadeira
    // deste tenant apontando para a location de outro tenant por chamada interna.
    const unidades = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM locations WHERE id = ${locationId}::uuid AND active FOR UPDATE
    `;
    if (!unidades[0]) throw new OnboardingError('location_not_found', 'Unidade não encontrada.');

    const servicos = await tx.$queryRaw<{ id: string; name: string }[]>`
      SELECT id, name FROM services WHERE active
    `;
    const idPorNome = new Map(servicos.map((s) => [s.name, s.id]));

    for (const pessoa of professionals) {
      const dias = new Set<number>();
      for (const faixa of pessoa.schedule) {
        if (dias.has(faixa.weekday)) {
          throw new OnboardingError('invalid_catalog', `A jornada de "${pessoa.name}" repete um dia da semana.`);
        }
        dias.add(faixa.weekday);
      }
      for (const nome of pessoa.serviceNames ?? []) {
        if (!idPorNome.has(nome)) {
          throw new OnboardingError('invalid_catalog', `O serviço "${nome}" atribuído a "${pessoa.name}" não existe.`);
        }
      }
    }

    await tx.$executeRaw`
      UPDATE professionals SET active = false, updated_at = now()
      WHERE kind = 'professional' AND location_id = ${locationId}::uuid
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
        ? pessoa.serviceNames.map((nome) => idPorNome.get(nome)!)
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
  locationId: string,
  methods: readonly PaymentMethod[],
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.$executeRaw`
      UPDATE locations SET payment_methods = ${[...methods]}, updated_at = now()
       WHERE id = ${locationId}::uuid
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
  return withTenant(tenantId, async (tx) => {
    // O mesmo row lock usado pelas etapas destrutivas: publicação e replace não
    // podem decidir sobre snapshots diferentes do primeiro dia.
    const base = await tx.$queryRaw<{ published_at: Date | null; slug: string }[]>`
      SELECT t.published_at, s.slug
        FROM tenants t
        JOIN tenant_slugs s ON s.tenant_id = t.id AND s.is_primary
       LIMIT 1
       FOR UPDATE OF t
    `;
    const tenant = base[0];
    if (!tenant) throw new OnboardingError('unknown_tenant', 'Barbearia não encontrada');

    const contagens = await tx.$queryRaw<{
      services: bigint;
      professionals: bigint;
      schedules: bigint;
    }[]>`
      SELECT
        (SELECT count(*) FROM services WHERE active) AS services,
        (SELECT count(*) FROM professionals p
          JOIN locations l ON l.id = p.location_id
         WHERE p.active AND p.kind = 'professional' AND l.active) AS professionals,
        (SELECT count(*) FROM work_schedules w
          JOIN professionals p ON p.id = w.professional_id
          JOIN locations l ON l.id = p.location_id
         WHERE p.active AND p.kind = 'professional' AND l.active) AS schedules
    `;
    const counts = contagens[0];
    if (!counts || Number(counts.services) === 0 || Number(counts.professionals) === 0) {
      throw new OnboardingError(
        'nothing_to_publish',
        'Cadastre pelo menos um serviço e um profissional antes de publicar.',
      );
    }
    if (Number(counts.schedules) === 0) {
      throw new OnboardingError(
        'nothing_to_publish',
        'Defina o horário de trabalho da equipe: sem jornada, a agenda nasce vazia.',
      );
    }

    const linhas = await tx.$queryRaw<{ published_at: Date }[]>`
      UPDATE tenants
      SET published_at = COALESCE(published_at, now()),
          onboarding_step = 6,
          updated_at = now()
      RETURNING published_at
    `;
    const quando = linhas[0]?.published_at;
    if (!quando) throw new OnboardingError('unknown_tenant', 'Barbearia não encontrada');
    return { slug: tenant.slug, publishedAt: quando.toISOString() };
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

  /** Abaixo disso não marca online em hora de pico. Nulo é desligado (bloco 60). */
  readonly onlineBlockScore?: number | null;
  /** A partir disso, passa na frente entre iguais na lista de espera. */
  readonly waitlistTrustedScore?: number;

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
  locationId: string,
  input: ChangeWindowInput,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.$executeRaw`
      UPDATE locations SET
        cancel_min_hours = ${input.cancelMinHours},
        reschedule_min_hours = ${input.rescheduleMinHours},
        max_reschedules = ${input.maxReschedules},
        cancellation_policy = CASE WHEN ${input.cancellationPolicy === undefined}::boolean
                              THEN cancellation_policy ELSE ${input.cancellationPolicy ?? null} END,
        updated_at = now()
      WHERE id = ${locationId}::uuid
    `;

    /**
     * Os dois limiares do score (bloco 60), cada um só quando vem.
     *
     * `onlineBlockScore` aceita nulo **explícito** como valor — nulo é
     * desligado, e desligar precisa ser possível pela tela. Por isso o teste é
     * `!== undefined` e não uma checagem de veracidade: `?? null` aqui apagaria
     * a regra toda vez que a tela de janela salvasse sem tocar nela.
     */
    if (input.onlineBlockScore !== undefined) {
      await tx.$executeRaw`
        UPDATE locations SET online_block_score = ${input.onlineBlockScore}, updated_at = now()
         WHERE id = ${locationId}::uuid
      `;
    }
    if (input.waitlistTrustedScore !== undefined) {
      await tx.$executeRaw`
        UPDATE locations SET waitlist_trusted_score = ${input.waitlistTrustedScore},
                             updated_at = now()
         WHERE id = ${locationId}::uuid
      `;
    }

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
        WHERE id = ${locationId}::uuid
      `;
    }

    // Os dois juntos, e não um campo por vez: encarregado é nome **e** contato,
    // e salvar metade deixaria o e-mail do antecessor apontando para o nome do
    // sucessor. Vazio vira nulo — a CHECK do banco recusa `''` como e-mail.
    if (input.dpoName !== undefined || input.dpoEmail !== undefined) {
      // REPARO DA VALIDAÇÃO: o campo é `string | null`, e o guarda só excluía
      // `undefined` — nulo chegava ao `.trim()`. Nulo aqui significa **apagar**
      // o encarregado, que é decisão diferente de "não mexa".
      const nome = input.dpoName == null ? input.dpoName ?? undefined : input.dpoName.trim();
      const email = input.dpoEmail == null ? input.dpoEmail ?? undefined : input.dpoEmail.trim();
      await tx.$executeRaw`
        UPDATE tenants SET
          dpo_name = CASE WHEN ${nome === undefined}::boolean THEN dpo_name
                          ELSE ${nome && nome.length > 0 ? nome : null} END,
          dpo_email = CASE WHEN ${email === undefined}::boolean THEN dpo_email
                           ELSE ${email && email.length > 0 ? email : null} END,
          updated_at = now()
         WHERE id = ${tenantId}::uuid
      `;
    }
  });
}

/** O que a tela de políticas mostra preenchido. */
export async function getPolicies(tenantId: string, locationId: string): Promise<{
  readonly cancelMinHours: number;
  readonly rescheduleMinHours: number;
  readonly maxReschedules: number;
  readonly cancellationPolicy: string | null;
  readonly maxDiscountBps: number;
  readonly creditScope: 'empresa' | 'unidade';
  readonly onlineBlockScore: number | null;
  readonly waitlistTrustedScore: number;
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
        online_block_score: number | null;
        waitlist_trusted_score: number;
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
             l.online_block_score, l.waitlist_trusted_score,
             t.dpo_name, t.dpo_email,
             l.deposit_mode, l.deposit_fixed_cents, l.deposit_percent_bps,
             l.deposit_score_threshold, l.deposit_ticket_over_cents,
             l.deposit_refund_hours
        FROM locations l
        JOIN tenants t ON t.id = l.tenant_id
       WHERE l.id = ${locationId}::uuid
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
      onlineBlockScore: linha.online_block_score,
      waitlistTrustedScore: linha.waitlist_trusted_score,
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
export async function getPhotoTargets(tenantId: string, locationId: string): Promise<PhotoTargets | null> {
  return withTenant(tenantId, async (tx) => {
    const unidades = await tx.$queryRaw<{ cover_url: string | null }[]>`
      SELECT cover_url FROM locations WHERE id = ${locationId}::uuid LIMIT 1
    `;
    const unidade = unidades[0];
    if (!unidade) return null;

    const marcas = await tx.$queryRaw<{ logo_url: string | null }[]>`
      SELECT logo_url FROM tenants WHERE id = ${tenantId}::uuid
    `;

    const equipe = await tx.$queryRaw<{ id: string; name: string; photo_url: string | null }[]>`
      SELECT id, name, photo_url FROM professionals
      WHERE active AND kind = 'professional' AND location_id = ${locationId}::uuid
      ORDER BY name
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
  locationId: string,
  input: PhotoInput,
): Promise<{ readonly saved: number }> {
  return withTenant(tenantId, async (tx) => {
    let gravadas = 0;

    if (input.coverUrl !== undefined) {
      // A capa é **da loja**, não da mais antiga: fixada em `ORDER BY
      // created_at LIMIT 1`, a filial nunca tinha capa própria e a matriz
      // trocava de foto quando alguém salvava a da filial.
      await tx.$executeRaw`
        UPDATE locations SET cover_url = ${input.coverUrl}, updated_at = now()
        WHERE id = ${locationId}::uuid
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
      const afetadas = await tx.$executeRaw`
        UPDATE professionals SET photo_url = ${pessoa.photoUrl}, updated_at = now()
        WHERE id = ${pessoa.id}::uuid AND location_id = ${locationId}::uuid
      `;
      if (afetadas === 0) throw new OnboardingError('invalid_catalog', 'Profissional da foto não encontrado nesta unidade.');
      if (pessoa.photoUrl) gravadas += 1;
    }

    for (const servico of input.services ?? []) {
      if (servico.photoUrl === undefined) continue;
      const afetadas = await tx.$executeRaw`
        UPDATE services SET photo_url = ${servico.photoUrl}, updated_at = now()
        WHERE id = ${servico.id}::uuid
      `;
      if (afetadas === 0) throw new OnboardingError('invalid_catalog', 'Serviço da foto não encontrado.');
      if (servico.photoUrl) gravadas += 1;
    }

    return { saved: gravadas };
  });
}
