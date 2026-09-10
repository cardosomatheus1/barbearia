"""Exercise real Caddy, compiled Next and compiled API using distinct loopback clients."""
from pathlib import Path
from urllib.parse import quote
import os, subprocess, time, json, http.client, secrets, re
root=Path(__file__).resolve().parents[1]
runtime=Path('/home/ec2-user/codex-tmp/barbearia-audit-runtime')
env=dict(os.environ)
database=env.get('MEDICAO_DB_NAME','barbearia_audit_medicao')
assert re.fullmatch(r'barbearia_audit_medicao(?:_v[0-9]+)?',database)
secret=secrets.token_hex(32)
env.update({'DATABASE_URL':'postgres://barbearia_app:'+quote(env['APP_DB_PASSWORD'],safe='')+'@127.0.0.1:5432/'+database,
 'API_URL':'http://127.0.0.1:3420','WEB_URL':'http://127.0.0.1:3421','PORT':'3420','RATE_LIMIT_SHORT':'2',
 'RATE_LIMIT_SHORT_TTL_MS':'600000','RATE_LIMIT_LONG':'1000','LOG_REQUISICOES':'sim','FISCAL_MODO':'nenhum',
 'INTERNAL_PROXY_SECRET':secret,'ACME_EMAIL':'audit@example.com'})
def get(port,path,ip='127.0.0.1',headers=None):
 conn=http.client.HTTPConnection('127.0.0.1',port,timeout=20,source_address=(ip,0))
 try:
  conn.request('GET',path,headers=headers or {});r=conn.getresponse();body=r.read();h=dict(r.getheaders())
  assert secret.encode() not in body and secret not in str(h),'internal credential exposed'
  return r.status
 finally:conn.close()
config=(root/'deploy/Caddyfile').read_text()
config=re.sub(r'www\.\{\$DOMINIO\} \{\n.*?\n\}', '',config,flags=re.S)
config=config.replace('{$DOMINIO} {','http://127.0.0.1:3422 {').replace('api:3000','127.0.0.1:3420').replace('web:3001','127.0.0.1:3421')
config=config.replace('/var/log/caddy/acesso.log',str(runtime/'proxy-caddy-access.raw.log'))
config=config.replace('\n{\n','\n{\n admin off\n',1)
configfile=runtime/'Caddyfile-proxy-audit';configfile.write_text(config)
logs=[];processes=[]
def start(name,cmd,cwd):
 log=(runtime/(name+'.raw.log')).open('w');logs.append(log)
 p=subprocess.Popen(cmd,cwd=cwd,env=env,stdout=log,stderr=subprocess.STDOUT);processes.append(p);return p
try:
 start('proxy-fixed-api',['node','apps/api/dist/main.js'],root)
 start('proxy-fixed-web',['node',str(root/'apps/web/node_modules/next/dist/bin/next'),'start','-p','3421','-H','127.0.0.1'],root/'apps/web')
 start('proxy-fixed-caddy',['/home/ec2-user/codex-tmp/barbearia-audit-tools/caddy','run','--config',str(configfile),'--adapter','caddyfile'],root)
 for _ in range(150):
  try:
   if get(3420,'/health/pronto')==200 and get(3422,'/')==200:break
  except (OSError,TimeoutError):pass
  assert all(p.poll() is None for p in processes),'process exited during startup'
  time.sleep(.2)
 else:raise AssertionError('startup timeout')
 # Forging XFF directly never resets the quota.
 direct=[get(3420,'/v1/b/audit-forged-'+str(i),headers={'x-forwarded-for':'192.0.2.'+str(i)}) for i in range(3)]
 assert direct==[404,404,429],direct
 inicio_ssr=(runtime/'proxy-fixed-api.raw.log').stat().st_size
 browser=[]
 for i in range(4):
  ip='127.0.0.'+str(20+i)
  browser.append(get(3422,'/audit-fixed-proxy-'+str(i),ip,{'x-barberdock-client-ip':'192.0.2.99','x-barberdock-proxy-key':'forged'}))
 assert browser==[404]*4,browser
 # As rotas agora usam o padrão do framework, sem o slug vindo do cliente.
 # Isolar a fase SSR evita confundir suas leituras com as sondas diretas.
 log_ssr=(runtime/'proxy-fixed-api.raw.log').read_bytes()[inicio_ssr:].decode()
 # Direct Caddy -> API also has a separate bucket for each real visitor.
 edge=[]
 for i in range(2):
  statuses=[get(3422,'/api/v1/b/audit-edge-'+str(i), '127.0.0.'+str(40+i)) for _ in range(3)]
  assert statuses==[404,404,429],statuses
  edge.append(statuses)
finally:
 for p in reversed(processes):p.terminate()
 for p in processes:
  try:p.wait(timeout=5)
  except subprocess.TimeoutExpired:p.kill();p.wait()
 for log in logs:log.close()
events=[]
for line in log_ssr.splitlines():
 try:event=json.loads(line)
 except ValueError:continue
 if event.get('rota')=='/v1/b/:slug':events.append(event)
assert len(events)>=4, 'SSR requests were grouped into the server bucket'
assert all(event.get('status')==404 for event in events),events
print(json.dumps({'caddy_next_api':'passed','direct_forged_xff':direct,'distinct_ssr_clients':browser,
 'direct_edge_clients':edge,'ssr_domain_reads':len(events),'internal_credential_exposed':False}))
