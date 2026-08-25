import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { falhasDoPortaoDeSeguranca } from './verificar-portao-seguranca.mjs';
const fontes={workflow:readFileSync('.github/workflows/portao.yml','utf8'),verify:readFileSync('scripts/verify.sh','utf8'),gitignore:readFileSync('.gitignore','utf8'),dependabot:readFileSync('.github/dependabot.yml','utf8')};
test('portão atual exige scans de segurança',()=>assert.deepEqual(falhasDoPortaoDeSeguranca(fontes),[]));
const muts=[
 ['histórico',{workflow:fontes.workflow.replace('fetch-depth: 0','fetch-depth: 1')}],
 ['secret scan',{workflow:fontes.workflow.replace('node scripts/verificar-segredos.mjs --history','echo sem-scan')}],
 ['audit',{workflow:fontes.workflow.replace('pnpm audit --audit-level high','echo sem-audit')}],
 ['audit não bloqueante',{workflow:fontes.workflow.replace('run: pnpm audit --audit-level high','continue-on-error: true\n        run: pnpm audit --audit-level high')}],
 ['env ignore',{gitignore:fontes.gitignore.replace('.env.*','# removido')}],
 ['dependabot',{dependabot:fontes.dependabot.replace('package-ecosystem: npm','package-ecosystem: removido')}],
];
for(const [nome,alteracao] of muts)test(`detecta regressão: ${nome}`,()=>assert.ok(falhasDoPortaoDeSeguranca({...fontes,...alteracao}).length>0));
