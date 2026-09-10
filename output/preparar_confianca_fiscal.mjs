/** Material sintético efêmero, criado antes da API para o ensaio de navegador. */
import assert from 'node:assert/strict';
import { copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { confiancaA1Sintetica } from '../packages/finance/test/nfse-confianca-fixture.ts';
const destino = process.env.FISCAL_CONFIANCA_DIR;
assert.ok(destino?.startsWith('/home/ec2-user/codex-tmp/barbearia-audit-runtime/nfse-confianca-browser-'));
const pki = confiancaA1Sintetica(undefined, '12ABC34501DE35');
try {
  for (const arquivo of ['raizes.pem', 'crls.pem', 'cadeias.pem']) await copyFile(join(pki.pasta, arquivo), join(destino, arquivo));
  await writeFile(join(destino, 'a1-teste.json'), JSON.stringify({
    pfx: pki.pfx.toString('base64'), senha: pki.senha, autoridadePem: pki.certificado.certificadoPem,
  }), { mode: 0o600 });
} finally { pki.limpar(); }
