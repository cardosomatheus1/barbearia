import { withTenant, type TransactionClient } from '@barbearia/db';
import {
  CATEGORIAS_DA_AVALIACAO,
  MAXIMO_DO_COMENTARIO,
  MAXIMO_DA_RESOLUCAO,
  estaPublicada,
  estrelas,
  horasRestantes,
  media,
  podeAvaliar,
  precisaDeRecuperacao,
  resumoPublico,
  validarNota,
  type Avaliacao,
  type CategoriaDaAvaliacao,
  type DesfechoDaRecuperacao,
  type Nota,
} from '@barbearia/core';
import { audit } from '@barbearia/identity';

/**
 * Avaliações, do banco para a decisão (bloco 43, SPEC §4.10).
 *
 * A regra mora em `packages/core`. Aqui se carrega, se chama o domínio e se
 * grava — e o que este arquivo não tem é tão importante quanto o que tem:
 * **não existe função para apagar avaliação**, e não é esquecimento. A SPEC
 * escreve o motivo, e o `REVOKE DELETE` da migração 0046 é a mesma frase onde
 * ninguém precisa lembrar dela.
 */

export type AvaliacaoFailure =
  | 'atendimento_nao_concluido'
  | 'ja_avaliado'
  | 'prazo_vencido'
  | 'nota_invalida'
  | 'comentario_longo'
  | 'avaliacao_nao_encontrada'
  | 'ja_resolvida'
  | 'motivo_curto';

export class AvaliacaoError extends Error {
  constructor(readonly code: AvaliacaoFailure, message: string) {
    super(message);
    this.name = 'AvaliacaoError';
  }
}

const MENSAGEM: Readonly<Record<AvaliacaoFailure, string>> = {
  atendimento_nao_concluido: 'Só dá para avaliar um atendimento que aconteceu.',
  ja_avaliado: 'Este atendimento já foi avaliado.',
  prazo_vencido: 'O prazo para avaliar este atendimento passou.',
  nota_invalida: 'A nota vai de 1 a 5.',
  comentario_longo: 'O comentário ficou longo demais.',
  avaliacao_nao_encontrada: 'Esta avaliação não existe.',
  ja_resolvida: 'Esta avaliação já foi tratada.',
  motivo_curto: 'Escreva o que foi feito — pelo menos uma frase.',
};

function recusar(code: AvaliacaoFailure): never {
  throw new AvaliacaoError(code, MENSAGEM[code]);
}

interface Ator {
  readonly id: string;
  readonly name: string;
}

// ---------------------------------------------------------------------------
// O cliente avalia
// ---------------------------------------------------------------------------

export interface NotasPorCategoria {
  readonly atendimento?: number;
  readonly qualidade?: number;
  readonly pontualidade?: number;
  readonly ambiente?: number;
}

const COLUNA_DA_CATEGORIA: Readonly<Record<CategoriaDaAvaliacao, string>> = {
  atendimento: 'rating_service',
  qualidade: 'rating_quality',
  pontualidade: 'rating_punctual',
  ambiente: 'rating_ambience',
};

/**
 * Registra a avaliação de um atendimento.
 *
 * O `customerId` vem **da sessão**, nunca do corpo: a RLS separa barbearias e
 * não separa clientes dentro de uma, e sem isso qualquer pessoa autenticada
 * avaliaria o corte de qualquer outra. O agendamento é conferido sob RLS antes
 * de virar chave estrangeira — a checagem de integridade referencial do Postgres
 * ignora row security.
 */
export async function avaliarAtendimento(entrada: {
  readonly tenantId: string;
  readonly customerId: string;
  readonly appointmentId: string;
  readonly nota: number;
  readonly categorias?: NotasPorCategoria;
  readonly comentario?: string | null;
  readonly agora?: Date;
}): Promise<{ readonly id: string; readonly publicada: boolean }> {
  if (!validarNota(entrada.nota)) recusar('nota_invalida');

  const comentario = entrada.comentario?.trim() ?? '';
  if (comentario.length > MAXIMO_DO_COMENTARIO) recusar('comentario_longo');

  for (const chave of CATEGORIAS_DA_AVALIACAO) {
    const valor = entrada.categorias?.[chave];
    if (valor !== undefined && !validarNota(valor)) recusar('nota_invalida');
  }

  const agora = entrada.agora ?? new Date();

  return withTenant(entrada.tenantId, async (tx) => {
    /**
     * O atendimento é desta pessoa, e acabou.
     *
     * `customer_id` no `WHERE` é obrigatório, e não é redundância com a RLS: um
     * id de agendamento vazado bastaria para avaliar em nome de quem foi
     * atendido — e a nota entraria na média do barbeiro dele.
     */
    const linhas = await tx.$queryRaw<
      {
        status: string;
        ends_at: Date;
        professional_id: string | null;
        avaliado: bigint;
      }[]
    >`
      SELECT a.status::text AS status, a.ends_at, a.professional_id,
             (SELECT count(*) FROM reviews r WHERE r.appointment_id = a.id) AS avaliado
        FROM appointments a
       WHERE a.id = ${entrada.appointmentId}::uuid
         AND a.customer_id = ${entrada.customerId}::uuid
    `;
    const atendimento = linhas[0];
    if (!atendimento) recusar('atendimento_nao_concluido');

    const decisao = podeAvaliar(
      {
        status: atendimento.status,
        terminouEm: atendimento.ends_at,
        jaAvaliado: Number(atendimento.avaliado) > 0,
      },
      agora,
    );
    if ('recusa' in decisao) recusar(decisao.recusa);

    const cat = entrada.categorias ?? {};
    const criadas = await tx.$queryRaw<{ id: string; created_at: Date }[]>`
      INSERT INTO reviews
        (tenant_id, appointment_id, customer_id, professional_id, rating,
         rating_service, rating_quality, rating_punctual, rating_ambience,
         comment, created_at)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${entrada.appointmentId}::uuid, ${entrada.customerId}::uuid,
        ${atendimento.professional_id}::uuid, ${entrada.nota},
        ${cat.atendimento ?? null}, ${cat.qualidade ?? null},
        ${cat.pontualidade ?? null}, ${cat.ambiente ?? null},
        ${comentario.length > 0 ? comentario : null}, ${agora}
      )
      RETURNING id, created_at
    `;
    const criada = criadas[0];
    if (!criada) recusar('ja_avaliado');

    return {
      id: criada.id,
      publicada: estaPublicada(
        {
          id: criada.id,
          nota: entrada.nota as Nota,
          comentario: null,
          criadaEm: criada.created_at,
          resolvidaEm: null,
        },
        agora,
      ),
    };
  });
}

// ---------------------------------------------------------------------------
// A leitura
// ---------------------------------------------------------------------------

interface LinhaDaAvaliacao {
  id: string;
  rating: number;
  comment: string | null;
  created_at: Date;
  resolved_at: Date | null;
  outcome: DesfechoDaRecuperacao | null;
  resolution_note: string | null;
  cliente: string | null;
  profissional: string | null;
  servico: string | null;
  atendido_em: Date | null;
  rating_service: number | null;
  rating_quality: number | null;
  rating_punctual: number | null;
  rating_ambience: number | null;
}

const SELECT_DA_AVALIACAO = `
  SELECT r.id, r.rating, r.comment, r.created_at, r.resolved_at, r.outcome,
         r.resolution_note,
         c.name AS cliente, p.name AS profissional,
         a.ends_at AS atendido_em,
         (SELECT s.name FROM appointment_services aps
             JOIN services s ON s.id = aps.service_id
            WHERE aps.appointment_id = a.id ORDER BY aps.position LIMIT 1) AS servico,
         r.rating_service, r.rating_quality, r.rating_punctual, r.rating_ambience
    FROM reviews r
    LEFT JOIN customers c ON c.id = r.customer_id
    LEFT JOIN professionals p ON p.id = r.professional_id
    LEFT JOIN appointments a ON a.id = r.appointment_id
`;

export interface AvaliacaoNaTela {
  readonly id: string;
  readonly nota: number;
  readonly estrelas: string;
  readonly comentario: string | null;
  readonly clienteNome: string;
  readonly profissionalNome: string | null;
  readonly servicoNome: string | null;
  readonly atendidoEm: string | null;
  readonly criadaEm: string;
  readonly publicada: boolean;
  readonly horasRestantes: number;
  readonly precisaDeAtitude: boolean;
  readonly resolvidaEm: string | null;
  readonly desfecho: DesfechoDaRecuperacao | null;
  readonly resolucao: string | null;
  readonly categorias: Readonly<Partial<Record<CategoriaDaAvaliacao, number>>>;
}

function paraTela(linha: LinhaDaAvaliacao, agora: Date): AvaliacaoNaTela {
  const dominio: Avaliacao = {
    id: linha.id,
    nota: linha.rating as Nota,
    comentario: linha.comment,
    criadaEm: linha.created_at,
    resolvidaEm: linha.resolved_at,
  };

  const categorias: Partial<Record<CategoriaDaAvaliacao, number>> = {};
  if (linha.rating_service !== null) categorias.atendimento = linha.rating_service;
  if (linha.rating_quality !== null) categorias.qualidade = linha.rating_quality;
  if (linha.rating_punctual !== null) categorias.pontualidade = linha.rating_punctual;
  if (linha.rating_ambience !== null) categorias.ambiente = linha.rating_ambience;

  return {
    id: linha.id,
    nota: linha.rating,
    estrelas: estrelas(linha.rating as Nota),
    comentario: linha.comment,
    // Nulo é cliente anonimizado: a nota fica, a pessoa sai de dentro dela.
    clienteNome: linha.cliente ?? 'Cliente anonimizado',
    profissionalNome: linha.profissional,
    servicoNome: linha.servico,
    atendidoEm: linha.atendido_em?.toISOString() ?? null,
    criadaEm: linha.created_at.toISOString(),
    publicada: estaPublicada(dominio, agora),
    horasRestantes: horasRestantes(dominio, agora),
    precisaDeAtitude: precisaDeRecuperacao(dominio, agora),
    resolvidaEm: linha.resolved_at?.toISOString() ?? null,
    desfecho: linha.outcome,
    resolucao: linha.resolution_note,
    categorias,
  };
}

export interface PainelDeAvaliacoes {
  readonly media: number | null;
  readonly total: number;
  /** A média que a página pública mostra — só o publicado, e só a partir do mínimo. */
  readonly mediaPublica: number | null;
  readonly aRecuperar: readonly AvaliacaoNaTela[];
  readonly ultimas: readonly AvaliacaoNaTela[];
}

/**
 * O que o gestor vê.
 *
 * **A média conta tudo**, publicado ou não — a SPEC é explícita, e uma média que
 * só somasse o que está no ar seria o painel mentindo para quem decide.
 *
 * A fila de recuperação vem separada porque é a única parte com prazo: passadas
 * as 48 horas a avaliação sai dela e vai para o ar, tenha alguém agido ou não.
 */
export async function painelDeAvaliacoes(
  tenantId: string,
  agora: Date = new Date(),
  limite = 30,
): Promise<PainelDeAvaliacoes> {
  return withTenant(tenantId, async (tx) => {
    const todas = await tx.$queryRaw<{ rating: number; created_at: Date }[]>`
      SELECT rating, created_at FROM reviews
    `;

    const linhas = await tx.$queryRawUnsafe<LinhaDaAvaliacao[]>(
      `${SELECT_DA_AVALIACAO} ORDER BY r.created_at DESC LIMIT $1`,
      limite,
    );
    const naTela = linhas.map((l) => paraTela(l, agora));

    const publicadas = todas
      .filter((t) =>
        estaPublicada(
          { id: '', nota: t.rating as Nota, comentario: null, criadaEm: t.created_at, resolvidaEm: null },
          agora,
        ),
      )
      .map((t) => t.rating);

    return {
      media: media(todas.map((t) => t.rating)),
      total: todas.length,
      mediaPublica: resumoPublico(publicadas).media,
      aRecuperar: naTela.filter((a) => a.precisaDeAtitude),
      ultimas: naTela,
    };
  });
}

/**
 * O que a página pública mostra.
 *
 * Só o publicado, e a média só aparece a partir de um mínimo: "5,0 de uma
 * avaliação" é ruído estatístico com cara de excelência.
 *
 * O corte das 48 horas é feito na consulta, com o instante calculado aqui —
 * `now()` dentro do SQL daria o relógio do banco, e este produto passa o
 * "agora" por parâmetro para que o teste seja determinístico.
 */
export async function avaliacoesPublicas(
  tenantId: string,
  agora: Date = new Date(),
  limite = 12,
): Promise<{
  readonly media: number | null;
  readonly total: number;
  readonly avaliacoes: readonly {
    readonly nota: number;
    readonly estrelas: string;
    readonly comentario: string | null;
    readonly primeiroNome: string;
    readonly profissionalNome: string | null;
    readonly quando: string;
  }[];
}> {
  return withTenant(tenantId, async (tx) => {
    const publicadas = await tx.$queryRaw<
      {
        rating: number;
        comment: string | null;
        created_at: Date;
        cliente: string | null;
        profissional: string | null;
      }[]
    >`
      SELECT r.rating, r.comment, r.created_at, c.name AS cliente, p.name AS profissional
        FROM reviews r
        LEFT JOIN customers c ON c.id = r.customer_id
        LEFT JOIN professionals p ON p.id = r.professional_id
       WHERE r.rating >= 4 OR r.created_at <= ${new Date(agora.getTime() - 48 * 3_600_000)}
       ORDER BY r.created_at DESC
    `;

    const resumo = resumoPublico(publicadas.map((p) => p.rating));

    return {
      media: resumo.media,
      total: resumo.total,
      avaliacoes: publicadas.slice(0, limite).map((p) => ({
        nota: p.rating,
        estrelas: estrelas(p.rating as Nota),
        comentario: p.comment,
        // Só o primeiro nome: a avaliação é pública e o sobrenome do cliente
        // não precisa estar num endereço que o Google indexa.
        primeiroNome: (p.cliente ?? 'Cliente').split(' ')[0] ?? 'Cliente',
        profissionalNome: p.profissional,
        quando: p.created_at.toISOString(),
      })),
    };
  });
}

/** As avaliações de um cliente, para a ficha. Filtra por `customer_id`. */
export async function avaliacoesDoCliente(
  tenantId: string,
  customerId: string,
  agora: Date = new Date(),
): Promise<readonly AvaliacaoNaTela[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRawUnsafe<LinhaDaAvaliacao[]>(
      `${SELECT_DA_AVALIACAO} WHERE r.customer_id = $1::uuid ORDER BY r.created_at DESC LIMIT 20`,
      customerId,
    );
    return linhas.map((l) => paraTela(l, agora));
  });
}

// ---------------------------------------------------------------------------
// A recuperação
// ---------------------------------------------------------------------------

/**
 * Registra o que a casa fez a respeito de uma nota baixa.
 *
 * **Isto não impede a publicação.** Passadas as 48 horas a avaliação vai ao ar
 * de qualquer forma, resolvida ou não — é o limite ético da SPEC §4.10, e é o
 * que separa uma janela de recuperação de um filtro de censura. O que se ganha
 * registrando é o histórico: seis meses depois, "ligamos e refizemos o corte" é
 * o que responde a pergunta de por que aquele cliente voltou.
 *
 * O motivo escrito é obrigatório na borda, aqui e por `CHECK` no banco.
 */
export async function registrarRecuperacao(entrada: {
  readonly tenantId: string;
  readonly avaliacaoId: string;
  readonly desfecho: DesfechoDaRecuperacao;
  readonly nota: string;
  readonly ator: Ator;
  readonly agora?: Date;
}): Promise<{ readonly resolvida: true }> {
  const nota = entrada.nota.trim();
  if (nota.length < 10 || nota.length > MAXIMO_DA_RESOLUCAO) recusar('motivo_curto');

  const agora = entrada.agora ?? new Date();

  return withTenant(entrada.tenantId, async (tx) => {
    /**
     * `resolved_at IS NULL` no `WHERE`, e a contagem conferida.
     *
     * Sem olhar quantas linhas pegou, o segundo toque gravaria trilha de uma
     * resolução que não aconteceu — e o painel mostraria dois registros para o
     * mesmo gesto.
     */
    const afetadas = await tx.$executeRaw`
      UPDATE reviews
         SET resolved_at = ${agora}, resolved_by = ${entrada.ator.id}::uuid,
             outcome = ${entrada.desfecho}::review_outcome, resolution_note = ${nota}
       WHERE id = ${entrada.avaliacaoId}::uuid AND resolved_at IS NULL
    `;
    if (afetadas === 0) {
      const existe = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM reviews WHERE id = ${entrada.avaliacaoId}::uuid
      `;
      recusar(existe[0] ? 'ja_resolvida' : 'avaliacao_nao_encontrada');
    }

    await audit(tx, {
      actorId: entrada.ator.id,
      actorName: entrada.ator.name,
      action: 'review.recovered',
      entity: 'reviews',
      entityId: entrada.avaliacaoId,
      after: { desfecho: entrada.desfecho, caracteres: nota.length },
    });

    return { resolvida: true };
  });
}

/**
 * O indicador do barbeiro: a média dele, e a da casa para comparar.
 *
 * Comparar com o **próprio** passado é a regra da SPEC §4.21, e ela é do bloco
 * 34 — aqui a média da casa entra só como referência do período, não como
 * ranking entre pessoas.
 */
export async function mediaDoProfissional(
  tenantId: string,
  professionalId: string,
  de: Date,
  ate: Date,
): Promise<{ readonly media: number | null; readonly total: number }> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ rating: number }[]>`
      SELECT rating FROM reviews
       WHERE professional_id = ${professionalId}::uuid
         AND created_at >= ${de} AND created_at < ${ate}
    `;
    return { media: media(linhas.map((l) => l.rating)), total: linhas.length };
  });
}

/** Os atendimentos que este cliente ainda pode avaliar. */
export async function atendimentosAAvaliar(
  tenantId: string,
  customerId: string,
  agora: Date = new Date(),
): Promise<readonly { readonly id: string; readonly servico: string | null; readonly profissional: string | null; readonly quando: string }[]> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      { id: string; servico: string | null; profissional: string | null; ends_at: Date }[]
    >`
      SELECT a.id, p.name AS profissional, a.ends_at,
             (SELECT s.name FROM appointment_services aps
                 JOIN services s ON s.id = aps.service_id
                WHERE aps.appointment_id = a.id ORDER BY aps.position LIMIT 1) AS servico
        FROM appointments a
        LEFT JOIN professionals p ON p.id = a.professional_id
       WHERE a.customer_id = ${customerId}::uuid
         AND a.status = 'completed'
         AND a.ends_at >= ${new Date(agora.getTime() - 30 * 86_400_000)}
         AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.appointment_id = a.id)
       ORDER BY a.ends_at DESC
       LIMIT 5
    `;
    return linhas.map((l) => ({
      id: l.id,
      servico: l.servico,
      profissional: l.profissional,
      quando: l.ends_at.toISOString(),
    }));
  });
}

/** Usado pelo worker: quem atendeu e o que, para montar o pedido de avaliação. */
export async function dadosDoPedidoDeAvaliacao(
  tx: TransactionClient,
  appointmentId: string,
): Promise<{ readonly customerId: string; readonly nome: string; readonly telefone: string } | null> {
  const linhas = await tx.$queryRaw<
    { customer_id: string; name: string; phone_e164: string; status: string; avaliado: bigint }[]
  >`
    SELECT a.customer_id, c.name, c.phone_e164, a.status::text AS status,
           (SELECT count(*) FROM reviews r WHERE r.appointment_id = a.id) AS avaliado
      FROM appointments a
      JOIN customers c ON c.id = a.customer_id
     WHERE a.id = ${appointmentId}::uuid
  `;
  const linha = linhas[0];
  if (!linha || linha.status !== 'completed' || Number(linha.avaliado) > 0) return null;
  return { customerId: linha.customer_id, nome: linha.name, telefone: linha.phone_e164 };
}
