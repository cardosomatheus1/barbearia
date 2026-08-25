# Barberdock — Auditoria por blocos — Bloco 1: Identidade, autenticação e fronteiras de acesso

**Data:** 24/08/2026  
**Base:** `barberdock-melhoria-notas-bloco12-seguranca-2026-08-24.zip`  
**Escopo:** OTP/sessões de cliente, gestor, MFA, cadastro/login, permissões administrativas, tenant/unidade e configuração de segredos de identidade.

## Veredito

O desenho de identidade já era forte, mas a revisão encontrou **quatro problemas reais** e uma lacuna de proteção estrutural. Todos os problemas de código encontrados neste bloco foram corrigidos e presos por guardas automáticas.

A prova de concorrência/RLS que depende de PostgreSQL real continua escrita mas **não executada neste runtime**.

## Achados e correções

### A1 — OTP de seis dígitos vulnerável a força bruta offline após dump — ALTO — corrigido

**Antes:** `otp_challenges.code_hash` guardava SHA-256 puro do código. Isso evita plaintext, mas um OTP de 6 dígitos possui apenas 1.000.000 de possibilidades; um atacante com somente o dump do banco conseguiria testar o espaço inteiro offline.

**Agora:**
- códigos OTP usam **HMAC-SHA256**;
- segredo exclusivo `OTP_PEPPER`, fora do banco;
- mínimo de 32 caracteres no preflight de produção;
- variável provisionada em `.env.example`, Compose, deploy, Windows e scripts de teste;
- comparação continua em tempo constante;
- rotação do pepper invalida somente desafios pendentes, que duram minutos.

### A2 — sessões-fantasma de gestor — MÉDIO/ALTO — corrigido

Foram encontrados dois caminhos:

1. `/signup` criava uma sessão de 14 dias dentro de `signUpOwner`, mas a rota pública responde `202 -> login` e nunca devolvia o token;
2. login com senha correta de uma barbearia bloqueada emitia sessão antes da checagem de bloqueio; o token era recusado ao cliente, mas a linha permanecia viva.

**Agora:**
- o cadastro público chama `signUpOwner(..., issueSession: false)` e não cria `staff_sessions`;
- o tipo do TypeScript diferencia cadastro com e sem sessão para impedir uso incorreto do retorno;
- qualquer erro posterior à autenticação que impeça a entrega do token tenta revogar a sessão antes de devolver a falha, inclusive conta bloqueada ou falha ao consultar o bloqueio;
- foi criado `revokeStaffSessionByToken` para limpeza segura sob o tenant do próprio token.

### A3 — corrida no cadastro simultâneo — MÉDIO — corrigido

**Antes:** duas requisições simultâneas podiam observar o mesmo e-mail como livre; duas barbearias com nomes iguais também podiam escolher o mesmo slug antes do primeiro commit. A constraint impediria corrupção, mas a requisição perdedora poderia virar erro técnico/500.

**Agora:**
- advisory lock transacional por `signup-email:<email_key>` antes da decisão global de e-mail;
- advisory lock transacional por `signup-slug:<raiz>` antes da escolha do slug;
- foram adicionados testes PostgreSQL para dois cadastros concorrentes do mesmo e-mail e dois cadastros concorrentes com o mesmo nome.

### A4 — ownership implícito em atualizações de sessão — BAIXO, defesa em profundidade — corrigido

Os controllers já passavam apenas a sessão autenticada, mas duas operações confiavam nisso sem repetir a identidade do dono da sessão no `WHERE`.

**Agora:**
- mudança de unidade exige `staff_sessions.id` **e** `staff_user_id`;
- marcação `mfa_verified_at` exige `sessionId` **e** `staffUserId`;
- RLS continua isolando o tenant, e o vínculo individual passa a ser explícito também no SQL.

### A5 — cobertura futura de autorização administrativa — lacuna estrutural — corrigido

Foi adicionada uma guarda que percorre todas as `*controller.ts` de `apps/api/src/admin`.

Ela exige:
- `StaffGuard + PermissaoGuard` nas controllers administrativas;
- `@Exige(...)` em todas as rotas protegidas;
- somente `POST /signup` e `POST /login` podem permanecer públicas no `admin.controller.ts`.

A guarda possui testes negativos e detecta a remoção deliberada de `@Exige`.

## Decisão de política não alterada automaticamente

### Sessão do gestor: 14 dias

O código tinha o comentário “dura o expediente”, mas a constante sempre foi **14 dias**. Isso foi corrigido na documentação: 14 dias é uma decisão de conveniência operacional, não duração de expediente.

Não reduzi silenciosamente para 24 h porque isso muda comportamento do produto e frequência de login. O risco residual é mitigado por:
- sessão listável/revogável por aparelho;
- revogação ao desligar usuário e redefinir senha;
- cookies `httpOnly`, `secure` em produção, `SameSite=Strict`, path `/admin`;
- MFA para operações de dinheiro.

Se o piloto ocorrer majoritariamente em computadores compartilhados, **24 h ou timeout por inatividade** continua sendo uma opção de hardening a decidir conscientemente.

## Validações executadas neste runtime

- guardas diretos `verificar-*.mjs` aplicáveis: **40/40**;
- testes Node autônomos sem Vitest: **95/95**;
- guarda nova de identidade: **PASS**;
- testes negativos da guarda de identidade: **9/9 regressões detectadas** + estado atual;
- preflight de produção: **17/17**;
- TypeScript sintático nos 5 arquivos principais alterados: **5/5**;
- shell alterado: **OK**;
- Compose YAML: **2/2**;
- secret scan do snapshot: **limpo**;
- SQL seguro de produção: **0 raw-unsafe**.

## Provas que continuam externas ao runtime

Os testes PostgreSQL adicionados para concorrência, a suíte completa de identidade sob RLS e a execução integral de `verify.sh` com banco continuam dependendo de PostgreSQL 16/`psql` disponíveis no ambiente.

## Classificação do bloco

**Código/desenho de identidade:** forte, sem achado crítico conhecido restante após as correções desta rodada.  
**Certificação runtime de RLS/concorrência:** pendente do PostgreSQL real.  
**Decisão residual:** duração absoluta da sessão administrativa (14 dias) permanece escolha explícita de produto/segurança.
