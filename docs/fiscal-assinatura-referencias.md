# Referências da assinatura da NFS-e

Consulta técnica em 10/09/2026. O gerador permite SHA1 e SHA256; o adaptador
nacional escolhe RSA-SHA1 com digest SHA1, C14N 1.0 e enveloped-signature.

O [Manual Integrado do Sistema Nacional NFS-e 1.00.02](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/leiaute-e-esquemas-antigos/manualintegradosnnfse_v1-00-02-producao.pdf),
seção 6.1.4, páginas 25–26, declara esses algoritmos e a inclusão somente do
certificado do usuário final na assinatura. A mesma seção aplica o processo
aos demais documentos assinados. Essa é uma referência oficial, mas está na
área de **leiautes antigos**; não prova sozinha a aceitação na API 1.01 atual.
O identificador da DPS vem do leiaute 1.01, não do exemplo antigo do manual.

O [Anexo I 1.01 de 09/02/2026](https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual/anexo_i-sefin_adn-dps_nfse-snnfse-v1-01-20260209.xlsx)
exige assinatura válida, certificado X.509 v3, CNPJ/CPF em OtherName,
assinatura digital, não repúdio, cadeia ICP-Brasil e conferência de revogação.
O código exige esses usos na folha A1 e usa OpenSSL para a cadeia e CRLs.
As provas locais usam PKI sintética, não um certificado ICP-Brasil real.

Matriz/filial: a seção 6.1.3 do manual antigo menciona a raiz do CNPJ para
assinatura de DPS e eventos; o Anexo II atual explicita CNPJ base para eventos.
Essa evidência foi preservada, mas a aceitação de A1 com inscrição diferente
da unidade ainda não foi implementada: o cadastro e a emissão exigem CNPJ
exato. Ampliar esse comportamento exige conferir o contrato de emissão atual
e as condições de acesso mTLS, além da assinatura do evento.

A homologação do proprietário deve registrar aceitação/rejeição da DPS e do
cancelamento na versão oficial em uso. Uma assinatura validada localmente
prova integridade criptográfica, não autorização pela administração tributária.
