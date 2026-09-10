"""Reproduce the return-rate tests with explicit fixture creation time."""
from pathlib import Path
from urllib.parse import quote
import json, os, re, subprocess
root=Path(__file__).resolve().parents[1]
runtime=Path('/home/ec2-user/codex-tmp/barbearia-audit-runtime/return-clock-proof')
runtime.mkdir(exist_ok=True)
link=runtime/'node_modules'
if not link.exists():link.symlink_to(root/'packages/finance/node_modules',target_is_directory=True)
source=root/'packages/finance/src/desempenho.integration.test.ts'
original=source.read_text()
body=re.sub(r"from '(\./[^']+)'",lambda m:"from '"+str(source.parent/m.group(1))+"'",original)
# The fixture says the next appointment was booked on Sep 5, but omitted
# created_at, so PostgreSQL stores the actual day the test is executed.
before='4000, \'${params.status ?? \'completed\'}\')'
after='4000, \'${params.status ?? \'completed\'}\', \'2026-09-05T15:00:00Z\')'
assert before in body
body=body.replace('service_starts_at, service_ends_at, price_cents, status)', 'service_starts_at, service_ends_at, price_cents, status, created_at)').replace(before,after)
(runtime/source.name).write_text(body)
(runtime/'vitest.config.mjs').write_text("export default {test:{include:['*.test.ts'],fileParallelism:false,hookTimeout:60000}};\n")
env=dict(os.environ)
env['SEED_DATABASE_URL']=env['ADMIN_DATABASE_URL'].rsplit('/',1)[0]+'/barbearia_audit_independent'
env['DATABASE_URL']='postgres://barbearia_app:'+quote(env['APP_DB_PASSWORD'],safe='')+'@127.0.0.1:5432/barbearia_audit_independent'
env['APP_DATABASE_URL']=env['DATABASE_URL']
result=subprocess.run(['node',str(root/'packages/finance/node_modules/vitest/vitest.mjs'),'run','-t','quem saiu com o próximo horário marcado|atendimento sem cliente cadastrado'],cwd=runtime,env=env,text=True,capture_output=True)
(runtime/'result.raw.log').write_text(result.stdout+result.stderr)
print(json.dumps({'product_unchanged':True,'original_test_unchanged':source.read_text()==original,'fixture_adjustment':'Explicit created_at=2026-09-05T15:00:00Z in synthetic appointments; no assertion changes','exit_code':result.returncode,'summary':[l for l in result.stdout.splitlines() if re.search(r'Test Files|Tests |Duration',l)]},ensure_ascii=False))
assert result.returncode==0
