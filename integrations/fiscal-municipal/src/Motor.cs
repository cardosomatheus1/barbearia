using System.Globalization;
using System.Security.Cryptography.X509Certificates;
using System.Text.RegularExpressions;
using OpenAC.Net.DFe.Core;
using OpenAC.Net.DFe.Core.Common;
using OpenAC.Net.NFSe;
using OpenAC.Net.NFSe.Commom.Model;
using OpenAC.Net.NFSe.Configuracao;
using OpenAC.Net.NFSe.Nota;

namespace Barbearia.FiscalMunicipal;

public static class Motor
{
    public static ConfigNFSe Configurar(PedidoFiscal p,
        Func<HttpRequestMessage, X509Certificate2?, HttpResponseMessage>? transporte = null)
    {
        Validar(p);
        var municipio = Catalogo.Exigir(p.Municipio, p.Ambiente);
        var hosts = Catalogo.Hosts(municipio, p.Ambiente);
        var config = new ConfigNFSe();
        config.Geral.Salvar = false;
        config.Arquivos.Salvar = false;
        config.Arquivos.PathSchemas = Path.Combine(AppContext.BaseDirectory, "Schemas");
        config.WebServices.Salvar = false;
        config.WebServices.Tentativas = 1;
        config.WebServices.IntervaloTentativas = 0;
        config.WebServices.Protocolos = System.Net.SecurityProtocolType.Tls12 | System.Net.SecurityProtocolType.Tls13;
        config.WebServices.CodigoMunicipio = p.Municipio;
        config.WebServices.Ambiente = p.Ambiente == "producao" ? DFeTipoAmbiente.Producao : DFeTipoAmbiente.Homologacao;
        config.WebServices.LayoutISSSaoPaulo = p.LayoutSaoPaulo == 2 ? LayoutISSSaoPaulo.Layout2 : LayoutISSSaoPaulo.Layout1;
        config.WebServices.Usuario = p.Usuario ?? "";
        config.WebServices.Senha = p.Senha ?? "";
        config.WebServices.ChaveAcesso = p.Token ?? "";
        // ProviderBase dispõe cada certificado ao terminar uma operação. A fábrica
        // cria uma nova chave efêmera por provider, sem PFX ou store do sistema.
        config.CertificadoEfemero = () => X509Certificate2.CreateFromPem(p.CertificadoPem, p.ChavePem);
        config.TransportarHttp = transporte ?? ((r, c) => Transporte.Enviar(r, c, hosts, p.CertificadoPem));
        config.PrestadorPadrao.CpfCnpj = p.Cnpj;
        config.PrestadorPadrao.InscricaoMunicipal = p.InscricaoMunicipal;
        config.PrestadorPadrao.RazaoSocial = p.RazaoSocial;
        PreencherEndereco(config.PrestadorPadrao.Endereco, p.EnderecoPrestador);
        return config;
    }

    public static void Validar(PedidoFiscal p)
    {
        if (p.Operacao is not ("preparar" or "preparar_cancelamento" or "emitir" or "consultar" or "cancelar") ||
            p.Regime is not ("simples" or "normal") || p.NumeroRps <= 0 ||
            !Regex.IsMatch(p.Cnpj, "^[0-9A-Z]{12}[0-9]{2}$") ||
            !Regex.IsMatch(p.Serie, "^[a-zA-Z0-9]{1,5}$") ||
            !Regex.IsMatch(p.InscricaoMunicipal, "^[a-zA-Z0-9]{1,20}$") ||
            !Regex.IsMatch(p.ItemListaServico, "^[0-9.]{1,10}$") ||
            !Regex.IsMatch(p.CodigoMunicipal, "^[a-zA-Z0-9.]{1,20}$") ||
            string.IsNullOrWhiteSpace(p.Descricao) || p.Descricao.Length > 2000 ||
            p.ServicoCents is <= 0 or > 100_000_000_000 || p.DescontoCents < 0 || p.DescontoCents >= p.ServicoCents ||
            p.AliquotaIssBps is < 0 or > 500 || p.LayoutSaoPaulo is not (1 or 2) ||
            p.CertificadoPem.Length > 200_000 || p.ChavePem.Length > 20_000)
            throw new ArgumentException("nfse_municipal_entrada_invalida");
        // O serializer SP1 não representa desconto incondicionado; SP2 exige
        // grupos IBS/CBS que este mapeamento ainda não oferece. Não omitir tributos.
        if (p.Municipio != 3550308 && !Regex.IsMatch(p.Serie, "^[1-9][0-9]{0,4}$"))
            throw new ArgumentException("nfse_municipal_serie_invalida");
        if (p.Municipio == 3550308 && (p.LayoutSaoPaulo != 1 || p.DescontoCents != 0))
            throw new ArgumentException("nfse_municipal_perfil_sem_suporte");
        if (p.Operacao is "cancelar" or "preparar_cancelamento" && (string.IsNullOrWhiteSpace(p.NumeroNota) ||
            string.IsNullOrWhiteSpace(p.CodigoCancelamento) || p.MotivoCancelamento?.Trim().Length is not (>= 15 and <= 255)))
            throw new ArgumentException("nfse_municipal_cancelamento_invalido");
    }

    public static NotaServico PreencherNota(OpenNFSe componente, PedidoFiscal p)
    {
        var nota = componente.NotasServico.AddNew();
        nota.IdentificacaoRps.Numero = p.NumeroRps.ToString(CultureInfo.InvariantCulture);
        nota.IdentificacaoRps.Serie = p.Serie;
        nota.IdentificacaoRps.Tipo = TipoRps.RPS;
        nota.IdentificacaoRps.DataEmissao = p.EmitidaEm.DateTime;
        nota.Competencia = p.Competencia.ToDateTime(TimeOnly.MinValue);
        nota.NaturezaOperacao = 1;
        nota.TipoTributacao = TipoTributacao.Tributavel;
        nota.Situacao = SituacaoNFSeRps.Normal;
        nota.OptanteSimplesNacional = p.Regime == "simples" ? NFSeSimNao.Sim : NFSeSimNao.Nao;
        nota.RegimeEspecialTributacao = RegimeEspecialTributacao.Nenhum;
        nota.IncentivadorCultural = NFSeSimNao.Nao;
        nota.Servico.Discriminacao = p.Descricao;
        // O adaptador SP escreve CodigoServico a partir desta propriedade.
        nota.Servico.ItemListaServico = p.Municipio == 3550308 ? p.CodigoMunicipal : p.ItemListaServico;
        nota.Servico.CodigoTributacaoMunicipio = p.CodigoMunicipal;
        nota.Servico.CodigoCnae = p.Cnae ?? "";
        nota.Servico.CodigoNbs = p.Nbs ?? "";
        nota.Servico.CodigoMunicipio = p.Municipio;
        nota.Servico.MunicipioIncidencia = p.Municipio;
        nota.Servico.Valores.ValorServicos = p.ServicoCents / 100m;
        nota.Servico.Valores.DescontoIncondicionado = p.DescontoCents / 100m;
        nota.Servico.Valores.BaseCalculo = (p.ServicoCents - p.DescontoCents) / 100m;
        nota.Servico.Valores.Aliquota = p.AliquotaIssBps / 100m;
        nota.Servico.Valores.ValorIss = decimal.Round(
            nota.Servico.Valores.BaseCalculo * p.AliquotaIssBps / 10000m, 2, MidpointRounding.AwayFromZero);
        nota.Servico.Valores.IssRetido = SituacaoTributaria.Normal;
        nota.Servico.Valores.ValorLiquidoNfse = nota.Servico.Valores.BaseCalculo;
        if (p.Tomador is not null)
        {
            nota.Tomador.CpfCnpj = p.Tomador.Documento;
            nota.Tomador.RazaoSocial = p.Tomador.Nome;
            if (p.Tomador.Endereco is not null) PreencherEndereco(nota.Tomador.Endereco, p.Tomador.Endereco);
        }
        if (p.NumeroNota is not null) nota.IdentificacaoNFSe.Numero = p.NumeroNota;
        if (p.CodigoVerificacao is not null) nota.IdentificacaoNFSe.Chave = p.CodigoVerificacao;
        return nota;
    }

    public static ResultadoFiscal Executar(PedidoFiscal p,
        Func<HttpRequestMessage, X509Certificate2?, HttpResponseMessage>? transporte = null)
    {
        var preparando = p.Operacao is "preparar" or "preparar_cancelamento";
        var mutacao = p.Operacao is "emitir" or "cancelar";
        if (mutacao && p.Requisicao is null) throw new ArgumentException("nfse_municipal_pedido_nao_arquivado");
        RequisicaoArquivada? capturada = null;
        var chamadas = 0;
        var falhaTecnica = false;
        var config = Configurar(p);
        var enviar = transporte ?? config.TransportarHttp!;
        config.TransportarHttp = (r, c) =>
        {
            if (++chamadas > 1) { falhaTecnica = true; throw new InvalidOperationException("nfse_municipal_chamada_repetida"); }
            if (preparando)
            {
                capturada = RequisicaoArquivada.Capturar(r);
                throw new InvalidOperationException("nfse_municipal_preparacao_sem_rede");
            }
            try
            {
                using var restaurada = mutacao ? p.Requisicao!.Restaurar(r) : null;
                var resposta = enviar(restaurada ?? r, c);
                if (!resposta.IsSuccessStatusCode) falhaTecnica = true;
                return resposta;
            }
            catch { falhaTecnica = true; throw; }
        };
        using var componente = new OpenNFSe(config);
        RetornoWebservice retorno;
        if (p.Operacao == "consultar")
            retorno = componente.ConsultaNFSeRps(p.NumeroRps, p.Serie, TipoRps.RPS,
                p.Competencia.Month, p.Competencia.Year);
        else
        {
            PreencherNota(componente, p);
            retorno = p.Operacao is "emitir" or "preparar"
                ? componente.Enviar(p.NumeroRps, Catalogo.Sincrono(Catalogo.Exigir(p.Municipio, p.Ambiente)))
                : componente.CancelarNFSe(p.CodigoCancelamento!, p.NumeroNota!, p.Serie,
                    (p.ServicoCents - p.DescontoCents) / 100m, p.MotivoCancelamento!, p.CodigoVerificacao ?? "");
        }
        if (preparando)
        {
            if (capturada is null) return new ResultadoFiscal(false, "nfse_municipal_preparacao_falhou", [], "", "", null, null, []);
            return new ResultadoFiscal(true, null, [], retorno.XmlEnvio, "", null, null, [], capturada);
        }
        // ProviderBase converte exceções (inclusive timeout e falha de parse)
        // em código 0. Isso nunca é uma recusa fiscal definitiva.
        falhaTecnica |= retorno.Erros.Any(e => e.Codigo == "0") || chamadas != 1;
        // Sucesso de recepção não é autorização. Só devolve nota quando o
        // documento original autorizado veio no retorno ou na consulta.
        var notas = componente.NotasServico.Where(n => p.Operacao == "consultar" && !string.IsNullOrWhiteSpace(n.XmlOriginal) &&
            !string.IsNullOrWhiteSpace(n.IdentificacaoNFSe.Numero)).Select(n => new NotaMunicipal(
                n.IdentificacaoNFSe.Numero, n.IdentificacaoNFSe.Chave ?? "", n.XmlOriginal,
                n.IdentificacaoRps.Numero ?? "", n.IdentificacaoRps.Serie ?? "",
                n.Prestador.CpfCnpj ?? "", n.Prestador.InscricaoMunicipal ?? "",
                decimal.ToInt64(decimal.Round(n.Servico.Valores.ValorServicos * 100m, 0)),
                n.Situacao == SituacaoNFSeRps.Cancelado ? "cancelada" : "autorizada",
                n.IdentificacaoRps.DataEmissao == default ? null : n.IdentificacaoRps.DataEmissao.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                n.Competencia == default ? null : n.Competencia.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                n.Tomador.CpfCnpj ?? "", decimal.ToInt64(decimal.Round(n.Servico.Valores.DescontoIncondicionado * 100m, 0)))).ToArray();
        var codigos = retorno.Erros.Select(e => e.Codigo).Where(c => Regex.IsMatch(c, "^[a-zA-Z0-9_.-]{1,40}$"))
            .Distinct().Take(10).ToArray();
        return new ResultadoFiscal(!falhaTecnica && retorno.Sucesso,
            falhaTecnica ? "nfse_municipal_confirmacao_pendente" : null, falhaTecnica ? [] : codigos,
            mutacao ? System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(p.Requisicao!.CorpoBase64)) : retorno.XmlEnvio, retorno.XmlRetorno,
            retorno is RetornoEnviar envio ? envio.Protocolo : null,
            retorno is RetornoEnviar lote ? lote.Lote : null, notas);
    }

    private static void PreencherEndereco(Endereco destino, EnderecoFiscal origem)
    {
        destino.Logradouro = origem.Logradouro;
        destino.Numero = origem.Numero;
        destino.Bairro = origem.Bairro;
        destino.Cep = origem.Cep;
        destino.CodigoMunicipio = origem.Municipio;
        destino.Municipio = origem.NomeMunicipio;
        destino.Uf = origem.Uf;
        destino.Complemento = origem.Complemento ?? "";
    }
}
