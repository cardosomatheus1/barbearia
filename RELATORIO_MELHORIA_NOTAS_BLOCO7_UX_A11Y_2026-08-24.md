# Barberdock — melhoria de notas — Bloco 7: UX, acessibilidade e densidade operacional

**Data:** 24/08/2026  
**Base:** versão cumulativa após Bloco 6 + Super Copy + imagem editorial no CTA final.

## Objetivo

Atacar pontos que ainda seguravam UX/visual sem inventar feature nova: custo de navegação por teclado, comportamento da busca global como modal, densidade do fechamento de Comanda e semântica das fotos da ficha do cliente.

## Mudanças aplicadas

### 1. Skip-link global no painel

O `Casco` do admin passou a usar o `SkipLink` do pacote UI.

- destino: `#conteudo-principal`;
- área de trabalho recebe `tabIndex={-1}` para aceitar foco programático;
- quem usa teclado pode pular o trilho, contexto e navegação repetitiva em toda tela.

Arquivos:

- `apps/web/src/app/admin/casco.tsx`

### 2. Busca global com comportamento modal completo

A busca já se declarava `role="dialog"`/`aria-modal`, mas não tinha ciclo de foco completo.

Agora:

- guarda o elemento que estava em foco antes de abrir;
- foca o campo de busca na abertura;
- fecha com `Escape` de qualquer ponto do modal;
- prende `Tab` e `Shift+Tab` dentro do diálogo;
- restaura o foco para a origem ao fechar;
- bloqueia rolagem da página atrás do modal;
- gatilho expõe `aria-expanded` e `aria-controls`;
- resultados, botão de fechar e campo têm indicação de foco visível;
- gatilho e fechar respeitam o alvo de toque do produto.

Arquivos:

- `apps/web/src/app/admin/busca-global.tsx`
- `apps/web/src/app/admin/busca-global.module.css`

### 3. Comanda com revelação progressiva no pagamento

Antes, o formulário `Receber` desenhava três pares `Como + Quanto` de uma vez, mesmo quando a grande maioria das vendas usa uma única forma.

Agora:

- uma forma de pagamento continua visível por padrão;
- segunda e terceira formas ficam dentro de `Dividir em mais formas`;
- os nomes dos campos (`forma0..2`, `valor0..2`) e o contrato enviado ao domínio foram preservados;
- nenhuma regra de fechamento, fiado, fidelidade, pacote, troco ou idempotência foi alterada.

Arquivos:

- `apps/web/src/app/admin/comanda/[id]/page.tsx`
- `apps/web/src/app/styles/30-admin-scheduling.css`

### 4. Fotos da ficha com alternativa textual

As fotos de antes/depois deixaram de usar `alt=""`.

Agora a alternativa usa:

1. a legenda cadastrada, quando existe;
2. fallback `Foto antes/depois do atendimento`.

Arquivo:

- `apps/web/src/app/admin/cliente/[id]/componentes.tsx`

## Guarda permanente criada

Novos arquivos:

- `scripts/verificar-a11y-ux.mjs`
- `scripts/verificar-a11y-ux.test.mjs`

A guarda cobra:

- skip-link e alvo focalizável;
- modal com Escape/Tab/Shift+Tab/restauração de foco;
- foco visual na busca;
- alvo de toque do gatilho;
- pagamento progressivo na Comanda;
- alternativa textual das fotos.

**Teste negativo:** 5/5 mutações deliberadas foram detectadas.

O `scripts/verify.sh` foi atualizado para incluir este portão.

## Validação executada

### Guardas autônomos

- **36/36 verificadores `verificar-*.mjs` aplicáveis: OK**.
- `verificar-r11-modulos.test.mjs`: não executou por depender de `vitest`, ausente neste runtime. Não foi falha do código.

Entre os verdes:

- V2 ficha do cliente;
- V7/V8/V9 visual estrutural;
- V11 busca global;
- R12 instrumento de usabilidade;
- percurso financeiro E2E estrutural + 4/4 testes negativos;
- auditoria profunda/ofensiva;
- rotas internas;
- R8 comercial;
- R9 mídia;
- módulos Comanda/Comissão/Fiscal/WhatsApp/Booking.

### TypeScript

Transpilação TypeScript/TSX dos arquivos alterados:

- `casco.tsx` ✅
- `busca-global.tsx` ✅
- `comanda/[id]/page.tsx` ✅
- `cliente/[id]/componentes.tsx` ✅

`verify.sh`: sintaxe shell ✅.

## Impacto esperado nas notas

Este bloco não fecha V8 humano e não substitui R12, mas melhora pontos verificáveis antes do piloto.

Estimativa conservadora:

- **UX operacional:** ~9,0 → **9,1–9,2**;
- **Design/qualidade visual percebida:** ~8,8/9,0 → **~9,0–9,1** quando combinado com a nova landing;
- **Testabilidade:** mantém **~9,7/9,8** com uma nova guarda negativa permanente;
- **Simplicidade:** ~8,7 → **~8,9**, principalmente pelo fechamento de Comanda menos denso;
- **Acessibilidade:** passa a ter um portão explícito, em vez de depender apenas de convenções dispersas.

## Limite desta rodada

Não houve renderização humana de todas as telas neste runtime. V8 global continua corretamente pendente de inspeção visual real, e R12 continua dependendo de pessoas reais. Banco/E2E completo também continua condicionado ao PostgreSQL 16.
