import { Body, Controller, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { RecadoError, registrarRecado } from '@barbearia/crm';
import { OtpError, resolveGuestCustomer, resolveSession } from '@barbearia/identity';
import { bookingPolicy, primaryLocation } from '@barbearia/scheduling';
import { DomainError, badRequest, notFound } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { TenantService } from '../tenant/tenant.service.js';
import { slugSchema } from './booking.schemas.js';
import { recadoPublicoSchema, type RecadoPublico } from './recado.schemas.js';

/**
 * O canal de recados, do lado do cliente (bloco 40).
 *
 * ## Sem conta, e é a decisão que faz o canal existir
 *
 * Quem tem uma reclamação para fazer não vai criar cadastro para fazê-la. Pior:
 * a reclamação mais valiosa vem de quem **desistiu** — esperou quarenta minutos
 * e foi embora —, e essa pessoa nunca teve conta. Exigir login aqui seria
 * fechar a porta na cara de quem o canal existe para ouvir.
 *
 * ## A resposta é sempre a mesma, e por quê
 *
 * `resolveGuestCustomer` reencontra o cliente existente pelo telefone. Devolver
 * qualquer coisa diferente — o id do recado, "você já mandou três" — viraria
 * oráculo: com uma lista de números se descobre quem é cliente de quem. É o
 * mesmo precedente do OTP e da lista de espera.
 *
 * Recusa de **formulário** continua saindo, porque ela fala do que a pessoa
 * acabou de digitar e não do cadastro de ninguém.
 */

const STATUS: Record<string, number> = {
  recado_nao_encontrado: 404,
  unidade_desconhecida: 404,
  texto_curto: 400,
  texto_longo: 400,
  tipo_invalido: 400,
};

const REGISTRADO = { registrado: true } as const;

@Controller('v1/b/:slug/feedback')
export class RecadoPublicoController {
  constructor(@Inject(TenantService) private readonly tenants: TenantService) {}

  @Post()
  async mandar(
    @Param('slug', new ZodValidationPipe(slugSchema)) slug: string,
    @Body(new ZodValidationPipe(recadoPublicoSchema)) body: RecadoPublico,
    @Req() request: Request,
  ) {
    const tenantId = await this.tenants.resolve(slug);
    if (!tenantId) throw notFound('establishment_not_found', 'Estabelecimento não encontrado');

    const local = await primaryLocation(tenantId);
    if (!local) throw notFound('establishment_not_found', 'Estabelecimento não encontrado');

    /**
     * A mesma política do agendamento e da lista de espera.
     *
     * Se a barbearia exige código para marcar, ela não quer cadastro nascendo
     * de telefone não verificado — e sem esta linha o recado seria a porta
     * lateral que a espera fechou no bloco 38. Achado da revisão deste bloco.
     */
    const policy = await bookingPolicy(tenantId, local.id);
    const customerId = await this.identificar(
      tenantId,
      body,
      request,
      policy?.requireOtpForBooking ?? false,
    );

    try {
      await registrarRecado({
        tenantId,
        locationId: local.id,
        tipo: body.tipo,
        texto: body.texto,
        customerId,
        ...(body.appointmentId ? { appointmentId: body.appointmentId } : {}),
      });
      return REGISTRADO;
    } catch (erro) {
      if (erro instanceof RecadoError) {
        throw new DomainError(erro.code, STATUS[erro.code] ?? 400, erro.message);
      }
      throw erro;
    }
  }

  /**
   * Quem está falando — e o anônimo é um resultado legítimo, não uma falha.
   *
   * Três caminhos, nessa ordem: sessão de cliente, nome com telefone, e nada.
   * O terceiro é o recado anônimo, e a tela avisa que ele não terá resposta.
   *
   * O telefone **não** é gravado no recado: quem o informa vira (ou reencontra)
   * um cliente, e o número mora em `customers`, sob RLS. Copiá-lo para a tabela
   * de recados criaria dado pessoal fora do cadastro para responder o que uma
   * junção já responde.
   */
  private async identificar(
    tenantId: string,
    body: RecadoPublico,
    request: Request,
    exigeOtp: boolean,
  ): Promise<string | null> {
    const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];

    if (token) {
      try {
        const sessao = await resolveSession(tenantId, token);
        return sessao.customerId;
      } catch (erro) {
        if (erro instanceof OtpError) {
          throw new DomainError('unauthorized', 401, 'Sessão inválida');
        }
        throw erro;
      }
    }

    /**
     * Com código exigido e sem sessão, o recado entra **anônimo** — não é
     * recusado.
     *
     * A espera devolve `otp_required` e está certa: entrar numa lista pressupõe
     * que a barbearia saiba chamar a pessoa. Aqui é o contrário. O canal existe
     * justamente para quem não tem conta, e recusar transformaria o interruptor
     * de segurança do agendamento num silenciador de reclamação — que é o
     * oposto do limite ético da SPEC §4.10.
     *
     * O custo está escrito na tela: sem contato, não há resposta.
     */
    if (exigeOtp) return null;

    if (!body.nome || !body.telefone) return null;

    try {
      const visitante = await resolveGuestCustomer({
        tenantId,
        name: body.nome,
        phone: body.telefone,
      });
      return visitante.customerId;
    } catch (erro) {
      // Telefone malformado fala do que a pessoa digitou, e sai. O resto não:
      // sem sessão, nada sobre o cadastro atravessa esta rota.
      if (erro instanceof OtpError) {
        throw badRequest('invalid_request', 'Confira o número de celular.');
      }
      throw erro;
    }
  }
}
