"""Prova de interface em banco novo e isolado; não inicia worker nem chama o fisco."""
from pathlib import Path
from urllib.parse import quote, urlparse
import os, subprocess, time, urllib.request, uuid

root = Path(__file__).resolve().parents[1]
runtime = Path('/home/ec2-user/codex-tmp/barbearia-audit-runtime')
env = dict(os.environ)
admin = env['ADMIN_DATABASE_URL']
assert urlparse(admin).hostname == '127.0.0.1'
db = 'barbearia_nfse_browser_' + uuid.uuid4().hex[:10]
env.update({'DATABASE_URL': 'postgres://barbearia_app:' + quote(env['APP_DB_PASSWORD'], safe='') + '@127.0.0.1:5432/' + db,
    'DEMO_DATABASE_URL': admin.rsplit('/', 1)[0] + '/' + db,
    'API_URL': 'http://127.0.0.1:3470', 'WEB_URL': 'http://127.0.0.1:3471', 'PORT': '3470',
    'FISCAL_MODO': 'nacional', 'FISCAL_SECRET_KEY': __import__('base64').b64encode(os.urandom(32)).decode(),
    'PSP_MODO': 'nenhum', 'WHATSAPP_MODO': 'nenhum', 'NODE_ENV': 'test',
    'RATE_LIMIT_SHORT': '100000', 'RATE_LIMIT_LONG': '100000'})
processes = []; logs = []
subprocess.run(['psql', admin, '-X', '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE DATABASE ' + db], check=True, stdout=subprocess.DEVNULL)
try:
    subprocess.run(['node', 'packages/db/scripts/migrate.mjs'], cwd=root,
        env={**env, 'DATABASE_URL': env['DEMO_DATABASE_URL']}, check=True)
    for name, args, cwd in [('api', ['node', 'apps/api/dist/main.js'], root),
        ('web', ['node', str(root/'apps/web/node_modules/next/dist/bin/next'), 'start', '-p', '3471', '-H', '127.0.0.1'], root/'apps/web')]:
        log = (runtime/('nfse-browser-' + name + '.raw.log')).open('w'); logs.append(log)
        processes.append(subprocess.Popen(args, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT))
    for _ in range(100):
        try:
            with urllib.request.urlopen(env['API_URL']+'/health/pronto', timeout=2), urllib.request.urlopen(env['WEB_URL'], timeout=2): break
        except Exception: time.sleep(.3)
    else: raise RuntimeError('Pilha fiscal local não ficou pronta')
    subprocess.run(['node', 'output/prova_fiscal_navegador.mjs'], cwd=root, env=env, check=True)
finally:
    for p in processes: p.terminate()
    for p in processes:
        try: p.wait(timeout=10)
        except subprocess.TimeoutExpired: p.kill(); p.wait()
    for log in logs: log.close()
    subprocess.run(['psql', admin, '-X', '-v', 'ON_ERROR_STOP=1', '-c', 'DROP DATABASE ' + db + ' WITH (FORCE)'], check=True, stdout=subprocess.DEVNULL)
