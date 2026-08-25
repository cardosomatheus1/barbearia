#!/usr/bin/env node
/** R12: smoke estrutural dos cinco percursos. Não é teste de usabilidade. */
import { readFileSync } from 'node:fs'; import { dirname,join } from 'node:path'; import { fileURLToPath } from 'node:url';
const raiz=process.env['R12_RAIZ']??join(dirname(fileURLToPath(import.meta.url)),'..'); const problemas=[]; const f=(p)=>readFileSync(join(raiz,p),'utf8');
const clientes=f('apps/web/src/app/admin/clientes/page.tsx');
const ficha=f('apps/web/src/app/admin/cliente/[id]/page.tsx');
const comp=f('apps/web/src/app/admin/cliente/[id]/componentes.tsx');
const hoje=f('apps/web/src/app/admin/dia/page.tsx');
const painel=f('apps/web/src/app/admin/painel/page.tsx');
const recorder=f('scripts/r12-usabilidade.mjs');
const doc=f('docs/usabilidade/r12.md');
const check=(ok,msg)=>{if(!ok)problemas.push(msg)};
check(/buscar|Busca/i.test(clientes)&&/\/admin\/cliente\//.test(clientes),'tarefa 1 perdeu busca/porta de cliente');
check(/>Agendar<\/a>/.test(ficha)&&/\/admin\/dia\/marcar\?c=/.test(ficha),'tarefa 2 perdeu ação contextual Agendar');
check(/chave: 'financeiro', rotulo: 'Financeiro'/.test(ficha)&&/hidden={aba !== 'financeiro'}/.test(ficha)&&/Fiado/.test(comp)&&/saldoCents/.test(comp),'tarefa 3 perdeu dívida na aba Financeiro');
check(/function ProximoCliente/.test(hoje)&&/>Próximo</.test(hoje),'tarefa 4 perdeu destaque do próximo cliente');
check(/faturados/.test(painel)&&/faturamentoCents/.test(painel),'tarefa 5 perdeu faturamento no painel');
for(const id of ['achar-cliente','agendar-cliente','ver-divida','proximo-atendimento','faturamento-hoje']) check(recorder.includes(`id: '${id}'`),`cronômetro perdeu tarefa ${id}`);
check(/linha de base anterior a V1\/V5\/V11 não foi cronometrada/.test(doc),'R12 deixou de registrar que o baseline original é irrecuperável');
check(/pendente de campo/.test(doc),'R12 está fingindo que a validação humana já aconteceu');
if(problemas.length){console.error(`R12: ${problemas.length} problema(s)\n`);for(const p of problemas)console.error(`  - ${p}`);process.exit(1)}
console.log('R12: 5 percursos disponíveis; instrumento pronto; validação humana permanece pendente de campo');
