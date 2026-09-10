# Emissor municipal próprio com código reutilizado

O emissor municipal executa no ambiente da plataforma e comunica diretamente
com a prefeitura. Não usa intermediário fiscal comercial. A opção nacional e a
municipal compartilham o certificado A1 da unidade, mas cada documento conserva
seu emissor, ambiente, série, número e dados da venda ao ser solicitado.

## Código de origem

A fonte OpenAC.Net.NFSe, licença MIT, está incorporada em
`integrations/fiscal-municipal/vendor/openac-nfse`, no commit
`1b09acef0ac4541ed4bab8daf97f804ad8951e3d` do repositório
https://github.com/OpenAC-Net/OpenAC.Net.NFSe. A licença deve acompanhar a
redistribuição. `origem.json` registra hashes dos 659 arquivos originais;
`alteracoes-locais.json` registra as seis adaptações de infraestrutura.
Não foram copiados demos nem testes upstream.

As adaptações removem transporte com validação TLS permissiva, certificado em
store, escrita de XML temporário e logs com dados fiscais; a serialização e os
protocolos municipais vêm dos adaptadores existentes. O leitor A1 nacional foi
adaptado da referência ERP Raiz; o fiscal direto daquele repositório é NF-e/NFC-e
e não forneceu os adaptadores municipais NFS-e.

## Cobertura e limites

O catálogo TypeScript é gerado pelo mesmo motor C# compilado, a partir dos
municípios da fonte fixada. Ele verifica endpoints HTTPS e exclui operações
sabidamente não implementadas (SigISS, Fisco, IPM, ISSSJP, Megasoft e GIAP).
NFeCidades e Citta usam envio síncrono. Ter um registro elegível no catálogo
**não comprova homologação** do município/CNPJ/regime/serviço.

Municípios ausentes ou sem fluxo completo são apresentados com orientação para
usar o portal da prefeitura. O escopo não inclui criar novos adaptadores para
essas cidades. A prefeitura pode exigir credenciamento ou campos específicos;
a rejeição deve ser conferida antes de solicitar nova nota.

O mapeamento atende serviços locais tributáveis, sem retenção, nos regimes
Simples e normal. Salão-parceiro, benefícios e situações especiais não estão
mapeados. São Paulo fica limitado ao layout 1 sem desconto: o serializer deste
layout não representa desconto incondicionado; o mapeamento do layout 2 com
IBS/CBS não foi implementado. A tela informa esse limite. Não emitir por um
perfil diferente do aplicável apenas para contornar a restrição.

O PDF municipal é uma representação auxiliar local. O XML original autorizado
fica disponível e a autenticidade deve ser conferida no portal municipal.

## Preparação e execução

Requer SDK .NET 10 LTS para compilar/testar e Node 22/pnpm como o restante do
monorepo. `Directory.Build.props` e os lockfiles fixam o grafo para linux-x64.

```sh
bash scripts/testar-fiscal-municipal.sh
```

O comando testa o motor, confere hashes/catálogo, publica executável
self-contained e prova o contrato Node → stdin → executável → stdout sem rede
fiscal. O `pnpm verify` inclui essa etapa; o CI instala o SDK .NET 10.
A imagem Docker compila o motor em estágio separado e define
`FISCAL_MUNICIPAL_BIN=/opt/barbearia/fiscal-municipal/Barbearia.FiscalMunicipal`.
Fora do Docker, configure um caminho absoluto para o executável publicado.
Não é um serviço HTTP nem abre porta adicional.

`FISCAL_MODO=nacional` conserva seu nome histórico e habilita o emissor próprio;
o seletor por unidade escolhe nacional ou municipal. A migração 0136 adiciona
configuração, contador de RPS, documentos e histórico municipal. Aplicar em
produção continua sendo ação separada de compilar/testar/publicar código.

## Operação e recuperação

1. Conferir o cadastro fiscal e escolher o emissor municipal.
2. Reservar série exclusiva, informar o primeiro número e confirmar essa
   exclusividade. Depois de salva, a numeração inicial da série não muda.
3. Informar códigos, endereço, credenciais se exigidas e A1.
4. Homologar o fluxo disponível com o CNPJ; só então habilitar a emissão.

Antes do primeiro envio, o sistema consulta o RPS para detectar colisão. Somente
resposta válida ou ausência documentada permite prosseguir. São Paulo reconhece
1106 na consulta; as variantes ABRASF inspecionadas reconhecem E4/E89/E91. E92,
falha técnica, erro de credencial ou conjunto misto não comprovam ausência.
Referências: Manual SP 3.3.7 (maio/2026), pp.53/82; manual ABRASF 1.00,
pp.31/34; tabela oficial de erros ABRASF 2.04, linhas10/95/97.

O motor prepara o envelope já serializado e assinado sem transmitir. O backend
cifra e persiste o envelope antes de enviar exatamente os mesmos bytes.
Timeout ou falha de parse ficam pendentes: a recuperação consulta, sem reenviar
RPS. O código local 0 da biblioteca nunca é tratado como recusa fiscal.
Recepção de lote também não equivale a autorização.

A nota recebida é conferida contra emitente, RPS/série, valor/desconto,
tomador e data/competência. O pedido e a primeira resposta permanecem
imutáveis. As consultas seguintes e as tentativas de cancelamento têm histórico
cifrado separado, sem permissão de alteração ou exclusão pelo role de aplicação.

Cancelamento com resposta incerta é conciliado por consulta da nota; não se
repete o envio automaticamente. Recusa confirmada permite nova ação explícita
com motivo corrigido. Uma nota consultada como cancelada encerra a conciliação.

Chaves e credenciais passam apenas por stdin, não por argumentos ou logs.
O transporte valida TLS e revogação, recusa redirecionamentos, proxies,
endereços internos e destinos fora do catálogo, com limites de tempo e tamanho.

## Validação externa

Os testes usam dados e certificados sintéticos e respostas controladas.
A homologação real permanece com o proprietário: conferir os campos exigidos,
aceite, rejeição, timeout, consulta, cancelamento e XML/PDF por município e perfil.
Esta documentação não declara a implantação nem a cobertura nacional universal.
