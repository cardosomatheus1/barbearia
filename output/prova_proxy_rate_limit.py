"""Use real compiled Web + API to test whether browser IPs survive SSR forwarding."""
from pathlib import Path
from urllib.parse import quote
import os, subprocess, urllib.request, urllib.error, time, json
root=Path(__file__).resolve().parents[1]
runtime=Path('/home/ec2-user/codex-tmp/barbearia-audit-runtime')
env=dict(os.environ)
env.update({'DATABASE_URL':'postgres://barbearia_app:'+quote(env['APP_DB_PASSWORD'],safe='')+'@127.0.0.1:5432/barbearia_audit_independent','API_URL':'http://127.0.0.1:3420','WEB_URL':'http://127.0.0.1:3421','PORT':'3420','RATE_LIMIT_SHORT':'2','RATE_LIMIT_SHORT_TTL_MS':'600000','RATE_LIMIT_LONG':'1000','LOG_REQUISICOES':'sim','FISCAL_MODO':'nenhum'})
def get(url,ip=None):
 try:
  req=urllib.request.Request(url,headers={'x-forwarded-for':ip} if ip else {})
  with urllib.request.urlopen(req,timeout=20) as response:return response.status
 except urllib.error.HTTPError as error:return error.code
api_log=(runtime/'proxy-api.raw.log').open('w');web_log=(runtime/'proxy-web.raw.log').open('w')
api=subprocess.Popen(['node','apps/api/dist/main.js'],cwd=root,env=env,stdout=api_log,stderr=subprocess.STDOUT)
web=subprocess.Popen(['node',str(root/'apps/web/node_modules/next/dist/bin/next'),'start','-p','3421','-H','127.0.0.1'],cwd=root/'apps/web',env=env,stdout=web_log,stderr=subprocess.STDOUT)
try:
 for _ in range(100):
  try:
   if get(env['API_URL']+'/health/pronto')==200 and get(env['WEB_URL']+'/')==200:break
  except (urllib.error.URLError,TimeoutError):pass
  assert api.poll() is None and web.poll() is None,'process exited during startup'
  time.sleep(.2)
 else:raise AssertionError('startup timeout')
 direct_a=[get(env['API_URL']+'/v1/b/audit-direct-a','198.51.100.10') for _ in range(2)]
 direct_b=get(env['API_URL']+'/v1/b/audit-direct-b','198.51.100.20')
 browser=[]
 for index,ip in enumerate(['198.51.100.101','198.51.100.102','198.51.100.103']):
  browser.append({'ip_presented_to_web':ip,'web_status':get(env['WEB_URL']+'/audit-proxy-'+str(index),ip)})
 forwarded_origin=get(env['API_URL']+'/v1/b/audit-proxy-check')
 fresh_direct=get(env['API_URL']+'/v1/b/audit-direct-fresh','198.51.100.200')
 print(json.dumps({'scenario':'Rate limit por IP atravessando SSR','limit_for_reproduction':2,'direct_client_a':direct_a,'direct_client_b':direct_b,'different_browser_clients':browser,'web_server_ip_after_requests':forwarded_origin,'new_direct_client':fresh_direct},ensure_ascii=False))
 assert direct_a==[404,404] and direct_b==404 and fresh_direct==404
 assert forwarded_origin==429
finally:
 for process in [web,api]:
  process.terminate()
 for process in [web,api]:
  try:process.wait(timeout=5)
  except subprocess.TimeoutExpired:process.kill();process.wait()
 api_log.close();web_log.close()
log=(runtime/'proxy-api.raw.log').read_text()
events=[]
for line in log.splitlines():
 try:event=json.loads(line)
 except (json.JSONDecodeError,ValueError):continue
 if 'audit-proxy-' in line:events.append(event)
print(json.dumps({'api_events_for_browser_requests':events},ensure_ascii=False))
