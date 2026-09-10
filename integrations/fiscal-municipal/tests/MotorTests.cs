using System.Net;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Xml.Linq;
using Barbearia.FiscalMunicipal;
using OpenAC.Net.NFSe;
using Xunit;

public sealed class MotorTests
{
    private static PedidoFiscal Pedido()
    {
        using var rsa = RSA.Create(2048);
        var request = new CertificateRequest("CN=Teste local sem validade fiscal", rsa,
            HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        using var cert = request.CreateSelfSigned(new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero),
            new DateTimeOffset(2027, 1, 1, 0, 0, 0, TimeSpan.Zero));
        return new PedidoFiscal("preparar", "producao", 3550308, "12345678000190", "12345678",
            "Barbearia de teste", new EnderecoFiscal("Rua Teste", "1", "Centro", "01001000", 3550308, "São Paulo", "SP"),
            "simples", "A", 1, new DateTimeOffset(2026, 9, 10, 10, 0, 0, TimeSpan.FromHours(-3)), new DateOnly(2026, 9, 10),
            "Serviço de teste & conferência", 10000, 0, 200, "6.01", "2658", "9602501", null,
            new ParteFiscal("13167474254", "Cliente de teste"), cert.ExportCertificatePem(), rsa.ExportPkcs8PrivateKeyPem());
    }

    [Fact]
    public void CatalogoSeparaCodigoExistenteDeTransporteUtilizavel()
    {
        var catalogo = Catalogo.Listar();
        Assert.Equal(198, catalogo.Length);
        Assert.True(Assert.Single(catalogo, m => m.Codigo == 3550308).Producao);
        Assert.False(Assert.Single(catalogo, m => m.Codigo == 3550308).Homologacao);
        Assert.Throws<InvalidOperationException>(() => Catalogo.Exigir(9999999, "producao"));
    }

    [Fact]
    public void ConfiguracoesCertificadosEDestinosNaoSaoCompartilhados()
    {
        var pedido = Pedido();
        var a = Motor.Configurar(pedido);
        var b = Motor.Configurar(pedido with { Cnpj = "99887766000199", InscricaoMunicipal = "87654321" });
        Assert.NotSame(a, b);
        Assert.Equal("12345678000190", a.PrestadorPadrao.CpfCnpj);
        Assert.Equal("99887766000199", b.PrestadorPadrao.CpfCnpj);
        Assert.False(a.Geral.Salvar);
        Assert.False(a.Arquivos.Salvar);
        Assert.False(a.WebServices.Salvar);
        using var primeiro = a.CertificadoEfemero!();
        using var segundo = a.CertificadoEfemero!();
        Assert.NotSame(primeiro, segundo);
        Assert.True(primeiro.HasPrivateKey);
        primeiro.Dispose();
        using var chave = segundo.GetRSAPrivateKey();
        Assert.NotNull(chave);
        Assert.NotEmpty(chave.SignData([1, 2, 3], HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1));
    }

    [Fact]
    public void XmlMunicipalUsaSerializerReaproveitadoSemTransmitir()
    {
        var resposta = Motor.Executar(Pedido(), (_, _) => throw new Exception("preparação não pode transmitir"));
        Assert.True(resposta.Sucesso);
        var xml = XDocument.Parse(resposta.XmlEnvio);
        Assert.Contains("<ValorServicos>100.00</ValorServicos>", resposta.XmlEnvio);
        Assert.Contains("&amp;", resposta.XmlEnvio);
        Assert.Contains(xml.Descendants(), e => e.Name.LocalName == "Assinatura" && e.Value.Length > 100);
        Assert.Empty(resposta.Notas);
        Assert.NotNull(resposta.Requisicao);
        Assert.Contains("EnvioLoteRPSRequest", System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(resposta.Requisicao.CorpoBase64)));
        Assert.Contains("<CodigoServico>2658</CodigoServico>", resposta.XmlEnvio);
    }

    [Fact]
    public void DinheiroPreservaCentavosEDesconto()
    {
        var pedido = Pedido() with { Municipio = 3106200, Serie = "1", ServicoCents = 12345, DescontoCents = 234, AliquotaIssBps = 299 };
        using var motor = new OpenNFSe(Motor.Configurar(pedido));
        var nota = Motor.PreencherNota(motor, pedido);
        Assert.Equal(121.11m, nota.Servico.Valores.BaseCalculo);
        Assert.Equal(3.62m, nota.Servico.Valores.ValorIss);
        Assert.Equal(123.45m, nota.Servico.Valores.ValorServicos);
    }

    [Fact]
    public void AceiteDoLoteNaoSeTransformaEmNotaAutorizada()
    {
        var chamadas = 0;
        var resposta = Motor.Executar(ParaEmitir(Pedido()), (r, c) =>
        {
            chamadas++;
            Assert.NotNull(c);
            Assert.Equal("nfews.prefeitura.sp.gov.br", r.RequestUri!.Host);
            var corpo = r.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            Assert.Contains("EnvioLoteRPSRequest", corpo);
            Assert.Contains("Signature", corpo);
            var xml = "<RetornoEnvioLoteRPS><Cabecalho><Sucesso>true</Sucesso><InformacoesLote><NumeroLote>55</NumeroLote><DataEnvioLote>2026-09-10T13:00:00</DataEnvioLote></InformacoesLote></Cabecalho></RetornoEnvioLoteRPS>";
            return Envelope("EnvioLoteRPSResponse", xml);
        });
        Assert.Equal(1, chamadas);
        Assert.True(resposta.Sucesso);
        Assert.Equal(55, resposta.Lote);
        Assert.Empty(resposta.Notas);
    }

    [Fact]
    public void RejeicaoPreservaCodigoSemExporMensagemDoEmissor()
    {
        var resposta = Motor.Executar(ParaEmitir(Pedido()), (_, _) => Envelope("EnvioLoteRPSResponse",
            "<RetornoEnvioLoteRPS><Cabecalho><Sucesso>false</Sucesso></Cabecalho><Erro><Codigo>100</Codigo><Descricao>Dado privado não pode ir ao log</Descricao></Erro></RetornoEnvioLoteRPS>"));
        Assert.False(resposta.Sucesso);
        Assert.Contains("100", resposta.Codigos);
        Assert.Empty(resposta.Notas);
    }

    [Fact]
    public void HandlerNuncaDesligaTlsNemSegueRedirecionamento()
    {
        using var handler = Transporte.CriarHandler(null);
        Assert.False(handler.AllowAutoRedirect);
        Assert.False(handler.UseProxy);
        Assert.Null(handler.SslOptions.RemoteCertificateValidationCallback);
        Assert.Equal(X509RevocationMode.Online, handler.SslOptions.CertificateRevocationCheckMode);
        Assert.Equal(SslProtocols.Tls12 | SslProtocols.Tls13, handler.SslOptions.EnabledSslProtocols);
        Assert.NotNull(handler.ConnectCallback);
    }

    [Theory]
    [InlineData("http://prefeitura.example/nfse")]
    [InlineData("https://127.0.0.1/nfse")]
    [InlineData("https://usuario:senha@prefeitura.example/nfse")]
    [InlineData("https://prefeitura.example:8000/nfse")]
    public void CatalogoRecusaDestinosInseguros(string url) => Assert.Throws<InvalidOperationException>(() => Catalogo.EnderecoSeguro(url));

    [Theory]
    [InlineData("127.0.0.1")]
    [InlineData("10.2.3.4")]
    [InlineData("169.254.169.254")]
    [InlineData("::ffff:127.0.0.1")]
    [InlineData("fc00::1")]
    public void ResolucaoNaoPodeLevarParaInfraestruturaInterna(string ip) => Assert.True(Transporte.Privado(IPAddress.Parse(ip)));

    [Theory]
    [InlineData(3106200)]
    [InlineData(3304557)]
    [InlineData(4106902)]
    [InlineData(4314902)]
    public void AdaptadoresPrincipaisPreparamEnvelopeSemRede(int municipio)
    {
        var pedido = Pedido() with { Municipio = municipio, Serie = "1", ItemListaServico = "06.01", CodigoMunicipal = "0601" };
        var r = Motor.Executar(pedido, (_, _) => throw new Exception("preparação não deve transmitir"));
        if (!r.Sucesso)
        {
            using var depurar = new OpenNFSe(Motor.Configurar(pedido, (_, _) => throw new Exception("transporte sintético")));
            Motor.PreencherNota(depurar, pedido);
            var falha = depurar.Enviar(pedido.NumeroRps);
            Assert.Fail($"Município {municipio}: " + string.Join("; ", falha.Erros.Select(e => e.Descricao)));
        }
        Assert.NotNull(r.Requisicao);
        Assert.StartsWith("https://", r.Requisicao.Url);
        Assert.NotEmpty(r.Requisicao.CorpoBase64);
    }

    [Theory]
    [InlineData("N", "autorizada")]
    [InlineData("F", "cancelada")]
    public void ConsultaPreservaIdentidadeValoresEEstadoDaNota(string estado, string esperado)
    {
        var pedido = Pedido() with { Operacao = "consultar" };
        var xml = $"<RetornoConsulta><Cabecalho><Sucesso>true</Sucesso></Cabecalho><NFe><ChaveNFe><NumeroNFe>101</NumeroNFe><CodigoVerificacao>ABC123</CodigoVerificacao><InscricaoPrestador>12345678</InscricaoPrestador></ChaveNFe><ChaveRPS><NumeroRPS>1</NumeroRPS><SerieRPS>A</SerieRPS><InscricaoPrestador>12345678</InscricaoPrestador></ChaveRPS><DataEmissaoRPS>2026-09-10</DataEmissaoRPS><DataEmissaoNFe>2026-09-10T10:00:00</DataEmissaoNFe><ValorServicos>100.00</ValorServicos><StatusNFe>{estado}</StatusNFe><CPFCNPJPrestador><CNPJ>12345678000190</CNPJ></CPFCNPJPrestador><CPFCNPJTomador><CPF>13167474254</CPF></CPFCNPJTomador></NFe></RetornoConsulta>";
        var r = Motor.Executar(pedido, (requisicao, _) =>
        {
            Assert.Contains("ConsultaNFeRequest", requisicao.Content!.ReadAsStringAsync().GetAwaiter().GetResult());
            return Envelope("ConsultaNFeResponse", xml);
        });
        Assert.True(r.Sucesso);
        var nota = Assert.Single(r.Notas);
        Assert.Equal("101", nota.Numero);
        Assert.Equal("2026-09-10", nota.DataEmissao);
        Assert.Equal("13167474254", nota.DocumentoTomador);
        Assert.Equal(10000, nota.ServicoCents);
        Assert.Equal(esperado, nota.Situacao);
    }

    [Fact]
    public void AusenciaOficialSaoPauloMantemCodigo1106SemVirarErroTecnico()
    {
        var r = Motor.Executar(Pedido() with { Operacao = "consultar" }, (_, _) => Envelope("ConsultaNFeResponse",
            "<RetornoConsulta><Cabecalho><Sucesso>false</Sucesso></Cabecalho><Erro><Codigo>1106</Codigo><Descricao>NF-e não encontrada.</Descricao></Erro></RetornoConsulta>"));
        Assert.False(r.Sucesso);
        Assert.Null(r.Erro);
        Assert.Equal(new[] { "1106" }, r.Codigos);
        Assert.Empty(r.Notas);
    }

    [Fact]
    public void CancelamentoPreparaSemRedeEEnviaEnvelopeArquivado()
    {
        var pedido = Pedido() with { Operacao = "preparar_cancelamento", NumeroNota = "101", CodigoVerificacao = "ABC123",
            CodigoCancelamento = "1", MotivoCancelamento = "Serviço não realizado pelo profissional" };
        var preparada = Motor.Executar(pedido);
        Assert.True(preparada.Sucesso);
        Assert.NotNull(preparada.Requisicao);
        var r = Motor.Executar(pedido with { Operacao = "cancelar", Requisicao = preparada.Requisicao }, (req, _) =>
        {
            Assert.Equal(Convert.FromBase64String(preparada.Requisicao.CorpoBase64), req.Content!.ReadAsByteArrayAsync().GetAwaiter().GetResult());
            return Envelope("CancelamentoNFeResponse", "<RetornoCancelamentoNFe><Cabecalho><Sucesso>true</Sucesso></Cabecalho></RetornoCancelamentoNFe>");
        });
        Assert.True(r.Sucesso);
        Assert.Null(r.Erro);
        Assert.NotEmpty(r.XmlRetorno);
    }

    [Theory]
    [InlineData(4204202)]
    [InlineData(2201903)]
    [InlineData(4101804)]
    [InlineData(4125506)]
    public void EndpointSozinhoNaoProvaOperacaoImplementada(int codigo)
    {
        var municipio = Catalogo.Listar().SingleOrDefault(m => m.Codigo == codigo);
        if (municipio is not null) Assert.False(municipio.Producao);
    }

    private static PedidoFiscal ParaEmitir(PedidoFiscal pedido)
    {
        var preparada = Motor.Executar(pedido with { Operacao = "preparar" });
        Assert.True(preparada.Sucesso);
        return pedido with { Operacao = "emitir", Requisicao = preparada.Requisicao };
    }

    [Theory]
    [InlineData(500, 1)]
    [InlineData(0, 2)]
    public void PerfilSaoPauloNaoPodeOmitirDescontoOuIBSCBS(long desconto, int layout)
    {
        var chamadas = 0;
        Assert.Throws<ArgumentException>(() => Motor.Executar(Pedido() with { DescontoCents = desconto, LayoutSaoPaulo = layout },
            (_, _) => { chamadas++; throw new Exception(); }));
        Assert.Equal(0, chamadas);
    }

    [Fact]
    public void TimeoutNuncaERecusaFiscal()
    {
        var r = Motor.Executar(ParaEmitir(Pedido()), (_, _) => throw new TimeoutException("informação privada"));
        Assert.False(r.Sucesso);
        Assert.Equal("nfse_municipal_confirmacao_pendente", r.Erro);
        Assert.Empty(r.Codigos);
    }

    [Fact]
    public void EnviaOsBytesArquivadosMesmoAposNovaSerializacao()
    {
        var pedido = ParaEmitir(Pedido());
        var bytes = Convert.FromBase64String(pedido.Requisicao!.CorpoBase64);
        var chamadas = 0;
        Motor.Executar(pedido with { Descricao = "Esta regeneração não substitui o documento arquivado" }, (r, _) =>
        {
            chamadas++;
            Assert.Equal(bytes, r.Content!.ReadAsByteArrayAsync().GetAwaiter().GetResult());
            return Envelope("EnvioLoteRPSResponse", "<RetornoEnvioLoteRPS><Cabecalho><Sucesso>true</Sucesso></Cabecalho></RetornoEnvioLoteRPS>");
        });
        Assert.Equal(1, chamadas);
    }

    [Fact]
    public void EmissaoSemArquivoNaoChegaAoTransporte() => Assert.Throws<ArgumentException>(() =>
        Motor.Executar(Pedido() with { Operacao = "emitir" }, (_, _) => throw new Exception("não deve chamar")));

    [Fact]
    public void ErroHttpEParseNaoSaoRecusasFiscais()
    {
        var pedido = ParaEmitir(Pedido());
        foreach (var status in new[] { HttpStatusCode.OK, HttpStatusCode.BadGateway })
        {
            var r = Motor.Executar(pedido, (_, _) => new HttpResponseMessage(status) { Content = new StringContent("não é XML") });
            Assert.False(r.Sucesso);
            Assert.Equal("nfse_municipal_confirmacao_pendente", r.Erro);
            Assert.Empty(r.Codigos);
        }
    }

    private static HttpResponseMessage Envelope(string tag, string xml) => new(HttpStatusCode.OK)
    {
        Content = new StringContent($"<soap:Envelope xmlns:soap='http://www.w3.org/2003/05/soap-envelope'><soap:Body><{tag} xmlns='http://www.prefeitura.sp.gov.br/nfe'><RetornoXML><![CDATA[{xml}]]></RetornoXML></{tag}></soap:Body></soap:Envelope>"),
    };
}
