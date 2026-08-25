# Barberdock — merge consolidado e auditoria de regressão

**Data:** 23/08/2026  
**Base escolhida:** `barberdock-corrigido-auditoria-2026-08-23`  
**Fonte de mudanças adicionais:** `barberdock-auditado-final`  

## 1. Decisão de merge

A versão `barberdock-auditado-final` não foi usada como base porque derivava da linha anterior e reintroduzia correções já fechadas. O merge foi reconstruído sobre a última baseline corrigida e recebeu apenas mudanças novas que continuavam válidas após revisão semântica.

Nenhum arquivo da baseline corrigida foi removido.

## 2. Melhorias da rodada final incorporadas

- recorte da equipe de fotos por `location_id`;
- atualização de foto de profissional também condicionada à unidade ativa;
- `locationId` permanece obrigatório em `getPhotoTargets`, evitando fallback silencioso para a primeira unidade;
- teste de integração multiunidade para capa/equipe adicionado;
- verificador barato de rotas literais do App Router adicionado e ligado ao `verify.sh`;
- chamada redundante do Painel para o período “hoje” removida;
- narrativa do Painel por `?dias=N` preservada, corrigindo `dias=1`: trata-se de um dia-calendário, não de 24 horas rolantes;
- origem da ficha explicitada em Clientes;
- envio avulso de WhatsApp agora transporta e normaliza a origem da ficha no POST;
- documentação do middleware mantida coerente com as ilhas Client Component existentes.

## 3. Correções anteriores preservadas

A consolidação preserva e agora protege cumulativamente:

1. segmento de cliente continua atrás de `customers.view_notes`;
2. filtros VIP/em risco/assinantes recusam acesso sem a permissão de relacionamento;
3. gasto total da ficha vem de todos os pedidos pagos via rota financeira protegida, e não da timeline limitada;
4. “Última visita” deriva de atendimento concluído, não de falta/cancelamento;
5. limpeza física de mídia após commit permanece best-effort, sem falso HTTP 500 depois de o banco já ter sido alterado;
6. conflito triplo de telefone atualiza o nome canônico dos conflitos restantes;
7. Clientes/Meu Dia/Dia permanecem origens fechadas da ficha;
8. ajuste de confiança/sinal entende os caminhos reais enviados pela ficha;
9. WhatsApp avulso preserva a origem durante sucesso e erro;
10. `danger` continua reservado a problema/erro, sem uso decorativo no shell, cards, filtros, estado pago ou preço acima da base;
11. as guardas antigas que protegiam essas correções não foram removidas.

## 4. Novo portão cumulativo

Foi criado:

`scripts/verificar-invariantes-auditoria.mjs`

Ele é executado pelo `scripts/verify.sh` e reprova se uma branch futura remover uma correção crítica junto com a asserção que a protegia. Isso corrige a fragilidade observada na linha `auditado-final`, em que código e guarda regrediram simultaneamente.

## 5. Validação executada

### 5.1 Guardas de produto/regressão

**21/21 guardas executadas e verdes**, incluindo:

- R7/R8/V0/V1/V3/V4/V5/R5/R6;
- lacunas;
- V10/V11/V2/V6/V7-V9/R12/R9/R10/R11;
- verificação de rotas web;
- invariantes cumulativos de auditoria.

A guarda de rotas encontrou **87 páginas/handlers** e validou **469 referências literais `/admin/...`**.

### 5.2 TypeScript/TSX — análise estrutural independente

- **736 arquivos TS/TSX** analisados;
- **0 erro de parse**;
- **3.589 imports internos/aliases** analisados;
- **0 caminho quebrado**;
- **7.221 imports nomeados** conferidos contra exports locais/barrels;
- **0 símbolo local ausente**.

### 5.3 Caso funcional puro reproduzido

O cenário de três linhas com o mesmo telefone foi executado fora da suíte Vitest. Após escolher João como registro canônico, o conflito restante passa a apontar para João. Resultado: **aprovado**.

### 5.4 Sintaxe de arquivos operacionais

- **68 arquivos `.mjs`**: sintaxe válida;
- **29 scripts shell**: `bash -n` válido;
- **44 JSON**: parse válido;
- **6 YAML**: parse válido.

## 6. O que ainda não pode ser declarado como validado

O ambiente continua sem acesso ao registry necessário para o Corepack obter `pnpm@10.33.0`. A tentativa de execução falha em `registry.npmjs.org` (`EAI_AGAIN`). Também não há `node_modules` nem PostgreSQL local configurado para a suíte completa.

Assim, permanecem pendentes de um ambiente conectado/completo:

- `pnpm install --frozen-lockfile`;
- `pnpm verify` integral;
- typecheck semântico com todas as dependências;
- Vitest completo;
- migrations/RLS/PostgreSQL;
- `next build` e medição real de bundle/LCP do R5;
- E2E full stack;
- teste humano R12.

Essas pendências são de **prova de runtime/infraestrutura**, não regressões conhecidas deixadas abertas neste merge.

## 7. Parecer

Todos os defeitos identificados nas duas auditorias estáticas anteriores foram corrigidos ou preservados corretamente no merge consolidado, e cada regressão crítica agora possui uma proteção automática cumulativa.

**Parecer estático/contratual:** aprovado.  
**Parecer full stack/produção:** ainda condicionado ao `pnpm verify`, PostgreSQL, build e testes reais descritos acima.
