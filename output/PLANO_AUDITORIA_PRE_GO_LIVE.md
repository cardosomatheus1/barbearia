# Plano de auditoria geral pré-go-live — Barberdock

Data: 09/09/2026. Versão: 1.

**Objetivo:** produzir uma decisão de liberação sustentada por evidências sobre segurança, integridade dos dados, correção do negócio e capacidade de operação do software inteiro.

**Escopo definido pelo proprietário:** lançamento completo, incluindo pagamentos, WhatsApp e fiscal. Fiscal ainda não implementado; pagamentos pendentes de configuração; liberação da Meta já obtida. A auditoria deve incorporar essas condições sem reduzir o lançamento a um piloto de agenda e caixa.

**Estado deste documento:** planejamento baseado em inspeção estática do repositório. Não representa auditoria executada, aprovação de produção nem autorização para implementar, configurar provedores, emitir documentos, movimentar dinheiro ou publicar uma versão.

## 1. Base examinada e dimensão do trabalho

- Repositório: <https://github.com/cardosomatheus1/barbearia>.
- Branch consultada: `claude/barbershop-app-research-xvejhy`.
- Commit inspecionado: `3d90fc62de2947fda05aed32407d5a2f2852340b`.
- Inventário inicial por arquivos: **3 aplicações, 11 pacotes, 64 controllers de API, 80 páginas Next.js e 119 migrações SQL**. Controllers não equivalem a endpoints; a contagem de rotas efetivas é parte da etapa A0.
- Aplicações: API NestJS, web Next.js e worker Node.js.
- Pacotes: `core`, `db`, `identity`, `onboarding`, `catalog`, `scheduling`, `finance`, `crm`, `jobs`, `platform`, `ui`.
- Banco PostgreSQL, RLS por tenant, consultas Prisma/SQL, fila no banco e deploy Docker/Caddy.

Fontes principais: [regras de engenharia](../CLAUDE.md), [roadmap](../ROADMAP.md), [especificação](../SPEC.md), [checklist anterior de go-live](../docs/go-live.md), [CI](../.github/workflows/portao.yml), código dos módulos e scripts de verificação/deploy.

Nesta preparação foram consultados a API pública do GitHub, um clone isolado e arquivos locais, com `git`, `rg` e scripts Python de inventário. Não foram instaladas dependências, executadas suítes, iniciadas aplicações ou acessados ambientes e contas externas. O clone é raso: uma futura análise de segredos no histórico exige obter o histórico completo.

### Pontos que mudam a ordem da auditoria

| Observação | Evidência inicial | Consequência para o plano |
|---|---|---|
| Não existe emissor fiscal real selecionável | [`fiscal-emissor.ts`](../packages/finance/src/fiscal-emissor.ts) limita o modo a `nenhum` e `fake` | Implementação, contratação/configuração e homologação fiscal são pré-requisitos do lançamento completo |
| Há adapters Stripe no código | [`stripe-pagamento.ts`](../packages/platform/src/stripe-pagamento.ts) | Configurar e certificar cada fluxo e meio; a existência do adapter não prova operação |
| Split ainda usa provedor simulado | [`adquirente.ts`](../packages/platform/src/adquirente.ts) e [`apps/worker/src/main.ts`](../apps/worker/src/main.ts) | Configurar Stripe não entrega automaticamente split; tratá-lo como capacidade separada |
| Captura/tokenização do cartão recorrente consta como pendente | Lacuna “Tokenizar o cartão do assinante” no [roadmap](../ROADMAP.md) | Confirmar a lacuna no fluxo atual e fechar a captura segura e o ciclo real se recorrência fizer parte da oferta |
| Existem provider Meta, cadastro e webhook | [`whatsapp-meta.ts`](../packages/crm/src/whatsapp-meta.ts), [`whatsapp-signup.ts`](../packages/crm/src/whatsapp-signup.ts), [`whatsapp-webhook.controller.ts`](../apps/api/src/plataforma/whatsapp-webhook.controller.ts) | Aproveitar a liberação Meta informada para certificar a integração, incluindo o vínculo correto por barbearia/unidade |
| Há dez percursos de navegador declarados no script | [`percorrer.mjs`](../scripts/percorrer.mjs) | Inventariar a cobertura efetiva e acrescentar os ciclos críticos ausentes; não presumir que os dez passaram neste commit |
| O código contém CI e mais migrações que alguns documentos citam | [workflow](../.github/workflows/portao.yml), [migrações](../packages/db/migrations), textos que ainda citam `0117` ou ausência de CI | Reconciliar documentação e evidências com o commit da liberação, cujo snapshot atual chega a `0119` |

Auditorias anteriores, comentários, contagens de testes e marcas de conclusão são pistas para revalidação. Um bloqueio por falta de prova deve ser distinguido de um defeito reproduzido.

## 2. Regras de execução e cobertura

1. Fixar um commit candidato. Cada evidência registra commit, configuração, versão de banco e ambiente. Alterações posteriores exigem análise de impacto e novos testes dos consumidores afetados.
2. Auditar todos os pacotes e superfícies, inclusive funcionalidades desligadas que mantenham rotas, jobs ou dados acessíveis. Profundidade máxima nas fronteiras de autorização, dinheiro, concorrência, dados pessoais e integrações.
3. Criar matriz rastreável: requisito/capacidade → tela/rota/job → regra → tabela/provider → cenário → evidência → decisão. Toda rota de escrita e toda fronteira de permissão deve aparecer nela.
4. Usar pelo menos duas barbearias, duas unidades em uma delas, dois clientes na mesma barbearia e todos os perfis relevantes. Isso separa isolamento entre tenants, entre unidades e entre pessoas do mesmo tenant.
5. Testar por tela e HTTP direto: botão escondido não comprova autorização. Testar com o role restrito da aplicação: conexão administrativa não comprova RLS.
6. Executar código de produção compilado, com API, Web, Worker, proxy e banco juntos. Testes que montam módulos internamente não comprovam bootstrap e configuração reais.
7. Usar bancos descartáveis, dados sintéticos e contas de homologação. Ler previamente scripts que criam/apagam bancos, reiniciam serviços, semeiam dados ou alteram o checkout. Ensaios de carga não podem atingir produção.
8. Começar por verificações direcionadas. Executar a regressão integral após consolidar as correções. Medições de desempenho rodam sem outras suítes disputando CPU/banco.
9. Não aceitar apenas guardas que procuram texto no código. Conferir comportamento real e demonstrar, em amostras de regras críticas, que o teste falha quando a garantia é removida em uma cópia descartável.
10. Separar quatro resultados: **código verificado**, **integração homologada**, **operação ensaiada**, **versão liberada**. Um resultado não substitui o seguinte.

## 3. Etapas, escopo e critérios de aceite

### A0 — Inventário, contrato de lançamento e ambiente

**Trabalho:** enumerar rotas HTTP, páginas, ações de servidor, jobs periódicos, tabelas, funções SQL privilegiadas, integrações, feature flags e versões resolvidas do lockfile. Identificar chamadas sem consumidor e funcionalidades com interface sem efeito. Cruzar SPEC, roadmap, material comercial e implementação.

Formalizar os meios de pagamento prometidos, quem recebe o dinheiro, cobrança do SaaS versus cobrança da barbearia, recorrência, sinal e split. Para fiscal, definir emissor, municípios/regimes atendidos, documentos de serviço/produto e responsabilidades de configuração tributária. Para WhatsApp, registrar WABA/número por barbearia/unidade e quais jornadas devem funcionar: avisos, campanhas, OTP, atendimento e agendamento por conversa.

Registrar infraestrutura alvo, volume esperado de tenants/agenda/transações, pico simultâneo, SLOs, janela de liberação e responsáveis. Essas definições são entradas do trabalho, não motivo para interromper a inspeção dos demais módulos.

**Aceite:** inventário completo, matriz de capacidades acordada e ambiente de auditoria isolado. Para este plano, fiscal permanece obrigatório; split, recorrência, sinal e outras capacidades anunciadas não podem ser excluídos silenciosamente para obter aprovação.

### A1 — Build, dependências, arquitetura e qualidade dos testes

**Onde:** manifests, lockfile, `core`, exports dos pacotes, `apps/*`, `scripts/verify.sh`, CI, Dockerfile.

**Verificar:** instalação reproduzível com Node 22 e pnpm do manifest; geração Prisma; typecheck; build limpo; imports entre pacotes e arquivos compilados; dependências transitivas vulneráveis; segredos no snapshot e no histórico; imagens e actions utilizadas; dependências/licenças incompatíveis com a distribuição prevista.

Revisar tratamento de exceções, timeouts, recursos sem fechamento, duplicação de regras financeiras, ciclos de dependência, pontos de alta complexidade e código morto. Conferir independência de `core`, contratos HTTP e transformação de dados entre formulário, API e domínio.

Auditar o próprio portão: suites descobertas versus existentes, testes pulados, mocks das garantias centrais, execução dos testes negativos e captura de falhas de processos filhos. Verificar que a configuração de release exige sucesso tanto do job `portao` quanto de `medicao` no mesmo commit.

**Aceite:** build e suites reproduzíveis, nenhuma suíte obrigatória pulada e nenhuma vulnerabilidade alta/crítica sem correção ou mitigação comprovada. Lista explícita das lacunas que exigem testes novos.

### A2 — Identidade, autorização e isolamento

**Onde:** `identity`, guards/controllers da API, sessões e middleware web, `platform`, `db/client.ts`, RLS e funções SQL.

**Cenários obrigatórios:** cliente A acessa/cancela/reagenda dados do cliente B; funcionário de uma unidade acessa outra; tenant A fornece IDs de tenant B em leitura, escrita, FK, upload, importação, exportação e job. Reusar conexões do pool entre tenants e depois de rollback. Testar contexto ausente e malformado.

Revisar OTP, senha, convite, primeiro acesso, troca e revogação de sessão, força bruta, enumeração, cookies, CSRF, XSS, origem de requisições, API keys e limitação de requisições. Testar a topologia real do proxy, falsificação de IP encaminhado e limites com mais de um processo.

Construir matriz de permissões para cliente, barbeiro, recepção, gerente, dono e papéis da plataforma. Exercitar promoção de papel, concessão de permissão, impersonação, MFA e prova expirada, inclusive endpoints financeiros classificados como configuração. Revisar exceções sem RLS e privilégios de funções `SECURITY DEFINER`.

**Aceite:** nenhuma leitura/escrita indevida, escalada de privilégio ou herança de tenant. MFA e revogação respeitam a política efetivamente configurada; recusas deixam os dados inalterados e a auditoria registra ações privilegiadas.

### A3 — Cadastro, onboarding, agenda e atendimento

**Onde:** `onboarding`, `catalog`, `scheduling`, regras de `core` e telas públicas/balcão/barbeiro.

**Verificar:** abertura de conta até publicação utilizável; catálogo, serviços, combos, duração, preços, recursos, profissionais, jornada, feriados e exceções. Alteração/desativação de cadastro com reservas existentes. Fuso da unidade, virada de dia, antecedência e fronteiras de intervalos.

Percorrer reservar → confirmar → chegar → iniciar → concluir → cobrar; cancelar e remarcar pelo cliente; walk-in; fila; espera, oferta, expiração e aceite; falta e justificativa; operação simultânea de duas unidades. Testar informações adulteradas, catálogo alterado entre consulta e confirmação e todos os estados não terminais.

Concorrência: 100 clientes disputando o mesmo slot; disputa por recurso compartilhado; remarcação contra nova reserva; bloqueio de jornada contra reserva; duas pessoas aceitando a mesma oferta; retransmissão com a mesma chave de idempotência e payload diferente.

**Aceite:** no ensaio de slot único, exatamente 1 reserva, 99 conflitos de domínio e zero 500, com conferência do banco. Demais disputas preservam capacidade, vínculos e estados. Nenhum estado operacional fica sem saída na interface.

### A4 — Financeiro, estoque e consistência entre módulos

**Onde:** `finance`, `core`, API e telas de caixa/comanda/comissão/resultado, jobs financeiros.

**Verificar:** abrir/fechar caixa, comanda repetida, alteração após fechamento, meios combinados, dinheiro e troco, desconto, gorjeta, fiado, baixa parcial, vale/adiantamento e estorno parcial/total. Comissões percentuais/progressivas, regra congelada, taxa do adquirente, competência e fechamento.

Cobrir estoque de revenda e consumo, devolução, compra, pacote, fidelidade, assinatura e uso entre unidades. Exercitar venda concorrente do último saldo/benefício, fechamento de comissão contra estorno e retirada de permissão durante operação.

Criar uma massa financeira com resultado esperado calculado independentemente do código: centavos, arredondamentos, receita, passivo/créditos, gorjeta, comissão, estoque e taxas. Comparar livro de movimentos, caixa, relatórios, DRE, tela do barbeiro e plataforma. Diferenciar taxa estimada de taxa efetivamente liquidada.

**Aceite:** nenhuma diferença inexplicada, efeito duplicado ou saldo consumido duas vezes. Toda divergência entre telas sobre o mesmo fato é investigada; estorno recompõe os efeitos previstos e mantém trilha.

### A5 — Pagamentos externos: configuração e homologação por capacidade

**Onde:** `platform/stripe*.ts`, `adquirente.ts`, `finance/cobranca-*`, `estorno`, `split`, webhooks e worker.

**Preparação:** configurar conta de teste, URLs públicas, segredos e meios habilitados; distinguir cobrança da plataforma, venda da barbearia, recorrência e recebedores. Verificar que credenciais de homologação/live e contas de tenants não se misturam. Não solicitar ou registrar números completos de cartão; captura por componente/checkout do adquirente.

**Matriz mínima:** cobrança aprovada, recusada, cancelada e expirada; Pix/cartão/link conforme oferta; autenticação adicional quando aplicável; timeout antes e depois da aceitação; retry; evento duplicado, concorrente, atrasado e fora de ordem; assinatura inválida; valor/moeda/conta divergentes; retorno do navegador sem webhook; webhook sem retorno; conciliação de evento perdido; estorno parcial/total e sua recusa.

Testar o serviço externo aceitando a cobrança e o banco local falhando antes de registrar o resultado. Repetir para estorno. A recuperação deve consultar/reconciliar a operação e evitar um segundo movimento.

**Entregas a esclarecer na implementação:** adapter real de split e KYC/repasse; captura do token e cobrança do clube; sinal online e devolução; uso da taxa real. Há pendências declaradas além da simples configuração da Stripe. Confirmar cada uma no código e incluí-la no backlog de lançamento quando fizer parte da matriz A0.

**Aceite:** provar, por capacidade, tela → API → adquirente → webhook/consulta → banco → caixa/razão/comissão. Nenhum pagamento concluído apenas pelo retorno do navegador. Provedores simulados não certificam capacidades externas.

### A6 — Fiscal: implementação e homologação obrigatórias

**Onde:** contrato `FiscalProvider`, `finance/fiscal-*`, jobs fiscais, endpoints, tela da comanda e configuração de deploy.

**Dependência de produto:** escolher e implementar o emissor real conforme a abstração existente. Fiscal não será considerado pronto com `FISCAL_MODO=fake`. A escolha de provedor, municípios atendidos e parâmetros fiscais deve ser validada com o responsável fiscal/contábil.

**Cenários:** emitir NFS-e a partir de uma venda; tomador válido/inválido; nota de serviço separada de mercadoria; desconto e composição de valores; parcela salão/profissional quando aplicável; rejeição; processamento assíncrono; consulta/retomada; emissão duplicada; timeout depois de o emissor aceitar; cancelamento aceito/recusado; link/documento disponível ao destinatário certo.

Validar NF-e/NFC-e se os produtos vendidos e a operação de lançamento exigirem esses documentos. A capacidade não é presumida como coberta por uma integração de NFS-e. Confirmar acesso ao documento, retenção e reemissão/consulta sem duplicar a nota.

**Aceite:** documento autorizado no ambiente de homologação do emissor, identificável e conciliado com a venda correta; falhas visíveis e recuperáveis; nenhuma nota duplicada após retry. Emissão não mantém uma venda presa a uma chamada externa. A configuração fiscal real e os procedimentos de ativação compõem o gate operacional final.

### A7 — WhatsApp e CRM: integração completa com Meta

**Premissa:** a liberação Meta foi informada como concluída pelo proprietário. Resta comprovar a integração na instalação e nas contas de teste autorizadas.

**Onde:** `crm/whatsapp-*`, `identity/messaging`, controllers/webhooks Meta, campanhas, automações e worker.

**Cenários:** Embedded Signup e cadastro manual, quando ambos forem oferecidos; vinculação WABA/número/unidade; inscrição de webhook; envio real a destinatário de teste; recebimento; status aceito/enviado/entregue/lido/falhou; mensagens duplicadas e fora de ordem; template aprovado/rejeitado e parâmetros inválidos; mídia, idioma, janela de atendimento e limites.

Exercitar número desabilitado, token revogado/expirado, limite do provedor, indisponibilidade, atraso de webhook, reconciliação e repetição após timeout. Campanha deve respeitar consentimento, opt-out, segmentação, teto de disparos, horário e interrupção. Dois tenants não podem compartilhar acidentalmente destinatário, token, histórico ou status.

Testar separadamente OTP/identidade, avisos transacionais, campanhas e conversa de agendamento. O roadmap registra lacunas no encaminhamento da conversa recebida e na conciliação de filiais: reproduzir o estado atual e fechar o que a oferta completa exigir.

**Aceite:** envio e recebimento confirmados no aparelho de teste e correlacionados com Meta, banco e UI; distinção entre aceitação e entrega; duas unidades exercitadas quando houver números próprios; canal não pode aparentar envio bem-sucedido quando só houve fallback ou tentativa.

### A8 — Dados pessoais, importação, mídia e API externa

**Onde:** `crm/lgpd`, `anonimizacao`, `importacao`, fotos, armazenamento, API pública, API keys e webhooks de saída.

**Verificar:** consentimentos separados e versionados; acesso a ficha/foto/exportação; anonimização alcançando mensagens, notas livres, intenções de agendamento e demais tabelas satélites; retenção periódica; logs e filas sem segredos/dados excessivos. Distinguir dados apagáveis de registros cuja retenção seja obrigatória e validar a política aplicável.

Testar CSV malformado, duplicatas, conflitos, rollback e reenvio de importação; URLs legadas; uploads adulterados, tipo real, tamanho, caminho e exclusão no storage. Verificar conteúdo público versus privado e impedir acesso de outro cliente/tenant por URL.

Auditar contratos e escopos das API keys, revogação e quotas; webhooks de saída, assinatura, retry e destinos SSRF, incluindo IPs internos, redirecionamento e mudança de resolução DNS.

**Aceite:** exportação completa do titular correto; anonimização/retenção executáveis sem quebrar finanças; ausência de vazamentos nas evidências e nos logs; arquivo ou URL não contorna autorização.

### A9 — Plataforma, multiunidade e funcionalidades avançadas

**Onde:** `platform`, `multiunidade`, `franquia`, `core`/`crm` de indicadores e assistentes, área `/plataforma` e marketplace.

**Verificar:** planos, mudança e rateio, assinatura SaaS, inadimplência, suspensão/reativação, flags por conta/unidade, operação de suporte e trilha de impersonação. Testar desabilitação durante requisição/job e sincronismo de permissões entre API, menu e worker.

Auditar escopos de rede/franquia e relatórios agregados; fidelidade, avaliação/contestação, segmentação, churn, precificação e indicadores. Para assistentes e conversa, conferir catálogo de intenções/métricas, limites de autorização, confirmação de ações e correspondência entre resposta e dado real. Não presumir presença de LLM ou tratar toda funcionalidade chamada “IA” como integração generativa.

**Aceite:** cada capacidade anunciada tem caminho funcional, dado de origem e autorização correta; bloqueios são aplicados em todas as superfícies e jobs; totais agregados mantêm o recorte de unidade/tenant.

### A10 — Worker, concorrência e recuperação de falhas

**Onde:** `jobs`, `apps/worker`, efeitos assíncronos de financeiro, CRM e plataforma.

**Cenários:** duas instâncias reivindicando a mesma tarefa; interrupção depois do claim, depois do efeito externo e antes do reconhecimento; lease expirado, tarefa retomada e worker antigo tentando concluir; retry esgotado; payload inválido; dependência indisponível; tarefa recorrente sobre tenant bloqueado/recurso desligado; backlog crescendo.

Conferir atomicidade entre escrita de negócio e enfileiramento, identificadores estáveis, backoff, limite de tentativas, fila de falhas e reprocessamento controlado. Medir idade da tarefa mais antiga e tempo de recuperação. Um worker iniciar após `SIGKILL` é uma prova menor que concluir corretamente o trabalho interrompido: exigir as duas.

**Aceite:** nenhuma perda silenciosa nem efeito financeiro/fiscal duplicado; tarefas abandonadas recuperam ou chegam a estado de falha acionável; logs informam por que uma tarefa foi pulada.

### A11 — Navegador, acessibilidade e desempenho

**Onde:** `apps/web`, `ui`, `scripts/percorrer.mjs`, scripts de conferência e medição.

Executar os dez percursos existentes e complementar com cancelamento/remarcação, espera/oferta, walk-in até recebimento, estoque/pacote/assinatura, segunda unidade, cobrança/estorno, WhatsApp e fiscal. Cada fluxo deve confirmar o efeito persistido e, quando houver, a resposta externa.

Testar perfis reais, sessão expirada, permissão negada, refresh, voltar, duplo clique, rede lenta/interrompida, erros 400/403/409/429/5xx, estado vazio e hidratação. Conferir 360, 390, 768 e 1280 px, teclado, foco, formulários, contraste e anúncio de erros. Incluir Safari/iOS ou navegador equivalente usado pelo público além do Chromium da esteira.

Metas já descritas no repositório: APIs comuns P95 < 500 ms; disponibilidade P95 < 800 ms no cenário de 7 dias × 5 profissionais; LCP público em 4G < 2,5 s; fluxo local comanda → pagamento < 1 s percebido. Pagamento externo deve ter prazo e feedback próprios; não confundir sua latência com o PDV local.

Medir também p99, throughput, memória, CPU, pool, locks, queries/N+1 e erros no volume definido em A0. O ensaio com rate limit elevado mede capacidade; é obrigatório outro com limites de produção para comprovar proteção e comportamento dos clientes.

**Aceite:** fluxos críticos completos, metas atingidas no cenário documentado, ausência de crescimento contínuo de recursos e nenhum passo essencial inacessível ou sem recuperação. Usabilidade com pessoas novas é evidência adicional e separada dos testes automatizados.

### A12 — Migrações, deploy, backup e observabilidade

**Onde:** `packages/db/migrations`, migrador, Dockerfile, `deploy/*`, configuração, healthchecks, logs e CI.

**Verificar:** aplicar as 119 migrações em banco vazio; atualizar de uma versão anterior representativa com dados; reaplicar sem efeitos; falhar no meio e retomar; dois migradores concorrentes; locks e duração sob volume. Conferir schema, constraints, grants, RLS e compatibilidade da aplicação anterior com o banco atualizado.

Revisar o artefato de release e sua correspondência com o commit aprovado; modo de autoatualização e exigência real dos dois jobs do CI; rollback com a imagem/versão anterior; migrações separadas do tráfego. O script de autoatualização oferece um modo sem exigir esteira: verificar a instalação efetiva e eliminar essa possibilidade no processo de liberação.

Conferir privilégios e segredos por processo. O compose compartilha um bloco de ambiente contendo credenciais administrativas com os serviços: revisar quais credenciais cada runtime realmente precisa. Verificar portas, TLS, proxy, armazenamento persistente, usuário dos contêineres, limites, ausência de contas demo, CORS/CSP/cookies e configuração de cada provider.

Restaurar banco **e mídia** a partir do backup externo cifrado em destino isolado; recuperar também as chaves necessárias e validar RLS, integridade financeira e capacidade de uso. Comparar resultados entre banco de origem e restaurado, não apenas contagem de linhas. Ensaiar falha no backup remoto, falta de espaço e chave incorreta.

Definir antes do ensaio RPO (perda máxima aceitável) e RTO (tempo máximo de recuperação). Proposta inicial para discussão: RPO ≤ 15 min e RTO ≤ 60 min. São requisitos sugeridos, não capacidade comprovada. Backup diário sozinho não atende ao RPO proposto; a arquitetura deve atender à meta aprovada.

Alertas mínimos: indisponibilidade; erro/latência; fila atrasada/falha; webhook rejeitado ou parado; pagamento sem conciliação; emissão fiscal pendente/rejeitada; WhatsApp com falha; backup vencido; disco e conexões. Cada alerta deve chegar a um responsável com instrução verificável de recuperação.

**Aceite:** restore e rollback ensaiados na infraestrutura representativa, dentro de RPO/RTO; nenhum segredo desnecessário nos runtimes; release impossível a partir de evidência de outro commit; diagnóstico e alertas testados por falha induzida.

## 4. Sequência de trabalho e dependências

| Passo | Execução | Entrega que permite avançar |
|---|---|---|
| 1 | A0 e A1 | Versão fixada, inventário, ambiente e baseline reproduzível |
| 2 | A2, A3 e A4 | Garantias de identidade, agenda e dinheiro avaliadas antes de expor efeitos externos |
| 3 | A8, A9 e A10 | Cobertura dos demais domínios, dados pessoais e processamento assíncrono |
| 4 | Fechamento das dependências de fiscal/pagamentos e A5–A7 | Integrações implementadas/configuradas e homologadas com evidência por capacidade |
| 5 | A11 e A12 | Produto completo percorrido, carga medida e operação ensaiada |
| 6 | Reteste de achados, regressão integral e reunião de liberação | Parecer final por versão, sem lacunas obrigatórias abertas |

Definição/contratação do emissor fiscal e preparação das contas de pagamento devem começar no início do projeto, pois têm dependências externas. A execução técnica acima pode ser sequencial; este plano não pressupõe uso de subagentes.

**Estimativa preliminar de esforço para uma pessoa dedicada:** 12–20 dias úteis para auditoria, evidências, homologações disponíveis e um ciclo de reteste. Não é prazo de go-live: não inclui implementação do fiscal/split/tokenização, espera de terceiros ou correções substanciais. Reestimar após A0/A1, com o tamanho real das lacunas. Não prometer data com base na quantidade de testes existentes.

## 5. Comandos e instrumentos a reaproveitar

Comandos abaixo são referências para a execução futura, a partir da raiz do repositório. Inspecionar seus efeitos e configurar exclusivamente o ambiente isolado antes de rodar. Nenhum deles foi executado para produzir este plano.

| Objetivo | Comando existente | Limite da prova |
|---|---|---|
| Dependências reproduzíveis | `pnpm install --frozen-lockfile` | Executa scripts de instalação; revisar previamente |
| Prisma | `pnpm --filter @barbearia/db db:generate` | Gera cliente, não valida migrações |
| Unitário de domínio | `pnpm --filter @barbearia/core test` | Não prova banco, rede ou UI |
| Integração por pacote | `pnpm --filter @barbearia/scheduling test` e equivalente dos demais pacotes | Scripts de banco exigem instância descartável e privilégios de criação/remoção |
| Dependências e API compiladas | `pnpm -r build` | Necessário para evitar testar `dist` antigo |
| Portão completo | `pnpm verify` | Exige `ADMIN_DATABASE_URL`; inclui helper que tenta iniciar PostgreSQL local |
| Dependências vulneráveis | `pnpm audit --audit-level high` | Classificar alcance dos advisories, não apenas contar |
| Segredos históricos | `node scripts/verificar-segredos.mjs --history` | Exige histórico completo; revisar cobertura do scanner sem expor matches secretos |
| Pilha/navegador/cargas | `scripts/medicao.sh` | Cria ambiente descartável e já chama percursos e disputa de reservas |
| Concorrência isolada | `node scripts/carga-concorrencia-reserva.mjs` | Exige fixture, `API_URL` e banco de demonstração; não usar em alvo real |
| Consistência de números | `node scripts/conferir-numeros.mjs` | Validar fixture, configuração e resultado esperado independente |
| Dado chegando à UI | `node scripts/conferir-telas.mjs` | Complementa, não substitui jornada clicada |
| Restore | `scripts/ensaio-de-restauracao.sh <banco-sintetico>` | Conferir destino descartável e ampliar para backup remoto/mídia |
| Rollback | `scripts/ensaio-de-rollback.sh` | Complementar com aplicação anterior contra schema atualizado |

Integrar a esses instrumentos os cenários ausentes; não criar uma segunda suíte de fachada que apenas repita os mesmos mocks e guardas estruturais.

## 6. Achados, evidências e responsabilidades

Cada achado terá: ID, título, severidade, capacidade afetada, arquivo/linha, commit, pré-condição, passos de reprodução, esperado/observado, impacto, evidência sanitizada, recomendação, responsável, dependências e reteste.

**Severidade:**

- **Crítica:** vazamento entre tenants, tomada de conta privilegiada, execução remota, exposição de segredos operacionais ou perda/duplicação grave de dinheiro/dados.
- **Alta:** quebra de fluxo essencial, autorização relevante contornada, reserva/estorno/nota duplicada, integração obrigatória indisponível, recuperação inviável.
- **Média:** defeito com impacto limitado e contorno demonstrado, sem violar garantia essencial.
- **Baixa:** acabamento ou manutenção sem risco material imediato.

Severidade não substitui prioridade de liberação: falta de implementação/homologação fiscal é bloqueio do escopo mesmo sem uma vulnerabilidade.

Status da prova: `não executado`, `aprovado`, `reprovado`, `bloqueado por dependência` ou `fora do escopo aprovado`. Achados: `aberto`, `corrigido aguardando reteste`, `validado` ou `risco aceito`. Sem prova, não marcar validado.

Responsáveis a nomear no início: auditoria técnica, implementação, homologação financeira, responsável fiscal/contábil, operação/infraestrutura e proprietário que decide a liberação. O responsável por uma correção não deve encerrá-la apenas por declaração; o reteste deve ser reproduzível e preferencialmente revisado por outra pessoa nos itens críticos.

Entregáveis em `output/`, quando a auditoria for executada:

- `INVENTARIO_E_MATRIZ_DE_COBERTURA.csv` — capacidades, interfaces, regras, cenários e cobertura.
- `ACHADOS_PRE_GO_LIVE.md` — achados reproduzidos e backlog priorizado.
- `EVIDENCIAS_PRE_GO_LIVE/` — comandos/resultados, traces sanitizados e IDs não sensíveis de teste.
- `HOMOLOGACAO_PAGAMENTOS_WHATSAPP_FISCAL.md` — prova por integração e capacidade.
- `RETESTE_E_REGRESSAO.md` — fechamento com testes e consumidores afetados.
- `PARECER_GO_NO_GO.md` — decisão por commit, configuração, limitações e responsáveis.

Nunca guardar tokens, cookies, credenciais, dumps reais, conteúdo de clientes ou dados fiscais pessoais nesses artefatos.

## 7. Critério de liberação do lançamento completo

O parecer será **NO-GO** enquanto qualquer condição obrigatória permanecer aberta:

- [ ] Inventário e matriz de cobertura completos, incluindo todos os domínios e capacidades anunciadas.
- [ ] Nenhum achado crítico ou alto aberto; correções comprovadas por reteste.
- [ ] Nenhum fluxo crítico apenas “presumido”, pulado ou bloqueado por dependência.
- [ ] Testes, build e ambos os jobs da esteira aprovados para o mesmo commit candidato.
- [ ] Isolamento, autorização, concorrência e integridade financeira comprovados no runtime restrito.
- [ ] Pagamentos configurados e homologados, com conciliação e estorno; split/recorrência/sinal também quando incluídos na oferta acordada.
- [ ] Fiscal real implementado e homologado para documentos/localidades do lançamento.
- [ ] WhatsApp comprovado ponta a ponta, incluindo status, recebimento e falhas; liberação Meta registrada como pré-requisito já informado.
- [ ] Fluxos completos pelo navegador, com confirmação no banco e no provedor quando aplicável.
- [ ] Worker recupera trabalhos interrompidos sem perda ou duplicação.
- [ ] Desempenho atende às metas no volume definido; proteções continuam funcionando sob carga.
- [ ] Migração, rollback e restauração ensaiados, backup externo validado e RPO/RTO atendidos.
- [ ] Configuração de produção revisada, artefato fixado, alertas e responsáveis disponíveis.
- [ ] Riscos médios/baixos remanescentes registrados com contorno, prazo e aceite explícito do proprietário.

Homologação não substitui a ativação real. Após autorização específica para rollout e efeitos externos, executar smoke controlado na instalação de destino: acesso, reserva, pagamento e estorno permitidos, WhatsApp com destinatário autorizado e fiscal conforme procedimento do emissor. Nunca emitir nota real ou movimentar dinheiro apenas para completar uma checklist sem mandato para isso.

Recomenda-se habilitar as primeiras contas de forma progressiva, com **todas as capacidades do escopo já aprovadas**. Acompanhar reserva, fechamento, comissão, liquidação, nota, entrega de mensagem e fila nas primeiras 48 horas e na primeira semana. Definir reversão/interrupção para vazamento, dinheiro duplicado, nota duplicada, falha de integridade ou indisponibilidade além do limite operacional acordado.

**Conclusão de planejamento:** a auditoria pode começar pelo código e pelas garantias centrais imediatamente. A data de liberação completa depende também de entregar o emissor fiscal real, resolver as capacidades financeiras ainda incompletas e produzir as evidências atuais de homologação e operação.
