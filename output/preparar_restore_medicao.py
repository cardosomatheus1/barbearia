"""Registra baseline explícita da base sintética preparada por medicao.sh.

A medição aplica os SQLs diretamente, sem livro de migrações. Antes dos ensaios
de restore, o migrador compara a estrutura com uma referência nova e registra
os checksums. Não adota banco produtivo nem altera dados das tabelas de negócio.
"""
from pathlib import Path
from urllib.parse import urlparse
import os, subprocess

root = Path(__file__).resolve().parents[1]
env = dict(os.environ)
admin = env['ADMIN_DATABASE_URL']
assert urlparse(admin).hostname in ['127.0.0.1', 'localhost']
env['DATABASE_URL'] = admin.rsplit('/', 1)[0] + '/barbearia_audit_medicao'
env['MIGRATION_ADOPT_THROUGH'] = sorted((root/'packages/db/migrations').glob('*.sql'))[-1].name
subprocess.run(['node', 'packages/db/scripts/migrate.mjs'], cwd=root, env=env, check=True)
