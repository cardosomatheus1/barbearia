# Achados da auditoria pré-go-live

Repositório `cardosomatheus1/barbearia`, commit `3d90fc62de2947fda05aed32407d5a2f2852340b`. Auditoria em 09/09/2026, ambiente local isolado. Todos os itens abaixo estão **abertos**; nenhuma correção de produto foi aplicada. Os responsáveis indicados são funções a atribuir, não pessoas que já aceitaram trabalho.

Severidade descreve o impacto. Prioridade **P0** bloqueia o lançamento completo contratado; **P1** exige correção/avaliação antes de liberar, com reteste. Lacuna de implementação, falha reproduzida e ausência de homologação são registradas separadamente. Não foi demonstrada exploração remota, tomada de conta ou vazamento entre tenants.

| ID | Severidade / prioridade | Resultado |
|---|---|---|
| AUD-01 | Alta / P0 | Cartão da comanda cria intenção sem caminho de captura/confirmação |
| AUD-02 | Alta / P0 | Fiscal real não está implementado; lacuna já informada pelo proprietário |
| AUD-03 | Alta / P0 no escopo correspondente | Split e cobrança recorrente do clube não têm provedores reais |
| AUD-04 | Alta / P0 | Retomada de migração registra 83 migrações que não foram aplicadas |
| AUD-05 | Alta / P0 | Ensaio de restore aprova banco sem permissões para a aplicação |
| AUD-06 | Alta / P0 | Autoatualização aceita verificações obrigatórias ausentes ou puladas |
| AUD-07 | Alta / P0 | Critério HTTP do deploy aprova homepage sem API/worker funcionando |
| AUD-08 | Alta / P0 | Lockfile contém dependências com advisories altos/críticos; gate reprova |
| AUD-09 | Alta / P0 | Compose entrega credenciais administrativas do banco aos runtimes |
| AUD-10 | Média / P1 | Clientes do site compartilham o limite por IP da API |
| AUD-11 | Média / P1 | Dez testes dependem indevidamente da data real de execução |
| AUD-12 | Média / P1 | Verificadores de recuperação dão respostas incorretas sobre o schema |
| AUD-13 | Média / P1 | Varredura histórica acusa três fixtures e interrompe o CI |
| AUD-14 | Média / P1, bloqueia homologação de filiais | Conciliação periódica de WhatsApp contempla somente a unidade principal |

## AUD-01 — cartão sem captura ou confirmação

**Prova:** análise do caminho completo e execução do adapter compilado com resposta HTTP injetada; sem chamada à Stripe. Fonte: `packages/platform/src/stripe-pagamento.ts:155–195` e `apps/web/src/app/admin/comanda/[id]/page.tsx:113` e componente `CobrancaEmCurso`.

O meio `cartao` envia `payment_method_types: ['card']`, sem instrumento de pagamento e sem confirmação. O adapter descarta o `client_secret`; a resposta à aplicação não oferece checkout nem outro caminho de captura. A tela oferece “Cartão” e, depois, espera confirmação, mas só desenha ação de pagamento quando recebe QR/link. Não foi encontrado consumidor de captura/confirmação de cartão nesse fluxo.

**Observado:** intenção aguardando, sem URL e sem material para concluir o pagamento. **Esperado:** o cliente consegue apresentar cartão de forma segura, concluir autenticação adicional quando necessária e ter a comanda conciliada.

**Impacto:** configurar a chave Stripe não completa esse meio. O link hospedado é um caminho distinto e também precisa de homologação própria; seu funcionamento não certifica a opção “Cartão”.

**Correção e aceite:** responsável financeiro/backend/web deve integrar checkout ou componente de captura do adquirente, concluir o contrato de retorno e testar aprovação, recusa, autenticação adicional, abandono, webhook/reconciliação e estorno. Não tratar um PaymentIntent criado como pagamento realizado.

Evidência: [payment-contract.log](EVIDENCIAS_PRE_GO_LIVE/payment-contract.log). Reprodução: `node output/prova_contrato_pagamentos.mjs`.

## AUD-02 — fiscal real ausente

**Prova:** código e execução da seleção de provider. `packages/finance/src/fiscal-emissor.ts:3–39` aceita somente `nenhum` e `fake`; este último é recusado em produção. A trava é correta, mas nenhum valor de configuração liga um emissor real.

**Impacto:** o lançamento completo solicitado não pode emitir documentos fiscais reais. Trata-se da lacuna informada pelo proprietário, confirmada no código, e não de um defeito descoberto em emissão de produção.

**Correção e aceite:** responsável fiscal/contábil define documentos, municípios, regimes e provedor; engenharia implementa o adapter e o ciclo assíncrono. Homologar autorização, rejeição, timeout incerto, reconsulta, repetição, cancelamento, vínculo com a venda e isolamento por emitente. Não emitir documentos reais para preencher a evidência local.

Evidência: [payment-contract.log](EVIDENCIAS_PRE_GO_LIVE/payment-contract.log) e [matriz de homologação](HOMOLOGACAO_PAGAMENTOS_WHATSAPP_FISCAL.md).

## AUD-03 — split e recorrência ainda simulados

**Prova estática:** `packages/platform/src/adquirente.ts:111`, `apps/worker/src/main.ts:371–385` e `:964`. O worker instancia `FakeSplitProvider` e `FakeCobrancaDoClubeProvider`, independentemente da seleção Stripe. A captura/tokenização do cartão do clube também está declarada como pendente no roadmap.

**Comportamento atual:** o fake do clube recusa cobrança e o fake do split mantém cadastro pendente/recusa repasse. Não há evidência de que esse código simule recebimento aprovado; o problema é a capacidade automatizada ausente. Recebimento manual do clube e pagamento manual de comissões são fluxos diferentes.

**Impacto:** configurar pagamentos não entrega repasse automático nem recorrência. Como a auditoria é do lançamento completo, essas capacidades precisam ser concluídas quando incluídas na oferta, ou ter sua exclusão comercial explicitamente decidida pelo proprietário; a auditoria não as excluiu para aprovar a versão.

**Correção e aceite:** engenharia financeira integra recebedores, KYC, tokenização/mandato e cobrança recorrente conforme contratos do provedor. Conferir valor efetivamente cobrado/liquidado, reentregas, inadimplência, estorno e fechamento de comissão, sem PAN/CVV no software.

## AUD-04 — adoção indevida do baseline de migração

**Prova dinâmica:** `packages/db/scripts/migrate.sh:63–79`. Em banco com journal vazio e qualquer tabela pública, o migrador marca todas as migrações até `0083` como aplicadas, sem validar o schema.

**Reprodução:** aplicar somente o SQL da `0001`, simulando interrupção após commit e antes de registrar o journal; reiniciar o migrador. **Observado:** 83 registros de migração; `staff_users` continua inexistente; execução falha na `0084` por ausência de `whatsapp_settings`. A aplicação limpa das 119 migrações e a segunda execução sem alterações passaram separadamente.

**Impacto:** uma instalação interrompida ou um banco preexistente incompleto recebe histórico falso. A retomada não restaura uma base confiável; reparo manual feito sobre esse journal pode agravar a inconsistência.

**Correção e aceite:** responsável banco/infra deve separar adoção explícita de legado da execução normal, validar baseline por schema/checksum e documentar recuperação da janela não atômica. Repetir banco vazio, baseline legítimo, baseline incompleto, falha intermediária e migradores concorrentes.

Evidência: [migrations-independent.log](EVIDENCIAS_PRE_GO_LIVE/migrations-independent.log). Reprodução isolada: `python3 output/prova_migracoes.py`.

## AUD-05 — restore sem grants da aplicação

**Prova dinâmica:** `scripts/ensaio-de-restauracao.sh` usa dump/restore sem privilégios e verifica o resultado com a conexão administrativa. O ensaio oficial retornou sucesso, “restaura e serve”.

Repetindo os mesmos parâmetros de restauração, `has_table_privilege` para `barbearia_app` mudou de verdadeiro para falso. Uma consulta com esse role falhou com `permission denied for table customers`. `scripts/ensaio-de-rollback.sh` também restaura com `--no-privileges`.

**Impacto:** presença de tabelas, linhas e políticas não basta: a aplicação pode permanecer indisponível após a recuperação aprovada pelo ensaio. O resultado não demonstra que backups externos de produção foram perdidos; demonstra que o procedimento testado não certifica uma base utilizável.

**Correção e aceite:** preservar/restabelecer grants, ownership e roles de forma controlada. Conferir conexão com o role real da aplicação, RLS, login, reserva, caixa e job no banco restaurado; testar também acesso negado entre tenants. Medir RPO/RTO com volume e armazenamento representativos.

Evidência: [restore-proof.log](EVIDENCIAS_PRE_GO_LIVE/restore-proof.log). Reprodução isolada: `python3 output/prova_restore.py`.

## AUD-06 — gate de deploy incompleto

**Prova dinâmica do verificador, sem executar deploy:** `deploy/auto-atualizar.sh:45` e bloco de leitura de `check-runs`. `EXIGIR_ESTEIRA` começa desligado. Quando ligado, basta haver checks concluídos e nenhum com conclusão fora de `success`, `neutral`, `skipped`; os nomes dos dois jobs obrigatórios não são exigidos.

**Observado:** somente um lint aprovado é aceito; os dois jobs obrigatórios pulados também são aceitos. Lista vazia é recusada corretamente. No SHA auditado, a consulta real ao GitHub encontrou `pnpm verify=failure` e `pilha, navegador e cargas=skipped`; portanto, com a exigência ligada, esse estado específico seria recusado. Não se afirma que houve deploy indevido.

Há ainda uma janela identificada estaticamente: o script consulta um SHA, mas chama `atualizar.sh`, que busca e reseta para a ponta atual da branch (`:40–41`). O artefato aplicado não é fixado ao SHA cujo resultado foi consultado.

**Correção e aceite:** infraestrutura deve exigir ambos os jobs, com conclusão `success`, no SHA e workflow esperados, e aplicar exatamente esse artefato. Cobrir check ausente, pulado, neutro, cancelado, em execução, reexecução e avanço da branch entre verificação e aplicação.

Evidências: [deploy-gate.log](EVIDENCIAS_PRE_GO_LIVE/deploy-gate.log), [github-checks.json](EVIDENCIAS_PRE_GO_LIVE/github-checks.json). Reprodução: `python3 output/prova_gate_deploy.py`.

## AUD-07 — homepage é uma prova insuficiente para concluir o deploy

**Prova dinâmica parcial da topologia:** `deploy/atualizar.sh:93`, `deploy/voltar.sh:55` e checagem de recuperação de `auto-atualizar.sh` usam `GET /` para decidir se o site responde. O Next compilado retornou HTTP 200 com `API_URL` apontando para porta sem API e sem worker.

**Impacto:** esses critérios podem aceitar um site cuja operação está interrompida. O compose possui healthcheck da API na partida; isso é proteção adicional, mas não torna a homepage uma prova da saúde posterior do worker ou dos fluxos.

**Correção e aceite:** conferir prontidão da API com role restrito, heartbeat/progresso do worker e smoke funcional sem efeitos externos. Induzir falha da API, do banco e do worker separadamente; o gate deve recusar a versão e sinalizar o componente correto. Não foi executado rollback/deploy em servidor real.

Evidência: [readiness-proof.log](EVIDENCIAS_PRE_GO_LIVE/readiness-proof.log).

## AUD-08 — vulnerabilidades conhecidas no lockfile

**Prova:** `pnpm audit` e `pnpm audit --prod`, ambos com corte high, retornaram código 1. O inventário de produção reportou **2 critical, 8 high, 4 moderate e 1 low**; são contagens do scanner, não quantidade de explorações demonstradas.

| Dependência / versão resolvida | Principal avaliação de alcance |
|---|---|
| Next `15.5.23` | GHSA-2xp9-vwfh-vxw4: API de otimização AVIF; versão corrigida indicada `>=15.5.24`. GHSA-p293-qw3h-jr36 é específico de Windows, incompatível com o alvo Linux examinado |
| sharp `0.34.5` | Bibliotecas libvips/libheif afetadas; correção indicada pelos advisories até `>=0.35.4` |
| PostCSS `8.4.31` | Leitura de source maps controlados; avaliar entradas do build. Correção indicada até `>=8.5.18` |
| multer `2.2.0` | DoS de multipart; não foi encontrado consumidor `FileInterceptor`/Multer. Não equivale a endpoint explorável comprovado. Correção indicada `>=2.3.0` |
| deepmerge-ts `7.1.5` | Exaustão de pilha em grafos recursivos; avaliar caminho Prisma/tooling. Correção indicada `>=8.0.0` |
| Vitest `2.1.9` e Vite `5.4.21` | Achados adicionais na árvore completa. O advisory crítico do Vitest depende do servidor UI exposto; a execução de testes sem UI não demonstra esse risco em produção |

O código web usa imagens comuns e restringe upload a PNG/JPEG/WebP; isso limita os caminhos examinados, mas não prova que toda superfície do otimizador está inacessível. Não foi executado exploit. Consultar os JSONs do scanner para todos os IDs, caminhos e versões; as versões acima são as recomendadas pela base de advisories consultada nesta data.

**Correção e aceite:** responsável dependências/segurança atualiza versões compatíveis e bibliotecas transitivas; repete build, fluxos de upload/imagem, suites afetadas e auditoria. Exceção exige alcance/mitigação demonstrados por advisory, sem tratar todas as ocorrências como RCE ou descartar o alerta só por ser transitivo.

Evidências: [dependency-audit-prod.log](EVIDENCIAS_PRE_GO_LIVE/dependency-audit-prod.log), [dependency-audit.log](EVIDENCIAS_PRE_GO_LIVE/dependency-audit.log).

## AUD-09 — privilégios administrativos disponíveis aos runtimes

**Prova estática:** `deploy/compose.yml:43–75`, serviços `api`, `worker` e `web`. O mesmo bloco de ambiente inclui `POSTGRES_PASSWORD`, `ADMIN_DATABASE_URL`, chaves de criptografia/backup e credenciais de provedores.

**Impacto:** a aplicação conecta normalmente com role restrito, mas o processo tem material para obter poderes administrativos se comprometido. O servidor web também recebe credenciais que seus clientes HTTP não exigem. Isso amplia o impacto de uma vulnerabilidade de aplicação e enfraquece a separação obtida pela RLS.

**Correção e aceite:** infraestrutura deve separar ambiente de preparação/migração, backup, API, web e worker pelo mínimo necessário. Conferir o ambiente efetivo dos contêineres sem registrar valores secretos. Não foi inspecionado o ambiente de uma instalação real nem demonstrada leitura desses valores pelo navegador.

## AUD-10 — limite por IP compartilhado entre visitantes

**Prova dinâmica:** Next e API compilados. `apps/web/src/lib/api.ts:102` e demais wrappers fazem chamadas servidor → API sem encaminhar identidade de rede do visitante. `apps/api/src/main.ts` confia em um salto de proxy; a API acaba identificando o servidor web. O padrão em `common/throttler.config.ts` é 20 chamadas/10 s e 120/minuto por handler/IP.

Com limite reduzido para 2 na reprodução, clientes diretos com IPs distintos mantiveram buckets separados. Visitantes com três IPs distintos apresentados ao Next consumiram o bucket do servidor web; uma consulta desse endereço recebeu 429 enquanto outro IP direto continuou recebendo a resposta normal 404 de slug inexistente.

**Limite da prova:** os slugs do experimento eram inexistentes; a evidência demonstra a identidade compartilhada e o 429, não uma medição de indisponibilidade de uma loja real nem a capacidade sob tráfego de produção. A primeira tentativa testava a forma textual errada do IP local; a repetição usa o endereço de origem efetivo.

**Correção e aceite:** encaminhar identidade de cliente validada pelo proxy confiável, preservar isolamento da API interna e impedir falsificação de headers. Testar dois usuários, duas barbearias, cache e server actions com a topologia final e limites de produção; um visitante exceder seu limite não deve bloquear os demais.

Evidência: [proxy-rate-limit-retry.log](EVIDENCIAS_PRE_GO_LIVE/proxy-rate-limit-retry.log). Reprodução: `python3 output/prova_proxy_rate_limit.py`.

## AUD-11 — fixtures dependentes do relógio real

**Prova:** baseline original reprovou 7 testes de `scheduling/oferta.integration.test.ts`, 1 de `crm/importacao.integration.test.ts` e 2 de `finance/desempenho.integration.test.ts`.

- Oferta usa `AGORA=2026-09-07` e vaga `2026-09-08`, mas consultas de hold usam `now()` do PostgreSQL (`booking.ts:458`). O hold já expirou na data da auditoria.
- Importação mistura `AGORA=2026-08-08` com `created_at = now() - interval '30 days'`; a limpeza recebe o relógio antigo.
- Retorno do profissional afirma que a próxima reserva foi criada no dia do atendimento, mas omite `created_at`; o default grava a data real. A consulta corretamente deixa de contar essa reserva posterior.

Em cópias isoladas dos testes, sem mudar código de produto ou asserções, atualizar o relógio/datas da oferta fez os 24 casos passarem; alinhar a fixture de importação fez o caso afetado passar; declarar a criação da reserva no dia indicado fez os 2 casos financeiros passarem. Os demais casos de CRM/finance foram **filtrados**, não declarados aprovados nessas repetições.

**Impacto:** a regressão original permanece vermelha. Não há fundamento, nesses dez resultados, para afirmar quebra atual da agenda, retenção LGPD ou taxa financeira em produção.

Separadamente, os 2 casos de `scripts/backup-shell.test.mjs` herdaram `BACKUP_ENCRYPTION_KEY` do ambiente da auditoria, cifraram com ela e tentaram decifrar com a chave diferente da fixture. A recusa GCM era correta. Repetir esses testes com `env -u BACKUP_ENCRYPTION_KEY` fez ambos passarem; não é prova de falha da criptografia de backup. Os testes devem controlar o ambiente do subprocesso. Evidência: [backup-shell-isolated.log](EVIDENCIAS_PRE_GO_LIVE/backup-shell-isolated.log).

**Correção e aceite:** responsável testes/domínio alinha fontes de tempo e fixtures; preserva casos de expiração e limites. Executar em datas diferentes e repetir os pacotes originais completos após a correção.

Evidências: [fixture-clock-proof-retry.log](EVIDENCIAS_PRE_GO_LIVE/fixture-clock-proof-retry.log), [return-clock-proof.log](EVIDENCIAS_PRE_GO_LIVE/return-clock-proof.log). Scripts: `prova_relogios.py`, `prova_retorno_fixture.py`.

## AUD-12 — verificação incorreta da versão restaurada

**Duas provas independentes:** o ensaio de restauração aceitou uma base que recebeu somente migrações `0001–0025` como se tivesse o schema atual `0119`, porque procura uma coluna antiga específica. O ensaio de rollback, por sua vez, retornou falha ao comparar hashes de definições SQL textuais equivalentes.

No segundo caso, a diferença isolada foi a representação de cast do array no CHECK `notification_send_intents_status_check`: cast do array inteiro versus cast de cada elemento. Contagens de tabelas, clientes e políticas coincidiram. Não foi demonstrada perda semântica do CHECK nem restauração de “banco errado”, apesar da mensagem emitida.

**Impacto:** o diagnóstico operacional não distingue banco antigo, diferenças de serialização e incompatibilidade real. É separado da perda efetiva de grants em AUD-05.

**Correção e aceite:** validar versão e invariantes com base no journal/schema efetivos e exercitar a aplicação; normalizar diferenças equivalentes antes de comparar. Cobrir banco antigo, objeto ausente, constraint alterada, grant ausente e representação equivalente.

Evidências: [restore-proof.log](EVIDENCIAS_PRE_GO_LIVE/restore-proof.log), [rollback-drill.log](EVIDENCIAS_PRE_GO_LIVE/rollback-drill.log), [rollback-diagnostic.log](EVIDENCIAS_PRE_GO_LIVE/rollback-diagnostic.log). O tempo local de restauração de aproximadamente 10,6 s não certifica RTO de produção.

## AUD-13 — falsos positivos no scanner histórico

**Prova:** varredura com histórico completo retornou 3 ocorrências, todas localizadas em fixtures de teste: `scripts/verificar-configuracao-producao.test.mjs`, `scripts/env-example.test.mjs` e `apps/api/test/plataforma.e2e.test.ts`. A varredura de snapshot exclui esse tipo de caminho da regra de literal genérico; a varredura de diffs históricos perde a informação de caminho e não aplica a mesma exclusão.

**Impacto:** essa etapa antecede instalação/verify no CI e bloqueia a esteira. Esses três matches não são evidência de vazamento de credenciais operacionais. Também não equivalem a certificação de ausência de todos os segredos possíveis; o scanner tem padrões e limites próprios.

**Correção e aceite:** manter contexto de arquivo/commit na leitura dos diffs e exceções precisas para fixtures, conservando detecção de chaves reais em arquivos de teste. Não resolver com exclusão geral do histórico ou do scanner. Valores encontrados foram omitidos dos artefatos.

Evidências: [secret-history.log](EVIDENCIAS_PRE_GO_LIVE/secret-history.log), [secret-history-triage.json](EVIDENCIAS_PRE_GO_LIVE/secret-history-triage.json).

## AUD-14 — conciliação WhatsApp somente na matriz

**Prova estática:** `apps/worker/src/main.ts:500–503` resolve `primaryLocation` e executa `conciliarWhatsAppDaUnidade` somente para ela, embora o cadastro seja por unidade. A limitação também consta no roadmap. A submissão de templates já considera a unidade do template; isso não amplia automaticamente a conciliação periódica.

**Impacto:** uma filial com conta/número próprios não recebe a mesma varredura de conciliação da matriz. A liberação Meta informada pelo proprietário resolve o pré-requisito de acesso à plataforma, mas não esse recorte do código nem a homologação dos fluxos.

**Correção e aceite:** CRM/worker deve varrer as unidades elegíveis, com credenciais, templates e estado corretos por unidade; testar contas/números distintos, atraso de aprovação e falha de uma filial sem interromper as demais. Nenhuma mensagem foi enviada à Meta nesta auditoria.

## Ordem recomendada de tratamento

1. Concluir o contrato de lançamento de pagamentos/fiscal e implementar as capacidades ausentes (AUD-01–03), em paralelo à preparação das contas de homologação pelo proprietário.
2. Corrigir recuperação, migração e seleção do artefato (AUD-04–07 e AUD-12). Uma liberação sem retorno confiável não está pronta para receber dados reais.
3. Atualizar dependências e reduzir privilégios dos processos (AUD-08–09); tratar a identidade do visitante no proxy (AUD-10).
4. Corrigir fixtures e scanner para obter uma regressão confiável (AUD-11 e AUD-13), completar WhatsApp por unidade (AUD-14) e executar homologações.
5. Retestar cada achado, executar regressão completa e repetir medição/ensaios na versão candidata e infraestrutura de destino. Apenas então emitir novo parecer de go-live.
