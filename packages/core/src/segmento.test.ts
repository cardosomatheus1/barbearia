import { describe, expect, it } from 'vitest';
import {
  cicloDoCliente,
  corteDeVip,
  FILTROS_DE_CAMPANHA,
  medianaDaBase,
  NUMERO_DO_FILTRO,
  ROTULO_DO_FILTRO,
  ROTULO_DO_SEGMENTO,
  definicaoDoFiltro,
  rotuloDoFiltro,
  segmentoDoCliente,
  SEGMENTO_DO_FILTRO,
  SEGMENTOS,
  type CicloDoCliente,
} from './segmento.js';

const dia = (n: number) => new Date(2026, 0, n, 12, 0, 0);

describe('o ciclo individual', () => {
  it('três visitas bastam; duas não são um ritmo', () => {
    /**
     * Com duas visitas há **um** intervalo, e um intervalo é coincidência.
     * Chamá-lo de ciclo transformaria o espaço entre a primeira e a segunda
     * vinda em regra — e a regra decide quem recebe mensagem.
     */
    expect(cicloDoCliente([dia(1), dia(15)])).toBeNull();
    expect(cicloDoCliente([dia(1), dia(15), dia(29)])).not.toBeNull();
  });

  it('a mediana sobrevive a um sumiço; a média não sobreviveria', () => {
    /**
     * Quem corta a cada 14 dias, some por seis meses e volta: a média dos
     * intervalos passa de 60 e a mediana continua 14. A mediana é quem ele é.
     */
    const visitas = [dia(1), dia(15), dia(29), dia(43), new Date(2026, 6, 1)];
    expect(cicloDoCliente(visitas)?.medianaDias).toBe(14);
  });

  it('ordena sozinho: depender da ordem do chamador é contrato que se quebra calado', () => {
    const fora = [dia(29), dia(1), dia(15)];
    expect(cicloDoCliente(fora)?.medianaDias).toBe(14);
  });

  it('quem é perfeitamente regular ganha um dia de folga, não zero', () => {
    /**
     * Sem o piso, quem corta toda sexta viraria "em risco" no sábado de manhã —
     * no dia seguinte ao corte, por um atraso de horas.
     */
    expect(cicloDoCliente([dia(1), dia(8), dia(15), dia(22)])?.folgaDias).toBe(1);
  });
});

describe('em qual segmento a pessoa está', () => {
  const ritmoDe14: CicloDoCliente = { medianaDias: 14, folgaDias: 2, visitas: 5 };

  const base = {
    ciclo: ritmoDe14,
    agora: new Date(2026, 1, 1, 12, 0, 0),
    assinanteAtivo: false,
    gastoTotalCents: 10_000,
    /**
     * Dez dias, e não trinta.
     *
     * Com a mediana da base em trinta, um ciclo de catorze fica **abaixo** dela
     * e todo caso "ativo" viraria "frequente" — o teste passaria a provar outra
     * coisa. A base rápida isola o que cada caso quer dizer.
     */
    medianaDaBaseDias: 10,
    corteDeVipCents: 100_000,
  };

  it('sem nenhuma visita é novo', () => {
    expect(segmentoDoCliente({ ...base, ciclo: null, ultimaVisita: null })).toBe('novo');
  });

  it('uma visita só continua novo, mesmo dentro do prazo', () => {
    // Ele não retornou ainda: chamá-lo de ativo daria à tela um cliente
    // estabelecido que veio uma vez.
    expect(
      segmentoDoCliente({ ...base, ciclo: null, ultimaVisita: new Date(2026, 0, 30) }),
    ).toBe('novo');
  });

  it('dentro do ritmo é ativo', () => {
    expect(segmentoDoCliente({ ...base, ultimaVisita: new Date(2026, 0, 25) })).toBe('ativo');
  });

  it('passou do ritmo mais a folga: em risco', () => {
    // 14 + 2 = 16 dias de tolerância. Dezoito dias sem vir estoura.
    expect(segmentoDoCliente({ ...base, ultimaVisita: new Date(2026, 0, 14) })).toBe('em_risco');
  });

  it('passou do dobro do ritmo: perdido', () => {
    expect(segmentoDoCliente({ ...base, ultimaVisita: new Date(2025, 11, 20) })).toBe('perdido');
  });

  it('quem corta a cada 45 dias não está em risco no dia 30, e quem corta a cada 15 está', () => {
    /**
     * É a frase da SPEC §4.4 virada em teste, e é o bloco inteiro: uma regra
     * fixa de sessenta dias erraria os dois.
     */
    const agora = new Date(2026, 1, 1, 12, 0, 0);
    const trintaDiasAtras = new Date(2026, 0, 2, 12, 0, 0);

    const devagar = segmentoDoCliente({
      ...base,
      ciclo: { medianaDias: 45, folgaDias: 5, visitas: 5 },
      ultimaVisita: trintaDiasAtras,
      agora,
    });
    const rapido = segmentoDoCliente({
      ...base,
      ciclo: { medianaDias: 15, folgaDias: 2, visitas: 5 },
      ultimaVisita: trintaDiasAtras,
      agora,
    });

    /**
     * `em_risco`, e não `perdido`: trinta dias é **exatamente** o dobro de
     * quinze, e a SPEC escreve "> 2× ciclo". No dobro cravado a pessoa ainda
     * está na faixa de ir atrás — e essa é a diferença entre chamar e desistir.
     *
     * A expectativa foi ajustada depois de o teste ficar vermelho, e o suspeito
     * era o código: a leitura da SPEC confirmou o `>`. O que o caso prova
     * continua de pé — uma regra fixa de sessenta dias erraria os dois, achando
     * o primeiro em risco e o segundo em dia.
     */
    expect(devagar).toBe('ativo');
    expect(rapido).toBe('em_risco');
  });

  it('o assinante que sumiu aparece como sumido, não como assinante', () => {
    /**
     * A ordem responde "o que a casa faz com ele hoje?". Para quem sumiu, a
     * resposta é ir atrás — principalmente sendo assinante, porque ali existe
     * uma mensalidade prestes a ser cancelada.
     */
    expect(
      segmentoDoCliente({
        ...base,
        assinanteAtivo: true,
        ultimaVisita: new Date(2026, 0, 14),
      }),
    ).toBe('em_risco');

    // Em dia, ele é assinante.
    expect(
      segmentoDoCliente({ ...base, assinanteAtivo: true, ultimaVisita: new Date(2026, 0, 25) }),
    ).toBe('assinante');
  });

  it('o VIP que não volta há três ciclos não é VIP', () => {
    // Chamá-lo de VIP na tela esconde exatamente o que precisa ser visto.
    expect(
      segmentoDoCliente({
        ...base,
        gastoTotalCents: 500_000,
        ultimaVisita: new Date(2025, 11, 20),
      }),
    ).toBe('perdido');
  });

  it('gasto no topo do decil é VIP; ritmo abaixo da mediana da base é frequente', () => {
    expect(
      segmentoDoCliente({
        ...base,
        gastoTotalCents: 100_000,
        ultimaVisita: new Date(2026, 0, 25),
      }),
    ).toBe('vip');

    expect(segmentoDoCliente({ ...base, ultimaVisita: new Date(2026, 0, 25) })).toBe('ativo');
    expect(
      segmentoDoCliente({
        ...base,
        ciclo: { medianaDias: 7, folgaDias: 2, visitas: 5 },
        ultimaVisita: new Date(2026, 0, 29),
      }),
    ).toBe('frequente');
  });
});

describe('as comparações contra a base', () => {
  it('base pequena não compara ninguém com ninguém', () => {
    /**
     * Com cinco clientes, a mediana é ruído e "volta mais rápido que a maioria"
     * vira uma frase sobre duas pessoas. Nulo significa "não dá para dizer", e
     * ninguém é frequente nem VIP — que é o certo.
     */
    expect(medianaDaBase([10, 20, 30])).toBeNull();
    expect(corteDeVip([100, 200, 300])).toBeNull();
  });

  it('o corte de VIP é o topo dos dez por cento, não um valor fixo', () => {
    // "Gastou mais de R$ 2.000" quer dizer coisas diferentes numa barbearia de
    // bairro e numa do centro; o decil é a mesma frase nas duas.
    const gastos = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
    expect(corteDeVip(gastos)).toBe(1900);
  });

  it('a mediana da base sai de quem tem ciclo', () => {
    expect(medianaDaBase([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])).toBe(55);
  });
});

describe('duas visitas no mesmo dia', () => {
  it('não são um ritmo, e não viram ciclo de zero dias', () => {
    /**
     * Corte e barba lançados como dois atendimentos, ou o cliente que volta à
     * tarde: nenhum dos dois é "voltar". Contados, a mediana ia a zero, a tela
     * escrevia *"normalmente volta a cada 0 dias"* e o churn disparava no
     * máximo — qualquer ausência já passa do dobro de zero.
     *
     * Nenhum teste ficou vermelho quando isso aconteceu. Apareceu na leitura do
     * print: uma cliente com risco 60 por ter vindo duas vezes numa terça.
     */
    const mesmoDia = cicloDoCliente([
      new Date(2026, 0, 10, 9, 0),
      new Date(2026, 0, 10, 11, 0),
      new Date(2026, 0, 10, 15, 0),
    ]);
    expect(mesmoDia).toBeNull();
  });

  it('a visita repetida no dia não encurta o ciclo de quem tem ritmo', () => {
    // Quinze dias entre as vindas, com uma tarde em que ele voltou. O ciclo
    // continua sendo quinze, não sete e meio.
    const ciclo = cicloDoCliente([
      new Date(2026, 0, 1, 10, 0),
      new Date(2026, 0, 16, 10, 0),
      new Date(2026, 0, 16, 16, 0),
      new Date(2026, 0, 31, 10, 0),
    ]);
    expect(ciclo?.medianaDias).toBe(15);
  });
});

describe('o vocabulário dos públicos de campanha', () => {
  it('todo público tem nome, e a resposta sobre o número é escrita', () => {
    /**
     * Os dois mapas são `Record` completos no tipo, mas o tipo não impede um
     * valor vazio — e um rótulo vazio vira uma opção em branco no seletor, que
     * é escolhível e não diz nada.
     *
     * `NUMERO_DO_FILTRO` aceita nulo de propósito: nulo é a resposta "este
     * público não pede número", e é o que a opção mostra.
     */
    for (const filtro of FILTROS_DE_CAMPANHA) {
      expect(ROTULO_DO_FILTRO[filtro], filtro).toBeTruthy();
      expect(NUMERO_DO_FILTRO[filtro] ?? '—', filtro).toBeTruthy();
    }
  });

  it('todo público de segmento aponta para um segmento que existe', () => {
    // Um filtro apontando para um segmento inventado nunca casaria com ninguém:
    // a campanha nasceria com público zero, sem erro e sem explicação.
    for (const [filtro, segmento] of Object.entries(SEGMENTO_DO_FILTRO)) {
      expect(SEGMENTOS, filtro).toContain(segmento);
    }
  });

  it('os públicos que a casa não deve interromper ficam de fora', () => {
    /**
     * `novo`, `ativo`, `frequente` e `assinante` são estados em que não há nada
     * a fazer. Mandar mensagem para quem está voltando sozinho é como se queima
     * o número da barbearia, e um filtro para eles seria o caminho mais curto.
     */
    const oferecidos = Object.values(SEGMENTO_DO_FILTRO);
    expect(oferecidos).not.toContain('ativo');
    expect(oferecidos).not.toContain('frequente');
    expect(oferecidos).not.toContain('assinante');
    expect(oferecidos).not.toContain('novo');
  });
});

/**
 * Um nome só para a mesma gente (bloco 99).
 *
 * `ROTULO_DO_SEGMENTO` e `ROTULO_DO_FILTRO` davam nomes diferentes às mesmas
 * pessoas, e as duas apareciam na **mesma tela**: o contador dizia "23 Em
 * risco" e o seletor logo abaixo dizia "Passou do ritmo dele". Quem opera não
 * tem como saber que são o mesmo grupo, e é a §6 pergunta 2.
 */
describe('o nome do público', () => {
  it('filtro que é segmento usa o nome do segmento', () => {
    for (const filtro of FILTROS_DE_CAMPANHA) {
      const segmento = SEGMENTO_DO_FILTRO[filtro];
      if (!segmento) continue;
      expect(rotuloDoFiltro(filtro), filtro).toBe(ROTULO_DO_SEGMENTO[segmento]);
    }
  });

  it('filtro que não é segmento mantém o nome próprio', () => {
    // A outra metade: sem ela, `rotuloDoFiltro` podendo devolver qualquer
    // coisa para os quatro que não têm segmento passaria no caso de cima.
    for (const filtro of FILTROS_DE_CAMPANHA) {
      if (SEGMENTO_DO_FILTRO[filtro]) continue;
      expect(rotuloDoFiltro(filtro), filtro).toBe(ROTULO_DO_FILTRO[filtro]);
    }
  });

  it('o que era o nome do filtro vira a definição ao lado', () => {
    /**
     * A definição não se perde ao deixar de ser nome: "Em risco — passou do
     * ritmo dele" é o nome com o que ele quer dizer junto, e sem ela o seletor
     * ficaria com sete rótulos que não explicam nada.
     */
    expect(definicaoDoFiltro('em_risco')).toBe('passou do ritmo dele');
    expect(definicaoDoFiltro('inativos')).toBeNull();
  });

  it('nenhum nome de público colide com o de outro', () => {
    // Dois públicos com o mesmo rótulo seriam duas opções idênticas no seletor,
    // e quem escolhe não teria como saber qual pegou.
    const nomes = FILTROS_DE_CAMPANHA.map((f) => rotuloDoFiltro(f));
    expect(new Set(nomes).size).toBe(nomes.length);
  });
});
