"""Resume logs concluídos sem copiar payloads ou configuração privada."""
from pathlib import Path
import hashlib, json, re, sys

root = Path(__file__).resolve().parents[1]
runtime = Path('/home/ec2-user/codex-tmp/barbearia-audit-runtime')
evidencias = root / 'output/EVIDENCIAS_CORRECOES_PRE_GO_LIVE'
versao = sys.argv[1] if len(sys.argv) > 1 else 'v6'
assert re.fullmatch(r'v[1-9][0-9]*', versao)
registro = json.loads((evidencias/f'regressao-final-{versao}.json').read_text())
fonte = json.loads((evidencias/f'verify-fiscal-baileys-stripe-{versao}-fonte.json').read_text())
assert fonte['fonte_estavel'], 'Não consolidar como fonte final uma execução instável'

def limpar(texto):
    return re.sub(r'\x1b\[[0-9;]*[a-zA-Z]', '', texto)

geral = limpar((runtime/f'regressao-final-{versao}.raw.log').read_text())
preliminar, final = geral.split('==> typecheck, builds e suítes (em paralelo)', 1)
padrao = r'^==> (.+)\n    (ok|FALHOU)\s*$'
nomes = re.findall(padrao, final, re.M)
arquivos = sorted((runtime/f'verify-fiscal-baileys-stripe-{versao}-stages').glob('[0-9]*.log'))
assert len(nomes) == len(arquivos), 'Etapas e logs não correspondem'
etapas = []
for i, (arquivo, (nome, status)) in enumerate(zip(arquivos, nomes)):
    assert int(arquivo.stem) == i
    dados = arquivo.read_bytes()
    texto = limpar(dados.decode(errors='replace'))
    vitest = []
    for linha in texto.splitlines():
        if re.match(r'^\s*Tests\s+', linha):
            contagens = {situacao: int(n) for n, situacao in re.findall(r'(\d+) (passed|failed|skipped|todo)', linha)}
            assert contagens, 'Resumo Vitest não reconhecido'
            vitest.append(contagens)
    tap = {k: sum(map(int, re.findall(r'^# '+k+r' (\d+)\s*$', texto, re.M)))
           for k in ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']}
    dotnet = [{'failed': int(f), 'passed': int(p), 'skipped': int(s), 'tests': int(t)} for f, p, s, t in re.findall(r'Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)', texto)]
    etapas.append({'indice': i, 'nome': nome, 'resultado': status,
        'log_sha256': hashlib.sha256(dados).hexdigest(), 'vitest': vitest,
        'tap': tap if tap['tests'] else None, 'dotnet': dotnet})

total_vitest = {k: sum(c.get(k, 0) for e in etapas for c in e['vitest'])
                for k in ['passed', 'failed', 'skipped', 'todo']}
total_tap = {k: sum(e['tap'][k] for e in etapas if e['tap'])
             for k in ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']}
total_dotnet = {k: sum(c.get(k, 0) for e in etapas for c in e['dotnet']) for k in ['tests', 'passed', 'failed', 'skipped']}
resultado = {'comando': registro['command'], 'inicio_utc': registro['started_utc'],
    'duracao_segundos': registro['duration_seconds'], 'exit_code': registro['exit_code'],
    'fonte_estavel': True, 'fonte_sha256': fonte['depois']['sha256_conjunto'],
    'guardas_iniciais': [{'nome': n, 'resultado': s} for n, s in re.findall(padrao, preliminar, re.M)],
    'etapas': etapas, 'total_vitest': total_vitest, 'total_tap': total_tap, 'total_dotnet': total_dotnet,
    'observacao': 'Contagens dos resumos dos runners. Não somam asserts SQL nem scripts sem resumo numérico. Logs completos preservados no runtime privado; este resumo não copia entradas nem payloads.'}
(evidencias/f'regressao-final-{versao}-resumo.json').write_text(json.dumps(resultado, indent=2, ensure_ascii=False)+'\n')
print(json.dumps({k: v for k, v in resultado.items() if k not in ['etapas', 'guardas_iniciais']}, ensure_ascii=False))
print(json.dumps({'etapas': len(etapas), 'guardas_iniciais': len(resultado['guardas_iniciais'])}))
