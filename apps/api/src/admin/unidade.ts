import type { AuthenticatedStaff } from '@barbearia/identity';
import { unidadeDaSessao, type UnidadeAtual } from '@barbearia/scheduling';
import { EXPLICACAO_DA_SELECAO, type UnidadeNaSelecao } from '@barbearia/core';
import { DomainError } from '../common/errors.js';

/**
 * A unidade em que esta sessão está operando (bloco 58).
 *
 * ## O que este arquivo troca
 *
 * Vinte rotas chamavam `primaryLocation(tenantId)` — *"a primeira"* —, cada uma
 * com o seu `if (!local) throw`. Está certo enquanto só existe uma loja; com
 * duas, "a primeira" é sempre a matriz, e a recepcionista da filial fecharia o
 * caixa da matriz sem nada ficar vermelho.
 *
 * A escolha vem de `staff_sessions.location_id` e **não de um parâmetro da
 * requisição**: um cabeçalho faria cada tela do painel precisar lembrar de
 * repassá-lo, e a que esquecesse cairia de volta em "a primeira" — que é o
 * defeito que este bloco existe para fechar. É o mesmo desenho de
 * `mfa_verified_at`, que também é estado da sessão e não do pedido.
 *
 * ## Uma função, e não um decorador
 *
 * Cada controller já tinha o seu `private async unidade(tenantId)`. Eles passam
 * a delegar aqui, e a regra — qual loja, quando recusar, com que mensagem —
 * fica escrita **uma vez**. Vinte cópias da mesma decisão é o que faz a
 * vigésima primeira divergir.
 */
export const semUnidade = (falha: keyof typeof EXPLICACAO_DA_SELECAO): DomainError =>
  new DomainError('unknown_location', 404, EXPLICACAO_DA_SELECAO[falha]);

export async function unidadeDoBalcao(staff: AuthenticatedStaff): Promise<UnidadeAtual> {
  const resolvida = await unidadeDaSessao({
    tenantId: staff.tenantId,
    escolhida: staff.unidadeEscolhidaId,
    autorizadas: staff.unidadesAutorizadas,
  });
  if ('falha' in resolvida) throw semUnidade(resolvida.falha);
  return resolvida.unidade;
}

/** A unidade atual **e** o que oferecer no seletor, para a tela desenhar as duas. */
export async function selecaoDoBalcao(staff: AuthenticatedStaff): Promise<{
  readonly atual: UnidadeAtual | null;
  readonly disponiveis: readonly UnidadeNaSelecao[];
  readonly falha: string | null;
}> {
  const resolvida = await unidadeDaSessao({
    tenantId: staff.tenantId,
    escolhida: staff.unidadeEscolhidaId,
    autorizadas: staff.unidadesAutorizadas,
  });
  /**
   * A falha **não** vira exceção aqui.
   *
   * Esta é a rota do seletor: uma conta sem unidade legível precisa receber a
   * lista e a explicação, senão a tela que existe para consertar o problema é a
   * primeira a quebrar por causa dele.
   */
  const autorizadas = staff.unidadesAutorizadas;
  const minhas = resolvida.disponiveis.filter(
    (u) => autorizadas.length === 0 || autorizadas.includes(u.id),
  );
  if ('falha' in resolvida) {
    return {
      atual: null,
      disponiveis: minhas,
      falha: EXPLICACAO_DA_SELECAO[resolvida.falha],
    };
  }
  return { atual: resolvida.unidade, disponiveis: minhas, falha: null };
}
