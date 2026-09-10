# Revisão de segurança das integrações — 10/09/2026

Revisão manual do código da branch local, complementar às suítes e aos ensaios.
Não representa pentest externo, homologação dos serviços ou aprovação de go-live.

| Fronteira revisada | Comportamento observado | Limite da conclusão |
|---|---|---|
| A1 e documentos fiscais | AES-256-GCM; contexto autenticado inclui tenant, unidade e finalidade; certificado selecionado pela chave, CNPJ e validade; intermediárias apresentadas no mTLS | A montagem da cadeia não estabelece confiança ICP-Brasil nem revogação. A autoridade externa não foi exercitada |
| Entrada XML | DTD e entidades recusados antes do parser; expansão GZip limitada; XSD oficial; DPS retornada comparada integralmente ao snapshot enviado | XSD/estrutura e HTTPS não equivalem à verificação criptográfica da assinatura da autoridade no documento armazenado |
| Stripe SaaS | Autenticação consulta PI existente, verifica tenant, fatura, valor, moeda, cliente e cartão; relê a fatura após a rede; retorno do navegador não quita | SDK/HTTP sintéticos nos ensaios. Cadastro e cobrança reais ainda dependem de configuração e homologação |
| Credenciais Baileys | Chave derivada por HKDF; GCM vinculado ao escopo; credenciais persistidas pelo worker; geração e token de posse cercam escritas; QR tem validade | Pareamento real, reconexão na rede WhatsApp e bloqueio do número não foram exercitados |
| API Baileys | StaffGuard, PermissaoGuard, unidade obtida da sessão; entrada estrita; identificação de texto validada; leitura da conexão sem cache | As suítes e os cenários específicos não constituem matriz exaustiva de todo papel contra toda rota |
| Mensagens locais | Seleção por canal, unidade e finalidade; edição não muda a finalidade de texto existente; variáveis conferidas; promoções incluem saída | A confirmação de socket é sintética. Ausência de aprovação de template não elimina consentimento, limites ou regras do WhatsApp |
| Separação financeira | Stripe atende assinatura da plataforma; comandas, clube e split não usam essa conta por fallback | Adquirentes próprios das barbearias permanecem fora da integração Stripe solicitada |
| Logs HTTP | API registra o padrão da rota; Caddy omite URI e headers de entrada/saída nos logs de acesso e de erro; método/status preservados | Prova com Caddy local em 11 caminhos e erro 502; quatro cenários HTTP da API. Não há inspeção nem saneamento de logs de produção nesta sessão |

Arquivos examinados nesta revisão complementar: `nfse/certificado.ts`,
`nfse/cofre.ts`, `nfse/xml-seguro.ts`, `nfse/assinatura.ts`, `nfse/respostas.ts`,
`stripe-autenticacao.ts`, `baileys/cofre.ts`, `baileys/socket.ts`,
`baileys/runtime.ts`, `baileys/textos.ts`, `whatsapp-canal.ts`,
`whatsapp-conexao.controller.ts`, `log.interceptor.ts`, `deploy/Caddyfile` e a ligação em
`apps/worker/src/main.ts`.

Os resultados de execução pertencem aos logs em
`EVIDENCIAS_CORRECOES_PRE_GO_LIVE/`. A v3 passou em todas as suítes de aplicação,
mas duas guardas falharam e foram corrigidas. V4/v5 foram interrompidas para reparar
logs com credenciais; a v6 verificará a fonte após os reparos. Nenhum segredo ou conteúdo
de clientes reais foi usado.

O vazamento foi reproduzido antes da correção (`proxy-token-fiscal-antes`).
Depois, `proxy-token-fiscal-corrigido` confirmou a ausência de token/chave nos
registros e `proxy-real-redacao-fiscal` repetiu com sucesso as cotas e a recusa
de cabeçalhos forjados no Caddy/Next/API reais.

A ampliação da revisão reproduziu tokens de fila/oferta no log da API, e links
em headers de redirecionamento e logs de erro do Caddy. `api-logs-credenciais-antes`
falhou nos quatro cenários HTTP; a correção passou em 27 testes de log. O Caddy
passou em `proxy-logs-acesso-erro-corrigidos`, inclusive com upstream indisponível.
`proxy-real-logs-corrigidos-reteste` confirmou as cotas com 8 leituras SSR reais.
O primeiro reteste integrado falhou porque o conferidor buscava o slug literal
que foi retirado do log; agora isola temporalmente a fase SSR e conta o padrão
da rota. Não houve relaxamento das expectativas de resposta ou cotas.
