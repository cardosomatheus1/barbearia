# NFS-e 1.01 — pacote oficial de 27/07/2026

Bytes originais preservados, com URL e SHA256 em `origem.json`. Este pacote
introduz CNPJ alfanumérico em DPS, NFS-e e eventos. Corrige também a expressão
da série que exigia adaptação local no pacote anterior, mantido como histórico.

O tipo `TSChaveNFSe` contém uma divergência: a expressão publicada é
`[0-9]{6}([0-9A-Z]{14})[0-9]{30}`, enquanto `TSIdNFSe` e sua descrição colocam
a inscrição federal depois de 9 caracteres (município com 7, ambiente gerador
com 1 e tipo de inscrição com 1). Os IDs de pedido e evento usam essa mesma
posição de 9 caracteres. A expressão da chave publicada rejeita CNPJs cujas
últimas posições da ordem do estabelecimento contêm letras.

`src/nfse/schema.ts` adapta somente a cópia em memória de `TSChaveNFSe` para
`[0-9]{9}[0-9A-Z]{14}[0-9]{27}`. Exige uma única ocorrência da expressão
publicada; atualização do bundle requer revisão. Os arquivos oficiais não
foram modificados. O domínio restringe adicionalmente CPF a dígitos e os dois
verificadores do CNPJ a dígitos, inclusive nos identificadores e rotas.

O teste `cnpj-alfanumerico.test.ts` usa o exemplo `12.ABC.345/01DE-35` do manual
RFB, com letras inclusive no fim da ordem do estabelecimento, e percorre
assinatura, resposta, pedido de cancelamento, evento e DANFSe. São contratos
locais com PKI sintética. A adaptação não é confirmação de aceite pela
autoridade: isso deve ser exercitado na homologação externa.

Includes resolvidos somente destes buffers; não há leitor genérico de arquivo
nem rede no validador.
