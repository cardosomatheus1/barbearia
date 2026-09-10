using OpenAC.Net.NFSe.Commom.Model;
using OpenAC.Net.NFSe.Commom.Types;
using OpenAC.Net.NFSe.Providers;

namespace Barbearia.FiscalMunicipal;

public static class Catalogo
{
    public static bool Sincrono(OpenMunicipioNFSe municipio) => municipio.Provedor.ToString() is "NFeCidades" or "Citta";

    public static Uri EnderecoSeguro(string valor)
    {
        if (!Uri.TryCreate(valor, UriKind.Absolute, out var uri) || uri.Scheme != "https" ||
            uri.UserInfo.Length > 0 || uri.Fragment.Length > 0 || uri.HostNameType != UriHostNameType.Dns ||
            uri.IsLoopback || !uri.IsDefaultPort)
            throw new InvalidOperationException("nfse_municipal_destino_invalido");
        return uri;
    }

    public static bool Atendido(OpenMunicipioNFSe municipio, bool producao)
    {
        // Estes adaptadores possuem endpoints, mas métodos necessários lançam
        // NotImplementedException na fonte fixada. Não oferecer fluxo incompleto.
        if (municipio.Provedor.ToString() is "SigISS" or "Fisco" or "IPM" or "ISSSJP" or "Megasoft" or "GIAP") return false;
        if (!ProviderManager.Providers.TryGetValue(municipio.Provedor, out var versoes) ||
            !versoes.ContainsKey(municipio.Versao)) return false;
        var urls = producao ? municipio.UrlProducao : municipio.UrlHomologacao;
        try
        {
            TipoUrl[] operacoes = [Sincrono(municipio) ? TipoUrl.EnviarSincrono : TipoUrl.Enviar, TipoUrl.ConsultarNFSeRps, TipoUrl.CancelarNFSe];
            return operacoes.All(op => urls.TryGetValue(op, out var url) && EnderecoSeguro(url) != null);
        }
        catch (InvalidOperationException) { return false; }
    }

    public static MunicipioFiscal[] Listar() => ProviderManager.Municipios
        .Select(m => new MunicipioFiscal(m.Codigo, m.Nome, m.UF.ToString(), m.Provedor.ToString(),
            Atendido(m, false), Atendido(m, true), m.Versao.ToString())).OrderBy(m => m.Codigo).ToArray();

    public static OpenMunicipioNFSe Exigir(int codigo, string ambiente)
    {
        if (ambiente is not ("producao" or "homologacao")) throw new ArgumentException("nfse_municipal_ambiente_invalido");
        var municipio = ProviderManager.Municipios.SingleOrDefault(m => m.Codigo == codigo);
        if (municipio is null || !Atendido(municipio, ambiente == "producao"))
            throw new InvalidOperationException("nfse_municipal_sem_suporte");
        return municipio;
    }

    public static HashSet<string> Hosts(OpenMunicipioNFSe municipio, string ambiente)
    {
        var urls = ambiente == "producao" ? municipio.UrlProducao : municipio.UrlHomologacao;
        var hosts = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var url in urls.Values.Where(u => !string.IsNullOrWhiteSpace(u)))
        {
            try { hosts.Add(EnderecoSeguro(url).Host); }
            catch (InvalidOperationException) { /* Endpoints HTTP nunca são promovidos a HTTPS por suposição. */ }
        }
        return hosts;
    }
}
