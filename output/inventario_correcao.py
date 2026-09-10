"""Inventário da fonte e dos testes atuais; preserva inventários anteriores."""
from pathlib import Path
import hashlib, json, re, subprocess

ROOT = Path(__file__).resolve().parents[1]

def caminhos():
    result = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=ROOT)
    return sorted(set(p for p in result.decode().split('\0') if p and not p.startswith('output/')))

def identidade_da_fonte():
    arquivos = {p: hashlib.sha256((ROOT/p).read_bytes()).hexdigest()
                for p in caminhos() if (ROOT/p).is_file()}
    resumo = hashlib.sha256(json.dumps(arquivos, sort_keys=True).encode()).hexdigest()
    return {'base': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
            'sha256_conjunto': resumo, 'arquivos': arquivos,
            'observacao': 'Fonte de trabalho não commitada; output e arquivos ignorados pelo Git excluídos.'}

def inventariar_testes():
    verify = (ROOT/'scripts/verify.sh').read_text()
    inventario = []
    for p in caminhos():
        if not re.search(r'\.(?:test|spec)\.(?:[cm]?[jt]sx?|sql)$', p):
            continue
        if p.startswith('scripts/') or (p.startswith('packages/db/test/') and p.endswith('.mjs')):
            runner = 'scripts/verify.sh'
            incluido = p in verify
        else:
            package_dir = '/'.join(p.split('/')[:2])
            manifest = ROOT/package_dir/'package.json'
            pacote = json.loads(manifest.read_text()) if manifest.exists() else {}
            runner = f"pnpm --filter {pacote.get('name', package_dir)} test"
            if p.endswith('.sql'):
                incluido = package_dir == 'packages/db' and 'test/*.test.sql' in (ROOT/package_dir/'scripts/test.sh').read_text()
            else:
                config = ROOT/package_dir/'vitest.config.ts'
                relativo = p[len(package_dir)+1:]
                # Os pacotes declaram src; API inclui também test; web usa o
                # padrão do Vitest. O inventário não afirma execução por isto.
                incluido = bool(pacote.get('scripts', {}).get('test')) and (
                    (not config.exists()) or
                    (relativo.startswith('src/') and p.endswith(('.test.ts', '.test.tsx'))) or
                    (package_dir == 'apps/api' and relativo.startswith('test/') and p.endswith('.test.ts')))
        inventario.append({'arquivo': p, 'runner': runner, 'incluido_no_portao': incluido})
    return {'arquivos': len(inventario), 'inventario': inventario,
            'sem_runner': [r['arquivo'] for r in inventario if not r['incluido_no_portao']],
            'observacao': 'Inclusão estrutural; resultados de execução ficam nas evidências de cada comando.',
            'ensaios_adicionais': ['scripts/medicao.sh', 'scripts/ensaio-de-rollback.sh',
                'scripts/ensaio-de-restauracao.sh', 'python3 output/prova_backup_cifrado.py',
                'TZ=Asia/Tokyo pnpm --filter @barbearia/core test',
                'node scripts/verificar-segredos.mjs --history', 'pnpm audit',
                'python3 output/prova_instalacao_limpa.py', 'python3 output/prova_baileys_navegador.py',
                'python3 output/prova_baileys_worker_navegador.py',
                'python3 output/prova_stripe_navegador.py', 'python3 output/prova_fiscal_navegador.py',
                'python3 output/prova_proxy_corrigido.py', 'python3 output/prova_log_fiscal_proxy.py',
                'python3 output/prova_conferidores_demo.py', 'python3 output/prova_pilha_complementar.py',
                'python3 output/prova_pilha_complementar.py --consistency']}

if __name__ == '__main__':
    for nome, valor in [('FONTE_CORRECOES_PRE_GO_LIVE', identidade_da_fonte()),
                        ('INVENTARIO_TESTES_CORRECOES_PRE_GO_LIVE', inventariar_testes())]:
        destino = ROOT/'output'/f'{nome}.json'
        anterior = destino.with_name(f'{nome}.antes_fiscal_baileys.json')
        if destino.exists() and not anterior.exists():
            anterior.write_bytes(destino.read_bytes())
        destino.write_text(json.dumps(valor, indent=2, ensure_ascii=False)+'\n')
    print(json.dumps({'testes': valor['arquivos'], 'sem_runner': valor['sem_runner']}, ensure_ascii=False))
