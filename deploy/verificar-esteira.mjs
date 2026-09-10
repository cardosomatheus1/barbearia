import { pathToFileURL } from 'node:url';

const REQUIRED = ['pnpm verify', 'pilha, navegador e cargas'];

export async function verificarEsteira({ api, sha, branch, buscar = fetch }) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('SHA inválido');
  const get = async (path) => {
    const response = await buscar(`${api}${path}`, {
      headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error('GitHub indisponível');
    return response.json();
  };
  const pages = async (path, key) => {
    const rows = [];
    for (let page = 1; page <= 100; page += 1) {
      const result = await get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      if (!Array.isArray(result[key]) || !Number.isInteger(result.total_count)) throw new Error('Resposta incompleta');
      rows.push(...result[key]);
      if (rows.length >= result.total_count) return rows;
      if (result[key].length === 0) throw new Error('Paginação incompleta');
    }
    throw new Error('Paginação excedeu o limite');
  };
  const latest = async () => (await pages(`/actions/workflows/portao.yml/runs?head_sha=${sha}&event=push&branch=${encodeURIComponent(branch)}`, 'workflow_runs'))
    .filter((r) => r.head_sha === sha && r.head_branch === branch && r.event === 'push')
    .sort((a, b) => b.id - a.id)[0];
  const run = await latest();
  if (!run || run.status !== 'completed' || run.conclusion !== 'success' || !Number.isInteger(run.run_attempt)) {
    throw new Error('A execução mais recente do portão ainda não aprovou este SHA');
  }
  const jobs = await pages(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs');
  for (const name of REQUIRED) {
    const matches = jobs.filter((job) => job.name === name);
    if (matches.length !== 1 || matches[0].head_sha !== sha ||
      matches[0].status !== 'completed' || matches[0].conclusion !== 'success') {
      throw new Error(`Job obrigatório ausente ou sem sucesso: ${name}`);
    }
  }
  // Uma reexecução começada durante a leitura invalida o veredito anterior.
  const current = await get(`/actions/runs/${run.id}`);
  if (current.head_sha !== sha || current.run_attempt !== run.run_attempt ||
    current.status !== 'completed' || current.conclusion !== 'success') throw new Error('Portão mudou durante a verificação');
  const final = await latest();
  if (!final || final.id !== run.id || final.run_attempt !== run.run_attempt ||
    final.status !== 'completed' || final.conclusion !== 'success') throw new Error('Execução mais recente mudou durante a verificação');
  return sha;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(await verificarEsteira({ api: process.env.REPO_API ?? 'https://api.github.com/repos/cardosomatheus1/barbearia',
      sha: process.argv[2], branch: process.argv[3] }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
