import { Body, Controller, Get, Headers, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  custoDoEncaixeNaFila,
  getQueue,
  joinQueue,
  moveQueueEntry,
  QueueError,
  seatQueueEntry,
  type QueueStatus,
} from '@barbearia/scheduling';
import { OtpError, resolveGuestCustomer, type AuthenticatedStaff } from '@barbearia/identity';
import { findCustomer } from '@barbearia/scheduling';
import { pode } from '@barbearia/core';
import { badRequest, DomainError, notFound } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard, Recurso } from './permissao.guard.js';
import { unidadeDoBalcao } from './unidade.js';
import {
  fitQuerySchema,
  joinQueueSchema,
  moveQueueSchema,
  queueEntryIdSchema,
  seatQueueSchema,
} from './fila.schemas.js';

const STATUS: Record<string, number> = {
  queue_entry_not_found: 404,
  unknown_service: 404,
  unknown_professional: 404,
  // 409, não 403: quem pede tem permissão. O que mudou foi o estado da fila.
  transition_not_allowed: 409,
  already_in_queue: 409,
  slot_taken: 409,
};

function toHttp(error: unknown): never {
  if (error instanceof QueueError) {
    throw new DomainError(error.code, STATUS[error.code] ?? 400, error.message);
  }
  if (error instanceof OtpError) {
    throw new DomainError(error.code, error.code === 'invalid_phone' ? 400 : 401, error.message);
  }
  throw error;
}

/**
 * A fila presencial, do lado do balcão.
 *
 * Como no painel do dia, **nenhuma rota aceita `locationId`** — ele vem do
 * tenant do token — e toda rota declara a permissão que exige, porque a guarda
 * recusa por padrão o que não declara nada.
 *
 * Uma escolha vale por toda a classe: **o token do link nunca volta numa
 * listagem**. Ele existe uma vez, na resposta de quem acabou de entrar na fila,
 * e depois só o hash existe no banco. Devolvê-lo em `GET /queue` transformaria
 * a tela do balcão numa lista de chaves para a posição de cada cliente.
 */
@Controller('v1/admin/queue')
// A fila inteira é o recurso: barbearia que atende só com hora marcada desliga
// e a tela some junto (bloco 26).
@Recurso('fila')
@UseGuards(StaffGuard, PermissaoGuard)
export class FilaController {
  private async unidade(staff: AuthenticatedStaff) {
    return unidadeDoBalcao(staff);
  }

  @Exige('appointments.view')
  @Get()
  async list(@Staff() staff: AuthenticatedStaff) {
    const local = await this.unidade(staff);
    return getQueue({
      tenantId: staff.tenantId,
      locationId: local.id,
      timezone: local.timezone,
      // Mesma decisão do painel do dia: quem não pode ver cliente lê a posição
      // e a duração, que é o que faz a fila andar.
      podeVerCliente: pode(staff.permissions, 'customers.view'),
    });
  }

  /**
   * Quanto custa encaixar este serviço agora, por cadeira.
   *
   * Separado da listagem porque depende do que a pessoa quer fazer: sem
   * duração, "cabe" não significa nada — e "livre" e "cabe" são coisas
   * diferentes.
   */
  @Exige('appointments.create')
  @Get('fit')
  async fit(
    @Staff() staff: AuthenticatedStaff,
    @Query(new ZodValidationPipe(fitQuerySchema)) query: { serviceIds: string[] },
  ) {
    const local = await this.unidade(staff);
    return {
      cadeiras: await custoDoEncaixeNaFila({
        tenantId: staff.tenantId,
        locationId: local.id,
        timezone: local.timezone,
        serviceIds: query.serviceIds,
      }),
    };
  }

  /**
   * Põe alguém na fila.
   *
   * `Idempotency-Key` porque duplo toque em celular lento na recepção poria a
   * mesma pessoa duas vezes — e a segunda entrada empurraria a fila inteira. O
   * índice parcial do banco é a segunda defesa, para o caso de a tela não mandar
   * a chave.
   */
  @Exige('appointments.create')
  @Post()
  async join(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(joinQueueSchema))
    body: {
      customerId?: string;
      name?: string;
      phone?: string;
      serviceIds: string[];
      professionalId?: string;
      notes?: string;
    },
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (idempotencyKey !== undefined && (idempotencyKey === '' || idempotencyKey.length > 128)) {
      throw badRequest('invalid_request', 'Idempotency-Key com tamanho inválido');
    }

    const local = await this.unidade(staff);

    try {
      const customerId = await this.identificar(staff.tenantId, body);
      return await joinQueue({
        tenantId: staff.tenantId,
        locationId: local.id,
        customerId,
        serviceIds: body.serviceIds,
        professionalId: body.professionalId ?? null,
        ...(body.notes ? { notes: body.notes } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
    } catch (error) {
      return toHttp(error);
    }
  }

  @Exige('appointments.attend')
  @Post(':id/move')
  async move(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(queueEntryIdSchema)) id: string,
    @Body(new ZodValidationPipe(moveQueueSchema)) body: { para: QueueStatus },
  ) {
    const unidade = await unidadeDoBalcao(staff);
    try {
      return await moveQueueEntry({
        tenantId: staff.tenantId,
        queueEntryId: id,
        // A loja deste balcão: sem ela, o operador da filial mexia na fila da
        // matriz com o id na mão.
        locationId: unidade.id,
        para: body.para,
      });
    } catch (error) {
      return toHttp(error);
    }
  }

  /**
   * A pessoa sentou: vira atendimento de verdade, com hora real.
   *
   * A recusa por cima de quem marcou vem da constraint de exclusão do banco, e
   * chega aqui como 409 com o motivo. É a regra de convivência da SPEC §2.10
   * imposta pelo Postgres, não por um `if` com janela de corrida.
   */
  @Exige('appointments.attend')
  @Post(':id/seat')
  async seat(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(queueEntryIdSchema)) id: string,
    @Body(new ZodValidationPipe(seatQueueSchema)) body: { professionalId: string },
  ) {
    const unidade = await unidadeDoBalcao(staff);
    try {
      return await seatQueueEntry({
        tenantId: staff.tenantId,
        queueEntryId: id,
        locationId: unidade.id,
        professionalId: body.professionalId,
      });
    } catch (error) {
      return toHttp(error);
    }
  }

  /** Mesma conferência que o balcão faz antes de gravar `customer_id`. */
  private async identificar(
    tenantId: string,
    body: { customerId?: string; name?: string; phone?: string },
  ): Promise<string> {
    if (body.customerId) {
      const cliente = await findCustomer(tenantId, body.customerId);
      if (!cliente) throw notFound('customer_not_found', 'Cliente não encontrado');
      return cliente.id;
    }

    if (!body.name || !body.phone) {
      throw badRequest('invalid_request', 'Informe o cliente ou nome e celular');
    }

    const novo = await resolveGuestCustomer({ tenantId, name: body.name, phone: body.phone });
    return novo.customerId;
  }
}
