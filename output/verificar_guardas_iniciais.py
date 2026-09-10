from pathlib import Path
import subprocess, tempfile, shlex
root=Path(__file__).resolve().parents[1]
body=(root/'scripts/verify.sh').read_text().split('# Fase 1 — o que os outros esperam.',1)[0]
body=body.replace('cd "$(dirname "$0")/.."','cd '+shlex.quote(str(root)),1)
body+='\nif [ ${#failures[@]} -ne 0 ]; then exit 1; fi\n'
with tempfile.TemporaryDirectory(prefix='barbearia-guardas-') as pasta:
 script=Path(pasta)/'guardas.sh';script.write_text(body)
 raise SystemExit(subprocess.run(['bash',str(script)],cwd=root).returncode)
