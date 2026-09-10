"""Exercise every inventoried guarded route on a local compiled API without credentials."""
from pathlib import Path
from urllib.parse import quote
import csv, json, os, re, subprocess, sys, time, urllib.request, urllib.error

root=Path(__file__).resolve().parents[1]
runtime=Path('/home/ec2-user/codex-tmp/barbearia-audit-runtime')
env=dict(os.environ)
env.update({'DATABASE_URL':'postgres://barbearia_app:'+quote(env['APP_DB_PASSWORD'],safe='')+'@127.0.0.1:5432/barbearia_audit_independent','API_URL':'http://127.0.0.1:3425','PORT':'3425','RATE_LIMIT_SHORT':'1000000','RATE_LIMIT_LONG':'1000000','FISCAL_MODO':'nenhum','PSP_MODO':'nenhum','WHATSAPP_MODO':'nenhum'})
public='--public' in sys.argv
routes=json.loads((root/'output/INVENTARIO_PRE_GO_LIVE.json').read_text())['routes']
def call(method,path):
    request=urllib.request.Request(env['API_URL']+path,method=method,data=b'{}' if method in ['POST','PUT','PATCH','DELETE'] else None,headers={'content-type':'application/json'})
    try:
        with urllib.request.urlopen(request,timeout=15) as response:return response.status,None
    except urllib.error.HTTPError as e:
        try:data=json.loads(e.read());code=data.get('code') or data.get('error',{}).get('code') if isinstance(data.get('error',{}),dict) else data.get('code')
        except (ValueError,AttributeError):code=None
        return e.code,code
log=(runtime/'anonymous-api.raw.log').open('w')
api=subprocess.Popen(['node','apps/api/dist/main.js'],cwd=root,env=env,stdout=log,stderr=subprocess.STDOUT)
results=[]
try:
    for _ in range(100):
        try:
            if call('GET','/health/pronto')[0]==200:break
        except urllib.error.URLError:pass
        assert api.poll() is None,'API exited at startup'
        time.sleep(.2)
    else:raise AssertionError('API startup timeout')
    for route in routes:
        if bool(route['guards']) == public:continue
        path=re.sub(r':([A-Za-z_]+)',lambda m:'audit-inexistente' if m.group(1)=='slug' else '99999999-9999-4999-8999-999999999999',route['path'])
        status,code=call(route['verb'],path)
        results.append({'verbo':route['verb'],'rota':route['path'],'arquivo':route['file'],'linha':route['line'],'guards':';'.join(route['guards']),'status_sem_credencial':status,'codigo':code,'resultado':'recusada' if (status in ([400,401,403,404,422] if public else [401,403]) or (public and (route['path'].startswith('/health') or route['path']=='/v1/marketplace/cidades') and status==200)) else 'investigar'})
finally:
    api.terminate()
    try:api.wait(timeout=5)
    except subprocess.TimeoutExpired:api.kill();api.wait()
    log.close()
with (root/('output/EVIDENCIAS_PRE_GO_LIVE/rotas-publicas.csv' if public else 'output/EVIDENCIAS_PRE_GO_LIVE/rotas-anonimas.csv')).open('w') as f:
    writer=csv.DictWriter(f,fieldnames=list(results[0]));writer.writeheader();writer.writerows(results)
unexpected=[r for r in results if r['resultado']!='recusada']
print(json.dumps({'mode':'public malformed input' if public else 'guarded unauthenticated','routes_exercised':len(results),'write_routes_exercised':sum(r['verbo'] in ['POST','PUT','PATCH','DELETE'] for r in results),'http_status_counts':{str(s):sum(r['status_sem_credencial']==s for r in results) for s in sorted(set(r['status_sem_credencial'] for r in results))},'unexpected':unexpected,'scope':'Anonymous guard boundary only; does not certify authenticated permission, IDOR or business workflows'},ensure_ascii=False))
assert not unexpected
