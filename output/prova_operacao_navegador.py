"""Percursos operacionais em banco efêmero, sem provedores externos."""
from pathlib import Path
from urllib.parse import quote, urlparse
import os, subprocess, time, urllib.request, uuid, tempfile

root = Path(__file__).resolve().parents[1]
runtime = Path('/home/ec2-user/codex-tmp/barbearia-audit-runtime')
env = dict(os.environ)
admin = env['ADMIN_DATABASE_URL']
assert urlparse(admin).hostname == '127.0.0.1'
db = 'barbearia_operacao_browser_' + uuid.uuid4().hex[:10]
env.update({'DATABASE_URL': 'postgres://barbearia_app:' + quote(env['APP_DB_PASSWORD'], safe='') + '@127.0.0.1:5432/' + db,
    'DEMO_DATABASE_URL': admin.rsplit('/', 1)[0] + '/' + db,
    'API_URL': 'http://127.0.0.1:3480', 'WEB_URL': 'http://127.0.0.1:3481', 'PORT': '3480',
    'FISCAL_MODO': 'fake', 'PSP_MODO': 'nenhum', 'WHATSAPP_MODO': 'nenhum', 'NODE_ENV': 'test',
    'WORKER_INTERVALO_MS': '250', 'RATE_LIMIT_SHORT': '100000', 'RATE_LIMIT_LONG': '100000'})
processes = []; logs = []
with tempfile.TemporaryDirectory(prefix='operacao-browser-', dir=runtime) as pasta:
    env['OPERACAO_WORKER_LOG'] = str(Path(pasta)/'worker.log')
    subprocess.run(['psql', admin, '-X', '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE DATABASE ' + db], check=True, stdout=subprocess.DEVNULL)
    try:
        subprocess.run(['node', 'packages/db/scripts/migrate.mjs'], cwd=root,
            env={**env, 'DATABASE_URL': env['DEMO_DATABASE_URL']}, check=True)
        for name, args, cwd in [('api', ['node', 'apps/api/dist/main.js'], root),
            ('worker', ['node', 'apps/worker/dist/main.js'], root),
            ('web', ['node', str(root/'apps/web/node_modules/next/dist/bin/next'), 'start', '-p', '3481', '-H', '127.0.0.1'], root/'apps/web')]:
            log = (Path(pasta)/(name+'.log')).open('w'); logs.append(log)
            processes.append(subprocess.Popen(args, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT))
        for _ in range(100):
            try:
                with urllib.request.urlopen(env['API_URL']+'/health/pronto', timeout=2), urllib.request.urlopen(env['WEB_URL'], timeout=2): break
            except Exception: time.sleep(.3)
        else: raise RuntimeError('Pilha operacional não ficou pronta')
        subprocess.run(['node', 'output/prova_operacao_navegador.mjs'], cwd=root, env=env, check=True)
    finally:
        for p in processes: p.terminate()
        for p in processes:
            try: p.wait(timeout=10)
            except subprocess.TimeoutExpired: p.kill(); p.wait()
        for log in logs: log.close()
        subprocess.run(['psql', admin, '-X', '-v', 'ON_ERROR_STOP=1', '-c', 'DROP DATABASE ' + db + ' WITH (FORCE)'], check=True, stdout=subprocess.DEVNULL)
