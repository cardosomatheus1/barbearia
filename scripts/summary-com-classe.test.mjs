import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Todo `<summary>` carrega classe — o padrão do navegador tem 24px de alvo.
 *
 * O piso de toque deste produto é 44px **em qualquer largura**, e não só no
 * celular: mouse impreciso e limitação motora não são exclusividade do aparelho
 * pequeno. Um `<summary>` sem classe sai com a altura do texto.
 *
 * ## Por que a medição não pega
 *
 * Ela pega — quando o elemento existe na hora da foto. O caso que escapou vivia
 * atrás de `podeMexer && signup`: o bloco de cadastro manual do WhatsApp só é
 * renderizado quando o Embedded Signup da Meta está configurado, e a semente da
 * medição não configura. Quarenta e sete `<summary>` do produto tinham classe;
 * o único que não tinha era o que a foto nunca alcançava.
 *
 * É a regra da semente da medição vista pelo outro lado: ali o print sai do
 * estado errado; aqui o elemento não sai. Uma guarda que lê o fonte não depende
 * de o estado acontecer.
 *
 * ## O que ela **não** vê
 *
 * Se a classe existe, não se ela dá 44px — isso é do design system e da
 * medição. O que ela impede é a ausência, que é o caso que aconteceu.
 */

const RAIZ = new URL('..', import.meta.url).pathname;

const telas = () =>
  execFileSync('git', ['ls-files', 'apps/web/src'], { cwd: RAIZ, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.endsWith('.tsx'));

describe('o alvo de toque do summary', () => {
  it('nenhum <summary> fica sem classe', () => {
    const semClasse = [];

    for (const f of telas()) {
      /**
       * O comentário sai antes de casar.
       *
       * A primeira versão acusava `importar/page.tsx`, onde a linha achada era a
       * **frase que explica esta regra** — ela cita a forma proibida para dizer
       * por que é proibida. Guarda que reprova a própria documentação é guarda
       * que alguém apaga, e é o defeito que a de pureza do `core` já cometeu.
       */
      const texto = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      for (const [i, linha] of texto.split('\n').entries()) {
        // `<summary>` cru, sem nenhum atributo: é a forma que sai com 24px.
        if (/<summary>/.test(linha)) semClasse.push(`${f}:${i + 1}`);
      }
    }

    expect(
      semClasse,
      'este <summary> sai com 24px de alvo: use `dobra__titulo` ou outra classe com o piso de 44px',
    ).toEqual([]);
  });

  it('a varredura enxerga a forma que ela proíbe', () => {
    // Sem este caso, um regex que não casasse nada devolveria verde para sempre.
    expect(/<summary>/.test('          <summary>Cadastrar à mão</summary>')).toBe(true);
    expect(/<summary>/.test('<summary className="dobra__titulo">Abrir</summary>')).toBe(false);
  });
});
