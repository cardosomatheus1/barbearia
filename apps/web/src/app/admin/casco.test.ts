import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  DESTINOS_GATEADOS,
  MODULOS,
  SECOES_POR_MODULO,
  moduloDaSecao,
  modulosVisiveis,
  secao,
  type Secao,
} from './secoes';

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

describe('os subgrupos do menu', () => {
  /**
   * O registro pelo tipo largo, e não `MODULOS` direto.
   *
   * `MODULOS` é `as const` — cada destino tem um tipo próprio, sem `grupo`
   * naqueles que não o declaram, e `tela.grupo` ali não compila. `modulosVisiveis`
   * já devolve `ModuloDoPainel[]`; passar todos os recursos ligados dá o
   * registro inteiro sem um segundo nome exportado para a mesma lista.
   *
   * Passando tudo ligado de propósito: um recurso desligado esconderia telas e
   * as guardas de agrupamento deixariam de ver o registro completo.
   */
  const TODOS = modulosVisiveis(DESTINOS_GATEADOS.map((d) => d.recurso));

  it('nenhum grupo tem o nome de uma tela do próprio módulo', () => {
    /**
     * "Resultado > Resultado" põe dois rótulos iguais na mesma coluna, e só um
     * deles é link. Quem opera lê a coluna de cima para baixo e não tem como
     * saber qual é qual — é a §6 pergunta 2 dentro de uma tela só.
     */
    const colisoes: string[] = [];
    for (const modulo of TODOS) {
      const nomes = new Set(modulo.telas.map((t) => t.nome.toLowerCase()));
      for (const tela of modulo.telas) {
        if (tela.grupo && nomes.has(tela.grupo.toLowerCase())) {
          colisoes.push(`${modulo.id}: grupo "${tela.grupo}" tem o nome de uma tela`);
        }
      }
    }
    expect([...new Set(colisoes)]).toEqual([]);
  });

  it('cada grupo aparece uma vez só, e em telas seguidas', () => {
    /**
     * O casco emite o rótulo quando o grupo **muda**. Um grupo interrompido e
     * retomado desenharia o mesmo título duas vezes na mesma coluna — e o
     * segundo bloco pareceria outra coisa com o mesmo nome.
     */
    const repetidos: string[] = [];
    for (const modulo of TODOS) {
      const vistos = new Set<string>();
      let anterior: string | undefined;
      for (const tela of modulo.telas) {
        const grupo = tela.grupo;
        if (grupo !== anterior && grupo !== undefined) {
          if (vistos.has(grupo)) repetidos.push(`${modulo.id}: "${grupo}" volta depois de outro grupo`);
          vistos.add(grupo);
        }
        anterior = grupo;
      }
    }
    expect(repetidos).toEqual([]);
  });

  it('ou o módulo agrupa tudo, ou não agrupa nada', () => {
    // Metade agrupada e metade solta produz telas órfãs boiando abaixo do
    // último subgrupo, que a pessoa lê como se pertencessem a ele.
    for (const modulo of TODOS) {
      const comGrupo = modulo.telas.filter((t) => t.grupo).length;
      expect([0, modulo.telas.length], `${modulo.id} agrupa pela metade`).toContain(comGrupo);
    }
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

  it('cada módulo tem as regras que o acendem no trilho e revelam o contexto', () => {
    /**
     * O CSS **precisa** enumerar módulo, e é a mesma limitação de seletor da
     * seção: casar `data-modulo-atual` com `data-modulo` é comparar o valor de
     * dois atributos. O que dá para fazer é cobrar a lista, e é o que faltava.
     *
     * O bloco 82 partiu "Administração" — dezesseis destinos — em Marketing,
     * Integrações e Administração. Sem esta guarda, um módulo novo entraria no
     * registro, apareceria no trilho, e **não acenderia**: o ícone ficaria
     * apagado e o bloco de contexto dele nunca apareceria, que é o defeito de
     * `lgpd` e `plano` um nível acima. Nada ficaria vermelho.
     *
     * As quatro formas são as que existem no arquivo, e a última mora dentro da
     * media query de 1024px — o notebook, onde o trilho vira coluna.
     */
    const formas = (m: string) => [
      `.casco:has([data-modulo-atual='${m}']) .trilho__botao[data-modulo='${m}']`,
      `.casco:has([data-modulo-atual='${m}']) .trilho__botao[data-modulo='${m}'] svg`,
      `.casco:has([data-modulo-atual='${m}']) .trilho__botao[data-modulo='${m}']::after`,
      `.casco:has([data-modulo-atual='${m}']) .contexto__bloco[data-modulo='${m}']`,
    ];

    /**
     * Conta ocorrências, não presença — e a primeira versão desta guarda
     * passava sem isso.
     *
     * Duas das quatro formas existem em **dois** lugares: uma vez na base e
     * outra dentro da media query de 1024px. Perguntando `includes`, apagar a
     * regra do notebook deixava a guarda verde pela cópia do celular — a tela
     * larga é justamente onde o trilho vira coluna e o traço do módulo aceso
     * muda de lado.
     *
     * O número esperado não é escrito: é o de qualquer outro módulo. Assim uma
     * forma nova, num lugar novo, nasce cobrada em todos eles.
     */
    const quantas = (agulha: string) => css.split(agulha).length - 1;
    const referencia = formas(MODULOS[0]?.id ?? 'inicio').map(quantas);
    expect(referencia.every((n) => n > 0), 'o módulo de referência não tem regra nenhuma').toBe(true);

    const divergentes: string[] = [];
    for (const modulo of MODULOS) {
      formas(modulo.id).forEach((forma, i) => {
        const achadas = quantas(forma);
        if (achadas !== referencia[i]) {
          divergentes.push(`${modulo.id}: ${achadas} de ${referencia[i]} — ${forma}`);
        }
      });
    }
    expect(
      divergentes,
      'módulo sem regra de CSS: o ícone não acende, ou o bloco de contexto não aparece numa das larguras.',
    ).toEqual([]);
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

/**
 * Tela que a plataforma liga: some do menu **e** fecha a porta.
 *
 * O fiscal entrou assim no bloco 81 — `FISCAL_MODO` é `nenhum`, não há emissor
 * contratado, e quem decide quando a nota estreia é a plataforma, uma conta de
 * cada vez. Fila, importação e avisos já eram gateados na API desde o bloco 26
 * e continuavam no menu: o link existia, a tela abria, e a API respondia 404
 * dentro dela. Estado de erro no lugar de "isto não existe aqui".
 *
 * Os dois testes abaixo fecham as duas metades, e a segunda é a que se perde:
 * esconder o link não fecha o endereço, e quem tem a tela salva no navegador
 * chega lá do mesmo jeito.
 */
describe('tela ligada pela plataforma', () => {
  const gateadas = DESTINOS_GATEADOS;

  it('há telas gateadas — senão os dois testes abaixo passam por vacuidade', () => {
    expect(gateadas.length).toBeGreaterThan(0);
  });

  it('o destino some do menu quando o recurso está desligado, e volta quando liga', () => {
    for (const tela of gateadas) {
      const codigo = tela.recurso;
      const outros = gateadas.map((t) => t.recurso).filter((c) => c !== codigo);

      const sem = modulosVisiveis(outros).flatMap((m) => m.telas.map((t) => t.href));
      expect(sem, `${tela.href} continua no menu com ${codigo} desligado`).not.toContain(tela.href);

      const com = modulosVisiveis([...outros, codigo]).flatMap((m) => m.telas.map((t) => t.href));
      expect(com, `${tela.href} sumiu com ${codigo} ligado`).toContain(tela.href);
    }
  });

  it('o que não depende de recurso aparece com a lista vazia', () => {
    // Uma barbearia sem recurso nenhum ligado é o caso comum — é o padrão do
    // catálogo. Se o filtro errasse a polaridade, o painel inteiro sumiria.
    const semNada = modulosVisiveis([]).flatMap((m) => m.telas);
    const todas = MODULOS.reduce((n, m) => n + m.telas.length, 0);
    expect(semNada.length).toBe(todas - gateadas.length);
    expect(semNada.every((t) => !t.recurso)).toBe(true);
  });

  it('toda tela gateada fecha a própria porta com exigirRecurso', () => {
    /**
     * Derivado do registro, e não de uma lista escrita ao lado: o destino que
     * alguém marcar com `recurso` no bloco seguinte nasce cobrado. Uma lista
     * paralela seria a que ninguém atualiza — é o defeito que `secoes.ts` já
     * custou uma vez.
     */
    const faltando: string[] = [];
    for (const tela of gateadas) {
      const caminho = join(AQUI, tela.href.replace('/admin/', ''), 'page.tsx');
      const fonte = readFileSync(caminho, 'utf8');
      if (!fonte.includes(`exigirRecurso(estado, '${tela.recurso}')`)) {
        faltando.push(`${tela.href} — falta exigirRecurso(estado, '${tela.recurso}')`);
      }
    }
    expect(
      faltando,
      'esconder o link do menu não fecha a tela: o endereço continua digitável, e quem o tem ' +
        'salvo chega a uma página que pede à API algo que ela responde 404.',
    ).toEqual([]);
  });
});
