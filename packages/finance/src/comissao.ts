/**
 * Fachada pública da comissão.
 *
 * A implementação é separada por responsabilidade para manter cálculo,
 * fechamento, configuração e clube evoluindo sem recriar um monólito.
 */
export { aplicarFaixas } from '@barbearia/core';

export {
  ComissaoError,
  MODELO_PADRAO_DA_ASSINATURA,
  type ComissaoFailure,
  type ConfiguracaoDeComissao,
  type ModeloDaAssinatura,
} from './comissao-contratos.js';

export {
  lancarComissaoDaComanda,
  estornarComissaoDaComanda,
  paraLancamento,
  lancamentosAbertos,
} from './comissao-lancamentos.js';

export {
  extratoDeComissao,
  descontarValesNoFechamento,
  fecharPeriodoDeComissao,
  fechamentosDeComissao,
  type LinhaDeComissao,
  type ExtratoDeComissao,
  type FechamentoDeComissao,
} from './comissao-periodos.js';

export {
  regrasDeComissao,
  salvarRegraDeComissao,
  removerRegraDeComissao,
  salvarConfiguracaoDeComissao,
  aliquotasDoAdquirente,
  salvarAliquotaDoAdquirente,
  type RegraNaTela,
} from './comissao-configuracao.js';

export {
  lerModeloDaAssinatura,
  simulacaoDaAssinatura,
  rentabilidadeDoClube,
  salvarModeloDaAssinatura,
  type RentabilidadeNaTela,
  type RentabilidadeDoClube,
} from './comissao-assinatura.js';
