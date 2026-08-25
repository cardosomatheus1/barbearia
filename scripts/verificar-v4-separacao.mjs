import { readFileSync } from 'node:fs';
import { lerCssDoApp } from './css-do-app.mjs';

const secoes = readFileSync('apps/web/src/app/admin/secoes.ts', 'utf8');
const casco = readFileSync('apps/web/src/app/admin/casco.tsx', 'utf8');
const css = lerCssDoApp();

const falhas = [];
const exigir = (condicao, mensagem) => { if (!condicao) falhas.push(mensagem); };

const PRINCIPAIS = ['hoje', 'agenda', 'clientes', 'atendimento', 'financeiro', 'crescimento', 'gestao'];
const CONFIG = [
  '/admin/equipe', '/admin/seguranca', '/admin/chaves', '/admin/webhooks',
  '/admin/lgpd', '/admin/trilha', '/admin/importar', '/admin/plano', '/admin/configuracoes',
];

// O registro precisa ter exatamente um módulo secundário; V4 é peso visual, não uma nova permissão.
exigir((secoes.match(/categoria: 'configuracao'/g) ?? []).length === 1, 'Configurações não é a única área secundária');
for (const id of PRINCIPAIS) {
  const linha = secoes.split('\n').find((item) => item.includes(`id: '${id}'`)) ?? '';
  exigir(Boolean(linha), `área operacional desapareceu: ${id}`);
}

const blocoConfig = secoes.match(/id: 'configuracoes'[\s\S]*?\n  \},\n\] as const/)?.[0] ?? '';
for (const href of CONFIG) {
  exigir(blocoConfig.includes(`href: '${href}'`), `destino de configuração ficou fora do bloco secundário: ${href}`);
}

// O casco desenha grupos diferentes. Uma classe no mesmo fluxo não basta para separar prioridades.
exigir(casco.includes('modulosPrincipais = modulos.filter'), 'casco não separa módulos principais antes de renderizar');
exigir(casco.includes("modulo.categoria !== 'configuracao'"), 'filtro de áreas principais não usa a categoria do registro');
exigir(casco.includes('trilho__grupo--principal'), 'grupo operacional não existe no trilho');
exigir(casco.includes('trilho__grupo--configuracao'), 'grupo de configuração não existe no trilho');
exigir(casco.includes('aria-label="Áreas de trabalho"') && casco.includes('aria-label="Configurações"'), 'separação visual não tem equivalência semântica para leitor de tela');
exigir(casco.includes('trilho__separador'), 'separador semântico/visual sumiu');
exigir(casco.indexOf('trilho__grupo--principal') < casco.indexOf('trilho__grupo--configuracao'), 'Configurações voltou a competir antes das áreas do dia');

// Peso menor, tablet sem rolagem e desktop com configuração no rodapé do trilho.
exigir(css.includes('.trilho__botao--configuracao'), 'Configurações não recebe tratamento visual secundário');
exigir(css.includes('color-mix(in srgb, var(--color-text-muted) 72%, transparent)'), 'Configurações não perdeu peso visual');
exigir(css.includes('@media (min-width: 720px) and (max-width: 1023px)'), 'não existe comportamento específico para tablet');
const tablet = css.match(/@media \(min-width: 720px\) and \(max-width: 1023px\) \{[\s\S]*?\n\}/)?.[0] ?? '';
exigir(tablet.includes('overflow-x: visible'), 'trilho ainda depende de rolagem em tablet');
exigir(tablet.includes('grid-row: 2'), 'Configurações não desce para a faixa secundária no tablet');
exigir(tablet.includes('justify-content: space-between'), 'áreas principais não usam a largura disponível no tablet');

exigir(
  /@media \(min-width: 1024px\) \{[\s\S]*?\.trilho__grupo--configuracao \{[\s\S]{0,180}?margin-top: auto/.test(css),
  'Configurações não fica fisicamente separada na base do trilho desktop',
);

if (falhas.length) {
  console.error(`V4: ${falhas.length} falha(s)`);
  for (const falha of falhas) console.error(`- ${falha}`);
  process.exit(1);
}

console.log('V4: operação e configuração em grupos distintos; tablet sem rolagem estrutural');
