import { describe, expect, it } from 'vitest';
import {
  CONFIANCA_PARA_AGIR,
  horarioServe,
  interpretarPedido,
  oQueFalta,
  PERGUNTA_DO_AGENTE,
  type PedidoDoCliente,
} from './agente.js';

/**
 * O agente de agendamento (bloco 65, SPEC §4.16).
 *
 * O que estes testes protegem: que o agente **não inventa** e que ele **não
 * calcula agenda**. O que sai daqui é o que a pessoa pediu, em campos, casado
 * contra o catálogo desta barbearia. Quem responde com horários é o motor.
 */

const CATALOGO = {
  servicos: [
    { id: 's1', nome: 'Corte' },
    { id: 's2', nome: 'Barba' },
    { id: 's3', nome: 'Corte e barba' },
  ],
  profissionais: [
    { id: 'p1', nome: 'João' },
    { id: 'p2', nome: 'Ruan' },
  ],
};

const pedir = (texto: string) => interpretarPedido(texto, CATALOGO);

describe('a frase da SPEC', () => {
  it('"Quero cortar amanhã depois das 18h com o João" vira os cinco campos', () => {
    /**
     * É o exemplo literal da §4.16, e ele fixa tudo: intenção, serviço, dia,
     * piso de hora e profissional.
     */
    const p = pedir('Quero cortar amanhã depois das 18h com o João');
    expect(p?.intencao).toBe('marcar');
    expect(p?.servicoNome).toBe('Corte');
    expect(p?.emQuantosDias).toBe(1);
    expect(p?.aPartirDeMinuto).toBe(18 * 60);
    expect(p?.profissionalNome).toBe('João');
    expect(p?.confianca).toBeGreaterThanOrEqual(CONFIANCA_PARA_AGIR);
  });
});

describe('o agente não inventa', () => {
  it('serviço que a barbearia não tem não sai daqui', () => {
    /**
     * *"Nunca inventa serviço, preço, horário ou promoção."* O intérprete casa
     * contra o catálogo **desta** barbearia; o que não está na lista vira nulo, e
     * nulo faz o agente perguntar em vez de chutar.
     */
    const p = pedir('quero marcar uma progressiva amanhã');
    expect(p?.servicoId).toBeNull();
    expect(oQueFalta(p!)).toContain('servico');
  });

  it('a forma verbal acha o serviço, porque é assim que se fala', () => {
    /**
     * O catálogo guarda substantivo e a pessoa fala verbo: *"quero cortar"*,
     * *"vim barbear"*. Sem a raiz, o agente respondia "o que você quer fazer?"
     * para a frase mais comum que existe numa barbearia.
     */
    expect(pedir('quero cortar amanhã')?.servicoNome).toBe('Corte');
    expect(pedir('quero marcar pra barbear amanhã')?.servicoNome).toBe('Barba');
  });

  it('o combo vence o serviço simples que está contido nele', () => {
    /**
     * "Corte e barba" contém "corte". Sem ordenar por tamanho, o combo cairia no
     * simples — e o cliente sairia com metade do que pediu, pagando metade e
     * ocupando metade do tempo que a agenda reservou.
     */
    expect(pedir('quero marcar corte e barba amanhã')?.servicoNome).toBe('Corte e barba');
    expect(pedir('quero marcar corte amanhã')?.servicoNome).toBe('Corte');
  });

  it('frase que não é pedido devolve nulo', () => {
    expect(pedir('bom dia')).toBeNull();
    expect(pedir('')).toBeNull();
  });
});

describe('o que falta vira pergunta, uma por vez', () => {
  it('sem serviço e sem dia, pergunta o serviço primeiro', () => {
    // Perguntar duas coisas numa mensagem faz a pessoa responder uma e o agente
    // ficar no mesmo lugar.
    const p = pedir('tem horario?');
    expect(oQueFalta(p!)).toEqual(['servico', 'dia']);
    expect(PERGUNTA_DO_AGENTE[oQueFalta(p!)[0]!]).toContain('Corte');
  });

  it('com tudo dito, não falta nada', () => {
    const p = pedir('quero cortar amanhã');
    expect(oQueFalta(p!)).toEqual([]);
  });
});

describe('a faixa de hora', () => {
  it('"depois das 18h" é piso, e "até as 12h" é teto', () => {
    expect(pedir('quero cortar amanhã depois das 18h')?.aPartirDeMinuto).toBe(1080);
    expect(pedir('quero cortar amanhã depois das 18h')?.ateMinuto).toBeNull();

    const cedo = pedir('quero cortar amanhã até as 12h');
    expect(cedo?.ateMinuto).toBe(720);
    expect(cedo?.aPartirDeMinuto).toBeNull();
  });

  it('hora dita sem "depois" nem "antes" é a hora pedida, não um piso', () => {
    /**
     * "Quero cortar amanhã às 19h" quer 19h. Tratá-la como piso ofereceria 19h,
     * 20h e 21h — e quem só pode às 19h veria três opções das quais duas não
     * servem, o que é pior que uma pergunta.
     */
    const p = pedir('quero cortar amanhã às 19h');
    expect(p?.aPartirDeMinuto).toBe(1140);
    expect(p?.ateMinuto).toBe(1140);
  });

  it('minuto quebrado é lido', () => {
    expect(pedir('quero cortar amanhã depois das 18:30')?.aPartirDeMinuto).toBe(1110);
  });

  it('sem hora nenhuma, a faixa é aberta', () => {
    const p = pedir('quero cortar amanhã');
    expect(p?.aPartirDeMinuto).toBeNull();
    expect(p?.ateMinuto).toBeNull();
  });
});

describe('o horário oferecido serve, ou não', () => {
  const base: PedidoDoCliente = {
    intencao: 'marcar',
    servicoId: 's1',
    servicoNome: 'Corte',
    profissionalId: null,
    profissionalNome: null,
    emQuantosDias: 1,
    aPartirDeMinuto: null,
    ateMinuto: null,
    confianca: 0.8,
  };

  it('quem pediu "até meio-dia" não recebe a vaga que termina 12:40', () => {
    /**
     * `contains`, nunca `overlaps` — a decisão da lista de espera do bloco 39.
     * Quem diz "até meio-dia" está dizendo que precisa ir embora ao meio-dia; uma
     * vaga que o põe na cadeira até 12:40 vira mensagem inútil.
     */
    const pedido = { ...base, ateMinuto: 720 };
    expect(horarioServe(pedido, { inicioMinuto: 660, fimMinuto: 690 })).toBe(true);
    expect(horarioServe(pedido, { inicioMinuto: 700, fimMinuto: 760 })).toBe(false);
  });

  it('a folga de quinze minutos existe, e é pequena de propósito', () => {
    // Zero seria rígido demais: quem diz "até meio-dia" aceita sair 12:10.
    const pedido = { ...base, ateMinuto: 720 };
    expect(horarioServe(pedido, { inicioMinuto: 700, fimMinuto: 730 })).toBe(true);
    expect(horarioServe(pedido, { inicioMinuto: 700, fimMinuto: 740 })).toBe(false);
  });

  it('quem pediu "depois das 18h" não recebe as 17h', () => {
    const pedido = { ...base, aPartirDeMinuto: 1080 };
    expect(horarioServe(pedido, { inicioMinuto: 1020, fimMinuto: 1050 })).toBe(false);
    expect(horarioServe(pedido, { inicioMinuto: 1080, fimMinuto: 1110 })).toBe(true);
  });

  it('sem faixa pedida, todo horário serve', () => {
    expect(horarioServe(base, { inicioMinuto: 480, fimMinuto: 510 })).toBe(true);
    expect(horarioServe(base, { inicioMinuto: 1200, fimMinuto: 1230 })).toBe(true);
  });
});

describe('a escalada para humano', () => {
  it('pedir para falar com alguém é uma intenção, não uma falha', () => {
    // *"Escalada para humano ... em pedido do cliente."* Tratar isso como "não
    // entendi" seria o agente insistindo com quem já desistiu dele.
    expect(pedir('quero falar com alguém')?.intencao).toBe('falar_com_humano');
    expect(pedir('me passa pra um atendente')?.intencao).toBe('falar_com_humano');
  });

  it('cancelar e remarcar são intenções próprias, e não "marcar"', () => {
    /**
     * "Não vou poder ir hoje" é cancelamento, e responder com uma grade de
     * horários seria o agente oferecendo o oposto do que a pessoa disse.
     */
    expect(pedir('não vou poder ir hoje')?.intencao).toBe('cancelar');
    expect(pedir('preciso remarcar para amanhã')?.intencao).toBe('remarcar');
  });

  it('intenção sozinha fica abaixo do piso, e o piso é o que faz perguntar', () => {
    const vago = pedir('tem horario?');
    expect(vago!.confianca).toBeLessThan(CONFIANCA_PARA_AGIR);
  });
});

describe('o telefone não vira hora', () => {
  it('o número do celular no meio da frase não é lido como horário', () => {
    /**
     * Telefone aparece o tempo todo numa conversa de barbearia. Sem a âncora de
     * palavra, o "98" de um número viraria uma hora impossível — e com sorte um
     * horário absurdo; sem sorte, um piso que esvazia a grade.
     */
    const p = pedir('quero cortar amanhã, meu telefone é 71988887777');
    expect(p?.emQuantosDias).toBe(1);
    expect(p?.aPartirDeMinuto).toBeNull();
  });
});
