/**
 * Leitura de CSV — o formato em que a base da barbearia realmente chega.
 *
 * A SPEC §5.8 lista as fontes: SalonSoft, AppBarber, Trinks, Belle, planilha,
 * agenda de papel. Na prática todas viram um arquivo exportado do Excel, e é
 * esse arquivo que precisa entrar sem que ninguém edite nada à mão.
 *
 * ## Por que não uma dependência
 *
 * O formato cabe em duzentas linhas e o que ele exige é *tolerância a exportador
 * mal-educado*, não conformidade com a RFC 4180 — que nenhum dos exportadores
 * acima segue. Uma biblioteca traria a RFC e não traria o que falta aqui:
 * separador `;`, BOM do Excel brasileiro e linha com número de colunas errado.
 * `packages/core` também não depende de nada por regra (CLAUDE.md §4), e um
 * parser de CSV é lógica pura — exatamente o que mora aqui.
 *
 * ## O que ele tolera de propósito
 *
 * - **BOM.** O Excel em Windows escreve `﻿` antes da primeira coluna. Sem
 *   removê-lo, o cabeçalho `Nome` nunca casa com o alias `nome` e a importação
 *   inteira falha dizendo que não achou a coluna que está lá na frente.
 * - **`;` como separador.** É o padrão do Excel em português, porque a vírgula é
 *   o separador decimal. Detectar errado devolve uma coluna só com tudo dentro.
 * - **CRLF, LF e CR sozinho.** O último é exportador antigo de Mac, e ainda
 *   aparece.
 * - **Linha com colunas a menos ou a mais.** Numa base de mil clientes existe
 *   sempre a linha estragada, e derrubar o arquivo inteiro por causa dela é o
 *   comportamento que faz a barbearia desistir da migração. Falta vira vazio,
 *   sobra é preservada para quem chamou decidir.
 */

export interface Csv {
  readonly cabecalho: readonly string[];
  readonly linhas: readonly (readonly string[])[];
  /** O separador que foi usado. Devolvido para a tela poder explicar a leitura. */
  readonly separador: string;
}

export type CsvErro = 'vazio' | 'sem_cabecalho' | 'aspas_abertas';

export class CsvInvalidoError extends Error {
  constructor(readonly code: CsvErro) {
    super(`CSV inválido: ${code}`);
    this.name = 'CsvInvalidoError';
  }
}

const SEPARADORES = [',', ';', '\t'] as const;

/**
 * Qual separador o arquivo usa.
 *
 * Conta ocorrências **fora de aspas** na primeira linha não vazia: um cabeçalho
 * `"Nome, Sobrenome";Telefone` tem duas vírgulas dentro de um campo só, e contar
 * cru escolheria a vírgula e quebraria tudo.
 *
 * Empate vai para o `;`, que é o do Excel em português — a fonte mais comum.
 */
export function detectarSeparador(texto: string): string {
  const primeira = primeiraLinhaLogica(semBom(texto));

  let melhor = ';';
  let maior = 0;

  for (const candidato of SEPARADORES) {
    let contagem = 0;
    let dentroDeAspas = false;

    for (let i = 0; i < primeira.length; i += 1) {
      const char = primeira[i];
      if (char === '"') {
        dentroDeAspas = !dentroDeAspas;
        continue;
      }
      if (!dentroDeAspas && char === candidato) contagem += 1;
    }

    if (contagem > maior) {
      maior = contagem;
      melhor = candidato;
    }
  }

  return melhor;
}

const semBom = (texto: string): string =>
  texto.charCodeAt(0) === 0xfeff ? texto.slice(1) : texto;

/** A primeira linha respeitando aspas — um campo pode conter quebra de linha. */
function primeiraLinhaLogica(texto: string): string {
  let dentroDeAspas = false;

  for (let i = 0; i < texto.length; i += 1) {
    const char = texto[i];
    if (char === '"') {
      dentroDeAspas = !dentroDeAspas;
      continue;
    }
    if (!dentroDeAspas && (char === '\n' || char === '\r')) return texto.slice(0, i);
  }

  return texto;
}

/**
 * Lê o arquivo inteiro.
 *
 * A primeira linha é sempre o cabeçalho. Arquivo sem cabeçalho existe, mas
 * adivinhar qual coluna é o telefone a partir do conteúdo erraria calado — e
 * errar calado numa importação de base é criar mil clientes com o nome trocado
 * pelo telefone.
 */
export function lerCsv(texto: string, separadorPedido?: string): Csv {
  const limpo = semBom(texto);
  if (limpo.trim() === '') throw new CsvInvalidoError('vazio');

  const separador = separadorPedido ?? detectarSeparador(limpo);
  const linhas: string[][] = [];
  let campo = '';
  let atual: string[] = [];
  let dentroDeAspas = false;

  const fecharCampo = () => {
    atual.push(campo);
    campo = '';
  };
  const fecharLinha = () => {
    fecharCampo();
    // Linha inteiramente vazia é separador visual do exportador, não registro.
    if (atual.some((valor) => valor.trim() !== '')) linhas.push(atual);
    atual = [];
  };

  for (let i = 0; i < limpo.length; i += 1) {
    const char = limpo[i];

    if (dentroDeAspas) {
      if (char === '"') {
        // `""` dentro de aspas é uma aspa literal — não o fim do campo.
        if (limpo[i + 1] === '"') {
          campo += '"';
          i += 1;
        } else {
          dentroDeAspas = false;
        }
      } else {
        campo += char;
      }
      continue;
    }

    if (char === '"' && campo === '') {
      dentroDeAspas = true;
      continue;
    }
    if (char === separador) {
      fecharCampo();
      continue;
    }
    if (char === '\r') {
      // CRLF conta como uma quebra só; CR sozinho também quebra.
      if (limpo[i + 1] === '\n') i += 1;
      fecharLinha();
      continue;
    }
    if (char === '\n') {
      fecharLinha();
      continue;
    }

    campo += char;
  }

  if (dentroDeAspas) throw new CsvInvalidoError('aspas_abertas');
  if (campo !== '' || atual.length > 0) fecharLinha();

  const cabecalho = linhas.shift();
  if (!cabecalho) throw new CsvInvalidoError('sem_cabecalho');

  return {
    cabecalho: cabecalho.map((valor) => valor.trim()),
    linhas,
    separador,
  };
}

/**
 * O valor de uma coluna numa linha, já aparado.
 *
 * Índice fora da linha devolve string vazia em vez de estourar: linha curta é
 * dado faltando, e dado faltando é caso de negócio — não de exceção.
 */
export function celula(linha: readonly string[], indice: number | null): string {
  if (indice === null || indice < 0) return '';
  return (linha[indice] ?? '').trim();
}
