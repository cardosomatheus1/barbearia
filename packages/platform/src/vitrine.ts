import { semTenant, withTenant } from '@barbearia/db';
import {
  caixaDaBusca,
  comDestaques,
  filtrarBusca,
  passaNaDisponibilidade,
  RESULTADOS_POR_BUSCA,
  resumoPublico,
  type BarbeariaNaVitrine,
  type CasaParaAgenda,
  type Disponibilidade,
  type FiltroDaBusca,
  type HorarioDaVitrine,
  type ResultadoDaBusca,
} from '@barbearia/core';
import { proximosHorariosEmLote } from '@barbearia/scheduling';
import { destaquesDaCidade } from './destaque.js';

/**
 * A vitrine do marketplace, do banco para a busca (bloco 70, SPEC §5.2).
 *
 * ## `semTenant`, e por que isto não é uma brecha
 *
 * A busca atravessa barbearias de propósito: descobrir qual é a barbearia é o
 * que ela faz, e portanto ela roda **antes** de existir tenant no contexto. Uma
 * consulta com RLS e sem tenant devolve zero linhas, sempre e em silêncio.
 *
 * A garantia aqui não é a política — é o **conteúdo** de `marketplace_listings`:
 * nome, endereço, coordenada, foto, faixa de preço e nota, tudo que a página
 * pública da barbearia já mostra a qualquer visitante. Nenhuma coluna dela
 * alcança cliente, agenda ou dinheiro, e a atualização é escrita `withTenant`,
 * de dentro da barbearia.
 */
export async function buscarNaVitrine(
  filtro: FiltroDaBusca,
  limite: number = RESULTADOS_POR_BUSCA,
): Promise<readonly (ResultadoDaBusca & CasaParaAgenda)[]> {
  const caixa = caixaDaBusca(filtro.de, filtro.raioKm);

  return semTenant(async (tx) => {
    /**
     * O recorte grosseiro é da consulta; o exato é de `packages/core`.
     *
     * Comparar quatro números com duas colunas é varredura de índice; haversine
     * dentro do `WHERE` é uma conta por linha sobre a tabela inteira. A caixa
     * traz os cantos a mais, e `filtrarBusca` os corta.
     *
     * A barbearia bloqueada não aparece: quem não está pagando a plataforma não
     * é vendida por ela.
     */
    const linhas = await tx.$queryRaw<
      {
        tenant_id: string;
        location_id: string;
        slug: string;
        name: string;
        city: string | null;
        state: string | null;
        latitude: string;
        longitude: string;
        cover_url: string | null;
        price_from_cents: number | null;
        price_from_service_id: string | null;
        rating_bps: number | null;
        rating_count: number;
        amenities: string[];
        has_club: boolean;
      }[]
    >`
      SELECT m.tenant_id, m.location_id, m.slug, m.name, m.city, m.state,
             m.latitude, m.longitude, m.cover_url,
             m.price_from_cents, m.price_from_service_id,
             m.rating_bps, m.rating_count, m.amenities, m.has_club
        FROM marketplace_listings m
        LEFT JOIN tenant_platform tp ON tp.tenant_id = m.tenant_id
       WHERE m.latitude BETWEEN ${caixa.latMin} AND ${caixa.latMax}
         AND m.longitude BETWEEN ${caixa.lonMin} AND ${caixa.lonMax}
         AND tp.blocked_at IS NULL
    `;

    const candidatas: (BarbeariaNaVitrine & CasaParaAgenda)[] = linhas.map((l) => ({
      tenantId: l.tenant_id,
      locationId: l.location_id,
      precoServicoId: l.price_from_service_id,
      slug: l.slug,
      nome: l.name,
      cidade: l.city,
      estado: l.state,
      latitude: Number(l.latitude),
      longitude: Number(l.longitude),
      fotoUrl: l.cover_url,
      precoDeCents: l.price_from_cents === null ? null : Number(l.price_from_cents),
      notaBps: l.rating_bps === null ? null : Number(l.rating_bps),
      avaliacoes: Number(l.rating_count),
      comodidades: l.amenities,
      temClube: l.has_club,
    }));

    return filtrarBusca(candidatas, filtro, limite);
  });
}

/**
 * Quantas candidatas o filtro de disponibilidade chega a analisar.
 *
 * Rodar o motor por casa custa uma transação, então a lista que vai ao lote tem
 * teto. Quarenta é o dobro do que a busca devolve: dá folga para metade delas
 * estar lotada e a página ainda encher.
 *
 * O teto não é silencioso. `analisadas` volta na resposta e a tela diz quando
 * ele foi alcançado — *"número de relatório que ignora parte do dado diz isso na
 * tela"*, e uma lista curta com cara de completa é pior do que uma lista curta
 * que se explica.
 */
export const CANDIDATAS_COM_DISPONIBILIDADE = 40;

export interface BuscaComHorario {
  readonly resultados: readonly (ResultadoDaBusca & {
    readonly proximoHorario: HorarioDaVitrine | null;
    /** Se este card foi pago (bloco 75). A tela é obrigada a dizer. */
    readonly patrocinado: boolean;
  })[];
  /** Quantas casas o lote chegou a consultar. */
  readonly analisadas: number;
  /** Se o teto de análise foi alcançado — a tela diz isso em letras. */
  readonly truncada: boolean;
}

/**
 * A busca com o "próximo horário" de cada card (bloco 71, SPEC §5.2).
 *
 * ## A ordem importa, e é esta
 *
 * Buscar, **ordenar**, cortar no teto de análise, consultar a agenda das que
 * sobraram e só então aplicar o filtro de disponibilidade. Filtrar antes de
 * ordenar não teria como: a disponibilidade não está no banco, ela é calculada.
 * Cortar em vinte antes de consultar seria pior — com metade da lista lotada, o
 * filtro "disponível hoje" devolveria dez resultados sobre uma cidade que tem
 * cem barbearias com vaga.
 *
 * ## Sem filtro, o lote roda igual
 *
 * O card mostra o horário sempre — é ele que *"diferencia de diretório"*. O que
 * o filtro muda é quem fica na lista, não se a agenda é consultada.
 */
export async function buscarComHorario(
  filtro: FiltroDaBusca,
  disponibilidade: Disponibilidade,
  agora: Date = new Date(),
): Promise<BuscaComHorario> {
  const teto =
    disponibilidade === 'qualquer' ? RESULTADOS_POR_BUSCA : CANDIDATAS_COM_DISPONIBILIDADE;
  const candidatas = await buscarNaVitrine(filtro, teto);

  const horarios = await proximosHorariosEmLote(
    candidatas.map((c) => ({
      tenantId: c.tenantId,
      locationId: c.locationId,
      serviceId: c.precoServicoId,
    })),
    agora,
  );

  const resultados = candidatas
    .map((casa) => {
      /**
       * A projeção acontece **aqui**, e não só na rota.
       *
       * Com `{ ...casa }` o objeto continuava carregando `tenantId`,
       * `locationId` e o serviço do piso em tempo de execução, enquanto o tipo
       * de retorno afirmava que eles não existiam. O compilador passava a
       * garantir "isto é público" sobre um objeto que não era, e a única
       * barreira real virava a lista de onze campos escrita à mão no
       * controller: a primeira pessoa a escrever `resultados: busca.resultados`
       * — numa paginação, num bloco de JSON-LD — mandaria o id da barbearia
       * para a internet sem nada ficar vermelho. E `tenantId` não é público em
       * lugar nenhum: o token da sessão do gestor é `<tenantId>.<segredo>`.
       *
       * Achado da `/security-review` deste bloco.
       */
      const { tenantId: _t, precoServicoId: _s, ...publico } = casa;
      return { ...publico, proximoHorario: horarios.get(casa.locationId) ?? null };
    })
    .filter((casa) => passaNaDisponibilidade(casa.proximoHorario, disponibilidade, agora))
    .slice(0, RESULTADOS_POR_BUSCA);

  /**
   * O destaque pago entra **em cima e marcado** (bloco 75).
   *
   * Depois do filtro, nunca antes: quem comprou destaque e não tem vaga hoje
   * não aparece numa busca por "disponível hoje". O destaque compra posição
   * entre resultados válidos, não o direito de contrariar o que a pessoa pediu.
   *
   * As cidades saem **dos próprios resultados**, todas elas. A primeira versão
   * usava a cidade da primeira casa da lista, e isso quebrava em silêncio: um
   * raio que cruza a divisa municipal, ou um primeiro colocado com `city` nula,
   * buscava os anúncios da cidade errada — a barbearia pagava e o card nunca
   * era promovido, sem erro em lugar nenhum.
   *
   * E o casamento é por **unidade**: `slug` vem de `tenant_slugs` e é o mesmo
   * para todas as lojas de uma rede.
   */
  const cidades = new Map<string, { readonly cidade: string; readonly estado: string }>();
  for (const casa of resultados) {
    if (casa.cidade && casa.estado) {
      cidades.set(`${casa.cidade}/${casa.estado}`, { cidade: casa.cidade, estado: casa.estado });
    }
  }

  const pagos = (
    await Promise.all(
      [...cidades.values()].map((c) => destaquesDaCidade(c.cidade, c.estado, agora)),
    )
  ).flat();

  const comPatrocinio = comDestaques(resultados, pagos).map((r) => {
    // A projeção pública acontece aqui, no fim: o casamento precisou do
    // `locationId`, e ele não atravessa esta linha.
    const { locationId: _l, ...publico } = r.casa;
    return { ...publico, patrocinado: r.patrocinado };
  });

  return {
    resultados: comPatrocinio,
    analisadas: candidatas.length,
    truncada: candidatas.length >= teto && disponibilidade !== 'qualquer',
  };
}

/**
 * Refaz a linha da vitrine de uma unidade.
 *
 * Chamada de **dentro** da barbearia, `withTenant`: os números saem de
 * `services` e `reviews`, que têm RLS, e é assim que a cópia continua sendo
 * feita por quem tem direito de ler o original.
 *
 * A linha é apagada quando a unidade sai da vitrine — por opção da barbearia,
 * por falta de coordenada ou por não estar publicada. Deixá-la com uma coluna
 * "escondida" seria um estado que toda consulta futura teria que lembrar de
 * filtrar; ausência não se esquece.
 *
 * `now()` do banco e não um `agora` por parâmetro: `refreshed_at` responde
 * "quando esta cópia foi feita", que é um fato do banco, não uma decisão de
 * domínio. O corte das 48 horas da avaliação, esse sim, entra por parâmetro.
 */
export async function atualizarVitrine(params: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly agora?: Date;
}): Promise<boolean> {
  const agora = params.agora ?? new Date();
  const desde48h = new Date(agora.getTime() - 48 * 3_600_000);

  return withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        slug: string | null;
        name: string;
        city: string | null;
        state: string | null;
        latitude: string | null;
        longitude: string | null;
        cover_url: string | null;
        amenities: string[];
        listed: boolean;
        published: boolean;
        preco: number | null;
        preco_servico_id: string | null;
        clube: boolean;
      }[]
    >`
      SELECT ts.slug, t.name, l.city, l.state, l.latitude, l.longitude, l.cover_url,
             l.amenities, l.listed_in_marketplace AS listed,
             t.published_at IS NOT NULL AS published,
             piso.price_cents AS preco, piso.id AS preco_servico_id,
             /**
              * "Tem plano de assinatura" é um booleano, e a decisão de
              * publicá-lo é escrita.
              *
              * A SPEC §5.2 lista assinatura entre os filtros da busca, então ele
              * precisa existir. O que sai é só a existência — nunca o preço, o
              * nome do plano ou quantos assinam —, e é a mesma coisa que a
              * barbearia diz na vitrine da loja. A revisão cobrou a decisão em
              * vez de a herança, e esta é a decisão.
              */
             EXISTS (SELECT 1 FROM club_plans cp WHERE cp.active) AS clube
        FROM locations l
        JOIN tenants t ON t.id = l.tenant_id
        LEFT JOIN tenant_slugs ts ON ts.tenant_id = l.tenant_id AND ts.is_primary
        /**
         * O piso é o do que a página pública **de fato oferece**, e ele sai daqui
         * uma vez só — com o preço e com o id do serviço.
         *
         * A primeira versão usava min(price_cents) de todo serviço ativo, e
         * publicava numa vitrine anônima o preço que a barbearia tinha mantido
         * fora da própria página: serviço sem bookable_online, ou sem nenhum
         * profissional que o faça online. Achado da /security-review do bloco
         * 70. O predicado é o mesmo de getPublicProfile — duas noções de "o que
         * é público" é como uma delas fica para trás.
         *
         * Desde o bloco 71 ele também devolve o **id**, porque é esse serviço
         * que o lote consulta para o "próximo horário": preço e horário no mesmo
         * card precisam falar da mesma coisa. Escrever o predicado de novo lá
         * seria a terceira cópia dele.
         *
         * O desempate por id é o que torna a escolha estável: com dois serviços
         * do mesmo preço, a ordem da consulta trocaria o card entre duas
         * atualizações sem nada ter mudado.
         */
        LEFT JOIN LATERAL (
          SELECT s.id, s.price_cents
            FROM services s
            JOIN professional_services ps ON ps.service_id = s.id
            JOIN professionals p ON p.id = ps.professional_id
           WHERE s.active AND s.bookable_online
             AND p.active AND p.bookable_online
             AND p.kind IN ('professional', 'external')
             AND p.location_id = l.id
           ORDER BY s.price_cents, s.id
           LIMIT 1
        ) piso ON true
       WHERE l.id = ${params.locationId}::uuid
    `;
    const casa = linhas[0];

    const fora =
      !casa ||
      !casa.slug ||
      !casa.listed ||
      !casa.published ||
      casa.latitude === null ||
      casa.longitude === null;

    if (fora) {
      /**
       * O `DELETE` é escopado pelo tenant do contexto, não só pelo id.
       *
       * `marketplace_listings` não tem RLS, e este é o único ponto do arquivo em
       * que um id atravessa a fronteira de uma tabela que a política não cobre.
       * Hoje o único chamador enumera as unidades sob a RLS da própria
       * barbearia — mas o contrato da função não pode depender do que os
       * chamadores de hoje acertam. É o defeito que a revisão do 58 e a do 68 já
       * acharam duas vezes, e a terceira foi antes de virar rota.
       */
      await tx.$executeRaw`
        DELETE FROM marketplace_listings
         WHERE location_id = ${params.locationId}::uuid
           AND tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
      `;
      return false;
    }

    /**
     * A nota da vitrine é a **pública**, e quem a calcula é `resumoPublico`.
     *
     * A mesma função da página da barbearia, com o mesmo mínimo de avaliações:
     * duas fontes para a mesma nota fariam o card do marketplace e a página
     * dizerem números diferentes sobre a mesma casa.
     */
    const notas = await tx.$queryRaw<{ rating: number }[]>`
      SELECT r.rating FROM reviews r
       -- Contestada sai da vitrine (bloco 80), e só dela.
       WHERE r.contested_at IS NULL
         AND (r.rating >= 4 OR r.created_at <= ${desde48h})
    `;
    const resumo = resumoPublico(notas.map((n) => n.rating));

    await tx.$executeRaw`
      INSERT INTO marketplace_listings (
        location_id, tenant_id, slug, name, city, state, latitude, longitude,
        cover_url, price_from_cents, price_from_service_id, rating_bps, rating_count,
        amenities, has_club, refreshed_at
      ) VALUES (
        ${params.locationId}::uuid,
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${casa.slug}, ${casa.name}, ${casa.city}, ${casa.state},
        ${casa.latitude}::numeric, ${casa.longitude}::numeric,
        ${casa.cover_url}, ${casa.preco === null ? null : Number(casa.preco)},
        ${casa.preco_servico_id}::uuid,
        ${resumo.media === null ? null : Math.round(resumo.media * 100)},
        ${resumo.total}, ${casa.amenities}, ${casa.clube}, now()
      )
      ON CONFLICT (location_id) DO UPDATE SET
        slug = EXCLUDED.slug, name = EXCLUDED.name, city = EXCLUDED.city,
        state = EXCLUDED.state, latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude, cover_url = EXCLUDED.cover_url,
        price_from_cents = EXCLUDED.price_from_cents,
        price_from_service_id = EXCLUDED.price_from_service_id,
        rating_bps = EXCLUDED.rating_bps,
        rating_count = EXCLUDED.rating_count, amenities = EXCLUDED.amenities,
        has_club = EXCLUDED.has_club, refreshed_at = EXCLUDED.refreshed_at
    `;
    return true;
  });
}

/**
 * Refaz a vitrine de **todas** as unidades de uma barbearia.
 *
 * É o que os caminhos de escrita chamam: quem publica ou edita o cadastro não
 * sabe — e não deve saber — quantas lojas a rede tem.
 */
export async function atualizarVitrineDaCasa(
  tenantId: string,
  agora: Date = new Date(),
): Promise<number> {
  const unidades = await withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM locations`;
    return linhas.map((l) => l.id);
  });

  let vivas = 0;
  for (const locationId of unidades) {
    if (await atualizarVitrine({ tenantId, locationId, agora })) vivas += 1;
  }
  return vivas;
}

/**
 * A varredura que refaz a vitrine inteira.
 *
 * Existe porque preço, nota e clube mudam **sem** passar pelo caminho que
 * publica: um serviço editado no catálogo, uma avaliação que completa 48 horas e
 * entra na média, um plano de clube desativado. Chamar a atualização de dentro
 * de cada um desses módulos espalharia a vitrine por cinco pacotes que não a
 * conhecem — e o que se ganharia em frescor se perderia no primeiro caminho novo
 * que alguém escrevesse sem lembrar dela.
 *
 * A janela de defasagem é de um dia, e `refreshed_at` a torna verificável.
 */
export async function varrerVitrine(agora: Date = new Date()): Promise<number> {
  const casas = await semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<{ tenant_id: string }[]>`
      SELECT tenant_id FROM tenant_platform WHERE blocked_at IS NULL
    `;
    return linhas.map((l) => l.tenant_id);
  });

  let refeitas = 0;
  for (const tenantId of casas) refeitas += await atualizarVitrineDaCasa(tenantId, agora);
  return refeitas;
}

/**
 * As cidades que têm barbearia na vitrine, com o centro delas.
 *
 * ## Por que a busca começa por cidade, e não por "perto de mim"
 *
 * *"Barbearias perto de mim"* precisa da coordenada do aparelho, e lê-la exige
 * JavaScript no navegador — o primeiro componente de cliente deste produto, que
 * é uma decisão de arquitetura com medição de pacote e não uma linha de código.
 * Ela está declarada como lacuna.
 *
 * O que dá para entregar sem isso, e não é um consolo: a pessoa escolhe a
 * cidade e busca a partir do centro dela. O centro **sai das próprias
 * barbearias** — a média das coordenadas listadas —, e não de uma tabela de
 * municípios que alguém teria que manter: uma dependência de dado externo para
 * responder o que o próprio cadastro já sabe.
 */
export async function cidadesNaVitrine(): Promise<
  readonly {
    readonly cidade: string;
    readonly estado: string;
    readonly latitude: number;
    readonly longitude: number;
    readonly casas: number;
  }[]
> {
  return semTenant(async (tx) => {
    const linhas = await tx.$queryRaw<
      { city: string; state: string; lat: string; lon: string; casas: bigint }[]
    >`
      SELECT m.city, m.state,
             avg(m.latitude)::numeric AS lat, avg(m.longitude)::numeric AS lon,
             count(*)::bigint AS casas
        FROM marketplace_listings m
        LEFT JOIN tenant_platform tp ON tp.tenant_id = m.tenant_id
       WHERE tp.blocked_at IS NULL AND m.city IS NOT NULL AND m.state IS NOT NULL
       GROUP BY m.city, m.state
       ORDER BY count(*) DESC, m.city
    `;
    return linhas.map((l) => ({
      cidade: l.city,
      estado: l.state,
      latitude: Number(l.lat),
      longitude: Number(l.lon),
      casas: Number(l.casas),
    }));
  });
}

/**
 * Liga ou desliga a barbearia na vitrine, e refaz as linhas na hora.
 *
 * Rota própria em vez de um campo em `saveBusiness`: aquela função grava o
 * cadastro inteiro, e chamá-la para mexer num interruptor exigiria reenviar
 * endereço, telefone e comodidades — o caminho em que um campo vazio apaga o que
 * ninguém queria apagar. É a mesma razão de o segundo fator e a unidade da
 * sessão terem rota própria.
 */
export async function definirVitrine(params: {
  readonly tenantId: string;
  /**
   * Qual loja entra ou sai da busca. Sem ela, o gerente escopado a uma filial
   * tirava a rede inteira do marketplace com um clique no interruptor da tela
   * dele — e o dono descobriria pelo telefone que parou de tocar.
   */
  readonly locationId: string;
  readonly ligado: boolean;
  readonly agora?: Date;
}): Promise<{ readonly ligado: boolean; readonly unidades: number }> {
  await withTenant(params.tenantId, async (tx) => {
    await tx.$executeRaw`
      UPDATE locations SET listed_in_marketplace = ${params.ligado}
       WHERE id = ${params.locationId}::uuid
    `;
  });
  const unidades = await atualizarVitrineDaCasa(params.tenantId, params.agora);
  return { ligado: params.ligado, unidades };
}

/** Se a barbearia está na vitrine hoje, para a tela desenhar o interruptor. */
export async function lerVitrine(
  tenantId: string,
): Promise<{ readonly ligado: boolean; readonly naVitrine: number }> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ ligado: boolean; publicadas: bigint }[]>`
      SELECT bool_or(l.listed_in_marketplace) AS ligado,
             count(*) FILTER (WHERE l.listed_in_marketplace)::bigint AS publicadas
        FROM locations l
    `;
    return {
      ligado: linhas[0]?.ligado === true,
      naVitrine: Number(linhas[0]?.publicadas ?? 0),
    };
  });
}
