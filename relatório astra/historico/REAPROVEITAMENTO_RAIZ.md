# Verificação de reaproveitamento do ERP Raiz

Verificado em 2026-09-09. Referência: `cardosomatheus1/erp-saas`, `master`
`ebc59f0d60fc353733513309acca551ba5b3b165`, obtida do GitHub em clone isolado.
A cópia de trabalho do ERP estava em `d1568e32`; os 132 arquivos examinados
nos módulos fiscal/assinaturas e pacotes sefaz-client/tax-engine são idênticos
à versão remota (comparação de conteúdo SHA256). O ERP não foi alterado.

## Parecer

Recomendo reaproveitamento seletivo. O Raiz já contém uma base própria de
NF-e/NFC-e com comunicação direta com a SEFAZ. Ela reduz trabalho em
certificados, XML e operação fiscal. **Não contém um emissor de NFS-e** que
possa ser copiado para cobrir os serviços das barbearias.

A presença de `NFSE` no enum `TipoNotaFiscal` não implementa emissão. A busca
nos módulos fiscais atuais encontrou esse enum e a recusa explícita de vendas
só de serviços em `nfe-snapshot.service.ts:310`, com teste correspondente.
Não há cliente DPS/NFS-e Nacional nem adaptadores municipais nesse módulo.

## O que aproveitar

| Componente no Raiz | Uso na barbearia | Adaptação necessária |
|---|---|---|
| `packages/sefaz-client/src/cert/certificate-reader.ts` | Leitura de certificado A1 | Fortalecer seleção do certificado correspondente à chave, validade completa e identificação ICP-Brasil; testar certificados sintéticos com cadeia |
| `packages/sefaz-client/src/xml/xml-signer.ts` | Estrutura de assinatura XMLDSig | Parâmetros, nó assinado e esquema devem seguir o documento fiscal específico. A assinatura atual é normativa para NF-e e não comprova NFS-e |
| `packages/sefaz-client/src/xml/xml-security.ts` | Recusa de DTD/entidades em XML recebido | Reaproveitar com limites de tamanho antes e depois de descompressão |
| `packages/sefaz-client/src/soap/soap-client.ts` | Autenticação mTLS e tratamento de indisponibilidade | SOAP é específico da SEFAZ; NFS-e nacional precisa do seu transporte. Revisar limites de resposta/descompressão antes de portar |
| `modules/fiscal/providers/sefaz-direct.adapter.ts` | NF-e/NFC-e de mercadorias | Adaptar o contrato, dados de produtos e persistência; não usar NF-e para cortes/barba |
| Numeração, snapshot, filas, consulta e cancelamento | Referência para o ciclo fiscal | Preservar o modelo de fila e RLS da barbearia; não importar schemas por tenant/BullMQ do ERP em bloco |
| `packages/tax-engine` | Tributos de mercadorias | Não fornece as regras municipais de ISS/NFS-e. Alíquotas/tabelas não são uma certificação nacional |
| `modules/subscription` | Checkout hospedado, portal e eventos Stripe do SaaS | Integrar à assinatura já existente, evitando duas réguas que cobrem a mesma mensalidade |

## Limites encontrados

- O mapa das 27 UFs é de autorizadores de NF-e/NFC-e. Não representa cobertura
  dos municípios para NFS-e.
- A skill fiscal descreve a assinatura como SHA-256, mas o código atual usa
  RSA-SHA1/C14N conforme o contrato documentado da NF-e. A implementação e o
  esquema têm de ser conferidos; a descrição histórica não serve de prova.
- `validateNfeXml` declara que não faz validação XSD completa. Os testes com
  "xsd" no nome verificam casos específicos; não substituem validação contra
  os schemas oficiais e homologação.
- O checkout Stripe do ERP verifica a reserva sob lock, chama a Stripe fora
  da transação e grava a reserva depois. Essa estrutura precisa de revisão de
  concorrência antes do reaproveitamento: duas chamadas podem passar pela
  primeira verificação antes de existir a reserva. Não copiar o fluxo sem
  garantir idempotência e reserva persistida antes do efeito externo.
- Código testado localmente não comprova autorização de CNPJ, certificado,
  credenciamento municipal, endpoint ou emissão real.

## Testes executados nesta verificação

Rodados sobre os fontes locais comprovadamente idênticos aos remotos, com as
dependências de desenvolvimento já instaladas. Sem setup/seed de ERP, acesso a
produção, emissão fiscal, cobrança real ou mensagens externas.

| Comando (relativo a `backend/erp-saas`) | Resultado |
|---|---|
| `cd packages/sefaz-client && ../../node_modules/.bin/vitest run --maxWorkers=1 --minWorkers=1` | 12 arquivos, 170 testes passaram |
| `cd packages/tax-engine && ../../node_modules/.bin/vitest run --maxWorkers=1 --minWorkers=1` | 9 arquivos, 101 testes passaram |
| `cd apps/api && ../../node_modules/.bin/jest --runInBand --config jest.config.ts src/modules/fiscal src/modules/subscription` | 36 suítes, 522 testes passaram |

Total: **793 testes**, todos aprovados. São testes locais dos módulos
selecionados, com mocks nos testes de serviços; não a regressão completa do
ERP nem homologação de SEFAZ/Stripe. Comandos, duração, saída e exit code em
`EVIDENCIAS_CORRECOES_PRE_GO_LIVE/raiz-{sefaz-tests,tax-tests,fiscal-billing-tests}.{json,log}`.

## Direção da implementação

Stripe exclusiva da assinatura SaaS. Fiscal próprio com contrato separado para
NFS-e de serviços e NF-e/NFC-e de produtos. Adaptar as partes comuns revisadas
do Raiz e implementar o que falta para NFS-e; não instalar intermediário fiscal.
A abrangência nacional permanece requisito pendente de implementação e prova.
