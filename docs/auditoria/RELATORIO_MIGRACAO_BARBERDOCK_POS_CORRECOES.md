# Barberdock — relatório detalhado da evolução do ZIP original até a versão auditada

**Data do relatório:** 23/08/2026  
**Base de comparação:** ZIP original `barbearia-claude-barbershop-app-research-xvejhy.zip`  
**Versão final considerada neste relatório:** `barberdock-auditado.zip` / árvore `/mnt/data/audit_final`  
**Objetivo:** registrar, de forma técnica e rastreável, tudo que foi alterado desde o ZIP original, o motivo de cada alteração, o que foi efetivamente validado nesta sessão, o que foi corrigido em auditoria posterior e o que ainda precisa ser comprovado em um ambiente completo ou em operação real.

## ADENDO — correções após auditoria independente de 23/08/2026

Este adendo **substitui qualquer leitura de que “19 guardas verdes” equivaleria a backlog integralmente aceito**. A comparação independente entre ZIP original, backlog, versão auditada e este relatório encontrou novos pontos e levou às seguintes correções na versão pós-correções:

- **V2 — gasto total do cliente:** corrigido. O cabeçalho não soma mais a timeline limitada a 10 ocorrências; o acumulado vem de rota financeira própria, protegida por `customers.view` + `finance.view`, somando todos os pedidos `paid`.
- **V2 — última visita:** corrigido. Falta/cancelamento continuam no histórico, mas a “Última visita” usa apenas o último atendimento `completed`.
- **V9 — semântica de cor:** corrigido no shell/navegação, landing, brilho decorativo de cards e filtro ativo do Painel; `paid` passou a `success`; fatura aberta e preço acima da base passaram a `warning`. A guarda visual foi ampliada para reprovar essas regressões.
- **R9 — falha de exclusão física pós-commit:** corrigido. A remoção do arquivo antigo é best-effort depois de a referência de banco ter sido atualizada; falha de filesystem não devolve 500 fingindo que a alteração lógica falhou e gera warning para reconciliação.
- **V10 — critério de 44px:** reconciliado. Todo alvo interativo mantém 44px; intervalo menor que 44px na escala proporcional permanece informativo e não é artificialmente esticado sobre outro compromisso.
- **V8 — alcance da guarda:** o critério original foi preservado. A redação foi corrigida para não superestimar cobertura: todas as seções seguem moldes V7 e níveis explícitos são cobrados nas superfícies-chave, mas **a aceitação global de V8 permanece pendente de revisão visual das demais telas**.
- **R5:** continua pendente de build real para medir bundle/LCP. A tentativa de obter `pnpm@10.33.0` neste ambiente falhou por indisponibilidade do registry, portanto não há medição inventada.
- **R12:** continua pendente de teste humano; o baseline pré-reorganização permanece irrecuperável e não foi reconstruído artificialmente.

Também foram reforçadas as guardas V2, V7/V8/V9 e R9 e adicionados testes de integração para os dois bugs da ficha.

Na árvore pós-correção, **19/19 guardas principais foram reexecutadas e ficaram verdes**; 736 TS/TSX foram parseados sem erro sintático e um scanner independente de imports internos/locais não encontrou caminho ausente. Isso continua sem substituir build/typecheck/Vitest/PostgreSQL.

---

## 1. Resumo executivo

O ZIP original já era um sistema grande e tecnicamente sofisticado. A revisão não partiu da premissa de reescrever o produto: a base de domínio, o multi-tenant, o uso de PostgreSQL/RLS, o motor de agenda, as permissões e boa parte das integrações já eram ativos importantes.

O problema principal identificado foi outro: **a quantidade de capacidade existente estava aparecendo ao usuário de forma mais complexa do que precisava**. O painel misturava operação, configuração, gestão e integração; algumas entidades centrais não tinham uma porta própria; telas importantes acumulavam dezenas de seções; e a arquitetura interna começava a concentrar código em arquivos muito grandes.

O programa de trabalho passou, portanto, por quatro eixos:

1. **Arquitetura de informação e UX:** reorganizar menu, orientação, clientes, Hoje, Agenda, ficha e Painel.
2. **Design system e consistência visual:** moldes de página, hierarquia visual e semântica de cor.
3. **Infraestrutura e manutenção:** armazenamento próprio de mídia, divisão do CSS e divisão das fachadas gigantes de API/Server Actions.
4. **Governança de produto:** matriz de prontidão, verdade comercial, guardas automáticas e protocolo de usabilidade real.

A comparação final entre as duas árvores mostra:

- **999 arquivos** no ZIP original;
- **1.093 arquivos** na versão auditada;
- **94 arquivos novos**;
- **60 arquivos existentes modificados**;
- **0 arquivos originais removidos**;
- **939 arquivos originais permaneceram byte a byte sem alteração**;
- **154 caminhos no total diferem** entre o original e o estado auditado.

Também houve redução importante dos monólitos que foram alvo direto da revisão:

| Arquivo | Original | Versão auditada | Observação |
|---|---:|---:|---|
| `apps/web/src/app/globals.css` | 9.228 linhas | 25 linhas | virou índice de imports; estilos foram separados por superfície |
| `apps/web/src/lib/admin-api.ts` | 4.096 | 17 | virou fachada; lógica distribuída em 11 módulos |
| `apps/web/src/app/admin/acoes.ts` | 3.548 | 181 | virou fachada/reexports; lógica distribuída em 6 módulos |
| `apps/web/src/app/admin/cliente/[id]/page.tsx` | 1.760 | 696 | responsabilidades foram separadas; componentes da ficha foram extraídos |

A versão auditada contém **736 arquivos TS/TSX** e **22 arquivos CSS**. A auditoria estática posterior analisou todos os 736 TS/TSX e resolveu **2.629 imports locais/aliases sem encontrar caminho quebrado**.

### Situação geral

- Os blocos de implementação da reorganização foram incorporados; critérios que dependem de build/medição humana permanecem explicitamente pendentes.
- As 19 guardas principais de regressão do programa estão verdes no ambiente disponível.
- Houve uma auditoria profunda posterior que encontrou e corrigiu problemas que as primeiras guardas não tinham detectado.
- **Ainda não é correto declarar que o sistema inteiro passou por `pnpm verify` completo**, porque este ambiente não possuía as dependências instaladas, Vitest/Pnpm operacionais nem PostgreSQL local para as suítes completas.
- Também ainda falta a principal validação de UX: **pessoas reais utilizando o sistema em barbearias reais**.

---

## 2. Princípios que orientaram as alterações

A tese central do trabalho foi:

> Não simplificar o que o Barberdock é capaz de fazer; simplificar o que o usuário precisa enxergar de cada vez.

As alterações seguiram alguns princípios recorrentes:

- operação diária deve ter prioridade visual sobre configuração eventual;
- o usuário deve saber onde está sem memorizar a arquitetura interna do software;
- uma entidade central como Cliente precisa de porta própria;
- o usuário não deve navegar para executar uma ação se o objeto da ação já está diante dele;
- “pronto no código” não significa automaticamente “pronto para vender”;
- integração fake/provedor abstrato não deve ser descrito como integração real;
- a UI deve respeitar as mesmas permissões do backend, inclusive nos enriquecimentos de uma tela;
- refatorações estruturais não devem obrigar páginas a conhecer a nova topologia interna;
- testes/guardas devem cobrar comportamento e contrato, não depender acidentalmente da posição textual antiga do código;
- quando uma coisa não pôde ser validada no ambiente, ela deve permanecer explicitamente não validada.

---

# Parte A — Mudanças realizadas, bloco a bloco

## 3. R7 — Matriz de prontidão

### Problema original

O ROADMAP usava a quantidade de blocos concluídos como uma representação forte de maturidade. Isso misturava dimensões diferentes:

- motor de domínio implementado;
- tela existente;
- integração real existente;
- E2E efetivamente provado;
- capacidade apta a produção.

Um bloco histórico podia estar fechado mesmo contendo uma parte fake ou uma integração externa ainda não comprovada.

### O que foi alterado

Foi criada no `ROADMAP.md` uma matriz explícita com as colunas:

`Motor | Tela | Integração real | E2E real | Produção | Evidência`

Ela passou a ser a fonte de leitura de conjunto para capacidades como:

- Agenda;
- Comanda / caixa / comissão;
- WhatsApp Meta Cloud;
- Stripe da plataforma;
- Split;
- Fiscal/NFS-e;
- sinal cobrado online;
- upload de fotos.

Foi criado `scripts/verificar-prontidao.mjs`, integrado ao `scripts/verify.sh`.

### Regras introduzidas

- Produção ✅ exige motor e tela ✅.
- Integração ❌ não pode coexistir com Produção ✅/⚠️.
- Evidências citadas na matriz precisam continuar existindo.
- Texto inequívoco que descreva como “pronto” algo explicitamente ❌ deve falhar na guarda.
- O antigo contador histórico de blocos não pode voltar a ser usado como selo comercial.

### Resultado

A governança passou a separar implementação de disponibilidade comercial.

### O que foi validado

A guarda foi executada repetidamente ao longo dos blocos posteriores e permanece verde na versão auditada.

---

## 4. V0 — Vocabulário e arquitetura mental do menu

### Problema original

O menu já tinha agrupamentos, mas os nomes refletiam a arquitetura do software:

- Visão geral;
- Atendimento;
- Financeiro;
- Marketing;
- Cadastros;
- Integrações;
- Administração.

Isso ainda exigia que uma recepcionista ou dono pensasse como quem projetou os módulos.

### O que foi alterado

A organização passou a refletir o trabalho:

- **Hoje**
- **Agenda**
- **Clientes**
- **Atendimento**
- **Financeiro**
- **Crescimento**
- **Gestão**
- **Configurações** em um grupo separado

O Assistente deixou de competir como “lugar” do menu e passou a ser tratado como capacidade transversal.

Também foi centralizada a decisão de destino inicial por perfil, respeitando onboarding e contexto.

### Regras preservadas

- não perder destinos antigos;
- continuar filtrando por permissão e recurso/plano;
- não promover telas proibidas por papel;
- não quebrar o onboarding de uma barbearia ainda não configurada.

### Resultado

A estrutura do menu deixou de expor a taxonomia técnica como primeira camada de navegação.

---

## 5. V1 — Porta principal de Clientes

### Problema original

O ZIP original tinha uma ficha detalhada em `/admin/cliente/[id]`, mas **não tinha uma tela geral `/admin/clientes`**.

Um cliente só era alcançado “de lado”, por contextos como:

- Retenção;
- LGPD;
- Meu Dia;
- Campanhas.

Um cliente fiel, que não estivesse em nenhuma exceção, podia ser mais difícil de encontrar do que um cliente em risco.

### O que foi alterado

Foi criada a área `/admin/clientes` com:

- busca por nome;
- busca por telefone normalizado;
- filtros operacionais;
- listagem completa ordenada por atividade recente;
- segmento derivado;
- última visita;
- próxima visita quando permitido;
- enriquecimentos financeiros apenas quando a permissão correspondente existe;
- acesso direto à ficha.

Também entrou um controlador/API específico para Clientes e lógica de CRM associada.

### Segurança e permissão

Foi preservado o princípio de que `customers.view` **não dá automaticamente** acesso a:

- informações financeiras;
- agenda ampla da equipe;
- fiado;
- outros enriquecimentos protegidos.

### Resultado

Cliente passou a ser uma entidade de primeira ordem no produto, e não apenas uma ficha acessível por atalhos laterais.

---

## 6. V3 — Orientação: área, página e contexto

### Problema original

O item ativo no menu era praticamente o único sinal de localização. Em várias superfícies havia competição entre níveis verticais de navegação.

### O que foi alterado

Foi estabelecido o contrato:

- **trilho/menu vertical:** onde estou no produto;
- **abas horizontais:** onde estou dentro da área;
- **breadcrumb/migalha derivado:** área → página;
- **nota contextual:** explicação curta da função daquela tela.

A informação passou a sair de `secoes.ts`, evitando breadcrumbs escritos manualmente em cada página.

Também foram cadastradas páginas internas, como ficha de cliente e telas pessoais, para que tenham localização coerente sem inventar um segundo registro.

### Resultado

Telas como Comissões passaram a responder de forma explícita algo equivalente a:

`Financeiro › Comissões`

sem uma segunda coluna vertical disputando atenção.

---

## 7. V4 — Separação entre operação e configuração

### Problema original

Integrações e Administração competiam visualmente com itens usados a cada minuto. API, Webhooks, LGPD e Auditoria podiam ter peso semelhante a Agenda, Fila ou Caixa.

### O que foi alterado

A navegação passou a ter dois grupos semânticos reais:

### Trabalho diário

- Hoje;
- Agenda;
- Clientes;
- Atendimento;
- Financeiro;
- Crescimento;
- Gestão.

### Configurações

- usuários;
- segurança;
- chaves/API;
- webhooks;
- LGPD/privacidade;
- auditoria;
- importação;
- plano;
- preferências.

Em desktop, Configurações fica visualmente afastada; em tablet, as áreas operacionais têm prioridade; em mobile, a navegação mantém scroll contido.

### Resultado

A interface reduz o peso visual de coisas que só são configuradas por exceção.

---

## 8. V5 — “Hoje” como centro operacional

### Problema original

`/admin/dia`, `/admin/painel` e o Assistente competiam como home conceitual. A tela operacional ainda carregava sinais de dashboard em vez de responder primeiro à rotina do balcão.

### O que foi alterado

`/admin/dia` passou a priorizar:

- quantidade de atendimentos do dia;
- **próximo cliente** em grande destaque;
- quem está esperando;
- quem está na cadeira;
- atrasos;
- confirmações pendentes;
- comandas abertas;
- contexto de caixa respeitando permissão;
- linha do tempo do dia.

Foi introduzida lógica separada para determinar “próximo” do ponto de vista operacional, considerando, por exemplo, um cliente que já chegou.

### Permissão financeira

A home não passou a exibir faturamento para alguém que só opera caixa. Operação de caixa e visão financeira continuam permissões distintas.

### Resultado

A home operacional passou a responder “o que acontece agora?” em vez de obrigar o usuário a interpretar uma grade de KPIs.

---

## 9. V10 — Agenda proporcional ao tempo

### Problema original

A Agenda apresentava compromissos, mas uma lista não torna a ociosidade visual. Um intervalo de quatro horas podia parecer apenas a distância entre duas linhas.

### O que foi alterado

A Agenda passou a usar uma régua temporal proporcional.

Foram reaproveitadas as regras reais de jornada (`resolveWorkingDay` e estruturas do domínio), considerando:

- jornada semanal;
- almoço;
- folga;
- férias/feriados/horários especiais quando aplicáveis;
- bloqueios;
- buffers ocupacionais.

O clique em um buraco preserva:

- dia;
- profissional;
- hora sugerida.

O motor continua sendo a fonte final para decidir se o serviço escolhido realmente cabe.

### Mobile

Foi adotada a lógica de mostrar um profissional inteiro por vez em largura pequena, sem esmagar várias colunas.

### Regra de alvo de toque

Intervalos curtos não são artificialmente aumentados a ponto de invadir outro compromisso. A escala temporal permanece verdadeira; quando um buraco não suporta um alvo de toque seguro, ele continua informativo sem virar botão sobreposto.

### Resultado

Capacidade ociosa virou informação visual imediata.

---

## 10. R5 — Primeira ilha client-side controlada

### Problema original

O projeto era fortemente server-first e evitava Client Components no admin. Isso mantinha o pacote público pequeno, mas bloqueava interações que realmente exigem estado local.

### Decisão

Não transformar o admin inteiro em SPA. Abrir **ilhas controladas** apenas onde existe razão concreta.

### Primeira ilha escolhida

Resolução de conflito de telefone na importação.

Quando duas linhas representam potencialmente a mesma pessoa, a interface permite escolher qual registro deve prevalecer, mantendo a decisão no preview importável.

### Regras introduzidas

- Client Component apenas no admin;
- CSS Module específico da ilha;
- superfície pública permanece sem `use client` introduzido pelo R5;
- permissão `customers.edit` preservada;
- atualização protegida por lock quando necessário;
- auditoria sem colocar nome/telefone bruto na trilha;
- proteção para futuras ilhas do admin sem liberar JS silencioso na página pública.

### Resultado

Foi criado um padrão seguro para interatividade futura, posteriormente usado pelo V11.

---

## 11. V11 — Busca global e ações no contexto

### Problema original

Mesmo com menu melhor, um sistema grande ainda exige memória de localização. Além disso, ações podiam obrigar o usuário a sair do objeto que já estava vendo.

### O que foi alterado

Foi criada a paleta global `Ctrl/⌘ + K`.

Ela busca:

- funções/telas que o usuário efetivamente pode abrir;
- clientes;
- agendamentos relevantes.

A busca de funções é derivada da navegação já recortada por permissão. Ela não recebe uma segunda lista “crua” de destinos no navegador.

A busca de cliente e agenda reaproveita contratos existentes.

### Ajustes de linguagem

A normalização passou a tratar casos do português como:

`comissão` → `Comissões`

em vez de depender apenas de remoção de acento.

### Ações contextuais

Foram reforçados fluxos como:

- cliente → Agendar;
- cliente → WhatsApp;
- cliente → Nova comanda;
- horário → abrir contexto correto;
- comanda → Receber no próprio objeto.

### Segurança

Resultados que dependem de clientes/agendamentos continuam recortados pelas permissões correspondentes. Dados pessoais não viraram um catálogo global para qualquer papel.

---

## 12. V2 — Reorganização da ficha do cliente

### Problema original

A ficha original tinha cerca de 1.760 linhas em uma página e empilhava, no mesmo fluxo visual:

- preferências;
- histórico;
- WhatsApp;
- consentimentos;
- fotos;
- LGPD;
- fidelidade;
- pacotes;
- fiado;
- avaliações;
- clube;
- sinal;
- outras ações.

### O que foi alterado

A ficha passou a ter quatro intenções principais:

- **Visão geral**;
- **Histórico**;
- **Fidelidade**;
- **Financeiro**.

O topo passou a mostrar identidade e contexto, incluindo quando permitido:

- segmento;
- visitas;
- total gasto;
- próximo atendimento;
- preferências;
- explicação do segmento/VIP.

O histórico usa leitura em linha do tempo.

As ações principais ficam no contexto da pessoa.

### Otimização posterior de leitura

Na auditoria final, foi detectado que as abas ainda podiam consultar dados além do necessário. Isso foi corrigido: cada aba passou a buscar apenas as fontes que realmente precisa desenhar e para as quais o usuário tem permissão.

### Retorno de ações

Também foi corrigido posteriormente um desvio: várias ações de Fidelidade/Financeiro voltavam para Visão geral. Os redirects agora preservam `?aba=fidelidade` ou `?aba=financeiro` quando apropriado.

### Observação de manutenibilidade atual

A página principal caiu de 1.760 para 696 linhas no estado auditado, mas parte dos componentes extraídos está concentrada em `componentes.tsx`, atualmente com aproximadamente 1.210 linhas. Portanto, o V2 melhorou bastante a separação da página, mas **a área da ficha ainda não deve ser considerada totalmente “refatorada para sempre”**; `componentes.tsx` é um hotspot residual a monitorar.

---

## 13. V6 — Painel do dono com narrativa

### Problema original

Uma sequência de indicadores exigia que o dono fizesse a síntese mental.

### O que foi alterado

O Painel passou a seguir esta ordem:

1. **Como estamos**;
2. **Agenda/capacidade**;
3. **Equipe**;
4. **O que merece atenção**;
5. **O que dá para fazer**.

O período padrão operacional do dono foi alinhado com Hoje, mantendo janelas maiores disponíveis.

A comparação de equipe foi tratada com cuidado para não vazar a comparação entre colegas para superfícies pessoais do profissional.

### Correção posterior da auditoria

Foi encontrado um erro de texto em períodos diferentes: consultas de 7/30 dias podiam estar corretas, mas a interface ainda escrever “Como estamos hoje” ou “Faltas hoje”. O painel foi corrigido para derivar os títulos e referências do período efetivamente solicitado, inclusive links com `?dias=N`.

### Resultado

O Painel passou a contar uma história de gestão em vez de ser apenas uma grade de KPIs.

---

## 14. V7 — Moldes de página

### Objetivo

Reduzir a necessidade de reaprender a interface a cada rota e estabelecer uma estrutura que o design system possa cobrar.

### O que foi alterado

Cada seção declara um molde em `secoes.ts`:

- `operacional`;
- `cadastro`;
- `gestao`;
- `configuracao`;
- exceção justificada quando uma tela legitimamente não cabe nos quatro.

A regra foi deliberadamente escrita como padrão + exceção explícita, e não como dogma que obrigue uma futura tela diferente a caber num molde errado.

---

## 15. V8 — Menos caixa, mais hierarquia

### Problema original

Quando tudo é card, a borda deixa de comunicar prioridade.

### O que foi alterado

O design passou a favorecer:

- espaço;
- alinhamento;
- peso tipográfico;
- tamanho;
- agrupamento;

antes de borda, sombra ou fundo.

Foram formalizados três níveis:

1. **Primário** — o que importa agora;
2. **Contexto** — informação para interpretar o primário;
3. **Detalhe** — dado consultado quando necessário.

Hoje, Painel e Cliente foram as principais superfícies reorganizadas sob essa regra.

---

## 16. V9 — Semântica de cor e estado

### Problema original

A cor podia ser decorativa e informativa ao mesmo tempo, reduzindo sua utilidade como vocabulário.

### O que foi alterado

Foi fechado um mapa semântico, centralizado no core, para os estados de atendimento.

Princípio geral:

- sucesso/concluído/confirmado → verde;
- atenção/espera que pede ação → amarelo;
- problema/falta/cancelamento → vermelho;
- estado apenas informativo → neutro;
- azul fica reservado principalmente a ação, navegação e foco.

A informação não depende apenas da cor; o rótulo continua escrito.

### Contraste

Nas revisões visuais feitas no ambiente, os novos estados foram avaliados nos temas e o pior caso permaneceu acima do patamar AA informado durante a implementação.

---

## 17. R9 — Armazenamento próprio de imagens

### Problema original

A administração de fotos aceitava basicamente URLs externas. Isso criava dependência de hosts de terceiros, imagens quebradas e uma demonstração comercial frágil.

### O que foi alterado

Foi criado armazenamento próprio com:

- upload de arquivo;
- preparação no navegador;
- preview;
- recorte/dimensão por tipo;
- saída WebP quando preparada pelo cliente;
- validação no servidor da assinatura real do conteúdo;
- limite de tamanho;
- nome de objeto aleatório;
- bloqueio de traversal;
- rota `/media/...`;
- volume persistente em Docker/deploy;
- backup de mídia junto da estratégia de backup;
- remoção do objeto físico quando a referência correspondente é substituída/removida.

A arquitetura foi feita para não depender da UI caso, no futuro, o storage local seja substituído por um provider como S3/R2.

### Escopo deliberado

Fotos privadas de cliente **não foram simplesmente transformadas em mídia pública**. Elas continuam sob regras próprias de consentimento e privacidade.

### Correções encontradas na auditoria profunda

#### 17.1 Multiunidade

Foi detectado que a tela podia buscar a capa de uma unidade e gravar na unidade atual, criando risco de substituir/apagar arquivo associado à unidade errada. A leitura/substituição foi corrigida para respeitar a unidade ativa.

#### 17.2 Limite de Server Action do Next

O domínio aceitava até 3 MB, mas o Next.js limita Server Actions a 1 MB por padrão. Um arquivo de 1,2–3 MB poderia ser preparado corretamente e morrer antes da API.

Foi adicionado em `apps/web/next.config.mjs`:

`experimental.serverActions.bodySizeLimit = '4mb'`

A margem é para o envelope multipart; o teto de domínio na API continua sendo 3 MB.

### Resultado

A mídia pública deixou de depender do usuário colar uma URL de terceiro e ganhou persistência/backup próprios.

---

## 18. R10 — Divisão do `globals.css`

### Problema original

O `globals.css` ultrapassava nove mil linhas e continuou crescendo ao longo dos blocos.

### O que foi alterado

O CSS foi repartido em **18 fragmentos por superfície**, com `globals.css` funcionando como índice de imports.

O maior fragmento ficou em torno de **1.252 linhas**.

Foi criado um helper para testes lerem o CSS expandido, evitando que as guardas antigas “deixassem de enxergar” regras apenas porque o arquivo foi dividido.

### Garantias criadas

A guarda do R10 verifica:

- fragmentos importados;
- ausência de arquivo órfão;
- ordem de cascata;
- regra que não deve voltar a ser despejada no índice;
- duplicatas idênticas entre fragmentos.

### Equivalência visual

O trabalho foi uma partição de código, não um redesign. Durante o R10 foi feita comparação da concatenação dos fragmentos com o conteúdo anterior, removendo somente duas duplicatas consideradas no-op.

---

## 19. R11 — Divisão de `admin-api.ts` e `acoes.ts`

### Problema original

Dois grandes arquivos concentravam contratos e ações de domínios diferentes:

- `admin-api.ts`: ~4.096 linhas;
- `acoes.ts`: ~3.548 linhas.

### O que foi alterado

`admin-api.ts` virou uma fachada de **17 linhas**, reexportando **11 módulos internos por domínio**.

`acoes.ts` virou fachada/reexport de **181 linhas**, com **6 módulos de ações**.

A UI continua importando da fachada pública. Uma tela não precisa conhecer `admin-api/clientes.ts`, `admin-api/financeiro.ts` etc.

### Problemas que a divisão revelou

A divisão expôs dependências que ficavam implícitas no arquivo monolítico, por exemplo tipos compartilhados usados por Agenda/Operação.

### Auditoria posterior do contrato

Na auditoria profunda foi detectado que um tipo público (`Resposta`) não estava sendo reexportado pela fachada final, embora já existisse no core interno. Isso foi corrigido:

`apps/web/src/lib/admin-api.ts` volta a exportar `Resposta`.

A árvore de imports locais/aliases também foi reavaliada depois da refatoração.

### Resultado

A refatoração reduziu o risco de crescimento concentrado sem obrigar o restante do frontend a conhecer a nova organização interna.

---

## 20. R6 — Promessas históricas limitadas pelas lacunas

### Problema

Títulos históricos ✅ podiam continuar usando palavras maiores do que aquilo que efetivamente foi entregue.

### O que foi alterado

Foram revisados títulos ligados a lacunas abertas. Exemplos:

- “arrastar” na Agenda;
- CI/CD e staging;
- rate limit “global”;
- Pix pela Stripe;
- split sem ressalva de provider fake;
- fiscal/emissor real;
- “canais” de campanha;
- filtros do marketplace.

Foi criado `scripts/verificar-r6-promessas.mjs`.

### Resultado

Bloco histórico fechado passa a descrever a entrega real, e não uma promessa maior que ainda depende de lacuna aberta.

---

## 21. R8 — Verdade comercial

### Problema

Mesmo uma matriz técnica correta perde valor se landing, README ou material de venda ainda descrevem uma capacidade ❌ como disponível.

### O que foi alterado

Foi criado:

`docs/comercial/prontidao.md`

O recurso de perguntas foi formalizado como **Assistente de gestão**, deixando explícito que trabalha sobre catálogo fechado de métricas e não é vendido como “IA que entende o negócio”.

A linguagem comercial também passou a qualificar recursos dependentes de conexão externa, como WhatsApp.

Foi criado `scripts/verificar-r8-comercial.mjs`.

### Resultado

A matriz de prontidão passou a ter uma consequência direta sobre o que o material comercial pode afirmar.

---

## 22. R12 — Protocolo de usabilidade real

### Objetivo

Substituir notas subjetivas como “UX 9/10” por dados observáveis.

### Tarefas definidas

Uma pessoa que nunca usou o sistema deve, sem explicação prévia:

1. encontrar o cadastro de João Silva;
2. agendar João para amanhã;
3. descobrir quanto João está devendo;
4. descobrir quem é o próximo cliente;
5. descobrir quanto a casa faturou hoje.

### Instrumentação criada

- `docs/usabilidade/r12.md`;
- `scripts/r12-usabilidade.mjs`;
- diretório de medições;
- cálculo de mediana/taxa de conclusão;
- guarda `verificar-r12-percursos.mjs` para confirmar que as cinco tarefas têm caminho real no produto.

### Limitação importante

A linha de base **pré-V1/V5/V11 não foi coletada no momento correto**. Depois que as portas e a busca foram criadas, não há forma honesta de reconstruir quanto uma pessoa nova demorava no sistema antigo.

Por isso, a documentação registra o baseline original como não coletado/irrecuperável, em vez de inventar números.

O próximo checkpoint válido é pós-reorganização.

### O que ainda falta

Executar o protocolo com pessoas reais e operar a versão em 3–5 barbearias.

---

# Parte B — Auditoria profunda realizada depois de todos os blocos

## 23. Por que foi feita uma segunda auditoria

Depois da sequência R7→R12, foi feita uma revisão adicional justamente porque guardas locais podem confirmar que um contrato existe e ainda não capturar interações entre blocos.

A revisão posterior procurou, entre outras coisas:

- erros de import/export introduzidos por R11;
- rotas quebradas por movimentação de arquivos;
- permissões que deixaram de ser respeitadas em enriquecimentos;
- comportamento de multiunidade;
- limites de runtime que não aparecem numa função isolada;
- textos de interface que não acompanham o dado real;
- redirects entre abas;
- carga desnecessária em páginas reorganizadas.

## 24. Checagens estáticas fortes executadas

Na versão auditada foram analisados:

### 24.1 Parse de TypeScript/TSX

- **736 arquivos TS/TSX**;
- **0 erro sintático encontrado**.

Isso é diferente de um typecheck completo: confirma que o parser aceita os arquivos, mas não substitui resolução de tipos externos/compilação completa de workspace.

### 24.2 Resolução de imports locais e aliases

- **2.629 imports locais/aliases** verificados;
- **0 caminho inexistente**.

Essa checagem é especialmente relevante depois de R10/R11.

### 24.3 Guardas de regressão

Na versão auditada, foram executadas e ficaram verdes:

- matriz de prontidão R7;
- verdade comercial R8;
- V0 navegação;
- V1 Clientes;
- V3 orientação;
- V4 separação operação/configuração;
- V5 Hoje;
- R5 ilha client-side;
- R6 promessas;
- lacunas declaradas;
- V10 Agenda;
- V11 busca/contexto;
- V2 ficha;
- V6 Painel;
- V7/V8/V9 visual;
- R12 percursos;
- R9 mídia;
- R10 CSS;
- R11 módulos.

**19 portões principais foram reexecutados na versão auditada e ficaram verdes.**

## 25. Problemas adicionais encontrados e corrigidos na auditoria

### 25.1 R9 — mídia e multiunidade

**Risco:** ler capa/foto de uma unidade e gravar/substituir na unidade atual, podendo manipular o arquivo físico errado.

**Correção:** leitura e substituição vinculadas à unidade ativa.

### 25.2 R9 — teto real do Next Server Actions

**Risco:** domínio/API aceitando 3 MB, mas Server Action cortando em 1 MB antes de a requisição chegar.

**Correção:** `bodySizeLimit` de 4 MB no Next, mantendo 3 MB como teto real de domínio.

### 25.3 V6 — período do Painel

**Risco:** dado de 7/30 dias correto, texto ainda dizendo “hoje”.

**Correção:** títulos/subtítulos/alertas passam a derivar do período efetivo.

### 25.4 V2 — retorno de abas

**Risco:** salvar fidelidade/financeiro e voltar para Visão geral.

**Correção:** ações retornam à aba correspondente.

### 25.5 V2 — leituras por aba

**Risco:** aba escondida visualmente, mas dados de outras áreas ainda consultados.

**Correção:** `Promise.all` recortado pela aba ativa e pelas permissões relevantes.

### 25.6 R11 — contrato público da fachada

**Risco:** tipo público `Resposta` deixar de ser exportado depois da partição.

**Correção:** tipo restaurado na fachada; imports reavaliados.

---

# Parte C — O que foi efetivamente testado

## 26. Níveis de validação usados

Ao longo do trabalho foram usados quatro níveis diferentes. Eles não devem ser confundidos.

### Nível 1 — Guarda estática de contrato

Exemplos:

- destino não pode desaparecer;
- uma seção precisa declarar molde;
- cor semântica não pode voltar para significado errado;
- UI não pode importar módulo interno do R11;
- superfície pública não deve receber Client Component pelo R5;
- material comercial não pode afirmar split/NFS-e como prontos.

**Status:** extensivamente executado e verde.

### Nível 2 — Runtime isolado sem infraestrutura completa

Foram executados casos puros/isolados de lógica, como:

- busca e filtros de Clientes;
- normalização da busca global;
- seleção de conflito de importação;
- geometria de timeline;
- armazenamento local de mídia com bytes reais;
- bloqueio de path traversal;
- cálculo de mediana do R12;
- outras funções que não precisam de PostgreSQL/Next completo.

**Status:** executado em vários blocos e usado para descobrir/corrigir bugs.

### Nível 3 — Inspeção visual estática em Chromium

Foram produzidas e revisadas versões desktop/tablet/mobile das principais superfícies:

- Clientes;
- navegação V3/V4;
- Hoje;
- Agenda timeline;
- Busca global;
- Ficha;
- Painel;
- consolidação V7/V8/V9;
- Fotos/R9.

Foram medidos diversos casos de overflow em 390/768/1024/1440 durante os blocos.

**Limite:** algumas capturas foram produzidas a partir de HTML representativo com o CSS/estrutura do projeto, não executando necessariamente todo o Next + API + Postgres.

### Nível 4 — Full stack real do repositório

Isto significa:

- instalar exatamente as dependências do lockfile;
- executar packages/build/typecheck;
- subir PostgreSQL;
- aplicar migrations;
- rodar Vitest/integration/e2e;
- construir Next;
- iniciar API/worker/web;
- navegar no produto real.

**Status neste ambiente: NÃO concluído.**

---

# Parte D — O que ainda precisa obrigatoriamente ser validado

## 27. `pnpm install` + `pnpm verify` completo

Esta é a maior lacuna de validação técnica da sessão.

O repositório declara:

- Node >= 22;
- `pnpm@10.33.0`;
- `pnpm verify` como portão único.

O ambiente usado durante boa parte do trabalho não tinha Pnpm/dependências/PostgreSQL utilizáveis para completar o portão.

### Deve ser feito

Em uma máquina ou CI com acesso às dependências:

1. Node 22;
2. Corepack/Pnpm 10.33.0;
3. `pnpm install --frozen-lockfile`;
4. PostgreSQL conforme configuração do projeto;
5. `pnpm verify`;
6. `pnpm build` se necessário isoladamente para investigação de falhas;
7. corrigir qualquer regressão antes de liberar piloto.

### Por que é indispensável

O parse dos 736 TS/TSX **não substitui typecheck**. Um arquivo pode ser sintaticamente válido e ainda usar um tipo incompatível vindo de outro pacote.

---

## 28. PostgreSQL, migrations e RLS reais

A base original tem forte dependência de segurança no banco.

### Ainda precisa ser comprovado após as mudanças

- banco vazio → todas as migrations;
- banco existente → migrations incrementais;
- usuário da aplicação sem `BYPASSRLS`;
- isolamento entre tenants nas novas rotas de Clientes e Mídia;
- isolamento por unidade nas consultas enriquecidas;
- consultas agregadas novas não furam RLS;
- lock/transação da resolução de conflito de importação;
- concorrência real de agendamento continua protegida.

### Casos de maior prioridade

1. `/admin/clientes` com dois tenants;
2. busca global entre dois tenants;
3. foto de duas unidades da mesma barbearia;
4. duas barbearias com mídia de mesmo tipo;
5. duas tentativas concorrentes para o mesmo horário;
6. manipulação de `customerId`, `locationId` ou `professionalId` de outro tenant.

---

## 29. Suíte Vitest/integration/e2e existente

O repositório original já tinha uma quantidade grande de testes. Eles foram alterados em pontos relevantes, inclusive contratos de foto/importação/agenda.

### Precisa ser rodado

- todos os pacotes;
- testes de API;
- testes de agenda;
- testes de caixa/financeiro;
- testes de permissões;
- testes de CRM/WhatsApp;
- testes de plataforma;
- testes novos de Clientes, busca, timeline, mídia e conflitos.

### Atenção

Uma guarda criada durante a reorganização prova uma regra específica. Ela não substitui a suíte antiga que prova comportamentos laterais do domínio.

---

## 30. Build real do Next.js

### Precisa ser comprovado

- compilação completa do `apps/web`;
- resolução dos Server Components/Client Components;
- serialização de props das ilhas;
- Server Actions novas/refatoradas;
- rotas dinâmicas;
- headers e middleware;
- assets CSS depois do R10;
- code splitting do admin.

### R5 — medição de bundle

Foi criado `scripts/medir-bundle-r5.mjs`, mas a medição real depende do build.

Deve ser confirmado que:

- a ilha de importação não entrou no bundle anônimo;
- a busca V11 não contaminou a página pública;
- CSS Modules do admin não foram parar desnecessariamente na superfície pública;
- LCP/bundle da página pública não sofreu regressão relevante.

---

## 31. Upload de mídia R9 em runtime real

Embora o storage isolado tenha sido exercitado, ainda é necessário testar o caminho completo:

`Browser → Server Action Next → API → storage → /media → proxy/Caddy → página pública`

### Matriz mínima de arquivos

- JPEG pequeno;
- PNG pequeno;
- WebP;
- arquivo preparado próximo de 3 MB;
- arquivo >3 MB;
- arquivo que mente extensão/MIME;
- payload inválido;
- nome malicioso;
- remoção;
- substituição;
- upload em duas unidades diferentes.

### Confirmar especificamente

- o `bodySizeLimit: 4mb` é suficiente para o multipart real;
- a API continua recusando acima de 3 MB;
- `/media` recebe os headers corretos;
- Caddy/proxy não intercepta incorretamente;
- persistência sobrevive a restart/recreate de containers;
- permissão de filesystem do volume em produção é correta.

---

## 32. Backup e restauração de mídia

R9 passou a incluir mídia no backup, mas o valor real só existe quando há ensaio de restauração.

### Deve ser testado

1. criar mídia real;
2. realizar backup;
3. destruir banco/volume de teste;
4. restaurar banco;
5. restaurar mídia;
6. abrir página pública;
7. confirmar que as URLs do banco continuam resolvendo para arquivos restaurados.

Sem esse ensaio, “backup inclui mídia” significa apenas que o script está preparado, não que o processo operacional foi provado de ponta a ponta.

---

## 33. Multiunidade

A auditoria já encontrou um bug real de R9 relacionado a unidade, portanto esse eixo merece prioridade extra.

### Cenários mínimos

- unidade A e unidade B com capas diferentes;
- substituir apenas A e comprovar que B permanece intacta;
- serviço/profissional compartilhado versus unidade específica;
- agenda filtrada por unidade;
- busca de cliente com contexto correto;
- navegação entre unidades;
- permissões de funcionário ligado a uma unidade;
- WhatsApp por unidade, respeitando a lacuna já conhecida de conciliação Meta.

---

## 34. Matriz real de papéis e permissões

Foram tomadas várias decisões para evitar vazamento de enriquecimentos. Elas precisam ser comprovadas em sessões reais.

### Papéis recomendados para teste

- dono;
- gerente;
- recepção;
- barbeiro;
- usuário customizado com permissões mínimas.

### Fluxos críticos

- Cliente aparece, mas fiado não aparece sem `finance.view`;
- recepção opera caixa sem ver faturamento, quando esse for o desenho de permissão;
- barbeiro não recebe comparação financeira da equipe;
- busca global não revela destinos proibidos;
- busca global não retorna nomes de cliente sem `customers.view`;
- próximo atendimento não expõe agenda de toda equipe a quem só vê a própria;
- fotos protegidas de cliente continuam protegidas;
- Configurações não aparece para papel sem permissão.

---

## 35. Agenda e concorrência real

V10 mudou a apresentação, não o motor, mas passou a depender de mais informação de jornada na tela.

### Validar

- jornada padrão;
- almoço;
- exceção diária;
- feriado;
- folga;
- férias/bloqueio;
- buffers antes/depois;
- serviço curto;
- serviço longo;
- dois serviços;
- múltiplos profissionais;
- múltiplos recursos;
- reagendamento;
- tentativa concorrente do mesmo slot;
- timezone e mudança de dia;
- mobile com muitas colunas/profissionais.

O buraco visual nunca deve ser considerado confirmação de disponibilidade; o motor continua sendo a decisão final.

---

## 36. Busca global V11

### Validar no app real

- `Ctrl+K`/`Cmd+K` em diferentes navegadores;
- foco e retorno de foco;
- escape;
- teclado completo;
- leitor de tela;
- nomes com acento;
- telefone;
- singular/plural;
- cliente sem agendamento;
- cliente com vários agendamentos;
- usuário sem permissão;
- muitos resultados;
- latência de rede;
- resultado desaparecendo depois de revogação de permissão.

---

## 37. Ficha V2

### Validar no app real

- todas as quatro abas;
- cada permissão isoladamente;
- retorno correto depois de todas as Server Actions;
- cliente sem histórico;
- cliente VIP;
- cliente sem fidelidade;
- fiado;
- assinatura/clube;
- fotos;
- consentimentos;
- LGPD;
- WhatsApp;
- Nova comanda vinculada ao cliente;
- próxima visita;
- total gasto;
- mobile 360/390.

### Hotspot residual

`componentes.tsx` tem ~1.210 linhas na versão auditada. Não é um bug funcional, mas é um ponto de manutenção que deve ser observado numa próxima refatoração se continuar crescendo.

---

## 38. Painel V6

### Validar

- Hoje;
- 7 dias;
- mês;
- links do Assistente com `?dias=N`;
- nenhum texto “hoje” em janela maior;
- estabelecimento sem faturamento;
- estabelecimento sem agenda;
- profissional único;
- equipe grande;
- comparação de ocupação;
- alertas;
- insights existentes;
- ausência de vazamento para o barbeiro.

---

## 39. Responsividade e dispositivos reais

Capturas estáticas ajudaram a detectar overflow, mas não substituem hardware/browser real.

### Matriz recomendada

- Chrome Android 360/390;
- Safari iPhone;
- Chrome desktop 1280/1440;
- notebook 768/1024;
- zoom 200%;
- teclado sem mouse;
- touch em agenda e filtros.

### Verificar especialmente

- topo no mobile;
- abas horizontais;
- timeline;
- paleta de busca;
- uploads;
- ficha;
- formulários longos;
- Configurações.

---

## 40. Acessibilidade real

Foram consideradas regras como alvo de toque, texto junto da cor e organização semântica, mas ainda precisa haver prova com ferramentas/uso real.

### Recomendações

- Axe/Lighthouse como apoio, não único juiz;
- navegação só por teclado;
- foco visível;
- ordem de foco no modal de busca;
- retorno de foco ao fechar;
- leitor de tela para grupos do menu;
- breadcrumb;
- abas;
- status;
- formulários de upload;
- erros de formulário.

---

## 41. Integrações externas que continuam exigindo mundo real

### WhatsApp / Meta

O código de Meta Cloud existe, mas permanecem dependências de prova externa, principalmente:

- Embedded Signup de ponta a ponta em navegador com conta real;
- número real verificado;
- comportamento de múltiplas unidades;
- diferenciação entre resposta a aviso e conversa livre, lacuna já declarada.

### Stripe

A cobrança da plataforma tem integração real, mas ainda precisa ser provada com credenciais/conta e fluxos reais do ambiente de destino.

### Split

**Não está pronto para produção.** O ROADMAP registra provider fake na integração real.

### Fiscal/NFS-e

**Não está pronto para produção.** O emissor real não está contratado/integrado; o modo disponível é `nenhum`/`fake` conforme a matriz.

### Sinal online

A política/motor existe, mas cobrança/reembolso automático via adquirente ainda não está pronto.

---

## 42. Deploy real, proxy, TLS e observabilidade

### Precisa ser feito em ambiente próximo de produção

- `docker compose` completo;
- geração/validação de `.env`;
- Caddy/TLS;
- headers de segurança;
- `/media` atrás do proxy;
- worker;
- healthchecks;
- restart de containers;
- perda temporária do banco;
- logs;
- rotacionamento de backup;
- carga;
- comportamento em deploy/redeploy.

Algumas lacunas do próprio ROADMAP — staging, CD, tracing distribuído, proxy de egresso — continuam explicitamente abertas.

---

# Parte E — Lacunas conhecidas que NÃO foram “resolvidas” por esta reorganização

## 43. Lista atual de 40 lacunas declaradas

Estas lacunas permanecem no `ROADMAP.md`. A reorganização não deve ser interpretada como fechamento delas:

1. O agente de conversa não responde pelo WhatsApp.
2. Conciliação com a Meta só na unidade principal.
3. Arrastar o cartão na agenda para remarcar.
4. Painel como aplicação separada.
5. Taxa real efetivamente cobrada pelo adquirente.
6. Cartão de garantia cobrado somente na falta.
7. Cobrar o sinal pelo produto e devolver automaticamente.
8. Provar Embedded Signup contra a Meta.
9. Campanha por e-mail, push e SMS.
10. Nota de produto NF-e/NFC-e.
11. Indicação com link e anti-fraude.
12. Passar recado para outra pessoa da equipe.
13. Tokenizar cartão do assinante.
14. Ranking entre barbeiros/gamificação.
15. Teste que usa a tela como o usuário usa.
16. Tela do balcão que se atualiza sozinha.
17. Varredura diária do validador de catálogo.
18. Importar agendamentos futuros e histórico.
19. Conversão da página e proporção de erro como alerta.
20. Publicação automática e ambiente de staging.
21. Tracing distribuído.
22. `stock_movements.location_id` obrigatória no banco.
23. Guarda para mecanismo exportado que ninguém oferece.
24. Recusa do domínio sem frase na tela.
25. Página pública por unidade.
26. Fatura em PDF e nota fiscal.
27. Pix pela Stripe e prazo do QR Code.
28. Entrega concorrente do mesmo webhook.
29. Contrato de split exercido pelo adquirente.
30. Papel novo criado pelo dono.
31. Teto de desconto por pessoa.
32. `Idempotency-Key` obrigatório na troca de plano.
33. Segundo fator na troca de plano pelo dono.
34. CAC e payback.
35. Exportação do titular em PDF.
36. Teto de requisição compartilhado entre processos.
37. “Perto de mim” com a coordenada do aparelho.
38. Filtro por serviço na busca do marketplace.
39. Saída de webhook por proxy de egresso.
40. Tabela de versão do schema.

O detalhe de “o que já existe / o que falta / dependência / quando entra” permanece no ROADMAP e deve continuar sendo a fonte para cada item.

---

# Parte F — Hotspots técnicos que continuam existindo

## 44. Maiores arquivos atuais que ainda merecem atenção

Mesmo depois de R10/R11, ainda existem módulos grandes que não foram objeto da reorganização ou que permanecem concentrados:

- `packages/finance/src/comanda.ts` — ~2.091 linhas;
- `packages/scheduling/src/booking.ts` — ~1.714;
- `packages/crm/src/whatsapp.ts` — ~1.482;
- `packages/finance/src/comissao.ts` — ~1.388;
- `packages/finance/src/fiscal.ts` — ~1.251;
- `apps/web/src/app/admin/cliente/[id]/componentes.tsx` — ~1.210;
- `apps/web/src/app/admin/comanda/[id]/page.tsx` — ~1.188;
- `apps/web/src/app/admin/agenda/page.tsx` — ~1.065.

Esses números são **sinais de revisão**, não ordem automática de refatoração. O critério continua sendo responsabilidade/coerência do módulo e custo real de mudança.

---

# Parte G — Plano de validação recomendado antes de piloto sério

## 45. Fase 1 — CI técnico completo

Bloqueador de release:

- [ ] instalar Node 22 + Pnpm 10.33.0;
- [ ] `pnpm install --frozen-lockfile`;
- [ ] subir PostgreSQL de teste;
- [ ] `pnpm verify` completo verde;
- [ ] `pnpm build` verde;
- [ ] `pnpm typecheck` verde;
- [ ] todos os testes Vitest/integration/e2e verdes;
- [ ] Next build produz chunks esperados do R5/V11;
- [ ] nenhum segredo real nos logs/artifacts.

## 46. Fase 2 — Smoke test full stack

- [ ] login dono;
- [ ] login recepção;
- [ ] login barbeiro;
- [ ] Clientes → ficha;
- [ ] buscar João no Ctrl+K;
- [ ] agendar;
- [ ] check-in;
- [ ] iniciar/finalizar;
- [ ] comanda;
- [ ] receber;
- [ ] fiado;
- [ ] comissão;
- [ ] Hoje;
- [ ] Agenda timeline;
- [ ] Painel Hoje/7d/mês;
- [ ] upload/substituição de foto;
- [ ] página pública renderizando mídia;
- [ ] importação com conflito;
- [ ] Configurações.

## 47. Fase 3 — Segurança e multi-tenant

- [ ] IDs de outro tenant em Clientes;
- [ ] IDs de outro tenant em Busca;
- [ ] IDs de outro tenant em mídia;
- [ ] permissões mínimas;
- [ ] exports;
- [ ] impersonação;
- [ ] RLS sem WHERE explícito onde o teste espera proteção de banco;
- [ ] concorrência da Agenda.

## 48. Fase 4 — Infraestrutura

- [ ] volume de mídia persiste;
- [ ] backup e restore de DB + mídia;
- [ ] restart/redeploy;
- [ ] Caddy/TLS;
- [ ] headers;
- [ ] healthchecks;
- [ ] worker;
- [ ] filas;
- [ ] DLQ/retentativas onde aplicável.

## 49. Fase 5 — Integrações reais

- [ ] Meta Embedded Signup numa conta real;
- [ ] envio WhatsApp 1:1/template;
- [ ] webhook Meta;
- [ ] Stripe do billing da plataforma;
- [ ] confirmar no material comercial que split/fiscal/sinal online continuam indisponíveis enquanto a matriz disser ❌.

## 50. Fase 6 — R12 com pessoas reais

### Mínimo

- 5 pessoas novas para teste controlado;
- idealmente papéis diferentes;
- depois 3–5 barbearias em uso assistido.

### Registrar

- tempo;
- sucesso/falha;
- ajuda necessária;
- clique errado;
- local em que procurou primeiro;
- termos que tentou na busca;
- dúvidas de significado;
- telas que pareceram redundantes;
- informação que esperou encontrar e não encontrou.

### Critério melhor que “nota 9/10”

A decisão deve ser baseada em:

- mediana das cinco tarefas;
- taxa de conclusão sem ajuda;
- erros por tarefa;
- observações qualitativas recorrentes.

---

# Parte H — Avaliação de risco por área

## 51. Risco baixo / principalmente estrutural

- R7 matriz de prontidão;
- R6 promessas históricas;
- R8 verdade comercial;
- R10 partição de CSS, desde que build confirme a cascata;
- R11 fachadas, depois do typecheck/build completo;
- documentação R12.

## 52. Risco médio

- V0/V3/V4 navegação;
- V7/V8/V9 design system;
- V6 Painel;
- V2 ficha;
- V11 busca global.

Motivo: muitas telas dependem dessas estruturas, mas grande parte das alterações é frontend/contrato e há guardas específicas.

## 53. Risco médio-alto e prioridade de teste full stack

- V1 Clientes;
- V5 Hoje;
- V10 Agenda;
- R5 resolução de importação;
- R9 mídia.

Motivo: combinam novas consultas/rotas/dados/permissões ou dependem de comportamento real de runtime.

### R9 merece atenção especial

Já foi a área em que a auditoria posterior encontrou dois bugs reais que as primeiras verificações não capturaram. Deve ser uma das primeiras no smoke test full stack.

---

# Parte I — Checklist de “pronto para piloto”

## 54. Não liberar um piloto sério enquanto qualquer item abaixo estiver vermelho

- [ ] `pnpm verify` completo verde em ambiente limpo;
- [ ] build Docker/Next/API/worker completo;
- [ ] migrations do zero e incrementais;
- [ ] RLS/tenant tests completos;
- [ ] smoke test dono/recepção/barbeiro;
- [ ] Agenda/Hoje/Clientes/Comanda aprovados em navegador real;
- [ ] R9 upload 2–3 MB real aprovado;
- [ ] multiunidade de mídia aprovado;
- [ ] backup/restore de mídia aprovado;
- [ ] nenhum erro severo em console/log;
- [ ] pelo menos uma rodada R12 com pessoas novas;
- [ ] WhatsApp real testado se fizer parte da oferta do piloto;
- [ ] material comercial revisado contra a matriz atual.

---

# Parte J — Conclusão

## 55. O que mudou de fato do ZIP original para esta versão

O trabalho não foi “trocar cores”. Houve mudança em:

- arquitetura de informação;
- descoberta de Clientes;
- orientação dentro do painel;
- prioridade operacional;
- agenda visual;
- busca global;
- ficha do cliente;
- painel executivo;
- design system;
- semântica de status;
- estratégia de Client Components;
- upload e persistência de mídia;
- organização de CSS;
- organização de API do frontend;
- organização de Server Actions;
- governança de prontidão;
- verdade comercial;
- instrumentação de usabilidade.

A versão atual é estruturalmente muito mais clara do que o ZIP original e possui um conjunto maior de guardas contra regressão. Entretanto, **a evidência disponível nesta sessão não é suficiente para afirmar que todo o produto está livre de regressão em runtime**.

A conclusão tecnicamente correta é:

> A reorganização foi implementada, passou por uma auditoria estática/contratual profunda e vários bugs adicionais encontrados nessa auditoria foram corrigidos. O próximo risco relevante não está em “inventar mais uma tela”, mas em executar o sistema completo com suas dependências reais e provar, em banco, navegador, infraestrutura e uso humano, que os contratos preservados no código também permanecem corretos em operação.

## 56. Artefatos de referência

- ZIP original: `barbearia-claude-barbershop-app-research-xvejhy.zip`
- Versão final auditada: `barberdock-auditado.zip`
- Auditoria resumida interna: `AUDITORIA_POS_REORGANIZACAO.md`
- ROADMAP atual: `ROADMAP.md`
- Verdade comercial: `docs/comercial/prontidao.md`
- Protocolo de usabilidade: `docs/usabilidade/r12.md`
- Portão principal: `scripts/verify.sh`

---

**Fim do relatório.**
