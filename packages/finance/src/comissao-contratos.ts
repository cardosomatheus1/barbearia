import type {
  BaseDeComissao,
  ModoDaAssinatura,
  TratamentoDaTaxa,
  TratamentoDoDesconto,
} from '@barbearia/core';

export type ComissaoFailure =
  | 'regra_invalida'
  | 'regra_nao_encontrada'
  | 'periodo_invalido'
  | 'periodo_ja_fechado'
  | 'aliquota_invalida'
  | 'nada_a_fechar';

export class ComissaoError extends Error {
  constructor(
    readonly code: ComissaoFailure,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ComissaoError';
  }
}

export interface ConfiguracaoDeComissao {
  readonly base: BaseDeComissao;
  readonly tratamentoDoDesconto: TratamentoDoDesconto;
  readonly tratamentoDaTaxa: TratamentoDaTaxa;
}

export const CONFIGURACAO_PADRAO: ConfiguracaoDeComissao = {
  base: 'liquido',
  tratamentoDoDesconto: 'reduz_base',
  tratamentoDaTaxa: 'absorvida',
};

/**
 * O modelo de comissão sobre assinatura (bloco 48, SPEC §3.4).
 *
 * Mora em `tenants` e não em `commission_settings` de propósito: a tela que o
 * dono usa para decidir é a do **clube**, com a simulação dos três modelos ao
 * lado, e não a de regras de comissão. Quem lê é a mesma função que fecha o
 * período — não há segunda fonte.
 */
export interface ModeloDaAssinatura {
  readonly modo: ModoDaAssinatura;
  readonly tetoBps: number;
}

/** Padrão: o **comportamento anterior**, como todo padrão que mexe em dinheiro. */
export const MODELO_PADRAO_DA_ASSINATURA: ModeloDaAssinatura = {
  modo: 'por_uso',
  tetoBps: 6000,
};
