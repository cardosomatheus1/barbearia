import { withTenant } from '@barbearia/db';
import { adotar, distanciaDoPadrao, republicar, type DistanciaDoPadrao } from '@barbearia/core';
import { CatalogError } from './servicos.js';

/**
 * O cardápio padrão da franquia, dos dois lados (bloco 76).
 *
 * ## Uma barbearia, duas leituras
 *
 * A franqueadora **publica**: escreve o item padrão, com nome, duração e preço
 * de referência. A franqueada **adota**: cria o serviço dela a partir do item,
 * copiando o preço uma vez, e a partir dali o preço é dela.
 *
 * As duas operações vivem no mesmo arquivo porque falam da mesma tabela e da
 * mesma regra. O que as separa não é código: é a **política de RLS**, que só
 * deixa a franqueadora escrever. Uma checagem de papel aqui seria a garantia
 * dependendo de alguém lembrar dela na próxima rota — no banco, a franqueada
 * que chamasse a rota da franqueadora não altera linha nenhuma.
 *
 * ## Por que aqui e não em `onboarding`
 *
 * Mesma divisão do bloco 12: `onboarding` monta a barbearia inteira de uma vez
 * e recria; aqui a pergunta é "adote este item", e ela acontece um item por vez,
 * ao longo de anos. Adotar nunca recria linha existente, porque
 * `appointment_services` aponta para `services.id`.
 */

export interface ItemPadrao {
  readonly id: string;
  readonly nome: string;
  readonly descricao: string | null;
  readonly referenciaCents: number;
  readonly duracaoMinutos: number;
  readonly categoria: string | null;
  readonly ativo: boolean;
  /** O serviço local que já adotou este item, quando existe. */
  readonly adotadoComo: {
    readonly serviceId: string;
    readonly praticadoCents: number;
    readonly quando: Date;
    readonly distancia: DistanciaDoPadrao | null;
  } | null;
}

export interface Franquia {
  readonly id: string;
  readonly nome: string;
  readonly papel: 'franqueadora' | 'franqueada';
}

/**
 * A franquia desta barbearia, ou `null` se ela não é de nenhuma.
 *
 * Sai da função `SECURITY DEFINER` que as políticas já usam, e não de uma
 * consulta escrita aqui: duas noções de "de qual franquia eu sou" divergiriam
 * no primeiro caminho novo, e uma delas é a que o banco aplica.
 */
export async function franquiaDaCasa(tenantId: string): Promise<Franquia | null> {
  return withTenant(tenantId, async (tx) => {
    /**
     * O papel sai de `papel_na_franquia()`, não de uma linha da tabela.
     *
     * A consulta original juntava `franchise_tenants` e pegava `linhas[0]`,
     * apostando que a RLS devolveria exatamente uma linha. O bloco 77 abriu a
     * política para a franqueadora enxergar quem está na rede dela — e a partir
     * dali ela recebia o próprio vínculo **e** o de cada franqueada, sem ordem
     * garantida. Meia dúzia de carregamentos e a tela dela dizia
     * `papel: 'franqueada'`, escondendo o formulário de publicar.
     *
     * Falhava fechado — `publicarItemDoPadrao` deriva o papel da mesma função
     * que a política usa —, então ninguém publicava o que não podia; mas quem
     * podia perdia o botão.
     */
    const linhas = await tx.$queryRaw<{ id: string; name: string; role: string }[]>`
      SELECT f.id, f.name, papel_na_franquia()::text AS role
        FROM franchises f
       WHERE f.id = franquia_do_contexto()
    `;
    const linha = linhas[0];
    if (!linha) return null;
    return {
      id: linha.id,
      nome: linha.name,
      papel: linha.role === 'franqueadora' ? 'franqueadora' : 'franqueada',
    };
  });
}

/**
 * O cardápio padrão, já casado com o que esta barbearia adotou.
 *
 * Uma consulta só, com `LEFT JOIN`: um laço perguntando "e este item, foi
 * adotado?" seria N+1 na tela que a franqueada abre para decidir o que vender.
 *
 * O casamento é por `franchise_service_id`, nunca pelo nome. A recepção edita a
 * descrição do serviço, e um "Corte social" renomeado deixaria de casar com o
 * item padrão em silêncio — é a mesma razão de o pacote casar por id.
 */
export async function padraoDaFranquia(tenantId: string): Promise<readonly ItemPadrao[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        name: string;
        description: string | null;
        reference_price_cents: number;
        duration_minutes: number;
        category_name: string | null;
        active: boolean;
        service_id: string | null;
        price_cents: number | null;
        adopted_at: Date | null;
      }[]
    >`
      SELECT fs.id, fs.name, fs.description, fs.reference_price_cents,
             fs.duration_minutes, fs.category_name, fs.active,
             s.id AS service_id, s.price_cents, s.adopted_at
        FROM franchise_services fs
        LEFT JOIN services s
               ON s.franchise_service_id = fs.id AND s.active
       WHERE fs.franchise_id = franquia_do_contexto()
       ORDER BY fs.position, fs.name
    `;

    return linhas.map((l) => {
      const referenciaCents = Number(l.reference_price_cents);
      const praticadoCents = l.price_cents === null ? null : Number(l.price_cents);
      return {
        id: l.id,
        nome: l.name,
        descricao: l.description,
        referenciaCents,
        duracaoMinutos: Number(l.duration_minutes),
        categoria: l.category_name,
        ativo: l.active,
        adotadoComo:
          l.service_id && praticadoCents !== null && l.adopted_at
            ? {
                serviceId: l.service_id,
                praticadoCents,
                quando: l.adopted_at,
                distancia: distanciaDoPadrao(referenciaCents, praticadoCents),
              }
            : null,
      };
    });
  });
}

/**
 * A franqueadora publica um item do padrão.
 *
 * `id` ausente cria; presente atualiza. Republicar **não** toca em nada dentro
 * de nenhuma franqueada — e quem garante isso não é uma cláusula esquecível
 * aqui: é o fato de esta função não escrever em `services`.
 */
export async function publicarItemDoPadrao(
  tenantId: string,
  entrada: {
    readonly id?: string | undefined;
    readonly nome: string;
    readonly descricao: string | null;
    readonly referenciaCents: number;
    readonly duracaoMinutos: number;
    readonly categoria: string | null;
    readonly posicao: number;
  },
): Promise<string> {
  const nome = entrada.nome.trim();
  if (!nome) throw new CatalogError('invalid_catalog', 'O item precisa de nome');
  if (!Number.isInteger(entrada.referenciaCents) || entrada.referenciaCents < 0) {
    throw new CatalogError('invalid_catalog', 'Preço de referência inválido');
  }
  if (!Number.isInteger(entrada.duracaoMinutos) || entrada.duracaoMinutos <= 0) {
    throw new CatalogError('invalid_catalog', 'Duração inválida');
  }

  return withTenant(tenantId, async (tx) => {
    const franquias = await tx.$queryRaw<{ id: string; role: string }[]>`
      SELECT franquia_do_contexto() AS id, papel_na_franquia()::text AS role
    `;
    const franquia = franquias[0];
    if (!franquia?.id) throw new CatalogError('invalid_catalog', 'Esta barbearia não é de uma franquia');
    /**
     * A recusa é aqui **também**, e não só na política.
     *
     * A política é quem garante — sem ela isto seria uma checagem esquecível.
     * Mas sem esta linha a franqueada receberia "0 linhas afetadas" e a tela
     * diria que salvou: recusa silenciosa é pior que erro visível.
     */
    if (franquia.role !== 'franqueadora') {
      throw new CatalogError('invalid_catalog', 'Só a franqueadora publica o padrão');
    }

    if (entrada.id) {
      const linhas = await tx.$queryRaw<{ id: string }[]>`
        UPDATE franchise_services
           SET name = ${nome}, description = ${entrada.descricao},
               reference_price_cents = ${entrada.referenciaCents},
               duration_minutes = ${entrada.duracaoMinutos},
               category_name = ${entrada.categoria},
               position = ${entrada.posicao}, updated_at = now()
         WHERE id = ${entrada.id}::uuid
        RETURNING id
      `;
      const item = linhas[0];
      if (!item) throw new CatalogError('service_not_found', 'Item do padrão não encontrado');

      /**
       * E só. A franqueadora **não** escreve dentro da franqueada — nem preço,
       * nem nome, nem duração.
       *
       * Não é limitação técnica travestida de princípio: a RLS de `services`
       * filtra pelo tenant do contexto, e um caminho que contornasse isso teria
       * que ser inventado de propósito. A pergunta é se valeria a pena inventar,
       * e a resposta é não — a assimetria "duração eu imponho, preço eu sugiro"
       * seria uma regra que ninguém consegue explicar no balcão.
       *
       * Quem age é sempre a franqueada: o item aparece na tela dela marcado como
       * mudado, e readotar aplica **tudo menos o preço**. Um lado só escreve
       * dentro de si mesmo, e o outro publica.
       */
      return item.id;
    }

    const criados = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO franchise_services
        (franchise_id, name, description, reference_price_cents, duration_minutes,
         category_name, position)
      VALUES (${franquia.id}::uuid, ${nome}, ${entrada.descricao},
              ${entrada.referenciaCents}, ${entrada.duracaoMinutos},
              ${entrada.categoria}, ${entrada.posicao})
      RETURNING id
    `;
    const item = criados[0];
    if (!item) throw new CatalogError('invalid_catalog', 'Não foi possível publicar o item');
    return item.id;
  });
}

/** Tira um item do padrão. Estado, nunca `DELETE`: quem adotou continua vendendo. */
export async function despublicarItemDoPadrao(tenantId: string, itemId: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ id: string }[]>`
      UPDATE franchise_services SET active = false, updated_at = now()
       WHERE id = ${itemId}::uuid AND active
      RETURNING id
    `;
    if (!linhas[0]) throw new CatalogError('service_not_found', 'Item do padrão não encontrado');
  });
}

/**
 * A franqueada adota um item do padrão.
 *
 * Cria o serviço local com o preço de referência **copiado uma vez**. Se já
 * existe serviço adotado daquele item, atualiza nome, descrição e duração — e
 * **não** o preço, que passou a ser dela na primeira adoção.
 *
 * O id do item vem do corpo da requisição, e por isso é conferido **sob RLS
 * antes de gravar**: a checagem de integridade referencial do Postgres ignora
 * row security, e a chave estrangeira aceitaria o item de outra franquia sem
 * reclamar.
 */
export async function adotarItemDoPadrao(
  tenantId: string,
  itemId: string,
): Promise<{ readonly serviceId: string; readonly novo: boolean }> {
  return withTenant(tenantId, async (tx) => {
    /**
     * Sem `FOR UPDATE`, e não é economia.
     *
     * No Postgres, `SELECT ... FOR UPDATE` passa **também** pela política de
     * escrita da tabela: travar exige poder alterar. A franqueada pode ler o
     * padrão e não pode escrevê-lo — por desenho —, então a trava devolvia zero
     * linhas e a adoção morria com "item não encontrado" sobre um item que
     * estava lá.
     *
     * A trava também não era necessária: a leitura aqui não decide uma escrita
     * **nesta** tabela. O que ela decide é uma linha em `services`, e quem
     * impede a segunda é o índice único parcial — com a condição na própria
     * instrução, porque violação de constraint dentro da transação aborta tudo.
     */
    const itens = await tx.$queryRaw<
      {
        id: string;
        name: string;
        description: string | null;
        reference_price_cents: number;
        duration_minutes: number;
        category_name: string | null;
      }[]
    >`
      SELECT id, name, description, reference_price_cents, duration_minutes, category_name
        FROM franchise_services
       WHERE id = ${itemId}::uuid AND active
    `;
    const item = itens[0];
    if (!item) throw new CatalogError('service_not_found', 'Item do padrão não encontrado');

    const doPadrao = {
      name: item.name,
      description: item.description,
      referenciaCents: Number(item.reference_price_cents),
      durationMinutes: Number(item.duration_minutes),
    };

    let categoriaId: string | null = null;
    if (item.category_name) {
      const categorias = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM service_categories
         WHERE lower(btrim(name)) = lower(btrim(${item.category_name}))
      `;
      categoriaId = categorias[0]?.id ?? null;
      if (!categoriaId) {
        const criadas = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO service_categories (tenant_id, name)
          VALUES (${tenantId}::uuid, ${item.category_name})
          RETURNING id
        `;
        categoriaId = criadas[0]?.id ?? null;
      }
    }

    const copia = adotar(doPadrao);

    /**
     * O preço entra **só** aqui, no `INSERT` da primeira adoção.
     *
     * `ON CONFLICT DO NOTHING` sobre o índice parcial: a segunda adoção não
     * cria linha, e não vira erro de banco no balcão. Zero linhas de volta
     * significa "já existe", e o caminho segue para a readoção.
     */
    const criados = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO services
        (tenant_id, category_id, name, description, price_cents, duration_minutes,
         franchise_service_id, adopted_at)
      VALUES (${tenantId}::uuid, ${categoriaId}::uuid, ${copia.name}, ${copia.description},
              ${copia.priceCents}, ${copia.durationMinutes}, ${itemId}::uuid, now())
      ON CONFLICT (tenant_id, franchise_service_id)
        WHERE franchise_service_id IS NOT NULL AND active
        DO NOTHING
      RETURNING id
    `;
    const criado = criados[0];
    if (criado) return { serviceId: criado.id, novo: true };

    /**
     * `republicar`, e não `adotar`: o tipo de retorno **não tem** `priceCents`,
     * então o compilador recusa quem tentar escrevê-lo aqui. A regra do bloco
     * fica onde ela pode ser testada sem banco, e a instrução herda a garantia
     * em vez de repeti-la.
     */
    const aplicar = republicar(doPadrao);
    const atualizados = await tx.$queryRaw<{ id: string }[]>`
      UPDATE services
         SET name = ${aplicar.name}, description = ${aplicar.description},
             category_id = ${categoriaId}::uuid,
             duration_minutes = ${aplicar.durationMinutes}, updated_at = now()
       WHERE franchise_service_id = ${itemId}::uuid AND active
      RETURNING id
    `;
    const atualizado = atualizados[0];
    if (!atualizado) throw new CatalogError('invalid_catalog', 'Não foi possível adotar o item');
    return { serviceId: atualizado.id, novo: false };
  });
}
