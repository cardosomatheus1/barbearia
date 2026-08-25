#!/usr/bin/env node
/** R8 — o material comercial não pode ser mais otimista que a matriz. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = process.env['R8_RAIZ'] ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const roadmap = readFileSync(join(raiz, 'ROADMAP.md'), 'utf8');
const problemas = [];
const falhar = (m) => problemas.push(m);

function tabela(fonte, cabecalho) {
  const i = fonte.indexOf(cabecalho); if (i < 0) return [];
  const out=[]; for (const l of fonte.slice(i).split('\n').slice(2)) { if(!l.startsWith('|')) break; out.push(l.split('|').slice(1,-1).map(x=>x.trim())); } return out;
}
const linhas=tabela(roadmap,'| Funcionalidade | Motor | Tela | Integração real | E2E real | Produção | Evidência |');
const estado=new Map(linhas.map(([nome,motor,tela,integracao,e2e,producao])=>[nome,{motor,tela,integracao,e2e,producao}]));

const superficies=['apps/web/src/app/page.tsx','docs/comercial/prontidao.md'];
const promessas=['apps/web/src/app/page.tsx'];
const textos=superficies.map((arquivo)=>({arquivo, texto: existsSync(join(raiz,arquivo)) ? readFileSync(join(raiz,arquivo),'utf8') : ''}));
for (const {arquivo,texto} of textos) if(!texto) falhar(`R8: superfície comercial ausente: ${arquivo}`);

const proibidas=[
  {nome:'Split de pagamento', pads:[/split[^\n]{0,80}(?:dispon[ií]vel|pront[oa]|autom[aá]tico|em produ[cç][aã]o)/i,/repasse autom[aá]tico[^\n]{0,80}profissional/i]},
  {nome:'Fiscal (NFS-e)', pads:[/(?:NFS-e|nota fiscal)[^\n]{0,80}(?:dispon[ií]vel|integrad[ao]|pront[oa]|emitimos|emiss[aã]o real)/i]},
  {nome:'Sinal cobrado online', pads:[/sinal[^\n]{0,80}(?:online|autom[aá]tic)[^\n]{0,60}(?:dispon[ií]vel|pront[oa]|cobramos)/i]},
];
for(const regra of proibidas){
  if(estado.get(regra.nome)?.producao!=='❌') continue;
  for(const {arquivo,texto} of textos.filter((x)=>promessas.includes(x.arquivo))) for(const p of regra.pads){ const m=p.exec(texto); if(m) falhar(`R8: ${arquivo} vende ${regra.nome} apesar de Produção ❌: "${m[0].trim()}"`); }
}

const landing=textos.find((x)=>x.arquivo==='apps/web/src/app/page.tsx')?.texto ?? '';
const canonico=textos.find((x)=>x.arquivo==='docs/comercial/prontidao.md')?.texto ?? '';
for (const {arquivo,texto} of textos) if(/\bIA\b[^\n]{0,100}(?:entende|conhece|pensa)[^\n]{0,80}(?:neg[oó]cio|barbearia)/i.test(texto)) falhar(`R8: ${arquivo} voltou a vender o assistente como IA que entende o negócio`);
if(!/Assistente de gestão/.test(canonico)) falhar('R8: material comercial não registra o nome honesto "Assistente de gestão"');

const secoes=readFileSync(join(raiz,'apps/web/src/app/admin/secoes.ts'),'utf8');
const pagina=readFileSync(join(raiz,'apps/web/src/app/admin/assistente/page.tsx'),'utf8');
if(!/nome: 'Assistente de gestão'/.test(secoes)) falhar('R8: navegação não chama o recurso de Assistente de gestão');
if(!/<h1[^>]*>Assistente de gestão<\/h1>/.test(pagina)) falhar('R8: tela do assistente perdeu o nome Assistente de gestão');
if(!/catálogo fechado de métricas/.test(pagina)) falhar('R8: tela deixou de explicar que o assistente usa catálogo fechado');
if(!/quando o canal está conectado/.test(readFileSync(join(raiz,'apps/web/src/app/page.tsx'),'utf8'))) falhar('R8: landing voltou a prometer WhatsApp sem a condição de canal conectado');

if(problemas.length){ console.error(`R8: ${problemas.length} problema(s)\n`); for(const p of problemas) console.error(`  - ${p}`); process.exit(1); }
console.log(`R8: ${superficies.length} superfície(s) comercial(is) coerentes com a matriz`);
