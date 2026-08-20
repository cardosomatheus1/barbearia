import { z } from 'zod';
import { ESCOPOS, MODALIDADES_DE_SINAL, tryNormalizeBusinessPhone } from '@barbearia/core';
import { AMENITIES, PAYMENT_METHODS } from '@barbearia/onboarding';

/**
 * Entrada do painel, validada na borda.
 *
 * Os tetos existem porque estes campos vão para a página pública: nome de
 * serviço sem limite quebra o layout do cliente, e texto livre sem limite é
 * armazenamento gratuito para quem quiser abusar.
 */

const minutos = z.number().int().min(0).max(1440);

/**
 * Telefone de contato da barbearia: entra como a pessoa escreve, sai em E.164.
 *
 * Vazio vira `undefined` em vez de erro — apagar o número é uma edição
 * legítima, e um campo em branco no formulário não é entrada inválida.
 */
/**
 * String de formulário: ausente é "não mexa", vazia é "apague".
 *
 * Uma função só porque a distinção precisa ser a mesma em todos os campos — a
 * etapa 2 é a única tela desse cadastro, e um campo que se comportasse
 * diferente dos vizinhos seria a pessoa aprendendo que "às vezes salva".
 */
const vazioApaga = (valor: string | undefined): string | null | undefined =>
  valor === undefined ? undefined : valor === '' ? null : valor;

const contatoDaBarbearia = z
  .string()
  .trim()
  .max(24)
  .optional()
  .transform((valor, ctx) => {
    /**
     * Campo **enviado vazio** é limpeza, e não omissão (bloco 111).
     *
     * Com `undefined`, o `COALESCE` do domínio preservava o valor antigo e não
     * havia caminho no produto para tirar o número do ar — a pessoa apagava o
     * campo, lia "salvo" e o celular pessoal continuava na página indexada. A
     * distinção só passou a existir quando a etapa 2 passou a vir preenchida:
     * antes, "vazio" era o estado normal de um formulário que não mostrava nada.
     *
     * `undefined` continua significando "não mandou" — é o que a chave ausente
     * produz, e é o que outras rotas usam.
     */
    if (valor === '') return null;
    if (valor === undefined) return undefined;
    const normalizado = tryNormalizeBusinessPhone(valor);
    if (!normalizado.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `telefone inválido: ${normalizado.code}` });
      return z.NEVER;
    }
    return normalizado.phone;
  });

export const signUpSchema = z.object({
  name: z.string().trim().min(3).max(80),
  email: z.string().trim().email().max(160),
  // O piso combina com `MIN_PASSWORD` do domínio; aqui é só para recusar cedo.
  password: z.string().min(10).max(200),
  phone: z.string().min(8).max(24),
  businessName: z.string().trim().min(2).max(80),
});

export const loginSchema = z.object({
  email: z.string().trim().email().max(160),
  password: z.string().min(1).max(200),
});

export const businessSchema = z.object({
  name: z.string().trim().min(2).max(80),
  street: z.string().trim().max(160).optional().transform(vazioApaga),
  district: z.string().trim().max(80).optional().transform(vazioApaga),
  city: z.string().trim().max(80).optional().transform(vazioApaga),
  state: z.string().trim().optional().transform(vazioApaga)
    .refine((v) => v == null || v.length === 2, 'UF tem duas letras'),
  postalCode: z.string().trim().max(12).optional().transform(vazioApaga),
  /**
   * O link do mapa, que é por onde a coordenada entra (bloco 115).
   *
   * Vazio apaga, como os vizinhos: quem colou o link errado precisa poder
   * tirá-lo, e aí a casa volta ao centro da capital.
   */
  linkDoMapa: z.string().trim().max(500).optional().transform(vazioApaga),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  /**
   * O contato da barbearia, normalizado **aqui** e não no banco.
   *
   * `locations.phone_e164` tem `CHECK` de formato E.164, e o que chegava era o
   * que o cliente mandasse: `(71) 3333-4444` — a forma como todo mundo escreve
   * — passava pelo `max(20)`, batia na constraint e virava **500 "Erro
   * interno"**. Entrada externa inválida tem que ser recusada na borda, com o
   * motivo; deixar o banco recusar transforma erro do usuário em erro do
   * servidor, e some do log como se fosse defeito nosso.
   *
   * `normalizeBusinessPhone` e não `normalizePhone`: aqui o fixo é legítimo.
   */
  phone: contatoDaBarbearia,
  whatsapp: contatoDaBarbearia,
  instagram: z.string().trim().max(80).optional().transform(vazioApaga),
  about: z.string().trim().max(600).optional().transform(vazioApaga),
  // O fuso vem da unidade, nunca do dispositivo (CLAUDE.md §2). Aqui ele é
  // escolhido explicitamente pelo dono, e é a única vez que isso acontece.
  timezone: z.string().trim().max(64).optional(),
  amenities: z.array(z.enum(AMENITIES)).max(AMENITIES.length).optional(),
});

const servicoSchema = z.object({
  key: z.string().trim().min(1).max(60),
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).optional(),
  category: z.string().trim().min(1).max(40),
  durationMinutes: z.number().int().min(5).max(600),
  bufferAfterMinutes: z.number().int().min(0).max(120),
  priceCents: z.number().int().min(0).max(10_000_00),
  componentKeys: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
});

export const servicesSchema = z.object({
  services: z.array(servicoSchema).min(1).max(80),
});

export const professionalsSchema = z.object({
  professionals: z
    .array(
      z.object({
        name: z.string().trim().min(2).max(80),
        bio: z.string().trim().max(300).optional(),
        phone: z.string().trim().max(20).optional(),
        schedule: z
          .array(
            z
              .object({
                weekday: z.number().int().min(0).max(6),
                startMinute: minutos,
                endMinute: minutos,
              })
              // Jornada invertida passaria pelo banco e produziria dia sem
              // horário nenhum, sem erro visível.
              .refine((d) => d.startMinute < d.endMinute, {
                message: 'início precisa ser antes do fim',
              }),
          )
          .max(21),
        serviceNames: z.array(z.string().trim().max(80)).max(80).optional(),
      }),
    )
    .min(1)
    .max(50),
});

export const paymentsSchema = z.object({
  methods: z.array(z.enum(PAYMENT_METHODS)).max(PAYMENT_METHODS.length),
});

export const changeWindowSchema = z.object({
  // O teto acompanha a CHECK do banco: 720 horas são 30 dias.
  cancelMinHours: z.number().int().min(0).max(720),
  rescheduleMinHours: z.number().int().min(0).max(720),
  maxReschedules: z.number().int().min(0).max(50),
  cancellationPolicy: z.string().trim().max(300).optional(),
  // Pontos-base inteiros, como toda alíquota do produto: 2000 é 20%. O teto do
  // schema acompanha a CHECK do banco.
  maxDiscountBps: z.number().int().min(0).max(10_000).optional(),
  /** Onde o fiado vale (bloco 59). Ausente é "não mexa". */
  // Do domínio: `fidelidade.schemas.ts` e `assinatura.schemas.ts` já derivam
  // de `ESCOPOS`, e este mesmo arquivo o reescrevia à mão.
  creditScope: z.enum(ESCOPOS).optional(),
  /**
   * Abaixo deste score não marca online em hora de pico (bloco 60).
   *
   * `nullable` é o desligado, e é uma decisão legítima que a tela precisa poder
   * mandar: sem ele, ligar a regra seria reversível só por SQL.
   */
  onlineBlockScore: z.number().int().min(0).max(100).nullable().optional(),
  waitlistTrustedScore: z.number().int().min(0).max(100).optional(),
  /**
   * O encarregado de dados (bloco 31).
   *
   * O formato do e-mail é conferido aqui **e** por CHECK no banco. Duas vezes
   * de propósito: a borda devolve erro legível, e a CHECK vale para quem entrar
   * por outro caminho — importação, script, correção manual.
   */
  dpoName: z.string().trim().max(120).optional(),
  dpoEmail: z
    .string()
    .trim()
    .max(160)
    .refine((v) => v.length === 0 || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), {
      message: 'E-mail inválido',
    })
    .optional(),

  /**
   * A política de sinal da unidade (bloco 37).
   *
   * Os tetos acompanham a CHECK do banco, e as duas exigências cruzadas
   * (`fixo` precisa de valor, `percentual` precisa de alíquota) são conferidas
   * aqui **e** lá. Aqui para a tela dizer o que faltou; lá porque a CHECK vale
   * para quem entrar por outro caminho.
   */
  deposit: z
    .object({
      mode: z.enum(MODALIDADES_DE_SINAL),
      fixedCents: z.number().int().min(0).max(1_000_000),
      percentBps: z.number().int().min(0).max(10_000),
      scoreThreshold: z.number().int().min(0).max(100),
      ticketOverCents: z.number().int().min(0).max(10_000_000),
      // 720 horas são 30 dias, como na janela de cancelamento.
      refundHours: z.number().int().min(0).max(720),
    })
    .refine((d) => d.mode !== 'fixo' || d.fixedCents > 0, {
      message: 'Informe o valor do sinal fixo.',
      path: ['fixedCents'],
    })
    .refine((d) => d.mode !== 'percentual' || d.percentBps > 0, {
      message: 'Informe o percentual do sinal.',
      path: ['percentBps'],
    })
    .optional(),
});

/**
 * Endereços de foto.
 *
 * A URL em si é validada pelo domínio (`imagemPublica`), que exige `https` e
 * recusa `javascript:` e `data:`. Aqui vale o formato e o teto — a string vazia
 * é aceita de propósito: é como a tela diz "tire esta foto".
 */
const enderecoDeFoto = z.string().trim().max(500);

export const photosSchema = z.object({
  coverUrl: enderecoDeFoto.optional(),
  logoUrl: enderecoDeFoto.optional(),
  professionals: z
    .array(z.object({ id: z.string().uuid(), photoUrl: enderecoDeFoto }))
    .max(50)
    .optional(),
  services: z
    .array(z.object({ id: z.string().uuid(), photoUrl: enderecoDeFoto }))
    .max(80)
    .optional(),
});

/**
 * O interruptor da vitrine do marketplace (bloco 70, SPEC §5.2).
 *
 * Um campo só, obrigatório: quem chama esta rota está tomando a decisão, e um
 * booleano ausente aqui não é "não mexa" — é um formulário que não enviou o que
 * a rota existe para receber.
 */
export const vitrineSchema = z.object({ ligado: z.boolean() });
