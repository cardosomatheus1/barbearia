# Correções da auditoria pré-go-live — em andamento

Base auditada: `3d90fc62de2947fda05aed32407d5a2f2852340b`.
Branch local: `fix/pre-go-live-audit-20260909`.

Mandato vigente: corrigir e testar os achados. Stripe exclusivamente para as assinaturas do SaaS, sem cobrança de comandas ou Connect. Fiscal próprio, sem intermediário, usando o ERP Raiz como referência; cobertura nacional requerida e ainda não comprovada. Nenhum commit, push, deploy, migração de produção, cobrança real, emissão fiscal ou envio de WhatsApp foi realizado nesta etapa.

O estado consolidado fica em [STATUS_PRE_GO_LIVE_ATUAL.md](STATUS_PRE_GO_LIVE_ATUAL.md).
Este documento preserva a cronologia: a tabela registra as primeiras correções e
as seções seguintes atualizam cada resultado. Contagens e pendências antigas não
substituem o estado consolidado. São provas locais, não certificação de produção.

| Achado | Correção local | Verificação / trabalho restante |
|---|---|---|
| AUD-01 Cartão sem caminho de conclusão | Stripe exclusivo da assinatura SaaS: Checkout mode=setup cadastra cartão com consentimento versionado; a régua existente cobra off_session. Reserva antes da rede, validação de vínculos e proteção contra evento antigo | Cadastro DB: 7 testes; arquivo API plataforma: 46; validações de configuração e modos passaram. Confirmação 3DS da mesma cobrança adicionada; webhook consulta o estado atual e recusa definitiva cancela o PI antes de liberar nova tentativa. Ensaios finais e homologação externa pendentes. O checkout de comanda não faz parte deste escopo |
| AUD-02 Fiscal real ausente | Emissor nacional próprio ligado à factory/API/worker/frontend: A1 cifrado, XSD, DPS/XMLDSig, numeração e snapshot, recuperação por consulta, cancelamento, XML/DANFSe e link assinado | 46 testes fiscais direcionados, 5 de mTLS local e fluxo de navegador em 4 larguras passaram. Cobertura atual MEI/Simples ISS DAS sem retenção. Outros perfis/municípios, contratos pendentes e homologação externa impedem declarar cobertura universal |
| AUD-03 Clube/split reais ausentes | Stripe recebe apenas as assinaturas SaaS. COMANDA_PSP_MODO separado, fake proibido em produção; cadastro hospedado do cartão SaaS implementado | Worker corrigido: clube/split sem adquirente falham explicitamente; fakes somente em teste configurado. Teste de separação passou. Revisão das telas e regressão geral pendentes |
| AUD-04 Adoção falsa de migrações | Migrador com trava por banco, checksums, marcador de execução interrompida e adoção explícita comparada a schema reconstruído | 9 testes passaram, com fixtures isoladas, falha SQL real, rollback do DDL, checksum divergente e recusa de retry silencioso |
| AUD-05 Restore perde grants | Dump/restore preservam ACL; validação usa login real restrito e compara acesso por tenant | 3 testes de restore passaram, inclusive permissões perdidas e duas barbearias |
| AUD-06 Gate de deploy permissivo | Workflow e dois jobs obrigatórios, sucesso no SHA exato, paginação e reexecução; deploy recebe SHA fixo; CI novamente pendente não bloqueia o commit; cron funciona na primeira instalação | 7 testes passaram, incluindo execução dos scripts com branch avançando, segunda consulta recusada e ativação/desativação sem crontab anterior. O teste do cron falhou antes da correção e passou depois |
| AUD-07 Homepage não prova prontidão | Sondas de API/banco/RLS, versão e avanço da fila do worker; leitura de domínio; web; checagem no update/rollback; API degradada retorna HTTP 503 | 2 testes de sondas passaram; prova HTTP de degradação e pilha final em execução. Compose completo e rollback de release antigo sem heartbeat ainda não homologados |
| AUD-08 Dependências vulneráveis | Next 15.5.25, Nest 11.2.3, Vitest 4.1.11 e transitivas corrigidas; Vitest fixado também na raiz | Audit anterior à inclusão de XML/Baileys terminou sem vulnerabilidades conhecidas; é necessário repetir com o lock final. Geração Prisma, builds e typechecks passaram. Regressão completa em andamento; núcleo passou também sob TZ=Asia/Tokyo |
| AUD-09 Segredos excessivos | Ambientes separados de validação, migração, API, worker, web e Caddy | YAML inspecionado; API/worker sem admin/backup, web sem banco/provedores; execução do compose não realizada |
| AUD-10 IP compartilhado no SSR | Caddy autentica origem com chave interna; Next preserva IP apenas para API; API recusa XFF e cabeçalhos forjados; encaminhamento mantém autorização de objetos Request | 2 testes HTTP da API e 3 de encaminhamento SSR passaram. Prova com Caddy/Next/API reais passou: visitantes distintos mantêm cotas próprias; cabeçalho forjado não renova a cota; chave interna não aparece nas respostas |
| AUD-11 Testes dependem da data | Relógio injetado alcança criação e leitura de reservas temporárias; fixtures financeiras/CRM usam instantes explícitos; backup não herda chave externa | 6 cenários de hold passaram, incluindo ocupado antes e livre após expiração. Suítes completas de financeiro (512), CRM (389) e identidade (208) passaram. A regressão revelou e permitiu corrigir o último uso do relógio real na criação do hold |
| AUD-12 Schema de restore obsoleto | Histórico/checksum e schema completo conferidos contra referência; comparação normalizada pelo PostgreSQL | Restore positivo/negativos passaram; rollback com 30 mil clientes e 90 mil lançamentos passou |
| AUD-13 Falso positivo histórico | Varredura preserva caminho e commit; fixtures genéricas tratadas como na árvore; padrões de credencial continuam recusados; conteúdo do diff não altera o nome do arquivo analisado | 10 testes passaram; varredura da árvore e de todo o histórico Git passou |
| AUD-14 WhatsApp só na matriz | Conciliação percorre todas as unidades sob RLS, agrega resultados, visita demais unidades após falha e pede retry | Suíte WhatsApp/CRM passou; build do worker passou |

## Evidência

Comandos, códigos de saída e logs sanitizados: `EVIDENCIAS_CORRECOES_PRE_GO_LIVE/`.

Inventário atualizado às 05h de 10/09: `INVENTARIO_TESTES_CORRECOES_PRE_GO_LIVE.json`, com 379 arquivos de testes mapeados aos runners, incluindo 60 arquivos SQL. Fonte em revisão: `FONTE_CORRECOES_PRE_GO_LIVE.json`, com SHA-256 da fonte, excluindo output e arquivos ignorados. Inventários anteriores preservados com sufixo `antes_fiscal_baileys`.

A primeira regressão completa encontrou quatro falhas de guardas/configuração e uma de expiração de hold. Todas tiveram correção e reteste dirigido; a execução completa após essas correções ainda está pendente. Não se deve interpretar os testes dirigidos com filtro como execução de todos os casos do arquivo.

Além do portão, a rodada final deve incluir medição de navegador/carga, conferência de números e telas, remarcação/cancelamento pelo navegador, proxy real, rollback, teste do núcleo em outro fuso e varredura de dependências/histórico. Os ensaios que exigem emissor fiscal, conta Stripe ou envio Meta reais continuam pendentes de configuração e homologação externa.

A restauração medida é local e sintética; seus tempos não são RTO de produção. O acesso ao ambiente produtivo e a configuração/homologação de provedores continuam separados da conclusão do código.

## Continuação de 10/09: fiscal e Baileys

- `nfse-fiscal-legado`: 36 testes passaram; `nfse-ui-build`: API/web compilados.
- `nfse-mtls-local`: 5 testes passaram, servidor TLS real local com CA/A1
  sintéticos, prazo total, rejeição de redirect, servidor não confiável, corpo
  inválido/excedente e conexão interrompida. Não houve chamada ao fisco.
- `nfse-fiscal-entrega-renovada`: 46 testes passaram. O link público passa a ser
  gerado na tentativa de entrega, evitando expiração durante espera pelo canal.
- `nfse-transporte-types`: typecheck financeiro passou.
- `nfse-browser-cadastro-retest`: cadastro, arquivo inválido, certificado com
  espaços na senha, remoção e 360/390/768/1280 passaram. A tentativa anterior
  falhou no seletor de URL do ensaio (`salvo=1`), corrigido sem mudar o produto.
  Capturas em `PRINTS_CORRECOES_PRE_GO_LIVE/nfse-configurada-*.png`.
- A prova de navegador usou banco novo, aplicou 121 migrações e removeu o banco
  ao terminar. Não iniciou worker e não emitiu documento externo.
- Detectada lacuna de entrega: nota fiscal/recado/clube/lista de espera ainda
  chegam ao `ConsoleNotificationProvider` no worker. Será corrigida no roteamento
  dos canais; PDF disponível não prova envio ao cliente.
- Baileys em implementação, plano em `PLANO_BAILEYS_PRE_GO_LIVE.md`. Migração 0122
  adiciona canal, sessão com lease, chaves cifradas, outbox e textos locais.
  `baileys-sessao-db-retest`: 11 testes passaram (6 regras/criptografia e 5
  Postgres/RLS/concorrência). `baileys-socket-types`: passou.
- Baileys 6.7.24 (tag legacy, mesma versão da referência), pino9.14.0. Há patch
  versionado para libsignal6.0.0, removendo objetos de sessão e stack do log.
  Instalação com patch passou; teste comportamental do patch ainda pendente.
- Nada foi commitado nem publicado. Fontes continuam mudando; verify/medição
  completos devem rodar novamente quando a implementação estiver estabilizada.


## Continuação: roteamento Baileys e resultados duráveis (10/09, em andamento)

- API de conexão: `baileys-api-http` passou (1 cenário com autenticação,
  permissões, unidades, edição local e instalação desabilitada).
- `baileys-api-web-types-retest`, `baileys-identity-build`: passaram.
- Roteador por unidade ligado ao worker, envio manual, campanhas, automações e
  avisos de serviço. A unidade do texto selecionado acompanha campanhas e
  automações. Disponibilidade local não fabrica aprovação Meta.
- Outbox reserva conteúdo cifrado antes da rede, espera ACK e liga o identificador
  à intenção de negócio. Confirmação tardia concilia a origem sem nova transmissão.
- O histórico `notifications` continua append-only: `previous_notification_id`
  registra a confirmação posterior sem apagar o resultado incerto original.
- `baileys-retencao-db`: 18 testes passaram (sessão, recibos, campanha incerta,
  histórico, consentimento, remoção por prazo e anonimização). Houve alterações
  posteriores em tentativas conhecidamente recusadas e novos avisos: reteste pendente.
- `notificacao-desfecho-db`: 78 testes da fila passaram antes da ampliação dos
  tipos de aviso; nova regressão pendente.
- `avisos-core-test`: 85 testes passaram. `adquirentes-separados-test`: 10 passaram.
- `avisos-servico-types`: oito pacotes passaram. Há edições posteriores que ainda
  precisam de typecheck e regressão.
- Correção na entrega fiscal: carimbo somente depois da confirmação; falha
  conhecida libera retry, dúvida mantém a intenção para conciliação. Primeiro
  teste encontrou uso indevido da coluna reservada à cota promocional; corrigido,
  reteste em execução (`fiscal-entrega-duravel-retest`).
- O worker deixou de instanciar fakes fixos do clube/split. A configuração explícita
  de teste da comanda controla os fakes; sem adquirente a operação falha sem
  inventar cadastro, repasse ou recusa de cartão. Stripe permanece exclusiva do SaaS.
- Ensaio de navegador Baileys preparado em `prova_baileys_navegador.{py,mjs}`:
  API/web reais em banco descartável, sessão sintética sem conexão ao WhatsApp.
  Não confundir com homologação Meta/Baileys em um número real.

Pendências continuam: ensaio visual, fluxos HTTP completos, regressão final e
ensaios de operação; recuperação Stripe/3DS; validação fiscal externa e cobertura
municipal/regimes além do escopo nacional já descrito. Nenhum commit/push/deploy.


## Continuação: envios pela tela e autenticação bancária (10/09, 03h UTC)

Resultados desta rodada substituem pendências específicas dos registros anteriores;
não constituem fechamento do pré-go-live.

- `baileys-browser-envios-migracao`: passou. API/web e PostgreSQL reais, socket
  sintético: troca de canal, QR expirado e renovação, erro de texto sem perder
  campos, quatro larguras, envio manual pela ficha, campanha criada/enfileirada
  pela tela e despachada pelo domínio, automação criada pela tela e disparada
  pelo mesmo código usado pelo worker, desconexão e retorno à Meta.
- A prova não executou o laço completo do worker: o despacho de campanha e de
  automação foi chamado diretamente. A captura da automação registra o alerta
  real de fila sem worker. Não foi um envio a números reais.
- O ensaio encontrou a constraint antiga que recusava aniversário no dia (0),
  embora core/API/tela o permitissem. Migração `0123_automacao_no_dia.sql` corrige
  aniversário e assinatura vencendo. Zero continua proibido nos demais gatilhos.
- `baileys-seguranca-retest`: 33 testes passaram. Além das fixtures corrigidas,
  houve defeito real na consulta pré-envio de agendamento: `cancelled` não existe
  no enum. A consulta agora usa os estados ativos; resposta citada via LID passou.
- `baileys-runtime-parada-db`: 23 testes passaram. Parada aguarda abertura e
  renovação em curso; bloqueio do tenant impede renovação e operações sob posse.
  O worker também encerra Baileys/banco no caminho excepcional (`finally`).
- Cota promocional extraída para jobs, compartilhada por retorno, campanha,
  automação e manual, incluindo consentimento e opt-out ainda na fila de entrada.
  `promocional-campanha-concorrente`: passou (1 cenário, 37 não selecionados).
  `retorno-compartilhado-db`: 78 testes da fila passaram.
- `fiscal-entrega-duravel-retest` da rodada anterior passou: 4 cenários
  selecionados, 30 não selecionados. Arquivo completo ainda deve entrar no verify.
- Stripe 3DS: referência do PaymentIntent preservada em `authentication_required`;
  dono consulta a mesma cobrança com validação de tenant, fatura, customer, valor,
  moeda, cartão e ambiente. Segredo só na resposta autenticada, `no-store`.
  Browser não quita a fatura. Código de confirmação carregado apenas no plano,
  após ação do dono. Configuração inclui `STRIPE_PUBLISHABLE_KEY` na API.
- Webhook da assinatura consulta a Stripe para ordenar eventos; após recusa
  definitiva, o PI anterior é cancelado antes de liberar a próxima cobrança,
  impedindo confirmação por uma aba antiga. Baixa manual/cancelamento local
  recusam fatura já vinculada a cobrança viva.
- `stripe-3ds-cancelamento-db`: 45 testes passaram. `stripe-3ds-http`: passou
  (1 cenário, 47 não selecionados), incluindo recusa sem sessão, id inválido,
  fatura ausente, cache, autenticação pendente, evento de falha atrasado e baixa.
- `validadores-baileys-stripe`: 25 passaram. `fronteiras-ui-config-test`: 9
  passaram, incluindo CSP restrita ao plano.
- Verify geral iniciado em `regressao-fiscal-baileys-stripe`, com logs privados
  por etapa em `verify-fiscal-baileys-stripe-v1-stages`. Uma expectativa do novo
  teste de automação foi corrigida após o typecheck: salvar retorna id; a prova
  do limiar deve ler a linha persistida. Esta execução não pode ser declarada verde.

Ainda abertos nesta revisão: reexecução de oferta de vaga (o token antigo não é
recuperável após falha entre criação e envio); descoberta Baileys em bases grandes;
reserva da cobrança SaaS antes da rede (corrida com fechamento local antes de existir
`psp_charge_id`); proof de navegador 3DS; testes e ensaios completos; documentação e
inventários finais; cobertura fiscal e homologação externa. Não houve commit/push.


## Continuação: concorrência financeira e recuperação (10/09, 04h UTC)

Substitui as pendências técnicas específicas da seção anterior, sem afirmar
conclusão de go-live. Nenhum commit, push ou efeito externo realizado.

- Reserva SaaS antes da rede, migração 0125: protege baixa/cancelamento concorrentes,
  conserva tentativa, valor e cartão em timeout. Após 23h só recupera por metadata;
  busca vazia não autoriza outro débito. Posse vencida não permite aplicar resposta
  de worker antigo. Falha de uma conta não impede processar a seguinte.
- Varredura de faturas usa cursor e alcança além de 500 abertas. `reserva-isolamento-falhas`:
  38 testes passaram; `reserva-saas-retest`: 43 passaram. Prova adicional de 501
  faturas em `cobranca-cursor-501` passou.
- Convite de vaga recupera a mesma oferta e o mesmo token cifrado; encerramento
  apaga a cifra (0126). Vencimento reenfileira o próximo no mesmo commit e respeita
  silêncio e recurso habilitado. `oferta-recuperavel-fronteiras`: 28 passaram.
- Baileys percorre rotas por cursor; teste excede a primeira página e preserva
  sessão da seguinte. Perda de posse durante envio deixa resultado incerto.
  `novas-fronteiras-baileys`: 20 passaram.
- Rateio de desconto usa BigInt para evitar inversão do maior resto em valores
  altos. Reprodutor com 933816783 + 821400452 centavos e desconto 1350908579:
  resultado correto 718715084 + 632193495. `rateio-exato-core`: 61 passaram.
- DANFSe persiste código de falha e retoma o download. `fiscal-pdf-retest`: cenário
  dirigido passou; os demais nove não foram selecionados nessa chamada.
- API de cadastro de cartão devolve 503 quando a Stripe não pode ser consultada.
  `stripe-conciliacao-503-api`: passou, 47 cenários não selecionados nessa chamada.
- Testes de auditoria agora copiam head-auditado e provam baseline positivo;
  `guardas-baseline-auditoria`: 48 passaram. Guardas acompanham extração de cota e
  despacho sem reintroduzir filtro tenant redundante. `guardas-crm-ofensiva`: 21;
  `guards-admin-rotas-127`: 12; guarda ofensiva atual: passou.
- Invariantes de banco completas passaram até 0127. Texto fiscal do catálogo
  reflete emissor próprio. Tela permite desligar split legado sem adquirente.
- Instalação frozen/offline em diretório vazio passou, com prova comportamental
  de libsignal sem log de chave privada (`instalacao-limpa-baileys`). Audit do
  registro: zero vulnerabilidades conhecidas nas 504 dependências reportadas.
  Árvore e histórico passaram no scanner (`segredos-historico-127`).
- `stripe-3ds-browser` da rodada anterior passou: tela/API com HTTP/SDK Stripe
  sintéticos. Captura de 390px foi inspecionada; mensagem de confirmação ganhou
  quebra de linha e exige nova captura.

A execução longa `regressao-fiscal-baileys-stripe` misturou arquivos anteriores
com correções feitas durante a rodada. Reprovou guardas já corrigidas e uma
asserção nova de PDF contra módulo carregado antes da correção; o reteste dirigido
passou. Ela **não** comprova o estado final. Permanecem verify integral, medição
sem contenção, ensaios complementares e reconferência do inventário. Fiscal
universal e homologações externas continuam sem comprovação.


## Continuação: fechamento dos fluxos e nova regressão (10/09, 05h UTC)

- O inventário de anonimização agora acompanha os gatilhos instalados e habilitados
  em `customers.anonymized_at`. A função real de domínio foi exercitada para outbox
  queued/sending/uncertain/sent. Cifra, vínculo e hash de destinatário saem; recibo
  atrasado não restaura dados. `anon-baileys-estados-corrigido`: quatro passaram.
  A suíte de anonimização completa passou no reteste anterior (22 casos).
- Avisos de vaga, recado, clube e nota voltaram a usar o mapa canônico de variáveis,
  eliminando arrays paralelos no worker. `mapa-avisos-worker`: três passaram.
- Retomada da vaga não entrega convite após desativar o profissional ou iniciar
  o horário. `oferta-retomada-inativa`: seis casos selecionados passaram; 22 não
  selecionados. O teste novo prova profissional desativado, não todas as mudanças
  possíveis na agenda depois de uma oferta.
- API de plataforma: o novo 3DS ativava a assinatura compartilhada pela fixture e
  contaminava o teste de trial. O cenário agora confere a ativação e restaura o
  estado anterior no cleanup. `plataforma-api-trial-isolado`: 48/48 passaram.
- `stripe-browser-atual`: seis cenários passaram, incluindo recusa, confirmação
  do mesmo PI e baixa somente após consulta pelo webhook. Quatro larguras;
  SDK/HTTP sintéticos. Captura móvel atual inspecionada.
- `fiscal-browser-atual`: cadastro, configuração, arquivo inválido, senha do A1
  com espaços, remoção e quatro larguras passaram. Sem chamada ao fisco.
- `baileys-browser-fila-real` reproduziu seleção de canal desfeita por refresh
  atrasado. O efeito do React passou a sincronizar a escolha apenas quando o
  canal persistido muda. `baileys-browser-fila-corrigida` passou: manual pela
  tela; campanha e automação criadas na tela e consumidas por `rodada` real,
  verificando claim, handler, ACK sintético, status done e liberação da posse.
  Não executa o processo main completo nem abre conexão real com WhatsApp.
- A1: apresentação mTLS agora inclui as intermediárias correspondentes do PFX,
  em ordem e com assinatura verificada, separada da folha usada no XML. Teste
  TLS real local aceita a cadeia e recusa a mesma folha sem intermediária.
  `fiscal-cadeia-mtls`: 11 testes; `tipos-cadeia-fiscal`: passou. Isto não valida
  confiança ICP-Brasil/CRL nem a assinatura criptográfica da resposta fiscal.
- A regressão anterior encerrou com falhas; não foi promovida a aprovação.
  `regressao-fonte-estavel` iniciou com toda a fonte estabilizada. O runner
  conserva logs por etapa e compara hashes antes/depois. Resultado pendente.
- O GitHub continua no SHA base: branch padrão `claude/barbershop-app-research-xvejhy`;
  `main` e `master` não existem no remoto. Nenhum push ou troca da branch padrão.

A cobertura fiscal universal segue incompleta. Não há adaptadores municipais
para os regimes que não podem emitir pelo sistema nacional, nem homologação
externa. Medição sem concorrência e ensaios finais ainda serão executados após
esta regressão. Estes registros não autorizam declarar go-live concluído.


### Recuperação de migração de dados (10/09, 05h12 UTC)

A regressão v2 foi interrompida (exit 130) antes da conclusão e não representa
aprovação. A revisão encontrou que o ensaio de rollback exigia diferença de schema,
mas 0127 altera dados. `check-schema.mjs data-signature` agora calcula resumo de
conteúdo por tabela em snapshot consistente, sem imprimir linhas. O rollback prova
mudança em estrutura **ou** dados e exige o conteúdo anterior após restaurar.

`assinatura-dados-restauracao` passou: UPDATE mantendo contagem muda o resumo;
reordenação física sem mudança de conteúdo não muda. `rollback-dados-catalogo`
passou com 30.000 clientes, 90.000 lançamentos e 173 políticas: backup 768 ms,
migração 13 ms, restauração 6607 ms, schema/conteúdo/role restrito conferidos.
Tempos locais sintéticos, sem Docker nem rollback de release produtiva.

Nova regressão integral: `regressao-final-v3`, fonte estabilizada depois desta
correção. Uma prova adicional de dump real cifrado com GCM e restaurado foi
preparada em `prova_backup_cifrado.py`; só será contabilizada após execução.

## Regressão e medição concluídas em 10/09, 06h29 UTC

- `regressao-final-v3` terminou após 3.837,60 s, com fonte estável
  `b3a3853d059240a0dae40762ff55afa9c1d10c6af407e649e93ed1e0dcf07085`.
  Todas as suítes de aplicação passaram: core 1.435; frontend 90; identidade
  208; scheduling 286; onboarding 18; catálogo 53; financeiro 544; CRM 428;
  jobs 101; plataforma 262; API 541. Os demais testes de scripts/migrações
  constam dos logs. O comando completo saiu 1 por duas verificações estáticas.
- A guarda de prontidão interpretou a frase negativa sobre o Raiz como promessa
  fiscal; a redação foi esclarecida. A guarda visual encontrou uma classe de
  botão incompatível no caminho de desligar split; foi trocada pela classe
  existente do design system. `guardas-finais-corrigidas`: passou, incluindo
  os 11 testes de prontidão e as 8 mutações negativas do verificador visual.
  A fonte depois dessa correção cosmética difere da fonte da regressão v3.
- `medicao-final`: passou em 656,77 s, incluindo novo build de todos os pacotes,
  telas nas quatro larguras, 10 percursos do clique ao banco e retomada do
  worker após SIGKILL. Com 840 horários ocupados, 120 amostras e 8 requisições
  simultâneas: P95 398 ms; P99 436 ms; 25,7 req/s. Disputa do mesmo horário:
  1 criação, 99 respostas 409, zero 500 e uma única reserva ativa no banco.
- `numeros-telas-final` falhou antes das comparações: esses conferidores usam
  contas fixas da demonstração, ausentes na base de medição. Ensaio separado
  com a semente oficial em banco local novo foi preparado; resultado pendente.

Nenhuma das evidências locais acima encerra a cobertura fiscal universal ou a
homologação externa. Commit/push/deploy não foram realizados.

## Conferidores auxiliares: diagnóstico e reparos

A primeira execução sobre a semente oficial (`conferidores-demo-final`)
exercitou as comparações e encontrou dois erros do material de verificação:

- O conferidor somava `package_uses` a comandas que já reconheciam esse valor.
  O snapshot sintético confirmou R$ 197,00 exatamente na parcela duplicada.
  A regra vigente é coberta por `pacote.integration.test.ts` (DRE sem consumo
  duplicado); o conferidor agora desconta consumo de assinatura e acrescenta
  mensalidades e saldo de pacote vencido. A consulta de estoque não engole
  mais falhas HTTP. Nenhum cálculo financeiro do produto foi alterado aqui.
- A semente publicava antes de inserir avaliações e seu upsert atualizava só
  `refreshed_at`. A linha conservava nota nula e contagem zero diante de 688
  avaliações publicáveis, média 4,7. O upsert de demonstração passa a atualizar
  os indicadores derivados; a rotina de vitrine do produto já os atualizava.

O navegador encontrou também um defeito real no catálogo: todos os formulários
repetiam o ID de `comboToleranceMinutes`, fazendo os labels apontarem para o
primeiro campo. O ID e o label agora usam o prefixo de cada formulário, como os
outros campos. Páginas de recusa de campanhas/automações ganharam H1.

Os conferidores usavam o gerente sem `marketing.send` para tentar ler dados de
campanha/automação; agora usam o dono para ler esses dados e verificam a recusa
do gerente separadamente nas quatro larguras. Uma recusa não conta mais como
leitura válida dos dados. Build web, guarda visual e quatro testes de crases
passaram. A repetição `conferidores-demo-corrigidos` aprovou os números e ainda
estava completando as telas ao registrar este andamento.

## Ensaios complementares aprovados — 10/09, 06h50 UTC

- `conferidores-demo-corrigidos`: passou, números, 30 telas com dados, 36
  destinos visíveis e recusa do gerente nas quatro larguras. Fiscal desabilitado
  nessa semente foi pulado pelo conferidor; cadastro fiscal tem ensaio próprio.
- `cliente-navegador-final`: remarcação e cancelamento passaram no navegador,
  estados anterior/novo/cancelado confirmados no banco. Sessão sintética.
- `proxy-real-final`: Caddy/Next/API passaram, cotas independentes e headers
  forjados recusados, sem credencial interna nas respostas.
- `baseline-restore-final`: 127 migrações adotadas na base local medida após
  comparação de estrutura; nenhuma base de produção foi adotada.
- `restauracao-final`: 142 tabelas, 173 políticas, 138 com FORCE RLS, schema e
  login/grants em duas contas conferidos.
- `backup-cifrado-final`: dump real passou por GCM e restore; conteúdo idêntico,
  schema e login/RLS conferidos; corrupção e chave errada recusadas.
- `baileys-worker-completo-final`: passou com main/fábrica/auth reais e socket
  sintético, inclusive PARAR e os envios da campanha/automação pela tela.

A regressão v4 começou após todos esses reparos. O runner mantém no máximo dois
processos ativos, aproveitando a vaga livre; o ensaio com três falhas deliberadas
confirmou que os códigos de saída são preservados e colhidos pelo gate original.

## Token fiscal no log do proxy — 10/09, 07h10 UTC

A v4 foi interrompida intencionalmente (exit 130, registro separado) porque a
revisão do Caddy identificou persistência da credencial do link fiscal na URI
e no Referer. O cabeçalho personalizado da chave interna também não era redigido.
`proxy-token-fiscal-antes` reproduziu a exposição com token/chave sintéticos.

`deploy/Caddyfile` agora usa o filtro JSON do Caddy para redigir o caminho fiscal,
incluindo query, barras repetidas e prefixo codificado. Referer e chave interna
são removidos. `proxy-token-fiscal-corrigido` passou em cinco variantes, preservando
URI comum, método e status. `proxy-real-redacao-fiscal` repetiu o ensaio real
Caddy/Next/API: cotas independentes, cabeçalhos forjados recusados e nenhuma chave
interna na resposta. A v5 repetirá a regressão integral após esta alteração.

## Logs de credenciais e fatura no celular — 10/09, 07h51 UTC

A v5 foi interrompida intencionalmente, exit 130. A ampliação da revisão mostrou
que também os links de fila/oferta carregam credenciais: o Caddy as registrava
na URI e em headers de redirecionamento; o log de erro de upstream era separado
do log de acesso. A API mascarava UUIDs, mas conservava os tokens base64url.

- `api-logs-credenciais-antes`: quatro cenários HTTP falharam reproduzindo a
  exposição. O interceptor agora usa o padrão registrado pelo framework e
  conserva o status das exceções HTTP. `api-logs-credenciais-corrigido`: 27
  testes passaram; build e tipos da API também passaram.
- `proxy-credenciais-antes`, `proxy-resposta-credencial-antes` e
  `proxy-falha-upstream-antes` reproduziram as três superfícies do Caddy. A
  configuração final omite URI e headers de pedido/resposta no acesso e no
  log do processo. `proxy-logs-acesso-erro-corrigidos`: passou em 11 caminhos,
  incluindo URL codificada, query de webhook e erro 502; método/status mantidos.
- `proxy-real-logs-corrigidos-reteste`: passou, 8 leituras SSR e mesmas cotas.
  O primeiro reteste falhou porque o conferidor procurava o slug literal
  retirado dos logs. Agora isola a fase SSR e confere o padrão da rota; nenhuma
  expectativa de resposta, quantidade mínima ou cota foi relaxada.
- As capturas da Stripe revelaram valor cortado pela tabela no celular. A lista
  de faturas agora usa pares nome/valor: empilha por recipiente estreito e
  organiza colunas quando há espaço. Valor e confirmação ficam juntos.
  `stripe-valor-mobile-corrigido` passou em 360/390/768/1280, incluindo prova
  negativa de valor cortado, recusa recuperável e baixa somente após webhook.
  O primeiro ensaio da nova asserção falhou por seletor ambíguo (preço de plano
  e valor da fatura), antes de avaliar visibilidade; o seletor foi delimitado.
- Build web e guardas visuais/acessibilidade/prontidão passaram. Uma chamada
  inicial da guarda usou nome de script inexistente; a chamada corrigida é
  `plano-faturas-guardas-corrigidas`.

Correção de registro: os 90 casos citados anteriormente como web pertencem a
`@barbearia/ui`; `@barbearia/web` passou com 191 casos, conforme logs da v3.
O inventário atual passa a 380 arquivos de testes após adicionar a prova HTTP
de logs. A v6 verificará a fonte estabilizada após essas correções.

## Regressão integral v6 concluída — 10/09, 08h41 UTC

`regressao-final-v6` passou, exit 0, em 2.866,69 segundos. Foram executadas as
29 guardas iniciais e as 102 etapas do verify. Os resumos registram 4.266 casos
Vitest e 313 TAP aprovados, sem falhas, cancelamentos ou testes pulados; as
invariantes SQL passaram e não são somadas a esses totais. A API passou em
37 arquivos e 545 testes, incluindo as quatro provas HTTP dos logs.

A fonte permaneceu idêntica antes/depois da execução e corresponde ao inventário
atual: `23a0bbb74c8a422592ea40519106e904270d69adf90522ffd904456b67631255`.
`regressao-final-v6-resumo.json` registra cada etapa e o hash do respectivo log.
O inventário continua com 380 arquivos de teste e nenhum sem runner identificado.

A medição `medicao-fonte-v6` foi iniciada depois do término do verify, em banco
local próprio. O resultado verde do código existente não encerra as pendências
fiscais de implementação nem substitui homologação externa das integrações.

## Medição final v6 concluída e escopo de pagamentos — 10/09, 08h52 UTC

`medicao-fonte-v6` passou, exit 0, em 659,29 segundos. Repetiu build, subida de
API/web/worker, queda abrupta e retomada do worker, quatro larguras e 10 percursos
do clique ao banco. Agenda com 840 horários ocupados: P50 304 ms, P95 365 ms,
P99 394 ms. Na disputa de 100 reservas: uma criação, 99 conflitos 409 e nenhum
500; banco confirmou uma linha ativa e replay idempotente.

O proprietário esclareceu que não precisa dos pagamentos online de cada
barbearia nesta etapa. Stripe permanece exclusivamente para assinaturas do SaaS;
implementar adquirente/KYC/split das lojas saiu da lista de pendências desta
entrega. Os mecanismos ausentes continuam explicitamente indisponíveis no código.

`PENDENCIAS_PRE_GO_LIVE_ATUAIS.md` consolida a cobertura fiscal ainda incompleta,
homologação externa, percursos de navegador ainda não cobertos e infraestrutura
não exercitada. Verify/medição verdes não encerram esses itens. Commit/push
continuam condicionados à conclusão do escopo autorizado.

Após a medição, a identidade da fonte continuou igual à v6. `git diff --check`
passou, assim como `segredos-estado-v6`, com varredura da árvore e histórico Git.
Não houve mudança de fonte de produto entre o início do verify e esse fechamento
das evidências; apenas relatórios em `output/` foram atualizados.
