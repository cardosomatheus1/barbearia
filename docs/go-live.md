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

### 1.1 O navegador — cobertura principal automatizada, aceite ainda parcial

Oitenta blocos de interface, e nada clicava. O e2e da API monta o corpo em
JavaScript; a medição renderiza e mede layout; os testes de integração provam a
regra sem tela. Entre o `<input name="...">` e o `z.object({...})` da borda não
havia nada.

`scripts/percorrer.mjs` fecha os caminhos abaixo e roda dentro da medição. **Os
10 percursos atualmente definidos são:**

| Percurso | O que só ele prova |
|---|---|
| Cliente marca pelo site | a grade, o formulário e o agendamento gravado |
| Cliente marca pela conversa | texto livre chega ao mesmo motor e termina na reserva gravada |
| Dono monta campanha sem texto aprovado | a UI não promete envio por um canal que ainda não foi conectado |
| Balcão entra e fecha venda | login de gestor de verdade e a comanda |
| Onboarding do dono, do zero | conta nova → seis etapas → **o link publicado abre** |
| O dia do barbeiro | senha de primeiro acesso na tela, troca obrigada, desvio para `/admin/meu-dia` |
| LGPD: registrar, exportar e anonimizar | o pedido, o arquivo baixado, e o texto satélite saindo junto |
| Plataforma reativa e bloqueia | a porta sem cadastro, e o efeito no `tenant_platform` |
| Cabeçalhos de segurança | CSP/HSTS e demais cabeçalhos saem do servidor real |
| Menu respeita capacidades | a navegação não oferece o que a conta não consegue abrir |

Cada percurso termina **perguntando ao banco**. "A tela mostrou pronto" é
exatamente o que o gatilho inerte da migração 0079 também mostrava.

#### Cobertura que ainda falta no navegador

Os 10 percursos acima não são sinônimo de cobertura integral do produto. Antes
do go-live, a mesma forma clique → API → banco → efeito precisa cobrir:

- cancelamento e remarcação pelo cliente;
- lista de espera, oferta e aceite de vaga;
- walk-in, atendimento e fechamento da comanda;
- compra/consumo de pacote e ciclo de assinatura;
- segunda unidade operando ao mesmo tempo que a matriz;
- estorno online refletido na interface e no razão;
- WhatsApp real, que depende de número e templates aprovados.

Há cobertura de domínio/API para partes desses casos, mas ela não prova os nomes
dos campos, navegação e efeitos externos do navegador. Até esses percursos
entrarem e passarem, o aceite de interface continua parcial.

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

### 1.2 As integrações reais — certificação atual

O código contém providers reais para identidade Meta, WhatsApp CRM e Stripe. O
ROADMAP registra exercício histórico da Stripe em test mode, mas o head `0117`
ainda precisa de uma evidência reproduzível com as contas atuais. Fiscal e split
não possuem provider real; nesses dois casos não basta preencher credenciais.

O padrão seguro continua sendo **não ligar o que não foi certificado**:

| Integração | Interruptor | Padrão | O que falta |
|---|---|---|---|
| OTP/primeiro acesso | `IDENTITY_MESSAGING_MODO` | `console` apenas fora de produção | WABA central, número, dois templates aprovados e entrega real em aparelho |
| Proteção anti-bot | `BOT_PROTECTION_MODO` | `turnstile` — exige as três chaves | conta na Cloudflare e as chaves no `.env`. `nenhum` assume a pendência por escrito e deixa `POST /admin/signup` sem proteção |
| Adquirente | `PSP_MODO` | `nenhum` | conta contratada na Stripe e smoke atual de cobrança/webhook/estorno |
| Fiscal | **recurso da plataforma** + `FISCAL_MODO` | desligado | implementar e contratar emissor real (a regra municipal **não** entra no código, SPEC §5.11) |
| WhatsApp CRM | cadastro por barbearia | sem número | conta Meta, empresa verificada, Embedded Signup e templates reais |
| Split | provider montado no Worker | fake, com repasse recusado | implementar provider real, contratar split e concluir KYC dos recebedores |

Com o padrão, o produto opera: a plataforma fatura e o Super Admin registra o
que viu no extrato (bloco 28), a nota **não aparece**, e o aviso cai no canal de
reserva.

#### O fiscal tem dois interruptores, e eles respondem coisas diferentes

`FISCAL_MODO` é da **instalação**: existe emissor contratado? Enquanto ele é
`nenhum`, a rota de emitir responde 503 e a tela diz isso em letras — que é a
convenção do repositório para gatilho que ainda não funciona.

O recurso `fiscal` é da **conta**: esta barbearia já tem nota fiscal? Ele nasce
desligado no catálogo (`feature_flags`), não entra em `plan_features`, e só é
ligado pelo toggle do Super Admin, uma conta de cada vez. Desligado, a tela some
do menu, o endereço responde 404 e o cartão da comanda não aparece — porque quem
decidiu não foi a barbearia, e mandá-la procurar quem libera é o pior recado
possível.

A convenção do "gatilho marcado, nunca escondido" continua valendo para o que a
barbearia liga. Quando quem decide é a plataforma, o recurso desligado **não
existe** para o outro lado — é a mesma razão de a guarda responder 404 e não 403.

### 1.3 A operação — ensaiada, com números

| Ensaio | Resultado | Medido em |
|---|---|---|
| Restauração de backup — medição histórica | **14s** para 8.000 clientes / dump de 2,1 MB. Naquele head, conferiu 123 tabelas por contagem, 147 políticas de RLS, `FORCE` em 121, constraints de exclusão, gatilhos, checks e a versão do schema | `scripts/ensaio-de-restauracao.sh`; precisa ser repetido no head `0117` antes do go-live |
| Migrações 0079–0081 sobre volume | **153 ms, 131 ms, 48 ms** com 400 mil linhas nas tabelas que elas alteram (troca de chave estrangeira e de constraint) | banco descartável com volume gerado |

O ensaio de restauração pergunta ao **banco restaurado**, não ao código de saída
do `pg_restore` — que responderia só "o arquivo não está corrompido".

### 1.4 A barbearia de demonstração, e as duas conferências

`scripts/semear-fundo.mjs` simula 245 dias dia a dia — jornada por dia da
semana, peso por hora, crescimento, sazonalidade e 620 clientes com ciclo
próprio — e `scripts/semear-detalhes.mjs` preenche o que o movimento não produz:
prateleira, clube, pacote, financeiro, marketing e integrações. As 41 tabelas
com linha, e cada coisa apontando para as outras.

Sobre ela rodam duas conferências, e elas existem para perguntas que os outros
portões não fazem:

| Ferramenta | A pergunta |
|---|---|
| `scripts/conferir-telas.mjs` | o dado está no banco **e** está na tela? (33 telas, cada uma pelo papel mais baixo que deveria vê-la) |
| `scripts/conferir-numeros.mjs` | o mesmo fato, por caminhos e papéis diferentes, dá o mesmo número? |

A segunda é a §6 pergunta 6 virada código, e foi ela que achou o desconto sumido
do DRE e a gorjeta contada como faturamento em três consultas.

### 1.5 A volta atrás — ensaiada, com números

Havia uma lacuna aqui, e ela estava mal formulada: *"as migrações são aditivas
por convenção mas não reversíveis por script"*. Migração aditiva **não precisa**
ser reversível — o que precisa ser verdade é outra coisa, e agora ela é
verificada.

**Existem duas voltas, e a pergunta que as separa é: o que quebrou?**

| O que quebrou | A volta | Custo |
|---|---|---|
| O aplicativo novo, com o banco bom | sobe a imagem anterior | segundos, sem tocar em dado |
| A migração em si | restaura o backup de antes dela | **2,7 s** medidos, mais o dado escrito na janela |

A primeira é a que acontece quase sempre, e ela só funciona se a versão anterior
continuar rodando contra o banco novo. É por isso que
`packages/db/test/migracao-aditiva.test.mjs` entrou no portão: ele varre as 82
migrações atrás das cinco formas que quebram quem está no ar — `DROP TABLE`,
`DROP COLUMN`, `RENAME`, mudança de tipo e `SET NOT NULL`. Nenhuma aparece, e a
convenção deixa de valer por disciplina e passa a valer porque o portão cobra.

`DROP CONSTRAINT` fica de fora da lista de propósito: afrouxar uma regra não
quebra quem já obedecia. Apertar quebraria — e é por isso que `SET NOT NULL`
está lá.

A segunda é ensaiada por `scripts/ensaio-de-rollback.sh`, sobre 30 mil clientes
e 90 mil lançamentos:

| Passo | Tempo |
|---|---|
| backup imediatamente antes de migrar | 820 ms (5,6 MB) |
| aplicar a migração | 51 ms |
| **restaurar o backup** | **2.684 ms** ← a indisponibilidade real |

E o ensaio confere que o banco restaurado **é** o de antes, por uma assinatura
do schema inteiro — colunas, corpo de função e definição de constraint. A
primeira versão procurava uma coluna específica como marca da migração e a
coluna era de outra: marcador escolhido a dedo prova o que quem escreveu já
achava.

#### O procedimento, em quatro linhas

1. `pg_dump --format=custom` **imediatamente antes** de aplicar a migração. É
   este backup que define quanto dado se perde no pior caso.
2. Aplicar as migrações. Se falharem, restaurar e parar: não há deploy.
3. Subir a imagem nova. Se ela estiver ruim, **subir a anterior** — o banco fica
   como está, e nada se perde.
4. Só se o banco tiver sido corrompido pela migração é que se restaura o backup
   do passo 1, aceitando perder o que foi escrito depois dele.

**O que ainda não foi ensaiado** é o passo 3 num ambiente de verdade, porque não
há ambiente — é a §3.1.

---

## 2. A triagem das lacunas declaradas

São 38, e **nenhuma delas bloqueia por si**. Lidas em conjunto, elas se
agrupam em quatro famílias:

| Família | Quantas | Bloqueia? |
|---|---|---|
| Depende de **contrato** (Stripe, Meta, emissor fiscal, e-mail, SMS) | 9 | Não — o interruptor deixa o produto operar sem |
| Depende de **infraestrutura** (bucket S3 já tem driver; ainda há Redis, staging/CD, proxy de egresso, tracing e provisionamento externo) | 6 | **Uma sim** — ver §3 |
| Dependia do **primeiro componente de cliente** | 3 abertas | **R5 resolveu a arquitetura e o conflito de telefone**; continuam arraste, "perto de mim" e atualização automática, cada um com dependência própria |
| **Deferimento de produto** com motivo escrito (ranking, papel novo, teto por pessoa, PDF, CAC) | 18 | Não |

A leitura completa de cada uma está em
[`ROADMAP.md`](../ROADMAP.md#lacunas-com-dependência-declarada), com o que já
existe, o que falta e por quê.

---

## 3. O que de fato bloqueia

### 3.1 O caminho de deploy — resolvido em código, aberto em contrato

Era a lacuna 20 e a única da lista que impedia a operação. O que dependia de
código está pronto e mora em [`docs/deploy.md`](deploy.md): `deploy/instalar.sh`
leva um VPS Ubuntu vazio ao produto no ar em um comando — Docker, os segredos obrigatórios
gerados na máquina, as migrações do repositório, cinco serviços, TLS automático e
backup diário criptografado/agendado. `deploy/atualizar.sh` faz o backup **antes** de migrar,
e `deploy/voltar.sh` sobe a versão anterior sem tocar no banco.

O que falta é comercial e não código: **a máquina contratada e o domínio**. E
uma coisa continua sem ensaio, que é a §3.5.

### 3.2 O `.env.example` estava incompleto — resolvido

Ele listava 7 variáveis e o código lia 30, incluindo **todas as chaves de
cifra**. Como elas falham alto quando ausentes, o dia do deploy seria subir,
quebrar, ler o erro, acrescentar uma variável, repetir. Pior: `PSP_MODO` e
`FISCAL_MODO` **não** falham alto — a instalação subiria, pareceria pronta, e
não cobraria nem emitiria nota.

Corrigido, e agora há guarda derivada (`scripts/env-example.test.mjs`) que lê
`process.env[...]` do fonte e reprova o que não estiver declarado.

### 3.5 O backup mora na mesma máquina

`deploy/backup.sh` roda todo dia, confere o arquivo, cifra com AES-256-GCM antes de mantê-lo
no disco/mandá-lo para fora e avisa em **toda execução** enquanto `BACKUP_REMOTO` não estiver configurado. O aviso é
deliberado: backup no mesmo disco cobre o erro humano e não cobre o caso que
tira a barbearia do ar, que é a máquina sumir.

Enviar para fora é uma linha (`rclone`), e ensaiar a volta **naquele** servidor
é o item que continua aberto no go/no-go. Restaurar aqui prova o formato do
dump; não prova a máquina de verdade.

### 3.3 Um erro cru sob contenção, visto uma vez

Com o portão inteiro em paralelo **e** a pilha de demonstração no mesmo
Postgres, o caso de dois clientes no mesmo horário reprovou com `P2010` — o
código genérico do Prisma para consulta crua — em vez do erro de domínio. O
tradutor cobre `23P01` e `23505`; o que escapou foi outro SQLSTATE, provavelmente
de contenção (`40P01` ou `40001`).

Não reproduziu em três execuções, então não está nomeado como defeito. O que
mudou é o diagnóstico: a asserção agora imprime **qual** código escapou. Se
aparecer de novo, a próxima execução já diz o que consertar — e o que está em
jogo é um cliente ver 500 em vez de "esse horário acabou de ser preenchido".

### 3.4 Não há cabeçalho de segurança — resolvido

Sem CSP, HSTS, `X-Content-Type-Options` nem `X-Frame-Options`. O vetor óbvio
está fechado por outro caminho — os cookies do painel são `sameSite=strict` —,
mas falta profundidade, e o HSTS cobre o primeiro acesso antes de o
`secure: NODE_ENV === 'production'` valer.

---

## 4. Go / no-go

- [x] Os 10 percursos definidos estão ligados à medição
- [ ] Os 10 percursos executados e verdes no head `0117`
- [ ] Percursos críticos complementares: cancelar/remarcar, espera, walk-in,
      pacote/assinatura, multiunidade, estorno e WhatsApp real
- [ ] Carga destrutiva: 100 reservas no mesmo slot, 1 sucesso, 99 conflitos e zero 500
- [ ] API + Web + Worker juntos, incluindo retomada do Worker após `SIGKILL`
- [x] Caminho de deploy definido — um comando, com volta atrás pronta
- [ ] VPS e domínio contratados, e o comando rodado uma vez
- [x] Rollback de migração escrito e ensaiado
- [ ] Restauração ensaiada **no ambiente de produção**, não só aqui (§3.5)
- [x] Decisão escrita sobre fiscal: nasce **desligado por conta**, e liga pelo
      toggle do Super Admin quando houver emissor contratado
- [ ] Decisão escrita sobre cobrança (`PSP_MODO`)
- [x] Cabeçalhos de segurança
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
