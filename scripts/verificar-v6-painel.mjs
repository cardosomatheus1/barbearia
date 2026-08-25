#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { lerCssDoApp } from './css-do-app.mjs';
const pagina=readFileSync('apps/web/src/app/admin/painel/page.tsx','utf8');
const css=lerCssDoApp();
const falhas=[]; const exigir=(c,m)=>{if(!c)falhas.push(m)};
exigir(pagina.includes("? valor : 'dia'"),'Hoje deixou de ser o período padrão do dono');
const ordem=['Como estamos hoje','painel-agenda','painel-equipe','painel-atencao','painel-acoes'];
let anterior=-1;for(const marco of ordem){const i=pagina.indexOf(marco);exigir(i>=0,`marco ausente: ${marco}`);if(i>=0){exigir(i>anterior,`narrativa fora de ordem em ${marco}`);anterior=i;}}
exigir(pagina.includes('const folga = Math.max(0, 100 - ocupacao)'),'capacidade livre não é derivada da ocupação');
exigir(pagina.includes("mediaEquipe - menor.ocupacao >= 15"),'alerta de equipe não tem piso de relevância');
exigir(pagina.includes('const referenciaDoPeriodo = dias !== null') && pagina.includes('const periodoTexto = dias !== null') && pagina.includes('const tituloPeriodo = dias !== null'), 'dias customizados buscam um período mas rotulam outro');
exigir(!pagina.includes('Últimas 24 horas') && !pagina.includes('nas últimas 24 horas'), 'dias=1 é dia-calendário e voltou a ser rotulado como 24 horas rolantes');
exigir(pagina.includes("dias === 1 ? 'Como estamos hoje'"), 'dias=1 não está rotulado como hoje');
exigir(pagina.includes('insightsDoPainel(token)'),'ações deixaram de usar insights existentes');
exigir(pagina.includes('oportunidades.map'),'ações de impacto não estão renderizadas');
exigir(!pagina.includes('<GraficoFaturamento dinheiro={dadosDinheiro} periodo={periodo} />'),'gráfico voltou a competir com a narrativa principal');
exigir(css.includes('.painel-v6__numero-principal'),'número principal não tem hierarquia visual');
exigir(css.includes('.painel-v6__ocupacao'),'capacidade não tem representação visual');
exigir(/@media (?:\(min-width: 0px\) and )?\(max-width: 767px\)/.test(css),'painel V6 não tem adaptação mobile');
if(falhas.length){console.error(`V6 reprovado (${falhas.length})`);for(const f of falhas)console.error('- '+f);process.exit(1)}
console.log('V6 ok: resultado → agenda → equipe → atenção → ação, com Hoje como padrão.');
