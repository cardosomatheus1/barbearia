import { z } from 'zod';
import { ESPECIALIDADES, MAXIMO_DE_ESPECIALIDADES,
  TIPOS_DE_CADEIRA,
} from '@barbearia/core';

/**
 * Entrada do CRUD do admin, validada na borda.
 *
 * Os tetos não são decoração. Duração e preço entram no motor de grade e no
 * cálculo do que o cliente paga: sem piso e teto aqui, um zero a mais no
 * formulário vira serviço de dezesseis horas que come a agenda inteira, e um
 * negativo vira desconto que ninguém pediu.
 */

export const idSchema = z.string().uuid();

/** Dinheiro em centavos inteiros — nunca float (CLAUDE.md). */
const centavos = z.number().int().min(0).max(10_000_000);

/**
 * Doze horas de teto e cinco minutos de piso.
 *
 * O piso existe porque `duration_minutes` é o passo da grade: um serviço de um
 * minuto geraria centenas de horários por dia e a página pública ficaria
 * inutilizável no celular.
 */
const duracao = z.number().int().min(5).max(720);

const buffer = z.number().int().min(0).max(120);

export const serviceSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).nullish(),
  categoryName: z.string().trim().min(1).max(60),
  priceCents: centavos,
  durationMinutes: duracao,
  bufferBeforeMinutes: buffer,
  bufferAfterMinutes: buffer,
  bookableOnline: z.boolean(),
  /**
   * Sempre exigir sinal deste serviço (bloco 37, SPEC §2.12).
   *
   * Opcional na borda para que a tela de catálogo anterior continue salvando —
   * e a ausência vale `false`, que é o comportamento de sempre. Um padrão
   * `true` faria toda coloração já cadastrada passar a pedir pagamento
   * adiantado no dia do deploy, sem ninguém ter decidido nada.
   */
  alwaysRequireDeposit: z.boolean().optional(),
  /**
   * Um combo tem ao menos duas partes. Uma parte só não é combo — é o mesmo
   * serviço com outro nome, e vira exatamente o tipo de catálogo duplicado que
   * o defeito D4 descreve.
   */
  componentIds: z.array(idSchema).max(10).optional(),
  /**
   * O ganho de fazer o combo na sequência, em minutos (bloco 111).
   *
   * A coluna existe desde a migração 0023, o validador a lê em duas regras e o
   * domínio a grava — e a borda **não a declarava**, então `z.object` a
   * descartava em silêncio. O único caminho que escreve recebia sempre
   * `undefined`, e o diagnóstico do catálogo mandava "aumente a tolerância"
   * sobre um valor que nunca saía de zero.
   *
   * Opcional pela mesma razão de `alwaysRequireDeposit`: ausente é "não mexa".
   */
  comboToleranceMinutes: z.number().int().min(0).max(60).optional(),
});

export const activeSchema = z.object({ active: z.boolean() });

export const professionalSchema = z.object({
  name: z.string().trim().min(2).max(80),
  bio: z.string().trim().max(600).nullish(),
  /**
   * Os quatro do enum, e não três nomes inventados (bloco 114).
   *
   * A borda aceitava `station` e `room`; `professional_kind` tem
   * `professional`, `counter`, `resource_only` e `external`. O domínio faz
   * `${input.kind}::professional_kind`, então escolher "Estação" na tela
   * respondia **500** — não havia como cadastrar uma cadeira que não fosse
   * profissional, e por isso o defeito D12 (balcão contado como cadeira nos
   * relatórios) nunca doía: ele estava inalcançável.
   *
   * A lista sai do domínio, como toda lista fechada deste código.
   */
  kind: z.enum(TIPOS_DE_CADEIRA as unknown as [string, ...string[]]),
  bookableOnline: z.boolean(),
  dailyLimit: z.number().int().min(1).max(100).nullish(),
  serviceIds: z.array(idSchema).max(200).optional(),
});

/** Minuto local desde a meia-noite; 1440 é o fim do dia, não o começo do outro. */
const minuto = z.number().int().min(0).max(1440);

const faixaSchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    startMinute: minuto,
    endMinute: minuto,
    breaks: z
      .array(z.object({ start: minuto, end: minuto }).refine((i) => i.start < i.end))
      .max(6)
      .default([]),
  })
  .refine((faixa) => faixa.startMinute < faixa.endMinute, {
    message: 'A hora de entrada precisa ser antes da hora de saída.',
  })
  .refine(
    (faixa) =>
      faixa.breaks.every(
        (intervalo) =>
          intervalo.start >= faixa.startMinute && intervalo.end <= faixa.endMinute,
      ),
    { message: 'O intervalo precisa estar dentro da jornada do dia.' },
  );

export const scheduleSchema = z.object({
  faixas: z.array(faixaSchema).max(28),
  /**
   * Gravar mesmo deixando agendamento fora da jornada.
   *
   * A primeira chamada devolve os conflitos e não grava; a segunda, com este
   * campo, grava. O passo intermediário existe porque encolher a terça sem ver
   * quem já estava marcado às 15h é como o horário some da tela do balcão sem
   * ninguém ter cancelado nada.
   */
  confirmarConflitos: z.boolean().default(false),
});

export const resourcesSchema = z.object({
  pools: z
    .array(
      z.object({
        resourceType: z.string().trim().min(2).max(40),
        capacity: z.number().int().min(1).max(100),
      }),
    )
    .max(30),
});

export const serviceResourcesSchema = z.object({
  requirements: z
    .array(
      z.object({
        resourceType: z.string().trim().min(2).max(40),
        quantity: z.number().int().min(1).max(20),
      }),
    )
    .max(10),
});

/**
 * O perfil público do barbeiro (bloco 73, SPEC §5.2).
 *
 * A especialidade é conjunto **fechado** na borda, e não texto livre: o que não
 * está no catálogo não existe, e a recusa acontece antes de qualquer ida ao
 * banco. Um valor inventado aqui não quebra nada — o domínio o descarta —, mas
 * recusar cedo dá motivo legível em vez de um perfil salvo com menos coisas do
 * que a pessoa marcou.
 */
export const perfilPublicoSchema = z.object({
  ligado: z.boolean(),
  especialidades: z.array(z.enum(ESPECIALIDADES)).max(MAXIMO_DE_ESPECIALIDADES).default([]),
  /** Ausente é "não mexa", nunca "apague" — a regra do campo opcional na borda. */
  bio: z.string().trim().max(500).optional(),
});
