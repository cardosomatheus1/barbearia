# CNPJ alfanumérico

Cadastro fiscal, documento do tomador, certificado A1, contador da DPS,
identificadores, assinatura, consulta, cancelamento e DANFSe preservam letras
ASCII maiúsculas nas primeiras 12 posições. Os dois verificadores continuam
numéricos. CNPJs numéricos existentes permanecem aceitos.

O cálculo usa ASCII menos 48, pesos e módulo 11 do manual da Receita Federal.
Referência: https://www.gov.br/receitafederal/pt-br/centrais-de-conteudo/publicacoes/documentos-tecnicos/cnpj
(manual-dv-cnpj.pdf e codigos-cnpj.zip), consultada em 10/09/2026. Exemplo
publicado e usado nos testes: `12.ABC.345/01DE-35`.

A normalização remove a máscara conhecida e converte a-z em A-Z. Não apaga
letras, espaços internos, caracteres Unicode ou símbolos desconhecidos para
transformar uma entrada inválida em documento válido. Uma entrada inválida
também não limpa silenciosamente um CPF/CNPJ que já estava salvo.

Migração 0130 amplia os CHECKs sem reescrever documentos históricos. O emissor
usa o bundle XSD oficial de 27/07/2026, com a única adaptação em memória descrita
em `packages/finance/schemas/nfse-1.01-20260727/README.md`. A comprovação local
não equivale a homologação de cadastro ou emissão no ambiente oficial.

O A1 ainda deve identificar exatamente o CNPJ emitente. A equivalência entre
matriz, filial ou procurador não é deduzida da raiz do CNPJ. Representação
exige contrato e validação próprios.
