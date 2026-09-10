import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const arquivos = ['scripts/verificar-finance-fiscal-modulos.mjs',
  ...['fiscal', 'fiscal-emissor', 'fiscal-erros', 'fiscal-configuracao', 'fiscal-notas', 'fiscal-emissao', 'fiscal-entrega', 'nfse-municipal/roteador']
    .map(nome => `packages/finance/src/${nome}.ts`)];

function verificar(mutacao) {
  const pasta = mkdtempSync(join(tmpdir(), 'barbearia-fiscal-modulos-'));
  try {
    for (const arquivo of arquivos) {
      const alvo = join(pasta, arquivo);
      mkdirSync(dirname(alvo), { recursive: true });
      copyFileSync(arquivo, alvo);
    }
    if (mutacao) {
      const [arquivo, antes, depois] = mutacao;
      const alvo = join(pasta, arquivo); const fonte = readFileSync(alvo, 'utf8');
      assert.ok(fonte.includes(antes), 'A mutação precisa alcançar a regra real');
      writeFileSync(alvo, fonte.replace(antes, depois));
    }
    return spawnSync(process.execPath, ['scripts/verificar-finance-fiscal-modulos.mjs'], { cwd: pasta, encoding: 'utf8' });
  } finally { rmSync(pasta, { recursive: true, force: true }); }
}

test('fachada fiscal aceita roteamento dos dois emissores com cofre obrigatório', () => {
  const resultado = verificar();
  assert.equal(resultado.status, 0, resultado.stderr);
});
for (const [nome, arquivo, trecho] of [
  ['cofre obrigatório', 'fiscal-emissor', 'chaveFiscal();'],
  ['roteador', 'fiscal-emissor', 'new EmissorProprioNfse()'],
  ['emissor nacional', 'nfse-municipal/roteador', 'new EmissorNacionalNfse()'],
  ['emissor municipal', 'nfse-municipal/roteador', 'new EmissorMunicipalNfse()'],
  ['roteamento do documento', 'nfse-municipal/roteador', "ref.startsWith('nfse-municipal:')"],
]) {
  test(`guarda reprova remoção de ${nome}`, () => {
    const resultado = verificar([`packages/finance/src/${arquivo}.ts`, trecho, 'null']);
    assert.notEqual(resultado.status, 0);
  });
}
