import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  AgendaError,
  createException,
  deleteException,
  getAgenda,
  MAX_DIAS_DA_AGENDA,
  quemEstaEsperando,
  rescheduleAppointment,
} from '@barbearia/scheduling';
import { MOTIVO_DA_FALHA, pode, type FalhaDaExcecao, type TipoDeExcecao } from '@barbearia/core';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { badRequest, DomainError, notFound } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { traduzirReserva } from '../common/booking-http.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { appointmentIdSchema } from '../booking/booking.schemas.js';
import { unidadeDoBalcao } from './unidade.js';
import {
  agendaQuerySchema,
  excecaoIdSchema,
  excecaoSchema,
  moverSchema,
} from './agenda.schemas.js';

/**
 * Teto do bloqueio operacional, em minutos.
 *
 * Quatro horas cobrem o dentista, a entrega, a reunião de equipe e o almoço
 * longo — o que a recepção de fato bloqueia, inclusive para a casa toda. Acima
 * disso a decisão é "hoje não se trabalha", que é folga ou feriado, e isso muda
 * o funcionamento da barbearia.
 *
 * O teto é sobre a **duração**, não sobre o alvo: exigir profissional impediria
 * a recepcionista de fechar uma hora para a reunião, que é trabalho legítimo e
 * frequente.
 *
 * **Limite assumido:** seis bloqueios de quatro horas cobrem o dia. A diferença
 * é que ficam seis linhas hachuradas e datadas na agenda, com autor e motivo —
 * não um `holiday` silencioso. Impedir a repetição exigiria um orçamento diário
 * por papel, que é mecanismo grande para um risco que a tela já expõe.
 */
const MAX_BLOQUEIO_OPERACIONAL = 240;

const STATUS: Record<string, number> = {
  appointment_not_found: 404,
  exception_not_found: 404,
  unknown_professional: 404,
  invalid_exception: 422,
  kind_not_allowed: 403,
  fora_do_alcance: 403,
  appointment_not_active: 409,
  slot_not_available: 409,
  slot_taken: 409,
};

function toHttp(error: unknown): never {
  if (error instanceof AgendaError) {
    // O detalhe é a falha de validação do domínio, traduzida para gente. Sem
    // ele a tela só consegue dizer "dados inválidos", que não é acionável.
    const motivo =
      typeof error.detail === 'string'
        ? MOTIVO_DA_FALHA[error.detail as FalhaDaExcecao]
        : undefined;
    throw new DomainError(
      error.code,
      STATUS[error.code] ?? 400,
      motivo ?? error.message,
      error.detail,
    );
  }
  traduzirReserva(error);
  throw error;
}

/**
 * A agenda do admin — dia, semana e lista saem todos daqui.
 *
 * As três "views" da SPEC §2.14 são o **mesmo dado** em intervalos diferentes:
 * um dia, sete dias, ou o intervalo que a lista pedir. Três endpoints seriam
 * três consultas para manter em sincronia, e a primeira a divergir seria a que
 * ninguém abre.
 *
 * Como no balcão, **nenhuma rota aceita `locationId`** — ele vem do tenant do
 * token — e toda rota declara a permissão que exige.
 *
 * O recorte por permissão é o mesmo do painel do dia: quem não tem
 * `appointments.view_all_professionals` enxerga só a própria agenda, e o
 * recorte sai de `staff.professionalId`, nunca do parâmetro da requisição.
 */
@Controller('v1/admin/agenda')
@UseGuards(StaffGuard, PermissaoGuard)
export class AgendaController {
  private recorte(staff: AuthenticatedStaff): string | null {
    return pode(staff.permissions, 'appointments.view_all_professionals')
      ? null
      : staff.professionalId;
  }

  private async unidade(staff: AuthenticatedStaff) {
    return unidadeDoBalcao(staff);
  }

  /**
   * Quem está esperando uma vaga (bloco 38).
   *
   * ## As duas permissões, e por que não é só a da agenda
   *
   * A rota devolve **nome e telefone** de quem espera, e nesta casa identidade
   * de cliente é `customers.view` — é a mesma forma que a busca do balcão
   * devolve, e ela declara essa permissão. Achado da revisão de segurança
   * deste bloco, e é o mesmo defeito que a revisão do bloco 31 cobrou na
   * exportação do titular: rota que agrega declara **todas** as permissões do
   * que ela devolve, não a mais próxima do nome.
   *
   * Sem isso, um dono que tirasse `customers.view` de um papel para proteger a
   * base entregaria a base inteira por esta porta — sem paginação e sem teto.
   *
   * ## O recorte por profissional
   *
   * Vale aqui como vale na agenda: quem não tem `appointments.view_all_
   * professionals` enxerga a própria cadeira. A entrada **sem profissional**
   * aparece para todos, porque qualquer um pode atendê-la; a que nomeia um
   * colega, não. Sem o recorte, o barbeiro lia a lista da barbearia inteira
   * justamente pela rota que a agenda protege.
   */
  @Exige('appointments.view', 'customers.view')
  @Get('espera')
  async espera(@Staff() staff: AuthenticatedStaff) {
    const local = await this.unidade(staff);
    const esperando = await quemEstaEsperando(
      staff.tenantId,
      local.id,
      this.recorte(staff),
    );
    return { esperando };
  }

  @Exige('appointments.view')
  @Get()
  async agenda(
    @Staff() staff: AuthenticatedStaff,
    @Query(new ZodValidationPipe(agendaQuerySchema))
    query: { from?: string; to?: string; professionalId?: string },
  ) {
    const local = await this.unidade(staff);
    const from = query.from ?? local.today;

    try {
      const agenda = await getAgenda({
        tenantId: staff.tenantId,
        locationId: local.id,
        timezone: local.timezone,
        from,
        to: query.to ?? from,
        onlyProfessionalId: this.recorte(staff),
      });

      // O filtro da tela é aplicado depois, sobre o que já veio: o recorte de
      // **permissão** vai na consulta, e os dois não podem se confundir.
      const professionals = query.professionalId
        ? agenda.professionals.filter((p) => p.id === query.professionalId)
        : agenda.professionals;

      return { ...agenda, professionals, today: local.today };
    } catch (error) {
      if (error instanceof RangeError) {
        throw badRequest('invalid_range', `Intervalo inválido (máximo ${MAX_DIAS_DA_AGENDA} dias)`);
      }
      throw error;
    }
  }

  /**
   * Bloqueio pontual: "dentista às 14h".
   *
   * `appointments.create` e não `settings.manage` de propósito. Bloquear uma
   * hora é ocupar tempo de agenda — trabalho de recepção, feito dez vezes por
   * semana. Exigir permissão de configuração aqui obrigaria a recepcionista a
   * chamar o dono para tirar uma hora do dia, e o que aconteceria de verdade é
   * a barbearia dar `settings.manage` para todo mundo.
   */
  @Exige('appointments.create')
  @Post('blocks')
  async bloquear(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(excecaoSchema))
    body: {
      kind: TipoDeExcecao;
      date: string;
      startMinute?: number | null;
      endMinute?: number | null;
      professionalId?: string;
      reason?: string;
      confirmarConflitos: boolean;
    },
  ) {
    if (body.kind !== 'block') {
      // Fechar o dia, o feriado e o horário diferente são política de
      // funcionamento, não operação do balcão. Vão pela outra rota, que exige
      // `settings.manage`.
      throw badRequest('invalid_exception', 'Esta rota cria apenas bloqueio pontual.');
    }

    // Recusar o **nome** não bastava: bloqueio das 00:00 às 24:00 sem
    // profissional é um feriado com outra etiqueta — o motor subtrai bloqueio da
    // unidade do dia de todo mundo, e a barbearia some da grade pública.
    // O primeiro teste desta rota conferia só a grafia do tipo, e passava.
    if (!pode(staff.permissions, 'settings.manage')) {
      const duracao = (body.endMinute ?? 0) - (body.startMinute ?? 0);
      if (duracao > MAX_BLOQUEIO_OPERACIONAL) {
        throw new DomainError(
          'forbidden',
          403,
          'Bloqueio longo é folga ou feriado, e isso é do dono ou do gerente.',
        );
      }
    }

    return this.gravar(staff, body);
  }

  /**
   * Folga, feriado, férias e horário diferente.
   *
   * Estes mudam o funcionamento da barbearia, não o dia de hoje — e é por isso
   * que exigem `settings.manage`. Um feriado criado por engano fecha a agenda
   * inteira e ninguém percebe até o cliente não achar horário.
   */
  @Exige('settings.manage')
  @Post('exceptions')
  async excecao(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(excecaoSchema))
    body: {
      kind: TipoDeExcecao;
      date: string;
      startMinute?: number | null;
      endMinute?: number | null;
      professionalId?: string;
      reason?: string;
      confirmarConflitos: boolean;
    },
  ) {
    return this.gravar(staff, body);
  }

  private async gravar(
    staff: AuthenticatedStaff,
    body: {
      kind: TipoDeExcecao;
      date: string;
      startMinute?: number | null;
      endMinute?: number | null;
      professionalId?: string;
      reason?: string;
      confirmarConflitos: boolean;
    },
  ) {
    const local = await this.unidade(staff);

    try {
      return await createException({
        tenantId: staff.tenantId,
        onlyProfessionalId: this.recorte(staff),
        locationId: local.id,
        timezone: local.timezone,
        kind: body.kind,
        date: body.date,
        startMinute: body.startMinute ?? null,
        endMinute: body.endMinute ?? null,
        professionalId: body.professionalId ?? null,
        reason: body.reason ?? null,
        confirmarConflitos: body.confirmarConflitos,
      });
    } catch (error) {
      return toHttp(error);
    }
  }

  @Exige('appointments.create')
  @Delete('exceptions/:id')
  async remover(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(excecaoIdSchema)) id: string,
  ) {
    const local = await this.unidade(staff);
    try {
      await deleteException({
        tenantId: staff.tenantId,
        locationId: local.id,
        exceptionId: id,
        // Simétrico à criação: quem só cria bloqueio só apaga bloqueio. A
        // guarda da rota declara o piso; o tipo só se conhece depois de ler a
        // linha, e sem esta simetria a recepcionista reabriria o feriado.
        somenteBloqueio: !pode(staff.permissions, 'settings.manage'),
        // E o mesmo recorte que a criação passou a exigir: quem enxerga uma
        // cadeira só apaga o que é dela.
        onlyProfessionalId: this.recorte(staff),
      });
      return { deleted: true };
    } catch (error) {
      return toHttp(error);
    }
  }

  /**
   * Move um agendamento — o que o "arrastar" da SPEC faz por baixo.
   *
   * A antecedência mínima e o limite de remarcações **não** se aplicam: são
   * regras do autoatendimento, e quem está aqui é a recepção com o telefone na
   * mão. `rescheduleAppointment` distingue os dois chamadores pela presença de
   * `customerId`, que aqui não vai.
   *
   * O horário de destino ainda passa pelo motor: mover para cima de outro
   * cliente é recusado pela constraint de exclusão, não por um aviso na tela.
   */
  @Exige('appointments.reschedule')
  @Post('appointments/:id/move')
  async mover(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(appointmentIdSchema)) id: string,
    @Body(new ZodValidationPipe(moverSchema))
    body: { date: string; start: string; professionalId?: string },
  ) {
    try {
      const recorte = this.recorte(staff);

      // Conta sem agenda própria e sem permissão de ver a casa não tem o que
      // mover. `recorte` devolve `null` nesse caso — que significa "sem
      // restrição" —, e para uma escrita que mexe no cliente de outra pessoa o
      // padrão precisa ser o contrário.
      if (!pode(staff.permissions, 'appointments.view_all_professionals') && !recorte) {
        throw new DomainError(
          'forbidden',
          403,
          'Sua conta não está ligada a uma agenda, então não há o que mover.',
        );
      }

      // Quem só enxerga a própria agenda também só empurra para a própria
      // cadeira. Aceitar o destino do corpo aqui deixaria o barbeiro despachar
      // cliente para o colega — e a lista de conflitos já dá os ids.
      if (recorte && body.professionalId && body.professionalId !== recorte) {
        throw new DomainError(
          'forbidden',
          403,
          'Você só pode mover atendimentos para a sua própria agenda.',
        );
      }

      // O agendamento é **desta** loja. Era a única rota deste controller que
      // não passava por `this.unidade(staff)`.
      const local = await this.unidade(staff);

      const movido = await rescheduleAppointment({
        tenantId: staff.tenantId,
        appointmentId: id,
        date: body.date,
        start: body.start,
        onlyProfessionalId: recorte,
        onlyLocationId: local.id,
        ...(body.professionalId ? { professionalId: body.professionalId } : {}),
      });

      return {
        id: movido.id,
        startsAt: movido.serviceStartsAt,
        endsAt: movido.serviceEndsAt,
        professionalId: movido.professionalId,
      };
    } catch (error) {
      return toHttp(error);
    }
  }
}
