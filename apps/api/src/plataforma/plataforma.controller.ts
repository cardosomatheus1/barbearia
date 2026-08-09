import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  bloquearBarbearia,
  desbloquearBarbearia,
  entrarNaPlataforma,
  listarBarbearias,
  listarPlanos,
  PlataformaError,
  sairDaPlataforma,
  trilhaDaPlataforma,
  trocarPlano,
  type AdminDaPlataforma,
} from '@barbearia/platform';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { TenantService } from '../tenant/tenant.service.js';
import { Admin, PlataformaGuard, type RequisicaoDaPlataforma } from './plataforma.guard.js';
import {
  bloqueioSchema,
  loginDaPlataformaSchema,
  tenantIdSchema,
  trilhaQuerySchema,
  trocaDePlanoSchema,
  type Bloqueio,
  type TrilhaQuery,
  type TrocaDePlano,
} from './plataforma.schemas.js';

const STATUS: Record<string, number> = {
  invalid_credentials: 401,
  unknown_plan: 404,
  unknown_tenant: 404,
  inactive_plan: 409,
  not_blockable: 409,
  not_blocked: 409,
  reason_required: 400,
  email_taken: 409,
  weak_password: 400,
};

function paraHttp(erro: unknown): never {
  if (erro instanceof PlataformaError) {
    throw new DomainError(erro.code, STATUS[erro.code] ?? 400, erro.message);
  }
  throw erro;
}

/** A porta — sem sessão, por definição. */
@Controller('v1/plataforma')
export class PlataformaAuthController {
  @Post('login')
  async login(@Body(new ZodValidationPipe(loginDaPlataformaSchema)) corpo: { email: string; senha: string }) {
    try {
      const sessao = await entrarNaPlataforma(corpo);
      return {
        token: sessao.token,
        admin: sessao.admin,
        expiraEm: sessao.expiraEm.toISOString(),
      };
    } catch (erro) {
      return paraHttp(erro);
    }
  }
}

/**
 * O painel da plataforma — **sessão de Super Admin obrigatória**.
 *
 * Nenhuma rota daqui lê agendamento, cliente, comanda ou caixa. O que este
 * controller alcança é o conjunto de tabelas da migração 0026, e é por isso que
 * ele pode ver todas as barbearias sem que nenhuma política de negócio tenha
 * sido afrouxada.
 */
@Controller('v1/plataforma')
@UseGuards(PlataformaGuard)
export class PlataformaController {
  constructor(@Inject(TenantService) private readonly tenants: TenantService) {}

  @Post('logout')
  async logout(@Req() requisicao: RequisicaoDaPlataforma) {
    // O token vem do cabeçalho, nunca do corpo: aceitá-lo do corpo deixaria
    // um admin derrubar a sessão de outro se algum dia vazasse um token.
    const token = /^Bearer (.+)$/.exec(requisicao.headers.authorization ?? '')?.[1];
    if (token) await sairDaPlataforma(token);
    return { revoked: true };
  }

  @Get('planos')
  async planos() {
    return { planos: await listarPlanos(true) };
  }

  @Get('barbearias')
  async barbearias() {
    const barbearias = await listarBarbearias();
    return {
      barbearias: barbearias.map((b) => ({
        ...b,
        bloqueadaEm: b.bloqueadaEm?.toISOString() ?? null,
        criadaEm: b.criadaEm.toISOString(),
      })),
    };
  }

  @Put('barbearias/:tenantId/plano')
  async plano(
    @Param('tenantId', new ZodValidationPipe(tenantIdSchema)) tenantId: string,
    @Body(new ZodValidationPipe(trocaDePlanoSchema)) corpo: TrocaDePlano,
    @Admin() admin: AdminDaPlataforma,
  ) {
    try {
      await trocarPlano({ adminId: admin.id, tenantId, planoCode: corpo.planoCode });
      return { ok: true };
    } catch (erro) {
      return paraHttp(erro);
    }
  }

  @Post('barbearias/:tenantId/bloqueio')
  async bloquear(
    @Param('tenantId', new ZodValidationPipe(tenantIdSchema)) tenantId: string,
    @Body(new ZodValidationPipe(bloqueioSchema)) corpo: Bloqueio,
    @Admin() admin: AdminDaPlataforma,
  ) {
    try {
      await bloquearBarbearia({ adminId: admin.id, tenantId, motivo: corpo.motivo });
      // Sem isto o bloqueio só valeria depois do TTL: a barbearia continuaria
      // atendendo por meio minuto depois de o painel dizer que ela parou.
      this.tenants.esquecerBloqueio(tenantId);
      return { ok: true };
    } catch (erro) {
      return paraHttp(erro);
    }
  }

  @Delete('barbearias/:tenantId/bloqueio')
  async desbloquear(
    @Param('tenantId', new ZodValidationPipe(tenantIdSchema)) tenantId: string,
    @Admin() admin: AdminDaPlataforma,
  ) {
    try {
      await desbloquearBarbearia({ adminId: admin.id, tenantId });
      this.tenants.esquecerBloqueio(tenantId);
      return { ok: true };
    } catch (erro) {
      return paraHttp(erro);
    }
  }

  @Get('trilha')
  async trilha(@Query(new ZodValidationPipe(trilhaQuerySchema)) query: TrilhaQuery) {
    const eventos = await trilhaDaPlataforma(query.limite);
    return { eventos: eventos.map((e) => ({ ...e, quando: e.quando.toISOString() })) };
  }
}
