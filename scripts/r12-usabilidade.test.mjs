#!/usr/bin/env node
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join,dirname } from 'node:path'; import { fileURLToPath } from 'node:url'; import { spawnSync } from 'node:child_process';
const raiz=join(dirname(fileURLToPath(import.meta.url)),'..'); const script=join(raiz,'scripts/r12-usabilidade.mjs'); const d=mkdtempSync(join(tmpdir(),'r12-'));
const reg=(id,ms)=>({versao:1,checkpoint:'teste',participante:id,papel:'dono',coletadoEm:new Date().toISOString(),resultados:[
 {tarefa:'achar-cliente',ms,concluiu:true,nota:''},{tarefa:'agendar-cliente',ms:ms+1000,concluiu:true,nota:''},{tarefa:'ver-divida',ms:ms+2000,concluiu:true,nota:''},{tarefa:'proximo-atendimento',ms:ms+3000,concluiu:true,nota:''},{tarefa:'faturamento-hoje',ms:ms+4000,concluiu:true,nota:''},]});
writeFileSync(join(d,'a.json'),JSON.stringify(reg('P01',5000))); writeFileSync(join(d,'b.json'),JSON.stringify(reg('P02',7000)));
const r=spawnSync(process.execPath,[script,'resumo'],{env:{...process.env,R12_DIR:d},encoding:'utf8'}); rmSync(d,{recursive:true,force:true});
if(r.status!==0||!r.stdout.includes('2/2 concluíram')||!r.stdout.includes('mediana 6.0s')) throw new Error(`resumo R12 falhou\n${r.stdout}\n${r.stderr}`);
console.log('R12 cronômetro: resumo/mediana ok');
