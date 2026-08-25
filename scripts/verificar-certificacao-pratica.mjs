import fs from 'node:fs';

const ler = (arquivo) => fs.readFileSync(arquivo, 'utf8');
const falhas = [];
const exigir = (condicao, mensagem) => { if (!condicao) falhas.push(mensagem); };

const medicao = ler('scripts/medicao.sh');
const carga = ler('scripts/carga-concorrencia-reserva.mjs');
const workflow = ler('.github/workflows/portao.yml');
const goLive = ler('docs/go-live.md');
const deploy = ler('docs/deploy.md');
const roadmap = ler('ROADMAP.md');
const pacote = JSON.parse(ler('package.json'));
const verify = ler('scripts/verify.sh');

const migracoes = fs.readdirSync('packages/db/migrations')
  .filter((nome) => /^\d{4}_.+\.sql$/.test(nome))
  .sort();
const totalMigracoes = migracoes.length;
const head = migracoes.at(-1)?.slice(0, 4);

exigir(
  medicao.includes('nohup node apps/worker/dist/main.js')
    && medicao.includes('"evento":"worker.iniciado"')
    && medicao.includes("printf '\\n\\033[1m==> queda abrupta e retomada do Worker\\033[0m\\n'\nkill -KILL \"$PID_WORKER\"\nwait")
    && medicao.includes('Worker retomado após SIGKILL')
    && medicao.includes('exigir_worker_vivo')
    && medicao.includes('node scripts/carga-concorrencia-reserva.mjs'),
  'medição deixou de subir, observar, derrubar/reiniciar o Worker ou rodar a carga destrutiva',
);

exigir(
  carga.includes('CARGA_RESERVAS_SIMULTANEAS ?? 100')
    && carga.includes('DISPUTANTES < 50')
    && carga.includes('await Promise.all(')
    && carga.includes('vencedoras.length !== 1')
    && carga.includes('conflitos.length !== DISPUTANTES - 1')
    && carga.includes("r.resposta.status === 409")
    && carga.includes('conflito.body?.error?.code')
    && carga.includes("execFileSync('psql'")
    && carga.includes('if (totalNoBanco !== 1) throw new Error')
    && carga.includes('if (!replay.resposta.ok || replay.body?.id !== appointmentId)'),
  'carga destrutiva deixou de provar 1 vencedor, conflitos limpos, idempotência ou estado final no banco',
);

exigir(
  pacote.scripts?.['test:carga-reserva'] === 'node scripts/carga-concorrencia-reserva.mjs',
  'package.json perdeu a porta explícita da carga de reserva',
);

exigir(
  workflow.includes('API, Web e Worker')
    && workflow.includes('run: scripts/medicao.sh'),
  'CI deixou de declarar a pilha completa na medição',
);

exigir(
  goLive.includes(`as ${totalMigracoes} migrações`) || deploy.includes(`as ${totalMigracoes} migrações`),
  `documentação não registra as ${totalMigracoes} migrações atuais`,
);
exigir(
  goLive.includes('Os 10 percursos')
    && goLive.includes('100 reservas no mesmo slot')
    && goLive.includes('Cobertura que ainda falta no navegador')
    && goLive.includes('cancelamento e remarcação pelo cliente')
    && goLive.includes('Fiscal e split')
    && goLive.includes('não possuem provider real'),
  'go-live voltou a usar contagem histórica ou a prometer providers/carga não certificados',
);
exigir(
  deploy.includes(`aplica as ${totalMigracoes} migrações`)
    && roadmap.includes(`as ${totalMigracoes} migrações`),
  'deploy/ROADMAP estão defasados em relação ao head de migração',
);
exigir(head === '0117', 'head inesperado durante a correção da certificação prática');

exigir(
  verify.includes('certificação prática da pilha')
    && verify.includes('node scripts/verificar-certificacao-pratica.mjs')
    && verify.includes('node --test scripts/verificar-certificacao-pratica.test.mjs')
    && verify.includes('node --test scripts/carga-concorrencia-reserva.test.mjs'),
  'verify.sh não protege a certificação prática e sua prova negativa',
);

if (falhas.length > 0) {
  console.error(`certificação prática: ${falhas.length} falha(s)`);
  for (const falha of falhas) console.error(`- ${falha}`);
  process.exit(1);
}

console.log(
  `certificação prática: Worker integrado, carga 100×1, documentação ${totalMigracoes}/${head} e providers honestos`,
);
