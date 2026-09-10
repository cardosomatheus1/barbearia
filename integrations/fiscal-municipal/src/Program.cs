using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Barbearia.FiscalMunicipal;

var json = new JsonSerializerOptions(JsonSerializerDefaults.Web)
{
    UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
    MaxDepth = 12,
};
// stdout é exclusivamente o contrato JSON. Bibliotecas não podem escrever
// XML, nomes ou material criptográfico nos logs do worker.
using var saida = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
Console.SetOut(TextWriter.Null);
Console.SetError(TextWriter.Null);
try
{
    if (args is ["catalogo"])
    {
        await saida.WriteLineAsync(JsonSerializer.Serialize(Catalogo.Listar(), json));
        return 0;
    }
    if (args.Length != 0) throw new ArgumentException();
    using var entrada = Console.OpenStandardInput();
    using var memoria = new MemoryStream();
    var buffer = new byte[8192];
    int n;
    while ((n = await entrada.ReadAsync(buffer)) > 0)
    {
        if (memoria.Length + n > 8 * 1024 * 1024) throw new ArgumentException();
        memoria.Write(buffer, 0, n);
    }
    var pedido = JsonSerializer.Deserialize<PedidoFiscal>(memoria.ToArray(), json) ?? throw new ArgumentException();
    var resultado = Motor.Executar(pedido);
    await saida.WriteLineAsync(JsonSerializer.Serialize(resultado, json));
    return 0;
}
catch (Exception erro)
{
    // Só códigos locais, nunca Message/StackTrace do motor com conteúdo fiscal.
    var codigo = erro is NotImplementedException ? "nfse_municipal_operacao_sem_suporte"
        : erro is ArgumentException or JsonException ? "nfse_municipal_entrada_invalida"
        : "nfse_municipal_processamento_falhou";
    await saida.WriteLineAsync(JsonSerializer.Serialize(new ResultadoFiscal(false, codigo, [], "", "", null, null, []), json));
    return 1;
}
