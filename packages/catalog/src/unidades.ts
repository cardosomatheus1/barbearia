import { resolverCoordenada } from '@barbearia/core';
import { withTenant } from '@barbearia/db';
import { audit } from '@barbearia/identity';
import { CatalogError } from './servicos.js';

/**
 * Abrir e fechar uma loja (bloco 58, SPEC §1.1).
 *
 * ## Por que em `catalog`, e não em `onboarding`
 *
 * O onboarding **cria a barbearia**, e a primeira unidade nasce com ela. Abrir a
 * segunda é a mesma operação que editar um serviço: cadastro de quem já está
 * funcionando. É a distinção que este pacote existe para carregar — o
 * onboarding substitui o conjunto inteiro, o que é certo para quem está abrindo
 * e errado a partir do dia seguinte.
 *
 * ## Unidade fecha, não some
 *
 * Não existe apagar. A loja encerrada continua carregando a venda, a comissão
 * paga e a nota emitida, e toda chave estrangeira para `locations` é `RESTRICT`
 * justamente para que apagá-la não leve o registro do dinheiro junto. `active`
 * é o interruptor: a loja fechada some da seleção do balcão e o histórico fica.
 *
 * ## O fuso é da unidade
 *
 * E é a razão de ele ser pedido no cadastro. Uma rede com loja em Salvador e em
 * Rio Branco tem dois "hoje" diferentes, e o dia da venda sai do fuso de onde a
 * venda aconteceu — não do relógio de quem cadastrou.
 */

export interface UnidadeDoCadastro {
  readonly id: string;
  readonly nome: string;
  readonly timezone: string;
  readonly ativa: boolean;
  readonly cidade: string | null;
}

export async function unidadesDoCadastro(
  tenantId: string,
): Promise<readonly UnidadeDoCadastro[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      { id: string; name: string; timezone: string; active: boolean; city: string | null }[]
    >`
      SELECT id, name, timezone, active, city FROM locations ORDER BY created_at
    `;
    return linhas.map((l) => ({
      id: l.id,
      nome: l.name,
      timezone: l.timezone,
      ativa: l.active,
      cidade: l.city,
    }));
  });
}

export async function criarUnidade(request: {
  readonly tenantId: string;
  readonly nome: string;
  readonly timezone: string;
  readonly cidade?: string | null;
  /**
   * A UF e o link do mapa, para a filial entrar na busca (bloco 115).
   *
   * Sem coordenada, `atualizarVitrine` delista a unidade — e a segunda loja
   * nascia assim, invisível no marketplace, enquanto a matriz aparecia. A
   * assimetria não tinha explicação nenhuma na tela.
   */
  readonly estado?: string | null;
  readonly linkDoMapa?: string | null;
  readonly ator: { readonly id: string; readonly name: string };
}): Promise<{ readonly id: string }> {
  const nome = request.nome.trim();
  if (nome.length < 2) throw new CatalogError('invalid_location', 'O nome da unidade é curto demais.');

  return withTenant(request.tenantId, async (tx) => {
    const ponto = resolverCoordenada({
      ...(request.linkDoMapa !== undefined ? { linkDoMapa: request.linkDoMapa } : {}),
      ...(request.estado !== undefined ? { estado: request.estado } : {}),
    });

    const criadas = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO locations (tenant_id, name, timezone, city, state, latitude, longitude)
      VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid,
              ${nome}, ${request.timezone}, ${request.cidade?.trim() || null},
              ${request.estado?.trim().toUpperCase() || null},
              ${ponto?.latitude ?? null}, ${ponto?.longitude ?? null})
      RETURNING id
    `;
    const criada = criadas[0];
    if (!criada) throw new CatalogError('invalid_location', 'Não deu para criar a unidade.');

    /**
     * A loja nova nasce com gaveta.
     *
     * Sem ela, o formulário "Transferir entre contas" da filial listava a
     * gaveta da matriz e **sempre** respondia "Esta conta não existe" —
     * `transferirEntreContas` exige `is_cash && location_id === locationId`.
     * Botão que só dá erro, sem saída na tela (§6, pergunta 3).
     *
     * Aqui e não em `packages/finance`: a seta vai de `catalog` para `db`, e
     * `financial_accounts` é cadastro, não movimento — é a mesma tabela que a
     * migração 0054 semeia para quem já existia. O nome sai do nome da loja
     * porque o índice de nome é por barbearia, e "Caixa da loja" colidiria na
     * segunda.
     */
    await tx.$executeRaw`
      INSERT INTO financial_accounts (tenant_id, location_id, name, is_cash)
      VALUES (NULLIF(current_setting('app.tenant_id', true), '')::uuid,
              ${criada.id}::uuid, ${`Caixa · ${nome}`}, true)
      -- Alvo explicito, e nao um ON CONFLICT DO NOTHING solto.
      --
      -- Sem alvo, o DO NOTHING engole **qualquer** indice unico da tabela, e ha
      -- dois. O nome da loja nao tem unicidade — duas lojas "Centro" sao
      -- legitimas —, entao a segunda geraria "Caixa - Centro", colidiria no
      -- indice de nome e a loja nasceria **sem gaveta**, em silencio: o estado
      -- que o comentario acima descreve como botao que so da erro.
      --
      -- Com o alvo, so a reentrancia legitima e absorvida; a colisao de nome
      -- estoura e vira erro tratavel. Achado da revisao de seguranca do bloco.
      ON CONFLICT (location_id) WHERE is_cash DO NOTHING
    `;

    await audit(tx, {
      actorId: request.ator.id,
      actorName: request.ator.name,
      action: 'location.created',
      entity: 'locations',
      entityId: criada.id,
      after: { nome, timezone: request.timezone },
    });

    return { id: criada.id };
  });
}

/**
 * Fecha (ou reabre) uma loja.
 *
 * **A última aberta não fecha.** Sem esta recusa, a barbearia inteira ficaria
 * sem unidade operável com um clique: `resolverUnidade` devolveria
 * `unidade_fechada` para todo mundo, e as vinte rotas do painel passariam a
 * responder 404 — inclusive a que reabriria a loja.
 *
 * A contagem é feita **dentro da transação**, com a linha travada: duas abas
 * fechando as duas últimas ao mesmo tempo leriam "há duas abertas" e as duas
 * passariam.
 */
export async function definirUnidadeAtiva(request: {
  readonly tenantId: string;
  readonly locationId: string;
  readonly ativa: boolean;
  /**
   * As lojas que o ator pode operar. **Vazio significa todas**, como em todo o
   * resto do schema — negar por omissão trancaria a equipe inteira no dia da
   * migração, porque nenhuma barbearia existente tem linha em `staff_locations`.
   */
  readonly autorizadas: readonly string[];
  readonly ator: { readonly id: string; readonly name: string };
}): Promise<void> {
  await withTenant(request.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ id: string; name: string; active: boolean }[]>`
      SELECT id, name, active FROM locations WHERE id = ${request.locationId}::uuid FOR UPDATE
    `;
    const unidade = linhas[0];
    if (!unidade) throw new CatalogError('location_not_found', 'Esta unidade não existe.');

    /**
     * O escopo é conferido **aqui**, e não na borda nem no seletor (bloco 104).
     *
     * A RLS separa barbearias e **não** separa lojas dentro de uma. A rota
     * vizinha deste mesmo controller — a transferência de estoque — já recebia
     * `autorizadas` por causa do achado do bloco 58; esta ficou de fora, e o
     * resultado foi reproduzido de ponta a ponta: um gerente escopado à filial
     * fechou a matriz e recebeu `201 {"ok":true}`.
     *
     * O estrago não é ler dado alheio, é derrubar operação: fechar zera o
     * `location_id` das sessões de quem estava lá, e a equipe inteira da matriz
     * passa a receber 404 em toda rota do painel até alguém com acesso a outra
     * loja reabrir. E não exige `curl` — a tela lista as duas unidades com o
     * botão "Fechar" ao lado de cada uma.
     *
     * A recusa usa a **mesma mensagem de inexistente**: "existe, mas não é sua"
     * confirma o id para quem o adivinhou, e é o precedente do OTP.
     */
    if (request.autorizadas.length > 0 && !request.autorizadas.includes(request.locationId)) {
      throw new CatalogError('location_not_found', 'Esta unidade não existe.');
    }

    if (!request.ativa) {
      const abertas = await tx.$queryRaw<{ total: bigint }[]>`
        SELECT count(*) AS total FROM locations WHERE active
      `;
      if (Number(abertas[0]?.total ?? 0) <= 1) {
        throw new CatalogError('ultima_unidade', 'Esta é a única unidade aberta. A barbearia precisa de uma.');
      }
    }

    /**
     * Fechar derruba a escolha das sessões que estavam nela.
     *
     * Sem isto, quem estava operando a loja fechada continua com ela
     * selecionada e recebe `unidade_fechada` em toda tela — sem entender por
     * quê, e sem caminho de volta a não ser sair e entrar. Com a coluna nula,
     * a resolução cai na primeira aberta, que é o comportamento de sempre.
     */
    if (!request.ativa) {
      await tx.$executeRaw`
        UPDATE staff_sessions SET location_id = NULL
         WHERE location_id = ${request.locationId}::uuid
      `;
    }

    await tx.$executeRaw`
      UPDATE locations SET active = ${request.ativa} WHERE id = ${request.locationId}::uuid
    `;

    await audit(tx, {
      actorId: request.ator.id,
      actorName: request.ator.name,
      action: request.ativa ? 'location.reopened' : 'location.closed',
      entity: 'locations',
      entityId: request.locationId,
      before: { ativa: unidade.active },
      after: { ativa: request.ativa },
    });
  });
}
