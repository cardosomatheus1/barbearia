"""Start the compiled local stack against retained synthetic measurement data."""
from pathlib import Path
from urllib.parse import quote
import os, subprocess, sys, time, urllib.request, urllib.error
root=Path(__file__).resolve().parents[1]
runtime=Path('/home/ec2-user/codex-tmp/barbearia-audit-runtime')
env=dict(os.environ)
env.update({'DATABASE_URL':'postgres://barbearia_app:'+quote(env['APP_DB_PASSWORD'],safe='')+'@127.0.0.1:5432/barbearia_audit_medicao','DEMO_DATABASE_URL':env['ADMIN_DATABASE_URL'].rsplit('/',1)[0]+'/barbearia_audit_medicao','API_URL':'http://127.0.0.1:3430','WEB_URL':'http://127.0.0.1:3431','PORT':'3430','RATE_LIMIT_SHORT':'1000000','RATE_LIMIT_LONG':'1000000','FISCAL_MODO':'fake','PSP_MODO':'nenhum','WHATSAPP_MODO':'nenhum'})
processes=[];logs=[]
try:
    for name,args,cwd in [('api',['node','apps/api/dist/main.js'],root),('worker',['node','apps/worker/dist/main.js'],root),('web',['node',str(root/'apps/web/node_modules/next/dist/bin/next'),'start','-p','3431','-H','127.0.0.1'],root/'apps/web')]:
        log=(runtime/('extra-'+name+'.raw.log')).open('w');logs.append(log)
        processes.append(subprocess.Popen(args,cwd=cwd,env=env,stdout=log,stderr=subprocess.STDOUT))
    for _ in range(100):
        try:
            with urllib.request.urlopen(env['API_URL']+'/health/pronto',timeout=2) as a,urllib.request.urlopen(env['WEB_URL']+'/',timeout=2) as w:
                if a.status==200 and w.status==200:break
        except (urllib.error.URLError,TimeoutError):pass
        assert all(p.poll() is None for p in processes),'A stack process stopped'
        time.sleep(.2)
    else:raise AssertionError('Stack readiness timeout')
    commands=[['node','scripts/conferir-numeros.mjs'],['node','scripts/conferir-telas.mjs']] if '--consistency' in sys.argv else [['node','output/prova_cliente_navegador.mjs']]
    results=[]
    for command in commands:
        result=subprocess.run(command,cwd=root,env=env)
        results.append(result.returncode)
    assert all(code==0 for code in results), str(results)
finally:
    for p in processes:p.terminate()
    for p in processes:
        try:p.wait(timeout=5)
        except subprocess.TimeoutExpired:p.kill();p.wait()
    for log in logs:log.close()
