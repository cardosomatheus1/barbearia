import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROTULO_DO_ESTADO, VERBO_CURTO, VERBO_DA_ACAO } from '@barbearia/core';

/**
 * O vocabulário das transições não volta a divergir (correção de fluxo, depois do bloco 36).
 *
 * A guarda existe porque o defeito reapareceria sozinho: escrever `'Começar'`
 * numa tela nova é mais rápido que importar o mapa, e nenhum outro teste
 * reprovaria — cada tela, sozinha, continua coerente. O que estava errado era o
 * produto ter três nomes para a mesma coisa, e isso só aparece olhando as três
 * juntas.
 */

const RAIZ = join(process.cwd(), 'src/app/admin');

/**
 * Tira comentário antes de varrer.
 *
 * Sem isto, o teste reprova a **explicação** do defeito: os comentários que
 * contam por que "Começar" saiu citam a palavra entre aspas. Guarda que proíbe
 * documentar o próprio motivo é guarda que alguém apaga.
 */
function semComentarios(fonte: string): string {
  return fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function telas(pasta: string): string[] {
  const achados: string[] = [];
  for (const nome of readdirSync(pasta)) {
    const caminho = join(pasta, nome);
    if (statSync(caminho).isDirectory()) {
      achados.push(...telas(caminho));
    } else if (nome.endsWith('.tsx') || (nome.endsWith('.ts') && !nome.endsWith('.test.ts'))) {
      achados.push(caminho);
    }
  }
  return achados;
}

/**
 * O que se proíbe é **definir o mapa**, não usar as palavras.
 *
 * A primeira versão deste teste procurava os textos antigos ("Começar",
 * "esperando") e reprovava um `id` de HTML e a prosa de uma frase de ajuda —
 * português legítimo. Guarda que reprova o certo é guarda que alguém desliga.
 *
 * O defeito real tem forma reconhecível: uma tela escrevendo `in_progress:
 * 'alguma coisa'`, isto é, montando o próprio dicionário de estado em vez de
 * importar o do domínio. É isso que se procura.
 */
const CHAVES_DE_MAPA = ['in_progress:', 'checked_in:', 'no_show:', 'undo_no_show:'];

/**
 * As três que mostram estado de atendimento.
 *
 * É onde a divergência nasceu e onde ela custa: o balcão e o barbeiro trabalham
 * no mesmo salão, falando um com o outro em voz alta.
 */
const TELAS_DE_ATENDIMENTO = ['dia/page.tsx', 'meu-dia/page.tsx', 'agenda/page.tsx'];

describe('o vocabulário mora em um lugar só', () => {
  const arquivos = telas(RAIZ);

  it('as telas de atendimento não definem o próprio dicionário de estado', () => {
    /**
     * Escopo nas três, e não no painel inteiro. Duas coisas parecidas são
     * legítimas e ficam de fora:
     *
     * - **mapa de classe CSS** (`in_progress: 'selo--agora'`) não é vocabulário,
     *   é estilo — e o valor denuncia qual é qual;
     * - **a ficha do cliente** fala de outro ângulo: ali o sujeito é o cliente,
     *   e "Cancelou" é certo onde o balcão diz "Cancelado pelo cliente".
     */
    const reincidentes: string[] = [];
    for (const tela of TELAS_DE_ATENDIMENTO) {
      const conteudo = semComentarios(readFileSync(join(RAIZ, tela), 'utf8'));
      for (const chave of CHAVES_DE_MAPA) {
        const achado = new RegExp(`${chave}\\s*'([^']+)'`).exec(conteudo);
        // Valor em minúscula sem espaço é nome de classe, não texto de tela.
        if (achado?.[1] && !/^[a-z][a-z0-9-]*$/.test(achado[1])) {
          reincidentes.push(`${tela}: ${chave} '${achado[1]}'`);
        }
      }
    }
    expect(reincidentes).toEqual([]);
  });

  it('as telas de atendimento importam o vocabulário em vez de escrevê-lo', () => {
    /**
     * As três que mostram estado de atendimento: o balcão, o barbeiro e a
     * agenda. Elas são o lugar onde a divergência nasceu, e onde ela custa —
     * as duas primeiras pessoas trabalham no mesmo salão.
     */
    for (const tela of ['dia/page.tsx', 'meu-dia/page.tsx', 'agenda/page.tsx']) {
      const conteudo = readFileSync(join(RAIZ, tela), 'utf8');
      expect(conteudo, tela).toContain("from '@barbearia/core'");
      expect(
        conteudo.includes('ROTULO_DO_ESTADO') || conteudo.includes('VERBO_'),
        `${tela} importa o vocabulário`,
      ).toBe(true);
    }
  });

  it('as duas telas que cobram leem a mesma definição de cobrável', () => {
    /**
     * O cartão do dia e a lista de "Cobrar" respondem à mesma pergunta sobre a
     * mesma consulta. Cada uma tinha o próprio `new Set([...])`, e bastava
     * acrescentar um estado num lugar para o balcão ver a pessoa cobrável numa
     * tela e não na outra — sem nada ficar vermelho, porque as duas continuam
     * corretas sozinhas.
     */
    for (const tela of ['dia/page.tsx', 'comanda/page.tsx']) {
      const conteudo = semComentarios(readFileSync(join(RAIZ, tela), 'utf8'));
      expect(conteudo, tela).toContain('ESTADOS_COBRAVEIS');
      expect(conteudo, `${tela} não redefine a lista`).not.toMatch(/new Set\(\[\s*'in_progress'/);
    }
  });

  it('o painel do dia oferece cobrança a quem já sentou', () => {
    // Encerrar o corte e ter que procurar a mesma pessoa numa segunda lista era
    // o passo mais frequente do balcão custando cinco toques.
    const dia = semComentarios(readFileSync(join(RAIZ, 'dia/page.tsx'), 'utf8'));
    expect(dia).toContain('acaoAbrirComanda');
    // Escondido de quem a API recusaria: botão que só dá erro é pior que
    // botão ausente para quem opera.
    expect(dia).toContain("podeNaTela(estado, 'cashier.open')");
  });

  it('o mapa que as telas usam é o do domínio, e está completo', () => {
    // Um mapa parcial devolveria `undefined` no botão de um estado raro — e o
    // caminho raro é justamente o que ninguém exercita antes de produção.
    expect(Object.values(ROTULO_DO_ESTADO).every(Boolean)).toBe(true);
    expect(Object.values(VERBO_DA_ACAO).every(Boolean)).toBe(true);
    expect(Object.values(VERBO_CURTO).every(Boolean)).toBe(true);
  });
});
