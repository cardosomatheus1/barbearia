# Contratos fiscais: algoritmo e matriz/filial

Revisão documental em 10/09/2026, pelo único auxiliar reautorizado. Nenhuma
chamada autenticada, alteração do produto ou homologação. A fonte permanece
congelada durante a regressão v9.

| Operação | Fonte oficial e regra | Limite da conclusão |
|---|---|---|
| Assinatura DPS | Manual Integrado 1.00.02, §6.1.4, pp.25–26: RSA-SHA1/digest SHA1, C14N 1.0/enveloped | Referência histórica; documentos atuais examinados não determinam algoritmo. XSD Algorithm:anyURI não comprova aceite |
| Certificado DPS | Anexo I 1.01 09/02/2026, RN DPS_NFS-e, RN646/E0718, linha649: certificado do emitente | Não explicita comparação por raiz |
| Assinatura evento | Anexo II 1.01 22/01/2026, RN EVENTO_PED.REG.EVENTO, RN20/E0812, linha23: verificar apenas CNPJ base | Permissão atual específica da assinatura; não autoriza presumir mTLS Sefin |
| Distribuição ADN | Manual APIs ADN contribuintes, §1.1, p.3: mesma raiz nas consultas; /DFe/{NSU} permite parâmetro CNPJ diferente do certificado | Permissão atual específica de consulta ADN, não POST /nfse na Sefin |
| Sefin GET /dps | Manual Emissor Público API 1.2, §§1.4.1–1.4.2, p.4: certificado deve corresponder a ator da nota; HEAD só verifica existência | Regra de raiz não explicitada |

## Fontes

- https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/leiaute-e-esquemas-antigos/manualintegradosnnfse_v1-00-02-producao.pdf
- https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/anexo_i-sefin_adn-dps_nfse-snnfse-v1-01-20260209.xlsx
- https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/anexo_ii-sefin_adn-pedregevt_evt-snnfse-v1-01-20260122.xlsx
- https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/manual-contribuintes-apis-adn-sistema-nacional-nfse.pdf
- https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/manual-contribuintes-emissor-publico-api-sistema-nacional-nfs-e-v1-2-out2025.pdf

## Efeito sobre o produto

`certificado.ts` e `configuracao.ts` exigem CNPJ integral. `transporte.ts` usa o
mesmo material para mTLS. Trocar globalmente a comparação por oito caracteres
ampliaria operações cuja autorização não foi confirmada. A validação integral
foi mantida. Assinatura de evento com mesma raiz e distribuição ADN têm contrato
identificado, mas o fluxo completo matriz/filial continua limitado no código.

Algoritmo atual e representação Sefin permanecem dúvidas documentais/externas;
adaptadores municipais, retenções e salão-parceiro continuam lacunas de código.
Uma classe não encerra a outra.

## Rechecagem da referência Raiz

O principal consultou `backend/erp-saas/apps/api/src/modules/fiscal` e
`backend/erp-saas/packages` somente para leitura. `NFSE` aparece no enum de
`fiscal.service.ts`, mas a fábrica seleciona intermediários, mock ou
`SefazDirectAdapter`. O caminho próprio é SEFAZ de NF-e/NFC-e;
`nfe-snapshot.service.ts` recusa venda apenas de serviços e orienta usar NFS-e.
Não foram encontrados adaptadores próprios ABRASF/Ginfes/ISSNet/Betha nesse
conjunto. Ter o enum não equivale a ter emissão municipal implementada.
