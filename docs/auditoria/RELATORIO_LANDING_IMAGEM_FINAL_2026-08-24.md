# Barberdock — imagem editorial no CTA final da landing

**Data:** 24/08/2026  
**Base:** `barberdock-super-copy-landing-2026-08-24.zip`

## Decisão aplicada

A imagem gerada **não** foi colocada no hero.

Motivo: a dobra principal já mostra o produto em funcionamento, e isso é mais valioso comercialmente do que uma foto conceitual. A imagem editorial foi aplicada apenas na **chamada final** da landing, onde ela reforça a sensação de colocar o sistema para funcionar na própria barbearia sem competir com os screenshots reais.

## Alterações

- inclusão do asset `apps/web/public/landing/cta-final-barbershop.webp`;
- conversão para **WebP** com tamanho final **1600×900**;
- peso final do asset: **89.024 bytes**;
- reestruturação da seção final para usar:
  - imagem de fundo editorial;
  - gradiente/overlay para preservar leitura da copy;
  - kicker contextual;
  - CTA preservado;
- manutenção do posicionamento do produto no hero e das telas reais como prova principal.

## Trecho afetado

- `apps/web/src/app/page.tsx`
- `apps/web/src/app/styles/50-marketing-site.css`
- `apps/web/public/landing/cta-final-barbershop.webp`

## Validação executada

- `node scripts/verificar-r8-comercial.mjs` ✅
- `node scripts/verificar-r9-midia.mjs` ✅
- `node scripts/verificar-r6-promessas.mjs` ✅
- `node scripts/verificar-v789-visual.mjs` ✅
- `node scripts/verificar-r5-ilha.mjs` ✅

## Avaliação

A intervenção melhora o fechamento da landing e adiciona atmosfera premium sem reduzir a credibilidade da página. O uso ficou **cirúrgico**: uma única imagem editorial, abaixo da dobra, com função de reforço emocional do CTA final.
