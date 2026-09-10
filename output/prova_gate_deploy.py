"""Exercise the exact embedded CI decision code without invoking deployment."""
from pathlib import Path
import json, re, subprocess
root=Path(__file__).resolve().parents[1]
source=(root/'deploy/auto-atualizar.sh').read_text()
match=re.search(r'check-runs" \| python3 -c \'(.*?)\' 2>/dev/null',source,re.S)
assert match, 'CI decision block not found'
cases={
 'nenhuma_esteira':[],
 'somente_lint_sem_gates_obrigatorios':[{'name':'lint','status':'completed','conclusion':'success'}],
 'verify_e_medicao_pulados':[{'name':'pnpm verify','status':'completed','conclusion':'skipped'},{'name':'pilha, navegador e cargas','status':'completed','conclusion':'skipped'}],
 'gates_executados_com_sucesso':[{'name':'pnpm verify','status':'completed','conclusion':'success'},{'name':'pilha, navegador e cargas','status':'completed','conclusion':'success'}],
}
for name,runs in cases.items():
 result=subprocess.run(['python3','-c',match.group(1)],input=json.dumps({'check_runs':runs}),text=True,capture_output=True,check=True)
 print(json.dumps({'scenario':name,'observed':result.stdout.strip(),'deployment_executed':False},ensure_ascii=False))
 if name in ['somente_lint_sem_gates_obrigatorios','verify_e_medicao_pulados']:assert result.stdout.strip()=='aprovado'
