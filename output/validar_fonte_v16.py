"""Executa as provas restantes em série após a regressão, somente em ambiente local."""
from pathlib import Path
import json, subprocess, time
from inventario_correcao import identidade_da_fonte

root = Path(__file__).resolve().parents[1]
evidencias = root / 'output/EVIDENCIAS_CORRECOES_PRE_GO_LIVE'
wrapper = '/home/ec2-user/codex-tmp/barbearia-audit-tools/run-repair.py'
fonte = identidade_da_fonte()
limite = time.monotonic() + 7200
registro = evidencias / 'regressao-final-v16.json'
while not registro.exists():
    if time.monotonic() > limite:
        raise SystemExit('Regressão não terminou dentro da janela de acompanhamento.')
    time.sleep(5)
assert json.loads(registro.read_text())['exit_code'] == 0, 'Regressão reprovada: não seguir automaticamente.'
prova = json.loads((evidencias/'verify-fiscal-baileys-stripe-v16-fonte.json').read_text())
assert prova['fonte_estavel'] and prova['depois'] == fonte, 'Fonte divergente da regressão.'
subprocess.run(['python3', 'output/consolidar_verify_final.py', 'v16'], cwd=root, check=True)

etapas = [
    ('docker-imagem-fonte-v16', ['env', 'DOCKER_HOST=unix:///tmp/barbearia-docker-run/docker.sock', 'DOCKER_CONFIG=/home/ec2-user/codex-tmp/barbearia-audit-tools/docker-config', 'DOCKER_BUILDKIT=0', '/home/ec2-user/codex-tmp/barbearia-audit-tools/docker/docker', 'build', '-t', 'barbearia-auditoria:20260910', '.']),
    ('docker-compose-fonte-v16', ['python3', 'output/prova_docker_compose.py']),
    ('meta-percurso-fonte-v16', ['python3', 'output/prova_meta_navegador.py']),
    ('meta-coexistencia-fonte-v16', ['env', 'META_ENSAIO_MODO=coexistencia', 'python3', 'output/prova_meta_navegador.py']),
    ('baileys-percurso-fonte-v16', ['python3', 'output/prova_baileys_revisao.py']),
    ('baileys-worker-fonte-v16', ['python3', 'output/prova_baileys_worker_navegador.py']),
    ('stripe-percurso-fonte-v16', ['python3', 'output/prova_stripe_navegador.py']),
    ('consentimento-percurso-fonte-v16', ['python3', 'output/prova_consentimento_navegador.py']),
    ('operacao-percursos-fonte-v16', ['python3', 'output/prova_operacao_navegador.py']),
    ('manual-prints-fonte-v16', ['python3', 'output/prova_manual_navegador.py']),
    ('fiscal-medicao-fonte-v16', ['env', 'FISCAL_MEDIR=1', 'python3', 'output/prova_fiscal_navegador.py']),
    ('medicao-fonte-v16', ['env', 'MEDICAO_MANTER_BANCO=1', 'MEDICAO_DB_NAME=barbearia_audit_medicao_v16',
        'MEDICAO_PRINTS='+str(root/'output/PRINTS_CORRECOES_PRE_GO_LIVE'), 'bash', 'scripts/medicao.sh']),
    ('cliente-percurso-fonte-v16', ['env', 'MEDICAO_DB_NAME=barbearia_audit_medicao_v16', 'python3', 'output/prova_pilha_complementar.py']),
    ('proxy-real-fonte-v16', ['env', 'MEDICAO_DB_NAME=barbearia_audit_medicao_v16', 'python3', 'output/prova_proxy_corrigido.py']),
    ('proxy-fiscal-log-fonte-v16', ['python3', 'output/prova_log_fiscal_proxy.py']),
    ('conferidores-fonte-v16', ['python3', 'output/prova_conferidores_demo.py']),
    ('instalacao-limpa-fonte-v16', ['python3', 'output/prova_instalacao_limpa.py']),
    ('restauracao-fonte-v16', ['bash', 'scripts/ensaio-de-restauracao.sh', 'barbearia_audit_medicao_v16']),
    ('rollback-fonte-v16', ['env', 'ENSAIO_ROLLBACK_DB=barbearia_audit_rollback_v16', 'bash', 'scripts/ensaio-de-rollback.sh']),
    ('backup-cifrado-fonte-v16', ['env', 'BACKUP_ENSAIO_DB=barbearia_audit_medicao_v16', 'python3', 'output/prova_backup_cifrado.py']),
    ('core-tokyo-fonte-v16', ['env', 'TZ=Asia/Tokyo', 'pnpm', '--filter', '@barbearia/core', 'test']),
    ('segredos-historico-fonte-v16', ['node', 'scripts/verificar-segredos.mjs', '--history']),
    ('dependencias-fonte-v16', ['pnpm', 'audit']),
]
resultados = []
for nome, comando in etapas:
    assert identidade_da_fonte() == fonte, 'Fonte alterada: interromper provas da v16.'
    print('Iniciando '+nome, flush=True)
    r = subprocess.run(['python3', wrapper, nome, *comando], cwd=root)
    resultados.append({'nome': nome, 'exit_code': r.returncode})
    (evidencias/'validacoes-fonte-v16.json').write_text(json.dumps({
        'fonte_sha256': fonte['sha256_conjunto'], 'etapas': resultados,
        'concluidas': len(resultados), 'previstas': len(etapas)}, indent=2)+'\n')
    if r.returncode:
        raise SystemExit(r.returncode)
assert identidade_da_fonte() == fonte
print('Provas complementares concluídas; fonte estável.', flush=True)
