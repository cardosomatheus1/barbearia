from pathlib import Path
import subprocess
p=Path('apps/web/src/app/admin/acoes/crescimento-plataforma.ts')
antes=p.read_bytes()
try:
 s=antes.decode();a='    // A lista vazia é a escolha de não adicionar botões. Omitir ativaria os padrões do domínio.\n    botoes,'
 assert s.count(a)==1
 p.write_text(s.replace(a,'    ...(botoes.length > 0 ? { botoes } : {}),'))
 r=subprocess.run(['pnpm','--filter','@barbearia/web','test','src/app/admin/acoes/whatsapp-textos.test.ts'],capture_output=True,text=True)
 assert r.returncode != 0 and '1 failed' in r.stdout and '2 passed' in r.stdout, 'Mutação não foi detectada como esperado'
 print('Mutação reprovada: deixar botoes ausente quando nada foi marcado falha exatamente no caso vazio; dois casos com botões continuam aprovados.')
finally:
 p.write_bytes(antes)
