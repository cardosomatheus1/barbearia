# Auditoria de regressão final — Barberdock

Data: 2026-08-23

## Escopo

Revisão profunda da versão acumulada após R7, V0, V1, V3, V4, V5, V10, R5,
V11, V2, V6, V7/V8/V9, R9, R10, R11, R6, R8 e instrumentação do R12.

O objetivo desta rodada foi procurar regressões que as guardas de cada bloco
poderiam não enxergar, principalmente nas partes que não puderam passar pelo
`pnpm verify` completo neste ambiente.

## Defeitos encontrados e corrigidos

1. **Fotos em multiunidade** — `getPhotoTargets()` lia a primeira unidade do
   tenant, enquanto upload/remoção gravavam na unidade atual. Em filial isso
   podia exibir estado da matriz e, ao substituir a capa, tentar apagar o arquivo
   anterior da matriz. A leitura e a equipe agora são recortadas por
   `locationId`; atualização de profissional também exige a mesma unidade.

2. **Upload de 1–3 MB bloqueado antes da API** — a UI/API aceitavam até 3 MB,
   mas o upload atravessa Server Action do Next, cujo limite padrão é 1 MB. O
   `bodySizeLimit` foi elevado para 4 MB (margem do multipart); a API continua
   impondo o teto real de 3 MB.

3. **Painel com `?dias=N` rotulado como Hoje** — a janela customizada era usada
   na consulta, mas título e textos de faltas continuavam derivados do seletor
   `periodo`. Agora `dias` governa também a narrativa visível.

4. **Ficha perdia a aba após ações e carregava dados desnecessários** — ações de
   fidelidade/fiado/sinal/assinatura voltavam para Visão geral, e as quatro abas
   buscavam praticamente todos os enriquecimentos. Cada aba agora busca apenas
   os dados que usa e as ações retornam à aba correspondente.

5. **Crash de runtime nas abas da ficha** — após o recorte de carga, fora de
   Visão geral `consentimentos` é `null`, mas o JSX ainda avaliava
   `consentimentos.ok` dentro de uma seção apenas `hidden`. `hidden` não impede
   avaliação dos filhos. As leituras agora usam guarda nula e o portão V2 cobra
   esse contrato.

## Verificações executadas sem dependências externas

- 736 arquivos TS/TSX analisados pelo parser TypeScript: **0 erro de sintaxe**.
- 2.622 imports locais/aliases resolvidos: **0 caminho quebrado**.
- 7.215 imports nomeados conferidos: **0 símbolo local ausente**.
- 87 páginas/route handlers do App Router contra referências literais
  `/admin/...`: **0 rota quebrada**.
- Rotas administrativas com decoradores HTTP revisadas: as únicas sem
  `@Exige` são `signup` e `login`, que são as portas públicas de autenticação.
- Todos os scripts `verificar-*.mjs` principais: **verdes**.
- Testes Node sem Vitest disponíveis (matriz, CSS, R6, R8, R12): **verdes**.
- `next.config.mjs`: sintaxe válida.
- Todos os scripts `.mjs`: sintaxe válida.
- `deploy/backup.sh`: sintaxe Bash válida.
- `docker-compose.yml` e `deploy/compose.yml`: YAML válido.
- R11: 154 Server Actions preservadas; fachadas continuam sendo o ponto público.
- Helpers duplicados nos 6 módulos de actions foram comparados e estão
  byte-equivalentes hoje; continuam sendo dívida de manutenção, não divergência
  funcional atual.

## Cobertura adicionada para o que foi encontrado

- R9 agora reprova perda do recorte por unidade e retorno ao limite padrão da
  Server Action.
- Foi acrescentado teste de integração futuro para provar que capa/equipe da
  matriz não aparecem na filial.
- V2 agora reprova acesso não protegido a consentimentos fora de Visão geral e
  perda dos redirects por aba.
- V6 reprova rotulagem incorreta quando a janela vem de `?dias=`.
- O `verify` ganhou uma guarda barata de rotas internas literais.

## O que esta auditoria NÃO consegue provar neste ambiente

Não foi possível executar a suíte completa com dependências reais porque este
ambiente não possui `pnpm`, `node_modules` nem PostgreSQL/`pg_isready`, e não
consegue baixar os pacotes. Portanto continuam pendentes de um ambiente normal:

- `pnpm install --frozen-lockfile`;
- typecheck semântico completo (`tsc` com todas as dependências);
- suítes Vitest que importam os pacotes reais;
- migrations/RLS e E2E contra PostgreSQL;
- `next build` e orçamento real dos chunks;
- teste humano de campo do R12.

A ausência dessas execuções não é tratada como aprovação. A versão auditada
reduz fortemente o risco por análise estrutural e por guardas, mas o Definition
of Done integral continua exigindo o `pnpm verify` em infraestrutura completa.
