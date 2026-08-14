# Preparação para o go-live

> O que precisa ser verdade antes da primeira barbearia de verdade, e o que
> **não** precisa. Escrito depois da revisão geral de segurança, com as
> medições feitas nesta máquina.

O risco de go-live deste produto já não é "o código está errado". O portão roda
na esteira, há suíte de ataque, inventário de 123 tabelas com RLS, ensaio de
restauração e medição de responsividade. O risco está em três coisas que **nunca
foram executadas**, e numa quarta que é decisão comercial.

---

## 1. As três que nunca foram executadas

### 1.1 O navegador — fechado

Oitenta blocos de interface, e nada clicava. O e2e da API monta o corpo em
JavaScript; a medição renderiza e mede layout; os testes de integração provam a
regra sem tela. Entre o `<input name="...">` e o `z.object({...})` da borda não
havia nada.

`scripts/percorrer.mjs` fecha isso, e roda dentro da medição. **Os seis
percursos passam:**

| Percurso | O que só ele prova |
|---|---|
| Cliente marca pelo site | a grade, o formulário e o agendamento gravado |
| Balcão entra e fecha venda | login de gestor de verdade e a comanda |
| Onboarding do dono, do zero | conta nova → seis etapas → **o link publicado abre** |
| O dia do barbeiro | senha de primeiro acesso na tela, troca obrigada, desvio para `/admin/meu-dia` |
| LGPD: registrar, exportar e anonimizar | o pedido, o arquivo baixado, e o texto satélite saindo junto |
| Plataforma reativa e bloqueia | a porta sem cadastro, e o efeito no `tenant_platform` |

Cada percurso termina **perguntando ao banco**. "A tela mostrou pronto" é
exatamente o que o gatilho inerte da migração 0079 também mostrava.

#### O que os quatro novos acharam na primeira execução

Nenhum deles falhou por acaso, e nenhum dos três achados aparecia no portão:

1. **`anonimizar_cliente` respondia 500** para qualquer pessoa com ajuste manual
   de saldo. O gatilho da 0079 escreve `note = NULL` e a 0044 exige motivo
   escrito em toda linha de `ajuste`: a constraint recusava e a transação
   inteira abortava. **O direito à exclusão era impossível de exercer**, com
   erro interno na cara de quem tentava responder ao titular. Corrigido na
   migração 0082, com marcador fixo no lugar do nulo — e com teste que fica
   vermelho sem ele.
2. **A plataforma não tinha como ter um operador.** Conta nova nasce `viewer`,
   nenhuma rota promove, e `criar-super-admin.mjs` era a única porta: ninguém
   podia bloquear uma inadimplente, trocar um plano ou encerrar um suporte. O
   comando ganhou `--operador`.
3. **A semente da medição bloqueava uma barbearia e não conferia a resposta** —
   400 por id malformado, depois 403 por papel. O cartão "bloqueada", que a
   função diz existir para medir a linha mais larga da tela, nunca existiu.

### 1.2 As integrações reais — bloqueado por contrato

Nenhuma teve contato com o mundo. O padrão de todas é **não estar ligada**, e
isso é decisão escrita:

| Integração | Interruptor | Padrão | O que falta |
|---|---|---|---|
| Adquirente | `PSP_MODO` | `nenhum` | conta contratada na Stripe |
| Fiscal | `FISCAL_MODO` | `nenhum` | emissor contratado (a regra municipal **não** entra no código, SPEC §5.11) |
| WhatsApp | cadastro por barbearia | sem número | conta na Meta e verificação de empresa |

Com o padrão, o produto opera: a plataforma fatura e o Super Admin registra o
que viu no extrato (bloco 28), a nota não é oferecida — e a tela **diz** —, e o
aviso cai no canal de reserva.

### 1.3 A operação — ensaiada, com números

| Ensaio | Resultado | Medido em |
|---|---|---|
| Restauração de backup | **14s** para 8.000 clientes / dump de 2,1 MB. Confere 123 tabelas por contagem, 147 políticas de RLS, `FORCE` em 121, constraints de exclusão, gatilhos, checks e a versão do schema | `scripts/ensaio-de-restauracao.sh` |
| Migrações 0079–0081 sobre volume | **153 ms, 131 ms, 48 ms** com 400 mil linhas nas tabelas que elas alteram (troca de chave estrangeira e de constraint) | banco descartável com volume gerado |

O ensaio de restauração pergunta ao **banco restaurado**, não ao código de saída
do `pg_restore` — que responderia só "o arquivo não está corrompido".

**O que ainda não foi ensaiado:** o rollback. Não há procedimento escrito para
"a migração quebrou em produção", e as migrações são aditivas por convenção mas
não reversíveis por script.

---

## 2. A triagem das lacunas declaradas

São 38, e **nenhuma delas bloqueia por si**. Lidas em conjunto, elas se
agrupam em quatro famílias:

| Família | Quantas | Bloqueia? |
|---|---|---|
| Depende de **contrato** (Stripe, Meta, emissor fiscal, e-mail, SMS) | 9 | Não — o interruptor deixa o produto operar sem |
| Depende de **infraestrutura** (armazenamento de objeto, Redis, staging/CD, proxy de egresso, tracing) | 6 | **Uma sim** — ver §3 |
| Depende do **primeiro componente de cliente** (arraste na agenda, "perto de mim", tela que se atualiza sozinha, conflito de telefone) | 5 | Não — decisão de arquitetura que merece bloco próprio |
| **Deferimento de produto** com motivo escrito (ranking, papel novo, teto por pessoa, PDF, CAC) | 18 | Não |

A leitura completa de cada uma está em
[`ROADMAP.md`](../ROADMAP.md#lacunas-com-dependência-declarada), com o que já
existe, o que falta e por quê.

---

## 3. O que de fato bloqueia

### 3.1 Não há caminho de deploy

É a lacuna 20, e é a única da lista que impede a operação: **não há ambiente de
staging nem passo de deploy**. A esteira roda o portão e para aí. Ir ao ar exige
decidir onde, e isso é infraestrutura contratada — não código.

### 3.2 O `.env.example` estava incompleto — resolvido

Ele listava 7 variáveis e o código lia 30, incluindo **todas as chaves de
cifra**. Como elas falham alto quando ausentes, o dia do deploy seria subir,
quebrar, ler o erro, acrescentar uma variável, repetir. Pior: `PSP_MODO` e
`FISCAL_MODO` **não** falham alto — a instalação subiria, pareceria pronta, e
não cobraria nem emitiria nota.

Corrigido, e agora há guarda derivada (`scripts/env-example.test.mjs`) que lê
`process.env[...]` do fonte e reprova o que não estiver declarado.

### 3.3 Não há cabeçalho de segurança

Sem CSP, HSTS, `X-Content-Type-Options` nem `X-Frame-Options`. O vetor óbvio
está fechado por outro caminho — os cookies do painel são `sameSite=strict` —,
mas falta profundidade, e o HSTS cobre o primeiro acesso antes de o
`secure: NODE_ENV === 'production'` valer.

---

## 4. Go / no-go

- [x] Os seis percursos verdes
- [ ] Caminho de deploy definido, com ambiente de staging
- [ ] Rollback de migração escrito e ensaiado
- [ ] Restauração ensaiada **no ambiente de produção**, não só aqui
- [ ] Decisão escrita sobre fiscal (`FISCAL_MODO`) e sobre cobrança (`PSP_MODO`)
- [ ] Cabeçalhos de segurança
- [ ] Barbearia-piloto escolhida, com plano de saída escrito

---

## 5. A forma do piloto

Multi-tenant não tem "go live": tem o **primeiro tenant**. Uma barbearia só,
acompanhada diariamente.

E o acompanhamento precisa ser por **consulta ao banco**, não por ausência de
erro no log. A razão está escrita: o gatilho da migração 0079 ficou inerte por
dois commits, sem erro e sem log, e quem o descobriu foi um teste do achado
seguinte. As perguntas do dia: a comissão saiu? o consentimento gravou? a nota
mudou de estado? o aviso foi entregue?
