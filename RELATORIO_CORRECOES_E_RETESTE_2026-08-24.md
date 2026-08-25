# Barberdock — correções e reteste executável

**Data:** 24/08/2026  
**Base:** `barberdock-backlog-codigo-final-2026-08-24.zip`

## Veredito

Os bloqueadores de código encontrados na primeira validação foram corrigidos. No escopo executável sem PostgreSQL, o repositório está verde: builds de produção, typecheck, testes unitários, guardas estruturais e medição de bundle concluíram sem falha.

Ainda não é possível certificar o portão completo de backend/banco neste ambiente. O runtime não fornece `postgres`, `psql` ou `pg_isready`, nem Docker/Podman. Por isso, 2.011 casos dependentes de PostgreSQL foram coletados e marcados como `skipped`; eles não foram contabilizados como aprovados.

## Correções aplicadas

- fachada de Server Actions compatível com o compilador do Next;
- nulabilidade e identificação de pagamentos nos fluxos de cobrança/cancelamento;
- catálogo e vocabulário da nova ação de auditoria de conflito de importação;
- opcionais estritos na API e no registro de seções do painel;
- determinismo da apuração por data injetada;
- contratos de testes de CRM, Finance, Identity e Scheduling atualizados;
- filtro defensivo de mensagens avulsas para tipos de campanha;
- logout/cabeçalho restaurados na lista de clientes e reconhecidos no painel do dia;
- tokens, dimensões de imagem, largura responsiva e compatibilidade CSS corrigidos;
- guardas de ações reorganizadas para ler os módulos reais, sem depender da antiga fachada monolítica;
- função interna de expiração deixou de ser classificada como job exportado órfão;
- lista de estados fiscais passou a usar o catálogo central;
- teste unitário do Embedded Signup deixou de abrir banco por meio de uma porta injetável;
- contratos estruturais V2, V5, V6 e V10 atualizados para a forma explícita das faixas responsivas.

## Evidências verdes

| Etapa | Resultado |
|---|---:|
| Typecheck | **14/14 projetos** |
| Build de pacotes | **11/11** |
| Build API | **OK** |
| Build Worker | **OK** |
| `next build` de produção | **OK, sem avisos; 73 páginas estáticas geradas** |
| Guardas estruturais | **23/23** |
| Guardas Vitest de repositório | **83/83** |
| Testes Node autônomos | **17/17 asserções em 5 arquivos** |
| Core | **1.421/1.421** |
| UI | **90/90** |
| Web | **179/179** |
| API sem banco | **77 aprovados; 439 dependentes de banco ignorados** |
| CRM sem banco | **49 aprovados; 324 dependentes de banco ignorados** |
| Finance sem banco | **5 aprovados; 499 dependentes de banco ignorados** |
| Identity sem banco | **50 aprovados; 149 dependentes de banco ignorados** |
| Jobs sem banco | **8 aprovados; 87 dependentes de banco ignorados** |
| Platform sem banco | **48 aprovados; 172 dependentes de banco ignorados** |
| Scheduling sem banco | **8 aprovados; 260 dependentes de banco ignorados** |
| Catalog/DB/Onboarding | **81 dependentes de banco ignorados** |
| Adaptador S3 simulado | **6/6** |

## R5 — build e bundle reais

O build de produção foi executado com Next `15.5.23`.

- First Load JS compartilhado informado pelo Next: **102 kB**;
- medidor do projeto: público **101 kB JS + 0 kB CSS gzip**;
- rota de importação: **101 kB JS + 1 kB CSS gzip**;
- **2 arquivos exclusivos do admin**, sem a ilha entrar no público.

Isso fecha a prova de build/chunks/budget do R5. A confirmação de LCP público abaixo de 2,5 s em perfil 4G continua exigindo uma execução de navegador em ambiente publicado e uma referência de comparação; não foi inventada a partir do tamanho do bundle.

## Banco e E2E

O pré-requisito oficial `scripts/pg-de-pe.sh` foi executado e falhou porque `pg_isready` não existe. Também foram confirmadas as ausências de `postgres`, `psql`, Docker e Podman.

Consequentemente, continuam sem prova neste runtime:

- aplicação das 108 migrações contra PostgreSQL real e repetibilidade;
- invariantes SQL;
- RLS e isolamento de tenant;
- integrações reais de DB, Identity, Scheduling, Onboarding, Catalog, Finance, CRM, Jobs e Platform;
- E2E completo da API.

Não há falha conhecida nessas suítes: elas simplesmente não executaram. O próximo ambiente precisa fornecer PostgreSQL 16 e rodar `scripts/verify.sh` sem `skip`.

## Aceites externos que permanecem

- **V8:** revisão visual humana global;
- **R5/LCP:** medição pública em navegador/4G e comparação com referência;
- **R12:** pessoas novas nos cinco percursos e operação assistida em 3–5 barbearias;
- **S3 real:** bucket, endpoint e credenciais do provedor escolhido, seguidos do smoke real;
- **Banco/E2E:** portão integral com PostgreSQL 16.

## Classificação final desta rodada

- **Bloqueadores conhecidos de código/build/typecheck/unitários:** fechados.
- **Portão completo de backend/banco:** não certificável neste runtime por ausência do serviço e das ferramentas PostgreSQL.
- **Aceite de produto:** continua dependendo das provas humanas e de provedores externos listadas acima.
