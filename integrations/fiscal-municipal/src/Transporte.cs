using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;
using System.Text;

namespace Barbearia.FiscalMunicipal;

public static class Transporte
{
    public const int LimiteBytes = 5 * 1024 * 1024;

    public static SocketsHttpHandler CriarHandler(X509Certificate2? certificado, string? cadeiaPem = null)
    {
        var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false, UseProxy = false,
            ConnectTimeout = TimeSpan.FromSeconds(20),
            SslOptions = new SslClientAuthenticationOptions
            {
                EnabledSslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13,
                CertificateRevocationCheckMode = X509RevocationMode.Online,
            },
        };
        if (certificado is not null)
        {
            var cadeia = new X509Certificate2Collection();
            if (cadeiaPem is not null) cadeia.ImportFromPem(cadeiaPem);
            handler.SslOptions.ClientCertificateContext = SslStreamCertificateContext.Create(certificado, cadeia, offline: true);
        }
        // A conexão usa os IPs públicos já verificados, evitando uma segunda
        // resolução DNS que pudesse trocar o destino para a rede interna.
        handler.ConnectCallback = async (contexto, cancelamento) =>
        {
            var ips = await Dns.GetHostAddressesAsync(contexto.DnsEndPoint.Host, cancelamento);
            if (ips.Length == 0 || ips.Any(Privado)) throw new InvalidOperationException("nfse_municipal_destino_invalido");
            foreach (var ip in ips)
            {
                var socket = new Socket(ip.AddressFamily, SocketType.Stream, ProtocolType.Tcp);
                try
                {
                    await socket.ConnectAsync(new IPEndPoint(ip, contexto.DnsEndPoint.Port), cancelamento);
                    return new NetworkStream(socket, ownsSocket: true);
                }
                catch (SocketException) { socket.Dispose(); }
                catch { socket.Dispose(); throw; }
            }
            throw new HttpRequestException("nfse_municipal_conexao_falhou");
        };
        return handler;
    }

    public static HttpResponseMessage Enviar(HttpRequestMessage pedido, X509Certificate2? certificado,
        IReadOnlySet<string> hosts, string? cadeiaPem = null)
    {
        var uri = Catalogo.EnderecoSeguro(pedido.RequestUri?.AbsoluteUri ?? "");
        if (!hosts.Contains(uri.Host)) throw new InvalidOperationException("nfse_municipal_destino_invalido");
        using var prazo = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        if (pedido.Content is not null)
        {
            pedido.Content.LoadIntoBufferAsync(LimiteBytes).GetAwaiter().GetResult();
            if (pedido.Content.Headers.ContentLength > LimiteBytes) throw new InvalidOperationException("nfse_municipal_limite");
        }
        using var handler = CriarHandler(certificado, cadeiaPem);
        using var client = new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
        using var resposta = client.SendAsync(pedido, HttpCompletionOption.ResponseHeadersRead, prazo.Token).GetAwaiter().GetResult();
        var status = (int)resposta.StatusCode;
        if (status is >= 300 and < 400) throw new InvalidOperationException("nfse_municipal_redirecionamento");
        if (resposta.Content.Headers.ContentLength > LimiteBytes) throw new InvalidOperationException("nfse_municipal_limite");
        using var stream = resposta.Content.ReadAsStream(prazo.Token);
        using var memoria = new MemoryStream();
        var buffer = new byte[8192];
        int lidos;
        while ((lidos = stream.ReadAsync(buffer, prazo.Token).GetAwaiter().GetResult()) > 0)
        {
            if (memoria.Length + lidos > LimiteBytes) throw new InvalidOperationException("nfse_municipal_limite");
            memoria.Write(buffer, 0, lidos);
        }
        var conteudo = Encoding.UTF8.GetString(memoria.ToArray());
        if (conteudo.Contains("<!DOCTYPE", StringComparison.OrdinalIgnoreCase) ||
            conteudo.Contains("<!ENTITY", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("nfse_municipal_xml_invalido");
        return new HttpResponseMessage(resposta.StatusCode) { Content = new StringContent(conteudo, Encoding.UTF8) };
    }

    public static bool Privado(IPAddress ip)
    {
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        if (IPAddress.IsLoopback(ip)) return true;
        var b = ip.GetAddressBytes();
        return b.Length == 4
            ? b[0] is 0 or 10 or 127 || b[0] >= 224 || b[0] == 169 && b[1] == 254 ||
                b[0] == 172 && b[1] is >= 16 and <= 31 || b[0] == 192 && b[1] == 168 ||
                b[0] == 100 && b[1] is >= 64 and <= 127
            : ip.IsIPv6LinkLocal || ip.IsIPv6Multicast || ip.IsIPv6SiteLocal || b[0] == 0 || (b[0] & 0xfe) == 0xfc;
    }
}
