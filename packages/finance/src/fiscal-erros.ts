import type { MotivoDeNaoEmitir } from '@barbearia/core';

export type FiscalRepoFailure =
  | 'cnpj_invalido'
  | 'regime_invalido'
  | 'codigo_de_servico_obrigatorio'
  | 'aliquota_invalida'
  | 'municipio_obrigatorio'
  | 'nao_configurado'
  | 'nota_nao_encontrada'
  | 'nota_nao_cancelavel'
  | 'motivo_obrigatorio'
  | 'venda_nao_encontrada'
  | 'nao_emite'
  | 'documento_invalido'
  | 'cliente_nao_encontrado'
  | 'fiscal_indisponivel';

export class FiscalError extends Error {
  constructor(
    readonly code: FiscalRepoFailure,
    message: string,
    readonly motivo?: MotivoDeNaoEmitir,
  ) {
    super(message);
    this.name = 'FiscalError';
  }
}

const MENSAGEM: Readonly<Record<FiscalRepoFailure, string>> = {
  cnpj_invalido: 'Confira o CNPJ.',
  regime_invalido: 'Escolha um regime.',
  codigo_de_servico_obrigatorio: 'Informe o código de serviço municipal.',
  aliquota_invalida: 'O ISS vai de 0 a 5%.',
  municipio_obrigatorio: 'Informe o código IBGE do município.',
  nao_configurado: 'Cadastre CNPJ e regime antes de emitir nota.',
  nota_nao_encontrada: 'Esta nota não existe.',
  nota_nao_cancelavel: 'Só uma nota autorizada pode ser cancelada.',
  motivo_obrigatorio: 'Escreva o motivo do cancelamento.',
  venda_nao_encontrada: 'Esta venda não existe.',
  nao_emite: 'Esta venda não gera nota.',
  documento_invalido: 'Confira o CPF ou o CNPJ.',
  cliente_nao_encontrado: 'Este cliente não existe.',
  /**
   * A frase diz o que é: não é erro da barbearia nem falha momentânea.
   *
   * "Tente de novo" mandaria a recepção repetir para sempre uma operação que
   * não existe neste ambiente, com o cliente esperando no balcão.
   */
  fiscal_indisponivel:
    'A emissão de nota não está disponível: nenhum emissor está configurado nesta instalação.',
};

export function recusar(code: FiscalRepoFailure, motivo?: MotivoDeNaoEmitir): never {
  throw new FiscalError(code, MENSAGEM[code], motivo);
}
