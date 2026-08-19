import { describe, expect, it } from 'vitest';
import {
  ASSUNTOS,
  assuntoDaChave,
  assuntoDaPergunta,
  chaveDaPergunta,
  responderRecepcao,
  type DadosDaCasa,
} from './recepcao.js';

/**
 * A recepção digital (bloco 66, SPEC §4.17).
 *
 * A regra que estes testes protegem é uma só: *"respostas vêm **exclusivamente**
 * dos dados configurados pela barbearia"*. Toda resposta tem que ser rastreável a
 * um campo que alguém cadastrou — e o que não tem cadastro devolve `null`, que é
 * o que vira a lacuna registrada.
 */

const CASA: DadosDaCasa = {
  servicos: [
    { nome: 'Corte', precoCents: 5000 },
    { nome: 'Barba', precoCents: 3000 },
  ],
  diasAbertos: [
    { diaDaSemana: 2, abre: '09:00', fecha: '19:00' },
    { diaDaSemana: 5, abre: '09:00', fecha: '21:00' },
  ],
  profissionais: [
    { nome: 'João', diasDaSemana: [2, 5] },
    { nome: 'Ruan', diasDaSemana: [5] },
  ],
  endereco: 'Rua das Laranjeiras, 120 — Rio Vermelho',
  politicaDeCancelamento: 'Cancele com 4 horas de antecedência, sem custo.',
};

const perguntar = (texto: string) => responderRecepcao(texto, CASA);

describe('as quatro perguntas da SPEC', () => {
  it('"Quanto custa corte?" responde o preço cadastrado', () => {
    expect(perguntar('Quanto custa corte?')?.texto).toContain('50,00');
  });

  it('"Vocês abrem domingo?" responde a partir da jornada cadastrada', () => {
    // Domingo não está nos dias abertos — e a resposta é "não abrimos", não
    // silêncio: a casa **cadastrou** que não abre.
    expect(perguntar('Vocês abrem domingo?')?.texto).toContain('não abrimos');
  });

  it('"João trabalha sexta?" responde a jornada dele, não a da casa', () => {
    /**
     * A pergunta contém "sexta", e sem a jornada do profissional vir antes na
     * ordem das pistas a resposta seria o horário da casa — a pergunta certa
     * respondida com o número errado.
     */
    expect(perguntar('João trabalha sexta?')?.texto).toContain('João atende sexta');
    expect(perguntar('João trabalha terça?')?.texto).toContain('João atende terça');
    expect(perguntar('Ruan trabalha terça?')?.texto).toContain('não atende');
  });

  it('"Posso levar meu filho?" não tem resposta cadastrada, e vira lacuna', () => {
    /**
     * É a quarta pergunta da SPEC, e ela é o exemplo perfeito do porquê da
     * tabela: a barbearia **pode** ter uma política sobre isso, e o produto não
     * tem onde ela a escreva. Responder "sim" seria inventar uma política que
     * alguém vai ter que honrar no balcão.
     */
    expect(perguntar('Posso levar meu filho?')).toBeNull();
  });
});

describe('exclusivamente do que a casa cadastrou', () => {
  it('sem endereço cadastrado, não há resposta de endereço', () => {
    const semEndereco = { ...CASA, endereco: null };
    expect(responderRecepcao('onde fica?', semEndereco)).toBeNull();
    expect(perguntar('onde fica?')?.texto).toContain('Laranjeiras');
  });

  it('sem política cadastrada, cancelamento vira lacuna', () => {
    const sem = { ...CASA, politicaDeCancelamento: null };
    expect(responderRecepcao('posso cancelar?', sem)).toBeNull();
  });

  it('profissional que não existe não recebe resposta inventada', () => {
    // "Pedro trabalha sexta?" com Pedro fora do quadro: responder qualquer coisa
    // seria o produto afirmando sobre alguém que não trabalha ali.
    expect(perguntar('Pedro trabalha sexta?')).toBeNull();
  });

  it('serviço nomeado vence a lista inteira', () => {
    // Responder a lista quando a pessoa nomeou o serviço é preguiça que obriga
    // ela a procurar; responder o corte a quem perguntou de barba é inventar.
    /**
     * `toContain`, e não `toBe` com o literal.
     *
     * `toLocaleString` com `currency: 'BRL'` põe um espaço **não-quebrável**
     * (U+00A0) entre "R$" e o número. O literal escrito à mão tem espaço comum, e
     * a diferença é invisível na mensagem de erro: `expected 'Barba custa
     * R$ 30,00.' to be 'Barba custa R$ 30,00.'`.
     */
    const resposta = perguntar('quanto custa a barba?')?.texto ?? '';
    expect(resposta).toContain('Barba custa');
    expect(resposta).toContain('30,00');
    expect(resposta).not.toContain('Corte');
  });

  it('formas de pagamento não têm cadastro, e por isso viram lacuna', () => {
    /**
     * O assunto existe na lista de propósito: é assim que ele aparece no
     * registro em vez de sumir. É a regra do gatilho que ainda não funciona — ele
     * aparece marcado, nunca escondido.
     */
    expect(perguntar('vocês aceitam pix?')).toBeNull();
  });
});

describe('a chave que agrupa a pergunta', () => {
  it('agrupa pelo assunto, e não pelas palavras exatas', () => {
    /**
     * O defeito que só apareceu no print: com o conjunto de palavras sozinho,
     * estas três viraram três linhas de "1 vez" — e a promessa do bloco é
     * *"dezoito pessoas perguntaram a mesma coisa"*. Frase de gente tem palavra
     * a mais; exigir o mesmo conjunto exato é exigir que duas pessoas digitem
     * igual.
     *
     * São os textos verdadeiros da medição, e não versões amansadas: a primeira
     * versão deste teste usava "vocês aceitam pix?" e "aceitam pix", que casam
     * até pelo caminho errado.
     */
    const chaves = [
      'vcs aceitam pix ou so dinheiro mesmo?',
      'vcs aceitam pix?',
      'aceitam pagamento no pix',
    ].map(chaveDaPergunta);
    expect(new Set(chaves).size).toBe(1);
  });

  it('duas coisas que faltam cadastrar não viram a mesma linha', () => {
    // O agrupamento por assunto junta o que é uma tarefa só; ele não pode
    // juntar duas tarefas diferentes, senão o dono resolve uma e some com a
    // outra.
    expect(chaveDaPergunta('vocês aceitam pix?')).not.toBe(chaveDaPergunta('onde fica?'));
  });

  it('sem assunto, ainda agrupa pelas palavras', () => {
    // "Posso levar meu filho?" não tem cadastro nem assunto — e continua
    // precisando agrupar, senão cada jeito de escrever vira uma linha.
    expect(chaveDaPergunta('posso levar meu filho')).toBe(
      chaveDaPergunta('posso levar o meu filho?'),
    );
  });

  it('a ordem das palavras não muda a chave', () => {
    // Quem digita com pressa no celular troca a ordem.
    expect(chaveDaPergunta('estacionamento proprio')).toBe(
      chaveDaPergunta('proprio estacionamento'),
    );
  });

  it('pergunta só de palavras vazias não vira chave utilizável', () => {
    // Uma chave vazia agruparia toda pergunta ininteligível numa linha só,
    // escondendo que são coisas diferentes.
    expect(chaveDaPergunta('???')).toBe('');
  });

  it('a chave de assunto se deixa reconhecer depois que o texto vence', () => {
    /**
     * O texto cru tem prazo de guarda. Passado ele, a chave é tudo que sobrou —
     * e sem `assuntoDaChave` a linha perderia o "cadastre em Configurações"
     * justamente quando só ela resta.
     */
    expect(assuntoDaChave(chaveDaPergunta('vocês aceitam pix?'))).toBe('formas_de_pagamento');
    expect(assuntoDaChave(chaveDaPergunta('posso levar meu filho'))).toBeNull();
  });
});

describe('todo assunto declarado é alcançável', () => {
  it('nenhum assunto existe sem uma pergunta que chegue nele', () => {
    /**
     * `formas_de_pagamento` ficou na lista sem uma única palavra que o
     * alcançasse: toda pergunta de pagamento caía em "sem assunto reconhecido",
     * e o print mostrou seis linhas assim seguidas. Assunto declarado que nada
     * alcança é o defeito de `blocks` com outra roupa.
     */
    const exemplos: Readonly<Record<string, string>> = {
      preco: 'quanto custa corte?',
      horario_de_funcionamento: 'vocês abrem domingo?',
      jornada_do_profissional: 'João trabalha sexta?',
      endereco: 'onde fica?',
      politica_de_cancelamento: 'posso cancelar?',
      formas_de_pagamento: 'vocês aceitam pix?',
    };
    for (const assunto of ASSUNTOS) {
      expect(assuntoDaPergunta(exemplos[assunto] ?? ''), assunto).toBe(assunto);
    }
  });
});

describe('a pergunta que não é sobre jornada', () => {
  /**
   * A lista do dono mandava para o cadastro errado (bloco 108).
   *
   * `atende` sozinho classificava *"vocês atendem criança?"* como jornada do
   * profissional, e a tela dizia "cadastre em Profissionais" — onde nenhum
   * cadastro torna aquela pergunta respondível. O dono vai, não acha nada,
   * volta, e a linha continua lá.
   *
   * "Sem assunto reconhecido" é a resposta honesta: a pergunta continua contada
   * e agrupada, sem mandar ninguém para o lugar errado.
   */
  it('pergunta com o verbo mas sem dia não vira jornada', () => {
    expect(assuntoDaPergunta('vocês atendem criança?')).toBeNull();
    expect(assuntoDaPergunta('vocês atendem com hora marcada?')).toBeNull();
  });

  it('pergunta sobre o dia de um profissional continua sendo jornada', () => {
    /**
     * O caso que a pista existe para pegar, e sem ele o teste acima passaria
     * com a pista simplesmente apagada.
     */
    expect(assuntoDaPergunta('o João trabalha domingo?')).toBe('jornada_do_profissional');
    expect(assuntoDaPergunta('o Ruan atende sábado?')).toBe('jornada_do_profissional');
    expect(assuntoDaPergunta('o Ítalo vai estar amanhã?')).toBe('jornada_do_profissional');
  });

  it('preço com preposição feminina continua sendo preço', () => {
    /**
     * `preco do` não casava "preço **da** barba", então a pergunta escapava da
     * recepção — e com a regra do substantivo do bloco 107 ela passaria a virar
     * oferta de horário. Uma lista de preposições fica sempre uma flexão atrás
     * da língua.
     */
    expect(assuntoDaPergunta('qual o preço da barba?')).toBe('preco');
    expect(assuntoDaPergunta('quanto fica o corte?')).toBe('preco');
  });
});
