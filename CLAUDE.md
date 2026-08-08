# Regras do projeto

Vinculante para todo bloco do [`ROADMAP.md`](ROADMAP.md). Nenhum bloco é dado
como concluído sem cumprir as quatro regras abaixo e o
[Definition of Done](#definition-of-done).

Estas regras não são estilo. Cada uma existe por um defeito concreto encontrado
no sistema analisado em campo (`docs/01-analise-salonsoft.md`) ou por um erro
cometido e corrigido neste repositório.

---

## 1. Testes

**Todo bloco entrega teste junto com o código. Não existe "testo depois".**

### O que precisa de teste

| Tipo de código | Nível exigido |
|---|---|
| Lógica de domínio (cálculo, regra, decisão) | unitário, sem banco, sem rede |
| Garantia imposta pelo banco (constraint, RLS, trigger) | integração contra Postgres real |
| Repositório e query | integração — a query real, não um mock |
| Endpoint | integração, incluindo caminho de erro e de autorização |
| Interface | teste de comportamento, não de snapshot de markup |

### Regras

- **Nunca mocar o que se quer provar.** A constraint anti-overbooking e a RLS são
  garantias do Postgres; mock não prova nada sobre elas. Por isso
  `packages/db/test` e `packages/scheduling` rodam contra banco de verdade.
- **Teste determinístico.** Nada de `Date.now()`, `Math.random()` ou fuso do
  processo dentro da lógica. Relógio entra por parâmetro (`now`), fuso vem da
  unidade. A suíte de `core` roda idêntica sob `TZ=UTC` e `TZ=Asia/Tokyo` — isso
  é verificado, não prometido.
- **Teste tem que poder falhar.** Antes de aceitar um teste verde, confirme que
  ele fica vermelho quando a regra é quebrada.
- **Quando um teste falha, o suspeito é o código — não o teste.** No bloco 1 uma
  expectativa "errada" revelou desperdício real no fim da janela; no bloco 2, o
  mesmo padrão apareceu em recurso. Investigue antes de ajustar a expectativa.
  Se ajustar a expectativa, explique por quê no próprio teste.
- **Caminho triste é obrigatório:** entrada inválida, concorrência, permissão
  negada, tenant errado, recurso inexistente.
- **Nome de teste descreve a regra**, não a função. `"exceção do profissional
  vence o feriado da unidade"`, não `"resolveWorkingDay works"`.
- Cobertura não é meta. Regra sem teste é que é problema.

---

## 2. Cibersegurança

**Aplicável a todo bloco que toque dado, autenticação, dinheiro ou entrada
externa.** Na prática: quase todos.

### Isolamento multi-tenant

- `tenant_id` em toda tabela de negócio, com **RLS `FORCE`** e política de
  `USING` **e** `WITH CHECK`.
- Acesso ao banco **somente** via `withTenant`. O pool reaproveita conexões: sem
  `set_config(..., true)` dentro da transação, uma requisição herda o tenant da
  anterior.
- O role da aplicação é `NOBYPASSRLS` e não tem DDL.
- Repositório **não** repete `tenant_id` no `WHERE` — quem filtra é a política.
  Assim um `WHERE` esquecido não vaza; e existe teste que consulta sem filtro e
  espera zero linhas.

### Entrada e autenticação

- **Validar toda entrada externa na borda**, com schema. Nunca confiar em id,
  data, fuso ou valor vindo do cliente.
- **O fuso vem da unidade, nunca do dispositivo.** Foi assim que o sistema
  analisado errou a grade para cliente com relógio torto (defeito D2).
- **Rate limit por telefone e por IP** em OTP, login e `/availability`. O
  endpoint de OTP é porta de entrada para custo de mensagem e para enumeração de
  base.
- **Não revelar existência de cadastro.** `verifica_celular` responde igual para
  telefone existente e inexistente.
- OTP: 6 dígitos, TTL 5 min, máximo 5 tentativas, invalidação no acerto,
  cooldown progressivo no reenvio.
- MFA obrigatório para papéis com permissão `finance.*`.

### Dinheiro e efeitos colaterais

- **`Idempotency-Key` em todo POST** que cria agendamento ou move dinheiro.
- **Chave de idempotência é escopada por cliente**, nunca só por tenant. Ela vem
  do cliente e é livre: duas pessoas mandando `"1"` colidiriam, e a segunda
  receberia de volta o agendamento da primeira — com o id, que basta para
  cancelá-lo.
- **RLS separa barbearias, não separa clientes dentro de uma.** Toda operação
  disparada pelo cliente final (cancelar, reagendar, ver histórico) filtra
  também por `customer_id`.
- **Consumidor de evento e webhook é idempotente por id.** Entrega duplicada não
  pode gerar comissão dobrada nem baixa de estoque em duplicidade.
- Webhook do PSP é a fonte da verdade, com reconciliação por polling como rede
  de segurança.
- Valor monetário em centavos inteiros. **Nunca `float`.**

### Dados pessoais (LGPD)

- Consentimento de marketing é **separado** do necessário para executar o
  serviço, com data, IP e versão do texto.
- Foto de cliente exige consentimento específico; uso público exige outro.
- `customers.export`, acesso a foto, impersonação e alteração de permissão são
  **sempre auditados**.
- Log de auditoria é append-only.

### Sempre

- Segredo nunca no repositório. Configuração por variável de ambiente.
- Sem SQL concatenado com entrada de usuário — parâmetro sempre.
- Id público é UUID/ULID. Id sequencial em URL permite enumerar a base.
- Erro para o cliente é genérico; o detalhe vai para o log.
- Dependência nova entra só com motivo declarado no commit.

**Ao fechar um bloco que mexa em auth, pagamento, dado pessoal ou permissão,
rode `/security-review` antes do commit.**

---

## 3. Otimização

**Medir antes de otimizar. Mas não entregar lentidão conhecida.**

### Metas (SPEC Parte 5 §5.12)

| Alvo | Meta |
|---|---|
| APIs comuns | P95 < 500 ms |
| `GET /availability` | P95 < 800 ms (7 dias × 5 profissionais) |
| Página pública, LCP em 4G | < 2,5 s |
| PDV: comanda → pagamento | < 1 s percebido |

### Regras

- **Zero N+1.** Carga do intervalo em uma query. Se precisar de laço sobre
  registros com ida ao banco dentro, está errado.
- **Índice junto com a query que o exige**, no mesmo bloco. Índice parcial
  quando o filtro é sempre o mesmo (ex.: status não-terminal).
- **Cache invalidado por evento**, nunca só por TTL. `/availability` invalida em
  `appointment.created/cancelled/updated`, `schedule.changed`, `block.created`.
- **Não desperdiçar capacidade.** Este produto vende agenda: buraco morto é
  dinheiro perdido. Três vezes o mesmo padrão apareceu (grade fixa, fim de
  janela, contenção de recurso) — sempre que houver janela livre, pergunte se
  algum pedaço dela está sendo descartado sem necessidade.
- **Paginação por cursor**, nunca offset.
- Bundle do cliente separado do admin. Não entregar o ERP inteiro a visitante
  anônimo (defeito D10).
- Otimização entra com número antes e depois. Sem medição, não entra.

---

## 4. Arquitetura e clean code

### Direção de dependência

```
core  ←  scheduling  ←  api  ←  web
  ↑          ↓
  └────── db (Prisma/SQL)
```

- **`packages/core` não depende de nada.** Sem banco, sem rede, sem relógio, sem
  framework. É lógica pura e é onde mora a regra de negócio. Há teste que falha
  se alguém adicionar dependência a ele.
- Domínio não conhece framework. Controller não tem regra de negócio — traduz
  HTTP para caso de uso e volta.
- Integração externa entra por **abstração** (`PaymentProvider`,
  `WhatsAppProvider`, `FiscalProvider`), cada uma com implementação `fake` para
  teste e desenvolvimento.
- Modular monolith com fronteira explícita por domínio. Microsserviço só quando
  escala ou organização justificar.

### Fonte da verdade

- **O schema é o SQL em `packages/db/migrations`.** Prisma é introspectado
  (`pnpm db:pull`). Constraint de exclusão, RLS e as checks não têm
  representação em Prisma — um `migrate dev` as apagaria.
- Migração é aditiva e reversível. **Nunca editar migração já aplicada em
  ambiente compartilhado ou produção** — antes do primeiro deploy elas ainda são
  maleáveis, depois disso a correção vem em migração nova.
- Migração roda em produção: nada de `CREATE ROLE ... PASSWORD` nem qualquer
  credencial dentro dela. Bootstrap de role fica em `scripts/bootstrap-role.sh`,
  parametrizado por ambiente.

### Código

- **TypeScript estrito**, com `noUncheckedIndexedAccess` e
  `exactOptionalPropertyTypes`. Sem `any`. Sem `!` para calar o compilador —
  trate o caso.
- Nome em português no domínio (`profissional`, `comanda`, `fiado`), inglês nas
  primitivas técnicas. Não misturar dentro do mesmo conceito.
- **Comentário explica *por quê*, não *o quê*.** Se o código precisa de
  comentário para dizer o que faz, reescreva o código. Todo comentário que
  justifica uma decisão contra-intuitiva deve dizer o que aconteceria sem ela.
- Função faz uma coisa. Se o nome precisa de "e", separe.
- Erro é explícito no tipo de retorno ou lançado — nunca `null` silencioso para
  significar falha.
- Não abstrair antes do terceiro caso.
- **Campo que o motor aceita e ninguém preenche é mentira.** Se o domínio expõe
  uma entrada, o bloco que a introduz entrega a origem do dado junto. `blocks`
  ficou oito blocos como parâmetro aceito e sempre vazio: o motor tinha teste
  verde e o barbeiro não conseguia fechar uma hora do dia. Adiar a **tela de
  cadastro** para o bloco do admin é legítimo; adiar o mecanismo não é.
- Configuração de negócio é dado (coluna, feature flag), não constante no código.

---

## 5. Responsividade e acabamento visual

**Aplicável a todo bloco que produza interface.**

### Antes de escrever CSS, invoque `frontend-design`

A skill oficial da Anthropic está instalada em
`.claude/skills/frontend-design/`. **Todo bloco que produza tela nova começa por
ela** — é o que impede o resultado de parecer template.

As duas coisas se complementam e nenhuma substitui a outra:

- **Esta seção define o piso** — responsivo a partir de 360px, contraste medido,
  toque de 44px, foco visível, sem rolagem horizontal. Obrigações, várias com
  teste.
- **A skill define o teto** — direção estética, tipografia com personalidade,
  elemento assinatura.

Em conflito, o piso vence: layout marcante que quebra em 360px ou reprova no
contraste não entra.

**Alerta que já se aplica aqui:** a skill lista três aparências em que design de
IA costuma cair, e a segunda é "fundo quase preto com um único acento vivo" —
descrição superficial do tema escuro do bloco 6. O âmbar tem lastro (couro,
latão, o setor) e passou por verificação, mas paleta não diferencia. A
personalidade tem que vir de tipografia, estrutura e do elemento assinatura.

### Mobile-first, sem exceção

- **O piso de projeto é 360px.** É o Android popular no Brasil, o aparelho em
  que o cliente da barbearia realmente agenda — em pé, na rua, com uma mão.
  Nada pode quebrar abaixo disso.
- **Toda media query de layout usa `min-width`.** `max-width` significa
  "desfazer o que fiz para tela grande", o que inverte a ordem de trabalho e
  deixa o celular como caso excepcional. Há teste que rejeita.
- **Larguras de conferência:** 360 · 390 · 768 · 1280. Uma tela que só foi
  olhada no notebook não foi olhada.
- **Nunca esconder conteúdo no celular — refluir.** `display: none` em tela
  pequena é decisão de que aquilo não importava; se não importa, tire de todas.

### O que nunca pode acontecer

- **Rolagem horizontal na página.** É o defeito mais comum em página de
  barbearia no celular. Conteúdo largo — tabela, grade de horários, diagrama —
  rola dentro do próprio recipiente (`.ui-scroll-x`), nunca leva a página junto.
  Há teste.
- **Imagem sem limite de largura.** `max-width: 100%` sempre, e `aspect-ratio`
  declarado para a foto não empurrar o conteúdo ao carregar.
- **Ação principal sob a barra de gestos.** Barra fixa no rodapé soma
  `env(safe-area-inset-bottom)`. Sem isso o botão "Agendar" fica inalcançável no
  iPhone. Há teste.
- **Alvo de toque abaixo de 44px.** Vale para botão, campo, horário na grade e
  qualquer coisa clicável.

### Componente responsivo ao recipiente, não à tela

Cartão de serviço aparece em coluna única no celular, em duas no tablet e dentro
de uma barra lateral estreita no admin. Quem decide o formato é a largura
disponível — `@container` —, não a largura da janela.

### Acabamento

O que separa uma página que parece profissional de uma que parece template:

- **Uma ação primária por tela.** Se tudo é destaque, nada é. No fluxo de
  agendamento, a cada passo existe exatamente um botão em `accent`.
- **Ritmo vem da escala.** Todo espaçamento sai de `space`. Valor avulso
  (`13px`, `0.85rem`) é o que faz uma tela parecer montada às pressas.
- **Hierarquia por tamanho e peso, antes de cor.** Cor é o último recurso, não
  o primeiro — e é o que menos funciona para quem tem baixa visão.
- **Foto faz o trabalho pesado.** Em barbearia a escolha é visual: corte,
  ambiente, barbeiro. Layout que depende só de texto vai parecer pobre por mais
  bem espaçado que esteja.
- **Estado vazio, carregando e erro são desenhados**, não improvisados. "Nenhum
  horário disponível" é uma tela, com o que fazer em seguida — não uma lista
  vazia.
- **Conteúdo real desde o primeiro protótipo.** Nada de texto de preenchimento:
  nome de serviço longo, preço de quatro dígitos e nome composto de barbeiro são
  o que quebram layout, e só aparecem com conteúdo verdadeiro.
- **Densidade é diferente por app.** A página pública respira — o cliente entra
  uma vez por mês. O admin é denso — a recepção passa o dia ali e rolagem custa
  tempo.
- **Movimento com propósito e curto.** Transição existe para explicar de onde
  algo veio. Acima de 200 ms vira espera, e `prefers-reduced-motion` desliga.

### Referência de qualidade

O alvo não é "melhor que o concorrente analisado" — a página dele não tem
endereço, mapa, foto de serviço nem descrição (defeitos D8 e D9). O alvo é a
faixa de Booksy e Fresha, documentada em
[`docs/02-benchmark-apps-barbearia.md`](docs/02-benchmark-apps-barbearia.md) §5.

---

## Definition of Done

Um bloco só está concluído quando **todos** os itens passam:

- [ ] `pnpm verify` verde (typecheck + testes + build em todos os pacotes)
- [ ] Regra nova tem teste que falha se a regra for quebrada
- [ ] Caminho triste coberto: entrada inválida, concorrência, permissão, tenant
- [ ] Isolamento de tenant preservado — acesso via `withTenant`, nada fora
- [ ] Entrada externa validada na borda
- [ ] `Idempotency-Key` onde cria agendamento ou move dinheiro
- [ ] Sem N+1; índice criado junto com a query que o exige
- [ ] `packages/core` continua sem dependências
- [ ] Nenhum segredo no repositório
- [ ] `/security-review` rodado, se o bloco tocou auth, dinheiro, dado pessoal ou permissão
- [ ] README atualizado se alguma decisão de arquitetura mudou
- [ ] Interface conferida em 360, 390, 768 e 1280 — sem rolagem horizontal
- [ ] Estado vazio, carregando e erro desenhados
- [ ] Lacuna conhecida declarada por escrito, **com dependência e bloco**, na tabela
      [Lacunas com dependência](ROADMAP.md#lacunas-com-dependência-declarada)
- [ ] `ROADMAP.md` com o bloco marcado e o contador atualizado

---

## Comandos

```bash
pnpm verify            # tudo: typecheck, testes (com banco), build
pnpm -r typecheck
pnpm -r build

pnpm --filter @barbearia/core test          # puro, sem banco
pnpm --filter @barbearia/db test            # invariantes do schema
pnpm --filter @barbearia/scheduling test    # pipeline banco -> motor
```

Testes de banco exigem Postgres 16+ com `pgcrypto`, `citext` e `btree_gist`.
Cada script cria e destrói o próprio banco descartável.

```bash
export ADMIN_DATABASE_URL="postgres://postgres@127.0.0.1:5432/postgres"
```

---

## Convenções deste código

| Assunto | Convenção |
|---|---|
| Dinheiro | centavos inteiros (`price_cents`), nunca float |
| Data/hora no banco | `timestamptz`, sempre UTC |
| Data/hora no domínio | minutos locais desde a meia-noite; conversão só em `zone.ts` |
| Intervalo | semiaberto `[início, fim)` — encostar não é sobrepor |
| Id público | UUID/ULID, nunca sequencial |
| Telefone | E.164 normalizado, chave de deduplicação |
| Slug | permanente; renomear adiciona em `tenant_slugs`, nunca substitui |
| Status de cancelamento | `cancelled_customer` ≠ `cancelled_business` — só o primeiro pune o cliente |
| Sessão do cliente no navegador | cookie `httpOnly`, um por barbearia no nome **e** no caminho |
| Permissão exibida na tela | sai da mesma função que a API aplica — nunca recalculada na view |

---

## Ao começar um bloco

1. Leia a seção correspondente em `docs/spec/` — a SPEC é o contrato.
2. Confirme quais defeitos de `SPEC.md §2.2` o bloco resolve.
3. Escreva o teste da regra antes ou junto do código.
4. Ao terminar, percorra o Definition of Done item por item.
5. Commit descrevendo **a decisão**, não o arquivo alterado.
