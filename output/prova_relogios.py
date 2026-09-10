"""Repeat existing tests with current fixture time, without modifying product or assertions."""
from pathlib import Path
from urllib.parse import quote, urlparse
import datetime, json, os, re, subprocess

root=Path(__file__).resolve().parents[1]
runtime=Path('/home/ec2-user/codex-tmp/barbearia-audit-runtime/clock-proof')
runtime.mkdir(exist_ok=True)
assert urlparse(os.environ['ADMIN_DATABASE_URL']).hostname=='127.0.0.1'
now=datetime.datetime.now(datetime.timezone.utc)
tomorrow=(now+datetime.timedelta(days=1)).date().isoformat()
env=dict(os.environ)
env['SEED_DATABASE_URL']=os.environ['ADMIN_DATABASE_URL'].rsplit('/',1)[0]+'/barbearia_audit_independent'
env['DATABASE_URL']='postgres://barbearia_app:'+quote(env['APP_DB_PASSWORD'],safe='')+'@127.0.0.1:5432/barbearia_audit_independent'
env['APP_DATABASE_URL']=env['DATABASE_URL']
results=[]
for package, filename, pattern in [('scheduling','oferta.integration.test.ts',None),('crm','importacao.integration.test.ts','preview abandonado não guarda dado pessoal para sempre')]:
    source=root/'packages'/package/'src'/filename
    dest=runtime/package
    dest.mkdir(exist_ok=True)
    link=dest/'node_modules'
    if not link.exists():link.symlink_to(root/'packages'/package/'node_modules',target_is_directory=True)
    config=dest/'vitest.config.mjs'
    config.write_text("export default {test:{include:['*.test.ts'],fileParallelism:false,hookTimeout:60000}};\n")
    original=source.read_text()
    body=re.sub(r"from '(\./[^']+)'", lambda m:"from '"+str(source.parent/m.group(1))+"'", original)
    if package=='scheduling':
        body=body.replace('2026-09-08',tomorrow).replace('2026-09-07T12:00:00Z',now.isoformat())
    else:
        body=body.replace('2026-08-08T12:00:00Z',now.isoformat())
    (dest/filename).write_text(body)
    args=['node',str(root/'packages'/package/'node_modules/vitest/vitest.mjs'),'run','--config',str(config)]
    if pattern:args+=['-t',pattern]
    result=subprocess.run(args,cwd=dest,env=env,text=True,capture_output=True)
    (runtime/(package+'.raw.log')).write_text(result.stdout+result.stderr)
    summaries=[line for line in result.stdout.splitlines() if re.search(r'Test Files|Tests |Duration',line)]
    record={'package':package,'original_source_unchanged':source.read_text()==original,'adjustment':'Only fixture clock and tomorrow booking dates; same product, test logic and assertions','fixture_now':now.isoformat(),'exit_code':result.returncode,'summary':summaries}
    print(json.dumps(record,ensure_ascii=False))
    results.append(result.returncode)
assert results==[0,0], 'See private per-suite logs for failed controlled clock experiment'
