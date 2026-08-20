import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Todo evento que a tela oferece tem quem o emita (bloco 112).
 *
 * `EVENTOS_DE_WEBHOOK` alimenta a borda, a tela e o banco. Quatro dos cinco
 * estavam nos três lugares e **nenhum ponto do produto os disparava**: o
 * contador marcava "Comanda paga" e "Horário cancelado", via o endereço na
 * lista com os rótulos certos, e o ERP dele nunca recebia nada — sem erro, sem
 * entrega falhada, sem linha no histórico. Um ERP que sincroniza agenda mostrava
 * para sempre como ativo o horário que o cliente cancelou.
 *
 * É o defeito de `blocks` — opção que o motor aceita e ninguém preenche — na
 * superfície que a barbearia mostra para terceiros, que é onde ele é mais caro:
 * do lado de lá, ninguém tem como investigar.
 *
 * Varredura e não lista escrita: o sexto evento nasce cobrado.
 */

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');

function fontesDeProducao() {
  return execFileSync('git', ['ls-files', 'packages', 'apps'], { cwd: raiz, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((caminho) => /\.ts$/.test(caminho))
    .filter((caminho) => !/\.test\.ts$/.test(caminho))
    .filter((caminho) => !/\/dist\//.test(caminho));
}

describe('catálogo de eventos de webhook', () => {
  const catalogo = readFileSync(join(raiz, 'packages/core/src/webhook.ts'), 'utf8');
  const declarados = [
    ...(/export const EVENTOS_DE_WEBHOOK = \[([^\]]+)\]/.exec(catalogo)?.[1] ?? '').matchAll(
      /'([^']+)'/g,
    ),
  ].map((m) => m[1]);

  it('a varredura acha o catálogo — se não achar, ela não prova nada', () => {
    // Guarda que casa vazio passa por vacuidade, e foi assim que a guarda do
    // `UPDATE locations` do bloco 111 aprovou o defeito que ela existia para
    // pegar. O limite vai escrito dentro dela.
    expect(declarados.length).toBeGreaterThanOrEqual(5);
  });

  it('todo evento declarado é emitido por algum ponto do produto', () => {
    const fonte = fontesDeProducao()
      .filter((caminho) => !caminho.startsWith('packages/core/src/webhook.ts'))
      .map((caminho) => readFileSync(join(raiz, caminho), 'utf8'))
      .join('\n');

    const semEmissor = declarados.filter((evento) => !fonte.includes(`'${evento}'`));

    expect(
      semEmissor,
      'a tela oferece estes e nada os dispara: o ERP do outro lado nunca recebe ' +
        'o aviso, e não tem como descobrir por quê',
    ).toEqual([]);
  });
});
