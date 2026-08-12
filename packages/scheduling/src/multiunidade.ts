import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  instantToLocal,
  resolverUnidade,
  type FalhaDaSelecao,
  type UnidadeNaSelecao,
} from '@barbearia/core';

/**
 * A unidade que a sessão está operando (bloco 58, SPEC §1.1 e §1.3).
 *
 * ## Por que aqui, e não em `finance`
 *
 * `locations` é de `scheduling` desde o bloco 1 — é ela que carrega o fuso, e é
 * o fuso que decide o dia da unidade, que é a pergunta que vinte rotas fazem.
 * `primaryLocation` mora neste pacote, e o que este arquivo faz é trocar *"a
 * primeira"* por *"a escolhida"* sem mudar a forma da resposta.
 *
 * ## O que muda para quem tem uma loja só
 *
 * Nada. Sem escolha gravada e sem vínculo em `staff_locations`, a resolução cai
 * na primeira aberta — que é exatamente o que `primaryLocation` devolvia.
 */

export interface UnidadeAtual {
  readonly id: string;
  readonly nome: string;
  readonly timezone: string;
  readonly today: string;
}

/** As unidades da barbearia, para a seleção e para o consolidado. */
export async function unidadesDaCasa(
  tenantId: string,
  tx?: TransactionClient,
): Promise<readonly UnidadeNaSelecao[]> {
  const dentro = async (t: TransactionClient) => {
    const linhas = await t.$queryRaw<{ id: string; name: string; active: boolean }[]>`
      SELECT id, name, active FROM locations ORDER BY created_at
    `;
    return linhas.map((l) => ({ id: l.id, nome: l.name, ativa: l.active }));
  };
  return tx ? dentro(tx) : withTenant(tenantId, dentro);
}

/**
 * As unidades que esta conta administra. **Vazio significa todas.**
 *
 * O padrão permissivo é deliberado e está escrito na migração: negar por
 * omissão trancaria a equipe inteira para fora no dia em que este bloco
 * entrasse, porque nenhuma barbearia existente tem vínculo gravado. O que a
 * pessoa *pode fazer* continua saindo de `role_permissions` — isto decide
 * apenas *onde*.
 */
export async function unidadesDoOperador(
  tenantId: string,
  staffUserId: string,
  tx?: TransactionClient,
): Promise<readonly string[]> {
  const dentro = async (t: TransactionClient) => {
    const linhas = await t.$queryRaw<{ location_id: string }[]>`
      SELECT location_id FROM staff_locations WHERE staff_user_id = ${staffUserId}::uuid
    `;
    return linhas.map((l) => l.location_id);
  };
  return tx ? dentro(tx) : withTenant(tenantId, dentro);
}

export type UnidadeResolvida =
  | { readonly unidade: UnidadeAtual; readonly disponiveis: readonly UnidadeNaSelecao[] }
  | { readonly falha: FalhaDaSelecao; readonly disponiveis: readonly UnidadeNaSelecao[] };

/**
 * Resolve a unidade da sessão, com a lista para o seletor.
 *
 * Devolve as duas coisas de uma vez porque a tela precisa das duas: o dado da
 * unidade atual e o que oferecer no seletor. Duas chamadas seriam duas idas ao
 * banco para ler a mesma tabela em toda requisição do painel.
 *
 * Quem decide *qual* é `resolverUnidade`, em `packages/core`: a regra de que a
 * loja fechada não é escolhível e de que a lista vazia significa todas é lógica
 * pura, e é onde o teste alcança.
 */
export async function unidadeDaSessao(params: {
  readonly tenantId: string;
  readonly escolhida: string | null;
  /** Vazio significa "todas". */
  readonly autorizadas: readonly string[];
  readonly now?: Date;
}): Promise<UnidadeResolvida> {
  return withTenant(params.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      { id: string; name: string; active: boolean; timezone: string }[]
    >`
      SELECT id, name, active, timezone FROM locations ORDER BY created_at
    `;
    const disponiveis: UnidadeNaSelecao[] = linhas.map((l) => ({
      id: l.id,
      nome: l.name,
      ativa: l.active,
    }));

    const resolvida = resolverUnidade({
      escolhida: params.escolhida,
      disponiveis,
      autorizadas: params.autorizadas,
    });
    if ('falha' in resolvida) return { falha: resolvida.falha, disponiveis };

    const crua = linhas.find((l) => l.id === resolvida.unidade.id);
    /**
     * O `??` nunca acontece: `resolverUnidade` só devolve o que recebeu. Ele
     * está aqui porque o tipo estrito não sabe disso, e um `!` para calar o
     * compilador é o que este projeto não aceita.
     */
    const timezone = crua?.timezone ?? 'America/Sao_Paulo';
    return {
      unidade: {
        id: resolvida.unidade.id,
        nome: resolvida.unidade.nome,
        timezone,
        today: instantToLocal(timezone, params.now ?? new Date()).date,
      },
      disponiveis,
    };
  });
}
