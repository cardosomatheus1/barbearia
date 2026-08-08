import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Responsividade das telas (CLAUDE.md §5).
 *
 * O design system já tinha esta guarda, mas ela só olhava o CSS de
 * `packages/ui`. **Todo o CSS das telas mora aqui** — página pública, fluxo de
 * agendamento, meus agendamentos e painel do balcão —, e nada verificava.
 *
 * A regra dizia "há teste que rejeita" e era verdade pela metade: o arquivo que
 * mais cresce era justamente o que ninguém checava.
 */

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'globals.css'),
  'utf8',
);

/**
 * O mesmo CSS sem as condições de `@media`.
 *
 * Ponto de quebra é `min-width: 768px` e não tem nada a ver com exigir 768px de
 * largura. Procurar largura fixa sem separar os dois acusa o próprio
 * mobile-first de quebrar o mobile-first.
 */
/**
 * O CSS sem comentários.
 *
 * O casamento de regra é `([^{}]+)\{([^}]*)\}`, e comentário é texto entre
 * chaves como qualquer outro: um comentário que **cita** uma classe fazia essa
 * classe herdar o corpo da regra seguinte. Foi assim que a guarda de
 * `min-width: 0` aprovou `.colunas` por causa de um comentário que a explicava
 * — o teste passou a testar a própria documentação.
 */
const semComentarios = css.replace(/\/\*[\s\S]*?\*\//g, '');

const semCondicoes = semComentarios.replace(/@media[^{]+\{/g, '{');

/**
 * Separa o CSS base do que está dentro de `@media`, contando chaves.
 *
 * A primeira versão partia o arquivo no primeiro `@media` e tratava o resto como
 * condicional — mas as media queries são intercaladas, então tudo que vem depois
 * da primeira ficava fora da análise. O teste passava por não estar olhando.
 */
function separar(fonte: string): { base: string; dentroDeMedia: string } {
  let base = '';
  let dentroDeMedia = '';
  let i = 0;

  while (i < fonte.length) {
    const inicio = fonte.indexOf('@media', i);
    if (inicio === -1) {
      base += fonte.slice(i);
      break;
    }

    base += fonte.slice(i, inicio);

    const abre = fonte.indexOf('{', inicio);
    if (abre === -1) break;

    let profundidade = 1;
    let j = abre + 1;
    while (j < fonte.length && profundidade > 0) {
      if (fonte[j] === '{') profundidade += 1;
      else if (fonte[j] === '}') profundidade -= 1;
      j += 1;
    }

    dentroDeMedia += fonte.slice(abre + 1, j - 1);
    i = j;
  }

  return { base, dentroDeMedia };
}

const { base: cssBase, dentroDeMedia } = separar(semComentarios);

/** Piso de projeto: o Android popular no Brasil. */
const PISO = 360;

describe('CSS das telas', () => {
  it('toda media query de layout é mobile-first', () => {
    // `max-width` significa "desfazer o que fiz para tela grande", o que inverte
    // a ordem de trabalho e transforma o celular em caso excepcional. Vale para
    // o painel também: notebook é o aparelho principal do balcão, não o único.
    const queries = [...css.matchAll(/@media\s*([^{]+)\{/g)].map((m) => (m[1] ?? '').trim());
    const layout = queries.filter((q) => !q.includes('prefers-'));

    expect(layout.length).toBeGreaterThan(0);
    for (const query of layout) {
      expect(query, `media query não é min-width: "${query}"`).toContain('min-width');
    }
  });

  it('nenhuma largura fixa passa do piso de 360px', () => {
    // Largura em pixel maior que a tela é a causa nº 1 de rolagem horizontal —
    // o defeito mais comum em página de barbearia no celular.
    const larguras = [...semCondicoes.matchAll(/(?:^|[^-])\bwidth:\s*(\d+)px/g)]
      .map((m) => Number(m[1]))
      .filter((valor) => valor > PISO);

    expect(larguras, `largura fixa acima de ${PISO}px: ${larguras.join(', ')}`).toEqual([]);
  });

  it('nenhum `min-width` em pixel obriga a tela a ser maior que o piso', () => {
    const minimos = [...semCondicoes.matchAll(/min-width:\s*(\d+)px/g)]
      .map((m) => Number(m[1]))
      .filter((valor) => valor > PISO);

    expect(minimos, `min-width acima do piso: ${minimos.join(', ')}`).toEqual([]);
  });

  it('conteúdo largo rola dentro do próprio recipiente', () => {
    // Tabela, grade de horários e régua de etapas são largas por natureza. A
    // regra não é evitá-las — é que a rolagem fique dentro delas e nunca leve a
    // página junto.
    const rolagens = [...css.matchAll(/overflow-x:\s*auto/g)];
    expect(rolagens.length).toBeGreaterThan(0);
  });

  it('não esconde conteúdo no celular para mostrá-lo no desktop', () => {
    // `display: none` no piso com `display: algo` num `min-width` é a decisão de
    // que aquilo não importava no celular. Se não importa, tire de todas.
    const escondidos = [...cssBase.matchAll(/\.([\w-]+)[^{}]*\{[^}]*display:\s*none/g)].map(
      (m) => m[1] ?? '',
    );

    const revividos = escondidos.filter((classe) =>
      new RegExp(`\\.${classe}[^{}]*\\{[^}]*display:\\s*(?!none)`).test(dentroDeMedia),
    );

    expect(revividos, `escondido no celular e revivido no desktop: ${revividos.join(', ')}`)
      .toEqual([]);
  });

  it('recipiente que rola dentro de grade declara `min-width: 0`', () => {
    // Terceira vez que este defeito aparece: `.ui-scroll-x` clipa a rolagem,
    // mas o **elemento** continua sendo item de grade ou de flex, e item nasce
    // com `min-width: auto` — a faixa cresce até o min-content do conteúdo
    // largo, e a página inteira passa a rolar de lado.
    //
    // Só a medição no navegador pegava, porque depende da largura intrínseca do
    // conteúdo. Este teste pega antes, e é barato: toda classe que aparece ao
    // lado de `ui-scroll-x` no markup precisa zerar o mínimo.
    //
    // **Limite conhecido:** cobre o recipiente, não os ancestrais dele. Na
    // agenda o `.agenda-dia` que envolve o `.colunas` precisou do mesmo
    // `min-width: 0`, e disso quem avisou foi a medição. Verificar a cadeia
    // inteira exigiria montar o layout, que é o que o navegador faz — as duas
    // guardas se completam e nenhuma substitui a outra.
    const comRolagem = new Set<string>();
    for (const arquivo of telas(SRC)) {
      const fonte = readFileSync(arquivo, 'utf8');
      for (const [, lista = ''] of fonte.matchAll(/className="([^"]*\bui-scroll-x\b[^"]*)"/g)) {
        for (const classe of lista.split(/\s+/).filter(Boolean)) {
          if (classe !== 'ui-scroll-x') comRolagem.add(classe);
        }
      }
    }

    expect(comRolagem.size, 'nenhum `ui-scroll-x` com classe própria').toBeGreaterThan(0);

    const porClasse = new Map<string, string>();
    for (const [, seletor = '', corpo = ''] of semCondicoes.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      for (const [, classe = ''] of seletor.matchAll(/\.([\w-]+)/g)) {
        if (comRolagem.has(classe)) porClasse.set(classe, (porClasse.get(classe) ?? '') + corpo);
      }
    }

    const frouxas = [...comRolagem].filter(
      (classe) => !/min-width:\s*0/.test(porClasse.get(classe) ?? ''),
    );

    expect(frouxas, `recipiente que rola sem \`min-width: 0\`: ${frouxas.join(', ')}`).toEqual([]);
  });

  it('toda tela do painel começa no piso, sem exigir notebook', () => {
    // O balcão é usado num notebook o dia inteiro, mas não pode ser exclusivo
    // dele: quando o notebook está ocupado, a recepção atende pelo celular.
    const painel = semCondicoes.slice(semCondicoes.indexOf('.painel__entrada'));
    expect(painel.length).toBeGreaterThan(0);

    const larguras = [...painel.matchAll(/width:\s*(\d+)px/g)].map((m) => Number(m[1]));
    for (const largura of larguras) {
      expect(largura, `painel exige ${largura}px`).toBeLessThanOrEqual(PISO);
    }
  });
});

/** Todo `.tsx` das telas, para conferir as imagens no markup. */
function telas(raiz: string): string[] {
  return readdirSync(raiz).flatMap((nome) => {
    const caminho = join(raiz, nome);
    if (statSync(caminho).isDirectory()) return telas(caminho);
    return caminho.endsWith('.tsx') ? [caminho] : [];
  });
}

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('imagens nas telas', () => {
  /**
   * Foto sem tamanho declarado empurra o conteúdo ao carregar.
   *
   * Numa página em que a próxima coisa depois da foto é a grade de horários,
   * isso é o toque errado no horário errado — com o cliente em pé, na rua, com
   * uma mão. A regra está no CLAUDE.md §5 desde o bloco 6 e não tinha teste,
   * porque até agora não havia uma única imagem no produto.
   */
  it('todo <img> declara width e height', () => {
    const semMedida: string[] = [];

    for (const arquivo of telas(SRC)) {
      const fonte = readFileSync(arquivo, 'utf8');
      for (const tag of fonte.match(/<img[\s\S]*?\/>/g) ?? []) {
        if (!/\bwidth=/.test(tag) || !/\bheight=/.test(tag)) {
          semMedida.push(`${arquivo.split('/src/')[1]}: ${tag.slice(0, 60).replace(/\s+/g, ' ')}`);
        }
      }
    }

    expect(semMedida, `<img> sem medida:\n${semMedida.join('\n')}`).toEqual([]);
  });

  it('toda classe usada num <img> tem limite de largura e proporção', () => {
    // As classes vêm do markup, não do nome.
    //
    // A primeira versão procurava classes com "foto" ou "img" no nome e acusava
    // `.foto-campo__linha` — um contêiner flex — e `.foto-campo__mini--vazia`,
    // um modificador cujo tamanho está na regra base. Heurística de nome erra
    // nos dois sentidos: pega o que não é imagem e perde a imagem mal batizada.
    const classes = new Set<string>();
    for (const arquivo of telas(SRC)) {
      const fonte = readFileSync(arquivo, 'utf8');
      for (const tag of fonte.match(/<img[\s\S]*?\/>/g) ?? []) {
        for (const [, lista = ''] of tag.matchAll(/className="([^"]+)"/g)) {
          for (const classe of lista.split(/\s+/).filter(Boolean)) classes.add(classe);
        }
      }
    }
    expect(classes.size, 'nenhum <img> com classe encontrado').toBeGreaterThan(0);

    // Todas as declarações de cada classe, somadas: uma imagem legitimamente
    // declara a largura na base e ajusta a proporção dentro de um `@media`.
    const porClasse = new Map<string, string>();
    for (const [, seletor = '', corpo = ''] of semCondicoes.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      for (const [, classe = ''] of seletor.matchAll(/\.([\w-]+)/g)) {
        if (classes.has(classe)) porClasse.set(classe, (porClasse.get(classe) ?? '') + corpo);
      }
    }

    const frouxas = [...classes].filter((classe) => {
      const corpo = porClasse.get(classe) ?? '';
      const temProporcao = /aspect-ratio|height:\s*(?!auto)/.test(corpo);
      const temLimite = /max-width|width:\s*(100%|\d)/.test(corpo);
      return !(temProporcao && temLimite);
    });

    expect(frouxas, `imagem sem limite ou sem proporção: ${frouxas.join(', ')}`).toEqual([]);
  });
});
