# Relatório Astra — auditoria, correções e implementações da barbearia

Data de consolidação: 10/09/2026, UTC. Repositório de produto: `cardosomatheus1/barbearia`.

Este documento reúne a sessão desde o pedido de auditoria pré-go-live até a publicação do código e a preparação deste relatório. As informações vêm dos pedidos do proprietário, do código, do histórico Git e dos registros locais de execução. Os documentos históricos completos ficam em `historico/`; o inventário de arquivos e o registro de execuções complementam este texto.

## 1. Resultado ao encerrar o trabalho de código

O código foi publicado em `main`, no commit **`535a190be8e4430e2530870abfafe00144bd4ab1`**, e a referência remota foi conferida após o push. A `main` foi criada por esse envio, conforme o pedido final. A primeira entrega da sessão já estava em `master`, no commit `75a41587d28e25c27125acf498bf0f1138ea80d1`.

O proprietário pediu expressamente a interrupção dos testes e a publicação imediata. Por isso, esta entrega **não tem aprovação integral da regressão sobre a fonte final**. A última regressão completa executada, v15, encontrou uma única falha estática; ela foi corrigida e os testes dirigidos passaram. A repetição v16 foi interrompida antes de terminar, e seus ensaios complementares não começaram.

Estão implementados, dentro dos perfis documentados: as correções gerais da auditoria, Stripe exclusivo das assinaturas do SaaS, Meta, Baileys, fila manual, consentimento de WhatsApp, reorganização das telas e emissores próprios de NFS-e nacional e municipal com reaproveitamento de adaptadores. Isso não significa cobertura fiscal universal nem homologação externa.

Retenção de ISS e salão-parceiro foram adiados pelo proprietário. Municípios sem adaptador reutilizável não foram desenvolvidos do zero. Nenhum deploy, migração em produção, mensagem real, cobrança real ou emissão fiscal real foi feito nesta sessão.

## 2. Como o escopo foi definido e alterado

1. O pedido começou com acesso ao repositório e um plano de auditoria geral pré-go-live. O lançamento pretendido incluía pagamentos, WhatsApp e fiscal. O proprietário informou que o fiscal ainda não existia, o pagamento precisava de configuração e já possuía liberação da Meta.
2. O proprietário autorizou executar a auditoria e resolver os problemas encontrados, inicialmente mencionando todos os municípios brasileiros e Stripe.
3. Em seguida, esclareceu que queria integração fiscal própria, sem provedor intermediário, e ofereceu o ERP Raiz como referência.
4. Stripe foi delimitado às assinaturas do SaaS. Posteriormente, pagamentos online das próprias barbearias foram explicitamente retirados desta entrega.
5. Foi solicitado reaproveitar também a integração Baileys, inclusive campanhas, automações e frontend, com planejamento das diferenças em relação à Meta.
6. Foi autorizada publicação em `master`, inclusive uma primeira publicação antes do restante do fiscal. O proprietário corrigiu o contexto do repositório e informou ter organizado o ambiente GitHub. O produto trabalhado e publicado foi a barbearia; o ERP permaneceu referência.
7. O proprietário pediu avaliação do fluxo como usuário real, seguida dos ajustes necessários para deixá-lo claro.
8. Foi acrescentada uma alternativa manual: preparar mensagens, abrir o WhatsApp do operador e exigir que ele confirme o envio no sistema. A possibilidade de inferir envio por Baileys foi discutida, mas o proprietário escolheu confirmação totalmente manual.
9. Foi pedido aceite de WhatsApp no cadastro do cliente, com identificação da barbearia.
10. A concorrência foi limitada a um auxiliar. Houve pedido de parada e reunião das informações dele; depois foi permitida participação de um auxiliar na verificação. A transferência e a última revisão estão documentadas.
11. Para o fiscal municipal, o proprietário preferiu aproveitar soluções existentes no GitHub e dispensou criar adaptadores para cidades sem código reaproveitável.
12. Retenção de ISS e salão-parceiro foram deixados para uma próxima entrega.
13. A orientação final de UX foi explícita: Meta oficial e recomendada, com custos e passo a passo; Baileys gratuito, não oficial e sujeito a banimento; manual sem envio automático.
14. O pedido de aguardar todos os testes foi substituído, ao final, por uma ordem expressa de interromper e fazer commit/push imediatamente para `main`. Essa foi a condição da publicação `535a190`.
15. Depois, foi solicitada a pasta `relatório astra`, com relato completo em Markdown, outro commit/push para `main` e envio ao bucket. O destino do bucket foi solicitado separadamente; não foi presumido a partir das configurações de mídia do produto. A orientação seguinte foi concluir relatório, commit/push e parar.

## 3. Repositórios, ambiente e rastreabilidade

O ponto de partida auditado da barbearia foi `3d90fc62de2947fda05aed32407d5a2f2852340b`. O checkout de produto usado no trabalho foi `barbearia-pre-go-live-20260909`. O remoto foi conferido como `git@github.com:cardosomatheus1/barbearia.git` antes da publicação.

O ERP Raiz foi examinado em referência isolada. A referência remota registrada foi `ebc59f0d60fc353733513309acca551ba5b3b165`. Na comparação daquela etapa, 132 arquivos dos módulos relevantes tinham conteúdo idêntico ao checkout local utilizado como referência. Não se atribuem as mudanças da barbearia ao ERP.

O ambiente inicial registrado usou Linux, Node 22.23.2, pnpm 10.33.0, PostgreSQL 16.15 e Chromium 141.0.7390.37. A integração municipal acrescentou .NET 10. As bases de testes eram locais e descartáveis, com aplicação usando role restrito e RLS. Configuração privada, dumps, certificados sintéticos privados, estado de autenticação e logs brutos ficaram fora do conjunto publicado.

O primeiro verify com concorrência ampla saturou o ambiente. As execuções controladas preservaram os comandos do portão e limitaram a concorrência a duas etapas, com um worker Vitest. Houve quedas do PostgreSQL iniciado como processo de sessão; posteriormente ele foi iniciado com `pg_ctl` como serviço independente. Docker rootless também foi preparado para os ensaios locais. Essas ocorrências de infraestrutura não foram apresentadas como falhas de produção do software.

## 4. Auditoria inicial e os 14 achados

O inventário inicial cobria 371 rotas, das quais 207 eram de escrita. A varredura sem autenticação exercitou 345 rotas protegidas, incluindo 194 escritas, com resposta 401. As 26 rotas públicas receberam entradas mínimas: 16 respostas 400, sete 404 e três 200 legítimas, sem 500 nessa amostra. Isso demonstrou a fronteira anônima; não foi tratado como prova de autorização de todos os usuários autenticados.

| Achado | Problema constatado | Tratamento nesta sessão |
|---|---|---|
| AUD-01 — cartão sem conclusão | Criar uma intenção de pagamento não oferecia ao usuário um caminho completo de captura/confirmação | O escopo final ficou no SaaS: cadastro hospedado, reserva antes da rede, cobrança, autenticação adicional e conciliação. Checkout online de comanda foi retirado do escopo pelo proprietário |
| AUD-02 — fiscal real ausente | A seleção de emissor aceitava somente `nenhum` e `fake` | Foram implementados emissor nacional próprio e integração municipal direta, com backend, worker, API e tela |
| AUD-03 — split e clube simulados | O worker instanciava fakes independentemente da escolha Stripe | Os modos de pagamentos das lojas foram separados do SaaS; integração ausente passou a falhar explicitamente. Não foi inventada aprovação, repasse ou tokenização real |
| AUD-04 — adoção falsa de migrações | Banco incompleto podia receber um journal de baseline que não correspondia ao schema | Migrador com trava, checksums, registro de interrupção e adoção explícita comparada a referência reconstruída |
| AUD-05 — restore sem grants | O ensaio aprovava um banco que a aplicação não conseguia consultar | Preservação/conferência de ACL, login real restrito, grants e isolamento entre tenants no restore |
| AUD-06 — gate de deploy permissivo | Checks incompletos/pulados podiam satisfazer o gate; branch podia avançar entre verificação e aplicação | Jobs/workflow exigidos com sucesso, consulta por SHA, paginação/reexecução e aplicação do SHA conferido; ajuste da instalação do cron |
| AUD-07 — homepage como prontidão | HTTP 200 da página não provava API, banco ou worker operacionais | Sondas de API/banco/RLS, versão, progresso do worker e leitura de domínio; resposta 503 em degradação |
| AUD-08 — dependências vulneráveis | O lockfile tinha vulnerabilidades conhecidas | Atualização de Next, Nest, Vitest e transitivas, builds e novas varreduras; o último `pnpm audit` registrado antes da publicação não encontrou vulnerabilidades conhecidas |
| AUD-09 — excesso de segredos | Web/API/worker recebiam ambiente administrativo e credenciais desnecessárias | Separação de ambientes de validação, migração, API, worker, web, proxy e backup |
| AUD-10 — rate limit compartilhado no SSR | Visitantes diferentes consumiam a cota do servidor web | Encaminhamento autenticado de IP pelo proxy, rejeição de headers forjados e preservação da autorização no encaminhamento de Request |
| AUD-11 — testes presos ao relógio real | Fixtures antigas e `now()` divergiam, e o backup herdava uma chave externa ao teste | Relógios explícitos, propagação do instante para holds e fixtures, isolamento do ambiente dos subprocessos de backup |
| AUD-12 — versão restaurada mal conferida | Schema antigo podia ser aceito; SQL equivalente podia ser rejeitado por comparação textual | Journal/checksum/schema completo, normalização pelo PostgreSQL e assinatura de conteúdo para migrações que alteram dados |
| AUD-13 — scanner histórico com falso positivo | O scanner perdia o caminho no diff e tratava fixtures de maneira diferente | Preservação de arquivo/commit, mesmas regras de fixture e manutenção da detecção de credenciais reais |
| AUD-14 — conciliação WhatsApp só na matriz | A varredura ignorava unidades com seus próprios números/contas | Conciliação por unidade sob RLS, continuidade após erro de uma unidade e sinalização de retry |

O baseline original não foi considerado verde: houve falhas em backup shell, agendamento, financeiro e CRM. Os retestes distinguiram defeito de produto, fixture e limitação do ensaio. Por exemplo, a recusa GCM com chave errada era correta; o teste é que herdava outra chave do ambiente.

## 5. Outras correções encontradas durante a execução

### Banco, recuperação e operação

- Adoção de baseline passou a exigir schema compatível, sem marcar migrações inexistentes como aplicadas.
- Falha SQL real passou a ser exercitada junto de rollback do DDL, divergência de checksum e retomada de execução interrompida.
- O ensaio de rollback passou a comparar conteúdo, além de estrutura: uma migração somente de dados também precisa ser revertida.
- O cálculo da assinatura dos dados usa snapshot consistente e não imprime as linhas. Reordenação física não muda o resultado; alteração de conteúdo mantendo a contagem muda.
- Restore e rollback passaram a conferir o papel real da aplicação e a separação entre duas barbearias, não somente uma conexão administrativa.
- A preparação/instalação, atualização e recuperação receberam verificações de prontidão mais próximas da operação real.

### Segurança e logs

- Foram reproduzidos tokens de links fiscais, fila e oferta em URIs, Referer, redirecionamentos e logs de erro.
- A API passou a registrar o padrão de rota do framework, preservando o status HTTP, em vez do caminho com credenciais.
- O Caddy passou a omitir URIs e cabeçalhos sensíveis de pedido/resposta nos logs pertinentes, incluindo falhas de upstream.
- As provas incluíram URL codificada, query de webhook, redirecionamento e erro 502. Método/status continuaram disponíveis.
- O encaminhamento de IP foi conferido com Caddy, Next e API reais: visitantes diferentes mantiveram cotas próprias, e forjar cabeçalho não reiniciou a cota.
- O patch da libsignal remove a impressão de objetos privados de sessão e stacks daquele caminho de log, preservando as transições da sessão.
- A anonimização passou a alcançar estados queued/sending/uncertain/sent da outbox Baileys; recibos atrasados não podem restaurar conteúdo pessoal apagado.

### Domínio, fila e frontend

- O convite de vaga passou a recuperar a mesma oferta e o mesmo token cifrado após falha, em vez de perder a possibilidade de entrega.
- Encerramento remove a cifra do convite; vencimento avança a fila na mesma transação e respeita silêncio/recurso habilitado.
- A retomada não oferece vaga de profissional desativado ou horário já iniciado nos casos exercitados.
- Corrigida consulta de agendamento que usava um estado `cancelled` inexistente no enum daquele domínio.
- A constraint de automação passou a aceitar aniversário no próprio dia e assinatura vencendo no dia, conforme core/API/tela; zero continuou inválido para os demais gatilhos.
- Rateio de desconto usa BigInt para preservar a ordem correta do maior resto.
- A seleção de canal WhatsApp deixou de ser desfeita por refresh atrasado do estado no React.
- IDs repetidos de campos do catálogo foram individualizados para que labels apontem ao formulário correto.
- Estados de recusa de campanhas e automações receberam H1.
- A lista de faturas foi reorganizada para que valor e confirmação não fiquem cortados no celular.
- O conferidor financeiro deixou de duplicar consumo de pacote já reconhecido na comanda. O cálculo financeiro do produto não foi alterado para acomodar o conferidor.
- O upsert da demonstração passou a atualizar os indicadores derivados de avaliações da vitrine; os testes de leitura usam o perfil autorizado, e verificam a recusa do gerente separadamente.

## 6. Reaproveitamento do ERP Raiz

O Raiz tinha uma base própria de NF-e/NFC-e, comunicação com a SEFAZ, certificados, assinatura XML, transporte, numeração e operação fiscal. Não tinha um emissor NFS-e pronto para copiar. Um enum com `NFSE` e um mapa de autorizadores por UF não representam cobertura de NFS-e municipal.

Foram úteis como referência a leitura de A1, seleção de chave/certificado, XMLDSig, recusa de DTD/entidades, mTLS, limites de resposta, snapshots, consulta e recuperação. Essas peças exigiram adaptação aos contratos NFS-e e ao modelo de RLS/filas da barbearia. Não foram importados em bloco os schemas por tenant ou a infraestrutura de filas do ERP.

A verificação da referência executou 170 testes de sefaz-client, 101 de tax-engine e 522 de fiscal/assinaturas: **793 aprovados**. Eram suítes selecionadas do ERP, com mocks nos testes de serviços; não a regressão integral do ERP nem homologação SEFAZ/Stripe.

O fluxo Stripe do ERP também serviu de referência, mas a janela entre verificar e persistir a reserva foi tratada no produto para evitar duas cobranças concorrentes. Código existente foi revisado antes de reaproveitar o desenho.

## 7. Stripe: assinatura do SaaS

O papel final da Stripe é receber as mensalidades da plataforma. Não foi implementado Stripe Connect ou checkout online por barbearia nesta entrega.

- Cadastro hospedado de cartão em Checkout `mode=setup`, com consentimento versionado e integração à régua de assinatura existente.
- Reserva persistida antes da chamada externa, protegendo contra baixa/cancelamento concorrentes.
- Preservação de tentativa, valor, cartão e identificação da cobrança após timeout.
- Recuperação de tentativa antiga por metadata; uma busca vazia depois da janela de idempotência não autoriza criar outro débito.
- Posse vencida não permite aplicar resposta de worker antigo. Falha em uma conta não impede processar a seguinte.
- Varredura por cursor para alcançar além das primeiras 500 faturas; houve prova com 501.
- Autenticação adicional/3DS confirma o mesmo PaymentIntent, com conferência de tenant, fatura, customer, valor, moeda, cartão e ambiente.
- O navegador não quita a fatura. Webhook e consulta do estado atual resolvem o resultado e eventos fora de ordem.
- Recusa definitiva exige cancelamento do PaymentIntent anterior antes de liberar uma nova tentativa, evitando confirmação posterior por aba antiga.
- Segredo de confirmação apenas em resposta autenticada e `no-store`; carregamento do SDK e CSP restritos ao fluxo de plano.
- Tela de cobrança responsiva, com valor e ação de confirmação visíveis.

As provas locais usaram HTTP/SDK sintéticos. Chaves, configuração, autenticação bancária e eventos reais ficam para homologação pelo proprietário.

## 8. Meta: integração oficial e recomendada

Foi preservada e corrigida a integração oficial, com conciliação por unidade e ligação a textos, campanhas, automações e avisos. A liberação da Meta foi informada pelo proprietário; não foi interpretada como prova de número, webhook ou templates operacionais.

A interface final compara os três modos e recomenda a Meta, explicando custos variáveis e oferecendo referência oficial de preços. O cadastro é apresentado em quatro passos. A tela orienta o uso de número dedicado quando necessário e o cenário de coexistência, sem afirmar que o retorno do cadastro significa conexão concluída.

A consulta de uma opção, por `modo=meta|baileys`, não muda a conexão. A ativação ocorre em botão explícito. O passo a passo pode ser lido antes de trocar o modo. Credenciais de integração pronta ficam em configuração avançada recolhida; quando o cadastro integrado não está disponível, existe orientação ao suporte.

O editor mostra variáveis e botões compatíveis com o aviso escolhido, acompanha o texto na prévia e limpa escolhas incompatíveis quando o tipo muda. Foi corrigido um defeito real: omitir a lista de botões vazia fazia o domínio aplicar padrões invisíveis. A ação agora envia `botoes: []` quando nada foi marcado.

Campanhas e automações identificam a conexão usada e o envio automático. A UI distingue mensagem aceita pela Meta, entregue e lida; aceitação não é apresentada como entrega confirmada. A submissão de texto segue a fila, sem prometer aprovação externa.

O cadastro no site externo da Meta não foi percorrido nesta auditoria. Os ensaios avaliaram as instruções locais; a repetição adicional final de coexistência não chegou a executar antes da parada solicitada.

## 9. Baileys: alternativa por QR

A alternativa Baileys foi integrada ao backend, worker, API e frontend, com textos locais próprios, sem exigir aprovação de template da Meta. A versão registrada na implementação foi Baileys 6.7.24, com patch versionado de libsignal 6.0.0.

- Conexão por unidade, QR, expiração, reconexão, desligamento e retorno à Meta.
- Sessão/chaves cifradas e posse exclusiva por lease, com renovação, perda de posse e parada controladas.
- Outbox cifrada persistida antes da rede, identidade de mensagem ligada à intenção de negócio e tratamento de ACK.
- Resultado incerto não vira entrega confirmada nem autoriza reenvio indiscriminado.
- Confirmação tardia concilia a origem preservando o histórico append-only; ligação pela notificação anterior evita apagar o resultado original.
- Tratamento de identificadores PN/LID e mensagens citadas nos cenários exercitados.
- Descoberta de unidades por cursor, alcançando além da primeira página.
- Campanhas, automações e avisos de agendamento, vaga, recado, clube e fiscal ligados ao roteamento por unidade.
- Cota promocional compartilhada, consentimento e opt-out conferidos no despacho; recebimento de PARAR exercitado.
- Retenção e anonimização de dados da sessão/outbox, inclusive com recibos tardios.
- O worker libera/encerra recursos também no caminho excepcional.

A tela informa que Baileys é gratuito como alternativa de integração, não oficial e sujeito a bloqueio/banimento; isso não elimina custos de hospedar o sistema. Não foi feita promessa de equivalência de confiabilidade com a API oficial.

Foram percorridos os fluxos no navegador e houve prova anterior com o `main` completo do worker, fábrica/auth reais e socket sintético. Não houve pareamento ou mensagem para um número real.

## 10. WhatsApp manual

O modo manual prepara a fila e abre a conversa com destinatário e mensagem preenchidos. Quem opera envia no WhatsApp e volta para marcar que enviou. Abrir a conversa não registra confirmação de envio; `sent_at` permanece vazio até a confirmação explícita.

A área tem **Fila, Campanhas e Lembretes**. O cadastro do texto vem antes da escolha de público/regra. Lembretes e campanhas podem preparar itens, mas não disparam mensagens automaticamente por esse modo.

O fluxo contempla fila persistente, reserva por operador, retomada, abertura da conversa, confirmação, liberação/descarte, pausa/retomada, histórico, controle de unidade, permissões, opt-out e limites. Os payloads pessoais são protegidos e tratados na conclusão/retenção. A origem da mensagem e as regras de criação são validadas no servidor.

Entrar no manual não desliga campanhas ou automações já ativas pelos outros modos. A tela passou a dizer isso claramente para evitar a falsa impressão de que acessar a fila manual pausa os envios automáticos existentes.

A alternativa não usa Baileys para inferir se o operador apertou enviar. Essa foi uma escolha expressa do proprietário. Não se prometeu risco zero de bloqueio no WhatsApp.

## 11. Consentimento no cadastro

Foi incluído aceite opcional, identificando a barbearia, para receber confirmações, lembretes e novidades pelo WhatsApp. A intenção apresentada no cadastro não equivale, sozinha, a consentimento definitivo de outra pessoa.

O fluxo confirma o aceite com o cliente autenticado, mantém trilha e versão do texto, possui expiração, valida vínculo/origem e evita reativar uma autorização revogada por repetição de um link ou intenção antiga. Houve cenários de replay, fallback, confirmação repetida, opt-out e ausência de vínculo indevido.

As provas negativas reproduziram falhas antes da correção. As provas posteriores da API e navegador verificaram persistência e integridade; a documentação preserva a diferença entre cadastros, intenções e consentimentos efetivamente confirmados.

## 12. Emissor próprio de NFS-e nacional

Foi implementado o caminho direto, sem intermediário fiscal: configuração por unidade/ambiente, A1, DPS, XMLDSig, validação XSD, numeração, snapshot da operação, fila, transporte mTLS, consulta, cancelamento, arquivamento e disponibilização de XML/DANFSe.

O documento e o pedido são congelados e protegidos antes da transmissão. Erro incerto exige consulta/recuperação; não é convertido em autorização para reenviar indiscriminadamente. O resultado é comparado aos identificadores e ao snapshot da operação.

O transporte local foi exercitado com servidor TLS real e PKI sintética, incluindo intermediária obrigatória, prazo total, servidor não confiável, redirect, resposta inválida/excedente e interrupção da conexão. A senha do PFX pode conter espaços e não é alterada silenciosamente.

### Confiança e documentos recebidos

- A1 associado à chave correta, validade, uso de chave e correspondência exata ao CNPJ da unidade.
- Cadeia de confiança verificada contra raízes independentes e CRLs em cadastro, prontidão e uso, com falha fechada.
- Atualização de confiança por manifesto/pins e publicação atômica, com configuração e monitoramento a fazer no destino.
- Assinatura do XML recebido verificada com assinante autorizado de forma independente.
- Proteção de IDs/referências e leitura do fragmento efetivamente assinado, reduzindo riscos de aceitar dados de uma parte não autenticada do XML.
- Comparação de chave, DPS e dados da operação, com prova de verificação cifrada e imutável para reprodução posterior.
- Recusa de DTD/entidades, limites de tamanho e proteção da leitura/descompressão.

O registro interno de verificação não é carimbo de tempo nem arquivamento independente de longo prazo. As fontes oficiais de confiança/CRL precisam ser configuradas e renovadas no ambiente de destino.

### Perfis implementados e contrato

Foram acrescentados MEI, Simples com ISS no DAS sem retenção, não optante com informações tributárias aproximadas, Simples com ISS municipal (`regApTribSN=2`) e ME/EPP com federais e ISS fora do DAS (`regApTribSN=3`), nos limites documentados. Isso não cria um motor completo de apuração de Lucro Real/Presumido ou de tributos federais.

O perfil normal presencial de IBS/CBS tem cadastro explícito, NBS/classificação, CPF do tomador, snapshot/DPS e comparação de totais assinados. Quando faltam dados fiscais necessários, a operação de recebimento não é tratada como se já houvesse uma nota válida.

CNPJ alfanumérico foi tratado em cadastro, tomador, A1, identificadores, DPS/chaves, consulta, evento e DANFSe. O bundle XSD oficial 1.01 de 27/07/2026 e a adaptação pontual documentada foram preservados com origem e hashes. O uso nacional de SHA1 foi documentado com a referência oficial histórica encontrada; vigência/aceite do contrato atual continua sujeito à homologação.

Não se presumiu que certificado da matriz pode representar qualquer filial somente porque a raiz do CNPJ coincide. A exigência atual é correspondência ao CNPJ integral da unidade.

## 13. DANFSe local e entrega do documento

A pesquisa oficial identificou desativação da antiga API DANFSe v1 em 03/08/2026. O transporte antigo foi removido e substituído por geração local a partir do XML assinado, conforme a referência NT008 v1.02 documentada.

Foram tratados conteúdo, página única, QR/link, identificação de cancelamento, fontes e persistência cifrada. As provas visuais locais usaram substitutas declaradas quando necessário; a implantação precisa das fontes licenciadas especificadas.

A regeneração usa o registro cifrado da verificação quando disponível. Documentos anteriores exigem nova verificação pelas regras documentadas. A representação municipal é auxiliar, preservando o XML original e sinalizando cancelamento.

O link público de entrega fiscal é gerado na tentativa de entrega, evitando que expire enquanto espera o canal. O carimbo de entrega depende da confirmação; falha conhecida permite retry, enquanto dúvida preserva a intenção para conciliação. Os avisos fiscais passaram a usar o roteamento real dos canais em vez de permanecer no provedor de console.

## 14. NFS-e municipal e código aberto reaproveitado

Após o pedido de não reinventar adaptadores, foram pesquisadas bibliotecas existentes. A revisão examinou transporte, configuração global, persistência de certificados/XML, validação TLS, isolamento entre emitentes e licenças. O relatório das bibliotecas preserva os riscos encontrados e as medidas necessárias; não se presumiu segurança só por o projeto já existir.

A solução incorporada foi **OpenAC.Net.NFSe**, licença MIT, fixada no SHA `1b09acef0ac4541ed4bab8daf97f804ad8951e3d`. São 659 arquivos originais com hashes/origem preservados e seis adaptações de infraestrutura registradas. O código foi incorporado ao repositório; não é contratação de intermediário fiscal.

Uma ponte C#/.NET 10 reaproveita os adaptadores e conversa com a camada TypeScript. Backend, API, worker e formulário municipal foram ligados ao produto. O catálogo contém 198 registros; a análise estática encontrou 136 elegíveis em produção e 127 em homologação. **Esses números não são municípios homologados em emissão real.**

O motor prepara e assina o envelope sem rede. A camada do produto cifra e persiste o pedido antes da transmissão direta. Em resposta incerta, a recuperação consulta RPS/cancelamento, sem reenviar automaticamente. O retorno é comparado a unidade, CNPJ, município, ambiente, numeração, valores, tomador e datas. São preservadas a primeira resposta e as tentativas de cancelamento.

Para São Paulo, o recorte entregue é layout 1 sem desconto, com tratamento da equivalência de inscrição municipal com zeros à esquerda. Operações incompatíveis recebem orientação fiscal, sem desfazer um recebimento válido. Quando não há fluxo completo no catálogo, a interface orienta o uso do portal municipal.

O proprietário dispensou desenvolver adaptadores inexistentes. O catálogo reaproveitado, os endpoints e os contratos precisam de validação por município/emitente no ambiente externo.

## 15. Migrações e isolamento das novas capacidades

As mudanças são registradas em migrações aditivas. Entre os marcos desta sessão estão a infraestrutura fiscal nacional, sessão/outbox Baileys, automação no dia, reserva SaaS, recuperação de convite e as migrações finais:

| Migração | Finalidade |
|---|---|
| 0128 | Perfil fiscal não optante |
| 0129 | Perfil IBS/CBS |
| 0130 | CNPJ alfanumérico |
| 0131 | Prova da assinatura fiscal |
| 0132 | Fila WhatsApp manual |
| 0133 | Simples com ISS fora do DAS |
| 0134 | Consentimento de WhatsApp no cadastro |
| 0135 | Federais e ISS fora do DAS |
| 0136 | Emissor municipal reaproveitado |

A migração 0136 cria isolamento ENABLE/FORCE RLS, USING/WITH CHECK e FKs compostas para manter tenant, unidade, nota e documentos coerentes. Há REVOKEs explícitos, inclusive para neutralizar privilégios padrão. Histórico não permite UPDATE/DELETE/TRUNCATE pela aplicação. Identidade, snapshot, pedidos e respostas já persistidos não podem ser reescritos silenciosamente.

A numeração é protegida por combinação de emitente/município/ambiente/série, com série exclusiva e primeiro número controlado. A aplicação conserva o emissor original do documento mesmo que a unidade mude sua configuração depois.

Anonimização cadastral não reescreve XML fiscal autorizado ou destrói o histórico fiscal protegido. A exportação LGPD alcança os dados fiscais pertinentes pelo vínculo da venda, nos limites legais e funcionais documentados.

## 16. Revisão de usabilidade solicitada

A avaliação foi feita percorrendo o produto como operador, com API/web/banco reais e transportes sintéticos, e não apenas olhando componentes isolados. Foram usadas as larguras 360, 390, 768 e 1280 px.

Antes, escolher a integração exigia mais conhecimento prévio; credenciais avançadas podiam competir com o caminho inicial; variáveis/botões de vários avisos apareciam juntos; a nomenclatura manual podia sugerir disparo automático.

As mudanças produziram uma sequência mais clara: escolher o modo, entender custo/risco, conectar quando necessário, cadastrar a mensagem compatível e então montar campanha/regra ou operar a fila. Instruções repetidas foram retiradas e detalhes avançados recolhidos, sem esconder os pré-requisitos da conexão.

Minha avaliação final do fluxo local é positiva: a escolha e a próxima ação ficaram mais evidentes; a prévia acompanha o conteúdo; o usuário consegue distinguir envio automático e trabalho manual. Ainda há atrito inerente ao cadastro externo da Meta, à recuperação/instabilidade de Baileys e à rotina de voltar para confirmar no manual. Isso não foi apresentado como estudo de usabilidade com clientes externos.

A última revisão do auxiliar encontrou três pontos: instruções Meta antes de trocar a conexão, aviso de que o manual não pausa os automáticos e preservação da lista vazia de botões. Todos foram corrigidos. Essa participação final foi estática, sem serviços ou testes executados pelo auxiliar. O histórico de transferência preserva as informações anteriores reunidas.

Os percursos WhatsApp v13 passaram: Meta em 20,11 s, Baileys em 40,90 s e manual em 21,07 s. Esses nomes identificam provas de UX e não significam que a regressão integral v13 tenha passado — ela falhou separadamente.

## 17. Testes, experimentos e falhas: o que de fato ocorreu

As contagens abaixo não devem ser somadas entre rodadas como se representassem novos testes independentes. Muitas execuções repetem os mesmos casos para verificar alterações.

| Marco | Resultado e limite |
|---|---|
| Baseline controlado | 99 etapas e verificações iniciais; saída 1, com falhas de backup shell, scheduling, finance e CRM. A API passou, mas sua contagem final original não foi inventada após a limpeza dos logs |
| Referência ERP Raiz | 793 testes selecionados aprovados; não foi a regressão completa do ERP |
| Regressão v3 | Todas as suítes de aplicação passaram, mas o comando saiu 1 por duas guardas estáticas; correções posteriores mudaram a fonte |
| V4 e v5 | Interrompidas para corrigir exposição de credenciais nos logs; não são aprovações |
| Regressão v6 | Saída 0 em 2.866,69 s; 29 guardas, 102 etapas, 4.266 Vitest e 313 TAP aprovados, sem falhas/pulados. É prova daquela fonte anterior |
| Medição v6 | Saída 0 em 659,29 s, com pilha, navegador, carga e recuperação de worker |
| Regressão v9 | Saída 1 em 3.115,67 s; o resultado foi preservado como reprovado, sem ser promovido a aprovação da versão final |
| V10/v11 | Houve interrupções registradas no curso de ajustes e da reorganização de UX; não são conclusões integrais |
| Regressão v13 | Saída 1; queda/ausência de PostgreSQL e guarda antiga da prévia. A guarda foi corrigida e teve reteste dirigido |
| V14 | Interrompida por encerramento do processo de banco; não foi tratada como aprovação |
| Regressão v15 | Saída 1 em 3.180,30 s; 29 guardas e 104 etapas. 4.418 Vitest passaram e um falhou; 321 TAP e 34 C# passaram. Nenhum caso pulado nesses resumos |
| Correção após v15 | As rotas municipais já tinham `@Exige`; a ordem estava diferente da esperada pelo scanner. Foi alinhada ao padrão sem retirar a proteção. Os 24 testes dirigidos da guarda passaram |
| Regressão v16 | Interrompida por pedido expresso de publicação imediata, com 2.410 Vitest e 34 C# aprovados até o registro, sem falha reportada naquele ponto. Não é regressão integral aprovada |
| Complementares v16 | Preparados para execução em série após a regressão, mas não iniciados antes da interrupção |
| Dependências, 21h17 UTC | `pnpm audit` saiu 0: nenhuma vulnerabilidade conhecida encontrada naquele momento |
| Segredos antes do commit | Varredura de árvore e histórico Git saiu 0 em 7,47 s |

A guarda de prévia antiga dependia de uma forma textual específica do código. Ela foi substituída por análise que liga o textarea editável à variável da prévia, com negativos para conteúdo divergente, campo não editável e ausência. Não foi simplesmente desabilitada para tornar o resultado verde.

O defeito de botões Meta teve teste de mutação: reintroduzir a omissão da lista vazia fez o teste pertinente falhar; a fonte correta foi restaurada. Também houve provas negativas de autorização, isolamento, concorrência, arquivos inválidos, XML, criptografia e fluxo manual, descritas nos registros de cada frente.

## 18. Ensaios locais já realizados e métricas

Além das suítes, houve ensaios de pilha, navegador, carga, recuperação, banco e segurança. São provas de versões e massas locais, sem extrapolação para SLA ou capacidade produtiva.

- A medição v6 usou agenda com 840 horários ocupados: P50 304 ms, P95 365 ms e P99 394 ms. Na disputa de 100 reservas, houve uma criação, 99 conflitos 409, nenhum 500, uma única reserva ativa e replay idempotente.
- Foram exercitados build, API, web, worker, queda abrupta e retomada do worker, dez percursos e as quatro larguras.
- Conferidores corrigidos aprovaram números, 30 telas com dados, 36 destinos visíveis e recusa do gerente separadamente.
- Remarcação e cancelamento pelo navegador foram conferidos no banco.
- Os cinco percursos operacionais adicionais passaram: walk-in, pacote, clube, lista de espera e duas unidades com sessões independentes. O ciclo de clube usou tarefa real com relógio injetado e recebimento manual; a lista de espera usou worker real e mensagem sintética.
- Restore anterior conferiu 142 tabelas, 173 políticas e 138 tabelas com FORCE RLS, além de schema, grants e login restrito. Esses números pertencem ao schema daquela etapa, não à migração final 0136.
- Dump real foi cifrado/decifrado/restaurado; conteúdo, schema, login e RLS foram conferidos. Corrupção e chave errada foram recusadas. O registro `backup-cifrado-final` saiu 0 em 22,24 s.
- Rollback foi exercitado com 30 mil clientes e 90 mil lançamentos, incluindo estrutura e conteúdo. Os tempos locais não foram declarados RTO de produção.
- Docker/Compose teve uma tentativa reprovada e uma repetição aprovada, `docker-compose-prontidao`, em 136,43 s, com 135 migrações, HTTPS por CA local, API/web/worker, reaplicação, reinício e persistência. Isso não certifica a imagem final com 0136/UX final; essa repetição ficou pendente.
- O motor municipal passou em 34 testes C#; a ponte real tem provas TAP. Contrato/banco municipal passou em 30 testes dirigidos, incluindo concorrência, RLS, histórico, timeout, cancelamento e documentos.
- A migração 0136 passou em provas de invariantes com 136 migrações locais e dez testes do cliente de banco.
- Há medições fiscais locais com 20 amostras e sem rede fiscal. No registro `fiscal-medicao-a1-build-atual`, prontidão teve P95 88 ms e fechamento com A1/snapshot/fila P95 108 ms. Outros registros preservam suas próprias medições; nenhuma delas mede tempo de autorização externa.

## 19. Inventário final e comandos de referência

O inventário final registrado antes da publicação identificou 398 arquivos de teste, nenhum sem runner mapeado. O inventário de produto contabilizou 401 rotas, 228 escritas, 77 controllers, 82 páginas, 14 pacotes e 136 migrações. Contagem estrutural não equivale a cobertura de todas as regras possíveis.

Comandos efetivamente usados ou wrappers identificados nos registros:

```text
python3 output/executar_verify_limitado.py
python3 output/executar_verify_correcao.py fiscal-baileys-stripe-v15
python3 output/executar_verify_correcao.py fiscal-baileys-stripe-v16
pnpm --filter @barbearia/api exec vitest run test/permissao.guard.test.ts
pnpm --filter @barbearia/finance test src/nfse-municipal
pnpm --filter @barbearia/db test
bash scripts/testar-fiscal-municipal.sh
bash scripts/medicao.sh
python3 output/prova_meta_navegador.py
python3 output/prova_baileys_revisao.py
python3 output/prova_baileys_worker_navegador.py
python3 output/prova_manual_navegador.py
python3 output/prova_consentimento_navegador.py
python3 output/prova_operacao_navegador.py
python3 output/prova_docker_compose.py
python3 output/prova_backup_cifrado.py
node scripts/verificar-segredos.mjs --history
pnpm audit
git push -u origin HEAD:refs/heads/main
git ls-remote origin refs/heads/main
```

Os wrappers carregam configuração privada fora do checkout e sanitizam os registros. Esta lista não declara que toda combinação final desses comandos tenha passado. Os resultados por tentativa estão no registro de execuções e nos relatórios históricos.

## 20. Publicações e situação dos artefatos

| Commit | Papel nesta sessão |
|---|---|
| `3d90fc62de2947fda05aed32407d5a2f2852340b` | Base auditada |
| `75a41587d28e25c27125acf498bf0f1138ea80d1` | Primeira entrega: Baileys, Stripe SaaS e correções pré-go-live, publicada em master |
| `535a190be8e4430e2530870abfafe00144bd4ab1` | Entrega adicional de fiscal próprio, manual, consentimento, UX e correções; main criada e push conferido |
| Commit que contém esta pasta | Consolidação documental solicitada após a publicação do código |

O commit `535a190` alterou 993 arquivos, com grande parte do volume decorrente de fontes municipais reaproveitadas, schemas e evidências. Não se deve interpretar o número bruto de linhas como quantidade de lógica nova escrita nesta sessão.

Arquivos de produto e evidências foram selecionados explicitamente. Não foi usado `git add -A`. Dumps, segredos, estado de autenticação e arquivos de build não foram incluídos. Whitespace de fontes oficiais/upstream e de logs foi preservado; a verificação de whitespace da fonte própria passou.

O envio ao bucket foi solicitado, mas serviço e destino não foram informados. Em seguida, o proprietário pediu concluir o relatório, fazer commit/push e parar. Não houve upload a bucket; nenhum bucket de mídia da aplicação foi escolhido por inferência.

## 21. O que permanece para depois desta publicação

### Validação local interrompida

Concluir a regressão integral sobre a fonte publicada, investigar qualquer nova falha concreta e executar os complementares da versão final: imagem Docker/Compose com 0136 e UX final; Meta padrão e coexistência; Baileys com worker real e transporte sintético; Stripe, consentimento, operação, manual e fiscal; medição sem concorrência; cliente/proxy/logs; conferidores; instalação limpa; restore; rollback; backup cifrado; fuso alternativo; dependências e segredos.

Muitos desses ensaios já passaram em versões anteriores, conforme a seção 18. A pendência é a repetição e consolidação na fonte final, não a alegação de que jamais foram executados.

### Homologação e configuração externas assumidas pelo proprietário

- Stripe: credenciais, webhook, cadastro e cobrança reais, autenticação adicional, recusa, recuperação e conciliação.
- Meta: empresa/app, cadastro e número, permissões, templates, webhook, OTP e entrega real. A aprovação informada não substitui o percurso externo.
- Baileys: pareamento, envio/recebimento, reconexão e operação real do número, respeitando o risco da alternativa não oficial.
- Fiscal: CNPJ, município, regime, A1, credenciamento e contrato efetivamente aceito; autorização, rejeição, timeout incerto, consulta, duplicidade e cancelamento.
- Implantação: domínio/HTTPS, proteção de bot, confiança/CRLs e renovação, fontes do DANFSe, segredos, backup remoto, monitoramento e recuperação no ambiente de destino.

### Escopo adiado ou não assumido

Retenção de ISS e salão-parceiro: próxima entrega por decisão do proprietário. Municípios sem adaptador reutilizável: não criar nesta entrega. Outros perfis IBS/CBS, benefícios/situações especiais e representação entre matriz/filial: não inferidos. NF-e/NFC-e de mercadorias e documentos fiscais do próprio SaaS: não fazem parte do emissor NFS-e de serviços da barbearia. Pagamentos online e split das lojas: retirados do escopo solicitado.

## 22. Como ler o material histórico

O documento presente fixa o estado no momento da consolidação. Os textos em `historico/` preservam a redação de cada etapa, inclusive frases como “em andamento”, “não publicado” e pedidos originais mais amplos. Essas frases devem ser lidas com a data/contexto do registro; não substituem as decisões posteriores narradas aqui.

O inventário de arquivos mostra o delta da base auditada até o commit de código publicado. O registro de execuções preserva resultados, inclusive reprovados, sem copiar credenciais ou payloads. As capturas locais de celular/desktop estão indexadas no material da entrega.

Código implementado, teste executado, teste aprovado, publicação Git e ativação externa são fatos diferentes. A sessão produziu implementações e numerosas provas locais, mas terminou com publicação antecipada por escolha expressa do proprietário, mantendo visível a validação que ficou por concluir.
