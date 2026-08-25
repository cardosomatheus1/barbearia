#!/usr/bin/env node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(raiz, 'scripts/verificar-r6-promessas.mjs');
let passou = 0;
function caso(nome, mutar) {
  const temp = mkdtempSync(join(tmpdir(), 'barber-r6-'));
  cpSync(join(raiz, 'ROADMAP.md'), join(temp, 'ROADMAP.md'));
  mutar(join(temp, 'ROADMAP.md'));
  const r = spawnSync(process.execPath, [script], { env: { ...process.env, R6_RAIZ: temp }, encoding: 'utf8' });
  rmSync(temp, { recursive: true, force: true });
  if (r.status === 0) throw new Error(`${nome}: a guarda aceitou a regressão`);
  passou++;
}
caso('arrastar volta ao título', (p) => writeFileSync(p, readFileSync(p,'utf8').replace('Agenda: dia/semana/lista, mover por formulário, bloqueio pontual','Agenda: dia/semana/lista, arrastar, bloqueio pontual')));
caso('staging volta ao título', (p) => writeFileSync(p, readFileSync(p,'utf8').replace('Portão local de qualidade: observabilidade, e2e e carga em `/availability`','CI/CD, staging, observabilidade, e2e, carga em `/availability`')));
caso('fiscal perde ressalva', (p) => writeFileSync(p, readFileSync(p,'utf8').replace('Fiscal: fluxo de NFS-e, cancelamento e Salão-Parceiro; emissor real pendente','Fiscal: NFS-e, cancelamento, Salão-Parceiro')));
caso('split perde provider fake', (p) => writeFileSync(p, readFileSync(p,'utf8').replace('Split: contrato de KYC, liquidação e estorno exercitado pelo provider fake','Split: KYC do profissional, liquidação, estorno')));
console.log(`R6 testes negativos: ${passou}/4`);
