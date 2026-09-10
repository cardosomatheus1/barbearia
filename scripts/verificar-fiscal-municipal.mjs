import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

const pasta = resolve('integrations/fiscal-municipal/vendor/openac-nfse');
const origem = JSON.parse(readFileSync(resolve(pasta, 'origem.json'), 'utf8'));
const patches = JSON.parse(readFileSync(resolve(pasta, 'alteracoes-locais.json'), 'utf8'));
for (const [arquivo, hash] of Object.entries(origem.sha256_originais)) {
  const esperado = patches[arquivo]?.depois ?? hash;
  assert.equal(createHash('sha256').update(readFileSync(resolve(pasta, arquivo))).digest('hex'), esperado,
    `Fonte fiscal reutilizada mudou sem registro: ${arquivo}`);
}
const dotnet = process.env.DOTNET_BIN || 'dotnet';
const catalogo = JSON.parse(execFileSync(dotnet,
  ['integrations/fiscal-municipal/src/bin/Debug/net10.0/Barbearia.FiscalMunicipal.dll', 'catalogo'],
  { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 }));
assert.deepEqual(catalogo, JSON.parse(readFileSync('packages/finance/assets/nfse-municipal/municipios.json', 'utf8')),
  'Catálogo do TypeScript precisa corresponder ao mesmo motor C#');
console.log(`Fonte fiscal fixada: ${Object.keys(origem.sha256_originais).length} arquivos, ${Object.keys(patches).length} adaptações locais; catálogo coerente.`);
