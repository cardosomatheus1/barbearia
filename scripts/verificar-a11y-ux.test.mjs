#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { avaliarA11yUx } from './verificar-a11y-ux.mjs';

const base = {
  casco: readFileSync('apps/web/src/app/admin/casco.tsx', 'utf8'),
  busca: readFileSync('apps/web/src/app/admin/busca-global.tsx', 'utf8'),
  buscaCss: readFileSync('apps/web/src/app/admin/busca-global.module.css', 'utf8'),
  comanda: readFileSync('apps/web/src/app/admin/comanda/[id]/page.tsx', 'utf8'),
  cliente: readFileSync('apps/web/src/app/admin/cliente/[id]/componentes.tsx', 'utf8'),
  primitives: readFileSync('packages/ui/src/components/primitives.tsx', 'utf8'),
  tokensCss: readFileSync('packages/ui/src/tokens/css.ts', 'utf8'),
  agendaCss: readFileSync('apps/web/src/app/styles/120-agenda-timeline.css', 'utf8'),
  agendaPage: readFileSync('apps/web/src/app/admin/agenda/page.tsx', 'utf8'),
  conferirTelas: readFileSync('scripts/conferir-telas.mjs', 'utf8'),
};

assert.deepEqual(avaliarA11yUx(base), []);

const casos = [
  ['skip-link', { ...base, casco: base.casco.replace('<SkipLink targetId="conteudo-principal" />', '') }],
  ['trap de foco', { ...base, busca: base.busca.replace("if (evento.key !== 'Tab') return;", "if (evento.key !== 'F9') return;") }],
  ['foco visível', { ...base, buscaCss: base.buscaCss.replace('.resultado:focus-visible {\n  outline: 2px solid var(--color-accent);', '.resultado:focus-visible {\n  outline: 0;') }],
  ['pagamento progressivo', { ...base, comanda: base.comanda.replace('Dividir em mais formas', 'Mais formas') }],
  ['alt da foto', { ...base, cliente: base.cliente.replace("alt={foto.legenda ?? `Foto ${foto.tipo === 'antes' ? 'antes' : 'depois'} do atendimento`}", 'alt=""') }],
  ['foco de summary', { ...base, tokensCss: base.tokensCss.replace(', summary, [tabindex]', ', [tabindex]') }],
  ['alvo da agenda', { ...base, agendaCss: base.agendaCss.replace('width: var(--size-touch);', 'width: 28px;') }],
  ['bloqueio curto', { ...base, agendaPage: base.agendaPage.replace('const cabeAcao = altura >= 44;', 'const cabeAcao = true;') }],
  ['V8 móvel', { ...base, conferirTelas: base.conferirTelas.replace('auditarSuperficie(page, rota, 360)', 'auditarSuperficie(page, rota, 768)') }],
  ['V8 overflow', { ...base, conferirTelas: base.conferirTelas.replace('overflow horizontal do documento', 'largura extra do documento') }],
];

for (const [nome, fontes] of casos) {
  assert.ok(avaliarA11yUx(fontes).length > 0, `a guarda deveria acusar regressão em ${nome}`);
}

console.log(`${casos.length}/${casos.length} mutações negativas de A11Y/UX detectadas`);
