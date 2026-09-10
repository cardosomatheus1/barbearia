# Revisão de segurança para reaproveitamento fiscal

Data: 2026-09-10. Escopo: transporte TLS, certificados, logs/arquivos e isolamento entre empresas em OpenAC.Net.NFSe e Unimake/DFe. Inspeção estática das fontes; não houve emissão fiscal, autenticação externa, alteração de bibliotecas ou execução de suítes nesta revisão.

## Recomendação

Preferir **OpenAC.Net.NFSe com fonte fixada e correções explícitas**, executada em processo CLI novo por operação. O reaproveitamento é viável para municípios/provedores já disponíveis e compatíveis. A presença de um município no catálogo não comprova funcionamento, contrato fiscal atual ou homologação.

Não incorporar nenhuma das bibliotecas diretamente com seus defaults em processo compartilhado do SaaS. A OpenAC compartilha configuração mutável no construtor vazio e permite bypass TLS em alguns provedores. A Unimake desativa a validação de certificado de servidor globalmente no transporte SOAP inspecionado. Isolar o processo reduz interferência entre empresas, mas **não corrige TLS permissivo, exposição de XML ou persistência de chaves**.

## Fontes fixadas

| Fonte | Commit inspecionado | Checkout |
| --- | --- | --- |
| OpenAC-Net/OpenAC.Net.NFSe | `1b09acef0ac4541ed4bab8daf97f804ad8951e3d` | `/home/ec2-user/codex-tmp/nfse-referencia-openac` |
| OpenAC-Net/OpenAC.Net.DFe.Core, tag `v1.7.0.1` | `fcd75d69bb678499d6e708c17ecb115b8f91f014` | `/home/ec2-user/codex-tmp/nfse-referencia-openac-dfecore` |
| Unimake/DFe | `3ca4cf22ce7c3fd871b88b7b892c569a3170d5e6` | `/home/ec2-user/codex-tmp/nfse-referencia-unimake` |

`OpenAC.Net.NFSe.csproj` referencia DFe.Core `1.7.0.1`; a dependência foi conferida nessa tag exata, primeiro por conteúdo GitHub e depois por clone. Não se usou a branch atual da dependência como prova da versão.

Convenção dos caminhos abaixo:

- **O/**: `src/OpenAC.Net.NFSe/` no checkout OpenAC.Net.NFSe.
- **C/**: `src/OpenAC.Net.DFe.Core/` no checkout DFe.Core da tag indicada.
- **U/**: `source/.NET Standard/Unimake.Business.DFe/` no checkout Unimake.

## Comparação resumida

| Aspecto | OpenAC | Unimake |
| --- | --- | --- |
| TLS de servidor | Base valida; vários provedores podem desativar | SOAP aceita qualquer certificado e altera callback global; não se atribui esse mesmo bypass à API HttpClient |
| Configuração por empresa | Construtor vazio compartilha singleton mutável | Configuração de instância; reutilização mantém certificado em cache |
| Importação A1 | `MachineKeySet` fixo em bytes/arquivo na dependência | `DefaultKeySet` padrão, flags configuráveis e certificado pode ser injetado |
| XML em disco | Gravações habilitadas por padrão em `Arquivos` e `Geral`; não separa CNPJ por padrão | Métodos explícitos de gravação encontrados; não se comprovou persistência automática geral |
| Logs | Exceções SOAP podem conter resposta completa e são registradas | Inicialização escreve XML completo em `Trace` quando habilitado/coletado |
| Estado global | Configuração default, catálogo de municípios e `ServicePointManager` | Callback TLS e protocolos em `ServicePointManager` |
| Uso recomendado | CLI por operação, fonte corrigida, catálogo restrito e cofre próprio | Modelos/builders podem ser úteis; não usar transporte SOAP original |

## Achados que bloqueiam incorporação com os defaults

### 1. Unimake SOAP ignora a identidade do servidor e altera o processo inteiro

**Evidência:** `U/ConsumirServico/Transport/SoapTransportExecutor.cs:22` atribui `ServicePointManager.ServerCertificateValidationCallback = new RemoteCertificateValidationCallback(RetornoValidacao)`. O método em `:194` retorna `true` incondicionalmente, ignorando `SslPolicyErrors`. Em `:23` habilita TLS 1.0, 1.1 e 1.2. O request efetivo é criado em `:88` e recebe o certificado cliente em `:100–103`.

**Gatilho:** executar uma operação que use esse transporte SOAP. O callback não é restaurado ao final. Outros clientes baseados nesse estado global no mesmo processo podem ser afetados.

**Impacto:** servidor com certificado expirado, cadeia não confiável ou nome incorreto pode ser aceito. A assinatura do XML enviado não autentica o servidor nem protege a autenticidade da resposta. Um processo separado continua vulnerável ao servidor falso.

**Correção necessária:** remover o bypass e manter validação normal de cadeia/nome/validade, com protocolos atuais no cliente efetivo. Corrigir cadeia incompleta do servidor mediante intermediária validada, sem callback permissivo. Testar rejeição de servidor não confiável em ambiente local controlado. Esse achado está demonstrado no caminho SOAP, não em todos os transportes da biblioteca.

### 2. OpenAC compartilha a configuração e credenciais no construtor padrão

**Evidência:** `O/Configuracao/ConfigNFSe.cs:63` declara `public static ConfigNFSe Default { get; } = new();`. `O/OpenNFSe.cs:68–72` atribui essa mesma referência a toda instância criada por `new OpenNFSe()`. A configuração contém `Certificados`, `WebServices` e `PrestadorPadrao`, criados em `ConfigNFSe.cs:47–54`, e prestador mutável em `:69`.

**Gatilho:** criar instâncias para duas empresas pelo construtor vazio e preencher cada uma. A segunda escrita altera o objeto usado pela primeira, mesmo sem uma corrida simultânea.

**Impacto:** troca de ambiente, prestador, certificado/senha e parâmetros entre empresas, dependendo da ordem de execução.

**Correção necessária:** `new ConfigNFSe()` por operação e construtor explícito `new OpenNFSe(config)` (`OpenNFSe.cs:78–82`). Não compartilhar, reconfigurar ou colocar instâncias/configurações em pool. Um CLI novo por operação reforça o isolamento. A API permite evitar esse problema sem alterar o singleton, desde que o wrapper nunca o utilize.

### 3. OpenAC permite bypass TLS por provedor

**Evidência:** `O/Commom/Client/NFSeHttpServiceClient.cs:281–284` instala callback que retorna `true` quando `ValidarCertificadoServidor()` é falso. A implementação base `:358` retorna `true`, mas existem overrides:

| Override | Quando desativa |
| --- | --- |
| `O/Providers/Conam/ConamServiceClient.cs:180–183` | Todos os ambientes |
| `O/Providers/SigISS/SigISS100ServiceClient.cs:135` | Todos os ambientes |
| `O/Providers/SigISS/SigISS103ServiceClient.cs:141` | Todos os ambientes |
| `O/Providers/Abaco/AbacoServiceClient.cs:173–175` | Homologação |
| `O/Providers/Abaco/Abaco204ServiceClient.cs:187–189` | Homologação |
| `O/Providers/ISSNet/ISSNet204ServiceClient.cs:183–185` | Homologação |
| `O/Providers/Thema/ThemaServiceClient.cs:162–164` | Homologação |
| `O/Providers/SmarAPD/SmarAPD204ServiceClient.cs:291–293` | Homologação |

Não foi encontrado override em `ISSSaoPauloServiceClient`; o caminho inspecionado de São Paulo utiliza a validação base. Isso não substitui homologação desse município.

**Correção necessária:** remover do transporte base a instalação do callback permissivo, independentemente dos overrides. A simples seleção de HTTPS não resolve certificado inválido. O wrapper deve tratar erro TLS como erro de conexão, sem tentar novamente com validação desligada.

### 4. OpenAC grava XML cru por padrão sem separar empresas

**Evidência da versão exata da dependência:** `C/Common/DFeArquivosConfigBase.cs:82` define `Salvar=true`; `:84` define `SepararPorCNPJ=false`; `:77–79` usa diretórios relativos à localização do assembly. `C/Common/DFeGeralConfigBase.cs:74` também define `Salvar=true`. Já `C/Common/DFeWebserviceConfigBase.cs:74` é uma propriedade bool sem atribuição no construtor, portanto seu default é falso.

**Uso efetivo:** `O/Providers/ProviderBase.cs:1570–1587` grava RPS/NFS-e quando `Arquivos.Salvar` está ligado; `:1595–1599` usa `Geral.Salvar` para outro caminho de gravação; `:1602–1618` escreve arquivo sem cifragem. `O/Commom/Client/NFSeHttpServiceClient.cs:278–279,329,366–373` grava envelopes quando `WebServices.Salvar` é verdadeiro.

`O/Configuracao/ConfigArquivosNFSe.cs:55–60` define diretórios NFSe/Lote/RPS. `C/Common/DFeArquivosConfigBase.cs:181–242` só inclui CNPJ quando a configuração solicita; por padrão os arquivos podem compartilhar a mesma árvore entre empresas. Separar por CNPJ, sozinho, não implementa controle de acesso nem cifragem.

**Correção necessária:** definir explicitamente `Arquivos.Salvar=false`, `Geral.Salvar=false` e `WebServices.Salvar=false`. Persistir documentos pelo armazenamento próprio do SaaS com empresa/ambiente/operação identificados, cifragem, autorização e retenção. Impedir que um operador forneça caminhos de arquivo. Verificar que emissão, consulta e erros não criam XML no diretório de trabalho ou temporário.

### 5. OpenAC importa PFX com MachineKeySet, inclusive ao receber bytes

**Evidência:** `C/Common/DFeCertificadosConfigBase.cs:144–156` seleciona certificado por bytes, arquivo ou store. `C/CertificadoDigital.cs:107` e `:124` usam `new X509Certificate2(..., X509KeyStorageFlags.MachineKeySet)` para arquivo e bytes. Não há flag configurável nesse caminho. Os bytes e a senha ficam nas propriedades de configuração (`DFeCertificadosConfigBase.cs:77,82`).

**Impacto:** passar PFX em memória não garante ausência de armazenamento da chave pelo runtime/SO. `MachineKeySet` direciona a importação ao contexto de máquina em plataformas que implementam esse comportamento. A inspeção não prova gravação efetiva no Linux atual nem permanência após descarte; isso deve ser verificado no runtime de produção.

**Correção necessária:** compilar a dependência fixada com `EphemeralKeySet` nos dois overloads, ou fornecer uma fronteira própria que importe e controle o certificado sem esse caminho. Não usar store global do usuário/máquina como seleção de empresa. Preservar validação própria de chave privada, validade, cadeia ICP-Brasil, revogação e vínculo do titular à operação. Descartar certificado ao final; `O/Providers/ProviderBase.cs:1636–1652` já descarta seu certificado em .NET, mas não apaga senha/bytes da configuração. CLI por operação limita a vida desse material; não passar PFX ou senha em argumentos de processo ou logs.

## Outros achados relevantes

### 6. Dados fiscais podem aparecer em logs e mensagens de erro

Na Unimake, `U/Servicos/ServicoBase.cs:146` executa `Trace.WriteLine(ConteudoXML?.InnerXml, "Unimake.DFe")` durante a inicialização. A captura depende da compilação com TRACE e de listeners; não significa que um arquivo seja sempre criado. Ainda assim, adicionar um listener de produção pode passar a coletar todo o documento sem o wrapper solicitar esse conteúdo.

Na OpenAC, `O/Commom/Client/NFSeSoapServiceClient.cs:174–185` inclui `EnvelopeRetorno`/`retorno` completo em exceções de resposta inválida. `O/OpenNFSe.cs:114–117` registra a exceção. Desligar a gravação de XML não evita esse caminho de exposição.

**Recomendação:** remover conteúdo bruto das exceções de comunicação e suprimir logs internos que emitam payload. O CLI deve devolver contrato estruturado de erro, código, etapa e identificador de correlação, sem repassar indiscriminadamente `exception.ToString()`, XML, PFX, senha ou cabeçalhos. A resposta fiscal original, quando necessária à auditoria, deve ir somente ao arquivo cifrado e autorizado da operação.

### 7. Configurações e certificados em cache não devem ser reaproveitados entre empresas

Na Unimake, `U/Servicos/Configuracao.cs:61–67` retorna `_certificadoDigital` já carregado. Alterar `CertificadoArquivo`, `CertificadoBase64`, `CertificadoSenha` ou serial (`:883–898`) não invalida esse cache. `CertificadoDigital` possui setter explícito em `:918–921`, mas o wrapper não deve depender de lembrar de limpá-lo a cada troca de empresa. O default de importação é `DefaultKeySet` (`:906–907`); é possível configurar flags ou injetar certificado já importado.

`U/Servicos/ServicoBase.cs:123–126` conserva referências da configuração e XML recebidos; o descarte `:357–370` libera o stream de resposta, sem demonstrar descarte do certificado da configuração. Na OpenAC, `O/Providers/ProviderBase.cs:267` também mantém certificado carregado no provedor.

**Recomendação:** objeto e certificado exclusivos por operação; sem pools desses objetos e sem alterar credenciais após sua criação. O proprietário do certificado deve controlar seu descarte. Para integração Unimake, é preferível injetar certificado previamente validado/importado com flags adequadas e não recorrer ao store automático.

### 8. Catálogo e protocolos globais exigem fronteira controlada

Na OpenAC, `O/Providers/ProviderManager.cs:207–213` permite limpar/carregar o catálogo estático de municípios. Alterar `ArquivoServicos` em `O/Configuracao/ConfigArquivosNFSe.cs:147–149` chama o carregador; `ProviderManager.cs:221–232` consulta o catálogo global. Não permitir que configurações de uma empresa alterem esse catálogo de outras operações.

`O/OpenNFSe.cs:102,106,121` guarda, altera e restaura `ServicePointManager.SecurityProtocol`. Restaurações podem se intercalar em operações concorrentes. `O/Configuracao/ConfigWebServicesNFSe.cs:64` habilita TLS 1.0/1.1/1.2, enquanto a atribuição de protocolos ao handler HttpClient está comentada em `O/Commom/Client/NFSeHttpServiceClient.cs:286–287`. Portanto, configurar `WebServices.Protocolos` não basta para afirmar a política efetiva do HttpClient em .NET moderno. A API Unimake também altera globais em `U/ConsumirServico/Transport/ApiTransportExecutor.cs:54–55`.

**Recomendação:** catálogo fixado e somente leitura, sem arquivos fornecidos pelo tenant. CLI por operação e TLS definido no handler efetivo. Remover alterações globais desnecessárias na fonte incorporada.

### 9. Política de endpoints, proxy e redirecionamentos não é a política do SaaS

A OpenAC usa a URL do provedor em `O/Commom/Client/NFSeHttpServiceClient.cs:303`; só configura proxy quando uma string é fornecida (`:292–296`), mantendo os defaults do handler quando ela está vazia. Não foi encontrado `AllowAutoRedirect=false` nesse cliente. O catálogo contém URLs HTTP, por exemplo `O/Resources/Municipios.nfse:678` (homologação) e `:722` (produção). Não presumir que todas as entradas podem ser usadas com segurança ou transformar automaticamente HTTP em HTTPS sem verificar o endpoint oficial.

Na Unimake, os executores inspecionados carregam explicitamente a decisão de proxy (`SoapTransportExecutor.cs:105`; `ApiTransportExecutor.cs:75–78`), e o mapper de configuração leva `HasProxy`; não se apontou ausência desse mapeamento. Entretanto, o caminho API sem certificado pode selecionar certificado do store automaticamente e usar credenciais do processo (`ApiTransportExecutor.cs:80–88`; `Compatibility/ApiConfigTransportRequestMapper.cs:17–21`). Isso não foi demonstrado no caminho SOAP de São Paulo. O WinHTTP usa seleção manual vazia, mas ainda permite credenciais padrão (`ApiTransportExecutor.cs:118–126`).

**Recomendação:** somente HTTPS em hosts/portas de um catálogo oficial aprovado; rejeitar URL, proxy e credenciais arbitrárias vindas da empresa. Desativar proxy de sistema e redirecionamento automático no wrapper; caso haja redirect necessário, validar cada destino explicitamente. Não habilitar credenciais padrão ou seleção automática de certificado. Ausência dessas guardas não comprova exploração, mas impede transferir diretamente a confiança do catálogo para entrada do usuário.

### 10. Caminhos explícitos/latentes de disco precisam ser evitados

`O/Commom/Client/NFSeMultiPartClient.cs:182–186` cria arquivo temporário e abre stream sem `DeleteOnClose` ou remoção explícita. O caminho é usado por `SendFormat.File`; a busca nos provedores não encontrou chamada atual dessa opção. É um risco latente de reutilização, não defeito demonstrado na operação de São Paulo.

`U/Servicos/NFSe/ServicoBase.cs:838–851` grava XML no caminho fornecido; é API explícita. Existe overload de stream em `:864`, que permite encaminhar o conteúdo ao armazenamento controlado sem arquivo local. Outros métodos de distribuição consultados também exigem chamada explícita para gravação. Não foi demonstrado que a Unimake grave todos os documentos automaticamente.

## Patches mínimos para a incorporação OpenAC proposta

1. Fixar fontes NFSe e DFe.Core nos hashes acima, preservar licenças e registrar patches locais.
2. Em `C/CertificadoDigital.cs`, substituir `MachineKeySet` por `EphemeralKeySet` nos overloads de arquivo e bytes; preferir bytes via canal interno restrito. Validar compatibilidade da assinatura e mTLS no runtime final.
3. Em `O/Commom/Client/NFSeHttpServiceClient.cs`, remover callback permissivo; definir explicitamente `SslProtocols` para TLS 1.2/1.3 no alvo .NET 8, `UseProxy=false`, seleção manual de certificado e `AllowAutoRedirect=false`. Não confiar em `ServicePointManager` como política desse handler.
4. Impor validação de endpoint HTTPS antes da chamada e catálogo imutável. Município ausente/incompatível deve resultar em mensagem de indisponibilidade; não fabricar adapter ou prometer cobertura nacional.
5. No CLI, criar `ConfigNFSe` novo, desativar as três flags de gravação e não configurar caminhos ou catálogo vindos do tenant. Manter certificado e dados associados à mesma operação.
6. Suprimir registro interno de payload e substituir exceções com resposta crua por erro estruturado seguro. Corrigir temporário multipart ou bloquear a opção enquanto não for necessária.
7. Executar somente uma operação por processo, com tempo/volume de entrada e saída limitados e tratamento de saída anormal. Não usar retry cego para emissão após timeout: resultado fiscal pode ser incerto e exige consulta/reconciliação antes de novo envio.
8. Manter no SaaS o controle de acesso, o cofre A1, a validação ICP-Brasil, a idempotência, o estado fiscal, os documentos cifrados e a auditoria. A biblioteca fornece protocolo/modelos, sem substituir essas garantias.

## Verificações necessárias após implementação

Estas verificações são propostas, **não resultados desta inspeção**:

- Teste de duas operações com empresas/certificados diferentes, demonstrando que configuração, saída e arquivos não se misturam.
- Teste local com servidor TLS não confiável e com hostname incorreto, ambos rejeitados; teste do servidor confiável com certificado cliente sintético esperado.
- Testes de rejeição de HTTP, destino externo ao catálogo e redirect não autorizado antes de enviar documento/certificado.
- Exercitar sucesso, erro SOAP, resposta inválida e timeout com dados sintéticos; assegurar ausência de XML bruto, PFX e senha em stdout de erro, stderr, logs e disco.
- Verificar importação efêmera e descarte no mesmo SO/runtime de produção. Não interpretar apenas o nome da flag como prova de ausência de artefato em todos os ambientes.
- Build e testes determinísticos dos adapters efetivamente incorporados, seguidos das regressões de consumidores que o agente principal está conduzindo. Homologação externa continua separada da conclusão de código.

## Registro de inspeção e limites

Foram usados `rg`, leitura numerada com `nl -ba`, inspeção dos construtores/transportes/mappers/configurações, `git ls-remote --tags` para localizar `v1.7.0.1`, leitura GitHub da dependência fixada e `git clone --depth 1 --branch v1.7.0.1` para materializá-la. O clone DFe.Core retornou o hash `fcd75d69bb678499d6e708c17ecb115b8f91f014`; o status desse clone estava limpo na conferência. Nenhum comando de emissão ou teste fiscal foi executado nesta revisão.

Esta análise não é uma auditoria integral dos pacotes transitivos, schemas, todos os municípios, criptografia XML ou parsers. Não comprova exploração de rede nem persistência de chave em um SO específico. Achados do código-fonte das bibliotecas não significam que já existam no produto: a consequência depende de quais caminhos forem incorporados. O agente principal deve registrar separadamente os patches aplicados e as provas executadas sobre o artefato final.
