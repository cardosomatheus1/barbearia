import { Controller, Get, Inject, Param, Post } from '@nestjs/common';
import {
  OfertaError,
  aceitarOferta,
  createAppointment,
  ofertaPorToken,
} from '@barbearia/scheduling';
import { recursoLigado } from '@barbearia/platform';
import { DomainError, notFound } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { traduzirReserva } from '../common/booking-http.js';
import { TenantService } from '../tenant/tenant.service.js';
import { slugSchema } from './booking.schemas.js';
import { queueTokenSchema } from '../admin/fila.schemas.js';

/**
 * O convite de vaga — **sem sessão, só com o link** (bloco 39, SPEC §2.9).
 *
 * Mesmo desenho da posição na fila: o token de 32 bytes é a credencial, vive
 * hasheado no banco e existe em claro uma vez, dentro da mensagem. Pedir login
 * antes de aceitar seria pedir cadastro no minuto em que o relógio corre — e a
 * janela exclusiva tem dez minutos.
 *
 * ## A resposta é a mesma para token inválido e para token de outra barbearia
 *
 * Diferenciar diria a quem varre links que aquele token existe em algum lugar.
 * É o precedente do `fila-publica`.
 *
 * ## O corpo do aceite é vazio, e é de propósito
 *
 * Serviços, profissional e horário saem da oferta gravada. Aceitar um corpo
 * deixaria quem tem o link marcar **outra coisa** no horário que conseguiu por
 * prioridade — e a fila premia quem pediu a janela mais justa, não quem sabe
 * montar uma requisição.
 */
/**
 * Como o agendamento nasce de um convite aceito.
 *
 * Uma função só, usada pelas **duas** portas — o link sem sessão e a tela de
 * quem já está autenticada. Duas cópias divergiriam no primeiro ajuste, e a
 * diferença apareceria como "pelo link marca, pela tela não".
 */
export function marcarDoConvite(tenantId: string) {
  return (pedido: {
    readonly ofertaId: string;
    readonly locationId: string;
    readonly professionalId: string;
    readonly serviceIds: readonly string[];
    readonly customerId: string;
    readonly date: string;
    readonly start: string;
    readonly holdId: string | null;
  }) =>
    createAppointment({
      tenantId,
      locationId: pedido.locationId,
      professionalId: pedido.professionalId,
      serviceIds: [...pedido.serviceIds],
      customerId: pedido.customerId,
      date: pedido.date,
      start: pedido.start,
      source: 'waitlist',
      /**
       * A antecedência mínima não se aplica ao convite, e isto é decisão.
       *
       * Ela existe para conter a marcação de surpresa pelo site — o cliente que
       * aparece às 8h55 para as 9h. Um convite é o contrário disso: a barbearia
       * é quem chamou, para um horário que ela quer preencher, e o buraco
       * costuma ser justamente no fim da tarde de hoje. Aplicá-la aqui faria o
       * produto convidar alguém para um horário que ele mesmo recusaria em
       * seguida.
       */
      atCounter: true,
      /**
       * A chave é o **id da oferta**, e não vem do cliente nem do token.
       *
       * Do cliente ela não pode vir: o convite não tem corpo, e uma chave livre
       * reabriria a colisão entre pessoas que a regra da casa fecha escopando
       * por cliente. Do token também não — ele é credencial, e pedaço de
       * credencial em coluna de banco é credencial em coluna de banco.
       */
      idempotencyKey: `oferta:${pedido.ofertaId}`,
      ...(pedido.holdId ? { holdId: pedido.holdId } : {}),
    });
}

/** Traduz a recusa do convite em resposta HTTP, para as duas portas. */
export function conviteParaHttp(erro: unknown): never {
  if (erro instanceof OfertaError) {
    // Convite inexistente e convite de outra barbearia respondem igual.
    throw new DomainError(
      erro.code,
      erro.code === 'oferta_nao_encontrada' ? 404 : 409,
      erro.message,
    );
  }
  traduzirReserva(erro);
  throw erro;
}

@Controller('v1/b/:slug/offer')
export class OfertaPublicaController {
  constructor(@Inject(TenantService) private readonly tenants: TenantService) {}

  @Get(':token')
  async ver(
    @Param('slug', new ZodValidationPipe(slugSchema)) slug: string,
    @Param('token', new ZodValidationPipe(queueTokenSchema)) token: string,
  ) {
    const oferta = await ofertaPorToken(await this.resolver(slug), token);
    if (!oferta) throw notFound('offer_not_found', 'Este convite não está mais válido');
    return oferta;
  }

  @Post(':token/accept')
  async aceitar(
    @Param('slug', new ZodValidationPipe(slugSchema)) slug: string,
    @Param('token', new ZodValidationPipe(queueTokenSchema)) token: string,
  ) {
    const tenantId = await this.resolver(slug);

    try {
      const { appointmentId } = await aceitarOferta({
        tenantId,
        convite: { token },
        marcar: marcarDoConvite(tenantId),
      });
      return { agendamentoId: appointmentId };
    } catch (erro) {
      return conviteParaHttp(erro);
    }
  }

  /**
   * A barbearia do endereço, com o recurso de avisos conferido.
   *
   * O convite cai junto com o interruptor que o criou: desligar avisos e deixar
   * no ar um link que marca horário seria um caminho vivo para um recurso que a
   * barbearia desligou.
   */
  private async resolver(slug: string): Promise<string> {
    const tenantId = await this.tenants.resolve(slug);
    if (!tenantId) throw notFound('establishment_not_found', 'Estabelecimento não encontrado');
    if (!(await recursoLigado(tenantId, 'avisos'))) {
      throw notFound('offer_not_found', 'Este convite não está mais válido');
    }
    return tenantId;
  }
}
