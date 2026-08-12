import { describe, expect, it } from 'vitest';
import {
  ESTADOS_DA_ASSINATURA,
  ROTULO_DA_ASSINATURA,
  assinaturaVale,
  cicloDaAssinatura,
  eAssinante,
  fraseDoBeneficio,
  mrrDasAssinaturas,
  antecedenciaDoAssinante,
  fraseDoBloqueio,
  planoValeNoHorario,
  podeSerDependente,
  podeUsarBeneficio,
  proximoUsoLiberado,
  quemConsome,
  usosQueOPlanoPaga,
  type BeneficioDoPlano,
} from './assinatura.js';

const AGORA = new Date('2026-11-15T12:00:00Z');
const CORTE = 'servico-corte';
const BARBA = 'servico-barba';

const dias = (n: number) => new Date(AGORA.getTime() + n * 86_400_000);

const doisCortes: BeneficioDoPlano = { serviceId: CORTE, quantidade: 2, cooldownDias: 0 };
const ilimitado: BeneficioDoPlano = { serviceId: CORTE, quantidade: null, cooldownDias: 7 };

describe('o que a assinatura cobre', () => {
  it('serviço fora do plano é recusado', () => {
    expect(
      podeUsarBeneficio({
        estado: 'ativa', beneficios: [doisCortes], serviceId: BARBA, uso: { usados: 0, ultimoUso: null }, agora: AGORA,
      }),
    ).toMatchObject({ pode: false, recusa: 'servico_fora_do_plano' });
  });

  it('a cota do ciclo acaba', () => {
    expect(
      podeUsarBeneficio({
        estado: 'ativa', beneficios: [doisCortes], serviceId: CORTE,
        uso: { usados: 2, ultimoUso: dias(-3) }, agora: AGORA,
      }),
    ).toMatchObject({ pode: false, recusa: 'cota_esgotada', restam: 0 });
  });

  it('a cota e o cooldown são do serviço pedido', () => {
    // O repositório já conta por serviço; o domínio recebe os dois números
    // prontos, e é isso que impede o uso da barba gastar a cota do corte.
    expect(
      podeUsarBeneficio({
        estado: 'ativa', beneficios: [doisCortes], serviceId: CORTE,
        uso: { usados: 0, ultimoUso: null }, agora: AGORA,
      }),
    ).toMatchObject({ pode: true, restam: 2 });
  });
});

describe('o cooldown é o que torna ilimitado viável', () => {
  it('segura o segundo corte dentro do intervalo', () => {
    /**
     * Sem o intervalo, "ilimitado" é prejuízo garantido no primeiro assinante
     * entusiasmado — e a barbearia descobre no fim do mês, com a agenda cheia e
     * o caixa igual.
     */
    const decisao = podeUsarBeneficio({
      estado: 'ativa', beneficios: [ilimitado], serviceId: CORTE,
      uso: { usados: 1, ultimoUso: dias(-3) }, agora: AGORA,
    });
    expect(decisao).toMatchObject({ pode: false, recusa: 'dentro_do_cooldown' });
    expect(decisao.liberaEm?.toISOString()).toBe(dias(4).toISOString());
  });

  it('passado o intervalo, libera — e ilimitado não tem cota', () => {
    expect(
      podeUsarBeneficio({
        estado: 'ativa', beneficios: [ilimitado], serviceId: CORTE,
        uso: { usados: 1, ultimoUso: dias(-8) }, agora: AGORA,
      }),
    ).toMatchObject({ pode: true, restam: null });
  });

  it('conta do último uso, e o ciclo não o recorta', () => {
    /**
     * Contar do ciclo faria o intervalo de sete dias virar "um por semana do
     * calendário". Recortar pelo ciclo é pior: o intervalo sumiria toda vez que
     * o mês virasse entre dois cortes — quem cortou no dia 28 cortaria de novo
     * no dia 30. Foi assim que a primeira versão errou.
     */
    expect(proximoUsoLiberado(dias(-1), 7)?.toISOString()).toBe(dias(6).toISOString());

    // Zero usos **no ciclo** e um uso ontem: o cooldown continua valendo.
    const decisao = podeUsarBeneficio({
      estado: 'ativa', beneficios: [ilimitado], serviceId: CORTE,
      uso: { usados: 0, ultimoUso: dias(-1) }, agora: AGORA,
    });
    expect(decisao).toMatchObject({ pode: false, recusa: 'dentro_do_cooldown' });
  });

  it('sem cooldown não há o que segurar', () => {
    expect(proximoUsoLiberado(AGORA, 0)).toBeNull();
  });
});

describe('o estado da assinatura', () => {
  it('inadimplente ainda usa, e é decisão', () => {
    /**
     * A SPEC §4.6 pede em letras: *"Suspensão de benefício é gradual e avisada —
     * cortar o acesso no primeiro erro de cartão gera cancelamento por raiva,
     * não por preço."* O cartão que falhou na terça costuma passar na quinta.
     */
    expect(assinaturaVale('inadimplente')).toBe(true);
    expect(
      podeUsarBeneficio({
        estado: 'inadimplente', beneficios: [doisCortes], serviceId: CORTE,
        uso: { usados: 0, ultimoUso: null }, agora: AGORA,
      }),
    ).toMatchObject({ pode: true });
  });

  it('suspensa e cancelada não usam', () => {
    for (const estado of ['suspensa', 'cancelada', 'pendente'] as const) {
      expect(
        podeUsarBeneficio({
          estado, beneficios: [doisCortes], serviceId: CORTE, uso: { usados: 0, ultimoUso: null }, agora: AGORA,
        }),
      ).toMatchObject({ pode: false, recusa: 'assinatura_inativa' });
    }
  });

  it('todo estado tem rótulo', () => {
    for (const e of ESTADOS_DA_ASSINATURA) expect(ROTULO_DA_ASSINATURA[e]).toBeTruthy();
  });
});

describe('o ciclo é ancorado no dia da adesão', () => {
  it('quem assinou no dia 20 tem o ciclo do 20 ao 20', () => {
    /**
     * Ancorar no dia 1º daria meio mês de graça para quem assina no dia 28, e a
     * barbearia veria o plano render metade no primeiro mês sem entender por quê.
     */
    const ciclo = cicloDaAssinatura(
      new Date('2026-09-20T10:00:00Z'),
      new Date('2026-11-25T12:00:00Z'),
    );
    expect(ciclo.de.toISOString()).toBe('2026-11-20T10:00:00.000Z');
    expect(ciclo.ate.toISOString()).toBe('2026-12-20T10:00:00.000Z');
  });

  it('antes do aniversário do mês, o ciclo é o anterior', () => {
    const ciclo = cicloDaAssinatura(
      new Date('2026-09-20T10:00:00Z'),
      new Date('2026-11-15T12:00:00Z'),
    );
    expect(ciclo.de.toISOString()).toBe('2026-10-20T10:00:00.000Z');
    expect(ciclo.ate.toISOString()).toBe('2026-11-20T10:00:00.000Z');
  });

  it('o dia 31 vira o último dia do mês curto, e volta a 31 depois', () => {
    // É o que qualquer assinatura do mundo faz, e o que ninguém lembra de testar.
    const fevereiro = cicloDaAssinatura(
      new Date('2027-01-31T10:00:00Z'),
      new Date('2027-02-15T12:00:00Z'),
    );
    expect(fevereiro.de.toISOString()).toBe('2027-01-31T10:00:00.000Z');
    expect(fevereiro.ate.toISOString()).toBe('2027-02-28T10:00:00.000Z');

    const marco = cicloDaAssinatura(
      new Date('2027-01-31T10:00:00Z'),
      new Date('2027-03-15T12:00:00Z'),
    );
    expect(marco.de.toISOString()).toBe('2027-02-28T10:00:00.000Z');
    expect(marco.ate.toISOString()).toBe('2027-03-31T10:00:00.000Z');
  });

  it('atravessa a virada do ano', () => {
    const ciclo = cicloDaAssinatura(
      new Date('2026-06-10T08:00:00Z'),
      new Date('2027-01-05T12:00:00Z'),
    );
    expect(ciclo.de.toISOString()).toBe('2026-12-10T08:00:00.000Z');
    expect(ciclo.ate.toISOString()).toBe('2027-01-10T08:00:00.000Z');
  });
});

describe('o MRR da barbearia', () => {
  it('soma o que os clientes pagam a ela, e não o que ela paga à plataforma', () => {
    /**
     * É o outro MRR da SPEC §8, declarado como lacuna no bloco em que o primeiro
     * entrou. `inadimplente` conta pela mesma razão de o benefício continuar: o
     * cartão que falhou na terça costuma passar na quinta, e tirar a receita do
     * número no primeiro erro faria o painel oscilar por um problema que se
     * resolve sozinho.
     */
    expect(
      mrrDasAssinaturas([
        { estado: 'ativa', precoCents: 14_900 },
        { estado: 'inadimplente', precoCents: 8900 },
        { estado: 'suspensa', precoCents: 24_900 },
        { estado: 'cancelada', precoCents: 14_900 },
        { estado: 'pendente', precoCents: 8900 },
      ]),
    ).toEqual({ mrrCents: 23_800, ativas: 2 });
  });

  it('barbearia sem assinante tem MRR zero, e isso não é erro', () => {
    expect(mrrDasAssinaturas([])).toEqual({ mrrCents: 0, ativas: 0 });
  });
});

describe('o ponto de equilíbrio', () => {
  it('diz quantos usos o plano paga', () => {
    // O Premium de R$ 149 paga dois cortes que custam R$ 36 à casa cada... e o
    // quarto já é prejuízo.
    expect(usosQueOPlanoPaga(14_900, 3600)).toBe(4);
  });

  it('sem custo por uso, o plano nunca dá prejuízo', () => {
    expect(usosQueOPlanoPaga(14_900, 0)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('a frase do balcão', () => {
  it('conta a cota do ciclo', () => {
    expect(fraseDoBeneficio(doisCortes, 1, 'cortes')).toBe(
      '1 de 2 cortes — 1 restante neste ciclo',
    );
  });

  it('ilimitado com intervalo diz o intervalo', () => {
    expect(fraseDoBeneficio(ilimitado, 3, 'Corte')).toBe('Corte ilimitado, a cada 7 dias');
  });
});

describe('o assinante na fila de espera', () => {
  it('o termo deixa de ser constante e falso', () => {
    /**
     * Era lacuna declarada desde o bloco 38: `assinante` entrava constante para
     * todo mundo, e o efeito era o score inteiro caber em 0,8 em vez de 1,0.
     */
    expect(eAssinante('ativa')).toBe(true);
    expect(eAssinante('inadimplente')).toBe(true);
    expect(eAssinante('suspensa')).toBe(false);
    expect(eAssinante(null)).toBe(false);
  });
});

describe('a restrição de horário protege o pico', () => {
  const sabadoDeManha = [{ diaDaSemana: 6, inicio: 540, fim: 780 }];

  it('bloqueia a janela cheia do sábado', () => {
    /**
     * Sem a restrição, o plano barato ocupa a hora que a casa vende cheia — e o
     * clube passa a **substituir** receita em vez de somar.
     */
    expect(planoValeNoHorario(sabadoDeManha, 6, 600)).toBe(false);
    expect(planoValeNoHorario(sabadoDeManha, 6, 900)).toBe(true);
  });

  it('o intervalo é semiaberto: encostar não é sobrepor', () => {
    // Um bloqueio até as 13:00 libera o horário das 13:00, como todo intervalo
    // deste produto.
    expect(planoValeNoHorario(sabadoDeManha, 6, 540)).toBe(false);
    expect(planoValeNoHorario(sabadoDeManha, 6, 780)).toBe(true);
  });

  it('outro dia não é afetado', () => {
    expect(planoValeNoHorario(sabadoDeManha, 3, 600)).toBe(true);
  });

  it('dia nulo bloqueia a mesma faixa em todos', () => {
    const almoco = [{ diaDaSemana: null, inicio: 720, fim: 780 }];
    for (const dia of [0, 1, 2, 3, 4, 5, 6]) {
      expect(planoValeNoHorario(almoco, dia, 750)).toBe(false);
    }
  });

  it('sem bloqueio o plano vale sempre', () => {
    expect(planoValeNoHorario([], 6, 600)).toBe(true);
  });

  it('a frase diz o dia e a faixa', () => {
    expect(fraseDoBloqueio({ diaDaSemana: 6, inicio: 540, fim: 780 })).toBe(
      'sábado, das 09:00 às 13:00',
    );
    expect(fraseDoBloqueio({ diaDaSemana: null, inicio: 720, fim: 780 })).toBe(
      'todo dia, das 12:00 às 13:00',
    );
  });
});

describe('a antecedência do assinante', () => {
  it('é a maior entre a da casa e a do plano', () => {
    // Nunca menor que a de todo mundo: um plano com janela curta viraria uma
    // punição por assinar.
    expect(antecedenciaDoAssinante(30, 60)).toBe(60);
    expect(antecedenciaDoAssinante(30, 0)).toBe(30);
    expect(antecedenciaDoAssinante(90, 60)).toBe(90);
  });
});

describe('os dependentes', () => {
  const base = { estado: 'ativa' as const, titularId: 'pai', candidatoId: 'filho' };

  it('o filho entra na assinatura do pai', () => {
    expect(podeSerDependente({ ...base, jaEDependenteDeOutra: false })).toBeNull();
  });

  it('o titular não é dependente de si mesmo', () => {
    // Ele apareceria duas vezes na lista de quem usa a cota.
    expect(
      podeSerDependente({ ...base, candidatoId: 'pai', jaEDependenteDeOutra: false }),
    ).toBe('e_o_titular');
  });

  it('ninguém é dependente de duas assinaturas', () => {
    // A mesma cota seria descontada de dois lugares.
    expect(podeSerDependente({ ...base, jaEDependenteDeOutra: true })).toBe('ja_e_dependente');
  });

  it('assinatura suspensa não recebe dependente', () => {
    expect(
      podeSerDependente({ ...base, estado: 'suspensa', jaEDependenteDeOutra: false }),
    ).toBe('assinatura_inativa');
  });

  it('a cota é da assinatura, não da pessoa', () => {
    /**
     * O plano família de dois cortes dá dois cortes para a família inteira, não
     * dois para cada. É o que a SPEC descreve — *"consumindo da mesma cota"* — e
     * é o que faz o plano ter preço.
     */
    expect(quemConsome('pai', ['filho', 'filha'])).toEqual(['pai', 'filho', 'filha']);
  });
});
