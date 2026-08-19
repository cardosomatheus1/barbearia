import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A semente de demonstração **não inventa** o que o produto não faz (bloco 101).
 *
 * ## O defeito
 *
 * A semente criava uma automação `tipo: 'pedido_de_avaliacao'`, **ligada**, com
 * disparos dando "4 enviadas · 1 alcançou o objetivo". Nada disso existe:
 * `pedido_de_avaliacao` é valor de `notification_kind` desde o bloco 46 e
 * nenhum código o usa — não há texto, não há variáveis, não há envio.
 *
 * E gravava `skipped_reason: 'sem_consentimento'` e `'janela_de_silencio'`, dois
 * motivos que nenhum código escreve. O produto de verdade grava
 * `optou_por_nao_receber` e `fora_da_janela`.
 *
 * ## Por que isso é caro
 *
 * Quem abre a demonstração não consegue separar **o que está pronto** do que
 * não está: a tela mostra número, contador e resultado para um recurso que não
 * existe. É o oposto da regra do projeto — *"gatilho ou opção que ainda não
 * funciona aparece na tela marcado, nunca escondido"* —, e é pior que esconder,
 * porque tem número do lado.
 *
 * E contamina para fora: a lista de "quem não recebeu" mostrava o identificador
 * cru da coluna porque o domínio não conhecia o motivo inventado, e o conserto
 * apressado foi **ampliar o vocabulário do domínio** para caber a invenção.
 * A semente passou a decidir o que o produto diz que sabe fazer.
 *
 * ## O que a guarda cobra
 *
 * Os dois vocabulários fechados que a semente escreve — tipo de aviso e motivo
 * de pulo — saem do domínio, lido do fonte. Nunca de uma lista ao lado.
 */

const SEMENTES = ['scripts/semear-demo.mjs', 'scripts/semear-detalhes.mjs'];

function fonte(caminho) {
  return readFileSync(caminho, 'utf8');
}

/** Tira comentário: a guarda não pode reprovar a explicação do próprio defeito. */
function semComentarios(texto) {
  return texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** As constantes do domínio, lidas do fonte — nunca copiadas para cá. */
function listaDoDominio(arquivo, nome) {
  const texto = readFileSync(arquivo, 'utf8');
  const bloco = new RegExp(`${nome}[^=]*=\\s*\\[([\\s\\S]*?)\\]`).exec(texto);
  if (!bloco) throw new Error(`não achei ${nome} em ${arquivo}`);
  return [...bloco[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
}

function chavesDoMapa(arquivo, nome) {
  const texto = readFileSync(arquivo, 'utf8');
  const bloco = new RegExp(`${nome}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`).exec(texto);
  if (!bloco) throw new Error(`não achei ${nome} em ${arquivo}`);
  return [...bloco[1].matchAll(/^\s{2}([a-z0-9_]+):/gm)].map((m) => m[1]);
}

describe('a semente não inventa', () => {
  it('só cria automação de um tipo que o produto sabe mandar', () => {
    const permitidos = listaDoDominio('packages/core/src/notificacao.ts', 'TIPOS_DE_CAMPANHA');
    const inventados = [];

    for (const caminho of SEMENTES) {
      /**
       * A âncora é o `gatilho:` na mesma linha, e não o `tipo:` solto.
       *
       * Com o `tipo:` sozinho a guarda acusava `tipo: 'service'` de um item de
       * comanda e `tipo: 'resale'` de um produto — dezessete falsos. Automação
       * é o que tem gatilho; é isso que a define.
       */
      for (const linha of semComentarios(fonte(caminho)).split('\n')) {
        if (!linha.includes('gatilho:')) continue;
        const achado = /tipo:\s*'([a-z0-9_]+)'/.exec(linha);
        if (achado && !permitidos.includes(achado[1])) {
          inventados.push(`${caminho}: ${achado[1]}`);
        }
      }
    }

    expect(
      inventados,
      'a semente cria automação de um tipo que o produto não manda — ela fabrica ' +
        'resultado para um recurso que não existe',
    ).toEqual([]);
  });

  it('só grava motivo de pulo que o produto escreve', () => {
    const conhecidos = chavesDoMapa('packages/core/src/automacao.ts', 'RESUMO_DO_PULO');
    const inventados = [];

    for (const caminho of SEMENTES) {
      const texto = semComentarios(fonte(caminho));
      for (const achado of texto.matchAll(/skipped_reason:[^,\n]*?'([a-z0-9_]+)'/g)) {
        if (!conhecidos.includes(achado[1])) inventados.push(`${caminho}: ${achado[1]}`);
      }
    }

    expect(
      inventados,
      'a semente grava um motivo que nenhum código escreve — e foi assim que o ' +
        'vocabulário do domínio foi ampliado para caber invenção dela',
    ).toEqual([]);
  });

  it('a guarda enxerga as duas listas do domínio', () => {
    // Sem isto, um `regex` que deixasse de casar tornaria as duas de cima
    // verdes por não terem nada a comparar — o teste passando pelo motivo
    // errado, que é o defeito que este repositório mais cataloga.
    expect(listaDoDominio('packages/core/src/notificacao.ts', 'TIPOS_DE_CAMPANHA').length)
      .toBeGreaterThan(0);
    expect(chavesDoMapa('packages/core/src/automacao.ts', 'RESUMO_DO_PULO').length)
      .toBeGreaterThan(5);
  });
});
