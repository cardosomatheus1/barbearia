import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  EsperaError,
  bookingPolicy,
  aceitarOferta,
  entrarNaEspera,
  esperasDoCliente,
  sairDaEspera,
} from '@barbearia/scheduling';
import { parseHHMM } from '@barbearia/core';
import { OtpError, resolveGuestCustomer, resolveSession } from '@barbearia/identity';
import type { AuthenticatedCustomer } from '@barbearia/identity';
import { DomainError, badRequest, notFound } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { TenantService } from '../tenant/tenant.service.js';
import { Customer, CustomerGuard, TenantId } from '../auth/customer.guard.js';
import { entrarNaEsperaSchema } from '../auth/auth.schemas.js';
import { appointmentIdSchema, slugSchema } from './booking.schemas.js';
import { conviteParaHttp, marcarDoConvite } from './oferta.controller.js';

/**
 * A lista de espera, do lado do cliente (bloco 38, SPEC §2.9).
 *
 * ## Entrar não pede sessão; sair pede
 *
 * A assimetria é a mesma do agendamento, e pela mesma razão. Quem chega aqui
 * acabou de ver "nenhum horário neste dia" — obrigá-la a fazer login para dizer
 * "me avise" perderia a pessoa no passo em que ela já foi frustrada uma vez.
 *
 * Sair é outra coisa: sem sessão bastaria conhecer o id de uma entrada para
 * tirar qualquer pessoa da fila, e o id viaja na tela de quem espera.
 *
 * ## E sem sessão a resposta não conta nada
 *
 * `resolveGuestCustomer` devolve o **cliente existente** quando o telefone já é
 * conhecido. Devolver a entrada criada — ou "você já está em três listas" —
 * transformaria a rota num oráculo: com uma lista de números, um atacante
 * descobriria quem é cliente daquela barbearia e o que essa pessoa está
 * esperando, sem autenticação nenhuma.
 *
 * Quem tem sessão recebe a entrada inteira; quem não tem recebe sempre a mesma
 * confirmação. É o precedente do OTP, que este produto já aplica: o endereço de
 * verificação responde igual para telefone existente e inexistente.
 */

const STATUS: Record<string, number> = {
  espera_nao_encontrada: 404,
  unidade_desconhecida: 404,
  servico_desconhecido: 404,
  profissional_desconhecido: 404,
  limite_atingido: 409,
  idempotencia_conflitante: 409,
  janela_invalida: 400,
  periodo_invertido: 400,
  periodo_longo_demais: 400,
  dia_no_passado: 400,
};

function toHttp(erro: unknown): never {
  if (erro instanceof EsperaError) {
    throw new DomainError(erro.code, STATUS[erro.code] ?? 400, erro.message);
  }
  if (erro instanceof OtpError) {
    throw new DomainError(erro.code, 400, erro.message);
  }
  throw erro;
}

/**
 * O que a rota pública devolve a quem não tem sessão.
 *
 * Um objeto só, sem id e sem nada do cadastro: é o que torna "criou", "já
 * estava" e "estourou o teto" indistinguíveis de fora.
 */
const REGISTRADO = { registrado: true } as const;

/**
 * As recusas que falam do **cadastro**, e por isso não saem sem sessão.
 *
 * As outras — janela invertida, período longo demais, dia no passado — falam do
 * que a pessoa acabou de digitar. Calá-las seria esconder erro de formulário.
 */
const CALADAS = new Set<string>(['limite_atingido']);

interface CorpoDaEspera {
  readonly name?: string;
  readonly phone?: string;
  readonly locationId: string;
  readonly serviceIds: string[];
  readonly professionalId?: string;
  readonly de: string;
  readonly ate: string;
  readonly inicio: string;
  readonly fim: string;
}

@Controller('v1/b/:slug/waitlist')
export class EsperaPublicaController {
  constructor(@Inject(TenantService) private readonly tenants: TenantService) {}

  @Post()
  async entrar(
    @Param('slug', new ZodValidationPipe(slugSchema)) slug: string,
    @Body(new ZodValidationPipe(entrarNaEsperaSchema)) body: CorpoDaEspera,
    @Req() request: Request,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    const tenantId = await this.tenants.resolve(slug);
    if (!tenantId) throw notFound('establishment_not_found', 'Estabelecimento não encontrado');

    // Só teto: a chave é escopada por cliente antes de ser gravada, então uma
    // chave curta é inofensiva.
    if (idempotencyKey !== undefined && (idempotencyKey === '' || idempotencyKey.length > 128)) {
      throw badRequest('invalid_request', 'Idempotency-Key com tamanho inválido');
    }

    const policy = await bookingPolicy(tenantId, body.locationId);
    if (!policy) throw notFound('unknown_location', 'Unidade não encontrada');

    const identificado = await this.identificar(
      tenantId,
      body,
      request,
      policy.requireOtpForBooking,
    );

    try {
      const entrada = await entrarNaEspera({
        tenantId,
        locationId: body.locationId,
        customerId: identificado.customerId,
        serviceIds: body.serviceIds,
        professionalId: body.professionalId ?? null,
        de: body.de,
        ate: body.ate,
        // `HH:mm` na borda, minutos no domínio: a conversão fica num lugar só.
        inicioMinuto: parseHHMM(body.inicio),
        fimMinuto: parseHHMM(body.fim),
        ...(idempotencyKey
          ? { idempotencyKey: `${tenantId}:${identificado.customerId}:${idempotencyKey}` }
          : {}),
      });

      return identificado.comSessao ? entrada : REGISTRADO;
    } catch (erro) {
      /**
       * Sem sessão, "você já está em três listas" vira oráculo sobre o cadastro
       * de terceiro — e o telefone é a chave.
       *
       * Achado da revisão de segurança. `resolveGuestCustomer` devolve o
       * **cliente existente** quando o telefone já é conhecido, então um
       * atacante com uma lista de números descobria, um a um, quem é cliente
       * daquela barbearia e quem está esperando o quê — sem nenhuma
       * autenticação.
       *
       * A resposta é o mesmo precedente do OTP, que este produto já aplica:
       * `verifica_celular` responde igual para telefone existente e
       * inexistente. Aqui as três saídas — criou, já estava, estourou o teto —
       * ficam indistinguíveis de fora.
       *
       * O custo está escrito: quem está no teto e não tem sessão recebe
       * "pronto" sem entrar. A tela manda conferir em "Meus agendamentos", que
       * é onde a verdade está — e lá pede sessão.
       *
       * Recusa de **entrada malformada** continua saindo: ela fala do que a
       * pessoa acabou de digitar, não do cadastro de ninguém.
       */
      if (!identificado.comSessao && erro instanceof EsperaError && CALADAS.has(erro.code)) {
        return REGISTRADO;
      }
      return toHttp(erro);
    }
  }

  /**
   * A mesma identificação do agendamento, e é de propósito.
   *
   * Se a barbearia exige código para marcar, exige para entrar na lista: sem
   * isso, a espera viraria a porta lateral para criar cadastro com telefone
   * alheio — que é justamente o que `requireOtpForBooking` fecha.
   */
  private async identificar(
    tenantId: string,
    body: CorpoDaEspera,
    request: Request,
    requireOtp: boolean,
  ): Promise<{ readonly customerId: string; readonly comSessao: boolean }> {
    const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];

    if (token) {
      try {
        const sessao = await resolveSession(tenantId, token);
        return { customerId: sessao.customerId, comSessao: true };
      } catch (erro) {
        if (erro instanceof OtpError) {
          throw new DomainError('unauthorized', 401, 'Sessão inválida');
        }
        throw erro;
      }
    }

    if (requireOtp) {
      throw new DomainError(
        'otp_required',
        401,
        'Esta barbearia pede validação do número para agendar',
      );
    }

    if (!body.name || !body.phone) {
      throw badRequest('invalid_request', 'Informe nome e celular');
    }

    try {
      const visitante = await resolveGuestCustomer({
        tenantId,
        name: body.name,
        phone: body.phone,
      });
      return { customerId: visitante.customerId, comSessao: false };
    } catch (erro) {
      return toHttp(erro);
    }
  }
}

/**
 * Ver e sair — **sessão obrigatória**.
 *
 * Toda rota repassa o `customerId`: a RLS separa barbearias, não separa
 * clientes dentro de uma.
 */
@Controller('v1/b/:slug/waitlist')
@UseGuards(CustomerGuard)
export class EsperaDoClienteController {
  @Get()
  async minhas(
    @TenantId() tenantId: string,
    @Customer() customer: AuthenticatedCustomer,
  ) {
    const esperas = await esperasDoCliente(tenantId, customer.customerId);
    return { esperas };
  }

  /**
   * Aceita o convite pela própria tela (bloco 39).
   *
   * O caminho normal é o link da mensagem, e o token é a credencial dele. Esta
   * porta existe porque a mensagem pode não chegar — janela de silêncio,
   * provedor fora do ar, ou o provedor de console, que é o que roda até o
   * WhatsApp oficial entrar. Sem ela, a pessoa vê "um horário abriu para você" e
   * não tem como aceitá-lo: estado sem saída na interface.
   *
   * Quem autoriza é a sessão **somada** ao `customerId`, que segue para o
   * domínio: a RLS separa barbearias e não separa clientes dentro de uma.
   */
  @Post(':id/accept')
  async aceitarConvite(
    @TenantId() tenantId: string,
    @Customer() customer: AuthenticatedCustomer,
    @Param('id', new ZodValidationPipe(appointmentIdSchema)) id: string,
  ) {
    try {
      const { appointmentId } = await aceitarOferta({
        tenantId,
        convite: { entryId: id, customerId: customer.customerId },
        marcar: marcarDoConvite(tenantId),
      });
      return { agendamentoId: appointmentId };
    } catch (erro) {
      return conviteParaHttp(erro);
    }
  }

  @Delete(':id')
  async sair(
    @TenantId() tenantId: string,
    @Customer() customer: AuthenticatedCustomer,
    @Param('id', new ZodValidationPipe(appointmentIdSchema)) id: string,
  ) {
    try {
      await sairDaEspera({ tenantId, customerId: customer.customerId, entryId: id });
      return { saiu: true };
    } catch (erro) {
      return toHttp(erro);
    }
  }
}
