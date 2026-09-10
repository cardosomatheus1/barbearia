# Schemas nacionais de NFS-e 1.01 — referência histórica

O validador atual usa o pacote de 27/07/2026 em `../nfse-1.01-20260727`.
A descrição abaixo registra o comportamento da versão anterior.

Arquivos originais do pacote oficial `nfse-esquemas_xsd-v1-01-20260209.zip`,
obtidos de gov.br em 2026-09-09. URL e SHA256 por arquivo estão em `origem.json`.
Os XSDs armazenados não foram editados.

## Incompatibilidade encontrada no padrão da série

`tiposSimples_v1.01.xsd`, tipo `TSSerieDPS`, contém:

```xml
<xs:pattern value="^0{0,4}\d{1,5}$"/>
```

Em regex de XML Schema 1.0, `^` e `$` são literais. A verificação com libxml2
(tanto WebAssembly quanto Python/lxml) rejeitou as séries `1` e `00001` e
aceitou `^1$`. Isso conflita com a regra E0010 do Anexo I, que reserva séries
numéricas de 00001 a 49999 para aplicativos próprios.

O validador aplica uma única correção de compatibilidade **em memória**:
`0{0,4}\d{1,5}`. Exige exatamente uma ocorrência do texto original; uma
atualização do pacote exige revisão explícita. O gerador também verifica
série inteira de 1 a 49999. Nenhum outro padrão foi alterado.

Os testes validam o documento contra os schemas com essa exceção documentada.
Não declarar que o XML passou pelo pacote original sem ajustes. A confirmação
de aceite pelo serviço nacional depende de homologação externa.

O leitor de includes recebe somente estes arquivos em memória. Não há leitor
genérico de arquivos nem cliente de rede registrado no validador.
