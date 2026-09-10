export interface EnderecoMunicipal {
  readonly logradouro: string; readonly numero: string; readonly bairro: string;
  readonly cep: string; readonly municipio: number; readonly nomeMunicipio: string;
  readonly uf: string; readonly complemento?: string | null;
}
export interface ConfiguracaoMunicipal {
  readonly ambiente: 'homologacao' | 'producao'; readonly serie: string;
  readonly numeroInicial: number; readonly serieExclusiva: true;
  readonly itemListaServico: string; readonly codigoMunicipal: string;
  readonly cnae: string | null; readonly nbs: string | null;
  readonly razaoSocial: string; readonly enderecoPrestador: EnderecoMunicipal;
  readonly layoutSaoPaulo: 1 | 2; readonly habilitada: boolean;
  readonly codigoCancelamento: string;
}
export interface PedidoMunicipal {
  readonly operacao: 'preparar' | 'preparar_cancelamento' | 'emitir' | 'consultar' | 'cancelar';
  readonly ambiente: 'homologacao' | 'producao'; readonly municipio: number;
  readonly cnpj: string; readonly inscricaoMunicipal: string; readonly razaoSocial: string;
  readonly enderecoPrestador: EnderecoMunicipal; readonly regime: 'simples' | 'normal';
  readonly serie: string; readonly numeroRps: number; readonly emitidaEm: string;
  readonly competencia: string; readonly descricao: string;
  readonly servicoCents: number; readonly descontoCents: number; readonly aliquotaIssBps: number;
  readonly itemListaServico: string; readonly codigoMunicipal: string; readonly cnae: string | null;
  readonly nbs: string | null; readonly layoutSaoPaulo: 1 | 2;
  readonly tomador: { readonly documento: string; readonly nome: string; readonly endereco?: EnderecoMunicipal } | null;
  readonly certificadoPem: string; readonly chavePem: string;
  readonly usuario?: string | null; readonly senha?: string | null; readonly token?: string | null;
  readonly numeroNota?: string | null; readonly codigoVerificacao?: string | null;
  readonly codigoCancelamento?: string | null; readonly motivoCancelamento?: string | null;
  readonly requisicao?: RequisicaoMunicipal | null;
}
export interface RequisicaoMunicipal {
  readonly url: string; readonly metodo: string; readonly corpoBase64: string;
  readonly cabecalhos: Readonly<Record<string, readonly string[]>>;
  readonly cabecalhosConteudo: Readonly<Record<string, readonly string[]>>;
}
export type SnapshotMunicipal = Omit<PedidoMunicipal, 'operacao' | 'certificadoPem' | 'chavePem' | 'usuario' | 'senha' | 'token' | 'requisicao'>;
export interface NotaMunicipal {
  readonly numero: string; readonly verificacao: string; readonly xml: string;
  readonly rps: string; readonly serie: string; readonly cnpj: string; readonly inscricaoMunicipal: string;
  readonly servicoCents: number; readonly situacao: string | null;
  readonly dataEmissao: string | null; readonly competencia: string | null;
  readonly documentoTomador: string; readonly descontoCents: number;
}
export interface ResultadoMunicipal {
  readonly sucesso: boolean; readonly erro: string | null; readonly codigos: readonly string[];
  readonly xmlEnvio: string; readonly xmlRetorno: string; readonly protocolo: string | null;
  readonly lote: number | null; readonly notas: readonly NotaMunicipal[];
  readonly requisicao?: RequisicaoMunicipal | null;
}
