# Política de Autoridade de Decisão — Agente

Este documento define o que o agente decide sozinho e o que exige intervenção humana.
Ele tem precedência sobre o instinto do modelo de pedir confirmação.

Carregado via `@AGENT_AUTHORITY.md` no `CLAUDE.md` da raiz do repositório. As paradas
obrigatórias da seção correspondente são replicadas como regra em
`.claude/settings.json` e hook de `PreToolUse` — este texto é contexto, não trava.

## Regra mestra

Você tem autoridade para decidir. Não pergunte.

Ao encontrar uma escolha não especificada na SPEC:

1. Escolha aplicando os critérios NESTA ORDEM, parando no primeiro que decidir
   a questão:

   a) O que o texto da SPEC determina literalmente.
   b) O que é consistente com o padrão já existente na base — use como
      precedente o módulo equivalente mais recente.
   c) O que for mais reversível: menor custo de mudar depois se a escolha se
      provar errada.
   d) O que exigir menos código.

   Se os quatro critérios empatarem, a escolha é irrelevante por definição.
   Escolha qualquer uma e siga.

2. Registre uma linha em `DECISIONS.md` no formato abaixo.
3. Continue a execução imediatamente.

O critério (b) resolve a maioria dos casos: a resposta quase sempre já existe
em código no repositório. Copiar o padrão vigente é comportamento esperado,
não atalho.

Formato do registro:

```
YYYY-MM-DD | SPEC-XXX | <decisão em uma linha> | <alternativa descartada> | <motivo em ≤15 palavras>
```

Perguntar não é o comportamento seguro. Uma decisão registrada e errada custa uma
revisão de PR; uma execução interrompida custa o ciclo inteiro. Quando estiver em
dúvida entre perguntar e decidir, decida.

Se a SPEC for tão vaga que nem o critério (b) encontra precedente, ainda assim não
pare: implemente a interpretação mais literal do texto da SPEC, marque a linha de
`DECISIONS.md` com o prefixo `REVISAR:` e siga para o próximo item.

## Você decide sozinho — lista não exaustiva

Estes itens NUNCA geram pergunta. Se algo se parece com um destes, decida.

- Nomes de variáveis, funções, classes, arquivos, colunas, índices e constraints
- Estrutura interna de módulo, service, controller, DTO, repositório
- Assinatura de métodos internos e organização de pastas
- Criação de índices não únicos, tipos de coluna, `nullable` vs default
- Formato de mensagens de erro, log e validação
- Escolha de biblioteca já presente no `package.json`
- Escrita, nomeação e ordenação de migrations aditivas
- Cobertura de testes: quais casos escrever, fixtures, factories, mocks
- Refatoração local dentro do escopo da SPEC em execução
- Ordem de execução de subtarefas dentro da SPEC
- Correção de bug encontrado no caminho, se dentro do módulo em edição
- Formatação, lint, imports, tipagem
- Mensagens de commit e descrição do PR

## Você para e pergunta — lista fechada

Esta lista é exaustiva. Nada fora dela justifica parar.

1. **Migration destrutiva** — `DROP`, `TRUNCATE`, remoção ou renomeação de coluna
   com dados, alteração de tipo com perda.
2. **Contrato de API já publicado** — mudança quebrando rota, payload ou resposta
   que já está em uso por cliente externo.
3. **Credenciais e segredos** — qualquer necessidade de chave, token ou variável
   de ambiente que não esteja no `.env.example`.
4. **Tenant real ou produção** — qualquer operação que toque dados de tenant real,
   banco de produção ou o gateway de pagamento em modo live.
5. **Escopo além da SPEC** — o trabalho exige alterar módulo fora do escopo
   declarado da SPEC atual.

Se a parada for necessária, registre o motivo em `DECISIONS.md`, prossiga com o
que for possível sem a resposta, e só então reporte.

## Convenções do projeto

Estas são as respostas para as perguntas que você faria. Consulte aqui antes de
qualquer coisa.

### Estrutura
- NestJS: um módulo por domínio, com `*.module.ts`, `*.controller.ts`,
  `*.service.ts`, `dto/`, `entities/`.
- Lógica de negócio vive no service. Controller só valida entrada e delega.
- Nada de lógica em controller, nada de acesso direto ao banco em controller.

### Banco e multi-tenant
- Toda tabela de domínio carrega discriminador de tenant.
- Toda query de domínio filtra por tenant explicitamente. Sem exceção.
- Toda SPEC que cria tabela exige teste de isolamento de tenant no mesmo PR.
- Migrations são aditivas por padrão. Remoção é operação de duas fases,
  separada em PRs distintos.

### Erros
- Exceções de domínio herdam da classe base do projeto.
- Resposta de erro segue o formato já existente na base. Não invente formato novo;
  copie o do módulo mais recente.

### Testes
- Nenhum PR sem teste do caminho feliz e de pelo menos um caminho de falha.
- Módulo com tenant exige, adicionalmente, teste de vazamento entre tenants.

<!-- Preencher com as convenções que hoje só existem na sua cabeça.
     Cada convenção não escrita aqui vira uma pergunta em runtime. -->

## Critério de conclusão

"Pronto" significa: a suite de testes passa, a migration aplica limpa em banco
efímero, o lint passa, e o PR está aberto. O julgamento é o exit code do CI.

Sua própria avaliação de que o código está correto não é critério de conclusão.
Não declare conclusão sem o CI verde.

## Saída

- Uma SPEC por branch. Nunca commit direto na branch principal.
- `DECISIONS.md` atualizado faz parte do PR.
- O PR descreve o que foi decidido autonomamente, para revisão humana focada.
