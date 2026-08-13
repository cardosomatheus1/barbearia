import {
  DIMENSOES,
  METRICAS,
  type ChaveDeMetrica,
  type DefinicaoDeMetrica,
  type DimensaoDaMetrica,
} from './metrica.js';

/**
 * Do português para uma entrada do catálogo (bloco 64, SPEC §4.15).
 *
 * ## O que este arquivo **não** faz
 *
 * Ele não lê banco, não decide permissão e não responde nada. Ele produz um
 * **palpite**: qual métrica, qual dimensão, qual período. Quem valida é
 * `validarPergunta`, e quem responde é a borda — o bloco 63 já montou os dois.
 *
 * Essa separação é a segurança inteira do assistente. O tradutor pode errar, ser
 * enganado por um texto malicioso ou um dia ser trocado por um modelo de
 * linguagem: nada disso alcança o banco, porque a saída dele é uma chave de um
 * conjunto fechado que ainda vai passar pela validação e pela permissão.
 *
 * ## Por que determinístico, e não um modelo
 *
 * Não há provedor de IA contratado neste produto, e escrever a integração agora
 * seria a mesma coisa que o `blocks` do bloco 8 — um parâmetro aceito que ninguém
 * preenche. O que existe é o **contrato**: `Interpretador`. Esta implementação é
 * a local, pelo mesmo desenho de `PaymentProvider` e `WhatsAppProvider`, que têm
 * uma `fake` desde o começo.
 *
 * E ela não é um remendo: as sete perguntas que a SPEC §4.15 lista são sobre um
 * vocabulário pequeno e estável — faturamento, ticket, barbeiro, vazio, churn,
 * falta, margem. Casar palavra-chave resolve todas, responde em micros­segundos
 * e não manda dado da barbearia para fora. O dia em que a pergunta livre valer o
 * custo, ela entra por trás do mesmo contrato.
 */

export interface Interpretacao {
  readonly metrica: ChaveDeMetrica;
  readonly dimensao: DimensaoDaMetrica;
  /** Dias para trás a partir de hoje. O período é resolvido por quem chama. */
  readonly diasParaTras: number;
  /**
   * O quanto o tradutor acredita, de 0 a 1.
   *
   * Não é probabilidade calibrada — é a mesma honestidade do churn: um número
   * que ordena, não que afirma. Abaixo do piso a tela **pergunta** em vez de
   * responder, que é a escalada que a SPEC §4.16 exige para o agente e vale
   * igual aqui.
   */
  readonly confianca: number;
}

export interface Interpretador {
  interpretar(texto: string): Interpretacao | null;
}

/** Abaixo disto o assistente não responde: ele oferece as opções. */
export const CONFIANCA_MINIMA = 0.5;

/**
 * Tira acento e caixa, para "notícia" e "noticia" casarem.
 *
 * Sem isso o assistente responderia a quem digita com acento e ignoraria quem
 * não digita — e no celular, com uma mão, ninguém digita acento.
 */
function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/**
 * As palavras que apontam para cada métrica.
 *
 * A ordem importa: a primeira que casar vence, e as mais específicas vêm antes.
 * "Quanto perdi com falta" contém "falta" **e** é sobre dinheiro — se `faltas`
 * viesse primeiro, a resposta seria a contagem em vez do prejuízo.
 */
const PISTAS: readonly { readonly metrica: ChaveDeMetrica; readonly palavras: readonly string[] }[] = [
  { metrica: 'perda_por_falta', palavras: ['perdi com falta', 'perda com falta', 'prejuizo com falta', 'quanto perdi'] },
  /**
   * O clube vem **antes** da margem por serviço.
   *
   * "Minha assinatura é rentável" contém "rentável", e sem esta linha a resposta
   * seria a margem dos serviços — a pergunta certa com o número errado, que é o
   * pior desfecho possível para um assistente.
   */
  { metrica: 'rentabilidade_do_clube', palavras: ['assinatura e rentavel', 'assinatura rentavel', 'clube da lucro', 'clube e rentavel', 'margem do clube', 'assinatura da lucro'] },
  { metrica: 'margem_por_servico', palavras: ['margem', 'lucro', 'rende mais', 'da mais lucro', 'rentavel'] },
  { metrica: 'ticket_medio', palavras: ['ticket', 'gasto medio', 'media por comanda', 'media por cliente'] },
  { metrica: 'clientes_em_risco', palavras: ['risco', 'churn', 'indo embora', 'sumindo', 'abandono'] },
  { metrica: 'ocupacao', palavras: ['ocupacao', 'vazio', 'vazios', 'cheio', 'agenda cheia', 'buraco'] },
  { metrica: 'faltas', palavras: ['falta', 'faltas', 'faltaram', 'no show', 'nao apareceu'] },
  { metrica: 'atendimentos', palavras: ['atendimento', 'atendi', 'quantos cortes', 'cortes', 'clientes atendidos'] },
  { metrica: 'faturamento', palavras: ['faturei', 'faturamento', 'receita', 'vendi', 'entrou', 'caixa'] },
];

/** As palavras que pedem uma quebra. */
const PISTAS_DE_DIMENSAO: readonly {
  readonly dimensao: DimensaoDaMetrica;
  readonly palavras: readonly string[];
}[] = [
  { dimensao: 'profissional', palavras: ['barbeiro', 'profissional', 'cada um', 'por pessoa', 'quem'] },
  { dimensao: 'servico', palavras: ['servico', 'servicos', 'corte ou barba'] },
  { dimensao: 'unidade', palavras: ['unidade', 'loja', 'filial'] },
];

/**
 * As janelas que se diz em voz alta, e quantos dias cada uma vale.
 *
 * "Este mês" são trinta dias para trás e não o primeiro dia do mês corrente, de
 * propósito: quem pergunta no dia 2 quer saber como está indo, e "faturamento do
 * mês" no dia 2 é um número quase vazio que assusta sem motivo. A resposta diz o
 * período que usou — é a exigência da SPEC —, então não há engano possível.
 */
const JANELAS: readonly { readonly palavras: readonly string[]; readonly dias: number }[] = [
  { palavras: ['hoje'], dias: 1 },
  { palavras: ['ontem'], dias: 2 },
  { palavras: ['esta semana', 'essa semana', 'semana'], dias: 7 },
  { palavras: ['quinzena', 'ultimos 15'], dias: 15 },
  { palavras: ['este mes', 'esse mes', 'mes', 'mensal'], dias: 30 },
  { palavras: ['trimestre', 'ultimos 3 meses', '90 dias'], dias: 90 },
  { palavras: ['ano', 'anual', '12 meses'], dias: 365 },
];

/**
 * Quantos dias a resposta cobre quando ninguém disse o período.
 *
 * O nome diz **da pergunta** porque `JANELA_PADRAO_DIAS` já existe no barril e
 * quer dizer outra coisa. É a segunda colisão deste tipo depois de
 * `PESO_DO_ATRASO`, e as duas só apareceram no `tsc` — o `vitest` roda por
 * esbuild e não vê.
 */
export const JANELA_PADRAO_DA_PERGUNTA = 30;

/**
 * O tipo é o **largo**, não o inferido do `as const`.
 *
 * Sem a anotação, o valor do mapa é a união das tuplas literais de cada métrica,
 * e `dimensoes.includes(...)` passa a exigir exatamente o literal daquela
 * entrada — `readonly ["nenhuma"]` recusa `"profissional"` em tempo de
 * compilação, o que é o oposto do que a checagem existe para fazer.
 */
const CATALOGO = new Map<ChaveDeMetrica, DefinicaoDeMetrica>(
  METRICAS.map((m) => [m.chave as ChaveDeMetrica, m]),
);

/**
 * O interpretador local.
 *
 * Devolve `null` quando não reconhece nada — e `null` é uma resposta legítima,
 * não um caso degradado: a tela mostra as sugestões, que é melhor que responder
 * a pergunta errada com um número que parece certo.
 */
export const interpretadorLocal: Interpretador = {
  interpretar(texto: string): Interpretacao | null {
    const t = normalizar(texto);
    if (t.trim().length === 0) return null;

    const achada = PISTAS.find((p) => p.palavras.some((w) => t.includes(w)));
    if (!achada) return null;

    const definicao = CATALOGO.get(achada.metrica);
    if (!definicao) return null;

    /**
     * A dimensão só entra se a métrica a aceita.
     *
     * "Quantos clientes em risco por barbeiro" não quer dizer nada, e propor uma
     * dimensão que a validação vai recusar transformaria uma pergunta razoável
     * numa mensagem de erro. Sem a dimensão, ela é respondida.
     */
    const pedida = PISTAS_DE_DIMENSAO.find((d) => d.palavras.some((w) => t.includes(w)));
    const dimensao: DimensaoDaMetrica =
      pedida && definicao.dimensoes.includes(pedida.dimensao) ? pedida.dimensao : 'nenhuma';

    const janela = JANELAS.find((j) => j.palavras.some((w) => t.includes(w)));

    /**
     * A confiança sobe com o que foi reconhecido, e não é um número mágico.
     *
     * Métrica achada é o piso; dizer o período e pedir uma quebra são sinais de
     * que a pessoa sabia o que estava perguntando. Uma pergunta que só bate a
     * métrica fica no piso — e o piso é justamente `CONFIANCA_MINIMA`, então ela
     * é respondida com o período padrão declarado na resposta.
     */
    let confianca = CONFIANCA_MINIMA;
    if (janela) confianca += 0.3;
    if (pedida && dimensao !== 'nenhuma') confianca += 0.2;

    return {
      metrica: achada.metrica,
      dimensao,
      diasParaTras: janela?.dias ?? JANELA_PADRAO_DA_PERGUNTA,
      confianca: Math.min(1, confianca),
    };
  },
};

/**
 * O período de uma interpretação, em datas.
 *
 * `hoje` entra por parâmetro pela razão de sempre: a janela é uma função do
 * relógio, e um `new Date()` aqui tornaria o resultado impossível de testar sem
 * esperar o tempo passar.
 */
export function periodoDaInterpretacao(
  interpretacao: Interpretacao,
  hoje: Date,
): { readonly de: string; readonly ate: string } {
  const ate = hoje.toISOString().slice(0, 10);
  const de = new Date(hoje.getTime() - (interpretacao.diasParaTras - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return { de, ate };
}

/** Só para o teste de completude não depender de importar o módulo inteiro. */
export const DIMENSOES_CONHECIDAS = DIMENSOES;
