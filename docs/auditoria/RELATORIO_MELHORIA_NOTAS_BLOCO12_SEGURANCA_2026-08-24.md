# Barberdock — Bloco 12 — fechamento do checklist de segurança de lançamento

**Data:** 24/08/2026  
**Base:** Bloco 11 — observabilidade  
**Objetivo:** atacar os itens ainda incompletos do checklist de segurança pré-lançamento sem marcar como aprovado o que depende de infraestrutura externa.

## Veredito

O bloco fechou quatro lacunas concretas de código/processo:

1. **SQL raw/unsafe de produção:** 30 usos foram removidos; o portão agora exige **0** `$queryRawUnsafe/$executeRawUnsafe` em produção.
2. **Bot protection:** criação anônima de conta usa Cloudflare Turnstile com validação server-side; o restante da API continua protegido por rate limit global em duas janelas.
3. **Secret/dependency gate:** snapshot é varrido localmente; CI baixa histórico Git completo e faz secret scan histórico; `pnpm audit --audit-level high` virou bloqueante; Dependabot cobre npm e GitHub Actions.
4. **Criptografia de backup:** dump PostgreSQL e mídia local passam a ser cifrados com **AES-256-GCM**, chave independente, IV aleatório e autenticação antes de permanecer no disco/seguir ao remoto.

Não foram inventadas aprovações para PostgreSQL/RLS, histórico Git real, registry npm ou certificado/domínio publicado.

---

## 1. SQL seguro — item 13

### Antes

Havia cerca de **30 chamadas** `$queryRawUnsafe/$executeRawUnsafe` em 11 arquivos de produção. Muitas ainda usavam placeholders corretamente, mas o nome `Unsafe` deixava a segurança depender de leitura humana caso a caso e permitia regressão futura.

### Agora

- produção usa template/composição segura (`Prisma.sql`/parâmetros);
- `scripts/verificar-sql-seguro.mjs` exige **0 raw-unsafe em produção**;
- ferramentas de teste podem continuar usando raw-unsafe quando necessário para setup/cleanup;
- testes negativos provam que a guarda fica vermelha se `queryRawUnsafe` ou `executeRawUnsafe` voltarem à produção.

**Resultado:** `SQL seguro: 0 chamadas raw-unsafe em código de produção`.

---

## 2. Bot protection — item 12

### Turnstile na criação de conta

Foi adicionada validação completa de Cloudflare Turnstile:

- widget apenas em `/admin/criar-conta`;
- token encaminhado pela Server Action;
- API valida o token no `Siteverify` **antes de qualquer escrita**;
- POST server-side;
- timeout;
- redirects bloqueados;
- `action=signup` conferida;
- hostname permitido conferido;
- falha fechada em produção quando a configuração está ausente;
- indisponibilidade do provedor não libera cadastro.

A CSP abre Cloudflare apenas nessa rota; as páginas públicas de agenda continuam sem script de terceiro.

### Demais portas públicas

O Barberdock já tinha `ThrottlerGuard` global. A guarda anti-bot agora também exige:

- `ThrottlerModule.forRoot(throttlerConfig())`;
- `ThrottlerGuard` como `APP_GUARD`;
- duas janelas de rate limit (curta + longa);
- nenhum `@SkipThrottle` fora do health check.

### Evidência

- runtime isolado do Turnstile: **9/9 cenários**;
- guarda anti-bot + mutações negativas: **9/9**.

---

## 3. Secret scan — item 2

### Snapshot atual

`node scripts/verificar-segredos.mjs` terminou com:

> `secret scan: árvore atual limpa`

O scanner cobre, entre outros:

- arquivos `.env` reais;
- private keys PEM;
- AWS access keys;
- Stripe live secrets;
- GitHub tokens;
- Slack tokens;
- Google API keys;
- literais atribuídos a nomes de variável explicitamente sensíveis.

Valores encontrados **não são impressos** no log.

### Histórico Git

O scanner foi fortalecido para `--history`:

- detecta `.env` que já foi commitado e removido;
- detecta secrets fortes em diffs antigos;
- detecta variável sensível adicionada no passado e removida depois;
- testes criam um repositório Git descartável, commitam o segredo, removem e comprovam que o histórico continua vermelho.

O CI usa `actions/checkout` com `fetch-depth: 0` e executa:

`node scripts/verificar-segredos.mjs --history`

**Limitação desta entrega:** o ZIP não contém `.git`; portanto o histórico real deste projeto não pôde ser lido nesta sessão. O mecanismo foi executado contra históricos Git artificiais, mas o repositório verdadeiro ainda precisa passar pelo workflow.

---

## 4. Dependency scan — item 20

O portão GitHub Actions agora executa:

`pnpm audit --audit-level high`

sem `continue-on-error`. Uma vulnerabilidade high/critical conhecida bloqueia a esteira.

Também foi criado `.github/dependabot.yml` com atualização semanal para:

- ecossistema npm/pnpm;
- GitHub Actions.

**Limitação desta sessão:** `pnpm 10.33.0` não pôde ser baixado porque o runtime não resolve `registry.npmjs.org` (`EAI_AGAIN`). Portanto o *audit atual* das versões do lockfile ainda precisa rodar no CI/com rede. O portão que o torna obrigatório está implementado e validado estruturalmente.

---

## 5. Criptografia de backup — item 5

A camada de segredos já cifrava MFA, webhooks e token WhatsApp com AES-256-GCM e senhas usavam scrypt. O ponto ainda exposto eram os **backups em arquivo**.

Agora:

- `BACKUP_ENCRYPTION_KEY`: chave própria de 32 bytes base64, gerada por `deploy/segredos.sh`;
- `scripts/backup-crypto.mjs`: AES-256-GCM;
- IV aleatório de 12 bytes por artefato;
- tag GCM de 16 bytes;
- `check` autentica o arquivo inteiro;
- chave errada e ciphertext adulterado falham;
- decrypt com erro não deixa saída parcial aceita;
- `deploy/backup.sh` cifra antes do upload/rotação;
- plaintext temporário é removido inclusive em falha;
- remoto recebe apenas `.dump.enc` / `.tar.gz.enc`;
- preflight de produção exige chave válida;
- documentação de restauração foi atualizada.

### Testes

- runtime criptográfico: **5/5**;
- integração real do shell com `backup.sh` simulado: **1/1**;
- guarda arquitetural + regressões artificiais: **7/7**.

Isso melhora a proteção de dados em repouso sob controle da aplicação. Criptografia do **volume do VPS/PostgreSQL/S3 físico** continua sendo configuração do provedor de infraestrutura, não algo que o código da aplicação possa certificar.

---

## 6. HTTPS — item 19

Permanece implementado em código/configuração:

- Caddy com TLS automático;
- redirecionamento `www` para HTTPS canônico;
- HSTS;
- `WEB_URL` de produção recusada se não for HTTPS;
- localhost recusado pelo preflight;
- cookies seguros já eram condicionados à produção.

**Prova restante:** certificado, redirect e HSTS no domínio publicado real. Não é possível certificar TLS público neste runtime.

---

## 7. RLS — item 4

Nada foi reclassificado artificialmente. RLS/`FORCE ROW LEVEL SECURITY` e os guardas de desenho continuam no projeto, mas a prova integral ainda depende do PostgreSQL 16 e das suítes que estavam skipped na rodada original.

---

## 8. Leitura atual dos 20 itens

| # | Controle | Estado após Bloco 12 |
|---:|---|---|
| 1 | API keys/secrets server-side | ✅ |
| 2 | Secrets no Git | 🟡 snapshot limpo + histórico obrigatório no CI; histórico real ainda não disponível neste ZIP |
| 3 | Public key de DB | ➖ não se aplica: navegador não acessa PostgreSQL diretamente |
| 4 | RLS | 🟡 implementado; prova PostgreSQL real pendente |
| 5 | Criptografia de dados | ✅ segredos sensíveis + backups cifrados; criptografia física do volume depende do provedor |
| 6 | Auth server-side | ✅ |
| 7 | Restrição de acesso | ✅ |
| 8 | Mass assignment | ✅ |
| 9 | Cookies | ✅ |
| 10 | Hash de senhas | ✅ scrypt |
| 11 | Rate limit | ✅ global, duas janelas |
| 12 | Bot protection | ✅ Turnstile no signup + rate limit global |
| 13 | Queries parametrizadas | ✅ 0 raw-unsafe em produção |
| 14 | Validação de inputs | ✅ |
| 15 | Não vazar conteúdo | ✅ logs/erros sanitizados |
| 16 | Uploads restritos | ✅ |
| 17 | Respostas de API controladas | ✅ |
| 18 | Security headers | ✅ |
| 19 | HTTPS | 🟡 implementação fechada; smoke público pendente |
| 20 | Scan de dependências | 🟡 bloqueante no CI; execução atual depende de acesso ao registry |

Leitura honesta: **15 controles fechados**, **4 aguardando prova externa**, **1 não aplicável à arquitetura**.

---

## 9. Validação final deste runtime

- verificadores diretos `verificar-*.mjs`: **40/40 PASS**;
- testes Node autônomos aplicáveis: **19/19 PASS**;
- scripts que importam Vitest: **23 não executados neste runtime**;
- TypeScript/TSX — sintaxe: **772/772**;
- Turnstile runtime isolado: **9/9**;
- backup AES-GCM runtime: **5/5**;
- backup shell integrado: **1/1**;
- secret scan do snapshot: **limpo**;
- secret scan histórico: mecanismo testado; histórico real indisponível sem `.git`;
- shell (`bash -n`): **OK**;
- YAML (workflow, Dependabot, compose): **4/4 OK**;
- ZIP final: verificar após empacotamento.

## 10. O que continua externo

1. PostgreSQL 16 + `scripts/verify.sh` completo, incluindo RLS/migração 0109/E2E;
2. secret scan do **histórico Git verdadeiro**;
3. `pnpm audit --audit-level high` com acesso ao registry;
4. smoke HTTPS/HSTS no domínio publicado;
5. smoke S3/Meta/Stripe nos provedores reais conforme as integrações forem ativadas.

Esses itens não são falta de implementação deste bloco; são provas que exigem serviços/estado que este artefato isolado não possui.
