#!/usr/bin/env node
/**
 * Cronômetro de campo do R12. Zero dependência npm; roda com Node 22.
 * Não contém automação de navegador porque R12 mede pessoa, não latência.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

export const TAREFAS = Object.freeze([
  { id: 'achar-cliente', texto: 'Encontre o cadastro do João Silva.' },
  { id: 'agendar-cliente', texto: 'Agende o João para amanhã.' },
  { id: 'ver-divida', texto: 'Veja quanto o João está devendo.' },
  { id: 'proximo-atendimento', texto: 'Veja quem é o próximo cliente a ser atendido.' },
  { id: 'faturamento-hoje', texto: 'Veja quanto a casa faturou hoje.' },
]);

const args = process.argv.slice(2);
const comando = args[0] ?? 'ajuda';
const valor = (nome) => { const i=args.indexOf(`--${nome}`); return i>=0 ? args[i+1] : undefined; };
const pasta = process.env['R12_DIR'] ?? join(process.cwd(), 'medicoes/r12');

function mediana(nums) {
  if (!nums.length) return null;
  const a=[...nums].sort((x,y)=>x-y); const m=Math.floor(a.length/2);
  return a.length%2 ? a[m] : (a[m-1]+a[m])/2;
}
const s = (ms) => `${(ms/1000).toFixed(1)}s`;

function validarId(v) {
  return typeof v === 'string' && /^[A-Z0-9_-]{2,24}$/i.test(v) && !/@|\s/.test(v);
}

async function sessao() {
  const checkpoint=valor('checkpoint'); const participante=valor('participante'); const papel=valor('papel');
  if(!checkpoint || !/^[a-z0-9_-]{2,40}$/i.test(checkpoint)) throw new Error('use --checkpoint com um identificador curto, ex.: pos-reorganizacao');
  if(!validarId(participante)) throw new Error('use --participante anônimo, ex.: P01 (sem nome/e-mail)');
  if(!['recepcao','barbeiro','gerente','dono'].includes(papel ?? '')) throw new Error('use --papel recepcao|barbeiro|gerente|dono');
  mkdirSync(pasta,{recursive:true});
  const rl=createInterface({input,output}); const resultados=[];
  output.write(`\nR12 · ${checkpoint} · ${participante} · ${papel}\nSem ensinar o menu. Enter inicia e Enter termina cada tarefa.\n\n`);
  try {
    for (const tarefa of TAREFAS) {
      await rl.question(`TAREFA: ${tarefa.texto}\nPressione Enter para iniciar...`);
      const inicio=performance.now();
      await rl.question('Pressione Enter quando a pessoa terminar ou desistir...');
      const ms=Math.round(performance.now()-inicio);
      const concluiu=(await rl.question('Concluiu sem ajuda? [s/n] ')).trim().toLowerCase()==='s';
      const nota=(await rl.question('Nota curta (opcional): ')).trim().slice(0,300);
      resultados.push({tarefa:tarefa.id,ms,concluiu,nota});
      output.write(`  ${concluiu?'✓':'✗'} ${s(ms)}\n\n`);
    }
  } finally { rl.close(); }
  const registro={versao:1,checkpoint,participante,papel,coletadoEm:new Date().toISOString(),resultados};
  const nome=`${new Date().toISOString().replace(/[:.]/g,'-')}-${checkpoint}-${participante}.json`;
  writeFileSync(join(pasta,nome),JSON.stringify(registro,null,2)+'\n');
  output.write(`Salvo em ${join(pasta,nome)}\n`);
}

function lerRegistros() {
  mkdirSync(pasta,{recursive:true});
  return readdirSync(pasta).filter(x=>x.endsWith('.json')).flatMap((nome)=>{
    try { const d=JSON.parse(readFileSync(join(pasta,nome),'utf8')); return d?.versao===1 ? [d] : []; } catch { return []; }
  });
}

function resumo() {
  const regs=lerRegistros();
  if(!regs.length){ console.log('R12: nenhuma sessão real registrada ainda.'); return; }
  const checkpoints=[...new Set(regs.map(r=>r.checkpoint))];
  for(const cp of checkpoints){
    const grupo=regs.filter(r=>r.checkpoint===cp); console.log(`\n${cp} — ${grupo.length} participante(s)`);
    for(const t of TAREFAS){
      const rs=grupo.flatMap(r=>r.resultados.filter(x=>x.tarefa===t.id)); const ok=rs.filter(x=>x.concluiu); const tempos=ok.map(x=>x.ms);
      const min=tempos.length?Math.min(...tempos):null,max=tempos.length?Math.max(...tempos):null,med=mediana(tempos);
      console.log(`${t.texto.padEnd(48)} ${ok.length}/${rs.length} concluíram` + (med===null?'':` · mediana ${s(med)} · ${s(min)}–${s(max)}`));
    }
  }
}

if(comando==='sessao') await sessao();
else if(comando==='resumo') resumo();
else {
  console.log('uso:\n  node scripts/r12-usabilidade.mjs sessao --checkpoint pos-reorganizacao --participante P01 --papel recepcao\n  node scripts/r12-usabilidade.mjs resumo');
}
