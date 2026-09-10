"""Dump PostgreSQL real -> GCM do produto -> restauração em banco descartável.

Executar após medicao.sh, com a pilha parada. Nenhum payload ou segredo é salvo
no relatório; artefatos transitórios ficam em diretório privado e são removidos.
"""
from pathlib import Path
from urllib.parse import urlparse
import base64, hashlib, json, os, subprocess, tempfile, time, uuid

root = Path(__file__).resolve().parents[1]
env = dict(os.environ)
admin = env['ADMIN_DATABASE_URL']
assert urlparse(admin).hostname in ['127.0.0.1', 'localhost']
base = admin.rsplit('/', 1)[0]
origem = base + '/barbearia_audit_medicao'
db = 'barbearia_restore_gcm_' + uuid.uuid4().hex[:10]
destino = base + '/' + db
env['BACKUP_ENCRYPTION_KEY'] = base64.b64encode(os.urandom(32)).decode()

def executar(args, *, ambiente=env):
    return subprocess.check_output(args, cwd=root, env=ambiente, stderr=subprocess.PIPE, text=True).strip()

def assinatura(url):
    return executar(['node', 'packages/db/scripts/check-schema.mjs', 'data-signature', url])

with tempfile.TemporaryDirectory(prefix='barbearia-gcm-', dir=env['TMPDIR']) as d:
    pasta = Path(d)
    dump, cifrado, decifrado = [pasta/n for n in ['origem.dump', 'backup.enc', 'restauravel.dump']]
    corrompido = pasta/'corrompido.enc'
    antes = assinatura(origem)
    executar(['pg_dump', origem, '--format=custom', '--no-owner', '--file='+str(dump)])
    hash_dump = hashlib.sha256(dump.read_bytes()).hexdigest()
    executar(['node', 'scripts/backup-crypto.mjs', 'encrypt', str(dump), str(cifrado)])
    dump.unlink()
    executar(['node', 'scripts/backup-crypto.mjs', 'check', str(cifrado)])
    executar(['node', 'scripts/backup-crypto.mjs', 'decrypt', str(cifrado), str(decifrado)])
    assert hashlib.sha256(decifrado.read_bytes()).hexdigest() == hash_dump
    bytes_alterados = bytearray(cifrado.read_bytes()); bytes_alterados[-1] ^= 1
    corrompido.write_bytes(bytes_alterados)
    recusado = pasta/'nao_pode_existir.dump'
    for entrada, ambiente in [(corrompido, env), (cifrado, {**env, 'BACKUP_ENCRYPTION_KEY':base64.b64encode(os.urandom(32)).decode()})]:
        resultado = subprocess.run(['node', 'scripts/backup-crypto.mjs', 'decrypt', str(entrada), str(recusado)],
            cwd=root, env=ambiente, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        assert resultado.returncode != 0 and not recusado.exists()
        assert not list(pasta.glob('*.parcial-*'))
    executar(['psql', admin, '-X', '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE DATABASE '+db])
    try:
        inicio = time.monotonic()
        executar(['pg_restore', '--exit-on-error', '--no-owner', '--dbname='+destino, str(decifrado)])
        segundos = time.monotonic()-inicio
        assert assinatura(destino) == antes
        executar(['node', 'packages/db/scripts/check-schema.mjs', 'current', destino])
        acesso = executar(['node', 'packages/db/scripts/check-schema.mjs', 'app', destino])
        assert 'tenants exercitados: 2' in acesso
        print(json.dumps({'resultado':'passou', 'restauracao_segundos':round(segundos, 3),
            'conteudo_identico':True, 'schema_atual':True, 'rls_login_real':True,
            'corrupcao_recusada':True, 'chave_errada_recusada':True,
            'provedores_externos':False, 'docker_executado':False}))
    finally:
        executar(['psql', admin, '-X', '-v', 'ON_ERROR_STOP=1', '-c', 'DROP DATABASE '+db+' WITH (FORCE)'])
