import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODULOS } from './secoes.js';

/**
 * Toda tela do painel tem volta e tem **Sair**.
 *
 * ## O defeito
 *
 * `/admin/equipe/permissoes` e `/admin/plano` eram as duas únicas telas do
 * painel sem `painel__topo` — sem o "← Barbearia" e, o que pesa mais, **sem o
 * botão Sair**. Numa máquina de balcão compartilhada, o logout desaparecia
 * exatamente onde a memória muscular o procura, e a tela virava caminho de ida.
 *
 * É a §6 pergunta 1 — *"onde a pessoa entra e para onde ela vai depois?"* — e
 * ela vinha sendo respondida por hábito, não por regra: dezenove telas acertavam
 * e duas não, sem nada notar a diferença.
 *
 * ## Por que derivada de `MODULOS`
 *
 * Uma lista escrita aqui ao lado nasceria desatualizada na primeira tela nova.
 * Derivada, o destino que alguém acrescentar ao menu no bloco seguinte já nasce
 * cobrado.
 *
 * ## O que ela **não** vê
 *
 * Ela lê o fonte e procura a marca do cabeçalho. Uma tela que montasse o topo
 * por um componente com outro nome apareceria como ausente — o que erra para o
 * lado seguro. E ela não prova que o topo é **renderizado**: prova que a tela o
 * escreve. Guarda em que se confia mais do que ela alcança é pior que guarda
 * nenhuma, e o limite fica escrito aqui.
 */

const RAIZ = join(process.cwd(), 'src/app');

function fonteDaTela(href: string): string | null {
  const rota = href.replace(/^\/admin\/?/, '');
  try {
    return readFileSync(join(RAIZ, 'admin', rota, 'page.tsx'), 'utf8');
  } catch {
    return null;
  }
}

/** As telas do menu, mais as que só se alcança de dentro de outra. */
const DESTINOS: readonly string[] = [
  ...MODULOS.flatMap((m) => m.telas.map((t) => t.href)),
  // Não está no menu e é tela cheia: foi uma das duas que estavam sem topo.
  '/admin/equipe/permissoes',
];

describe('a saída de cada tela do painel', () => {
  it('a varredura encontra as telas que deveria vigiar', () => {
    const achadas = DESTINOS.filter((href) => fonteDaTela(href) !== null).length;
    expect(achadas).toBeGreaterThan(20);
  });

  it('toda tela desenha o cabeçalho com a volta', () => {
    const sem = DESTINOS.filter((href) => {
      const fonte = fonteDaTela(href);
      return fonte !== null && !fonte.includes('painel__topo');
    });

    expect(sem, 'tela sem cabeçalho é caminho de ida (§6, pergunta 1)').toEqual([]);
  });

  it('toda tela oferece o Sair', () => {
    /**
     * Separado do caso acima de propósito: o cabeçalho pode existir sem o
     * botão, e é o botão que a pessoa procura ao levantar do balcão.
     */
    const sem = DESTINOS.filter((href) => {
      const fonte = fonteDaTela(href);
      return fonte !== null && !fonte.includes('acaoSair');
    });

    expect(sem, 'tela sem Sair deixa a sessão aberta numa máquina compartilhada').toEqual([]);
  });
});
