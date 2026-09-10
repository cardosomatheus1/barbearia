# Fiscal próprio — cobertura e condições ainda abertas

Estado da implementação local em 10/09/2026. O requisito continua sendo cobertura
de todos os municípios do Brasil, sem intermediário fiscal. A entrega atual não
cumpre esse requisito integralmente. Esta lista separa código faltante de prova
externa; configurar um certificado não encerra as pendências de código.

| Capacidade | Estado do código | O que falta para encerrar |
|---|---|---|
| NFS-e Nacional para MEI | Fluxo direto implementado, incluindo DPS, assinatura, consulta, cancelamento e DANFSe | Validar os contratos/retornos no ambiente oficial e o perfil habilitado do CNPJ |
| Simples com ISS no DAS, sem retenção | Implementado com consulta do convênio municipal; recusa município sem emissor nacional | Homologar o perfil e confirmar a parametrização municipal/serviço na autoridade |
| Municípios com emissor próprio | Sem adaptadores municipais | Levantar contratos oficiais e suas versões, implementar famílias de protocolos e particularidades, credenciamento, respostas/consulta/cancelamento e comprovar cada cobertura declarada |
| Outros regimes e retenções | Não implementados no gerador de DPS nacional | Ampliar o modelo e o snapshot fiscal, regras de incidência/base/alíquota/retenção, totalizadores e formulários; exemplos fiscais oficiais e validação contábil |
| Salão-parceiro no emissor próprio | O domínio legado não constitui implementação fiscal nacional desse perfil | Definir emitentes e base fiscal, adaptar documentos/numeração/certificados e provar que receita da parte parceira não é tributada como receita própria indevida |
| IBS/CBS | Sem implementação específica nesse emissor | Confrontar leiaute e regras vigentes, competência e perfil aplicável; implementar os grupos e validar os totais sem inventar alíquotas |
| CNPJ alfanumérico e certificado de matriz/filial | Formato atual numérico e correspondência exata entre CNPJ da unidade e A1 | Atualizar validação/identificadores somente com contrato oficial compatível e regras de representação; exercitar cenários de matriz/filial |
| Confiança no A1 | Chave, certificado correspondente, CNPJ, validade e cadeia intermediária conferidos | Estabelecer raízes ICP-Brasil confiáveis e política de atualização/revogação/CRL, incluindo falha e indisponibilidade; montar cadeia não equivale a validá-la contra raiz confiável |
| Assinatura fiscal recebida | XSD, estrutura, chave e DPS comparados ao snapshot; transporte HTTPS validado | Verificar criptograficamente a assinatura da autoridade e sua cadeia confiável; certificado embutido na resposta não pode tornar-se raiz por si só |
| Algoritmo de assinatura | Gerador suporta SHA1/SHA256; operação nacional usa SHA1 explicitamente | Confirmar exigência normativa da versão oficial em uso e exercitar a aceitação no ambiente da autoridade |
| Documento de mercadorias e fiscal do SaaS | Não cobertos pelo emissor de serviços da barbearia | Definir documentos/emitentes e implementar os fluxos próprios quando aplicáveis; a NF-e/NFC-e do Raiz é referência para mercadorias, não NFS-e de serviços |

A identificação municipal atual está em `packages/finance/src/nfse/capacidade.ts`;
o perfil está em `dps.ts`, `documentos.ts` e `configuracao.ts`; a leitura da resposta
está em `respostas.ts`. A implantação usa XSD 1.01 obtido da publicação oficial de
09/02/2026. Não há uma lista comprovada de municípios atendidos por adaptadores
locais nesta versão.

A preparação da homologação ainda aguarda o município, regime e perfil do CNPJ
de testes solicitado ao proprietário. Certificado, senha e demais segredos devem
ser configurados fora do chat e do Git. A liberação Meta informada e os testes
locais de Stripe/Baileys não substituem essa validação fiscal.

Homologação deve preservar evidência de emissão/rejeição, consulta após timeout,
duplicidade, cancelamento aceito/recusado, conteúdo fiscal e entrega do documento.
Nenhuma emissão real ou autorização fiscal foi produzida por esta execução.
