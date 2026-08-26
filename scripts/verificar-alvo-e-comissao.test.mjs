import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { falhasDoAlvoEComissao } from './verificar-alvo-e-comissao.mjs';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

const AGENDA = 'apps/web/src/app/admin/agenda/page.tsx';
const REGRAS = 'apps/web/src/app/admin/comissao/regras/page.tsx';
const ACAO = 'apps/web/src/app/admin/acoes/agenda-financeiro.ts';

test('o produto de hoje passa', () => assert.deepEqual(falhasDoAlvoEComissao(), []));

/** Copia só os três arquivos que a guarda lê, e devolve a raiz de mentira. */
function copiaComPastas() {
  const base = mkdtempSync(resolve(tmpdir(), 'alvo-'));
  for (const p of [AGENDA, REGRAS, ACAO]) {
    const destino = join(base, p);
    mkdirSync(dirname(destino), { recursive: true });
    writeFileSync(destino, readFileSync(join(RAIZ, p), 'utf8'));
  }
  return base;
}

const quebras = [
  [
    '"A barbearia toda" volta a ser oferecida a todo mundo',
    AGENDA,
    (s) =>
      s.replace(
        /{podeFecharACasa \? <option value="">A barbearia toda<\/option> : null}/,
        '<option value="">A barbearia toda</option>',
      ),
  ],
  [
    'o alvo único vira um seletor de uma opção',
    AGENDA,
    // Ancorada em `value={alvoUnico}` de propósito: sem isso ela troca o
    // `professionalId` oculto da confirmação de conflito, que é outro campo.
    (s) => s.replace(/type="hidden" value={alvoUnico}/, 'type="text" value={alvoUnico}'),
  ],
  [
    'a regra por categoria some do formulário',
    REGRAS,
    (s) => s.replace(/value={`cat:\$\{categoria\.id\}`}/g, 'value={categoria.id}'),
  ],
  [
    'a ação para de separar serviço de categoria',
    ACAO,
    (s) => s.replace(/alvo\.startsWith\('cat:'\)/g, "false && alvo.startsWith('x:')"),
  ],
  [
    'voltam dois campos para a mesma pergunta',
    REGRAS,
    (s) => s.replace(/id="alvo" name="alvo"/, 'id="alvo" name="serviceId"'),
  ],
];

for (const [nome, arquivo, quebrar] of quebras) {
  test(`fica vermelha quando ${nome}`, () => {
    const base = copiaComPastas();
    try {
      const antes = readFileSync(join(base, arquivo), 'utf8');
      const depois = quebrar(antes);
      // Um `replace` que não casa deixa o teste passando pelo motivo errado:
      // a guarda pareceria não prestar quando quem não prestou foi a quebra.
      assert.notEqual(depois, antes, `a quebra "${nome}" não casou com nada`);
      writeFileSync(join(base, arquivo), depois);
      assert.ok(
        falhasDoAlvoEComissao(base).length > 0,
        `a guarda não viu: ${nome}`,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
}
