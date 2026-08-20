import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `ESCOPOS_COM_ROTA` diz a verdade sobre a API pública (bloco 112).
 *
 * A tela de chaves oferecia trinta e um escopos sob o título "O que ela pode
 * fazer", e duas rotas honravam dois deles. O dono marcava `fiscal.issue`
 * porque o integrador pediu, e nada respondia — não havia sequer o que recusar.
 *
 * A lista mora em `packages/core`, que não lê o fonte da API. Esta varredura é
 * o que impede as duas de divergirem: a rota nova entra na constante ou o
 * portão fica vermelho, e a chave que já existia não ganha poder novo sem
 * ninguém ter decidido.
 */

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');

function escoposDeclaradosNasRotas() {
  const arquivos = execFileSync('git', ['ls-files', 'apps/api/src'], { cwd: raiz, encoding: 'utf8' })
    .split('\n')
    .filter((caminho) => /\.ts$/.test(caminho) && !/\.test\.ts$/.test(caminho));

  const achados = new Set();
  for (const caminho of arquivos) {
    const fonte = readFileSync(join(raiz, caminho), 'utf8');
    for (const casamento of fonte.matchAll(/@Escopo\('([^']+)'\)/g)) achados.add(casamento[1]);
  }
  return [...achados].sort();
}

function daConstante() {
  const fonte = readFileSync(join(raiz, 'packages/core/src/apikey.ts'), 'utf8');
  const bloco = /export const ESCOPOS_COM_ROTA: readonly Permissao\[\] = \[([^\]]*)\]/.exec(fonte);
  return [...(bloco?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
}

describe('escopo de chave de API × rota que o honra', () => {
  it('a varredura enxerga os decoradores — sem isso ela não prova nada', () => {
    // A guarda do `UPDATE locations` do bloco 111 passou verde sobre o defeito
    // porque casava zero arquivos. O limite vai escrito dentro da guarda.
    expect(escoposDeclaradosNasRotas().length).toBeGreaterThan(0);
  });

  it('a constante lista exatamente o que alguma rota declara', () => {
    expect(
      daConstante(),
      'a tela promete o que a API honra: divergir aqui é oferecer um escopo que ' +
        'não responde, ou dar poder novo a uma chave que já existia',
    ).toEqual(escoposDeclaradosNasRotas());
  });
});
