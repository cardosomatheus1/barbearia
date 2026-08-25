#!/usr/bin/env node
import { cpSync,mkdtempSync,readFileSync,rmSync,writeFileSync,mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join,dirname } from 'node:path'; import { fileURLToPath } from 'node:url'; import { spawnSync } from 'node:child_process';
const raiz=join(dirname(fileURLToPath(import.meta.url)),'..'); const script=join(raiz,'scripts/verificar-r8-comercial.mjs'); let ok=0;
function base(){const t=mkdtempSync(join(tmpdir(),'barber-r8-')); for(const f of ['ROADMAP.md','apps/web/src/app/page.tsx','apps/web/src/app/admin/secoes.ts','apps/web/src/app/admin/assistente/page.tsx','docs/comercial/prontidao.md']){const d=join(t,dirname(f));mkdirSync(d,{recursive:true});cpSync(join(raiz,f),join(t,f));} return t;}
function caso(nome,mut){const t=base();try{mut(t);const r=spawnSync(process.execPath,[script],{env:{...process.env,R8_RAIZ:t},encoding:'utf8'});if(r.status===0)throw new Error(`${nome}: regressão aceita`);ok++;}finally{rmSync(t,{recursive:true,force:true});}}
caso('vende split',t=>{const p=join(t,'apps/web/src/app/page.tsx');writeFileSync(p,readFileSync(p,'utf8')+'\nSplit automático disponível em produção.\n')});
caso('vende NFS-e',t=>{const p=join(t,'apps/web/src/app/page.tsx');writeFileSync(p,readFileSync(p,'utf8')+'\nNFS-e integrada e disponível.\n')});
caso('vende IA mágica',t=>{const p=join(t,'docs/comercial/prontidao.md');writeFileSync(p,readFileSync(p,'utf8')+'\nIA que entende o seu negócio.\n')});
caso('tira ressalva do WhatsApp',t=>{const p=join(t,'apps/web/src/app/page.tsx');const antes=readFileSync(p,'utf8');const depois=antes.replace('Lembretes no WhatsApp, quando o canal está conectado','Lembretes no WhatsApp');if(depois===antes)throw new Error('fixture R8 desatualizada: a ressalva atual do WhatsApp não foi encontrada');writeFileSync(p,depois)});
console.log(`R8 testes negativos: ${ok}/4`);
