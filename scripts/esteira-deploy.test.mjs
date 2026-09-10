import test from 'node:test';
import assert from 'node:assert/strict';
import { verificarEsteira } from '../deploy/verificar-esteira.mjs';
const sha = 'a'.repeat(40);
const run = { id: 100, head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', run_attempt: 2 };
const jobs = ['pnpm verify', 'pilha, navegador e cargas'].map((name) => ({ name, head_sha: sha, status: 'completed', conclusion: 'success' }));
function verificar({ runs = [run], finalRuns = runs, lista = jobs, current = run, paginar = false } = {}) {
  let leituras = 0;
  return verificarEsteira({ api: 'https://github.example', sha, branch: 'main', buscar: async (input) => {
    const url = new URL(input);
    let data;
    if (url.pathname.endsWith('/runs') && url.pathname.includes('/workflows/')) {
      const encontrados = leituras++ === 0 ? runs : finalRuns;
      data = { workflow_runs: encontrados, total_count: encontrados.length };
    }
    else if (url.pathname.endsWith('/jobs')) {
      data = paginar ? { jobs: url.searchParams.get('page') === '1' ? [lista[0]] : [lista[1]], total_count: 2 }
        : { jobs: lista, total_count: lista.length };
    } else data = current;
    return Response.json(data);
  } });
}
test('aprova somente os dois jobs no SHA solicitado, inclusive em páginas distintas', async () => {
  assert.equal(await verificar({ paginar: true }), sha);
});
test('recusa job ausente, skipped, neutral, falho, pendente e SHA diferente', async () => {
  for (const patch of [{ conclusion: 'skipped' }, { conclusion: 'neutral' }, { conclusion: 'failure' },
    { status: 'in_progress' }, { head_sha: 'b'.repeat(40) }]) {
    await assert.rejects(verificar({ lista: [jobs[0], { ...jobs[1], ...patch }] }));
  }
  await assert.rejects(verificar({ lista: [jobs[0]] }));
  await assert.rejects(verificar({ lista: [] }));
});
test('verde antigo não encobre execução nova ou reexecução durante consulta', async () => {
  await assert.rejects(verificar({ runs: [run, { ...run, id: 101, status: 'in_progress' }] }));
  await assert.rejects(verificar({ current: { ...run, run_attempt: 3 } }));
  await assert.rejects(verificar({ finalRuns: [run, { ...run, id: 101, status: 'in_progress' }] }));
});
