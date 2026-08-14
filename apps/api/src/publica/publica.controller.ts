import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { listServices, unidadesDoCadastro } from '@barbearia/catalog';
import { createAppointment, getAvailabilityRange, getPublicProfile } from '@barbearia/scheduling';
import { resolveGuestCustomer } from '@barbearia/identity';
import { badRequest, DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { ChaveGuard, Escopo, type ChaveRequest } from './chave.guard.js';
import { agendamentoPublicoSchema, disponibilidadePublicaSchema } from './publica.schemas.js';

/**
 * A API pública, para integração de terceiro (bloco 78, SPEC §5.6).
 *
 * ## Ela não é uma segunda noção de nada
 *
 * A disponibilidade sai do **mesmo motor** da página pública, com a mesma
 * antecedência mínima e a mesma constraint anti-overbooking; o agendamento sai
 * do mesmo `createAppointment`, com `Idempotency-Key`, sinal e score. Uma
 * segunda noção de "horário livre" é a agenda vendida duas vezes — é a regra
 * que o agente de conversa do bloco 65 já cumpre, e vale igual aqui.
 *
 * ## O que ela não expõe
 *
 * Dinheiro, por desenho: uma chave não carrega escopo de `finance.` nem de
 * `cashier.`, porque o segundo fator deste produto é provado por sessão com
 * TOTP e máquina não digita TOTP. A recusa é na borda, no domínio e por `CHECK`.
 *
 * E não expõe cadastro de cliente por telefone: `resolveGuestCustomer` acha
 * quem já existe, e devolver isso viraria oráculo — com uma lista de números se
 * descobre quem é cliente de quem. A resposta do agendamento traz o que foi
 * criado, nunca o que já havia.
 */
@Controller('v1/publica')
@UseGuards(ChaveGuard)
export class PublicaController {
  /**
   * Quem é a barbearia dona desta chave.
   *
   * `appointments.view` porque é o escopo mais baixo que existe para leitura de
   * operação — e o piso de uma rota de consulta genérica é o mais baixo de
   * propósito: um piso alto barra por conta própria, e aí ninguém nota se a
   * conferência que importa parar de acontecer.
   */
  @Escopo('appointments.view')
  @Get('barbearia')
  async barbearia(@Req() pedido: ChaveRequest) {
    const chave = this.exigir(pedido);
    const [perfil, unidades] = await Promise.all([
      getPublicProfile(chave.tenantId, ''),
      unidadesDoCadastro(chave.tenantId),
    ]);
    if (!perfil) throw new DomainError('nao_encontrada', 404, 'Barbearia não encontrada');
    return {
      nome: perfil.name,
      unidades: unidades
        .filter((u) => u.ativa)
        .map((u) => ({ id: u.id, nome: u.nome, fuso: u.timezone, cidade: u.cidade })),
      profissionais: perfil.professionals.map((p) => ({ id: p.id, nome: p.name })),
    };
  }

  /** O catálogo vendável. `settings.manage` seria escrever; ler é operação. */
  @Escopo('appointments.view')
  @Get('servicos')
  async servicos(@Req() pedido: ChaveRequest) {
    const chave = this.exigir(pedido);
    const catalogo = await listServices(chave.tenantId);
    return {
      servicos: catalogo.services
        .filter((s) => s.active && s.bookableOnline)
        .map((s) => ({
          id: s.id,
          nome: s.name,
          descricao: s.description,
          precoCents: s.priceCents,
          duracaoMinutos: s.durationMinutes,
          categoria: s.categoryName,
        })),
    };
  }

  /**
   * A grade, do mesmo motor da página pública.
   *
   * A janela tem teto nas duas pontas — só o começo conferido deixaria "de hoje
   * até 2099" passar, e isso nunca expira.
   */
  @Escopo('appointments.view')
  @Get('disponibilidade')
  async disponibilidade(
    @Req() pedido: ChaveRequest,
    @Query(new ZodValidationPipe(disponibilidadePublicaSchema)) query: {
      locationId: string;
      serviceIds: string[];
      professionalId?: string;
      de: string;
      ate?: string;
    },
  ) {
    const chave = this.exigir(pedido);
    const grade = await getAvailabilityRange({
      tenantId: chave.tenantId,
      locationId: query.locationId,
      serviceIds: query.serviceIds,
      dateFrom: query.de,
      dateTo: query.ate ?? query.de,
      ...(query.professionalId ? { professionalId: query.professionalId } : {}),
    });
    return { fuso: grade.timezone, dias: grade.days };
  }

  /**
   * Cria um agendamento.
   *
   * `Idempotency-Key` obrigatória, e não opcional como na porta do cliente: ali
   * quem repete é um dedo no botão; aqui é um laço de integração com
   * retentativa, e a segunda chamada sem chave cria o segundo horário.
   *
   * A chave é escopada por cliente antes de ser gravada — duas integrações
   * mandando `"1"` não colidem —, e o escopo exigido é `appointments.create`,
   * o mesmo do painel.
   */
  @Escopo('appointments.create')
  @Post('agendamentos')
  async agendar(
    @Req() pedido: ChaveRequest,
    @Body(new ZodValidationPipe(agendamentoPublicoSchema)) body: {
      locationId: string;
      serviceIds: string[];
      professionalId: string;
      date: string;
      start: string;
      telefone: string;
      nome: string;
      notes?: string;
    },
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const chave = this.exigir(pedido);
    if (!idempotencyKey || idempotencyKey.length > 128) {
      throw badRequest('idempotency_key_obrigatoria', 'Mande um Idempotency-Key de até 128 caracteres');
    }

    const guest = await resolveGuestCustomer({
      tenantId: chave.tenantId,
      name: body.nome,
      phone: body.telefone,
    });

    const agendamento = await createAppointment({
      tenantId: chave.tenantId,
      customerId: guest.customerId,
      locationId: body.locationId,
      serviceIds: body.serviceIds,
      professionalId: body.professionalId,
      date: body.date,
      start: body.start,
      source: 'api' as const,
      idempotencyKey,
      ...(body.notes ? { notes: body.notes } : {}),
    });

    /**
     * A resposta traz o que foi criado, e nada do cadastro.
     *
     * `resolveGuestCustomer` acha quem já existe; devolver isso — ou dizer "já
     * era cliente" — viraria oráculo, e com uma lista de números se descobre
     * quem é cliente de quem. É o precedente do OTP, que responde igual para
     * telefone existente e inexistente.
     */
    return {
      id: agendamento.id,
      comecaEm: agendamento.serviceStartsAt,
      terminaEm: agendamento.serviceEndsAt,
      profissionalId: agendamento.professionalId,
      estado: agendamento.status,
      precoCents: agendamento.priceCents,
      sinalCents: agendamento.depositRequiredCents,
    };
  }

  private exigir(pedido: ChaveRequest) {
    const chave = pedido.chave;
    if (!chave) throw new DomainError('sem_chave', 401, 'Chave ausente');
    return chave;
  }
}
