import { withTenant } from '@barbearia/db';
import { audit } from '@barbearia/identity';

/**
 * Fotos antes/depois e o portfólio (bloco 74, SPEC §4.2 e §1.8 regra 2).
 *
 * > *"O barbeiro registra **Antes** e **Depois**, vinculados ao atendimento. No
 * > atendimento seguinte, consulta 'último corte' com um toque."*
 *
 * ## Duas autorizações, e a diferença entre elas é o bloco
 *
 * `photos` deixa **guardar** na ficha; `photos_public` deixa **publicar** no
 * portfólio. As duas são conferidas aqui, com mensagem legível, e de novo por
 * gatilho no banco — porque a regra é direito do titular, e uma cláusula de
 * aplicação é perdível numa reescrita.
 *
 * ## Ver foto é auditado
 *
 * *"Acesso a fotos é permissão própria e **auditado**."* A trilha registra que
 * alguém abriu as fotos de um cliente, com quem e quando — nunca as URLs: o
 * `audit_log` é append-only e a anonimização não o alcança, então uma cópia do
 * endereço da foto ali sobreviveria ao apagamento que a revogação faz.
 */

export type TipoDeFoto = 'antes' | 'depois';

export class FotoError extends Error {
  constructor(
    readonly code: 'sem_consentimento' | 'sem_uso_publico' | 'foto_nao_encontrada' | 'url_invalida',
    mensagem: string,
  ) {
    super(mensagem);
    this.name = 'FotoError';
  }
}

export interface FotoDoCliente {
  readonly id: string;
  readonly tipo: TipoDeFoto;
  readonly url: string;
  readonly legenda: string | null;
  readonly noPortfolio: boolean;
  readonly quando: Date;
  readonly appointmentId: string | null;
  readonly professionalId: string | null;
}

/**
 * As fotos de um cliente, da mais recente para a mais antiga.
 *
 * `ator` é obrigatório porque a leitura é auditada — e obrigatório no **tipo**,
 * não opcional: opcional, o primeiro chamador novo esqueceria dele e a trilha
 * deixaria de existir sem nada ficar vermelho.
 */
export async function fotosDoCliente(entrada: {
  readonly tenantId: string;
  readonly customerId: string;
  readonly ator: { readonly id: string; readonly nome: string };
}): Promise<readonly FotoDoCliente[]> {
  return withTenant(entrada.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<
      {
        id: string;
        kind: TipoDeFoto;
        url: string;
        caption: string | null;
        in_portfolio: boolean;
        created_at: Date;
        appointment_id: string | null;
        professional_id: string | null;
      }[]
    >`
      SELECT id, kind::text AS kind, url, caption, in_portfolio, created_at,
             appointment_id, professional_id
        FROM customer_photos
       WHERE customer_id = ${entrada.customerId}::uuid
       ORDER BY created_at DESC
       LIMIT 100
    `;

    /**
     * Auditada **dentro da transação** que leu, como toda trilha deste produto,
     * e só quando houve o que ver: registrar a abertura de uma ficha vazia
     * encheria a trilha de linhas que não respondem pergunta nenhuma.
     */
    if (linhas.length > 0) {
      await audit(tx, {
        actorId: entrada.ator.id,
        actorName: entrada.ator.nome,
        action: 'customers.photos_viewed',
        entity: 'customer',
        entityId: entrada.customerId,
        after: { quantas: linhas.length },
      });
    }

    return linhas.map((l) => ({
      id: l.id,
      tipo: l.kind,
      url: l.url,
      legenda: l.caption,
      noPortfolio: l.in_portfolio,
      quando: l.created_at,
      appointmentId: l.appointment_id,
      professionalId: l.professional_id,
    }));
  });
}

/**
 * Registra uma foto.
 *
 * O consentimento é conferido aqui **e** por gatilho. Aqui para a recepção ler
 * "o cliente não autorizou o registro de fotos" em vez de um erro de banco no
 * balcão; lá porque a garantia não pode depender de este caminho ser o único.
 */
export async function registrarFoto(entrada: {
  readonly tenantId: string;
  readonly customerId: string;
  readonly tipo: TipoDeFoto;
  readonly url: string;
  readonly appointmentId?: string | undefined;
  readonly professionalId?: string | undefined;
  readonly legenda?: string | undefined;
  readonly noPortfolio?: boolean;
  readonly ator: { readonly id: string; readonly nome: string };
}): Promise<{ readonly id: string }> {
  if (!/^https:\/\/\S+$/.test(entrada.url)) {
    throw new FotoError('url_invalida', 'O endereço da foto precisa começar com https://');
  }
  const noPortfolio = entrada.noPortfolio === true;

  return withTenant(entrada.tenantId, async (tx) => {
    /**
     * O cliente é conferido **aqui**, sob RLS, e não por tabela vizinha.
     *
     * O consentimento já não seria visível para o cliente da vizinha, então a
     * corrente fechava — mas por dependência indireta, e uma guarda que depende
     * de outra função continuar conferindo é uma guarda que some numa
     * reescrita. Junto vem a recusa de quem foi anonimizado: aquela pessoa
     * pediu para sair, e o consentimento dela sobrevive à anonimização por
     * desenho (o histórico é append-only).
     */
    const clientes = await tx.$queryRaw<{ anonymized_at: Date | null }[]>`
      SELECT anonymized_at FROM customers WHERE id = ${entrada.customerId}::uuid
    `;
    const cliente = clientes[0];
    if (!cliente) throw new FotoError('foto_nao_encontrada', 'Cliente não encontrado');
    if (cliente.anonymized_at) {
      throw new FotoError(
        'sem_consentimento',
        'Este cadastro foi anonimizado a pedido do titular. Não é possível registrar fotos.',
      );
    }

    const consentimentos = await lerConsentimentos(tx, entrada.customerId);
    if (!consentimentos.photos) {
      throw new FotoError(
        'sem_consentimento',
        'Este cliente não autorizou o registro de fotos. Peça o aceite na ficha dele.',
      );
    }
    if (noPortfolio && !consentimentos.photosPublic) {
      throw new FotoError(
        'sem_uso_publico',
        'Este cliente autorizou guardar a foto, mas não publicá-la. São dois aceites.',
      );
    }

    /**
     * O agendamento e o profissional são conferidos **sob RLS antes de gravar**.
     *
     * A checagem de integridade referencial do Postgres ignora row security: a
     * chave estrangeira aceitaria o id de outra barbearia sem reclamar, e a
     * foto ficaria pendurada no atendimento alheio. É a regra do id que vem do
     * corpo, quebrada aqui uma vez em cada bloco que a esquece.
     */
    if (entrada.appointmentId) {
      const achados = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM appointments WHERE id = ${entrada.appointmentId}::uuid
      `;
      if (achados.length !== 1) {
        throw new FotoError('foto_nao_encontrada', 'Atendimento não encontrado');
      }
    }
    if (entrada.professionalId) {
      const achados = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM professionals WHERE id = ${entrada.professionalId}::uuid
      `;
      if (achados.length !== 1) {
        throw new FotoError('foto_nao_encontrada', 'Profissional não encontrado');
      }
    }

    const linhas = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO customer_photos
        (tenant_id, customer_id, appointment_id, professional_id, kind, url,
         caption, in_portfolio, created_by)
      VALUES (
        NULLIF(current_setting('app.tenant_id', true), '')::uuid,
        ${entrada.customerId}::uuid,
        ${entrada.appointmentId ?? null}::uuid,
        ${entrada.professionalId ?? null}::uuid,
        ${entrada.tipo}::customer_photo_kind,
        ${entrada.url},
        ${entrada.legenda ?? null},
        ${noPortfolio},
        ${entrada.ator.id}::uuid
      )
      RETURNING id
    `;
    const id = linhas[0]?.id;
    if (!id) throw new FotoError('foto_nao_encontrada', 'Não foi possível registrar a foto');

    await audit(tx, {
      actorId: entrada.ator.id,
      actorName: entrada.ator.nome,
      action: 'customers.photo_added',
      entity: 'customer',
      entityId: entrada.customerId,
      // O **que** mudou, nunca o valor: a URL da foto no `audit_log` seria uma
      // segunda cópia numa tabela que a revogação não apaga.
      after: { tipo: entrada.tipo, noPortfolio },
    });

    return { id };
  });
}

/** Põe ou tira uma foto do portfólio público. */
export async function publicarFoto(entrada: {
  readonly tenantId: string;
  readonly fotoId: string;
  readonly publicar: boolean;
  readonly ator: { readonly id: string; readonly nome: string };
}): Promise<void> {
  await withTenant(entrada.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ customer_id: string }[]>`
      SELECT customer_id FROM customer_photos WHERE id = ${entrada.fotoId}::uuid
    `;
    const foto = linhas[0];
    if (!foto) throw new FotoError('foto_nao_encontrada', 'Foto não encontrada');

    if (entrada.publicar) {
      const consentimentos = await lerConsentimentos(tx, foto.customer_id);
      if (!consentimentos.photosPublic) {
        throw new FotoError(
          'sem_uso_publico',
          'Este cliente não autorizou o uso público da foto.',
        );
      }
    }

    await tx.$executeRaw`
      UPDATE customer_photos SET in_portfolio = ${entrada.publicar}
       WHERE id = ${entrada.fotoId}::uuid
    `;

    await audit(tx, {
      actorId: entrada.ator.id,
      actorName: entrada.ator.nome,
      action: entrada.publicar ? 'customers.photo_published' : 'customers.photo_unpublished',
      entity: 'customer',
      entityId: foto.customer_id,
    });
  });
}

/**
 * Apaga uma foto.
 *
 * Existe porque a barbearia erra: a foto saiu tremida, entrou a pessoa errada,
 * o cliente pediu por fora. A revogação do consentimento já apaga tudo por
 * gatilho — isto é o caso avulso, e é `DELETE` de verdade, não um estado
 * escondido: o titular que pede para tirar uma foto não pediu para escondê-la.
 */
export async function apagarFoto(entrada: {
  readonly tenantId: string;
  readonly fotoId: string;
  readonly ator: { readonly id: string; readonly nome: string };
}): Promise<void> {
  await withTenant(entrada.tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ customer_id: string }[]>`
      SELECT customer_id FROM customer_photos WHERE id = ${entrada.fotoId}::uuid
    `;
    const foto = linhas[0];
    if (!foto) throw new FotoError('foto_nao_encontrada', 'Foto não encontrada');

    await tx.$executeRaw`DELETE FROM customer_photos WHERE id = ${entrada.fotoId}::uuid`;

    await audit(tx, {
      actorId: entrada.ator.id,
      actorName: entrada.ator.nome,
      action: 'customers.photo_deleted',
      entity: 'customer',
      entityId: foto.customer_id,
    });
  });
}

/**
 * O portfólio público de um profissional.
 *
 * Confere o consentimento **de novo na leitura**, e não só a coluna.
 * `in_portfolio` é a escolha da barbearia; o aceite vigente é o teto. O gatilho
 * já limpa a coluna quando alguém revoga, e esta segunda conferência é o que
 * torna a página correta mesmo que um dia o gatilho seja alterado — a foto de
 * quem disse não some da internet pelas duas portas.
 */
export async function portfolioDoProfissional(
  tenantId: string,
  professionalId: string,
  limite = 12,
): Promise<
  readonly { readonly id: string; readonly url: string; readonly legenda: string | null }[]
> {
  return withTenant(tenantId, async (tx) => {
    const linhas = await tx.$queryRaw<{ id: string; url: string; caption: string | null }[]>`
      SELECT f.id, f.url, f.caption
        FROM customer_photos f
       WHERE f.professional_id = ${professionalId}::uuid
         AND f.in_portfolio
         AND consentimento_vigente(f.customer_id, 'photos_public')
       ORDER BY f.created_at DESC
       LIMIT ${limite}
    `;
    /**
     * O id vai junto, e serve de chave da lista na tela.
     *
     * Pela URL, duas fotos com o mesmo endereço — o antes e o depois apontando
     * para o mesmo arquivo, ou o endereço recolado — colidiriam. É uuid opaco e
     * não expõe nada.
     */
    return linhas.map((l) => ({ id: l.id, url: l.url, legenda: l.caption }));
  });
}

type Transacao = Parameters<Parameters<typeof withTenant>[1]>[0];

async function lerConsentimentos(
  tx: Transacao,
  customerId: string,
): Promise<{ readonly photos: boolean; readonly photosPublic: boolean }> {
  const linhas = await tx.$queryRaw<{ photos: boolean; photos_public: boolean }[]>`
    SELECT consentimento_vigente(${customerId}::uuid, 'photos') AS photos,
           consentimento_vigente(${customerId}::uuid, 'photos_public') AS photos_public
  `;
  return {
    photos: linhas[0]?.photos === true,
    photosPublic: linhas[0]?.photos_public === true,
  };
}
