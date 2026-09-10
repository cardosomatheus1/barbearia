"""Executa os conferidores oficiais contra a semente que eles esperam.

Banco novo local e descartável; sem worker para não despachar webhooks da
semente. Logs de preparação, que contêm senha sintética, ficam privados.
"""
from pathlib import Path
from urllib.parse import quote, urlparse
import os, secrets, subprocess, time, urllib.request, uuid

root = Path(__file__).resolve().parents[1]
runtime = Path('/home/ec2-user/codex-tmp/barbearia-audit-runtime')
env = dict(os.environ)
admin = env['ADMIN_DATABASE_URL']
assert urlparse(admin).hostname == '127.0.0.1'
db = 'barbearia_conferencia_' + uuid.uuid4().hex[:10]
base = admin.rsplit('/', 1)[0]
senha = secrets.token_urlsafe(24)
env.update({'DATABASE_URL': 'postgres://barbearia_app:' + quote(env['APP_DB_PASSWORD'], safe='') + '@127.0.0.1:5432/' + db,
    'DEMO_DATABASE_URL': base+'/'+db, 'API_URL': 'http://127.0.0.1:3490', 'WEB_URL': 'http://127.0.0.1:3491', 'PORT': '3490',
    'FISCAL_MODO': 'fake', 'COMANDA_PSP_MODO': 'fake', 'PSP_MODO': 'fake', 'WHATSAPP_MODO': 'nenhum', 'NODE_ENV': 'test',
    'MEDICAO_SENHA': senha, 'SEMENTE_SENHA': senha, 'RATE_LIMIT_SHORT': '100000', 'RATE_LIMIT_LONG': '100000'})
processes = []; logs = []
subprocess.run(['psql', admin, '-X', '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE DATABASE '+db], check=True, stdout=subprocess.DEVNULL)
try:
    subprocess.run(['node', 'packages/db/scripts/migrate.mjs'], cwd=root,
        env={**env, 'DATABASE_URL': base+'/'+db}, check=True)
    for name, args, cwd in [('api', ['node', 'apps/api/dist/main.js'], root),
        ('web', ['node', str(root/'apps/web/node_modules/next/dist/bin/next'), 'start', '-p', '3491', '-H', '127.0.0.1'], root/'apps/web')]:
        log=(runtime/('conferencia-'+name+'.raw.log')).open('w'); logs.append(log)
        processes.append(subprocess.Popen(args, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT))
    for _ in range(100):
        try:
            with urllib.request.urlopen(env['API_URL']+'/health/pronto', timeout=2), urllib.request.urlopen(env['WEB_URL'], timeout=2): break
        except Exception: time.sleep(.3)
        assert all(p.poll() is None for p in processes), 'Pilha encerrou na partida'
    else: raise RuntimeError('Pilha de conferência não ficou pronta')
    with (runtime/'conferencia-semente.raw.log').open('w') as privado:
        semeadura=subprocess.run(['node', 'scripts/semear-demo.mjs'], cwd=root,
            env={**env, 'ADMIN_DATABASE_URL': base+'/'+db}, stdout=privado, stderr=subprocess.STDOUT)
    assert semeadura.returncode == 0, 'Preparação da demonstração falhou; consultar log privado sem expor credenciais'
    print('Base de demonstração criada pela semente oficial, sem provedores reais.', flush=True)
    resultados=[]
    for script in ['scripts/conferir-numeros.mjs', 'scripts/conferir-telas.mjs']:
        resultados.append(subprocess.run(['node', script], cwd=root, env=env).returncode)
    assert resultados == [0, 0], 'Conferidores: '+str(resultados)
finally:
    for p in processes: p.terminate()
    for p in processes:
        try: p.wait(timeout=10)
        except subprocess.TimeoutExpired: p.kill(); p.wait()
    for log in logs: log.close()
    subprocess.run(['psql', admin, '-X', '-v', 'ON_ERROR_STOP=1', '-c', 'DROP DATABASE '+db+' WITH (FORCE)'], check=True, stdout=subprocess.DEVNULL)
