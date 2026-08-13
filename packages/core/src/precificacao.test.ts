import { describe, expect, it } from 'vitest';
import {
  OCUPACAO_PARA_ACRESCIMO_BPS,
  TETO_DE_VARIACAO_BPS,
  precoDoHorario,
  recomendarPrecos,
  repartirPreco,
  type FaixaDePreco,
} from './precificacao.js';

/**
 * Preço por faixa de horário (bloco 68, SPEC §4.20).
 *
 * As quatro regras obrigatórias da SPEC são o roteiro destes testes. Duas delas
 * — o teto e o assinante — existem para proteger de um efeito que ninguém
 * pediu, e são exatamente as que passariam despercebidas se o cálculo estivesse
 * "funcionando".
 */

const TERCA_TARDE: FaixaDePreco = {
  diaDaSemana: 2,
  inicioMinuto: 13 * 60,
  fimMinuto: 16 * 60,
  deltaBps: -1000,
};
const SABADO_MANHA: FaixaDePreco = {
  diaDaSemana: 6,
  inicioMinuto: 9 * 60,
  fimMinuto: 13 * 60,
  deltaBps: 1000,
};

const preco = (parcial: Partial<Parameters<typeof precoDoHorario>[0]> = {}) =>
  precoDoHorario({
    precoBaseCents: 5000,
    faixas: [TERCA_TARDE, SABADO_MANHA],
    diaDaSemana: 2,
    minutoLocal: 14 * 60,
    assinante: false,
    tetoBps: TETO_DE_VARIACAO_BPS,
    ...parcial,
  });

describe('as duas regras que o administrador cadastrou', () => {
  it('a faixa de desconto de terça vale à tarde', () => {
    // É o exemplo da SPEC: "Terça 13:00–16:00 → −10%".
    expect(preco().precoCents).toBe(4500);
    expect(preco().deltaBps).toBe(-1000);
  });

  it('a faixa de acréscimo de sábado vale de manhã', () => {
    expect(preco({ diaDaSemana: 6, minutoLocal: 10 * 60 }).precoCents).toBe(5500);
  });

  it('fora da faixa é preço de tabela', () => {
    expect(preco({ minutoLocal: 18 * 60 }).precoCents).toBe(5000);
    expect(preco({ diaDaSemana: 3 }).precoCents).toBe(5000);
  });

  it('a faixa é semiaberta: quem termina às 16h não pega o slot das 16h', () => {
    /**
     * `[início, fim)` como todo intervalo deste produto. Sem isso, duas faixas
     * encostadas — 13h–16h e 16h–19h — dariam dois preços para o mesmo slot, e
     * o desempate entre regras de preço é como o cliente vê um valor na tela e
     * outro na hora de pagar.
     */
    expect(preco({ minutoLocal: 13 * 60 }).deltaBps).toBe(-1000);
    expect(preco({ minutoLocal: 16 * 60 }).deltaBps).toBe(0);
  });
});

describe('o teto da marca', () => {
  it('apara a regra em vez de recusá-la', () => {
    /**
     * *"Variação máxima configurável (default ±15%) — evita que o algoritmo
     * produza preço que destrói a percepção da marca."*
     *
     * Recusar faria a barbearia cadastrar −40%, salvar sem erro e não entender
     * por que nada mudou.
     */
    const exagerada: FaixaDePreco = { ...TERCA_TARDE, deltaBps: -4000 };
    const resultado = preco({ faixas: [exagerada] });
    expect(resultado.deltaBps).toBe(-TETO_DE_VARIACAO_BPS);
    expect(resultado.precoCents).toBe(4250);
  });

  it('apara nos dois sentidos', () => {
    const exagerada: FaixaDePreco = { ...SABADO_MANHA, deltaBps: 4000 };
    const resultado = preco({ faixas: [exagerada], diaDaSemana: 6, minutoLocal: 10 * 60 });
    expect(resultado.deltaBps).toBe(TETO_DE_VARIACAO_BPS);
  });

  it('teto zero desliga a variação sem desligar o cadastro', () => {
    // A barbearia que quer parar de variar preço zera o teto e mantém as regras
    // cadastradas — apagar tudo para voltar atrás é o caminho que ninguém toma.
    expect(preco({ tetoBps: 0 }).precoCents).toBe(5000);
  });
});

describe('assinante nunca paga surge', () => {
  it('o acréscimo é ignorado para quem assina', () => {
    /**
     * *"Assinante **nunca** paga surge pricing; é benefício do clube."* Quem
     * paga mensalidade para ter previsibilidade não pode descobrir num sábado
     * que o corte dele subiu.
     */
    const resultado = preco({ diaDaSemana: 6, minutoLocal: 10 * 60, assinante: true });
    expect(resultado.precoCents).toBe(5000);
    expect(resultado.deltaBps).toBe(0);
  });

  it('mas o desconto continua valendo para ele', () => {
    // Aparar o desconto também seria ler a frase ao contrário: ela protege quem
    // assina, não a receita da casa.
    expect(preco({ assinante: true }).precoCents).toBe(4500);
  });
});

describe('o arredondamento é de centavo, e para o lado certo', () => {
  it('acréscimo sobre preço quebrado não perde centavo', () => {
    // Truncar sempre para baixo tiraria um centavo da regra em toda venda, para
    // sempre — dinheiro é centavo inteiro, e o arredondamento é `round`.
    const resultado = preco({
      precoBaseCents: 4999,
      faixas: [SABADO_MANHA],
      diaDaSemana: 6,
      minutoLocal: 10 * 60,
    });
    expect(resultado.precoCents).toBe(5499);
  });
});

describe('a recomendação, que é só uma recomendação', () => {
  const hora = (dia: number, h: number, ocupacaoBps: number | null, porSemana = 5) => ({
    diaDaSemana: dia,
    hora: h,
    ocupacaoBps,
    atendimentosPorSemana: porSemana,
  });

  it('hora cheia vira sugestão de acréscimo', () => {
    const [sugestao] = recomendarPrecos({
      horas: [hora(5, 17, 9700)],
      ticketMedioCents: 5000,
      tetoBps: TETO_DE_VARIACAO_BPS,
    });
    expect(sugestao?.deltaBps).toBe(TETO_DE_VARIACAO_BPS);
    // 5 atendimentos × 4 semanas × R$ 50 × 15% = R$ 150.
    expect(sugestao?.ganhoMensalCents).toBe(15_000);
  });

  it('hora morna não vira sugestão nenhuma', () => {
    /**
     * Sugestão que aparece sobre uma hora normal é ruído, e ruído numa lista de
     * três é o que faz o dono parar de olhar. Só as pontas rendem decisão.
     */
    expect(
      recomendarPrecos({
        horas: [hora(3, 15, 6000)],
        ticketMedioCents: 5000,
        tetoBps: TETO_DE_VARIACAO_BPS,
      }),
    ).toHaveLength(0);
  });

  it('hora fechada não vira sugestão nenhuma', () => {
    /**
     * Ocupação nula é "a casa não abre", não "está vazio" — regra do bloco 57.
     */
    expect(
      recomendarPrecos({
        horas: [hora(0, 8, null, 0)],
        ticketMedioCents: 5000,
        tetoBps: TETO_DE_VARIACAO_BPS,
      }),
    ).toHaveLength(0);
  });

  it('hora fria não vira sugestão de desconto', () => {
    /**
     * O defeito que só o print mostrou: três cartões seguidos — domingo às 6h,
     * 7h e 8h — com o **mesmo** ganho, porque o ganho de um desconto não sai de
     * lugar nenhum. Quantas pessoas 15% a menos traria é o que este produto não
     * sabe, e chutar é inventar número de marketing com cara de estatística.
     *
     * A hora vazia tem resposta melhor no produto: o insight do bloco 67 conta
     * as vagas e o público, e o botão dele abre a campanha.
     */
    expect(
      recomendarPrecos({
        horas: [hora(0, 6, 1900), hora(0, 7, 1900), hora(0, 8, 1900)],
        ticketMedioCents: 5000,
        tetoBps: TETO_DE_VARIACAO_BPS,
      }),
    ).toHaveLength(0);
  });

  it('vem no máximo três, do maior ganho para o menor', () => {
    const sugestoes = recomendarPrecos({
      horas: [
        hora(1, 10, 9500, 2),
        hora(2, 11, 9500, 9),
        hora(3, 12, 9500, 5),
        hora(4, 13, 9500, 7),
      ],
      ticketMedioCents: 5000,
      tetoBps: TETO_DE_VARIACAO_BPS,
    });
    expect(sugestoes).toHaveLength(3);
    expect(sugestoes.map((s) => s.hora)).toEqual([11, 13, 12]);
  });

  it('barbearia sem ticket médio não recebe sugestão de valor zero', () => {
    // Mês um: um "ganho de R$ 0,00/mês" é o indicador que nunca preenche.
    expect(
      recomendarPrecos({
        horas: [hora(5, 17, 9700)],
        ticketMedioCents: 0,
        tetoBps: TETO_DE_VARIACAO_BPS,
      }),
    ).toHaveLength(0);
  });

  it('o corte de acréscimo é o da constante, não um número solto na tela', () => {
    // Ocupação logo abaixo do corte não sugere nada; no corte, sugere.
    const abaixo = recomendarPrecos({
      horas: [hora(5, 17, OCUPACAO_PARA_ACRESCIMO_BPS - 1)],
      ticketMedioCents: 5000,
      tetoBps: TETO_DE_VARIACAO_BPS,
    });
    const emCima = recomendarPrecos({
      horas: [hora(5, 17, OCUPACAO_PARA_ACRESCIMO_BPS)],
      ticketMedioCents: 5000,
      tetoBps: TETO_DE_VARIACAO_BPS,
    });
    expect(abaixo).toHaveLength(0);
    expect(emCima).toHaveLength(1);
  });
});

describe('o ajuste chega à comanda, não só ao agendamento', () => {
  it('a soma das partes é o total ajustado, ao centavo', () => {
    /**
     * A comanda nasce de `appointment_services`. Sem repartir, ela cobraria o
     * preço de tabela — o cliente veria R$ 45 na tela e R$ 50 na hora de pagar,
     * que é o defeito que a faixa de preço existe para não produzir.
     *
     * Três itens com preço que não divide redondo: é onde o centavo se perde.
     */
    const base = new Map([
      ['corte', 3333],
      ['barba', 3333],
      ['sobrancelha', 3334],
    ]);
    const repartido = repartirPreco(base, 9000);
    expect([...repartido.values()].reduce((s, v) => s + v, 0)).toBe(9000);
  });

  it('cada parte guarda a proporção do preço de tabela', () => {
    // Ratear igual faria a barba de R$ 30 e o corte de R$ 50 saírem pelo mesmo
    // valor, e a comissão de cada serviço iria junto no erro.
    const repartido = repartirPreco(new Map([['corte', 5000], ['barba', 3000]]), 7200);
    expect(repartido.get('corte')).toBe(4500);
    expect(repartido.get('barba')).toBe(2700);
  });

  it('preço de tabela zerado devolve a lista intacta', () => {
    // Serviço de cortesia com preço zero: dividir por zero produziria `NaN` em
    // toda a comanda.
    const base = new Map([['brinde', 0]]);
    expect(repartirPreco(base, 0)).toBe(base);
  });
});
