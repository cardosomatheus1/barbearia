"""Repair verification: same gate, bounded concurrency, stage logs preserved privately.

Requires a disposable localhost PostgreSQL cluster and the repository's normal
dependencies. Executes the original commands; does not modify product files.
"""
from pathlib import Path
from urllib.parse import urlparse
import os, re, shlex, subprocess, sys, tempfile, json
from inventario_correcao import identidade_da_fonte

root=Path(__file__).resolve().parents[1]
assert urlparse(os.environ.get('ADMIN_DATABASE_URL','')).hostname in ['127.0.0.1','localhost'], 'Use an isolated local database'
body=(root/'scripts/verify.sh').read_text()
body=body.replace('cd "$(dirname "$0")/.."','cd '+shlex.quote(str(root)),1)
needle='  nomes+=("$nome")\n'
assert body.count(needle)==1
# Reutiliza a vaga livre sem aguardar a dupla inteira. Não chama wait -n:
# colher() continua recebendo o status original de todos os processos.
body=body.replace(needle,needle+'  while [ "$(jobs -rp | wc -l)" -ge 2 ]; do sleep 0.1; done\n',1)
label=sys.argv[1] if len(sys.argv)>1 else 'repair'
assert re.fullmatch(r'[a-z0-9_-]+',label)
stage_logs=Path('/home/ec2-user/codex-tmp/barbearia-audit-runtime')/f'verify-{label}-stages'
stage_logs.mkdir(exist_ok=True)
body=body.replace('SAIDA=$(mktemp -d)', 'SAIDA='+shlex.quote(str(stage_logs)),1)
body=body.replace("trap 'rm -rf \"$SAIDA\"' EXIT", ': # repair runner preserves private stage logs',1)
env=dict(os.environ,VITEST_MAX_THREADS='1',VITEST_MIN_THREADS='1',VITEST_MAX_FORKS='1',VITEST_MIN_FORKS='1',npm_config_workspace_concurrency='1')
antes=identidade_da_fonte()
with tempfile.TemporaryDirectory(prefix='barbearia-audit-verify-') as directory:
    script=Path(directory)/'verify-controlled.sh';script.write_text(body)
    result=subprocess.run(['bash',str(script)],cwd=root,env=env)
depois=identidade_da_fonte()
estavel=antes == depois
prova={'fonte_estavel':estavel,'antes':antes,'depois':depois,'exit_code':result.returncode}
(root/'output/EVIDENCIAS_CORRECOES_PRE_GO_LIVE'/f'verify-{label}-fonte.json').write_text(json.dumps(prova,indent=2)+'\n')
print(json.dumps({'fonte_estavel':estavel,'sha256_conjunto':antes['sha256_conjunto']}))
if not estavel: raise SystemExit('Fonte mudou durante a verificação; esta rodada não certifica o estado final.')
raise SystemExit(result.returncode)
