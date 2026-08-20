import type { TipoDeCadeira } from './attendance.js';
/**
 * Validador de integridade de catálogo — SPEC §5.7.
 *
 * > **Resolve D4 e D5**, os defeitos mais caros encontrados no sistema
 * > analisado em campo.
 *
 * D4 é o combo "Cabelo + Barba" cadastrado com 30 minutos quando as partes
 * somam 40. A agenda subestima o tempo real, o atraso acumula ao longo do dia e
 * ninguém sabe a causa — porque o defeito está no cadastro, não na operação. A
 * SPEC diz que o alerta de V7 **sozinho justifica a migração** para uma
 * barbearia que sofre com atraso crônico.
 *
 * D5 é o cardápio incompreensível: 11 de 17 serviços em "Outros Serviços".
 *
 * Puro, como todo `core`: entra o retrato do catálogo, sai a lista de achados.
 * Quem lê o banco é `packages/catalog`; quem decide o que é problema é aqui.
 *
 * ## Duas decisões que valem ler antes de mexer
 *
 * **Severidade é sobre consequência, não sobre gosto.** `bloqueia` é o que
 * quebra a agenda ou cobra errado; `publicacao` é o que deixa o cliente ver um
 * horário que não existe; `aviso` é o resto. Um validador que trata tudo como
 * erro é um validador que a barbearia desliga na primeira semana.
 *
 * **Todo achado carrega o conserto.** "Duração inconsistente" não é acionável;
 * "cadastrado 30 min, real 43 min, ajustar para 45" é. A SPEC pede alerta
 * acionável, e sem o número sugerido o alerta vira mais uma tarefa para alguém
 * descobrir sozinho.
 */

export type Severidade = 'bloqueia' | 'publicacao' | 'aviso';

/** As regras da SPEC §5.7, com o código que ela usa. */
export type RegraDoCatalogo =
  | 'V1' | 'V2' | 'V3' | 'V4' | 'V5'
  | 'V6' | 'V7' | 'V8' | 'V9' | 'V10';

export interface Achado {
  readonly regra: RegraDoCatalogo;
  readonly severidade: Severidade;
  /** O que está errado, em uma frase que o dono entende. */
  readonly titulo: string;
  /** O que fazer. Vazio só quando não há conserto automático possível. */
  readonly conserto: string;
  /** Serviço, combo ou profissional a que o achado se refere. */
  readonly alvoId: string | null;
  readonly alvoNome: string;
}

export interface ServicoNoCatalogo {
  readonly id: string;
  readonly name: string;
  readonly categoryName: string | null;
  readonly priceCents: number;
  readonly durationMinutes: number;
  readonly bufferBeforeMinutes: number;
  readonly bufferAfterMinutes: number;
  readonly description: string | null;
  readonly photoUrl: string | null;
  readonly active: boolean;
  readonly bookableOnline: boolean;
  /** Quantos profissionais ativos executam. */
  readonly profissionais: number;
  /** Mediana da duração real medida, em minutos. Nulo sem amostra suficiente. */
  readonly duracaoRealMediana: number | null;
  readonly amostras: number;
}

export interface ComboNoCatalogo {
  readonly id: string;
  readonly name: string;
  readonly priceCents: number;
  readonly durationMinutes: number;
  /** Tolerância declarada pela barbearia, em minutos. */
  readonly toleranciaMinutes: number;
  readonly componentes: readonly { readonly durationMinutes: number; readonly priceCents: number }[];
}

export interface ProfissionalNoCatalogo {
  readonly id: string;
  readonly name: string;
  readonly kind: TipoDeCadeira | string;
  /** Minutos de jornada por dia da semana em que trabalha. */
  readonly minutosPorDia: readonly number[];
}

export interface Catalogo {
  readonly servicos: readonly ServicoNoCatalogo[];
  readonly combos: readonly ComboNoCatalogo[];
  readonly profissionais: readonly ProfissionalNoCatalogo[];
}

/**
 * Amostra mínima antes de acusar a duração cadastrada.
 *
 * A SPEC fala em "últimos 40 atendimentos". Vinte é o piso para o alerta
 * aparecer: abaixo disso a mediana ainda oscila com um corte demorado, e alerta
 * que aparece e some é alerta que a barbearia aprende a ignorar.
 */
const AMOSTRA_MINIMA = 20;

/**
 * Quanto a duração real precisa passar da cadastrada para virar achado.
 *
 * A SPEC pede "fora de 2σ da mediana real". Sem guardar a distribuição inteira,
 * o proxy é um percentual: 20% de diferença sobre um corte de 30 minutos são 6
 * minutos por atendimento, que é meia hora de atraso num dia de cinco cortes.
 * É onde o erro deixa de ser ruído e vira o atraso crônico do D4.
 */
const DESVIO_TOLERADO = 0.2;

/** Acima disto, a categoria "Outros" deixou de organizar coisa nenhuma (D5). */
const TETO_DE_OUTROS = 0.4;

/** Jornada acima disto por sete dias é agenda de balcão, não de gente (D12). */
const JORNADA_SUSPEITA_MINUTOS = 12 * 60;

/**
 * Os nomes que a barbearia dá para a categoria-saco.
 *
 * Comparados **já sem acento**: a primeira versão normalizava só a entrada e
 * deixava `'outros serviços'` com cedilha na lista, então "Outros Serviços" —
 * o nome literal do sistema analisado — passava sem ser reconhecido. O teste
 * pegou.
 */
const NOMES_DE_OUTROS = ['outros', 'outros servicos', 'diversos', 'geral', 'sem categoria'];

/**
 * Palavras que denunciam a categoria errada.
 *
 * Lista curta e explícita, não classificador: o vocabulário de barbearia é
 * pequeno e estável, e um acerto de 90% com regra legível vale mais do que 95%
 * com regra que ninguém consegue corrigir. Serviço que não casa com nada não
 * gera achado — o silêncio é a resposta certa para o que a lista não conhece.
 */
const FAMILIAS: readonly { readonly familia: string; readonly palavras: readonly string[] }[] = [
  { familia: 'Cabelo', palavras: ['corte', 'cabelo', 'degrade', 'degradê', 'maquina', 'máquina', 'tesoura', 'pezinho'] },
  { familia: 'Barba', palavras: ['barba', 'bigode', 'navalha'] },
  { familia: 'Sobrancelha', palavras: ['sobrancelha', 'sobrancelhas'] },
  { familia: 'Química', palavras: ['tintura', 'coloração', 'coloracao', 'luzes', 'platinado', 'relaxamento', 'progressiva', 'alisamento'] },
];

const semAcento = (texto: string): string =>
  texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** A que família o nome do serviço pertence, ou `null` se a lista não sabe. */
export function familiaDoNome(nome: string): string | null {
  const limpo = semAcento(nome);
  for (const { familia, palavras } of FAMILIAS) {
    if (palavras.some((palavra) => limpo.includes(semAcento(palavra)))) return familia;
  }
  return null;
}

const ehCategoriaDeOutros = (nome: string | null): boolean =>
  nome === null || NOMES_DE_OUTROS.includes(semAcento(nome));

/** Arredonda para cima no múltiplo de 5: agenda de barbearia não usa minuto quebrado. */
const arredondar5 = (minutos: number): number => Math.ceil(minutos / 5) * 5;

const reais = (cents: number): string =>
  `R$ ${(cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

export function validarCatalogo(catalogo: Catalogo): readonly Achado[] {
  const achados: Achado[] = [];
  const ativos = catalogo.servicos.filter((servico) => servico.active);

  // -- V1 e V2: o combo --------------------------------------------------------
  for (const combo of catalogo.combos) {
    const somaDuracao = combo.componentes.reduce((total, parte) => total + parte.durationMinutes, 0);
    const somaPreco = combo.componentes.reduce((total, parte) => total + parte.priceCents, 0);

    if (combo.componentes.length > 0 && combo.durationMinutes < somaDuracao - combo.toleranciaMinutes) {
      achados.push({
        regra: 'V1',
        severidade: 'bloqueia',
        titulo:
          `"${combo.name}" reserva ${combo.durationMinutes} min, mas as partes somam ${somaDuracao} min.`,
        conserto:
          `A agenda vai atrasar ${somaDuracao - combo.durationMinutes} min a cada venda deste combo. `
          + `Ajuste para ${arredondar5(somaDuracao - combo.toleranciaMinutes)} min ou aumente a tolerância.`,
        alvoId: combo.id,
        alvoNome: combo.name,
      });
    }

    if (combo.componentes.length > 0 && combo.priceCents >= somaPreco) {
      achados.push({
        regra: 'V2',
        severidade: 'aviso',
        titulo: `"${combo.name}" custa ${reais(combo.priceCents)} e as partes somam ${reais(somaPreco)}.`,
        conserto:
          'Combo que não sai mais barato não é combo: ninguém escolhe, e ele só ocupa espaço no '
          + 'cardápio. Baixe o preço ou tire o combo.',
        alvoId: combo.id,
        alvoNome: combo.name,
      });
    }
  }

  // -- V3 e V4: a organização do cardápio (D5) ---------------------------------
  for (const servico of ativos) {
    const familia = familiaDoNome(servico.name);
    if (!familia || !servico.categoryName) continue;
    if (ehCategoriaDeOutros(servico.categoryName)) continue;
    if (semAcento(servico.categoryName).includes(semAcento(familia))) continue;

    achados.push({
      regra: 'V3',
      severidade: 'aviso',
      titulo: `"${servico.name}" está em "${servico.categoryName}".`,
      conserto: `Pelo nome, ele parece de "${familia}". Cardápio agrupado errado confunde na hora de escolher.`,
      alvoId: servico.id,
      alvoNome: servico.name,
    });
  }

  const emOutros = ativos.filter((servico) => ehCategoriaDeOutros(servico.categoryName));
  if (ativos.length > 0 && emOutros.length / ativos.length > TETO_DE_OUTROS) {
    achados.push({
      regra: 'V4',
      severidade: 'aviso',
      titulo:
        `${emOutros.length} de ${ativos.length} serviços estão sem categoria ou em "Outros".`,
      conserto:
        'Categoria que guarda quase tudo não organiza nada — o cliente rola a lista inteira para '
        + 'achar um corte. Separe pelo menos Cabelo, Barba e Sobrancelha.',
      alvoId: null,
      alvoNome: 'Cardápio',
    });
  }

  // -- V5, V6, V10: cada serviço -----------------------------------------------
  for (const servico of ativos) {
    if (servico.priceCents <= 0) {
      achados.push({
        regra: 'V10',
        severidade: 'bloqueia',
        titulo: `"${servico.name}" está sem preço.`,
        conserto: 'Serviço sem preço fecha comanda em zero e some do faturamento. Defina o valor.',
        alvoId: servico.id,
        alvoNome: servico.name,
      });
    }

    if (servico.profissionais === 0) {
      achados.push({
        regra: 'V5',
        severidade: 'publicacao',
        titulo: `Ninguém executa "${servico.name}".`,
        conserto:
          'Ele aparece no cardápio e nunca tem horário livre — o cliente tenta, não consegue e vai '
          + 'embora. Marque quem faz, ou desative o serviço.',
        alvoId: servico.id,
        alvoNome: servico.name,
      });
    }

    if (servico.bookableOnline && (!servico.description?.trim() || !servico.photoUrl?.trim())) {
      const falta = !servico.description?.trim()
        ? !servico.photoUrl?.trim() ? 'descrição e foto' : 'descrição'
        : 'foto';
      achados.push({
        regra: 'V6',
        severidade: 'aviso',
        titulo: `"${servico.name}" está sem ${falta}.`,
        conserto:
          'Em barbearia a escolha é visual (defeito D9). Serviço só com nome e preço vende menos que '
          + 'o vizinho que mostra o corte.',
        alvoId: servico.id,
        alvoNome: servico.name,
      });
    }
  }

  // -- V7: a duração real contra a cadastrada (D4) -----------------------------
  for (const servico of ativos) {
    if (servico.duracaoRealMediana === null || servico.amostras < AMOSTRA_MINIMA) continue;

    const diferenca = servico.duracaoRealMediana - servico.durationMinutes;
    if (Math.abs(diferenca) <= servico.durationMinutes * DESVIO_TOLERADO) continue;

    const atrasa = diferenca > 0;
    achados.push({
      regra: 'V7',
      severidade: 'aviso',
      titulo:
        `"${servico.name}": cadastrado ${servico.durationMinutes} min, real `
        + `${servico.duracaoRealMediana} min (mediana de ${servico.amostras} atendimentos).`,
      conserto: atrasa
        ? `São ${diferenca} min de atraso por atendimento, que acumulam no dia. `
          + `Ajuste para ${arredondar5(servico.duracaoRealMediana)} min.`
        : `Sobram ${Math.abs(diferenca)} min por atendimento — a agenda está reservando mais tempo `
          + `do que você usa e perdendo horário. Ajuste para ${arredondar5(servico.duracaoRealMediana)} min.`,
      alvoId: servico.id,
      alvoNome: servico.name,
    });
  }

  // -- V8: buffer fora do padrão da própria casa -------------------------------
  achados.push(...semBuffer(ativos));

  // -- V9: agenda que não é de gente (D12) -------------------------------------
  for (const pessoa of catalogo.profissionais) {
    if (pessoa.kind !== 'professional') continue;
    if (pessoa.minutosPorDia.length < 7) continue;
    if (!pessoa.minutosPorDia.every((minutos) => minutos > JORNADA_SUSPEITA_MINUTOS)) continue;

    achados.push({
      regra: 'V9',
      severidade: 'aviso',
      titulo: `"${pessoa.name}" trabalha mais de 12h todos os dias da semana.`,
      conserto:
        'Isso costuma ser conta de balcão cadastrada como profissional. Ela polui a ocupação e a '
        + 'comissão — mude o tipo para estação ou sala.',
      alvoId: pessoa.id,
      alvoNome: pessoa.name,
    });
  }

  return achados;
}

/**
 * V8 — serviço sem buffer numa família que costuma ter.
 *
 * O padrão é o da **própria barbearia**, não um número que eu escolhi: se a
 * maioria dos cortes reserva 5 minutos de limpeza e um não reserva, é o que
 * destoa que interessa. Comparar contra uma constante universal geraria alerta
 * em toda casa que trabalha sem buffer por opção.
 */
function semBuffer(servicos: readonly ServicoNoCatalogo[]): readonly Achado[] {
  const porFamilia = new Map<string, ServicoNoCatalogo[]>();
  for (const servico of servicos) {
    const familia = familiaDoNome(servico.name);
    if (!familia) continue;
    porFamilia.set(familia, [...(porFamilia.get(familia) ?? []), servico]);
  }

  const achados: Achado[] = [];
  for (const [familia, doGrupo] of porFamilia) {
    // Menos de três não é padrão, é coincidência.
    if (doGrupo.length < 3) continue;

    const comBuffer = doGrupo.filter((s) => s.bufferBeforeMinutes + s.bufferAfterMinutes > 0);
    if (comBuffer.length <= doGrupo.length / 2) continue;

    for (const servico of doGrupo) {
      if (servico.bufferBeforeMinutes + servico.bufferAfterMinutes > 0) continue;
      achados.push({
        regra: 'V8',
        severidade: 'aviso',
        titulo: `"${servico.name}" não reserva intervalo, e os outros de ${familia} reservam.`,
        conserto:
          'Sem o intervalo, o próximo cliente é marcado em cima do anterior e o atraso começa aí. '
          + 'Confira se foi de propósito.',
        alvoId: servico.id,
        alvoNome: servico.name,
      });
    }
  }

  return achados;
}

/** O que impede publicar, na ordem em que o dono precisa resolver. */
export function impedemPublicar(achados: readonly Achado[]): readonly Achado[] {
  return achados.filter((achado) => achado.severidade !== 'aviso');
}

/** Contagem por severidade, para a tela dizer o tamanho do problema de relance. */
export function resumoDosAchados(achados: readonly Achado[]): Record<Severidade, number> {
  return {
    bloqueia: achados.filter((a) => a.severidade === 'bloqueia').length,
    publicacao: achados.filter((a) => a.severidade === 'publicacao').length,
    aviso: achados.filter((a) => a.severidade === 'aviso').length,
  };
}
