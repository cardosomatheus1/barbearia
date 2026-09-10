# Fiscal próprio — cobertura e condições ainda abertas

Estado da implementação local em 10/09/2026. O proprietário limitou a cobertura municipal ao código reutilizável
existente: não é necessário desenvolver adaptadores para cidades sem suporte.
Retenção de ISS e salão-parceiro foram adiados expressamente pelo proprietário para a próxima entrega em 10/09/2026. A integração reutilizada ainda está em validação. Esta lista separa código faltante de prova
externa; configurar um certificado não encerra as pendências de código.

| Capacidade | Estado do código | O que falta para encerrar |
|---|---|---|
| NFS-e Nacional para MEI | Fluxo direto implementado, incluindo DPS, assinatura, consulta, cancelamento e DANFSe | Validar os contratos/retornos no ambiente oficial e o perfil habilitado do CNPJ |
| Simples com ISS no DAS, sem retenção | Implementado com consulta do convênio municipal; recusa município sem emissor nacional | Homologar o perfil e confirmar a parametrização municipal/serviço na autoridade |
| Municípios com emissor próprio | Fonte OpenAC.Net.NFSe MIT incorporada, motor C#, backend/API/tela escritos | Concluir validação dirigida, Docker, navegador e regressão. Não criar adaptadores ausentes; informar limites. Ver docs/fiscal-municipal.md |
| Não optante pelo Simples, sem retenção | Cadastro, migração 0128, percentuais aproximados obrigatórios, snapshot e DPS com opSimpNac=1 implementados localmente; testes dirigidos de domínio, XML, PostgreSQL/RLS, API e navegador aprovados | Regressão integral após estabilizar as entregas; homologar o contrato e homologar também o perfil IBS/CBS presencial implementado. Não equivale a motor de apuração de Lucro Real/Presumido |
| Simples com ISS municipal (`regApTribSN=2`) | Cadastro, migração 0133, estimativas obrigatórias e snapshot/DPS implementados; unitários e 22 cenários nacionais de banco aprovados | API e navegador aprovados; homologar o enquadramento e a parametrização municipal. Ver docs/fiscal-simples-iss-municipal.md |
| ME/EPP com federais e ISS fora do DAS (`regApTribSN=3`) | Migração 0135, cadastro, DPS e snapshot implementados; XML, 23 cenários de banco, API e navegador aprovados | Regressão final e homologação do enquadramento; não inclui motor de apuração federal |
| Demais regimes, benefícios e situações especiais | Retenções, benefícios e situações especiais não implementados no gerador nacional | Ampliar modelo/snapshot por operação, incidência/base/alíquota/retenção, totalizadores e formulários; exemplos fiscais oficiais e validação contábil |
| Retenção de ISS | Não implementada nesta entrega | Próxima entrega, por decisão expressa do proprietário em 10/09/2026; requer identificação do responsável e regras municipais |
| Salão-parceiro no emissor próprio (próxima entrega por decisão do proprietário) | O domínio legado não constitui implementação fiscal nacional desse perfil | Definir emitentes e base fiscal, adaptar documentos/numeração/certificados e provar que receita da parte parceira não é tributada como receita própria indevida |
| IBS/CBS | Perfil normal presencial implementado localmente: cadastro explícito, NBS/classificação, CPF do tomador, snapshot/DPS, conferência dos totais assinados e proteção do pagamento sem CPF; detalhes em docs/fiscal-ibscbs.md | API e navegador aprovados; falta regressão final e ampliar demais perfis, acompanhar NT009 e homologar externamente |
| CNPJ alfanumérico | Implementado no cadastro, tomador, A1, DPS/chaves, consulta, evento e DANFSe; migração 0130, contratos, banco/RLS, API e navegador aprovados | Regressão integral final e homologação do contrato de julho/2026, cuja adaptação pontual do XSD está documentada em docs/fiscal-cnpj-alfanumerico.md |
| Certificado de matriz/filial | Correspondência exata entre CNPJ da unidade e A1 mantida | Confirmar regra oficial de representação antes de aceitar certificado com inscrição diferente; a igualdade de raiz não foi presumida |
| Confiança no A1 | Validação OpenSSL contra raízes independentes, restrições de cadeia e CRLs de todos os níveis no cadastro, prontidão e uso; falha fechada | Atualização automática por manifesto/pins, cadeia/CRLs e publicação atômica implementada e testada localmente; configurar fontes oficiais conferidas e ativar/monitorar o atualizador. Testes locais usam PKI sintética, sem comprovar instalação ICP-Brasil real |
| Assinatura fiscal recebida | Assinatura XML externa verificada com certificado público autorizado independentemente; referências/IDs protegidos e leitura do fragmento assinado. XSD, chave e DPS comparados ao snapshot | Cadeia e CRLs dos assinantes conferidas antes de aceitar resposta; prova cifrada e imutável permite reprodução posterior, com testes locais aprovados. Configurar/renovar catálogo oficial. O registro interno não é carimbo do tempo nem arquivo independente de longo prazo; ver docs/fiscal-resposta-arquivada.md |
| Algoritmo de assinatura | Gerador suporta SHA1/SHA256; operação nacional usa SHA1 explicitamente | Referência histórica oficial localizada (Manual Integrado 1.00.02, pp.25–26); confirmar vigência/aceite na API 1.01 atual. Ver docs/fiscal-assinatura-referencias.md |
| Documento de mercadorias e fiscal do SaaS | Não cobertos pelo emissor de serviços da barbearia | Definir documentos/emitentes e implementar os fluxos próprios quando aplicáveis; a NF-e/NFC-e do Raiz é referência para mercadorias, não NFS-e de serviços |

A identificação municipal atual está em `packages/finance/src/nfse/capacidade.ts`;
o perfil está em `dps.ts`, `documentos.ts` e `configuracao.ts`; a leitura da resposta
está em `respostas.ts`. A implementação atual usa XSD 1.01 obtido da publicação oficial de
27/07/2026, com a adaptação em memória documentada no README do bundle. O catálogo municipal reutilizado fica em packages/finance/assets/nfse-municipal/municipios.json; elegibilidade estática não comprova homologação.

A homologação externa será conduzida pelo proprietário, conforme orientação
vigente. Ela deve usar município, regime e perfil de CNPJ definidos por ele.
Certificado, senha e demais segredos devem ser configurados fora do chat e do Git.
A liberação Meta informada e os testes locais de Stripe/Baileys não substituem
essa validação fiscal. Detalhes da confiança em `docs/fiscal-confianca.md`.

Homologação deve preservar evidência de emissão/rejeição, consulta após timeout,
duplicidade, cancelamento aceito/recusado, conteúdo fiscal e entrega do documento.
Nenhuma emissão real ou autorização fiscal foi produzida por esta execução.

A consulta oficial desta continuação identificou a desativação da API DANFSe v1 em 03/08/2026. O transporte antigo foi removido: agora há geração local do DANFSe a partir do XML assinado, seguindo NT008 v1.02. Conteúdo, página única, QR/link, marca de cancelamento e persistência cifrada tiveram provas locais. Configurar as fontes licenciadas exigidas na implantação; a prova visual local usou fontes substitutas declaradas. Ver docs/fiscal-danfse.md. A regeneração usa o registro cifrado da verificação, quando presente; documentos anteriores exigem nova verificação atual. Limites em docs/fiscal-resposta-arquivada.md.
