import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { MODULOS, SECOES_POR_MODULO, moduloDaSecao, secao, type Secao } from './secoes';

/**
 * O casco é padrão, e padrão sem guarda é convenção — dura até a próxima tela.
 *
 * O que motivou esta guarda: cinco telas do painel (`meu-dia`, `meus-numeros`,
 * a ficha do cliente, a comanda aberta e o onboarding) não declaravam seção
 * nenhuma. Não dava erro, não quebrava layout e ninguém percebeu por dois
 * blocos — porque o CSS tinha um `casco:not(:has([data-secao]))` que caía em
 * "Operação". O gestor abria "Meus números" e via, no trilho, nenhum módulo
 * aceso, e na barra ao lado a lista da Operação. Errado em silêncio é pior que
 * quebrado.
 *
 * Os três testes abaixo fecham os três jeitos de errar isso de novo.
 */

const AQUI = dirname(fileURLToPath(import.meta.url));

/**
 * As telas que ficam **fora** do casco.
 *
 * `admin/layout.tsx` só monta o casco quando há sessão. Antes dela existe a
 * porta — entrar, criar conta e trocar a senha —, e ali não há módulo para
 * acender porque ainda não se sabe quem é a pessoa.
 */
const PORTA = ['entrar', 'criar-conta', 'trocar-senha'];

function paginasDoPainel(): readonly string[] {
  const achadas: string[] = [];
  const andar = (pasta: string) => {
    for (const item of readdirSync(pasta)) {
      const caminho = join(pasta, item);
      if (statSync(caminho).isDirectory()) andar(caminho);
      else if (item === 'page.tsx') achadas.push(caminho);
    }
  };
  andar(AQUI);
  return achadas.filter((c) => !PORTA.some((p) => relative(AQUI, c).startsWith(p)));
}

describe('toda tela do painel declara onde está', () => {
  it('nenhum <main> do painel fica sem seção', () => {
    const semSecao: string[] = [];

    for (const caminho of paginasDoPainel()) {
      const fonte = readFileSync(caminho, 'utf8');
      // Cada `<main` até o `>` que o fecha. O atributo pode vir em qualquer
      // ordem, então o que se procura é a chamada, não uma posição.
      for (const abertura of fonte.match(/<main[\s\S]*?>/g) ?? []) {
        if (!abertura.includes('secao(')) {
          semSecao.push(`${relative(AQUI, caminho)}: ${abertura.replace(/\s+/g, ' ')}`);
        }
      }
    }

    expect(semSecao).toEqual([]);
  });

  it('ninguém escreve data-secao à mão', () => {
    // O atributo sozinho acende o link na lista de contexto e **não** acende o
    // módulo no trilho: é meia declaração, e o resultado é uma tela onde o
    // trilho inteiro fica apagado. `secao()` devolve os dois de uma vez.
    const naMao = paginasDoPainel().filter((c) =>
      readFileSync(c, 'utf8').includes('data-secao="'),
    );

    expect(naMao.map((c) => relative(AQUI, c))).toEqual([]);
  });

  it('o mapa por módulo tem exatamente os módulos do registro', () => {
    /**
     * A rede da asserção de tipo em `SECOES_POR_MODULO`.
     *
     * Ele é derivado de `MODULOS` com `Object.fromEntries`, que devolve
     * assinatura de índice — o TypeScript não prova que toda chave de `Modulo`
     * está ali, e a guarda do CSS logo abaixo varre justamente os **valores**
     * deste mapa. Um módulo ausente sumiria das duas conferências de uma vez,
     * que é exatamente como `lgpd` e `plano` ficaram sem acender.
     */
    expect(Object.keys(SECOES_POR_MODULO).sort()).toEqual(MODULOS.map((m) => m.id).sort());
  });

  it('toda seção usada pelas telas é conhecida pelo casco', () => {
    const conhecidas = new Set(Object.values(SECOES_POR_MODULO).flat());
    const usadas = new Set<string>();

    for (const caminho of paginasDoPainel()) {
      for (const [, nome] of readFileSync(caminho, 'utf8').matchAll(/secao\('([a-z-]+)'\)/g)) {
        usadas.add(nome!);
      }
    }

    expect([...usadas].filter((s) => !conhecidas.has(s))).toEqual([]);
    // E o contrário: seção registrada que nenhuma tela usa é campo que ninguém
    // preenche — o casco passa a listar um lugar que não existe.
    expect([...conhecidas].filter((s) => !usadas.has(s))).toEqual([]);
  });
});

describe('o CSS acompanha o casco', () => {
  const css = readFileSync(join(AQUI, '..', 'globals.css'), 'utf8');

  it('cada tela de navegação tem a regra que acende o próprio link', () => {
    // Esta é a única lista que o CSS ainda precisa enumerar: casar
    // `data-secao` com `data-para` é comparar o valor de dois atributos, e
    // seletor não faz isso. As outras três listas — módulo aceso, ícone e
    // bloco de contexto — saíram, e é por isso que `data-modulo-atual` existe.
    const semRegra = Object.values(SECOES_POR_MODULO)
      .flat()
      .filter((s) => !css.includes(`.casco:has([data-secao='${s}']) .contexto__link[data-para='${s}']`));

    /**
     * A lista de quem precisa de regra vem do **registro**, não escrita aqui.
     *
     * Ela era escrita à mão, com quinze nomes, e foi assim que `lgpd` e `plano`
     * entraram em `MODULOS`, ficaram sem regra de CSS e o teste continuou verde
     * — duas telas em que o gestor não sabia onde estava, guardadas por uma
     * guarda desligada em silêncio. É o mesmo defeito que `secoes.ts` conta ter
     * corrigido no CSS, reaparecido um nível acima, no teste.
     *
     * Só as telas **listadas** viram link; as de `dentro` (ficha do cliente,
     * comanda aberta) não aparecem na barra e não têm link para acender.
     */
    const listadas = new Set<string>(MODULOS.flatMap((m) => m.telas.map((t) => t.secao)));

    expect(semRegra.filter((s) => listadas.has(s))).toEqual([]);
  });

  it('o CSS não volta a enumerar seção para acender módulo', () => {
    // A regressão que esta linha impede: alguém acrescenta uma tela e, em vez
    // de registrá-la no casco, cola mais um seletor nas listas. Aí a lista
    // volta a crescer e volta a ser esquecível.
    const enumeracoes = css.match(
      /\.casco:has\(\[data-secao='[a-z-]+'\]\) \.(trilho__botao|contexto__bloco)/g,
    );

    expect(enumeracoes).toBeNull();
  });

  it('não existe mais o desvio que escondia a tela sem seção', () => {
    expect(css).not.toContain(':not(:has([data-secao]))');
  });
});

describe('secao()', () => {
  it('devolve a seção e o módulo dono dela', () => {
    expect(secao('caixa')).toEqual({ 'data-secao': 'caixa', 'data-modulo-atual': 'financeiro' });
    expect(secao('cliente')).toEqual({ 'data-secao': 'cliente', 'data-modulo-atual': 'atendimento' });
  });

  it('recusa seção fora do casco', () => {
    // O tipo já barra em tempo de compilação; a exceção existe para quem
    // alargar `Secao` à mão sem registrar a seção num módulo.
    expect(() => secao('inventada' as Secao)).toThrow(/fora do casco/);
  });
});

/**
 * A navegação é o contexto do casco, e só ele (correção de fluxo, depois do bloco 36).
 *
 * Existiam duas barras escritas à mão — `BalcaoNav` e `CadastroNav` — e as duas
 * discordavam do registro:
 *
 * - a `BalcaoNav` listava **Dia · Agenda · Fila · Caixa · Fiado · Comissão**,
 *   misturando dois módulos, e **não** tinha Comanda. As telas de comanda a
 *   desenhavam mesmo assim, com `atual="/admin/comanda"`, que não casava com
 *   nada — nenhuma aba acendia;
 * - e Dia, Agenda e Fila **não a desenhavam**. Ela oferecia atalho para três
 *   telas que, abertas, não tinham barra nenhuma.
 *
 * A correção não foi uma terceira barra: foi apagar as duas. O contexto do
 * casco já lista exatamente as telas do módulo aberto, derivadas de `MODULOS`,
 * **em qualquer largura** — é um bloco `display: flex` que rola na horizontal,
 * condicional por seção e não por tamanho de tela. As barras eram o mesmo link
 * duas vezes no DOM, que é justamente o que o casco documenta ter removido.
 */
describe('a navegação não é reescrita à mão', () => {
  const arquivos = paginasDoPainel();

  it('nenhuma tela desenha barra própria de navegação', () => {
    // Uma terceira lista volta a divergir na primeira tela nova — foi assim que
    // as duas primeiras divergiram.
    const proprias: string[] = [];
    for (const arquivo of arquivos) {
      const conteudo = readFileSync(arquivo, 'utf8');
      for (const barra of ['<BalcaoNav', '<CadastroNav', '<ModuloNav']) {
        if (conteudo.includes(barra)) proprias.push(`${relative(AQUI, arquivo)}: ${barra}`);
      }
    }
    expect(proprias).toEqual([]);
  });

  it('todo módulo tem pelo menos um destino no contexto', () => {
    // Módulo sem tela é um ícone no trilho que abre uma lista vazia: a pessoa
    // toca e não acontece nada.
    for (const modulo of MODULOS) {
      expect(modulo.telas.length, modulo.id).toBeGreaterThan(0);
    }
  });

  it('toda seção de tela pertence a um módulo', () => {
    /**
     * `moduloDaSecao` é o que decide qual bloco do contexto aparece. Seção órfã
     * significaria uma tela onde nenhum módulo acende — e o casco tinha um
     * desvio que caía em "Operação" para esse caso, justamente o que foi
     * removido por mentir sobre onde a pessoa estava.
     */
    for (const modulo of MODULOS) {
      for (const tela of modulo.telas) {
        expect(moduloDaSecao(tela.secao), tela.secao).toBe(modulo.id);
      }
      for (const dentro of modulo.dentro) {
        expect(moduloDaSecao(dentro), dentro).toBe(modulo.id);
      }
    }
  });
});
