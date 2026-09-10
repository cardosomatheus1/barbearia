namespace Barbearia.FiscalMunicipal;

public sealed record EnderecoFiscal(string Logradouro, string Numero, string Bairro,
    string Cep, int Municipio, string NomeMunicipio, string Uf, string? Complemento = null);
public sealed record ParteFiscal(string Documento, string Nome, EnderecoFiscal? Endereco = null);
public sealed record PedidoFiscal(
    string Operacao, string Ambiente, int Municipio, string Cnpj, string InscricaoMunicipal,
    string RazaoSocial, EnderecoFiscal EnderecoPrestador, string Regime, string Serie,
    int NumeroRps, DateTimeOffset EmitidaEm, DateOnly Competencia, string Descricao,
    long ServicoCents, long DescontoCents, int AliquotaIssBps, string ItemListaServico,
    string CodigoMunicipal, string? Cnae, string? Nbs, ParteFiscal? Tomador,
    string CertificadoPem, string ChavePem, string? Usuario = null, string? Senha = null,
    string? Token = null, string? NumeroNota = null, string? CodigoVerificacao = null,
    string? CodigoCancelamento = null, string? MotivoCancelamento = null, int LayoutSaoPaulo = 1,
    RequisicaoArquivada? Requisicao = null);
public sealed record NotaMunicipal(string Numero, string Verificacao, string Xml,
    string Rps, string Serie, string Cnpj, string InscricaoMunicipal, long ServicoCents,
    string? Situacao, string? DataEmissao, string? Competencia, string DocumentoTomador, long DescontoCents);
public sealed record ResultadoFiscal(bool Sucesso, string? Erro, string[] Codigos,
    string XmlEnvio, string XmlRetorno, string? Protocolo, int? Lote, NotaMunicipal[] Notas,
    RequisicaoArquivada? Requisicao = null);
public sealed record MunicipioFiscal(int Codigo, string Nome, string Uf, string Padrao,
    bool Homologacao, bool Producao, string Versao);
