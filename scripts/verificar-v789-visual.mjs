#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { lerCssDoApp } from './css-do-app.mjs';

const secoes = readFileSync('apps/web/src/app/admin/secoes.ts', 'utf8');
const css = lerCssDoApp();
const hoje = readFileSync('apps/web/src/app/admin/dia/page.tsx', 'utf8');
const painel = readFileSync('apps/web/src/app/admin/painel/page.tsx', 'utf8');
const cliente = readFileSync('apps/web/src/app/admin/cliente/[id]/page.tsx', 'utf8');
const agenda = readFileSync('apps/web/src/app/admin/agenda/page.tsx', 'utf8');
const meuDia = readFileSync('apps/web/src/app/admin/meu-dia/page.tsx', 'utf8');
const vocabulario = readFileSync('packages/core/src/vocabulario.ts', 'utf8');
const adminShell = readFileSync('apps/web/src/app/styles/60-admin-shell.css', 'utf8');
const marketing = readFileSync('apps/web/src/app/styles/50-marketing-site.css', 'utf8');
const primitives = readFileSync('apps/web/src/app/styles/70-admin-primitives.css', 'utf8');
const plataforma = readFileSync('apps/web/src/app/styles/80-platform-admin.css', 'utf8');
const dashboard = readFileSync('apps/web/src/app/styles/90-business-dashboard.css', 'utf8');
const booking = readFileSync('apps/web/src/app/styles/00-public-booking.css', 'utf8');

const falhas = [];
const exigir = (condicao, mensagem) => { if (!condicao) falhas.push(mensagem); };

// V7 — cada seção declara um contrato visual na mesma fonte da navegação.
const declaracoes = [...secoes.matchAll(/secao: '([^']+)',\s*molde: '([^']+)'/g)];
exigir(declaracoes.length === 45, `V7 esperava 45 seções com molde; encontrou ${declaracoes.length}`);
const permitidos = new Set(['operacional', 'cadastro', 'gestao', 'configuracao', 'excecao']);
for (const [, secao, molde] of declaracoes) {
  exigir(permitidos.has(molde), `V7: ${secao} usa molde desconhecido ${molde}`);
}
exigir(secoes.includes("readonly 'data-molde': MoldeDePagina"), 'V7: secao() deixou de levar data-molde para o DOM');
exigir(secoes.includes("'data-molde': molde"), 'V7: data-molde não sai do registro');
exigir(css.includes("[data-molde='operacional']"), 'V7: molde operacional não tem contrato de layout');
exigir(css.includes("[data-molde='cadastro']"), 'V7: molde cadastro não tem contrato de layout');
exigir(css.includes("[data-molde='gestao']"), 'V7: molde gestão não tem contrato de layout');
exigir(css.includes("[data-molde='configuracao']"), 'V7: molde configuração não tem contrato de layout');
for (const match of secoes.matchAll(/molde: 'excecao'/g)) {
  const trecho = secoes.slice(match.index, match.index + 300);
  exigir(/excecaoDeMolde:\s*'[^']{8,}'/.test(trecho), 'V7: exceção de molde sem justificativa escrita');
}

// V8 — hierarquia explícita nas superfícies de maior frequência; as demais
// herdam o contrato estrutural do molde V7. Não fingimos que um atributo em
// cada nó seria uma auditoria visual de 45 telas.
for (const [nome, fonte] of [['Hoje', hoje], ['Painel', painel], ['Cliente', cliente]]) {
  exigir(fonte.includes('data-nivel="primario"'), `V8: ${nome} não declara nível primário`);
  exigir(fonte.includes('data-nivel="contexto"'), `V8: ${nome} não declara nível de contexto`);
  exigir(fonte.includes('data-nivel="detalhe"'), `V8: ${nome} não declara nível de detalhe`);
}
exigir(css.includes('.hoje-proximo {\n  border: 0;'), 'V8: próximo cliente voltou a ser cartão cercado');
exigir(css.includes("[data-molde='configuracao'] .painel__grupo"), 'V8: configuração não usa agrupamento por espaço/régua');
exigir(css.includes("[data-molde='cadastro'] .item-cadastro"), 'V8: cadastro não recebeu tratamento de lista');

// V9 — uma fonte única para o significado de estado, azul fora de status.
const tonsEsperados = {
  pending: 'neutral', confirmed: 'success', checked_in: 'warning', waiting: 'warning',
  in_progress: 'neutral', completed: 'success', cancelled_customer: 'danger',
  cancelled_business: 'danger', no_show: 'danger', rescheduled: 'neutral',
};
for (const [estado, tom] of Object.entries(tonsEsperados)) {
  exigir(vocabulario.includes(`${estado}: '${tom}'`), `V9: ${estado} deveria ser ${tom}`);
}
for (const classe of ['neutral', 'success', 'warning', 'danger']) {
  exigir(css.includes(`.selo--${classe}`), `V9: CSS não implementa selo ${classe}`);
}
for (const [nome, fonte] of [['Hoje', hoje], ['Agenda', agenda], ['Meu dia', meuDia]]) {
  exigir(fonte.includes('TOM_SEMANTICO_DO_ESTADO'), `V9: ${nome} não usa o mapa semântico compartilhado`);
}
const ultimaRegraAgora = css.slice(css.lastIndexOf('.atendimento--agora'), css.lastIndexOf('.atendimento--agora') + 140);
exigir(ultimaRegraAgora.includes('var(--color-border-strong)'), 'V9: azul voltou a representar "na cadeira"');
const ultimaBarra = css.slice(css.lastIndexOf('.painel-v6__ocupacao > span'), css.lastIndexOf('.painel-v6__ocupacao > span') + 220);
exigir(ultimaBarra.includes('var(--color-text-muted)'), 'V9: barra de dado voltou a usar azul de ação');

// Danger é semântico, nunca navegação nem decoração. Esta é a brecha que a
// primeira guarda deixava passar: estados estavam corretos, mas o menu ativo e
// o herói ainda usavam vermelho como ornamento.
exigir(!adminShell.includes('var(--color-danger)'), 'V9: shell/navegação voltou a usar danger como decoração ou estado ativo');
const hero = marketing.slice(marketing.indexOf('.lp-heroi__titulo'), marketing.indexOf('.lp-heroi__texto'));
exigir(!hero.includes('var(--color-danger)'), 'V9: herói comercial voltou a usar danger como ornamento');
const ambiente = marketing.slice(marketing.indexOf('.lp-ambiente'), marketing.indexOf('.lp-nav'));
exigir(!ambiente.includes('var(--color-danger)'), 'V9: atmosfera da landing voltou a usar danger decorativamente');
const numeroDecorativo = primitives.slice(primitives.indexOf('.numero::after'), primitives.indexOf('.numero > *'));
exigir(!numeroDecorativo.includes('var(--color-danger)'), 'V9: card numérico voltou a usar danger como brilho decorativo');
const periodoAtivo = dashboard.slice(dashboard.indexOf('.painel-periodos .filtro--ativo'), dashboard.indexOf('.painel-resumo'));
exigir(!periodoAtivo.includes('var(--color-danger)'), 'V9: filtro ativo do Painel voltou a misturar danger em navegação');
const faturaAberta = plataforma.match(/\.plano-fatura__estado--open\s*\{[^}]+\}/)?.[0] ?? '';
exigir(faturaAberta.includes('var(--color-warning)'), 'V9: fatura aberta deve usar warning, não danger');
const faturaPaga = plataforma.match(/\.plano-fatura__estado--paid\s*\{[^}]+\}/)?.[0] ?? '';
exigir(faturaPaga.includes('var(--color-success)'), 'V9: fatura paga deve usar success, não cor de ação');
const precoAcima = booking.match(/\.hora__preco--acima\s*\{[^}]+\}/)?.[0] ?? '';
exigir(precoAcima.includes('var(--color-warning)'), 'V9: preço acima da base deve usar warning, não danger');

if (falhas.length) {
  console.error(`V7/V8/V9 reprovados (${falhas.length})`);
  for (const falha of falhas) console.error(`- ${falha}`);
  process.exit(1);
}

console.log(`V7/V9 ok; V8 estrutural ok: ${declaracoes.length} seções sob moldes e níveis explícitos nas telas-chave. Aceitação visual global de V8 continua manual.`);
