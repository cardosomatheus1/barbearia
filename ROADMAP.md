# Roadmap de execução

Companheiro do [`SPEC.md`](SPEC.md). A SPEC diz **o que** o produto é; este
documento diz **em quantas partes** ele é construído e em que ordem.

**Prontidão do produto:** use a matriz abaixo. Os 134 blocos continuam registrados
como histórico de execução; bloco concluído não é sinônimo de integração real nem
de funcionalidade pronta para produção.

---

## Matriz de prontidão

Esta é a leitura de conjunto que decide o que pode ser tratado como pronto. Cada
linha separa cinco perguntas que o antigo contador misturava: existe motor, existe
tela, há integração real, o caminho foi provado de ponta a ponta e pode ser usado
em produção.

**Legenda:** ✅ provado · ⚠️ parcial ou ainda não provado contra o mundo real ·
❌ ausente · — não se aplica. A coluna **Evidência** usa `arquivo::trecho`; o
`pnpm verify` confere que o arquivo e o trecho continuam existindo.

| Funcionalidade | Motor | Tela | Integração real | E2E real | Produção | Evidência |
|---|---|---|---|---|---|---|
| Agenda | ✅ | ✅ | — | ⚠️ | ✅ | `packages/scheduling/src/booking.ts::createAppointment` · `apps/web/src/app/admin/agenda/page.tsx::Agenda` · `apps/api/test/agenda.e2e.test.ts::describe` · `ROADMAP.md::Teste que usa a tela como o usuário usa` |
| Comanda / caixa / comissão | ✅ | ✅ | — | ⚠️ | ✅ | `packages/finance/src/comanda.ts::fecharComanda` · `apps/web/src/app/admin/comanda/[id]/page.tsx::Comanda` · `apps/api/test/caixa.e2e.test.ts::describe` · `ROADMAP.md::Teste que usa a tela como o usuário usa` |
| WhatsApp (Meta Cloud) | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | `packages/crm/src/whatsapp-meta.ts::MetaWhatsAppProvider` · `apps/web/src/app/admin/whatsapp/page.tsx::WhatsApp` · `ROADMAP.md::Provar o Embedded Signup contra a Meta` |
| Stripe (cobrança da plataforma) | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | `packages/platform/src/stripe-pagamento.ts::StripePaymentProvider` · `packages/platform/src/stripe.ts::https://api.stripe.com/v1` · `ROADMAP.md::Pix pela Stripe` |
| Split de pagamento | ✅ | ✅ | ❌ | ❌ | ❌ | `packages/finance/src/split.ts::splitDaVenda` · `apps/web/src/app/admin/comissao/page.tsx::podeMexerNoSplit` · `packages/platform/src/adquirente.ts::FakeSplitProvider` |
| Fiscal (NFS-e) | ✅ | ✅ | ❌ | ❌ | ❌ | `packages/finance/src/fiscal-emissor.ts::modoFiscal` · `apps/web/src/app/admin/fiscal/page.tsx::emissorDisponivel` · `packages/finance/src/fiscal-emissor.ts::Use nenhum ou fake` |
| Sinal cobrado online | ✅ | ⚠️ | ⚠️ | ❌ | ❌ | `packages/scheduling/src/confianca.ts::deposit_mode` · `apps/web/src/app/[slug]/agendado/[id]/page.tsx::Fale com a barbearia` · `ROADMAP.md::Cobrar o sinal pelo produto, e devolvê-lo sozinho` |
| Foto por envio de arquivo | ✅ | ✅ | ✅ | ⚠️ | ✅ | `apps/api/src/media/storage.ts::guardarImagemPublica` · `apps/web/src/app/admin/fotos/upload-de-foto.tsx::canvas.toBlob` · `apps/api/src/media/storage.ts::AWS4-HMAC-SHA256` · `deploy/configurar-midia-s3.sh::setar MEDIA_STORAGE s3` · `apps/api/test/admin.e2e.test.ts::recebe o arquivo, hospeda e a imagem chega na página pública` |

### Regra da matriz

- Um ✅ de **Produção** exige motor e tela ✅, integração ✅ ou — e não pode ter E2E ❌. E2E ⚠️ é permitido quando o fluxo existe e opera, mas ainda falta prova automatizada pela interface — exatamente a lacuna declarada de teste que clica.
- Integração ❌ nunca pode coexistir com Produção ✅ ou ⚠️.
- A matriz descreve o **estado atual**. SPEC e documentos de direção podem
  descrever o produto-alvo, mas não podem ser usados como prova de prontidão.
- Uma capacidade com integração ou produção ❌ não pode ser descrita, nas
  superfícies de estado atual, como *pronta*, *em produção*, *integração real* ou
  equivalente. `scripts/verificar-prontidao.mjs` é a guarda dessa regra.

---

## R8 — verdade comercial

A matriz acima também limita o material de venda. O resumo de linguagem permitida
fica em [`docs/comercial/prontidao.md`](docs/comercial/prontidao.md), e
`scripts/verificar-r8-comercial.mjs` impede que uma superfície comercial venda
como disponível o que a matriz marca ❌. O recurso de perguntas chama-se
**Assistente de gestão**: ele interpreta um catálogo fechado de métricas e nunca
é descrito como “IA que entende o negócio”.

## R12 — validação de usabilidade em campo

O protocolo e o cronômetro estão em [`docs/usabilidade/r12.md`](docs/usabilidade/r12.md)
e `scripts/r12-usabilidade.mjs`. O repositório **não** finge a linha de base que
não foi coletada antes de V1/V5/V11: o primeiro checkpoint válido será a rodada
pós-reorganização com pessoas novas. `scripts/verificar-r12-percursos.mjs` prova
apenas que as cinco tarefas têm caminho no produto; tempo, hesitação e pedido de
ajuda continuam sendo dados de campo, a coletar em 3–5 barbearias.

## O que é um bloco

Uma unidade de trabalho que termina **commitada, com teste verde e uma
capacidade nova real**. Não é uma sessão nem um dia — é um incremento que se
sustenta sozinho e pode ser revisado isoladamente.

**Nenhum bloco é dado como concluído sem cumprir o
[Definition of Done](CLAUDE.md#definition-of-done) do `CLAUDE.md`** — testes,
segurança, desempenho e arquitetura. `pnpm verify` é o portão.

---

## Aviso sobre este número

A primeira versão deste roadmap estimava 41 blocos. Estava errada: contava o que
estava escrito nas cinco partes da SPEC, e a SPEC descreve o **produto**, não a
**plataforma que o sustenta**.

Faltavam, por inteiro:

- o app do barbeiro (`app-pro`) — a SPEC pede três aplicações, o orçamento cobria duas;
- o Super Admin (Parte 1 §1.2) — seção escrita, zero blocos;
- a cobrança das barbearias — é o modelo de negócio, sem ele não há SaaS;
- infraestrutura — CI/CD, staging, deploy, observabilidade, backup testado;
- design system — três apps precisam de base comum;
- LGPD operacional — exportação, anonimização e retenção como código, não como texto.

O número corrigido é ~78. Ele é registrado aqui para não se perder, mas leia a
seção [Escopo recomendado](#escopo-recomendado) antes de tratá-lo como plano.

---

## Correção de fluxo (entre o 36 e o 37)

Não é bloco: é conserto do que o portão inteiro deixou passar, e a razão de o
`CLAUDE.md` ter ganhado a [§6](CLAUDE.md#6-regra-de-negócio-e-coerência-do-fluxo).
Dez defeitos, todos com teste verde antes e todos invisíveis a qualquer teste
de tela — porque cada tela, sozinha, era coerente:

| O que estava errado | O conserto |
|---|---|
| Duas barras escritas à mão (`BalcaoNav`, `CadastroNav`) discordavam do registro: a primeira misturava dois módulos, **não** tinha Comanda, e não existia em Dia, Agenda e Fila — as três telas que ela oferecia | as duas foram **apagadas**. O contexto do casco já lista as telas do módulo aberto, derivadas de `MODULOS`, em qualquer largura. As barras eram o mesmo link duas vezes no DOM |
| `lgpd` e `plano` nunca acendiam no trilho — e o teste passava, porque ele também tinha lista escrita à mão | as regras entraram, e a guarda passou a derivar de `MODULOS` |
| A mesma transição tinha três nomes: **Iniciar · Começar · Sentou**, em três telas do mesmo produto | vocabulário único em `packages/core/src/vocabulario.ts`, com teste que reprova tela definindo o próprio dicionário |
| A fila nunca fechava ninguém: nada escrevia `done`, e por isso a **espera média era sempre `—`** | encerrar o atendimento fecha a entrada, na mesma transação |
| Ninguém via quem estava na cadeira nem há quanto tempo — `appointments.started_at` existia desde a migração 0014, com o comentário "base da duração real", e era descartado antes de chegar à tela | faixa "Nas cadeiras agora" no topo do dia, com o tempo decorrido. **O número não anda**: é o instantâneo da carga, e a tela diz isso |
| Abrir a comanda do mesmo atendimento duas vezes esbarrava em `orders_uma_aberta_por_agendamento` e virava **500**: a tela dizia "tente de novo" e tentar de novo dava o mesmo erro para sempre. A comanda existia e não havia caminho até ela | `abrirComanda` devolve a que já está aberta. O índice dizia desde o bloco 18 que é uma só; faltava a outra metade da regra. A corrida também: a violação de unicidade vira leitura numa transação nova |
| Encerrado o corte, o cartão do dia ficava **sem saída** — receber exigia ir a Dinheiro → Cobrar e procurar a mesma pessoa numa segunda lista, montada pela **mesma** consulta e pelos **mesmos** dois estados | "Cobrar" no cartão, escondido de quem não tem `cashier.open`. E a definição de "cobrável" saiu das duas telas para `ESTADOS_COBRAVEIS`, em `core`: escrita nas duas, bastava mexer numa para elas discordarem sem nada ficar vermelho |
| A agenda mostrava estado de operação ("Na cadeira", "Atendido") e não oferecia nada além de "Mover" | link "Ver no dia" no cartão. Link, e não os botões de atendimento: a máquina de estados fica em uma tela só — duplicá-la é como as transições ganharam três nomes |
| A página pública desenha um botão de ligar desde o bloco 4, e o número era **sempre nulo**: `locations.phone_e164` existia, a API aceitava `phone`/`whatsapp` e nenhuma tela os preenchia. Achado ao escrever `scripts/rodar-local.sh` — o semeador foi o primeiro cliente a mandar o campo | os dois campos entraram na etapa 2 do onboarding. E o valor passa a ser normalizado **na borda**: `(71) 3333-4444` batia na `CHECK` de E.164 e virava **500 "Erro interno"** — entrada externa inválida é 400 com motivo. Fixo é aceito aqui e recusado no cadastro do cliente, porque o do cliente recebe o código de acesso |
| A tela de comissão dizia **"Comissão"** para os dois lados do mesmo dinheiro. O dono abre para saber quanto **paga**, o barbeiro para saber quanto **recebe**, e quem tem as duas contas não tinha como saber qual estava na tela | "Comissão da equipe" e "Minha comissão", com o subtítulo dizendo o que o número é. Os dados sempre estiveram certos — a API já recorta pelo `commission.view_all` |

## Lacunas com dependência declarada

Quando um bloco fecha deixando algo de fora, o motivo entra aqui — com **o que
já existe**, **o que falta** e **em qual bloco entra**. Sem isso, "lacuna
conhecida" vira lugar onde trabalho adiado desaparece.

A regra que separa as duas colunas: mecanismo (schema, motor, API, tela do
cliente) fecha no bloco em que a necessidade aparece; **tela de administração
para cadastrar o dado** espera o bloco do admin. O contrário — mecanismo adiado
porque a tela ainda não existe — é o que produz motor que finge aceitar
`blocks` e nunca recebe nenhum.

| Lacuna | Pronto | Falta | Bloco |
|---|---|---|---|
| Hora renderizada no fuso do processo, em oito telas | a regra é escrita desde sempre — *o fuso vem da unidade, nunca do dispositivo* — e 21 das 63 chamadas de formatação de data já passam `timeZone`. O bloco 134 consertou a nona, na lista de mensagens da ficha, e foi lá que o defeito ficou visível: no servidor `Intl` usa UTC, no navegador usa o fuso do aparelho, o React não reidrata a hora e a **página inteira** cai com o erro 418. Quem pegou foi o percurso da medição, não o portão | oito chamadas pedem `hour` ou `minute` **sem** `timeZone`, e cada uma é o defeito D2 mais um 418 esperando acontecer: `avisos:58`, `comanda:83`, `configuracoes:599`, `fila-parada:98`, `importar:96`, `seguranca:566`, `trilha:49` e `plataforma/trilha:33`. Não entraram aqui porque são oito telas de oito assuntos e cada uma precisa do fuso da unidade chegar até ela — escopo de bloco próprio, não de conserto de carona. As outras 34 sem `timeZone` mostram só data e erram um dia por ano no pior caso; elas ficam de fora do corte de propósito | 135, junto da guarda derivada. O corte foi **medido antes de escrever a guarda**: "toda formatação sem `timeZone`" acusaria 42 de 63 e seria desligada na primeira semana; "pede hora e não diz o fuso" acusa 8, e as 8 são defeito |
| Hidratação instável na tela de Campanhas | o percurso *"dono monta uma campanha sem texto aprovado"* existe e cobre o caminho inteiro, do clique ao banco | a tela devolve **React #418** (*hydration failed*) de forma **intermitente** ao voltar de `?feito=criada`: duas execuções seguidas do mesmo commit, uma vermelha e uma verde, e a árvore limpa passou na mesma máquina. A campanha **é criada** — o defeito é de renderização, não de dado. O suspeito medido é o `const agora = new Date()` de `campanhas/page.tsx`, que é o único relógio da tela e alimenta o estado dos disparos. Não foi consertado aqui porque não é deste bloco e porque um conserto sem reprodução determinística é palpite: o primeiro passo é fazer o percurso falhar sempre | sem bloco definido: entra no primeiro bloco que tocar Campanhas, e o critério de pronto é o percurso vermelho **antes** do conserto |
| OTP do agendamento sem entrega real | o motor está inteiro — `MetaIdentityMessagingProvider` fala a Cloud API, trata timeout como entrega incerta e recusa `console` quando alguém depende dele | a **WABA central**: número, token e dois templates aprovados pela Meta. Enquanto `IDENTITY_MESSAGING_MODO=console`, OTP e senha de primeiro acesso vão para o log — e a senha tem saída pela tela, o OTP não. Por isso a guarda pergunta ao banco em vez de recusar cego: hoje nenhuma unidade exige OTP, e no dia em que uma exigir o deploy reprova sozinho | sem bloco definido: depende de contratar a WABA e da aprovação da Meta, que leva dias. O código não muda — é a mesma variável de sempre |
| Proteção anti-bot desligada em produção | o mecanismo está inteiro: widget na tela de cadastro, CSP liberando o domínio da Cloudflare só naquela rota, validação server-side no Siteverify com conferência de `action` e `hostname`, e falha fechada quando configurado | as **chaves**. A conta na Cloudflare ainda não existe, e `BOT_PROTECTION_MODO=nenhum` assume a pendência por escrito: enquanto estiver assim, `POST /admin/signup` — a criação de barbearia nova — aceita automação. É uma rota só, e nenhuma outra depende disso | sem bloco definido: é conta gratuita e cinco minutos de configuração, sem trabalho de código. Volta a `turnstile` no dia em que as três chaves entrarem no `.env`, e o padrão do código continua sendo exigir |
| Fallback SMS do OTP de identidade | o canal principal da SPEC está implementado: OTP e senha de primeiro acesso usam a WABA central da plataforma via Cloud API da Meta, com template `AUTHENTICATION`, timeout tratado como entrega incerta e console proibido em produção | o **canal secundário SMS** citado na SPEC §1.6. Hoje uma indisponibilidade definitiva da Meta faz a solicitação falhar/compensar; não existe `SmsProvider` contratado para tentar uma segunda rede | sem bloco definido: depende de contratar um provedor de SMS e obter credenciais/preço por mensagem. O caminho principal de autenticação está operacional por WhatsApp; o fallback entra junto da primeira contratação de SMS, sem criar fake que finja redundância |
| O agente de conversa não responde pelo WhatsApp | a porta do site está no ar desde o bloco 106: `/[slug]/conversar`, com a resposta em cookie de dois minutos, os horários levando ao passo 4 do agendamento de sempre, medição e percurso de navegador do texto livre até a linha no banco. As rotas `POST /v1/b/:slug/agente` e `/agente/meu` continuam sendo o único caminho de leitura, e nenhuma delas grava | o **encaminhamento da mensagem recebida**: hoje o webhook da Meta manda tudo para `registrarResposta`, e uma mensagem que não responde a nada nenhum caminho lê. Precisa decidir o que é conversa e o que é resposta a um aviso, e o que fazer com quem escreve dentro da janela de silêncio | sem bloco definido: depende de a barbearia ter número próprio verificado, que é o estado que o bloco 88 tornou explícito e que nenhuma barbearia da base tem ainda. Entra junto do primeiro bloco que ligue o número de verdade |
| Conciliação com a Meta só na unidade principal | a varredura de hora em hora (bloco 90) promove o número a `ativo` quando a Meta confirma a posse, e tira os textos de "Na Meta" — pela `primaryLocation` de cada barbearia | cobrir **todas** as unidades: `whatsapp_settings` é por unidade desde o bloco 55, e uma rede com número próprio por loja concilia só o da matriz | sem bloco definido: nenhuma barbearia deste produto tem hoje número por filial, e um laço sobre unidades seria caminho que nada exercita — o defeito de `blocks` outra vez. O que segura a decisão é dado, não código: entra quando existir a primeira rede com dois números. Enquanto isso o sintoma é conhecido e limitado — a filial fica em "falta confirmar" com o canal funcionando, que é o estado de antes do bloco 90 |
| Arrastar o cartão na agenda para remarcar | mover está entregue e é o caminho principal: formulário com dia, hora e profissional, no cartão de cada compromisso, passando pelo mesmo motor e recusando choque | o arraste em si | sem bloco: **a WCAG 2.5.7 exige alternativa de um ponteiro para qualquer arraste**, então mover teria que existir de qualquer jeito — arrastar é acabamento sobre ele, não a funcionalidade. O **R5 já abriu a primeira ilha de cliente e mediu sua separação de pacote**; o arraste continua sem entrar de carona porque é acabamento sobre o caminho acessível de mover que já existe. Entra num bloco próprio de interação da agenda |
| Painel como aplicação separada | rota `/admin` própria; o pacote da página pública continua em 102 kB depois de quatro telas novas de cadastro | extrair `apps/admin` quando o painel tiver dependência que a página pública não usa | sem bloco: o 13 era o candidato e passou sem criar essa dependência — o painel inteiro é renderizado no servidor e não manda JavaScript próprio. Extrair agora seria custo de build sem ganho medido. Entra quando o número subir |
| A taxa que o adquirente cobrou **de fato** | a alíquota é cadastrada por meio de pagamento, congelada em cada venda (`orders.fee_cents`) e descontada da base quando o rateio está ligado — a terceira escolha da SPEC §3.4, entregue no bloco 36 | usar o valor **real** do extrato no lugar do calculado. Quem sabe o número exato é o adquirente, que o informa na transação de saldo | sem bloco definido: depende de conta contratada, como a própria integração. **Não há coluna esperando por ele** — criá-la agora seria campo que ninguém preenche, e a revisão deste bloco cobrou exatamente isso. O calculado erra por centavos e na direção conhecida (a alíquota é a contratada), o que basta para a comissão; o valor real importa para conciliação bancária, que é outro assunto e não existe no produto |
| Cartão de garantia (cobrado só na falta) | o sinal antecipado inteiro: Pix, cartão e link pelo adquirente, com reembolso por política | a modalidade "cartão de garantia" da SPEC §2.12, em que o cartão fica registrado e só é cobrado se a pessoa faltar | sem bloco definido: exige tokenizar cartão e **capturar depois**, que é outro contrato com o adquirente — e a convenção deste código é que só existe token do provedor, marca e os quatro últimos, com invariante que reprova quem criar coluna para PAN. A modalidade entra quando houver conta contratada e captura postergada, junto da lacuna do contrato com a Stripe |
| Cobrar o sinal pelo produto, e devolvê-lo sozinho | a decisão inteira: quem paga sinal, quanto, por quê, e se o dinheiro volta num cancelamento — com a política por unidade, o serviço que sempre exige, o ajuste do gerente e o registro do recebido pelo balcão, auditado | a **cobrança pelo adquirente**: QR Code na tela de agendamento, webhook confirmando e devolução automática. Hoje o sinal é o Pix que o cliente manda para o número da barbearia e alguém confere — que é como a esmagadora maioria das barbearias do país cobra, mas deixa a recepção digitando "recebi" | sem bloco definido, junto da lacuna do contrato com a Stripe: é o mecanismo dos blocos 35 e 36 aplicado ao **agendamento** em vez da comanda, e a diferença não é pequena — a cobrança nasce dias antes de existir comanda, sem caixa aberto, e a devolução é estorno de uma cobrança que pode ter sido paga num ciclo de faturamento anterior. O registro manual não é becos sem saída: ele preenche `deposit_paid_cents` e é o que a política de reembolso lê |
| Provar o Embedded Signup contra a Meta | o fluxo inteiro escrito e ligado (bloco 83): botão "Conectar WhatsApp" com o SDK sob nonce e licença de CSP numa rota só, `FINISH` e `FINISH_ONLY_WABA` distinguidos, troca do código pelo token no servidor, assinatura do webhook e registro do número — mais a troca de código **exercitada contra a Graph API de verdade**, que respondeu "Invalid verification code format" com as credenciais aceitas | o **clique de ponta a ponta**: nenhum navegador chegou a abrir a janela da Meta, porque o SDK não é alcançável do ambiente de desenvolvimento. Os testes provam o que sai; o que falta sair só aparece contra a conta real — é a lição do `success_url` da Stripe no bloco 80 | sem bloco definido: a dependência é **uma barbearia de verdade conectando o número**, e ela não é código. O caminho de escape continua inteiro: quem já tem os ids cadastra à mão, e o formulário está a um clique de distância na mesma tela |
| Campanha por e-mail, push e SMS | a campanha inteira: público congelado na criação, quatro filtros (incluindo a célula fria do heatmap), as mesmas proteções da automação, as seis colunas da SPEC §4.13 e a **receita atribuída** congelada na janela | os **outros três canais**. Hoje tudo sai pelo caminho de mensagem do produto, que é o WhatsApp do bloco 55 | sem bloco definido: e-mail exige domínio verificado e reputação de remetente; push exige aplicativo instalado, que este produto não tem (é PWA); SMS tem custo por mensagem e chega sem formatação. A SPEC §4.13 lista os quatro e marca SMS como opcional — o que ela não diz é que os três valem menos que o primeiro numa base brasileira, e é por isso que o WhatsApp veio antes |
| Nota de produto (NF-e / NFC-e) | a NFS-e inteira: contrato do emissor, emissão que não bloqueia a venda, cancelamento com estado em voo, Salão-Parceiro, CPF do tomador e a nota chegando ao cliente. A base da nota é **só serviço**, por decisão escrita, e a tela diz por quê quando a comanda só tem produto | o **segundo documento**. Produto é NF-e ou NFC-e: outro modelo fiscal, outra numeração, outro credenciamento estadual — e a SPEC §3.11 diz "quando aplicável", não "junto". Somá-lo à NFS-e recolheria ISS sobre mercadoria, que é imposto errado sobre base errada | sem bloco definido: a dependência é a mesma da NFS-e — **conta contratada com o emissor** —, e é ela que decide se o mesmo contrato cobre os dois documentos ou se são duas integrações. Enquanto a barbearia média vende pomada como acessório do corte, a nota que o cliente pede é a do serviço; a de produto vira obrigatória quando a revenda deixa de ser acessório, e aí é o volume dela que paga a integração |
| Indicação com link e anti-fraude | nada — a SPEC §4.9 descreve `barber.app/ref/CARLOS92`, crédito para os dois lados e cinco regras anti-fraude | o mecanismo inteiro: link por cliente, vínculo do indicado, crédito só depois de atendimento concluído e pago, teto por período e bloqueio de autoindicação por telefone e por aparelho | sem bloco definido. Ele **depende** da fidelidade, que agora existe: o crédito da indicação é um lançamento em `loyalty_entries`, com o mesmo extrato e a mesma validade. Entra quando houver demanda — e o anti-fraude é o bloco inteiro, não um detalhe: sem ele a indicação é a porta mais barata para fabricar crédito |
| Passar um recado para outra pessoa da equipe | assumir para si e devolver à fila, os dois gestos que a tela do balcão oferece | "manda esse para o Ruan, é da cadeira dele". O domínio já aceita qualquer id da equipe em `assumirRecado`; o que não existe é a rota e o seletor — e a rota de assumir foi deliberadamente fechada para não aceitar responsável do corpo | sem bloco definido: é conveniência, não lacuna de regra. Entra quando uma barbearia com equipe grande pedir. Hoje, quem quer passar adiante devolve à fila e a outra pessoa assume |
| Tokenizar o cartão do assinante | a régua de cobrança inteira: fatura por ciclo com valor congelado, escada D+1/D+3/D+7, suspensão gradual avisada aos quinze dias, cancelamento self-service e a coluna `payment_token` com a rota que a preenche — mais o contrato `CobrancaDoClubeProvider`, que separa recusa definitiva de indisponibilidade | a **origem do token**: a tela em que o assinante digita o cartão e o adquirente devolve a referência. Sem ela nenhuma assinatura tem cartão salvo, e a régua pula a cobrança sem gastar degrau — o que quita a mensalidade é o balcão registrando o Pix que viu no extrato, que é como a esmagadora maioria das barbearias do país cobra hoje | sem bloco: a dependência não é de código, e três blocos seguidos a empurraram para frente sem que nada a destravasse. Faltam **duas coisas de fora**: uma conta de adquirente por barbearia — a mesma dependência comercial do split — e uma integração de cartão client-side compatível com PCI. O R5 já provou a arquitetura de ilha; o que continua faltando aqui é a dependência comercial e de PCI. Nenhum bloco do roadmap entrega a conta contratada, e apontar para o próximo a cada fechamento é adiamento com data falsa. Ela entra quando houver contrato assinado, e o mecanismo já está inteiro esperando: a régua de cobrança roda hoje sobre o provedor de mentira, que recusa por padrão justamente para que escada, inadimplência e suspensão sejam percorridas pelo caminho real |
| Ranking entre barbeiros (gamificação) | cada barbeiro vê os próprios números, a meta do mês com ritmo, o `rebooking rate` e a comissão do período — tudo comparado com o **próprio** passado | os rankings de faturamento, vendas, avaliações e retenção da SPEC §4.21, com o interruptor por barbearia e a escolha de quais são visíveis para a equipe | sem bloco: a própria SPEC manda vir **desligado por padrão** e explica por quê — ranking público produz disputa por cliente bom, empurra produto e faz recusar atendimento rápido. Entregar o motor de ranking antes de existir demanda real seria construir o que a SPEC pede para manter desligado. Entra quando uma barbearia pedir, junto do interruptor |
| Teste que usa a tela como o usuário usa | e2e da API cobrindo o caminho inteiro (`apps/api/test/caminho-inteiro.e2e.test.ts` e mais quinze arquivos), a medição de responsividade abrindo **toda** tela em quatro larguras num navegador de verdade, e a leitura de fluxo do §6 feita à mão a cada bloco | o teste que **clica**: navegar, preencher, submeter e conferir o efeito no banco. A medição abre as telas e mede o layout; ela não usa o produto. Um unitário passa com a funcionalidade quebrada, e três defeitos deste repositório — o botão que levava a lugar nenhum, o estado sem saída na interface, o indicador sempre `—` — só apareceram na leitura manual | sem bloco definido: a dependência é **infraestrutura de teste**, não produto. O Playwright já está montado para medir, então o custo não é o navegador — é a suíte de fixtures (sessão de gestor, sessão de cliente, banco semeado por caso) e o tempo dela dentro do portão, que hoje fecha em ~90s. Entra quando o custo do §6 manual passar do custo da suíte, e o sinal disso é um defeito de fluxo escapar da leitura |
| Tela do balcão que se atualiza sozinha | recarga manual e recarga a cada ação; a tela sempre reflete o banco no instante em que foi montada — vale para o painel do dia e, desde o bloco 35, para a comanda com Pix em curso | atualização sem toque: hoje, quem cobra por Pix recarrega a comanda para ver que o cliente pagou | sem bloco (movida do 20): o 20 entregou processo fora de requisição — que é trabalho de fundo, não canal do servidor para o navegador. Empurrar mudança para uma aba aberta exige SSE ou WebSocket. O **R5 já abriu a primeira ilha client-side sem contaminar o pacote público**; o que continua faltando aqui é o canal em tempo real e seu ciclo de reconexão, não a arquitetura básica de componente de cliente. A alternativa sem JavaScript é `meta refresh`, que é pesquisa em laço com o custo da página inteira e apaga o que a recepção estiver digitando — pior que recarregar quando ela quiser |
| Varredura diária do validador de catálogo | a conferência roda sob demanda, a cada carga do painel e da tela de diagnóstico, sempre sobre o cadastro do instante | a varredura em segundo plano que a SPEC §5.7 também pede | sem bloco: sob demanda é **mais fresco** que diário, então a varredura não melhora o que a tela mostra. O que ela acrescentaria é alertar quem não abriu o painel — e isso é canal de aviso **para o dono**, que o produto não tem (o bloco 20 entregou aviso para o cliente). Entra junto com o primeiro aviso dirigido ao gestor, não antes |
| Importar agendamentos futuros e histórico | a base de clientes entra inteira, com deduplicação por telefone, preview, reversão e idempotência | as duas outras linhas do escopo mínimo da SPEC §5.8: a agenda futura e o histórico de atendimento | sem bloco definido: as duas dependem de **casar nome de profissional e de serviço** entre dois cadastros que não se conhecem, e de decidir o que fazer quando o horário importado bate com um existente — a constraint de exclusão recusa, e recusar em silêncio perderia o agendamento que a SPEC diz que não pode se perder. É outro importador, com outras telas de conferência. Enquanto isso vale a mitigação que a própria SPEC §5.8 prescreve: **operação paralela por uma ou duas semanas**, com a agenda velha em leitura — são umas trinta marcações a redigitar, não mil e duzentas |
| Conversão da página e proporção de erro como alerta | duas das quatro regras da SPEC §5.12 entregues **com coletor**: queda de volume por barbearia e fila de trabalho travada, com teste puro da decisão e teste de integração da coleta | as outras duas: conversão da página pública e proporção de erro na gravação | sem bloco definido: as regras seriam triviais de escrever e **não têm origem de dado**. Conversão exige contar visita — que é rastreamento de visitante anônimo, com implicação de LGPD que merece decisão própria, não carona. Proporção de erro exige ler o log agregado de volta para dentro do produto, e não há agregador. Escrevê-las agora deixaria duas funções que ninguém chama, que é o defeito de `blocks` — aceito por oito blocos e sempre vazio |
| Publicação automática e ambiente de staging | o **deploy existe e é um comando**: `deploy/instalar.sh` leva um VPS Ubuntu vazio ao produto no ar — Docker, segredos obrigatórios gerados, as 119 migrações, cinco serviços, TLS automático pelo Caddy e backup diário agendado —, com `deploy/atualizar.sh` fazendo backup antes de migrar e `deploy/voltar.sh` subindo a versão anterior sem tocar no banco. A esteira roda o portão, API + Web + Worker, os percursos e as duas cargas (disponibilidade e 100 reservas concorrentes) a cada push | o **gatilho**: publicar sozinho quando o portão fica verde, e um segundo ambiente para exercitar a subida antes da produção | sem bloco definido: agora falta uma coisa só, e ela é comercial — **a máquina contratada**. Com um VPS e um domínio, o comando roda; a publicação automática vem depois, e o que ela faria é chamar o mesmo `deploy/atualizar.sh` que uma pessoa chama hoje |
| Tracing distribuído | log estruturado por requisição, com `x-request-id` aceito do proxy, devolvido na resposta e presente em toda linha — que é correlação ponta a ponta dentro do processo | spans com duração por camada, e propagação para fora | sem bloco definido: o produto é um monólito modular com um processo e um banco. Span entre camadas do mesmo processo responde o que o perfil de CPU responde melhor, e foi o perfil que achou o gargalo de fuso deste bloco. Entra quando houver um segundo serviço em jogo |
| `stock_movements.location_id` obrigatória no banco | a migração 0092 preenche toda linha antiga — a 0061 já tinha atribuído a barbearia de uma loja só, e esta atribui o resto à mais antiga — e o **tipo** passou a exigi-la: `moverEstoque` recebe `locationId: string`, então o compilador cobra o caminho que esquecer | o `SET NOT NULL`, que é o que impede a coluna de voltar a ficar nula por um caminho que não passe pelo TypeScript — SQL cru numa importação, por exemplo | sem bloco definido, e a dependência é **de deploy**: `SET NOT NULL` numa tabela que já existe quebra o rollback, porque a versão anterior da aplicação volta a escrever nulo e passa a falhar. É operação de duas fases em dois deploys, e a guarda de migração aditiva reprova a primeira que tentar fazer as duas juntas. Entra no primeiro deploy depois de o 117 estar em produção |
| Guarda para o mecanismo exportado que ninguém oferece | `varredura-com-chamador.test.mjs` cobra chamador de toda função com prefixo `varrer`, `atribuir` ou `expirar`, e foi ela que achou a varredura da vitrine no bloco 108 | a guarda para a classe que o bloco 129 encontrou: `TODAS_AS_UNIDADES` era **constante** exportada de `core`, com teste próprio, e o cabeçalho do arquivo prometia o consolidado que nenhuma tela oferecia | sem bloco definido, e o corte **foi medido e reprovado**: "todo símbolo exportado de `core` referenciado fora do próprio arquivo" acusa 429 de 1014 — tipo consumido estruturalmente e reexportado pelo barril parecem órfãos. Estreitando para constante em CAIXA_ALTA e contando referências de dentro de `core`, ainda são 78 de 182, e a maioria é legítima: parâmetro de calibragem exportado para o próprio teste (os sete `PESO_*` de `churn.ts`) não é defeito. O corte que faltaria é "constante que representa uma **opção de leitura** e nenhuma rota a oferece", e ele não é derivável sem inventar uma convenção. Guarda que acusa o certo é guarda que alguém desliga |
| Recusa do domínio sem frase na tela | as telas traduzem por mapa de código para frase, e o bloco 116 acrescentou as duas recusas de unidade da venda de destaque — que caíam em *"tente de novo"*, a única resposta que nunca funcionaria | a **conferência derivada**: hoje `packages/platform` lança 47 códigos e 20 não têm frase em nenhuma tela da plataforma. Parte é legítima (falha interna que ninguém deve ver, código mostrado no painel da barbearia e não no da plataforma), parte é caixa de erro errada esperando acontecer — e o `Record<string, string>` esconde a falta, que é exatamente o defeito que a convenção do mapa de erro descreve | sem bloco definido: a varredura é fácil de escrever e **difícil de acertar o corte**. Reprovar os 47 acusaria o legítimo, e uma lista de isenções por nome de código seria a lista que ninguém revisa. O corte precisa ser conquistado, como o de `kind` na varredura de capacidade — provavelmente "código que sai de uma rota que a tela chama", o que exige ligar ação de tela a rota. O bloco 126 era o candidato e **não** serve: ele fechou a lacuna do menu sem construir a travessia, porque a guarda que ele entregou é empírica — percorre o painel com cada papel e pergunta ao DOM se a tela recusou. Ela prova mais que a leitura do `@Exige` provaria e não produz o mapa tela → rota que esta lacuna precisa. Sem bloco definido, e o corte continua sendo o difícil |
| Página pública por unidade | `marketplace_listings` é por unidade desde o bloco 72, e a coordenada de cada loja entra pelo link do mapa desde o 115. A vitrine publica **uma** loja por barbearia — a que `/{slug}` desenha —, e o card e a página concordam | o **endereço público de uma loja escolhida**. `getPublicProfile` faz `ORDER BY created_at LIMIT 1`, então uma rede tem uma página só: a filial de Feira de Santana não aparece na busca, e a recepção da filial não tem link para mandar. `primaryLocation` continua decidindo por três portas públicas — o recado do cliente, a política de OTP daquele recado e a conciliação com a Meta | sem bloco definido: não é um `WHERE` esquecido, é **esquema de endereço**. Precisa decidir a URL (`/{slug}/{loja}`? subdomínio? seletor no topo?), carregar a loja escolhida por todo o fluxo de agendamento, e o que fazer com o link antigo que mil clientes já salvaram — o slug é permanente por convenção desde o bloco 5. Publicar as outras lojas antes disso produzia o pior card que este produto pode emitir: o nome da rede, a coordenada de uma cidade e um link que abre o endereço, o telefone e a grade de outra. Entra quando existir a primeira rede com duas lojas em cidades diferentes, e a metade cara já está pronta — o schema é por unidade em toda parte |
| Fatura em PDF e nota fiscal | a fatura tem período, plano, valor, vencimento e situação, e o dono a lê na tela | o documento para baixar e a nota fiscal do serviço | sem bloco definido: nota fiscal da **plataforma** é emissão sobre a própria empresa, não sobre a barbearia — outro regime, outro provedor, e nada a ver com o `FiscalProvider` dos blocos 53 e 54, que emite sobre o serviço da barbearia. Entra quando houver contabilidade de verdade por trás |
| Pix pela Stripe, e o prazo do QR Code | as duas pontas do adquirente foram **exercidas contra a conta de verdade** em `test mode`: cobrança de cartão, link de checkout, idempotência por chave, consulta, mensalidade cobrada, conciliação e estorno — todas responderam. Três defeitos que só a chamada real mostra foram corrigidos junto: o `success_url` ausente que impedia a sessão de checkout inteira, `requires_payment_method` lido como recusa num intent recém-criado, e o meio de pagamento nulo virando string vazia | o **Pix**, que a conta recusa com `payment_method_type "pix" is invalid` enquanto não for ativado no painel da Stripe — e, com ele, qual expiração ela permite para o QR Code, que o código lê de `pix_display_qr_code.expires_at` e nunca viu preenchido | sem bloco definido: a dependência é **ativar o Pix na conta**, que é decisão comercial e não código. O caminho de cartão e link já opera; o Pix continua caindo no registro manual, que é como a maioria das barbearias cobra hoje |
| Entrega concorrente do mesmo webhook | a chave primária de `psp_events` trava a entrega repetida, e a máquina de estados da fatura carrega o caso sequencial (provado quebrando a chave de propósito: os testes de reentrega continuaram verdes sem ela) | um teste que exercite duas entregas **ao mesmo tempo** | sem bloco definido: o pool serializa as duas transações neste ambiente e o caso não se reproduz. Provar exigiria segurar uma transação por fora — o que testaria o arranjo do teste, não o produto. Fica escrito porque a garantia é real e não é provada |
| Contrato de split exercido pelo adquirente | o mecanismo inteiro, dos dois blocos: `payment_splits` derivado da comissão, o cadastro do recebedor (KYC) com o dado bancário atravessando sem ser gravado, a régua de liquidação com estado próprio para a chamada em voo, chave de idempotência estável por fatia, e a política de estorno — cancelar o que não saiu, cobrar do profissional o que saiu. Tudo exercido pelo `FakeSplitProvider`, que deixa o cadastro pendente e recusa o repasse | uma chamada que um adquirente **de verdade** tenha respondido. Como na lacuna da Stripe, os testes provam o que sai na requisição e como a resposta é lida contra uma rede injetada — não que exista conta habilitada para split, nem qual é o fluxo de KYC dela | sem bloco definido, junto da lacuna do contrato com a Stripe: falta a **conta contratada com split habilitado**, que é decisão comercial e não código. Nenhum bloco pode entregá-la. O que dependia de código está pronto, e o produto funciona sem ela: a parte do barbeiro fica retida, o dinheiro cai na casa e a comissão sai no fechamento — que é como toda barbearia do país paga o barbeiro hoje |
| Papel novo criado pelo dono | os quatro papéis têm o conjunto de permissões editável pela tela, por barbearia, com trilha de antes e depois | criar um **quinto** papel — "caixa", "gerente de unidade" — em vez de só reconfigurar os quatro | sem bloco definido: `staff_role` é um enum do Postgres, e papel criado por barbearia teria que virar tabela com chave própria, migrando `staff_users.role`, `role_permissions.role` e a semente. É trabalho real e o ganho é pequeno enquanto os quatro cobrem o que a SPEC §1.3 descreve — quatro conjuntos editáveis já respondem "a recepção pode dar desconto?" |
| Teto de desconto por pessoa | o teto é por barbearia, em pontos-base, e vale para todo mundo que tem `finance.discount` | um teto diferente por papel — a recepção até 10%, o gerente até 30% | sem bloco definido: exigiria o teto migrar de `tenants` para `role_permissions`, que hoje é um par (papel, permissão) sem valor associado. Vale quando alguém pedir; hoje a separação que importa — quem pode e quem não pode — já existe |
| `Idempotency-Key` obrigatório na troca de plano | o POST aceita a chave e a honra; o reenvio sequencial esbarra em `same_plan`, e a chave é escopada por operador | torná-la obrigatória, para fechar também o envio **concorrente** — dois cliques ao mesmo tempo emitiriam dois acertos de rateio | sem bloco definido: seria a primeira rota do produto a exigir a chave, e as de dinheiro do balcão (comanda, caixa) a aceitam opcional. Mudar uma só cria duas convenções; mudar todas é decisão de contrato de API, com cliente a atualizar. Fica escrito porque a `/security-review` do bloco 28 apontou e a resposta foi consciente, não esquecimento |
| Segundo fator na troca de plano pelo dono | a rota é `settings.manage`, e o segundo fator é derivado da permissão declarada — então ela emite cobrança sem exigir o autenticador | decidir se a emissão de cobrança pelo próprio dono merece `finance.*` | sem bloco definido: exigir finanças obrigaria o dono que ainda não cadastrou autenticador a não conseguir **ler** o próprio plano, que é a tela onde ele descobre que a conta vai vencer. O risco é o próprio dono gastando o próprio dinheiro, com fatura e trilha. A troca vira decisão no dia em que houver mais de uma conta com `settings.manage` numa barbearia |
| CAC e payback | GMV, MRR e churn saem de dado que o produto tem | as duas métricas da SPEC §8 que dependem de **custo de aquisição** | sem bloco definido: não existe origem de dado. Quanto se gastou para trazer uma barbearia mora em ferramenta de marketing, não aqui, e inventar um campo "custo" que ninguém preenche é o defeito de `blocks` outra vez |
| Exportação do titular em PDF | o arquivo sai em JSON, completo, com nove consultas nomeadas e teste que reprova quando uma tabela com dado de cliente fica de fora | o PDF que a SPEC §1.8 regra 4 cita ao lado do JSON | sem bloco definido: exigiria a primeira dependência de geração de documento do produto, e a mesma decisão volta nos blocos 53 e 54 (nota fiscal) e na fatura em PDF da plataforma. As três devem escolher o mesmo caminho de uma vez, não três vezes. O JSON já é legível e é o formato que a ANPD aceita para portabilidade; o PDF é conforto de leitura, não o direito |
| Teto de requisição compartilhado entre processos | teto por IP em duas janelas, e — desde o bloco 33 — escada de espera **por conta** no login, esta guardada no banco e portanto compartilhada por todos os processos | o teto por IP num armazenamento comum: hoje ele é a memória do processo, então dois servidores dobram o limite efetivo | sem bloco definido: exigiria Redis, que é a primeira dependência de infraestrutura fora do Postgres, e a decisão de tê-lo vale junto com o CD e o ambiente que ainda não existem. O que protegia senha era a escada por conta, e essa **já** é compartilhada; o teto por IP protege custo de endpoint, e dobrá-lo com dois processos não abre nada |
| "Perto de mim" com a coordenada do aparelho | a busca inteira: vitrine sem RLS, raio, caixa de coordenada indexada, filtros de nota, preço, comodidade e clube, e a cidade escolhida com o centro derivado das próprias barbearias listadas | ler a **geolocalização do navegador**, que é o que a SPEC §5.2 chama de "perto de mim" | sem bloco definido: exige geolocalização no navegador. O **R5 já abriu a primeira ilha client-side e deixou a página pública fora dela**; falta agora uma ilha pública específica, com consentimento e medição própria, para não transformar a busca anônima no bundle do ERP. Escolher a cidade não é consolo: ela resolve o caso de quem busca do computador, e o centro sai do cadastro em vez de uma tabela de municípios que alguém teria que manter |
| Filtro por **serviço** na busca do marketplace | os outros sete filtros da SPEC §5.2, o motor rodando em lote, e — desde o bloco 73 — a dimensão "profissional", que entrou como **página pública do barbeiro**: é assim que ela existe num marketplace, porque ninguém busca por um barbeiro que ainda não conhece | escolher o serviço na busca. Hoje o horário do card é o do **serviço de entrada** da casa, o mesmo do "a partir de", e a tela diz isso em letras — a casa cujo serviço mais barato está lotado some do filtro com a tarde livre para o resto do cardápio | sem bloco definido: cada barbearia nomeia os serviços como quer ("Corte", "Corte masculino", "Cabelo"), e um filtro que atravessa casas exige uma **taxonomia compartilhada** que ainda não existe. Inventá-la dentro deste bloco seria decidir por todo mundo a partir de um cadastro só; ela vale junto com o primeiro cliente real que tenha catálogo grande o bastante para justificá-la |
| Saída de webhook por proxy de egresso | a recusa de destino interno em duas camadas — o nome no cadastro e **cada IP resolvido** antes de conectar —, `redirect: 'manual'` para o `3xx` não virar o segundo salto sem guarda, e `https://` por `CHECK` | fechar a janela entre a resolução e a do `fetch` (religação de DNS). Hoje ela é estreita e de baixo impacto: o esquema é `https:` e o certificado é conferido, então uma religação para IP interno falha no aperto de mão antes de qualquer corpo sair ou voltar — e o erro registrado é o genérico da biblioteca, sem servir de oráculo de porta | sem bloco definido: o conserto de verdade é a saída da rede passar por um proxy de egresso com lista de destinos, e isso é decisão de infraestrutura, não de código. Entra junto do primeiro deploy de verdade |
| Tabela de versão do schema | o ensaio de restauração confere que o banco restaurado tem as colunas da última migração | uma tabela que registre qual migração foi aplicada e quando | sem bloco definido: as migrações são aplicadas em ordem por script, e o marcador de coluna responde a pergunta que importa hoje ("este dump é velho?"). Uma tabela de versões vale a partir do primeiro deploy de verdade, junto do CD |

A leitura agrupada — o que é dívida, o que espera infraestrutura, o que é ordem
deliberada e o que é só tela — está em
[`SPEC.md` §7.1](SPEC.md#71-distância-entre-esta-spec-e-o-que-está-construído).
Esta tabela continua sendo a fonte do detalhe; a SPEC agrupa pelo motivo.

**Lacuna fechada sai da tabela.** O histórico de por que foi adiada fica no
commit que a fechou; manter linha morta aqui faria a lista virar ruído e
esconder o que ainda falta.

---

## R6 — títulos históricos limitados por lacunas abertas

Bloco fechado registra **o que o código entregou**, não a promessa mais ampla do
título original. A tabela abaixo liga os casos em que uma lacuna aberta limita
explicitamente um título histórico. `scripts/verificar-r6-promessas.mjs` impede
que a palavra que promete demais volte enquanto a lacuna continuar aberta.

| Bloco | Lacuna aberta que limita o título | Texto que não pode voltar ao título |
|---|---|---|
| 15 | Arrastar o cartão na agenda para remarcar | `arrastar` |
| 23 | Publicação automática e ambiente de staging | `CI/CD` · `staging` |
| 33 | Teto de requisição compartilhado entre processos | `rate limit global` |
| 35 | Pix pela Stripe, e o prazo do QR Code | `Pix pela Stripe` |
| 50 | Contrato de split exercido pelo adquirente | título sem ressalva de provider fake |
| 53 | Fatura em PDF e nota fiscal | `integração` sem dizer que o provider é fake |
| 54 | Fatura em PDF e nota fiscal | título sem dizer que o emissor real está pendente |
| 57 | Campanha por e-mail, push e SMS | `canais` como se todos estivessem entregues |
| 70 | Filtro por **serviço** na busca do marketplace | `filtros` sem limitar aos implementados |

## R1 — MVP (23 blocos)

**Critério de aceite:** uma barbearia de duas cadeiras consegue largar o sistema
atual sem perder nenhuma capacidade que usava.

| # | Bloco | Estado |
|---|---|---|
| 1 | Motor de disponibilidade + schema Scheduling | ✅ |
| 2 | Repositórios: resolver `ProfessionalDay`, catálogo, habilidades | ✅ |
| 3 | API + middleware de tenant/RLS + `GET /availability` | ✅ |
| 4 | Domínio de reserva: criar, hold, idempotência, reagendamento atômico | ✅ |
| 5 | Auth do cliente (OTP WhatsApp) + endpoints de reserva | ✅ |
| 6 | Design system: tokens, componentes base, tema, acessibilidade | ✅ |
| 7 | Página pública SSR: layout, mapa, horário, JSON-LD, deep links | ✅ |
| 8 | Fluxo de agendamento no front: serviço → profissional → horário → dados → comprovante | ✅ |
| 9 | Meus agendamentos: entrar por código, listar, cancelar, remarcar | ✅ |
| 10 | Conta de gestor + onboarding em 6 etapas + configuração da unidade | ✅ |
| 11 | Balcão: painel do dia, check-in, no-show, busca e marcação pelo balcão | ✅ |
| 12 | RBAC mínimo: papéis, permissões e contas de equipe | ✅ |
| 13 | Admin: CRUD de catálogo, equipe, jornadas, recursos | ✅ |
| 14 | Balcão: fila de walk-in, encaixe com custo visível, posição pelo celular | ✅ |
| 15 | Agenda: dia/semana/lista, mover por formulário, bloqueio pontual | ✅ |
| 16 | `app-pro`: agenda do barbeiro, próximo cliente, preferências | ✅ |
| 17 | `app-pro`: check-in, iniciar/finalizar, comissão, metas | ✅ |
| 18 | Comanda + checkout + caixa + **fiado** | ✅ |
| 19 | Comissão básica + fechamento | ✅ |
| 20 | Notificações: confirmação, lembrete 24h/2h, retorno (fila + worker) | ✅ |
| 21 | Dashboard básico + validador de catálogo | ✅ |
| 22 | Importador de base + deduplicação por telefone | ✅ |
| 23 | Portão local de qualidade: observabilidade, e2e e carga em `/availability` | ✅ |

---

## O balcão é a terceira superfície

Três pessoas usam este produto, e só duas tinham tela no plano original.

| Quem | Aparelho | Frequência | Densidade |
|---|---|---|---|
| Cliente | celular, em pé na rua | uma vez por mês | respira |
| Gestor | celular ou notebook | uma vez por semana | média |
| **Balcão** | **notebook ligado o dia inteiro** | **o tempo todo** | **densa** |

O balcão é quem digita o telefone de quem chegou sem marcar, marca presença,
descobre que o cliente das 14h não veio e decide se encaixa o que está esperando
em pé na frente dele. A SPEC descreve o papel (Parte 1 §1.2), a fila presencial
(Parte 2 §2.10 — "**é outro objeto e outra tela**") e o check-in (§2.11). O que
faltava era o roadmap tratar isso como **uma superfície**, e não como funções
espalhadas.

O erro concreto que estava no plano:

- **Check-in só existia dentro do `app-pro`**, o aplicativo do barbeiro. Mas o
  primeiro canal de check-in que a SPEC lista é "recepção" — quem marca presença
  na prática é quem está no balcão, não o barbeiro com a máquina na mão.
- **A fila de walk-in estava no bloco 37**, depois do MVP inteiro. Numa barbearia
  de bairro, quem entra sem marcar é uma fatia grande do faturamento; sem a fila,
  o sistema não cobre o dia real e a recepção volta para o caderno.
- **Não havia RBAC.** Hoje toda conta de gestor tem poder de dono. Criar a conta
  da recepcionista antes de existir permissão entregaria faturamento e base de
  clientes a quem só precisa marcar presença — e `customers.export` é o vetor
  clássico de roubo de base quando alguém sai.

Daí a ordem: o painel do dia (11) vem primeiro porque é o buraco mais agudo —
hoje o dono abre a página do cliente para adivinhar o que está marcado. O RBAC
(12) vem logo atrás e **antes de qualquer conta que não seja do dono**: enquanto
só existe dono não há permissão a separar, mas a primeira recepcionista criada
sem ele já é um incidente. O CRUD (13) espera porque mudar preço é dor semanal;
não enxergar a agenda é dor de todo minuto do expediente.

### O que muda no desenho

É a primeira tela cujo aparelho principal é um **notebook**, aberta o dia
inteiro, usada por alguém que não lê — olha de relance entre um cliente e outro.

Isso muda a **densidade**, não a regra. O balcão é a mesma tela nos dois
aparelhos: nasce no piso de 360px, ganha colunas e atalhos de teclado quando há
espaço. Nada de "versão de celular" reduzida — a recepção atende pelo telefone
sempre que o notebook está ocupado com outra coisa, e é justamente aí, com
cliente esperando em pé na frente dela, que a tela não pode faltar.

Vale para todo o produto e está no CLAUDE.md §5: todo **alvo autônomo** tem
44px em qualquer largura, `min-width` sempre, e conferência medida em 360 · 390 ·
768 · 1280 por `scripts/medir-responsividade.js` — não no olho. Elemento que não
pode receber 44px sem sobrepor outro conteúdo deixa de ser alvo e permanece
informativo; é o caso de buracos muito curtos na régua proporcional da Agenda V10.

---

## Plataforma (10 blocos)

Transversal. Nada aqui aparece para o cliente final, e sem nada aqui o produto
não é vendável.

| # | Bloco | Estado |
|---|---|---|
| 24 | Super Admin: tenants, planos, bloqueio de conta | ✅ |
| 25 | Super Admin: métricas globais, MRR, churn | ✅ |
| 26 | Super Admin: feature flags, impersonação auditada | ✅ |
| 27 | Billing: planos, trial, assinatura da barbearia | ✅ |
| 28 | Billing: upgrade/downgrade, inadimplência, régua de retentativa | ✅ |
| 29 | Billing: integração com PSP, conciliação | ✅ |
| 30 | RBAC: telas de gestão de papéis e permissões editáveis pelo dono | ✅ |
| 31 | LGPD: consentimentos, exportação de dados | ✅ |
| 32 | LGPD: anonimização, retenção, pipeline de exclusão | ✅ |
| 33 | Segurança: hardening, rate limit por processo + escada por conta, auditoria de acesso | ✅ |

---

## R2 — dinheiro e ocupação (11 blocos)

| # | Bloco |
|---|---|
| 34 | `PaymentProvider`: abstração, fake e o cliente Stripe compartilhado | ✅ |
| 35 | Motor de Pix no adquirente: QR Code, webhook e conciliação; ativação na conta pendente | ✅ |
| 36 | Cartão e link de pagamento pela Stripe | ✅ |
| 37 | Sinal seletivo + política de reembolso | ✅ |
| 38 | Lista de espera: entradas, expiração, gatilho de cancelamento | ✅ |
| 39 | Lista de espera: priority queue, janela exclusiva, notificação | ✅ |
| 40 | Sugestões e reclamações do cliente | ✅ |
| 41 | Fidelidade: pontos, visitas ou cashback | ✅ |
| 42 | Pacotes: venda, consumo, validade, receita diferida | ✅ |
| 43 | Avaliações + fluxo de recuperação de nota baixa | ✅ |
| 44 | Produtos, estoque, ficha de consumo, CMV | ✅ |

### O bloco 40 e o 43 são irmãos, e não a mesma coisa

A SPEC §4.10 descreve **avaliação**: 1 a 5 estrelas, vinculada a um atendimento
concluído de verdade, com janela de recuperação quando a nota é baixa. Ela é
confiável justamente por ser vinculada — é o que a separa de review aberta de
marketplace, e é o bloco 43.

Falta o outro lado, e ele não estava em lugar nenhum da SPEC nem do roadmap: o
cliente que quer **dizer alguma coisa sem ter uma nota para dar**. "A cadeira
do fundo está bamba", "vocês deviam abrir no domingo", "fui atendido bem, mas
esperei quarenta minutos". Nada disso cabe numa estrela, e nada disso exige um
atendimento concluído — quem desistiu da fila e foi embora é justamente quem
mais tem o que contar.

Por isso é bloco próprio e não um campo no 43:

- **A entrada é diferente.** Avaliação nasce de um atendimento; sugestão nasce
  de uma vontade. Amarrá-la a `appointment_id` perderia quem nunca chegou a ser
  atendido.
- **O destino é diferente.** Nota baixa vira alerta de recuperação com prazo de
  48h. Sugestão vira fila de triagem sem prazo, que alguém lê quando dá.
- **A publicação é diferente.** Avaliação vai para o perfil público. Sugestão e
  reclamação **não vão** — são conversa entre o cliente e a casa, e publicá-las
  seria transformar um canal de melhoria em vitrine de problema.

O que o bloco entrega: o canal do lado do cliente (na página pública e no
próprio link de agendamento, sem exigir conta), a fila de triagem no admin com
estado e responsável, resposta ao cliente pelo canal que ele já usa, e o
vínculo opcional com atendimento quando existir um. O limite ético do §4.10 vale
igual — o produto não oferece apagar reclamação.

---

## R3 — recorrência e escala (15 blocos)

| # | Bloco |
|---|---|
| 45 | Planos de assinatura: modelagem, regras, cooldown | ✅ |
| 46 | Assinatura: restrição de horário, dependentes, prioridade na fila | ✅ |
| 47 | Cobrança recorrente: régua, suspensão gradual, cancelamento self-service | ✅ |
| 48 | Rentabilidade da assinatura (simulação dos três modelos de comissão) | ✅ |
| 49 | Split: modelagem derivada da comissão | ✅ |
| 50 | Split: contrato de KYC, liquidação e estorno exercitado pelo provider fake | ✅ |
| 51 | Financeiro: contas a pagar/receber, transferências, conciliação | ✅ |
| 52 | Financeiro: vale, DRE gerencial | ✅ |
| 53 | `FiscalProvider`: abstração, contrato e provider fake | ✅ |
| 54 | Fiscal: fluxo de NFS-e, cancelamento e Salão-Parceiro; emissor real pendente | ✅ |
| 55 | WhatsApp oficial: templates, webhooks, botões | ✅ |
| 56 | Marketing automation: motor de eventos, teto de mensagens, janela de silêncio | ✅ |
| 57 | Campanhas: filtros, WhatsApp e receita atribuída | ✅ |
| 58 | Multiunidade: seleção, consolidação, transferência de estoque | ✅ |
| 59 | Multiunidade: cliente e fidelidade compartilhados | ✅ |

---

## R4 — inteligência (10 blocos)

Depende de histórico acumulado. Não antecipar.

| # | Bloco |
|---|---|
| 60 | Reliability score + sinal condicional | ✅ |
| 61 | Ciclo individual de retorno + segmentação automática | ✅ |
| 62 | Churn score com explicação | ✅ |
| 63 | Schema semântico de métricas (base do assistente) | ✅ |
| 64 | Assistente do gestor: text-to-query | ✅ |
| 65 | Agente de agendamento: intent, slots, confirmação | ✅ ¹ |
| 66 | Agente: remarcação e recepção digital | ✅ ¹ |
| 67 | Insights proativos | ✅ |
| 68 | Smart pricing com aprovação humana | ✅ |
| 69 | Previsão de consumo e sugestão de compra | ✅ |

¹ O motor e as rotas ficaram **sem porta** do bloco 66 ao 105: nenhuma tela e
nenhum canal os chamavam. O bloco 106 abriu a do site (`/[slug]/conversar`); a do
WhatsApp continua em [Lacunas com dependência](#lacunas-com-dependência-declarada),
e depende de a barbearia ter número próprio verificado. A nota fica porque o ✅
sozinho contou uma meia-verdade por quarenta blocos, e apagá-la agora seria
apagar o registro de como isso passou despercebido.

---

## R5 — rede (10 blocos)

Só faz sentido com centenas de barbearias na base.

| # | Bloco |
|---|---|
| 70 | Marketplace: busca geográfica e filtros implementados | ✅ |
| 71 | Marketplace: "próximo horário" em lote (exige `/availability` rápido) | ✅ |
| 72 | Marketplace: atribuição de cliente novo e comissão | ✅ |
| 73 | Perfil público do barbeiro | ✅ |
| 74 | Portfólio e consentimento de uso público | ✅ |
| 75 | Anúncios e destaque | ✅ |
| 76 | Franquias: catálogo padrão, preços sugeridos | ✅ |
| 77 | Franquias: indicadores consolidados, metas | ✅ |
| 78 | API pública: chaves, escopos, rate limit | ✅ |
| 79 | Webhooks assinados para terceiros | ✅ |

---

## Adição de escopo: contestar uma avaliação (bloco 80)

O bloco 43 fechou com a nota baixa publicando **de qualquer forma** passadas as
48 horas, e as três camadas que impedem apagar avaliação continuam de pé. Isso
está certo para a nota ruim e verdadeira, e deixa sem resposta a nota ruim e
**injusta** — spam, ofensa, nota atribuída ao profissional errado, gente que
nunca foi cliente. Contra essa, hoje o dono não tem nada, e é uma reclamação
justa.

O caminho **não** é apagar. Apagar o que não se gostou transforma a nota em
folheto — e não só do lado de fora: a média que o gestor vê no painel conta tudo
hoje, publicado ou não, e é a distância entre ela e a média pública que diz
"o Bruno está com 4,8 na rua e 3,9 de verdade". Com o botão de apagar, os dois
números viram o mesmo e o dono cega o próprio termômetro. Somem-se a isso o CDC
art. 37 e o fato de a plataforma ser operadora.

A contestação é o meio-termo que Booksy e Fresha já operam:

| | Apagar | Contestar |
|---|---|---|
| Motivo | nenhum | lista fechada, registrado e auditado |
| Efeito | some para sempre | **suspensa** da vitrine enquanto está em análise |
| Nota e texto | apagáveis | continuam imutáveis — sai da vitrine, não do histórico |
| Média do painel | muda | **não muda**: o gestor continua vendo a verdade |

| # | Bloco | |
|---|---|---|
| 80 | Contestar uma avaliação: motivo de lista fechada, suspensão da vitrine, trilha | ✅ |

O número do roadmap sobe de 79 para 80. Não é bloco descoberto: é escopo novo,
pedido depois do 51, e está aqui porque adição silenciosa é o que faz um plano
deixar de servir para planejar.

---

## Correção de contagem: o roadmap parou no 80 e o código foi ao 87

Esta seção é o conserto de uma divergência, e ela merece ser dita em vez de
apagada: o contador disse **80 de 80** por sete blocos, enquanto o código citava
o 81, o 82, o 83, o 84, o 85, o 86 e o 87 — trinta e oito citações só do 82.

É o defeito que este repositório mais cataloga, aplicado ao próprio plano: dois
lugares afirmando o mesmo fato e discordando. O sintoma foi
`verificar-lacunas.mjs 88` respondendo *"(bloco desconhecido)"* sobre o bloco que
estava começando — a guarda que existe para dizer o que aponta para um bloco não
conhecia bloco nenhum acima de 80.

Nenhum destes é bloco novo: as linhas saem dos commits e das citações que já
estavam no código, e a maioria é a corrida do WhatsApp oficial contra a Meta.

| # | Bloco | |
|---|---|---|
| 81 | Nota fiscal vira recurso ligado pela plataforma, e nasce desligada | ✅ |
| 82 | Campanha e automação saindo pelo canal de WhatsApp | ✅ |
| 83 | Embedded Signup: conectar deixa de ser copiar dois números de quinze dígitos | ✅ |
| 84 | A conta e o número descobertos pelo token, não pelo navegador | ✅ |
| 85 | Coexistência: conectar o número sem tirá-lo do WhatsApp da barbearia | ✅ |
| 86 | A janela de conexão por redirecionamento, no lugar do SDK | ✅ |
| 87 | A frase da Meta chega à tela, e com ela onde se resolve | ✅ |
| 88 | Os escopos concedidos viram cadastro, e a rota do número antigo sai | ✅ |
| 89 | A política de privacidade vira página pública, que é o que a App Review exige | ✅ |
| 90 | A Meta passa a ser perguntada: o número sai de "falta confirmar" e o texto sai de "Na Meta" | ✅ |
| 91 | Salvar o cadastro para de rebaixar um canal já verificado | ✅ |
| 92 | A tela de automação passa a se explicar sozinha, e a automação ligada ganha como desligar | ✅ |
| 93 | A amostra de cada variável e a categoria certa: a Meta para de recusar o texto sem lê-lo | ✅ |
| 94 | O texto vira cadastro com nome próprio, e a automação escolhe **qual** — não mais um por tipo | ✅ |
| 95 | Os três tipos de botão da Meta, com o destino saindo do domínio e nunca de um campo | ✅ |
| 96 | A campanha e a ficha do cliente também escolhem o texto, e a tela mostra a frase preenchida | ✅ |
| 97 | A tela passa a responder "por que não chegou": lista de pulados com motivo, e nada de verde com o canal desligado | ✅ |
| 98 | O formulário para de perder o que foi digitado, e o envio em massa ganha confirmação | ✅ |
| 99 | Um vocabulário só para segmento, automação e campanha — e a pista de que a barra rola | ✅ |
| 100 | "Quando · só para · mandar": o gatilho ganha público, e a automação vira uma frase | ✅ |
| 101 | O que a avaliação cega achou: a fila parada tem aviso, o dinheiro tem um formato só, e as barras de navegação dizem que rolam | ✅ |
| 102 | Três consultas da automação nunca tinham rodado: a varredura volta a funcionar, e o aviso passa a enxergar a tarefa que desistiu | ✅ |
| 103 | O que a avaliação cega do financeiro achou: o balcão para de cobrar duas vezes, a permissão da tela volta a ser a da rota, e o menu chama cada tela pelo nome dela | ✅ |
| 104 | O que a avaliação cega da administração achou: a medição deixa de ser cega no painel, o gerente da filial para de fechar a matriz, e a trilha passa a dizer em quem mexeu | ✅ |
| 105 | O que a avaliação cega do cliente final achou: o passo 4 mostra o preço que o motor grava, a disputa por um horário deixa de virar 500, e a busca ganha os filtros que a API já aceitava | ✅ |
| 106 | A porta do agente: o cliente escreve o que precisa, e a proposta leva ao passo de confirmar | ✅ |
| 107 | O agente entende substantivo: "quero um corte amanhã" para de ser "não entendi" | ✅ |
| 108 | O que a avaliação cega do marketing achou: o teto de quatro promoções por mês volta a contar, a receita atribuída deixa de esperar a próxima campanha, e a Retenção manda ao público que ela mostra | ✅ |
| 109 | O que a avaliação cega do atendimento achou: o barbeiro para de fechar a agenda da casa, a grade para de apagar o que foi atendido, e o escopo de unidade chega às três rotas que faltavam | ✅ |
| 110 | As três lacunas sem bloco: a vitrine e o resgate de entrega ganham o laço periódico, e o aviso da vaga passa a dizer **quem** ligar | ✅ |
| 111 | O que a avaliação cega dos cadastros achou: salvar a empresa para de apagar a empresa e de reescrever a rede, as etapas que substituem o conjunto recusam depois de a casa abrir, e o escopo de unidade chega às seis rotas de profissional que faltavam | ✅ |
| 112 | O que a avaliação cega das integrações achou: três integrações morriam em toda instalação feita pelo caminho documentado, quatro eventos de webhook nunca disparavam, e a tela oferecia trinta e um escopos de chave com duas rotas honrando dois | ✅ |
| 113 | O que a avaliação cega da plataforma achou: a comissão do marketplace nascia faturada contra uma fatura que não a continha, a conta de plataforma não tinha rotação de senha nem desligamento, e o triângulo de safra pintava "todas saíram" como "ainda não aconteceu" | ✅ |
| 114 | O que a avaliação cega da visão geral achou: o DRE comparava um mês pela metade contra um mês inteiro, "meus números" dizia ao barbeiro que ele caiu 40% quando caiu 5%, e a avaliação mostrava a hora do fim da reserva no fuso do servidor | ✅ |
| 115 | A coordenada da barbearia: o link do mapa colado vira o ponto, o centro da capital é a rede, e o cartão da vitrine ganha o estado que faltava | ✅ |
| 116 | A varredura geral: a ocupação que contava o balcão como cadeira, o 500 que a API pública devolvia por horário tomado, a fila da filial que o link não achava, o prazo citado errado e o saldo que o cliente lia como zero | ✅ |
| 117 | Varredura de multiunidade: a comanda de uma loja fechada pela outra com o dinheiro na gaveta errada, a folha da matriz lida e fechada pela filial, o saldo da rede validando a perda da loja, e o painel que nunca dizia onde você está | ✅ |
| 118 | Varredura da rota que agrega: a comanda entregando nome e dívida por cinco portas de trás, a receita de campanha fora do segundo fator, a agenda exportando a base inteira, e a permissão que o dono desmarcava sem efeito nenhum | ✅ |
| 119 | O que a revisão do 118 achou: `customers.view` somada ao `@Exige` tirava o PDV inteiro de quem não a tem, marcar falta contornava a guarda de cancelar, e a varredura de pessoa era contornável declarando o interruptor sem usá-lo | ✅ |
| 120 | Varredura de listas paralelas: 97 recusas do domínio viravam "Tente de novo" na tela, `assinatura` saía crua na comanda do assinante, e vinte uniões do domínio estavam reescritas à mão em `admin-api.ts` | ✅ |
| 121 | Varredura de estado sem saída na tela: comanda aberta que não fechava nem cancelava, nota fiscal presa em voo sem varredura, segundo fator sem como desligar, avaliação contestada fora do alcance da retirada, mensalidade perdoada deixando a assinatura suspensa, lista de espera só leitura e campanha travada em `enviando` | ✅ |
| 122 | Varredura de §6 pergunta 6: o balcão mostrava o preço de tabela sobre um horário que o motor congela mais caro, o faturamento por barbeiro tinha três definições, a barra de meta media a casa contra a meta da equipe, e o DRE comemorava em verde um aluguel não pago | ✅ |
| 123 | Varredura geral: o balcão não tinha como vender um produto e o item digitado à mão nascia sem `service_id`, o estorno deixava o custo no CMV, a recusa de resgate virava 500, e a nota fiscal ficava fora da exportação do titular | ✅ |
| 124 | A gorjeta ganha dono: rateada por peso da receita entre quem atendeu, ou de quem o cliente nomeou — com linha própria no DRE, fora das duas somas, e no extrato do barbeiro | ✅ |
| 125 | O atendimento concluído para de segurar a cadeira até o fim da reserva: a janela ocupada encolhe até o instante real, por uma função que a constraint de exclusão e o motor de disponibilidade compartilham | ✅ |
| 126 | O menu do painel para de oferecer o que a conta não abre — e as seis telas que respondiam 403 com *"recarregue a página"* passam a dizer de quem é a permissão. A guarda é empírica e nos dois sentidos: entra com cada papel padrão, abre tudo que o menu ofereceu e tudo que ele escondeu | ✅ |
| 127 | Duas lacunas de dado pessoal e de cadastro: a recepção automática passa a responder as formas de pagamento a partir da coluna que existia desde a migração 0013, e o preview de importação abandonado ganha a varredura que alcança quem nunca mais abriu a tela | ✅ |
| 128 | Três lacunas de "o mecanismo existe e a tela não": a janela do assistente viaja no link para o painel, a simulação do clube diz **por que** não há o que comparar, e a plataforma ganha a tela de cancelar, reativar e trocar o cartão de uma barbearia | ✅ |
| 129 | O relatório de resultado ganha o consolidado da rede — `TODAS_AS_UNIDADES` existia desde o bloco 58 e nenhuma tela o chamava — e o autoatendimento do cliente passa a decidir as três finalidades de consentimento, não só a de promoção | ✅ |
| 130 | O barbeiro fecha a própria agenda sem teto de horas — o limite de quatro horas valia pela duração e ignorava o alvo, então pegava junto o dono da cadeira —, o seletor "De quem" deixa de abrir na única opção que a API sempre recusa para ele, e a regra de comissão por **categoria** ganha porta na tela: `commission_rules.category_id` existia desde o bloco 19, com peso próprio na resolução, e nenhum formulário a preenchia | ✅ |
| 131 | As três peças da rede de segurança do deploy que só falhavam quando acionadas: o backup empacotava a mídia com `exec` no contêiner da API — impossível fazer backup com a aplicação fora, que é quando ele importa —, o `atualizar.sh` fazia backup **antes** de buscar o código, então uma API quebrada nunca chegava a ser corrigida, e o `voltar.sh` imprimia "no ar" sem conferir nada, sobre um contêiner morto | ✅ |
| 132 | O estado vazio que não distinguia dois zeros: as três telas que oferecem texto de WhatsApp — ficha do cliente, Campanhas e Automações — escreviam "Nenhum texto aprovado" também para quem tinha textos aprovados de outro tipo. A barbearia com `sua_vez` e o lembrete de 2h aprovados leu isso, foi ao painel da Meta, viu os dois lá e concluiu que o produto estava quebrado. `faltaDeTexto` separa os dois fatos em `core`, e a guarda é derivada de `TIPOS_DE_CAMPANHA`: a quarta tela que recortar por tipo nasce cobrada | ✅ |
| 133 | A viagem à Meta sai da requisição e vira tarefa de fila. Medido em produção, submeter um texto custava **7.039 ms** de um `POST` do balcão contra o teto de 10 s do `web` — e estourar o teto fazia a tela dizer "não deu" sobre um texto que a Meta já tinha recebido, com a tentativa seguinte batendo em "nome repetido". A reserva enfileira dentro da própria transação, o worker entrega, e `pendente` ganhou o campo que separa "na fila" de "na Meta". Mais a varredura que solta o texto preso quando a tarefa desiste — o estado sem saída do bloco 121, na porta ao lado | ✅ |
| 134 | Os quatro silêncios que a caçada de produção expôs: `accepted` da Meta era gravado e mostrado como entrega, e `whatsapp_messages.delivered_at` estava sendo escrito desde o bloco 58 **sem nenhum leitor**; seis porteiros do worker cortavam o envio e fechavam a tarefa como concluída, sem motivo em lugar nenhum; `assinarWebhook` tinha um chamador só, então quem cadastra o número à mão nunca recebia desfecho de nada; e `fiscal.conciliar` falhava três vezes por hora, nas duas barbearias, porque não há emissor contratado | ✅ |
| 135 | A hora que o servidor renderiza e o navegador não reidrata: oito telas formatam `hour`/`minute` sem `timeZone`, então `Intl` usa UTC de um lado e o fuso do aparelho do outro. É o defeito D2 mais o erro 418, que derruba a página inteira. Entra com a guarda derivada — o corte foi medido no bloco 134 e acusa 8 de 63 | ⬜ |

---

## Correção de escopo: fiado subiu para o MVP

O roadmap punha fiado no bloco 52 e a SPEC §3.10 diz, com todas as letras:

> **Obrigatório no MVP** — sua ausência é motivo de não-migração.

Os dois não podiam estar certos, e quem decide é o critério de aceite do próprio
MVP: *uma barbearia de duas cadeiras substitui o incumbente sem perder nenhuma
capacidade que usava*. A engenharia reversa do concorrente encontrou
`get_controle_fiados` e `registra_pagamento_divida` — é recurso em uso, não
enfeite de catálogo. Barbearia de bairro fia, e sistema que não fia é sistema
que não entra.

Fiado passou para o **bloco 18**, junto com o caixa, porque é onde ele de fato
vive: pagar fiado é forma de pagamento no fechamento da comanda, e receber o
fiado é movimento de caixa. Separar em outro bloco criaria uma forma de
pagamento que a tela de pagamento não conhece.

**`vale` e DRE gerencial ficaram no 52.** A SPEC os descreve como presentes no
incumbente, mas não os marca como obrigatórios para migrar — vale é
adiantamento descontado da comissão, e comissão é o bloco 19.

---

## Escopo recomendado

79 blocos é produto de time, horizonte de mais de um ano. Duas decisões cortam
isso pela metade sem prejudicar o que é vendável:

### 1. Adiar R4 e R5 por dependência, não por preguiça
São 20 blocos que **não funcionam** no começo: score e IA precisam de histórico
que ainda não existe, marketplace precisa de densidade de barbearias que ainda
não existe. Construí-los cedo produz funcionalidade morta.

### 2. Comprar a Plataforma em vez de construir
Billing e Super Admin (blocos 24–29) são os menos diferenciados do produto
inteiro. Nenhuma barbearia escolhe o sistema pelo painel interno do fornecedor.
Uma solução de billing pronta cobre a maior parte, e sobra o essencial: feature
flags, impersonação auditada e LGPD.

### Resultado

```
R1 MVP              23 blocos   (20 + balcão e RBAC)
Plataforma enxuta    5 blocos   (de 10)
R2                  10 blocos   (a fila de walk-in subiu para o MVP)
─────────────────────────────
                    38 blocos  → produto que uma barbearia paga e usa
```

Os três blocos que entraram no MVP não são escopo novo: dois já estavam na SPEC
(recepcionista e fila presencial), fora de ordem. O terceiro divide o RBAC em
dois — **aplicar** permissão vem antes da primeira conta que não é do dono
(bloco 12); **gerenciar** papéis pela tela continua na Plataforma (bloco 30),
porque até lá os quatro papéis fixos da SPEC bastam.

O resto vira roadmap de verdade — replanejado com cliente real usando o sistema,
não estimado no vazio.

---

## Riscos que podem alterar a contagem

| Risco | Impacto |
|---|---|
| **Fiscal** (blocos 50–51) | ~5.500 municípios com regras próprias. Pode ser 2 ou 6 blocos, dependendo do provedor escolhido. Não estimável antes da decisão. |
| **WhatsApp oficial** | Depende de número verificado e aprovação de templates. Bloqueio de fornecedor, não de código. |
| **Split** | Exige KYC de cada profissional no PSP. O onboarding assíncrono é mais trabalhoso que a divisão em si. |
| **Importadores** | O bloco 19 cobre CSV e um sistema. Cada origem adicional (AppBarber, Trinks, Belle) é trabalho novo. |
| **Reordenação** | Quando o MVP estiver numa barbearia real, o que ela pedir vai reordenar R2 em diante — e deve mesmo. |
