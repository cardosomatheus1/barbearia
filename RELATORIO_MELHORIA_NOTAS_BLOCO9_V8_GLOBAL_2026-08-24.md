# Barberdock — Bloco 9 — V8 técnico global

**Data:** 24/08/2026  
**Base cumulativa:** Bloco 8 + landing Super Copy/imagem + Blocos 1–7

## Objetivo

Aumentar a cobertura objetiva de UX/visual sem fingir que inspeção estática substitui revisão humana. O bloco atua em três frentes: acessibilidade de controles nativos, alvo de toque na Agenda e auditoria técnica global das superfícies.

## Correções aplicadas

### 1. Foco visível em `<summary>`

O anel global de foco do design system cobria links, botões, campos e elementos com `tabindex`, mas não incluía `summary`. O seletor gerado passou a incluir `summary`, cobrindo as dezenas de dobras nativas usadas no produto.

### 2. Ações da Agenda com alvo de 44 px

O menu `•••` dos cartões de horário tinha 28×28 px. Agora usa `var(--size-touch)` nas duas dimensões, e o cartão reserva espaço lateral suficiente para o alvo.

O botão `Remover` dentro de um bloqueio curto da régua também podia aparecer com apenas 28 px. A régua agora segue o mesmo princípio já usado para horários livres: se a escala temporal não comporta 44 px, o bloco fica informativo e a ação continua disponível na lista de bloqueios; quando a ação aparece, usa 44 px.

### 3. V8 estático global

Novo verificador `scripts/verificar-v8-estatico-global.mjs` percorre **97 arquivos TSX** e rejeita, entre outros:

- imagem sem `alt`;
- `target="_blank"` sem `noopener`;
- `tabIndex` positivo;
- `div`/`span` com clique sem semântica nativa;
- `outline: none` não auditado;
- botão fora do design system/ exceções conhecidas;
- `summary` sem contrato auditável;
- tabela de dados sem recipiente horizontal local;
- regressão dos alvos de toque da Agenda.

A guarda teve **8/8 mutações negativas detectadas**.

### 4. V8 técnico em runtime dentro de `conferir-telas.mjs`

A conferência de telas agora contém uma auditoria objetiva em **1280 px e 360 px**. Quando executada no ambiente com Playwright + PostgreSQL, cada superfície verifica:

- overflow horizontal do documento;
- quantidade de H1 visível;
- imagem sem alt ou quebrada;
- input/select/textarea sem rótulo;
- ação sem nome acessível básico;
- alvo autônomo abaixo de 44 px;
- tabela larga sem `.ui-scroll-x`.

Além das áreas com pergunta de banco, todas as portas visíveis do dono passam pela auditoria técnica usando o próprio menu como fonte, evitando uma lista paralela de telas.

## Validação desta rodada

- verificadores Node/autônomos: **42 aprovados, 0 falhas**;
- 1 teste não executado: depende de `vitest`, ausente neste runtime;
- V8 estático: **97 TSX aprovados**;
- mutações negativas V8 estático: **8/8**;
- mutações negativas A11Y/UX: **10/10**;
- sintaxe de `conferir-telas.mjs`: OK;
- sintaxe TypeScript/TSX de `apps/web/src/app`: **133/133 arquivos**;
- sintaxe de `packages/ui/src/tokens/css.ts`: OK;
- `scripts/verify.sh`: `bash -n` OK.

## Limite que permanece

Este bloco **não fecha o V8 humano**. A nova auditoria runtime também ainda não foi executada neste ambiente porque a conferência depende de Playwright, aplicação publicada/local funcional e PostgreSQL/`psql`. Ela está implementada e protegida por guardas, mas a evidência visual humana global permanece externa.

## Efeito esperado na avaliação

- UX/A11Y técnica: melhora real, especialmente navegação por teclado e Agenda;
- testabilidade visual: sobe porque V8 agora tem uma camada global automática, e não só contratos nas telas-chave;
- design visual: pequeno ganho objetivo, mas a nota final continua limitada pela revisão humana global.
