# Auditoria técnica pré-go-live — Barberdock

**Parecer: NO-GO para o lançamento completo solicitado.** O núcleo possui evidências positivas de funcionamento, isolamento e concorrência, mas a versão ainda tem fluxos financeiros incompletos, fiscal sem emissor real, dependências vulneráveis e problemas nos mecanismos de migração, recuperação e liberação.

Repositório: <https://github.com/cardosomatheus1/barbearia>. Branch: `claude/barbershop-app-research-xvejhy`. Commit: **`3d90fc62de2947fda05aed32407d5a2f2852340b`**, revalidado contra o HEAD remoto ao final dos testes principais. Data: 09/09/2026, UTC.

## Escopo e forma de execução

O proprietário pediu auditoria para lançamento completo, incluindo pagamentos, WhatsApp e fiscal. Informou fiscal ainda não implementado, pagamentos pendentes de configuração e liberação Meta obtida. A auditoria incorporou essas condições; não reduziu o escopo a agenda/caixa nem tratou a aprovação Meta como homologação do software.

Foi usado clone isolado, histórico Git completo, dependências do lockfile e PostgreSQL local com dados sintéticos. Os testes de aplicação conectaram com role restrito; a conexão administrativa foi usada somente para preparar/verificar bancos de auditoria. Foram executados código compilado, suites do repositório, sondas HTTP, percursos Chromium, carga e reproduções independentes.

**Não houve alteração de código de produto, commit, push, deploy, migração em produção ou uso real de provedores.** Os novos arquivos são relatórios, inventários e provas em `output/`. A homologação externa e a certificação da infraestrutura real continuam pendentes; esta execução local não as representa.

## Principais bloqueios

1. **Pagamento por cartão não se completa pela opção oferecida na comanda.** O adapter cria intenção, mas não entrega captura/confirmação ou checkout à tela. Configurar a chave não resolve esse caminho.
2. **Fiscal real está ausente.** O código só seleciona `nenhum`/`fake` e corretamente recusa fake em produção. Split e recorrência do clube também permanecem sem provedores reais.
3. **Recuperação não é confiavelmente certificada pelos scripts.** O restore pode ser aprovado mesmo retirando grants da aplicação; também aprova schema antigo. O rollback acusa diferença em SQL semanticamente equivalente.
4. **Migração interrompida pode gerar journal falso.** Uma base com apenas a primeira migração foi registrada como tendo aplicado 83 migrações, antes de falhar por tabelas ausentes.
5. **O portão de deploy pode aprovar evidência incompleta.** Aceita checks pulados ou sem os jobs obrigatórios, não fixa o artefato ao SHA consultado e usa homepage como prova operacional insuficiente.
6. **Segurança da configuração e dependências exige tratamento.** Há advisories altos/críticos no lockfile; o compose compartilha credenciais administrativas entre API, web e worker. Não foi demonstrada exploração dessas condições.

O registro contém **14 achados abertos**, com natureza da prova, impacto, referência, responsável funcional e critério de reteste. A classificação é alta em AUD-01–09 e média em AUD-10–14; a incidência de AUD-03 na liberação depende das capacidades financeiras efetivamente ofertadas. Ver [registro completo de achados](ACHADOS_PRE_GO_LIVE.md).

## Evidências positivas e resultados dos testes

| Verificação | Resultado observado |
|---|---|
| Inventário | 3 aplicações, 11 pacotes, 64 arquivos controller / 71 classes, **371 rotas**, **207 escritas**, 80 páginas Next e 119 migrações |
| Schema aplicado | 130 tabelas, 127 com FORCE RLS, 160 políticas. Exceções com `tenant_id` sem RLS: `jobs` e `marketplace_listings`, por desenho; ausência de RLS nelas não foi automaticamente classificada como vazamento |
| Instalação, tipos e build | Instalação pelo lockfile, Prisma, typecheck e builds passaram; build completo incluído na medição |
| Suites com contagem preservada | **3.494 aprovados e 10 reprovados em 3.504 casos**, além de API, scripts e invariantes SQL. Os 10 erros foram diagnosticados como inconsistências temporais das fixtures |
| API completa | Etapa aprovada. Sem inventar contagem final de casos não preservada pelo script |
| Sonda de autorização anônima | **345/345 rotas protegidas retornaram 401**, incluindo 194 escritas |
| Sonda das demais entradas | 26 rotas públicas exercitadas, 13 de escrita; respostas 400/404 ou 200 legítimos; zero 500 nesse cenário |
| Navegador — script oficial | **10 percursos completos aprovados**, com confirmação no banco: agenda, conversa do site, campanha sem template aprovado, venda no balcão, onboarding/publicação, equipe, LGPD, plataforma, headers e menus por papel |
| Navegador — complemento independente | **Remarcação e cancelamento do cliente aprovados**, em viewport 390 px, conferindo estado anterior, nova reserva e cancelamento no banco. Sessão sintética válida; entrega de OTP não homologada |
| Responsividade | **96 telas/estados**, nas larguras 360, 390, 768 e 1280 px, passaram no script de medição |
| Disponibilidade sob carga | 5 profissionais × 7 dias, 755 horários ocupados, 120 amostras / 8 simultâneas: **P95 367 ms**, P99 384 ms, vazão 28,2 req/s. Meta do cenário: P95 < 800 ms |
| Disputa de horário | **1 reserva criada + 99 conflitos 409 + zero 500**; banco confirmou uma linha ativa e replay idempotente. 100 respostas em 1.858 ms |
| Worker | Processo retomou após SIGKILL e permaneceu ativo durante a medição; suite de jobs: 100 casos aprovados. Retomar processo não é, isoladamente, prova de reconciliação em um provedor externo |

Os testes existentes são uma base útil, mas sua aprovação não demonstra automaticamente que todas as regras de todas as rotas foram verificadas. A [matriz por rota](INVENTARIO_E_MATRIZ_DE_COBERTURA.csv) identifica exatamente a sonda realizada, sem transformar 401 em cobertura funcional.

## Por que o gate continua reprovado

A execução controlada do verify terminou com saída 1 e quatro etapas reprovadas: scheduling, finance, CRM e backup shell. Os dez erros de domínio desapareceram em cópias dos testes com datas coerentes, sem alterar produto ou asserções. Os dois testes de backup shell passaram ao remover a chave herdada do ambiente; a criptografia recusava corretamente uma chave diferente da fixture.

Isso esclarece as causas, mas **o código original permanece com a regressão vermelha**. Não se substituiu o resultado original pelos experimentos diagnósticos. A varredura histórica também reprovou por três fixtures de testes e a auditoria de dependências reprovou por advisories conhecidos.

A consulta pública ao GitHub encontrou o mesmo SHA com `pnpm verify=failure` e `pilha, navegador e cargas=skipped`. A medição local completa, por sua vez, passou. Esses resultados são registrados separadamente: teste local não altera o estado do CI remoto.

O primeiro verify foi interrompido por saturação desta máquina; a repetição manteve comandos, limitou simultaneidade e concluiu. O histórico das tentativas e suas causas está em [execução e retestes](RETESTE_E_REGRESSAO.md).

## Cobertura por frente do plano

| Frente | Evidência produzida | Limite ou pendência |
|---|---|---|
| A0 — inventário | Código, rotas/guards/permissões, páginas, pacotes, migrations e schema real catalogados | Volume de produção, documentos/localidades fiscais e oferta financeira final ainda precisam ser formalizados |
| A1 — engenharia | Build, tipos, regressão, CI, dependências e histórico de segredos | Gate vermelho; não houve revisão jurídica completa de licenças nem scan de imagem Docker construída |
| A2 — identidade/isolamento | Identity, invariantes RLS, suites de ataque/guards/API e todas as entradas HTTP sondadas | Não há matriz exaustiva papel × rota × tenant × unidade executada independentemente; a proteção de proxy tem AUD-10 |
| A3 — agenda/atendimento | Suites de agenda, ofertas, onboarding/catálogo; navegador; disputa de 100 reservas; remarcação/cancelamento extras | Oferta/espera foi exercitada em integração, não como jornada completa por WhatsApp real |
| A4 — financeiro/estoque | Suite financeira e API; venda de balcão; diagnósticos de retorno | Conferidores auxiliares de números/telas não chegaram às comparações por incompatibilidade de fixture; não há prova independente completa de todos os relatórios. Providers locais não comprovam movimentação externa |
| A5 — pagamentos | Contratos, adapter Stripe, código de webhook/reconciliação e fluxo local | AUD-01/AUD-03; configuração e certificação externa pendentes |
| A6 — fiscal | Ausência de emissor real confirmada; contratos e fluxo simulado examinados | AUD-02; implementação, documentos/regimes e homologação pendentes |
| A7 — WhatsApp | Código Meta/identidade, suites de CRM/API, estados e roteamento examinados | Sem sessão de homologação externa; conciliação de filiais incompleta; agente do site não certifica agente no WhatsApp |
| A8 — plataforma/multiunidade | Suite platform, financeiro/CRM/API, fluxo de bloqueio/reativação e perfis | Não equivale a homologar toda operação de rede/franquia ou PSP por filial |
| A9 — LGPD/dados | Suites e percurso real de registrar/exportar/anonimizar; retenção diagnosticada | Política jurídica, contratos, acesso humano e procedimento organizacional não certificados |
| A10 — jobs | Integração da fila e retomada do worker na pilha | Falha após efeito em provedor real ainda deve ser certificada |
| A11 — experiência/desempenho | 96 estados em 4 larguras, 10 percursos oficiais + 2 complementares, carga local | Sem Safari/iOS, leitor de tela humano, LCP sob 4G controlado, soak prolongado ou SLA no volume real |
| A12 — operação | Migração limpa/repetida/interrompida, restore, rollback, código de deploy/segredos e sonda de saúde | Achados abertos; sem Docker/Caddy/TLS de produção, recuperação de backup remoto/mídia real, aplicação anterior ou entrega de alertas testados no destino |

Os critérios externos e capacidades ainda não implementadas estão detalhados em [homologação de pagamentos, WhatsApp e fiscal](HOMOLOGACAO_PAGAMENTOS_WHATSAPP_FISCAL.md).

## Decisão e próximos marcos

O avanço recomendado é tratar os bloqueios de implementação e recuperação, atualizar dependências/reduzir privilégios, tornar o gate confiável e homologar as três integrações. Em seguida, retestar o novo commit com os cenários que falharam, os consumidores afetados, o gate integral e a pilha completa.

Não há base técnica nesta versão para prometer uma data de lançamento completo apenas por configuração. A aprovação depende das entregas e provas, não de contagem de testes ou de marcas históricas de conclusão no roadmap.

Entregáveis:

- [Achados e critérios de correção](ACHADOS_PRE_GO_LIVE.md).
- [Inventário e matriz HTTP por rota](INVENTARIO_E_MATRIZ_DE_COBERTURA.csv), [inventário estruturado](INVENTARIO_PRE_GO_LIVE.json).
- [Integrações e homologação](HOMOLOGACAO_PAGAMENTOS_WHATSAPP_FISCAL.md).
- [Execução, falhas e retestes diagnósticos](RETESTE_E_REGRESSAO.md).
- [Parecer de liberação](PARECER_GO_NO_GO.md).
- [Evidências e comandos](EVIDENCIAS_PRE_GO_LIVE/INDEX.md).
