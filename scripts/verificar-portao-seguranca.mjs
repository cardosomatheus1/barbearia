#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ler = (p) => readFileSync(resolve(raiz,p),'utf8');

export function falhasDoPortaoDeSeguranca(fontes={}) {
  const workflow = fontes.workflow ?? ler('.github/workflows/portao.yml');
  const verify = fontes.verify ?? ler('scripts/verify.sh');
  const gitignore = fontes.gitignore ?? ler('.gitignore');
  const dependabot = fontes.dependabot ?? ler('.github/dependabot.yml');
  const falhas=[];
  if (!workflow.includes('fetch-depth: 0')) falhas.push('CI não baixa histórico completo para secret scan');
  if (!workflow.includes('node scripts/verificar-segredos.mjs --history')) falhas.push('CI não faz secret scan do histórico');
  const blocoAudit = workflow.match(/- name: varredura de dependências[\s\S]*?(?=\n\s*- name:|\n\s{2}\w|$)/)?.[0] ?? '';
  if (!blocoAudit.includes('pnpm audit --audit-level high')) falhas.push('CI não executa audit high');
  if (/continue-on-error:\s*true/.test(blocoAudit)) falhas.push('dependency audit não bloqueia o portão');
  if (!gitignore.includes('.env.*') || !gitignore.includes('!.env.example')) falhas.push('.gitignore não protege arquivos env mantendo exemplo');
  if (!verify.includes('verificar-segredos.mjs')) falhas.push('verify local não inclui secret scan atual');
  if (!verify.includes('verificar-sql-seguro.mjs')) falhas.push('verify não inclui guarda de SQL seguro');
  if (!verify.includes('verificar-bot-protection')) falhas.push('verify não inclui guarda anti-bot');
  if (!dependabot.includes('package-ecosystem: npm') || !dependabot.includes('package-ecosystem: github-actions')) falhas.push('Dependabot não cobre pacotes e GitHub Actions');
  return falhas;
}
const direto=process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href;
if(direto){const f=falhasDoPortaoDeSeguranca();if(f.length){console.error(f.map(x=>`FAIL: ${x}`).join('\n'));process.exitCode=1}else console.log('portão de segurança: OK')}
