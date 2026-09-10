namespace Barbearia.FiscalMunicipal;

// Capturada depois da serialização/assinatura do adaptador e antes da rede.
// O chamador cifra e persiste este envelope antes de autorizar sua transmissão.
public sealed record RequisicaoArquivada(string Url, string Metodo, string CorpoBase64,
    Dictionary<string, string[]> Cabecalhos, Dictionary<string, string[]> CabecalhosConteudo)
{
    public static RequisicaoArquivada Capturar(HttpRequestMessage r)
    {
        r.Content?.LoadIntoBufferAsync(Transporte.LimiteBytes).GetAwaiter().GetResult();
        return new(r.RequestUri!.AbsoluteUri, r.Method.Method,
            Convert.ToBase64String(r.Content?.ReadAsByteArrayAsync().GetAwaiter().GetResult() ?? []),
            r.Headers.ToDictionary(h => h.Key, h => h.Value.ToArray()),
            r.Content?.Headers.ToDictionary(h => h.Key, h => h.Value.ToArray()) ?? []);
    }

    public HttpRequestMessage Restaurar(HttpRequestMessage gerada)
    {
        if (Url != gerada.RequestUri?.AbsoluteUri || Metodo != gerada.Method.Method)
            throw new InvalidOperationException("nfse_municipal_pedido_divergente");
        Catalogo.EnderecoSeguro(Url);
        var bytes = Convert.FromBase64String(CorpoBase64);
        if (bytes.Length > Transporte.LimiteBytes) throw new InvalidOperationException("nfse_municipal_limite");
        var r = new HttpRequestMessage(new HttpMethod(Metodo), Url) { Content = new ByteArrayContent(bytes) };
        foreach (var h in Cabecalhos) r.Headers.Add(h.Key, h.Value);
        foreach (var h in CabecalhosConteudo)
            if (!h.Key.Equals("Content-Length", StringComparison.OrdinalIgnoreCase)) r.Content.Headers.Add(h.Key, h.Value);
        return r;
    }
}
