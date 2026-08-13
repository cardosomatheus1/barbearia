import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import {
  getAvailabilityRange,
  getPublicProfile,
  MAX_RANGE_DAYS,
  perfilPublicoDoBarbeiro,
} from '@barbearia/scheduling';
import { notFound, badRequest } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { TenantService } from '../tenant/tenant.service.js';
import { avaliacoesPublicas } from '@barbearia/crm';
import { availabilityQuerySchema, slugSchema, type AvailabilityQuery } from './booking.schemas.js';

/**
 * Superfície pública de agendamento. Sem autenticação: o slug é o endereço.
 *
 * O controller traduz HTTP para caso de uso e volta. Nenhuma regra de negócio
 * mora aqui (CLAUDE.md §4).
 */
@Controller('v1/b/:slug')
export class BookingController {
  // `@Inject` explícito: a DI por metadata de decorator depende do transpilador
  // emitir `design:paramtypes`, o que o esbuild não faz. Declarar o token deixa
  // a injeção independente da ferramenta de build.
  constructor(@Inject(TenantService) private readonly tenants: TenantService) {}

  /** Tudo que a página pública mostra sem autenticação. */
  @Get()
  async profile(@Param('slug', new ZodValidationPipe(slugSchema)) slug: string) {
    const tenantId = await this.tenants.resolve(slug);
    if (!tenantId) throw notFound('establishment_not_found', 'Estabelecimento não encontrado');

    const profile = await getPublicProfile(tenantId, slug);
    if (!profile) throw notFound('establishment_not_found', 'Estabelecimento não encontrado');
    return profile;
  }

  /**
   * A reputação da casa, sem autenticação (bloco 43, SPEC §4.10).
   *
   * Rota própria e não parte do perfil porque `getPublicProfile` mora em
   * `scheduling`, e a seta de dependência não volta: quem sabe de avaliação é
   * `crm`. A API é a camada que conhece as duas.
   *
   * Devolve só o **publicado** — nota boa entra na hora, nota baixa depois da
   * janela de 48h — e só o primeiro nome de quem escreveu: a página é indexada
   * pelo Google, e o sobrenome do cliente não precisa estar nela.
   */
  @Get('avaliacoes')
  async avaliacoes(@Param('slug', new ZodValidationPipe(slugSchema)) slug: string) {
    const tenantId = await this.tenants.resolve(slug);
    if (!tenantId) throw notFound('establishment_not_found', 'Estabelecimento não encontrado');
    return avaliacoesPublicas(tenantId);
  }

  /**
   * A página pública do barbeiro (bloco 73, SPEC §5.2).
   *
   * Pública e sem sessão, como o resto da superfície de descoberta — quem lê
   * ainda não é cliente de ninguém. O que sai daqui é o que a SPEC desenha no
   * card: nome, foto, nota pública, atendimentos e especialidades. Nada de
   * agenda de cliente, nada de dinheiro.
   *
   * Perfil desligado responde 404, e não uma página vazia: "existe mas está
   * escondido" confirma para quem adivinhou o endereço que aquela pessoa
   * trabalha ali — é o precedente do OTP, que responde igual para telefone
   * existente e inexistente.
   */
  @Get('b/:barbeiro')
  async barbeiro(
    @Param('slug', new ZodValidationPipe(slugSchema)) slug: string,
    @Param('barbeiro', new ZodValidationPipe(slugSchema)) barbeiro: string,
  ) {
    const tenantId = await this.tenants.resolve(slug);
    if (!tenantId) throw notFound('establishment_not_found', 'Estabelecimento não encontrado');

    const perfil = await perfilPublicoDoBarbeiro(tenantId, barbeiro);
    if (!perfil) throw notFound('professional_not_found', 'Profissional não encontrado');
    return perfil;
  }

  @Get('availability')
  async availability(
    @Param('slug', new ZodValidationPipe(slugSchema)) slug: string,
    @Query(new ZodValidationPipe(availabilityQuerySchema)) query: AvailabilityQuery,
  ) {
    const tenantId = await this.tenants.resolve(slug);
    if (!tenantId) throw notFound('establishment_not_found', 'Estabelecimento não encontrado');

    let range;
    try {
      range = await getAvailabilityRange({
        tenantId,
        locationId: query.locationId,
        serviceIds: query.serviceIds,
        dateFrom: query.dateFrom,
        ...(query.dateTo ? { dateTo: query.dateTo } : {}),
        ...(query.professionalId ? { professionalId: query.professionalId } : {}),
        collapse: query.anyProfessional,
      });
    } catch (error) {
      // `datesBetween` rejeita intervalo invertido ou acima do teto. É erro do
      // chamador, não falha interna.
      if (error instanceof RangeError) {
        throw badRequest('invalid_range', `Intervalo inválido (máximo ${MAX_RANGE_DAYS} dias)`);
      }
      throw error;
    }

    return {
      timezone: range.timezone,
      granularityMinutes: range.granularityMinutes,
      days: range.days.map((day) => ({
        date: day.date,
        totalDurationMinutes: day.totalDurationMinutes,
        serviceDurationMinutes: day.serviceDurationMinutes,
        unavailableReason: day.unavailableReason,
        waitlistAvailable: day.waitlistAvailable,
        slots: day.slots.map((slot) => ({
          start: slot.start,
          end: slot.end,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          professionalId: slot.professionalId,
          priceCents: slot.price ?? null,
        })),
      })),
      professionals: range.days[0]?.professionals ?? [],
    };
  }
}
