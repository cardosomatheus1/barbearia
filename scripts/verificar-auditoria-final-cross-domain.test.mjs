import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const raiz = process.cwd();
const arquivos = [
  'packages/catalog/src/concorrencia.ts',
  'packages/catalog/src/recursos.ts',
  'packages/catalog/src/equipe.ts',
  'packages/catalog/src/servicos.ts',
  'packages/catalog/src/franquia.ts',
  'packages/scheduling/src/concorrencia.ts',
  'packages/scheduling/src/booking.ts',
  'packages/scheduling/src/fila.ts',
  'packages/scheduling/src/oferta.ts',
  'packages/scheduling/src/dayboard.ts',
  'packages/platform/src/conciliacao.ts',
  'packages/db/migrations/0115_platform_jobs_integracoes.sql',
  ...fs.readdirSync(path.join(raiz, 'packages/db/migrations'))
    .filter((nome) => /^\d{4}_.+\.sql$/.test(nome))
    .map((nome) => `packages/db/migrations/${nome}`),
  'scripts/verify.sh',
  'scripts/verificar-auditoria-final-cross-domain.mjs',
];

function preparar() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'barberdock-final-cross-domain-'));
  for (const arq of new Set(arquivos)) {
    const dst = path.join(tmp, arq);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(raiz, arq), dst);
  }
  return tmp;
}

function mutacao(rel, de, para) {
  const tmp = preparar();
  const alvo = path.join(tmp, rel);
  const antes = fs.readFileSync(alvo, 'utf8');
  assert.ok(antes.includes(de), `fixture não contém mutação: ${de.slice(0, 110)}`);
  fs.writeFileSync(alvo, antes.replace(de, para));
  const r = spawnSync(process.execPath, ['scripts/verificar-auditoria-final-cross-domain.mjs'], {
    cwd: tmp,
    encoding: 'utf8',
  });
  assert.notEqual(r.status, 0, `guarda aceitou regressão em ${rel}`);
}

test('detecta namespace de jornada divergente no Scheduling', () => mutacao(
  'packages/scheduling/src/concorrencia.ts',
  'barberdock:professional-config:${professionalId}',
  'barberdock:scheduling-professional:${professionalId}',
));
test('detecta namespace de recursos divergente no Scheduling', () => mutacao(
  'packages/scheduling/src/concorrencia.ts',
  "${'barberdock:catalog:resources:'} || current_setting('app.tenant_id', true)",
  "${'barberdock:scheduling:resources:'} || current_setting('app.tenant_id', true)",
));
test('detecta criação/hold/remarcação sem lock de recursos', () => mutacao(
  'packages/scheduling/src/booking.ts',
  'await travarConfiguracaoDeRecursos(tx);',
  'await Promise.resolve();',
));
test('detecta walk-in sem lock do profissional', () => mutacao(
  'packages/scheduling/src/fila.ts',
  'await travarConfiguracaoDoProfissional(tx, params.professionalId);',
  'await Promise.resolve();',
));
test('detecta walk-in sem lock de recursos', () => mutacao(
  'packages/scheduling/src/fila.ts',
  'await travarConfiguracaoDeRecursos(tx);',
  'await Promise.resolve();',
));
test('detecta walk-in sem prova de habilidade', () => mutacao(
  'packages/scheduling/src/fila.ts',
  'const profissionalHabilitado = contextoDoDia?.professionals.find',
  'const profissionalHabilitado = [{ id: params.professionalId }].find',
));
test('detecta walk-in sem jornada vigente', () => mutacao(
  'packages/scheduling/src/fila.ts',
  'const jornada = resolveWorkingDay({',
  'const jornada = resolveWorkingDayIgnorada({',
));
test('detecta oferta sem lock do profissional', () => mutacao(
  'packages/scheduling/src/oferta.ts',
  'await travarConfiguracaoDoProfissional(tx, params.professionalId);',
  'await Promise.resolve();',
));
test('detecta oferta sem lock de recursos', () => mutacao(
  'packages/scheduling/src/oferta.ts',
  'await travarConfiguracaoDeRecursos(tx);',
  'await Promise.resolve();',
));
test('detecta oferta sem revalidação de grade', () => mutacao(
  'packages/scheduling/src/oferta.ts',
  'if (!(await vagaAindaExisteParaEntrada(tx, {',
  'if (!(await vagaAntigaAindaPareceLivre(tx, {',
));
test('detecta oferta sem compute da disponibilidade atual', () => mutacao(
  'packages/scheduling/src/oferta.ts',
  'const grade = computeFromContext(context, {',
  'const grade = { slots: [] } /* compute removido */; void context; ({',
));
test('detecta undo_no_show sem lock de recurso', () => mutacao(
  'packages/scheduling/src/dayboard.ts',
  'await travarConfiguracaoDeRecursos(tx);',
  'await Promise.resolve();',
));
test('detecta reader de configuração voltando a lock exclusivo', () => mutacao(
  'packages/scheduling/src/concorrencia.ts',
  'SELECT pg_advisory_xact_lock_shared(',
  'SELECT pg_advisory_xact_lock(',
));
test('detecta booking sem lock de serviços', () => mutacao(
  'packages/scheduling/src/booking.ts',
  'await travarConfiguracaoDeServicos(tx);',
  'await Promise.resolve();',
));
test('detecta update de profissional sem fencing da Agenda', () => mutacao(
  'packages/catalog/src/equipe.ts',
  'await travarConfiguracaoDoProfissional(tx, professionalId);',
  'await Promise.resolve();',
));
test('detecta ativação de profissional sem fencing da Agenda', () => mutacao(
  'packages/catalog/src/equipe.ts',
  'await travarConfiguracaoDoProfissional(tx, params.professionalId);',
  'await Promise.resolve();',
));
test('detecta update de serviço sem lock de catálogo', () => mutacao(
  'packages/catalog/src/servicos.ts',
  "await travarCatalogoDoTenant(tx, 'services');",
  'await Promise.resolve();',
));
test('detecta readoção de franquia sem lock de serviço', () => mutacao(
  'packages/catalog/src/franquia.ts',
  "await travarCatalogoDoTenant(tx, 'services');",
  'await Promise.resolve();',
));
test('detecta PSP separado da transação financeira', () => mutacao(
  'packages/platform/src/conciliacao.ts',
  'pagarFaturaNaTransacao(tx',
  'pagarFatura(',
));
test('detecta estorno sem claim pending -> failed', () => mutacao(
  'packages/platform/src/conciliacao.ts',
  "UPDATE refunds SET status = 'failed'\n           WHERE id = ${lancamento.id}::uuid AND status = 'pending'",
  "UPDATE refunds SET status = 'failed'\n           WHERE id = ${lancamento.id}::uuid",
));
test('detecta perda da FK tenant+endpoint de webhook', () => mutacao(
  'packages/db/migrations/0115_platform_jobs_integracoes.sql',
  'FOREIGN KEY (tenant_id, endpoint_id)',
  'FOREIGN KEY (endpoint_id)',
));
test('detecta auditoria final removida do verify', () => mutacao(
  'scripts/verify.sh',
  'lancar "auditoria Final Cross-Domain" node scripts/verificar-auditoria-final-cross-domain.mjs',
  'echo "auditoria final removida"',
));
