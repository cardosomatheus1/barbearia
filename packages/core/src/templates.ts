/**
 * Catálogo sugerido no onboarding.
 *
 * **Resolve o defeito D4 na origem.** No sistema analisado, o cardápio foi
 * digitado à mão sem validação: "Cabelo + Barba" declarava 40 minutos enquanto
 * cabelo (25) e barba (20) somavam 45. A grade nascia otimista e o barbeiro
 * atrasava o dia inteiro a partir do segundo cliente.
 *
 * Aqui a duração e o buffer já vêm coerentes, e o combo declara a soma real dos
 * componentes — não um número escolhido no olho.
 *
 * Preço é chute editável e está escrito como tal: a barbearia sempre ajusta. O
 * que não se ajusta com o dedo é duração, e é justamente ela que quebra a
 * agenda quando errada.
 */

export interface ServiceTemplate {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly durationMinutes: number;
  /** Limpeza entre atendimentos. Zero aqui é o que produz agenda impossível. */
  readonly bufferAfterMinutes: number;
  /** Sugestão inicial, em centavos. A barbearia edita na própria etapa. */
  readonly priceCents: number;
  /** Quando presente, este serviço é um combo dos serviços listados. */
  readonly componentKeys?: readonly string[];
}

export const SERVICE_TEMPLATES: readonly ServiceTemplate[] = [
  {
    key: 'corte-maquina',
    name: 'Corte (máquina)',
    description: 'Máquina zero ou pente único, com acabamento.',
    category: 'Cabelo',
    durationMinutes: 20,
    bufferAfterMinutes: 5,
    priceCents: 3500,
  },
  {
    key: 'corte-tesoura',
    name: 'Corte (tesoura)',
    description: 'Tesoura em cima, máquina nas laterais.',
    category: 'Cabelo',
    durationMinutes: 30,
    bufferAfterMinutes: 5,
    priceCents: 4500,
  },
  {
    key: 'pezinho',
    name: 'Pezinho',
    description: 'Acabamento da nuca e das costeletas.',
    category: 'Cabelo',
    durationMinutes: 10,
    bufferAfterMinutes: 5,
    priceCents: 1500,
  },
  {
    key: 'barba',
    name: 'Barba',
    description: 'Toalha quente, navalha e pós-barba.',
    category: 'Barba',
    durationMinutes: 25,
    bufferAfterMinutes: 5,
    priceCents: 3500,
  },
  {
    key: 'sobrancelha',
    name: 'Sobrancelha',
    description: 'Alinhamento na navalha ou na pinça.',
    category: 'Barba',
    durationMinutes: 10,
    bufferAfterMinutes: 5,
    priceCents: 1500,
  },
  {
    key: 'pigmentacao',
    name: 'Pigmentação',
    description: 'Preenchimento de falhas na barba ou no cabelo.',
    category: 'Tratamento',
    durationMinutes: 20,
    bufferAfterMinutes: 5,
    priceCents: 3000,
  },
  {
    key: 'lavagem',
    name: 'Lavagem',
    description: 'Lavagem e finalização.',
    category: 'Tratamento',
    durationMinutes: 15,
    bufferAfterMinutes: 5,
    priceCents: 2000,
  },
  {
    key: 'hidratacao',
    name: 'Hidratação',
    description: 'Hidratação profunda com massagem.',
    category: 'Tratamento',
    durationMinutes: 30,
    bufferAfterMinutes: 5,
    priceCents: 5000,
  },
  {
    key: 'corte-barba',
    name: 'Corte + Barba',
    description: 'O combinado mais pedido.',
    category: 'Combo',
    // 30 + 25 = 55, e é isso que fica escrito. O concorrente declarou 40 para o
    // mesmo par e a agenda dele nasceu devendo 15 minutos por cliente.
    durationMinutes: 55,
    bufferAfterMinutes: 5,
    // Abaixo da soma (R$ 80,00), que é o motivo de o combo existir.
    priceCents: 7000,
    componentKeys: ['corte-tesoura', 'barba'],
  },
];

export interface TemplateProblem {
  readonly key: string;
  readonly problem: 'combo_shorter_than_parts' | 'combo_not_cheaper' | 'unknown_component';
  readonly declared: number;
  readonly actual: number;
}

/**
 * Confere que nenhum combo promete menos tempo do que as partes levam.
 *
 * Roda sobre o que a barbearia editou, não só sobre o template: o dono muda a
 * duração de "corte" e o combo continua com o número antigo — é exatamente
 * assim que D4 renasce depois do onboarding.
 */
export function validateCombos(
  services: readonly {
    key: string;
    durationMinutes: number;
    priceCents: number;
    componentKeys?: readonly string[];
  }[],
): TemplateProblem[] {
  const porChave = new Map(services.map((s) => [s.key, s]));
  const problemas: TemplateProblem[] = [];

  for (const servico of services) {
    if (!servico.componentKeys || servico.componentKeys.length === 0) continue;

    let duracao = 0;
    let preco = 0;
    let completo = true;

    for (const chave of servico.componentKeys) {
      const parte = porChave.get(chave);
      if (!parte) {
        problemas.push({
          key: servico.key,
          problem: 'unknown_component',
          declared: servico.durationMinutes,
          actual: 0,
        });
        completo = false;
        break;
      }
      duracao += parte.durationMinutes;
      preco += parte.priceCents;
    }
    if (!completo) continue;

    if (servico.durationMinutes < duracao) {
      problemas.push({
        key: servico.key,
        problem: 'combo_shorter_than_parts',
        declared: servico.durationMinutes,
        actual: duracao,
      });
    }

    // Combo que não é mais barato não é combo — e o cliente que o escolhe está
    // pagando a mais achando que economiza.
    if (servico.priceCents >= preco) {
      problemas.push({
        key: servico.key,
        problem: 'combo_not_cheaper',
        declared: servico.priceCents,
        actual: preco,
      });
    }
  }

  return problemas;
}
