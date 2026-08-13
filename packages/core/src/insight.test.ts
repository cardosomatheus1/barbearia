import { describe, expect, it } from 'vitest';
import {
  MAXIMO_DE_INSIGHTS,
  montarInsights,
  type AgendaApertada,
  type DadosDoInsight,
} from './insight.js';

/**
 * Os insights proativos (bloco 67, SPEC §4.19).
 *
 * Duas regras carregam o bloco, e são as duas que estes testes protegem: **no
 * máximo três**, e **ordenados por impacto**. As outras — texto bonito, botão
 * certo — são acabamento; estas duas decidem se o painel é lido ou ignorado.
 */

const TICKET = 5000;

const apertada = (nome: string, pedidos: number): AgendaApertada => ({
  profissionalId: `id-${nome}`,
  nome,
  ocupacaoBps: 9700,
  pedidosSemVaga: pedidos,
});

const dados = (parcial: Partial<DadosDoInsight> = {}): DadosDoInsight => ({
  ticketMedioCents: TICKET,
  horaOciosa: null,
  apertadas: [],
  acabando: [],
  ...parcial,
});

describe('o limite de três', () => {
  it('nunca devolve mais de três, por mais que a barbearia tenha', () => {
    /**
     * *"Painel com 20 alertas é painel ignorado."* Sem o corte, uma rede com
     * dez cadeiras apertadas devolveria dez cartões — e quem opera aprende que
     * aquela área não pede nada.
     */
    const muitas = ['Ana', 'Bruno', 'Caio', 'Davi', 'Elis'].map((n, i) => apertada(n, i + 1));
    expect(montarInsights(dados({ apertadas: muitas }))).toHaveLength(MAXIMO_DE_INSIGHTS);
  });

  it('os três que sobram são os de maior impacto', () => {
    // O corte só serve se ele cortar os certos: cortar por ordem de chegada
    // esconderia o problema mais caro atrás do mais antigo.
    const muitas = [apertada('Ana', 1), apertada('Bruno', 40), apertada('Caio', 2), apertada('Davi', 30)];
    const nomes = montarInsights(dados({ apertadas: muitas })).map((i) => i.titulo);
    expect(nomes[0]).toContain('Bruno');
    expect(nomes[1]).toContain('Davi');
    expect(nomes.join(' ')).not.toContain('Ana');
  });
});

describe('o impacto é teto, e é comparável entre tipos', () => {
  it('a hora ociosa vale o menor dos dois lados, nunca o maior', () => {
    /**
     * Cem clientes no ponto de voltar não valem nada se houver três vagas.
     * Multiplicar os dois — ou usar o maior — produziria um número grande que
     * ordenaria a lista errado, que é o único jeito de o limite de três
     * atrapalhar.
     */
    const poucaVaga = montarInsights(
      dados({ horaOciosa: { vagas: 3, primeiraHora: 13, ultimaHora: 17, clientesNoPonto: 100 } }),
    );
    expect(poucaVaga[0]?.impactoCents).toBe(3 * TICKET);

    const poucoCliente = montarInsights(
      dados({ horaOciosa: { vagas: 100, primeiraHora: 13, ultimaHora: 17, clientesNoPonto: 3 } }),
    );
    expect(poucoCliente[0]?.impactoCents).toBe(3 * TICKET);
  });

  it('um insight caro de um tipo vence um barato de outro', () => {
    // O teto existe justamente para isso: se cada tipo tivesse a própria escala,
    // a ordem seria a de quem escreveu o código.
    const lista = montarInsights(
      dados({
        horaOciosa: { vagas: 2, primeiraHora: 13, ultimaHora: 17, clientesNoPonto: 90 },
        apertadas: [apertada('Ana', 20)],
      }),
    );
    expect(lista[0]?.tipo).toBe('agenda_apertada');
    expect(lista[1]?.tipo).toBe('hora_ociosa');
  });
});

describe('insight que não tem o que dizer não aparece', () => {
  it('sem vaga amanhã não há insight de hora ociosa', () => {
    expect(
      montarInsights(
        dados({ horaOciosa: { vagas: 0, primeiraHora: 13, ultimaHora: 17, clientesNoPonto: 90 } }),
      ),
    ).toHaveLength(0);
  });

  it('sem ninguém a quem oferecer, a vaga não vira insight', () => {
    // "Há 23 horários vagos" sem público é um fato, não uma tarefa — e o cartão
    // ofereceria criar campanha para ninguém.
    expect(
      montarInsights(
        dados({ horaOciosa: { vagas: 23, primeiraHora: 13, ultimaHora: 17, clientesNoPonto: 0 } }),
      ),
    ).toHaveLength(0);
  });

  it('agenda cheia sem pedido recusado não é problema', () => {
    /**
     * Ocupação alta sozinha é boa notícia. O que faz dela um insight é gente
     * batendo na porta e não conseguindo entrar — sem isso, o cartão mandaria o
     * dono ampliar jornada para atender ninguém.
     */
    expect(montarInsights(dados({ apertadas: [apertada('Ana', 0)] }))).toHaveLength(0);
  });

  it('barbearia sem ticket médio não produz insight de impacto zero', () => {
    // Mês um, nenhuma venda fechada: todo teto é zero, e um cartão de "até
    // R$ 0,00" é pior que cartão nenhum.
    expect(
      montarInsights({
        ticketMedioCents: 0,
        horaOciosa: { vagas: 23, primeiraHora: 13, ultimaHora: 17, clientesNoPonto: 90 },
        apertadas: [apertada('Ana', 14)],
        acabando: [],
      }),
    ).toHaveLength(0);
  });
});

describe('a ordem não depende da consulta', () => {
  it('empate desempata por nome, não pela ordem de chegada', () => {
    /**
     * Duas cadeiras com o mesmo número de pedidos recusados dão o mesmo teto, e
     * sem desempate estável o painel trocaria de conteúdo entre dois
     * carregamentos sem nada ter mudado.
     */
    const numaOrdem = montarInsights(dados({ apertadas: [apertada('Zeca', 5), apertada('Ana', 5)] }));
    const naOutra = montarInsights(dados({ apertadas: [apertada('Ana', 5), apertada('Zeca', 5)] }));
    expect(numaOrdem.map((i) => i.titulo)).toEqual(naOutra.map((i) => i.titulo));
  });
});

describe('o texto diz o que a pessoa precisa para decidir', () => {
  it('a hora ociosa diz quantas vagas, em que faixa e quanta gente', () => {
    // É o exemplo da SPEC §4.19, e ele tem os três números por uma razão: sem
    // qualquer um deles o dono não consegue julgar se vale a campanha.
    const [insight] = montarInsights(
      dados({ horaOciosa: { vagas: 23, primeiraHora: 13, ultimaHora: 17, clientesNoPonto: 96 } }),
    );
    expect(insight?.texto).toContain('23 horários vagos');
    expect(insight?.texto).toContain('13h');
    expect(insight?.texto).toContain('17h');
    expect(insight?.texto).toContain('96 clientes');
    expect(insight?.acao.rotulo).toBe('Criar campanha');
  });

  it('a agenda apertada diz de quem é e quantos ficaram de fora', () => {
    const [insight] = montarInsights(dados({ apertadas: [apertada('João', 14)] }));
    expect(insight?.texto).toContain('João');
    expect(insight?.texto).toContain('97%');
    expect(insight?.texto).toContain('14 pessoas');
    expect(insight?.acao.parametros['profissionalId']).toBe('id-João');
  });
});

describe('o produto que vai acabar (bloco 69)', () => {
  const acabando = (nome: string, dias: number, comprar: number, precoCents: number) => ({
    produtoId: `id-${nome}`,
    nome,
    diasAteAcabar: dias,
    comprar,
    precoCents,
  });

  it('vira cartão com o prazo, a quantidade e o que deixa de ser vendido', () => {
    // É o terceiro exemplo da SPEC §4.19, e ele tem os dois números por uma
    // razão: sem o prazo o dono não sabe se corre, sem a quantidade não sabe o
    // que pedir.
    const [insight] = montarInsights(
      dados({ acabando: [acabando('Pomada modeladora', 9, 12, 4500)] }),
    );
    expect(insight?.tipo).toBe('estoque_acabando');
    expect(insight?.titulo).toContain('9 dias');
    expect(insight?.texto).toContain('12 unidades');
    // O texto acrescenta em vez de repetir: o print mostrou o cartão dizendo o
    // nome e o prazo duas vezes.
    expect(insight?.texto).not.toContain('Pomada modeladora');
    expect(insight?.impactoCents).toBe(12 * 4500);
  });

  it('produto sem preço de venda não vira cartão de dinheiro', () => {
    /**
     * É o consumo interno chegando por engano. Para o shampoo da lavagem o
     * produto não sabe quanto de receita a falta bloqueia, e um teto inventado
     * ao lado de dois defensáveis faz a ordenação inteira deixar de valer.
     */
    expect(montarInsights(dados({ acabando: [acabando('Shampoo', 4, 6, 0)] }))).toHaveLength(0);
  });

  it('o que já está coberto não vira cartão', () => {
    // "Comprar zero unidades" é o cartão que ocupa espaço sem pedir nada.
    expect(montarInsights(dados({ acabando: [acabando('Cera', 40, 0, 4500)] }))).toHaveLength(0);
  });

  it('o estoque disputa a ordem com os outros dois pelo mesmo teto', () => {
    // Os três tipos usam a mesma definição de impacto; se cada um tivesse a
    // própria escala, a ordem seria a de quem escreveu o código.
    const lista = montarInsights(
      dados({
        apertadas: [apertada('Ana', 2)],
        acabando: [acabando('Pomada', 3, 20, 4500)],
      }),
    );
    expect(lista[0]?.tipo).toBe('estoque_acabando');
  });
});
