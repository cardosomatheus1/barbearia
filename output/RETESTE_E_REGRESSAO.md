# Execução e retestes diagnósticos

Commit `3d90fc62de2947fda05aed32407d5a2f2852340b`. Nenhuma correção de produto foi aplicada; portanto, nenhum achado foi encerrado por reteste. As repetições abaixo esclarecem causas e não substituem uma execução verde da versão corrigida.

## Baseline técnico

Ambiente: Node 22.23.2, pnpm 10.33.0, PostgreSQL 16.15, Chromium 141.0.7390.37, Linux. Dependências instaladas pelo lockfile; Prisma gerado. Banco local isolado, conexão de aplicação `NOBYPASSRLS`, sem chamadas a provedores reais.

O primeiro `pnpm verify` iniciou grande número de processos simultâneos e saturou a memória/CPU desta máquina; foi interrompido e **não tem veredito**. A execução seguinte preservou os comandos do `scripts/verify.sh`, limitando a duas etapas simultâneas e um worker Vitest. O wrapper ficou fora do produto. Reprodução equivalente: `python3 output/executar_verify_limitado.py`, somente com banco local descartável.

O baseline controlado concluiu **99 etapas lançadas**, além das verificações iniciais, em 3.129 s. Saída **1**, com quatro etapas reprovadas: backup shell, scheduling, finance e CRM. Typecheck, builds executados pelo gate, guardas estruturais/negativas restantes e API passaram. A medição executa o build completo, inclusive worker.

| Suite de pacote | Resultado original preservado |
|---|---|
| core | 1.434 aprovados / 74 arquivos |
| UI | 90 aprovados / 4 arquivos |
| web | 187 aprovados / 30 arquivos |
| db | 10 aprovados no cliente; migrações/invariantes SQL também passaram |
| identity | 208 aprovados / 12 arquivos |
| scheduling | 274 aprovados, 7 reprovados / 12 arquivos |
| onboarding | 18 aprovados / 1 arquivo |
| catalog | 53 aprovados / 4 arquivos |
| finance | 510 aprovados, 2 reprovados / 24 arquivos |
| CRM | 387 aprovados, 1 reprovado / 21 arquivos |
| jobs | 100 aprovados / 4 arquivos |
| platform | 223 aprovados / 15 arquivos |
| API | Etapa completa aprovada. A contagem final por arquivo não foi preservada antes da limpeza de logs temporários do script; não foi inventada a partir de contagem estática |

As linhas com contagem acima somam **3.504 casos: 3.494 aprovados e 10 reprovados**, além da API, testes de scripts e invariantes SQL. Não somar repetições desses casos como se fossem cobertura adicional. A aprovação dos testes existentes não certifica todas as regras das 371 rotas inventariadas.

Fontes: [verify-controlled.json](EVIDENCIAS_PRE_GO_LIVE/verify-controlled.json), [verify-controlled.log](EVIDENCIAS_PRE_GO_LIVE/verify-controlled.log), [resumos das 99 etapas](EVIDENCIAS_PRE_GO_LIVE/verify-stages-summary.json), [db-retry.log](EVIDENCIAS_PRE_GO_LIVE/db-retry.log).

## Repetições que explicaram falhas

| Experimento | Resultado | Interpretação |
|---|---|---|
| Oferta com cópia das datas alinhada ao relógio atual | 24 aprovados | Os 7 erros originais decorrem do conflito entre fixture antiga e `now()` do banco |
| Retenção de preview com relógio de fixture atual | 1 aprovado; 37 filtrados | O caso de CRM foi diagnosticado; não houve nova aprovação dos 38 casos nessa repetição |
| Retorno com `created_at` explícito, conforme a história do teste | 2 aprovados; 24 filtrados | Os 2 erros financeiros vieram da fixture, não de uma nova regra de cálculo |
| Backup shell sem chave herdada do processo pai | 2 aprovados | A chave do ambiente contaminava os subprocessos de teste; GCM recusou corretamente a chave divergente |
| Restore com conexão do role da aplicação | Consulta recusada, apesar de ensaio oficial aprovado | AUD-05 reproduzido |
| Restore de schema somente até 0025 | Ensaio oficial aprovado como atual | AUD-12 reproduzido |
| Rollback 0119 com massa sintética | Ensaio retorna 1; comparação textual difere em cast equivalente | Não demonstra perda semântica da constraint; ver diagnóstico em AUD-12 |

Fontes: `fixture-clock-proof-retry`, `return-clock-proof`, `backup-shell-isolated`, `restore-proof`, `rollback-drill`, `rollback-diagnostic` em [EVIDENCIAS_PRE_GO_LIVE](EVIDENCIAS_PRE_GO_LIVE).

## Entradas HTTP e provas independentes

API compilada, com banco real e role restrito:

- **345 rotas protegidas**, incluindo **194 de escrita**, responderam 401 sem credenciais.
- **26 rotas públicas**, incluindo **13 de escrita**, foram exercitadas com entrada mínima/sem parâmetros: 16 responderam 400, 7 responderam 404 e 3 responderam 200 legitimamente (sondas de saúde e catálogo de cidades). Zero 500 nessa amostra.
- A matriz soma as **371 rotas / 207 escritas**, com código HTTP por rota. Isso comprova apenas essa fronteira de entrada; autorização entre usuários autenticados, MFA e negócio são avaliados pelas suites específicas, sem atribuir sua cobertura automaticamente a cada linha.
- Contrato do cartão, adoção incorreta de migrações, perda de grants no restore, gate de deploy e compartilhamento do rate limit foram reproduzidos por scripts independentes em `output/`.

Fontes: [matriz completa](INVENTARIO_E_MATRIZ_DE_COBERTURA.csv), `anonymous-route-sweep.log`, `public-route-sweep-retry.log` e provas referidas em [ACHADOS_PRE_GO_LIVE.md](ACHADOS_PRE_GO_LIVE.md).

## Pilha, navegador e carga

`bash scripts/medicao.sh` passou, com build completo, em **540,33 s**. O script confirmou API/Web/Worker, retomou o worker após SIGKILL, verificou 96 telas/estados em quatro larguras e executou os 10 percursos completos. As duas jornadas adicionais de cliente — remarcar e cancelar — passaram em execução separada da pilha, com sessão sintética e conferência no banco.

Na carga de disponibilidade, 120 amostras com 8 pedidos simultâneos, 5 profissionais e 7 dias de agenda produziram P50 277 ms, **P95 367 ms**, P99 384 ms e 28,2 requisições/s. O teste tinha 755 horários ocupados. O limite de requisições foi elevado conforme o script, portanto isso mede o cenário de capacidade, não certifica a proteção de rate limit de produção.

A disputa de 100 reservas do mesmo slot terminou em **1 criação, 99 respostas 409 e zero 500**, com confirmação de uma linha ativa no banco e replay idempotente. Duração: 1.858 ms. Esses números são desta máquina e massa local; não foram extrapolados para SLA ou capacidade máxima de produção.

Evidências: [medicao-completa.log](EVIDENCIAS_PRE_GO_LIVE/medicao-completa.log), [browser-customer-extra.log](EVIDENCIAS_PRE_GO_LIVE/browser-customer-extra.log).

## Tentativas ambientais, sem atribuição ao produto

- Primeira execução DB: processo local de PostgreSQL iniciado em segundo plano não permaneceu vivo; repetição com processo persistente passou.
- Primeiro verify: interrompido por saturação, sem conclusão.
- Primeiro experimento de relógio: caminho incorreto do executável Vitest; repetido com caminho do pacote.
- Primeiro experimento de proxy: testou representação textual de IP diferente da origem real; repetição corrigida comprovou o bucket compartilhado.
- Primeira sonda pública: a asserção esperava erro no catálogo público de cidades, que legitimamente responde 200; corrigida a classificação, sem mudança no produto.
- Primeira medição tentou reutilizar os builds do verify pulando build; o worker ainda não havia sido compilado. A execução seguinte usa `scripts/medicao.sh` com build completo. A primeira tentativa não conta como falha do worker em produção.
- Os auxiliares `conferir-numeros.mjs` e `conferir-telas.mjs` pressupõem contas fixas de outra fixture. A medição atual cria e-mails dinâmicos; a consulta ao banco confirmou que as contas fixas não existem. As tentativas adicionais pararam no login, mesmo após alinhar a senha da fixture. **As comparações desses dois scripts não foram executadas/aprovadas**, e o 401 não foi classificado como defeito do login do produto. Ver `consistency-cross-domain-retry.log` e `fixture-accounts.log`. A evidência financeira desta auditoria vem das suites e do percurso de venda, sem alegar uma conferência independente completa de todos os relatórios.

## Condições para encerrar os achados

Após alterações, registrar novo SHA; retestar cada cenário que reproduziu o problema e os consumidores afetados. Para mudanças financeiras, incluir caixa, comissão, estoque, DRE e worker. Para identidade/tenant, repetir acessos entre tenants, entre clientes do mesmo tenant e entre unidades com sessões reais. Depois executar o gate integral e a medição sem concorrência com outras suites.

Pagamentos, WhatsApp e fiscal exigem os testes externos da [matriz de homologação](HOMOLOGACAO_PAGAMENTOS_WHATSAPP_FISCAL.md). Restore operacional exige artefato remoto, mídia/chaves, aplicação com role restrito e infraestrutura representativa. Esses requisitos permanecem pendentes e não são substituídos pelos retestes diagnósticos desta auditoria.
