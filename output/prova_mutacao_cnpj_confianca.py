"""Contraprova dirigida. Não compila dist e restaura a fonte mesmo se o teste falhar."""
from pathlib import Path
import subprocess, hashlib, json
root=Path(__file__).resolve().parents[1]
casos=[
 ('cnpj_dv', 'packages/core/src/fiscal.ts', '(digitos.charCodeAt(i) - 48)', 'Number(digitos[i])',
  '@barbearia/core', 'test', 'src/fiscal.test.ts', 'valida o exemplo alfanumérico'),
 ('cadeia_resposta', 'packages/finance/src/nfse/confianca-a1.ts', "await executar('/usr/bin/openssl'", "await (async (..._args: unknown[]) => ({}))('/usr/bin/openssl'",
  '@barbearia/finance', 'test:unit', 'src/nfse/prova-resposta.test.ts', 'recusa assinante revogado'),
 ('cofre_canonico', 'packages/finance/src/nfse/cofre.ts', "dados.toString('base64') !== body", 'false',
  '@barbearia/finance', 'test:unit', 'src/nfse/contrato.test.ts', 'cifra com nonce aleatório'),
 ('rollback_crl', 'scripts/fiscal-confianca-atualizar.mjs', 'ultima >= antes.lastUpdate', 'true',
  '@barbearia/finance', 'test:unit', 'src/nfse/confianca-atualizacao.test.ts', 'impede voltar a uma CRL anterior'),
]
resultados=[]
for nome, arquivo, antes, depois, pacote, comando, teste, esperado in casos:
 p=root/arquivo; original=p.read_bytes(); s=original.decode(); assert s.count(antes)==1
 try:
  p.write_text(s.replace(antes,depois))
  r=subprocess.run(['pnpm','--filter',pacote,comando,teste],cwd=root,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
  assert r.returncode!=0 and esperado in r.stdout, 'Mutação não demonstrou a falha esperada: '+nome
 finally: p.write_bytes(original)
 assert p.read_bytes()==original
 resultados.append({'caso':nome,'falhaDirigidaDetectada':True,'fonteRestaurada':True,'sha256':hashlib.sha256(original).hexdigest()})
print(json.dumps(resultados,ensure_ascii=False))
