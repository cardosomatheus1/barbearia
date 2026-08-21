import type { AuthenticatedStaff } from '@barbearia/identity';
import { unidadeDaSessao, type UnidadeAtual } from '@barbearia/scheduling';
import {
  EXPLICACAO_DA_SELECAO,
  TODAS_AS_UNIDADES,
  type EscolhaDeUnidade,
  type UnidadeNaSelecao,
} from '@barbearia/core';
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

/**
 * A unidade que o **relatório** vai ler: uma loja, ou a rede inteira.
 *
 * ## Por que o consolidado passa por aqui, e não pelo seletor do casco
 *
 * O casco carrega a unidade de **operação** — caixa, comanda e agenda são de
 * uma loja, e somá-las faria a recepção fechar o caixa da loja errada. É o que
 * o cabeçalho de `multiunidade.ts` diz desde o bloco 58: `TODAS` é valor
 * legítimo da seleção *de leitura*, e nunca da de operação. Um terceiro estado
 * no seletor do casco valeria para as vinte telas do painel de uma vez, e a
 * primeira a somar duas gavetas seria um defeito de dinheiro.
 *
 * ## Quem pode pedir a rede
 *
 * Só quem enxerga **todas** as lojas. `staff_locations` vazio significa todas —
 * é a decisão do bloco 58, e negar por omissão trancaria a equipe no dia da
 * migração —, então o gerente escopado a uma filial pede o consolidado e recebe
 * a filial dele. Não é erro: ele está vendo tudo o que pode ver, e recusar
 * mandaria alguém procurar uma tela que ele não tem como abrir.
 */
export async function unidadeDoRelatorio(
  staff: AuthenticatedStaff,
  pedida: string | undefined,
): Promise<EscolhaDeUnidade> {
  if (pedida !== TODAS_AS_UNIDADES) {
    // Sem pedido, ou com o id de uma loja: é a resolução de sempre, com a mesma
    // conferência de autorização — o id vem da consulta e é entrada externa.
    const atual = await unidadeDaSessao({
      tenantId: staff.tenantId,
      escolhida: pedida ?? staff.unidadeEscolhidaId,
      autorizadas: staff.unidadesAutorizadas,
    });
    if ('falha' in atual) throw semUnidade(atual.falha);
    return atual.unidade.id;
  }

  if (staff.unidadesAutorizadas.length === 0) return TODAS_AS_UNIDADES;

  const todas = await unidadeDaSessao({
    tenantId: staff.tenantId,
    escolhida: null,
    autorizadas: [],
  });
  const abertas = todas.disponiveis.filter((u) => u.ativa).map((u) => u.id);
  const veTodas = abertas.every((id) => staff.unidadesAutorizadas.includes(id));
  if (veTodas) return TODAS_AS_UNIDADES;

  // Escopado: o consolidado dele é a loja dele. Cai na resolução de sempre.
  return unidadeDoBalcao(staff).then((u) => u.id);
}
