/**
 * A recepção digital (bloco 66, SPEC §4.17).
 *
 * > *"Respostas vêm **exclusivamente** dos dados configurados pela barbearia.
 * > Pergunta sem resposta configurada → encaminha a um humano e **registra a
 * > lacuna**, para o dono preencher. Essa lista de lacunas é, sozinha, um
 * > produto útil."*
 *
 * ## "Exclusivamente" é a regra inteira
 *
 * Este arquivo não sabe nada sobre barbearia. Ele recebe **o que a casa
 * cadastrou** — preço, horário, jornada de cada profissional, política de
 * cancelamento — e responde a partir disso. Não há uma frase de conhecimento
 * geral aqui, e não pode passar a haver: a hora que o produto responder "sim,
 * pode levar criança" sem a barbearia ter dito isso, ele estará inventando uma
 * política que alguém vai ter que honrar no balcão.
 *
 * ## O que ele não sabe vira número, não silêncio
 *
 * A pergunta sem resposta não é um caso degradado — é o **dado** que o bloco
 * produz. Uma barbearia que vê *"dezoito pessoas perguntaram se você abre no
 * domingo"* tem uma tarefa; um chatbot que só diz "não sei" tem um problema.
 */

export const ASSUNTOS = [
  'preco',
  'horario_de_funcionamento',
  'jornada_do_profissional',
  'endereco',
  'politica_de_cancelamento',
  'formas_de_pagamento',
] as const;
export type AssuntoDaRecepcao = (typeof ASSUNTOS)[number];

/** O que a barbearia cadastrou, e nada além disso. */
export interface DadosDaCasa {
  readonly servicos: readonly { readonly nome: string; readonly precoCents: number }[];
  readonly diasAbertos: readonly {
    readonly diaDaSemana: number;
    readonly abre: string;
    readonly fecha: string;
  }[];
  readonly profissionais: readonly {
    readonly nome: string;
    readonly diasDaSemana: readonly number[];
  }[];
  readonly endereco: string | null;
  readonly politicaDeCancelamento: string | null;
}

export interface RespostaDaRecepcao {
  readonly assunto: AssuntoDaRecepcao;
  readonly texto: string;
}

const NOME_DO_DIA_LONGO = [
  'domingo',
  'segunda',
  'terça',
  'quarta',
  'quinta',
  'sexta',
  'sábado',
];

function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/**
 * A chave de agrupamento de uma pergunta.
 *
 * **Agrupa pelo assunto quando ele existe**, e só cai no conjunto de palavras
 * quando não existe. É a correção do defeito que apareceu no print da tela: com
 * o conjunto de palavras sozinho, "vcs aceitam pix?", "aceitam pagamento no pix"
 * e "vcs aceitam pix ou so dinheiro mesmo?" viraram três linhas de uma vez cada
 * — e a promessa do bloco é justamente *"dezoito pessoas perguntaram a mesma
 * coisa"*. Frase de gente tem palavra a mais; exigir o mesmo conjunto exato é
 * exigir que duas pessoas digitem igual.
 *
 * O agrupamento por assunto é o certo **aqui** porque esta tabela só recebe o
 * que ficou sem resposta, e o que fica sem resposta é um cadastro que falta:
 * seis perguntas sobre pagamento são uma tarefa, não seis.
 *
 * Colisão entre as duas famílias de chave é impossível: assunto tem `_` e o
 * conjunto de palavras nunca tem, porque a normalização troca tudo que não é
 * letra ou número por espaço.
 */
export function chaveDaPergunta(texto: string): string {
  const assunto = assuntoDaPergunta(texto);
  if (assunto) return assunto;
  return normalizar(texto)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((p) => p.length > 2 && !PALAVRAS_VAZIAS.has(p))
    .sort()
    .join(' ');
}

/**
 * O assunto guardado dentro da chave, quando a chave é um.
 *
 * A tela precisa disto porque o texto cru vence: passado o prazo de guarda, a
 * chave é tudo que sobrou, e sem esta função a linha perderia o "cadastre em
 * Configurações" justamente quando só ela resta.
 */
export function assuntoDaChave(chave: string): AssuntoDaRecepcao | null {
  return (ASSUNTOS as readonly string[]).includes(chave) ? (chave as AssuntoDaRecepcao) : null;
}

/**
 * As palavras que não distinguem uma pergunta de outra.
 *
 * Sem elas na lista, "vocês abrem domingo" e "abrem domingo" viram chaves
 * diferentes — e o contador que existe para agrupar não agrupa nada.
 */
const PALAVRAS_VAZIAS = new Set([
  'voce',
  'voces',
  'vcs',
  'que',
  'qual',
  'quais',
  'como',
  'quanto',
  'quantos',
  'para',
  'com',
  'uma',
  'dos',
  'das',
  'por',
  'aqui',
  'tem',
  'sao',
  'esta',
  'estao',
]);

const PISTAS: readonly { readonly assunto: AssuntoDaRecepcao; readonly palavras: readonly string[] }[] = [
  /**
   * `preco` e `valor` sozinhos, e o motivo é gênero.
   *
   * A lista dizia `preco do` e `valor do`, e com isso *"qual o preço **da**
   * barba?"* não era classificada como pergunta de preço — passava direto para
   * a escalada, e no bloco 107 passou a virar **pedido de horário**, porque a
   * frase nomeia um serviço e tem "queria". Uma lista de preposições fica sempre
   * uma flexão atrás da língua; a palavra sozinha não fica.
   *
   * `quanto` sozinho ficou de fora de propósito: "quanto tempo demora?" é
   * pergunta de duração, e responder com uma tabela de preços seria o produto
   * inventando o assunto.
   */
  { assunto: 'preco', palavras: ['quanto custa', 'preco', 'valor do', 'valor da', 'quanto e', 'quanto fica'] },
  {
    assunto: 'jornada_do_profissional',
    palavras: ['trabalha', 'atende', 'esta la', 'vai estar'],
  },
  {
    assunto: 'horario_de_funcionamento',
    palavras: ['abrem', 'abre', 'que horas', 'funciona', 'fecha', 'aberto', 'domingo', 'feriado'],
  },
  { assunto: 'endereco', palavras: ['onde fica', 'endereco', 'como chego', 'fica onde'] },
  {
    assunto: 'politica_de_cancelamento',
    palavras: ['cancelar', 'desmarcar', 'multa', 'antecedencia', 'politica'],
  },
  /**
   * Por último, e com pistas de verdade.
   *
   * O assunto existia na lista sem uma única palavra que o alcançasse: toda
   * pergunta sobre pagamento caía em "sem assunto reconhecido", e o print da
   * tela mostrou seis linhas assim seguidas. Assunto declarado que nada alcança
   * é o defeito de `blocks` com outra roupa — o motor aceita e ninguém preenche.
   *
   * Depois de `preco` de propósito: "quanto custa no cartão?" é pergunta de
   * preço, e quem responde é o catálogo.
   */
  {
    assunto: 'formas_de_pagamento',
    palavras: ['pix', 'cartao', 'dinheiro', 'debito', 'credito', 'parcel', 'pagar', 'pagamento'],
  },
];

/**
 * Sobre o que a pergunta é, mesmo quando não há resposta para ela.
 *
 * A recepção usa isto para escolher o que responder; a tela do dono usa a
 * **mesma** função para dizer onde se resolve a lacuna. Duas leituras da mesma
 * frase feitas por dois caminhos diferentes acabariam discordando — e a
 * discordância apareceria como a tela mandando o dono para o cadastro errado.
 */
export function assuntoDaPergunta(pergunta: string): AssuntoDaRecepcao | null {
  const t = normalizar(pergunta);
  if (t.trim().length === 0) return null;
  return PISTAS.find((p) => p.palavras.some((w) => t.includes(w)))?.assunto ?? null;
}

/** O nome do assunto na tela, escrito uma vez. */
export const ROTULO_DO_ASSUNTO: Readonly<Record<AssuntoDaRecepcao, string>> = {
  preco: 'Preço de serviço',
  horario_de_funcionamento: 'Horário de funcionamento',
  jornada_do_profissional: 'Jornada do profissional',
  endereco: 'Endereço',
  politica_de_cancelamento: 'Política de cancelamento',
  formas_de_pagamento: 'Formas de pagamento',
};

/**
 * Responde a partir do que a casa cadastrou, ou devolve `null`.
 *
 * `null` significa **escalar e registrar** — não "tentar de novo". A ordem das
 * pistas importa: "João trabalha domingo?" contém "domingo", e sem a jornada do
 * profissional vir antes, a resposta seria o horário da casa em vez do dia dele.
 */
export function responderRecepcao(
  pergunta: string,
  dados: DadosDaCasa,
): RespostaDaRecepcao | null {
  const t = normalizar(pergunta);
  const assunto = assuntoDaPergunta(pergunta);
  if (!assunto) return null;

  switch (assunto) {
    case 'preco': {
      /**
       * O serviço nomeado, se ele estiver na pergunta; senão, a lista inteira.
       *
       * Responder "o corte custa R$ 50" a quem perguntou de barba seria inventar
       * — e responder a lista quando a pessoa nomeou o serviço é preguiça que
       * obriga ela a procurar.
       */
      const nomeado = dados.servicos.find((s) => t.includes(normalizar(s.nome)));
      if (nomeado) {
        return { assunto: 'preco', texto: `${nomeado.nome} custa ${reais(nomeado.precoCents)}.` };
      }
      if (dados.servicos.length === 0) return null;
      return {
        assunto: 'preco',
        texto: dados.servicos
          .slice(0, 5)
          .map((s) => `${s.nome}: ${reais(s.precoCents)}`)
          .join(' · '),
      };
    }

    case 'jornada_do_profissional': {
      const quem = dados.profissionais.find((p) => t.includes(normalizar(p.nome)));
      if (!quem) return null;
      const dia = NOME_DO_DIA_LONGO.findIndex((d) => t.includes(normalizar(d)));
      if (dia >= 0) {
        const trabalha = quem.diasDaSemana.includes(dia);
        return {
          assunto: 'jornada_do_profissional',
          texto: trabalha
            ? `Sim, ${quem.nome} atende ${NOME_DO_DIA_LONGO[dia]}.`
            : `${quem.nome} não atende ${NOME_DO_DIA_LONGO[dia]}.`,
        };
      }
      if (quem.diasDaSemana.length === 0) return null;
      return {
        assunto: 'jornada_do_profissional',
        texto: `${quem.nome} atende ${quem.diasDaSemana.map((d) => NOME_DO_DIA_LONGO[d]).join(', ')}.`,
      };
    }

    case 'horario_de_funcionamento': {
      if (dados.diasAbertos.length === 0) return null;
      const dia = NOME_DO_DIA_LONGO.findIndex((d) => t.includes(normalizar(d)));
      if (dia >= 0) {
        const aberto = dados.diasAbertos.find((d) => d.diaDaSemana === dia);
        return {
          assunto: 'horario_de_funcionamento',
          texto: aberto
            ? `${cap(NOME_DO_DIA_LONGO[dia]!)} abrimos das ${aberto.abre} às ${aberto.fecha}.`
            : `${cap(NOME_DO_DIA_LONGO[dia]!)} não abrimos.`,
        };
      }
      return {
        assunto: 'horario_de_funcionamento',
        texto: dados.diasAbertos
          .map((d) => `${cap(NOME_DO_DIA_LONGO[d.diaDaSemana]!)}: ${d.abre}–${d.fecha}`)
          .join(' · '),
      };
    }

    case 'endereco':
      return dados.endereco ? { assunto: 'endereco', texto: dados.endereco } : null;

    case 'politica_de_cancelamento':
      return dados.politicaDeCancelamento
        ? { assunto: 'politica_de_cancelamento', texto: dados.politicaDeCancelamento }
        : null;

    /**
     * Formas de pagamento não têm cadastro ainda.
     *
     * O assunto existe na lista porque ele **é** uma das perguntas que chegam —
     * e é assim que ele aparece no registro de lacunas em vez de sumir. É a
     * regra do gatilho que ainda não funciona: ele aparece marcado, nunca
     * escondido.
     */
    case 'formas_de_pagamento':
      return null;
  }
}

const reais = (centavos: number): string =>
  (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
