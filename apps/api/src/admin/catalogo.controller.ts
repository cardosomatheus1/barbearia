import { Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import {
  CatalogError,
  definirPerfilPublico,
  conflitosDaJornada,
  createProfessional,
  createService,
  getSchedule,
  listProfessionals,
  listResources,
  listServices,
  saveResources,
  saveSchedule,
  setProfessionalActive,
  setServiceActive,
  setServiceResources,
  updateProfessional,
  updateService,
  type FaixaDoDia,
  type ProfessionalInput,
  type ServiceInput,
} from '@barbearia/catalog';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { DomainError, notFound } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { unidadeDoBalcao } from './unidade.js';
import {
  activeSchema,
  idSchema,
  professionalSchema,
  resourcesSchema,
  scheduleSchema,
  serviceResourcesSchema,
  serviceSchema,
  perfilPublicoSchema,
} from './catalogo.schemas.js';

const STATUS: Record<string, number> = {
  too_many_specialties: 422,
  invalid_public_slug: 422,
  service_not_found: 404,
  professional_not_found: 404,
  category_not_found: 404,
  name_taken: 409,
  invalid_catalog: 422,
};

function toHttp(error: unknown): never {
  if (error instanceof CatalogError) {
    throw new DomainError(error.code, STATUS[error.code] ?? 400, error.message, error.detail);
  }
  throw error;
}

/**
 * O cadastro da barbearia — exige `settings.manage`.
 *
 * Até aqui o catálogo só existia como as seis etapas do onboarding, que
 * **substituem** o conjunto inteiro: qualquer correção depois do primeiro dia
 * apagava e recriava os serviços, e com eles os ids que `appointment_services`
 * usa para saber o que foi vendido. Este controlador edita no lugar, e é essa a
 * diferença entre um formulário de abertura e o cadastro de um produto.
 *
 * Como no balcão, **nenhuma rota aceita `locationId`**: ele sai do tenant do
 * token. E toda rota declara a permissão que exige, porque a guarda recusa por
 * padrão o que não declara nada.
 */
@Controller('v1/admin/catalog')
@UseGuards(StaffGuard, PermissaoGuard)
export class CatalogoController {
  private async unidade(staff: AuthenticatedStaff) {
    return unidadeDoBalcao(staff);
  }

  // -- Serviços ---------------------------------------------------------------

  @Exige('settings.manage')
  @Get('services')
  async services(@Staff() staff: AuthenticatedStaff) {
    return listServices(staff.tenantId);
  }

  @Exige('settings.manage')
  @Post('services')
  async createService(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(serviceSchema)) body: ServiceInput,
  ) {
    try {
      return await createService(staff.tenantId, body);
    } catch (error) {
      return toHttp(error);
    }
  }

  @Exige('settings.manage')
  @Put('services/:id')
  async updateService(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(serviceSchema)) body: ServiceInput,
  ) {
    try {
      await updateService(staff.tenantId, id, body);
      return { updated: true };
    } catch (error) {
      return toHttp(error);
    }
  }

  /**
   * Desativa em vez de apagar, e devolve quantos já estão marcados.
   *
   * Apagar quebraria o histórico de quem já foi atendido. O número que volta é
   * o que a tela mostra antes de confirmar: são clientes com hora marcada que
   * continuam marcados, e alguém precisa decidir o que fazer com eles.
   */
  @Exige('settings.manage')
  @Put('services/:id/active')
  async serviceActive(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(activeSchema)) body: { active: boolean },
  ) {
    try {
      const resultado = await setServiceActive(staff.tenantId, id, body.active);
      return { active: body.active, ...resultado };
    } catch (error) {
      return toHttp(error);
    }
  }

  @Exige('settings.manage')
  @Put('services/:id/resources')
  async serviceResources(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(serviceResourcesSchema))
    body: { requirements: { resourceType: string; quantity: number }[] },
  ) {
    const local = await this.unidade(staff);
    try {
      await setServiceResources({
        tenantId: staff.tenantId,
        locationId: local.id,
        serviceId: id,
        requirements: body.requirements,
      });
      return { saved: true };
    } catch (error) {
      return toHttp(error);
    }
  }

  // -- Equipe -----------------------------------------------------------------

  @Exige('settings.manage')
  @Get('professionals')
  async professionals(@Staff() staff: AuthenticatedStaff) {
    const local = await this.unidade(staff);
    return { professionals: await listProfessionals(staff.tenantId, local.id) };
  }

  @Exige('settings.manage')
  @Post('professionals')
  async createProfessional(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(professionalSchema)) body: ProfessionalInput,
  ) {
    const local = await this.unidade(staff);
    try {
      return await createProfessional(staff.tenantId, local.id, body);
    } catch (error) {
      return toHttp(error);
    }
  }

  @Exige('settings.manage')
  @Put('professionals/:id')
  async updateProfessional(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(professionalSchema)) body: ProfessionalInput,
  ) {
    try {
      await updateProfessional(staff.tenantId, id, body);
      return { updated: true };
    } catch (error) {
      return toHttp(error);
    }
  }

  /**
   * A página pública do profissional (bloco 73, SPEC §5.2).
   *
   * `settings.manage`, como o resto da tela de equipe: é configuração do
   * cadastro, não dinheiro nem dado de cliente. E rota própria em vez de campo
   * no `PUT` de cima — aquele grava o cadastro inteiro, e um campo vazio ali
   * apagaria a habilidade de quem só queria ligar o perfil.
   */
  @Exige('settings.manage')
  @Put('professionals/:id/perfil-publico')
  async perfilPublico(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(perfilPublicoSchema))
    body: { ligado: boolean; especialidades: string[]; bio?: string },
  ) {
    try {
      const local = await this.unidade(staff);
      const { slug } = await definirPerfilPublico(staff.tenantId, local.id, id, {
        ligado: body.ligado,
        especialidades: body.especialidades,
        ...(body.bio === undefined ? {} : { bio: body.bio }),
      });
      return { ligado: body.ligado, slug };
    } catch (error) {
      return toHttp(error);
    }
  }

  @Exige('settings.manage')
  @Put('professionals/:id/active')
  async professionalActive(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(activeSchema)) body: { active: boolean },
  ) {
    try {
      const resultado = await setProfessionalActive({
        tenantId: staff.tenantId,
        professionalId: id,
        active: body.active,
      });
      return { active: body.active, futuros: resultado.futuros };
    } catch (error) {
      return toHttp(error);
    }
  }

  @Exige('settings.manage')
  @Get('professionals/:id/schedule')
  async schedule(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
  ) {
    return { faixas: await getSchedule(staff.tenantId, id) };
  }

  /**
   * Grava a jornada, em dois tempos quando há conflito.
   *
   * A primeira chamada devolve `conflitos` e **não grava**. Só a segunda, com
   * `confirmarConflitos`, escreve. Encolher um dia é operação legítima — o
   * barbeiro passou a sair mais cedo —, mas fazê-la sem ver quem já estava
   * marcado depois do novo horário é como o cliente perde o horário sem
   * ninguém ter cancelado nada.
   *
   * A conferência roda antes da gravação e na mesma leitura de fuso da
   * unidade, nunca no relógio do navegador: comparar minuto local com hora
   * gravada em UTC pelo relógio do dispositivo é o defeito D2.
   */
  @Exige('settings.manage')
  @Put('professionals/:id/schedule')
  async saveSchedule(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(scheduleSchema))
    body: { faixas: FaixaDoDia[]; confirmarConflitos: boolean },
  ) {
    try {
      const conflitos = await conflitosDaJornada({
        tenantId: staff.tenantId,
        professionalId: id,
        faixas: body.faixas,
      });

      if (conflitos.length > 0 && !body.confirmarConflitos) {
        return { saved: false, conflitos };
      }

      await saveSchedule({ tenantId: staff.tenantId, professionalId: id, faixas: body.faixas });
      return { saved: true, conflitos };
    } catch (error) {
      return toHttp(error);
    }
  }

  // -- Recursos ---------------------------------------------------------------

  @Exige('settings.manage')
  @Get('resources')
  async resources(@Staff() staff: AuthenticatedStaff) {
    const local = await this.unidade(staff);
    return { resources: await listResources(staff.tenantId, local.id) };
  }

  @Exige('settings.manage')
  @Put('resources')
  async saveResources(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(resourcesSchema))
    body: { pools: { resourceType: string; capacity: number }[] },
  ) {
    const local = await this.unidade(staff);
    try {
      await saveResources({ tenantId: staff.tenantId, locationId: local.id, pools: body.pools });
      return { saved: true };
    } catch (error) {
      return toHttp(error);
    }
  }
}
