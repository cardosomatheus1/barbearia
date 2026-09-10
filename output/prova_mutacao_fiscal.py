"""Demonstra que os testes reprovam a retirada de uma garantia; restaura a fonte."""
from pathlib import Path
import hashlib, subprocess, json
root = Path(__file__).resolve().parents[1]
casos = [
 ('resposta_ibscbs', 'packages/finance/src/nfse/ibscbs-resposta.ts',
  "  if (Object.hasOwn(inf, 'IBSCBS') !== Object.hasOwn(dps, 'IBSCBS')) return false;",
  "  if (Object.hasOwn(dps, 'IBSCBS')) return true;\n  if (Object.hasOwn(inf, 'IBSCBS') !== Object.hasOwn(dps, 'IBSCBS')) return false;",
  'src/nfse/contrato.test.ts'),
 ('cabecalho_danfse', 'packages/finance/src/nfse/danfse-desenho.ts',
  "    texto('Documento Auxiliar da NFS-e', 5.3, 0.63, 10.3, 0.4, 9, 'rotulo', '#000000', 'center');",
  '', 'src/nfse/danfse.test.ts'),
]
resultados=[]
for nome, arquivo, antes, depois, teste in casos:
 p=root/arquivo; original=p.read_bytes(); texto=original.decode()
 assert texto.count(antes)==1
 try:
  p.write_text(texto.replace(antes,depois))
  r=subprocess.run(['pnpm','--filter','@barbearia/finance','test:unit',teste],cwd=root)
  assert r.returncode!=0, 'A mutação não foi detectada: '+nome
 finally:p.write_bytes(original)
 assert p.read_bytes()==original
 resultados.append({'caso':nome,'mutacaoDetectada':True,'fonteRestaurada':True,'sha256':hashlib.sha256(original).hexdigest()})
print(json.dumps(resultados))
