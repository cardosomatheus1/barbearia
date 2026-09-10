# Autenticidade das respostas fiscais

O emissor nacional verifica XSD, assinatura XML, chave, DPS e conteúdo antes de
gravar uma autorização ou um cancelamento. A assinatura precisa referenciar
exatamente `infNFSe` ou `infEvento`, filho direto do documento recebido. A assinatura
da DPS ou do pedido de cancelamento, que fica dentro do retorno, não autentica
por si só a resposta da autoridade.

## Catálogo de assinantes autorizados

`FISCAL_AUTORIDADES_PEM_B64` contém certificados **públicos** dos assinantes fiscais
autorizados pela instalação: arquivos PEM concatenados e codificados em base64,
em uma única linha. A seleção compara a impressão SHA-256 do certificado recebido
com esse catálogo e usa a chave pública configurada para verificar a assinatura.

Obtenha e confira esses certificados por canal oficial independente da resposta
que está sendo validada. Não adicione automaticamente o certificado encontrado
em `KeyInfo`, o A1 da barbearia ou qualquer chave privada. Um certificado assinado
por uma CA conhecida não concede, por si só, autoridade para emitir NFS-e.

É possível manter os certificados anterior e novo durante uma troca programada.
Remover um certificado do catálogo encerra sua aceitação na leitura seguinte.
Certificados vencidos ou ainda não válidos não são utilizados; a instalação precisa
de pelo menos um certificado válido. Catálogo ausente, inválido ou contendo chave
privada impede prontidão fiscal e transmissão, sem interromper os outros canais.

API e worker recebem a mesma configuração. Web e proxy não precisam dela.
O valor não vai para o formulário da barbearia, para respostas de API ou para logs.

## Confiança e revogação do A1

`FISCAL_CONFIANCA_DIR` aponta para um diretório absoluto administrado pela
plataforma. Ele contém dois arquivos exclusivamente públicos:

- `raizes.pem`: raízes ICP-Brasil obtidas e conferidas em fonte oficial
  independente. O PFX do cliente nunca acrescenta uma raiz a essa lista.
- `crls.pem`: listas de certificados revogados, em PEM, dos emissores de todos
  os níveis das cadeias utilizadas, inclusive da raiz para as intermediárias.

O cadastro, a indicação de prontidão e cada uso do A1 executam a validação com
OpenSSL 3 (`/usr/bin/openssl`, já instalado na imagem). São conferidos caminho,
assinaturas, validade, restrições de CA, finalidade de cliente TLS, força mínima
das assinaturas/chaves e revogação de toda a cadeia. O processo recebe somente
certificados públicos e CRLs; PFX, senha e chave privada ficam fora dos arquivos
temporários, argumentos, ambiente e mensagens de erro.

A leitura do A1 também exige folha X.509 v3 com `digitalSignature` e
`nonRepudiation` no KeyUsage, conforme as regras da assinatura da DPS no
Anexo I oficial 1.01 (09/02/2026). A finalidade TLS do OpenSSL não substitui
esses requisitos fiscais. Certificados com CNPJ e validade corretos, mas sem
esses usos, são recusados antes de serem armazenados ou usados.

Raiz desconhecida, certificado revogado, CRL ausente, futura, vencida ou com
assinatura inválida impedem o uso. Não há fallback para as raízes do sistema nem
download de endereços fornecidos pelo PFX. Uma indisponibilidade não transforma
o certificado em válido. Cadastro rejeitado preserva o A1 anterior; a falha antes
de transmitir preserva a intenção fiscal para recuperação posterior.

Nos dois Composes, o diretório do host é montado somente para leitura em
`/run/fiscal-confianca`, na API e no worker. Web/proxy não recebem esse material.
O atualizador opcional publica gerações atômicas antes de `nextUpdate`; o sistema
revalida sem cache de aceitação. Mantenha raízes antigas e novas durante renovações
autorizadas e CRLs correspondentes. Remover uma raiz encerra sua aceitação no
próximo uso. Em revogação real do A1, a recuperação requer outro certificado
válido; não se deve retirar a revogação da lista.

O utilitário `scripts/fiscal-confianca-atualizar.mjs` renova raízes previamente
autorizadas e CRLs, com pins e verificação OpenSSL; ver
`docs/fiscal-renovacao-confianca.md`. A escolha inicial das raízes e sua
autenticidade por canal independente continuam sendo configuração da instalação. A sessão não obteve
um pacote oficial verificável: o endpoint consultado falhou na validação TLS e
nenhuma raiz foi aceita ignorando essa falha. Os testes usam uma PKI sintética
com raiz, intermediária e folha, além de CRLs realmente assinadas.

## Validação e recuperação das respostas

Além do pin explícito, recebimentos novos verificam a cadeia e as CRLs do
assinante fiscal contra o catálogo independente. As intermediárias podem ser
fornecidas no arquivo público `cadeias.pem` da mesma geração de confiança.
A assinatura XML e o vínculo com o pedido são conferidos antes da persistência.

A migração 0131 guarda registro autenticado da verificação junto à nota/evento.
O DANFSe usa essa evidência para documentos arquivados após uma rotação ou
vencimento posterior do certificado. Legado sem prova exige revalidação atual;
não se inventa uma data de validação anterior. Ver `fiscal-resposta-arquivada.md`
para funcionamento e limites, incluindo a distinção de carimbo do tempo e
validação independente de longo prazo.

Retorno inválido não grava autorização/cancelamento. A intenção persistida é
mantida para consulta e recuperação; não se transmite outro pedido só porque
a resposta foi recusada. Os testes usam autoridades sintéticas, sem valor
fiscal. Aceitação por uma autoridade real continua na homologação externa.
