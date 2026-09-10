"""Portable reproduction of the audit's two-stage-at-a-time verify scheduler.

Requires a disposable localhost PostgreSQL cluster and the repository's normal
dependencies. Executes the original commands; does not modify product files.
"""
from pathlib import Path
from urllib.parse import urlparse
import os, shlex, subprocess, tempfile

root=Path(__file__).resolve().parents[1]
assert urlparse(os.environ.get('ADMIN_DATABASE_URL','')).hostname in ['127.0.0.1','localhost'], 'Use an isolated local database'
body=(root/'scripts/verify.sh').read_text()
body=body.replace('cd "$(dirname "$0")/.."','cd '+shlex.quote(str(root)),1)
needle='  nomes+=("$nome")\n'
assert body.count(needle)==1
body=body.replace(needle,needle+'  if (( ${#pids[@]} % 2 == 0 )); then colher; fi\n',1)
env=dict(os.environ,VITEST_MAX_THREADS='1',VITEST_MIN_THREADS='1',VITEST_MAX_FORKS='1',VITEST_MIN_FORKS='1',npm_config_workspace_concurrency='1')
with tempfile.TemporaryDirectory(prefix='barbearia-audit-verify-') as directory:
    script=Path(directory)/'verify-controlled.sh';script.write_text(body)
    result=subprocess.run(['bash',str(script)],cwd=root,env=env)
raise SystemExit(result.returncode)
