import { describe, expect, it } from 'vitest';
import {
  familiaDoNome,
  impedemPublicar,
  resumoDosAchados,
  validarCatalogo,
  type Catalogo,
  type ComboNoCatalogo,
  type ProfissionalNoCatalogo,
  type RegraDoCatalogo,
  type ServicoNoCatalogo,
} from './validador.js';

/**
 * O validador de catálogo — SPEC §5.7, que resolve D4 e D5.
 *
 * D4 é o defeito operacional mais caro observado em campo: combo cadastrado com
 * 30 minutos quando as partes somam 40, agenda atrasando o dia inteiro e
 * ninguém sabendo por quê. Estes testes existem para que o alerta apareça —
 * e, tão importante quanto, para que ele **não** apareça quando não há defeito.
 * Validador que grita à toa é validador desligado na primeira semana.
 */

const servico = (over: Partial<ServicoNoCatalogo> = {}): ServicoNoCatalogo => ({
  id: 's1',
  name: 'Corte',
  categoryName: 'Cabelo',
  priceCents: 5000,
  durationMinutes: 30,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  description: 'Corte na máquina e tesoura',
  photoUrl: 'https://exemplo.com/corte.jpg',
  active: true,
  bookableOnline: true,
  profissionais: 2,
  duracaoRealMediana: null,
  amostras: 0,
  ...over,
});

const combo = (over: Partial<ComboNoCatalogo> = {}): ComboNoCatalogo => ({
  id: 'c1',
  name: 'Cabelo + Barba',
  priceCents: 9000,
  durationMinutes: 60,
  toleranciaMinutes: 0,
  componentes: [
    { durationMinutes: 30, priceCents: 5000 },
    { durationMinutes: 30, priceCents: 5000 },
  ],
  ...over,
});

const pessoa = (over: Partial<ProfissionalNoCatalogo> = {}): ProfissionalNoCatalogo => ({
  id: 'p1',
  name: 'Ruan',
  kind: 'professional',
  minutosPorDia: [480, 480, 480, 480, 480],
  ...over,
});

const catalogo = (over: Partial<Catalogo> = {}): Catalogo => ({
  servicos: [servico()],
  combos: [],
  profissionais: [pessoa()],
  ...over,
});

const regras = (c: Catalogo): RegraDoCatalogo[] =>
  validarCatalogo(c).map((achado) => achado.regra);

describe('catálogo saudável', () => {
  it('não gera achado nenhum', () => {
    // O caso mais importante do arquivo: alerta que aparece sem defeito é como
    // a barbearia aprende a ignorar todos.
    expect(validarCatalogo(catalogo())).toEqual([]);
  });
});

describe('V1 — o combo que não cabe no tempo (D4)', () => {
  it('acusa combo mais curto que a soma das partes', () => {
    /**
     * O defeito exato do sistema analisado: "Cabelo + Barba" com 30 min, e as
     * partes somando 40. A agenda subestima, o atraso acumula, e a causa está
     * no cadastro — não na operação.
     */
    const achados = validarCatalogo(catalogo({ combos: [combo({ durationMinutes: 30 })] }));
    const v1 = achados.find((a) => a.regra === 'V1');

    expect(v1?.severidade).toBe('bloqueia');
    expect(v1?.titulo).toContain('30 min');
    expect(v1?.titulo).toContain('60 min');
    // O conserto traz o número, não só o diagnóstico.
    expect(v1?.conserto).toContain('60 min');
  });

  it('respeita a tolerância declarada pela barbearia', () => {
    // Cortar cabelo e barba na sequência é mais rápido que os dois separados —
    // e é a própria casa que diz quanto.
    const comTolerancia = combo({ durationMinutes: 50, toleranciaMinutes: 10 });
    expect(regras(catalogo({ combos: [comTolerancia] }))).not.toContain('V1');
  });

  it('um minuto além da tolerância já é achado', () => {
    const comTolerancia = combo({ durationMinutes: 49, toleranciaMinutes: 10 });
    expect(regras(catalogo({ combos: [comTolerancia] }))).toContain('V1');
  });

  it('combo mais longo que as partes não é problema', () => {
    expect(regras(catalogo({ combos: [combo({ durationMinutes: 70 })] }))).not.toContain('V1');
  });
});

describe('V2 — o combo sem vantagem', () => {
  it('acusa combo que custa o mesmo que as partes', () => {
    const semDesconto = combo({ priceCents: 10000 });
    const v2 = validarCatalogo(catalogo({ combos: [semDesconto] })).find((a) => a.regra === 'V2');

    expect(v2?.severidade).toBe('aviso');
    expect(v2?.conserto).toContain('mais barato');
  });

  it('combo mais barato passa', () => {
    expect(regras(catalogo({ combos: [combo({ priceCents: 8500 })] }))).not.toContain('V2');
  });
});

describe('V3 e V4 — o cardápio incompreensível (D5)', () => {
  it('acusa serviço na categoria errada pelo nome', () => {
    // "Sobrancelhas" em "Estética Facial" é o exemplo literal do D5.
    const fora = servico({ name: 'Sobrancelha', categoryName: 'Estética Facial' });
    const v3 = validarCatalogo(catalogo({ servicos: [fora] })).find((a) => a.regra === 'V3');

    expect(v3?.severidade).toBe('aviso');
    expect(v3?.conserto).toContain('Sobrancelha');
  });

  it('nome que a lista não conhece não vira achado', () => {
    /**
     * Regra legível que erra por omissão é melhor que classificador que erra
     * por invenção: o silêncio é a resposta certa para o que a lista não sabe.
     */
    const exotico = servico({ name: 'Ozonioterapia capilar', categoryName: 'Estética' });
    expect(regras(catalogo({ servicos: [exotico] }))).not.toContain('V3');
  });

  it('acento não muda a família', () => {
    expect(familiaDoNome('Degradê')).toBe('Cabelo');
    expect(familiaDoNome('Coloração')).toBe('Química');
  });

  it('acusa quando "Outros" guarda mais de 40% do cardápio', () => {
    // 11 de 17 era o número real do sistema analisado.
    const catalogoRuim = catalogo({
      servicos: [
        servico({ id: '1', name: 'Corte', categoryName: 'Outros Serviços' }),
        servico({ id: '2', name: 'Barba', categoryName: 'Outros Serviços' }),
        servico({ id: '3', name: 'Pezinho', categoryName: 'Cabelo' }),
      ],
    });
    const v4 = validarCatalogo(catalogoRuim).find((a) => a.regra === 'V4');
    expect(v4?.titulo).toContain('2 de 3');
  });

  it('serviço sem categoria conta como "Outros"', () => {
    // Não ter categoria e ter a categoria-saco são o mesmo problema para quem
    // procura um corte na lista.
    const semCategoria = catalogo({
      servicos: [
        servico({ id: '1', name: 'Corte', categoryName: null }),
        servico({ id: '2', name: 'Barba', categoryName: 'Barba' }),
      ],
    });
    expect(regras(semCategoria)).toContain('V4');
  });

  it('cardápio bem separado não gera achado', () => {
    const bom = catalogo({
      servicos: [
        servico({ id: '1', name: 'Corte', categoryName: 'Cabelo' }),
        servico({ id: '2', name: 'Barba', categoryName: 'Barba' }),
        servico({ id: '3', name: 'Sobrancelha', categoryName: 'Sobrancelha' }),
      ],
    });
    expect(regras(bom)).not.toContain('V4');
  });
});

describe('V5, V6 e V10 — o serviço que não vende', () => {
  it('serviço sem profissional impede publicar', () => {
    const orfao = servico({ profissionais: 0 });
    const v5 = validarCatalogo(catalogo({ servicos: [orfao] })).find((a) => a.regra === 'V5');
    expect(v5?.severidade).toBe('publicacao');
  });

  it('preço zerado bloqueia', () => {
    const v10 = validarCatalogo(catalogo({ servicos: [servico({ priceCents: 0 })] }))
      .find((a) => a.regra === 'V10');
    expect(v10?.severidade).toBe('bloqueia');
    expect(v10?.conserto).toContain('faturamento');
  });

  it('sem descrição e sem foto vira um achado só, dizendo os dois', () => {
    const pelado = servico({ description: null, photoUrl: null });
    const v6 = validarCatalogo(catalogo({ servicos: [pelado] })).filter((a) => a.regra === 'V6');
    expect(v6).toHaveLength(1);
    expect(v6[0]?.titulo).toContain('descrição e foto');
  });

  it('serviço que não aparece na página não precisa de foto', () => {
    // Encaixe interno da recepção não é vitrine.
    const interno = servico({ description: null, photoUrl: null, bookableOnline: false });
    expect(regras(catalogo({ servicos: [interno] }))).not.toContain('V6');
  });

  it('serviço desativado não gera achado nenhum', () => {
    const desligado = servico({ active: false, priceCents: 0, profissionais: 0, photoUrl: null });
    expect(validarCatalogo(catalogo({ servicos: [desligado] }))).toEqual([]);
  });
});

describe('V7 — a duração real contra a cadastrada (D4)', () => {
  const medido = (real: number, amostras: number, cadastrada = 30) =>
    catalogo({
      servicos: [servico({ durationMinutes: cadastrada, duracaoRealMediana: real, amostras })],
    });

  it('acusa quando o real passa muito da cadastrada', () => {
    /**
     * O alerta que a SPEC diz justificar a migração sozinho: cadastrado 30,
     * real 43, e o dono descobrindo por que o dia atrasa.
     */
    const v7 = validarCatalogo(medido(43, 40)).find((a) => a.regra === 'V7');
    expect(v7?.titulo).toContain('43 min');
    expect(v7?.titulo).toContain('40 atendimentos');
    // Arredondado para cima no múltiplo de 5: agenda não usa minuto quebrado.
    expect(v7?.conserto).toContain('45 min');
    expect(v7?.conserto).toContain('13 min de atraso');
  });

  it('acusa também quando sobra tempo', () => {
    // Reservar 30 para um serviço de 20 é desperdiçar capacidade — o produto
    // vende agenda, e buraco morto é dinheiro perdido.
    const v7 = validarCatalogo(medido(20, 40)).find((a) => a.regra === 'V7');
    expect(v7?.conserto).toContain('perdendo horário');
    expect(v7?.conserto).toContain('20 min');
  });

  it('amostra pequena não vira alerta', () => {
    /**
     * Abaixo do piso a mediana ainda oscila com um corte demorado, e alerta que
     * aparece e some é alerta que a barbearia aprende a ignorar.
     */
    expect(regras(medido(43, 19))).not.toContain('V7');
    expect(regras(medido(43, 20))).toContain('V7');
  });

  it('diferença pequena não vira alerta', () => {
    // 30 cadastrados contra 35 reais são 17%: ruído de um dia cheio.
    expect(regras(medido(35, 40))).not.toContain('V7');
    expect(regras(medido(37, 40))).toContain('V7');
  });

  it('sem medição não há palpite', () => {
    expect(regras(catalogo({ servicos: [servico({ duracaoRealMediana: null, amostras: 99 })] })))
      .not.toContain('V7');
  });
});

describe('V8 — o intervalo que destoa da própria casa', () => {
  const daFamilia = (id: string, buffer: number) =>
    servico({ id, name: `Corte ${id}`, categoryName: 'Cabelo', bufferAfterMinutes: buffer });

  it('acusa o único sem intervalo quando a maioria tem', () => {
    const c = catalogo({
      servicos: [daFamilia('1', 5), daFamilia('2', 5), daFamilia('3', 5), daFamilia('4', 0)],
    });
    const v8 = validarCatalogo(c).filter((a) => a.regra === 'V8');
    expect(v8).toHaveLength(1);
    expect(v8[0]?.alvoId).toBe('4');
  });

  it('casa que não usa intervalo em nada não é incomodada', () => {
    /**
     * O padrão é o da própria barbearia, não uma constante minha. Comparar
     * contra um número universal geraria alerta em toda casa que trabalha sem
     * buffer por opção.
     */
    const c = catalogo({
      servicos: [daFamilia('1', 0), daFamilia('2', 0), daFamilia('3', 0), daFamilia('4', 0)],
    });
    expect(regras(c)).not.toContain('V8');
  });

  it('menos de três serviços na família não é padrão', () => {
    const c = catalogo({ servicos: [daFamilia('1', 5), daFamilia('2', 0)] });
    expect(regras(c)).not.toContain('V8');
  });
});

describe('V9 — a agenda que não é de gente (D12)', () => {
  it('acusa jornada de mais de 12h em todos os sete dias', () => {
    // Duas das quatro "agendas" do sistema analisado eram contas de balcão com
    // jornada 08:00–23:00 todos os dias.
    const balcao = pessoa({ name: 'Cadeira 2', minutosPorDia: Array(7).fill(15 * 60) });
    const v9 = validarCatalogo(catalogo({ profissionais: [balcao] })).find((a) => a.regra === 'V9');
    expect(v9?.conserto).toContain('estação');
  });

  it('quem folga um dia é gente', () => {
    const gente = pessoa({ minutosPorDia: [13 * 60, 13 * 60, 13 * 60, 13 * 60, 13 * 60, 13 * 60] });
    expect(regras(catalogo({ profissionais: [gente] }))).not.toContain('V9');
  });

  it('quem já está cadastrado como estação não é acusado', () => {
    const estacao = pessoa({ kind: 'resource_only', minutosPorDia: Array(7).fill(15 * 60) });
    expect(regras(catalogo({ profissionais: [estacao] }))).not.toContain('V9');
  });
});

describe('o que a tela precisa saber', () => {
  it('separa o que impede publicar do que é conselho', () => {
    const c = catalogo({
      servicos: [servico({ priceCents: 0, profissionais: 0, photoUrl: null })],
    });
    const achados = validarCatalogo(c);

    expect(resumoDosAchados(achados)).toMatchObject({ bloqueia: 1, publicacao: 1, aviso: 1 });
    expect(impedemPublicar(achados).map((a) => a.regra).sort()).toEqual(['V10', 'V5']);
  });

  it('todo achado carrega o conserto', () => {
    // A SPEC pede alerta acionável. Sem o que fazer, o alerta vira mais uma
    // tarefa para alguém descobrir sozinho.
    const c = catalogo({
      servicos: [
        servico({ id: '1', priceCents: 0, profissionais: 0, photoUrl: null }),
        servico({ id: '2', name: 'Sobrancelha', categoryName: 'Estética Facial' }),
      ],
      combos: [combo({ durationMinutes: 30, priceCents: 12000 })],
      profissionais: [pessoa({ minutosPorDia: Array(7).fill(15 * 60) })],
    });

    for (const achado of validarCatalogo(c)) {
      expect(achado.conserto.length, `${achado.regra} sem conserto`).toBeGreaterThan(20);
      expect(achado.alvoNome.length, `${achado.regra} sem alvo`).toBeGreaterThan(0);
    }
  });
});
