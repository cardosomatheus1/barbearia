import { createRequire } from 'node:module';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const atual = process.argv.includes('--atual');
const require = createRequire(resolve(root, 'apps/api/package.json'));
const ts = require('typescript');
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (['node_modules','dist','.next','.git'].includes(e.name)) return [];
    const p=resolve(dir,e.name); return e.isDirectory()?files(p):[p];
  });
}
function decorators(node) {
  return (ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : []).map(d=>{
    const exp=d.expression;
    return ts.isCallExpression(exp)?{name:exp.expression.getText(),args:exp.arguments.map(a=>a.getText())}:{name:exp.getText(),args:[]};
  });
}
const routes=[];
for (const path of files(resolve(root,'apps/api/src')).filter(p=>p.endsWith('.controller.ts'))) {
 const source=ts.createSourceFile(path,readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true);
 for (const klass of source.statements.filter(ts.isClassDeclaration)) {
  const kd=decorators(klass); const controller=kd.find(d=>d.name==='Controller'); if (!controller) continue;
  const prefix=(controller.args[0]??'').replace(/^['"]|['"]$/g,'');
  for (const method of klass.members.filter(ts.isMethodDeclaration)) {
   const md=decorators(method);const route=md.find(d=>['Get','Post','Put','Patch','Delete','Head','Options','All'].includes(d.name)); if(!route)continue;
   const suffix=(route.args[0]??'').replace(/^['"]|['"]$/g,'');
   const permission=md.find(d=>d.name==='Exige')??kd.find(d=>d.name==='Exige');
   routes.push({file:relative(root,path),line:source.getLineAndCharacterOfPosition(method.getStart()).line+1,controller:klass.name?.text,handler:method.name.getText(),verb:route.name.toUpperCase(),path:'/'+[prefix,suffix].filter(Boolean).join('/'),guards:[...kd,...md].filter(d=>d.name==='UseGuards').flatMap(d=>d.args),permission:permission?.args??null,feature:(md.find(d=>d.name==='Recurso')??kd.find(d=>d.name==='Recurso'))?.args??[],proof_status:'Inventariado; correlacionar com evidências, não implica rota testada'});
  }
 }
}
const pages=files(resolve(root,'apps/web/src/app')).filter(p=>p.endsWith('/page.tsx')).map(p=>relative(root,p));
const packages=['apps','packages'].flatMap(dir=>readdirSync(resolve(root,dir)).filter(name=>{try{return !!readFileSync(resolve(root,dir,name,'package.json'));}catch{return false;}}).map(name=>{const p=JSON.parse(readFileSync(resolve(root,dir,name,'package.json'),'utf8'));return {path:`${dir}/${name}`,name:p.name,dependencies:p.dependencies??{},test:p.scripts?.test??null};}));
const migrations=files(resolve(root,'packages/db/migrations')).filter(p=>p.endsWith('.sql')).map(p=>relative(root,p));
const inventory={commit:'3d90fc62de2947fda05aed32407d5a2f2852340b',routes,pages,packages,migrations};
if (atual) inventory.estado = 'Fonte de trabalho não commitada; a base não representa as alterações locais';
writeFileSync(resolve(root,atual ? 'output/INVENTARIO_CORRECOES_PRE_GO_LIVE.json' : 'output/INVENTARIO_PRE_GO_LIVE.json'),JSON.stringify(inventory,null,2)+'\n');
const quote=v=>'"'+String(v??'').replaceAll('"','""')+'"';
writeFileSync(resolve(root,atual ? 'output/INVENTARIO_ROTAS_CORRECOES.csv' : 'output/INVENTARIO_ROTAS.csv'),[['verbo','rota','arquivo','linha','guards','permissoes','recurso','estado'],...routes.map(r=>[r.verb,r.path,r.file,r.line,r.guards.join(';'),(r.permission??[]).join(';'),r.feature.join(';'),r.proof_status])].map(row=>row.map(quote).join(',')).join('\n')+'\n');
console.log(JSON.stringify({routes:routes.length,write_routes:routes.filter(r=>['POST','PUT','PATCH','DELETE'].includes(r.verb)).length,controller_classes:new Set(routes.map(r=>r.controller)).size,pages:pages.length,packages:packages.length,migrations:migrations.length}));
