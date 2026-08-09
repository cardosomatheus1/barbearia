import { Body, Controller, Get, Inject, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import {
  changeOwnPassword,
  changeStaffRole,
  convidarProfissional,
  createStaffUser,
  listStaff,
  definirPermissoesDoPapel,
  permissionsByRole,
  resetStaffPassword,
  setStaffActive,
  StaffError,
  type AuthenticatedStaff,
  type MessagingProvider,
} from '@barbearia/identity';
import type { Papel } from '@barbearia/core';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { MESSAGING_PROVIDER } from '../auth/messaging.token.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import {
  activeSchema,
  changePasswordSchema,
  createStaffSchema,
  papelEditavelSchema,
  permissoesDoPapelSchema,
  roleSchema,
  staffIdSchema,
} from './team.schemas.js';
import { conviteSchema } from './ficha.schemas.js';

const STATUS: Record<string, number> = {
  email_taken: 409,
  // Colisão com outra barbearia. Mesmo código HTTP, mensagem genérica: dizer
  // "já existe na plataforma" confirmaria que o endereço é de alguém.
  email_unavailable: 409,
  invalid_role: 400,
  unknown_permission: 400,
  // 403 e não 400: o pedido está bem formado e quem pede tem `team.manage`. O
  // que recusa é o alcance de quem pede — conceder o que não se tem.
  cannot_grant: 403,
  invalid_phone: 400,
  staff_not_found: 404,
  professional_not_found: 404,
  // 409, não 403: quem pede tem `team.manage`. O que recusa é o estado da
  // cadeira, que já tem dono.
  professional_already_invited: 409,
  // 409, não 403: quem pede tem `team.manage`. O que recusa é a regra de que o
  // dono não se tranca para fora da própria barbearia.
  owner_protected: 409,
  weak_password: 400,
  invalid_credentials: 401,
};

function toHttp(error: unknown): never {
  if (error instanceof StaffError) {
    throw new DomainError(error.code, STATUS[error.code] ?? 400, error.message);
  }
  throw error;
}

const contexto = (request: Request) => ({
  ...(request.ip ? { ip: request.ip } : {}),
  ...(request.headers['user-agent'] ? { userAgent: request.headers['user-agent'] } : {}),
});

/**
 * Equipe — exige `team.manage`.
 *
 * Até o bloco 11 só existia a conta do dono, e quem operava o balcão usava ela.
 * Estas rotas são por onde a recepcionista passa a ter conta própria — com o
 * acesso que ela precisa e nada além.
 *
 * Tudo aqui é auditado dentro da transação que muda o estado. Alteração de
 * permissão é evento de registro obrigatório (SPEC Parte 1 §1.7), e a trilha é
 * append-only no banco: `UPDATE` e `DELETE` foram revogados do role da
 * aplicação, então nem esta API consegue reescrever o que gravou.
 */
@Controller('v1/admin/team')
@UseGuards(StaffGuard, PermissaoGuard)
export class TeamController {
  constructor(
    @Inject(MESSAGING_PROVIDER) private readonly messaging: MessagingProvider,
  ) {}

  @Exige('team.manage')
  @Get()
  async list(@Staff() staff: AuthenticatedStaff) {
    return {
      members: await listStaff(staff.tenantId),
      // A tela mostra o que cada papel pode a partir **desta** resposta, nunca
      // de uma cópia da lista no front: permissão exibida sai da mesma fonte
      // que a API aplica (CLAUDE.md).
      permissionsByRole: await permissionsByRole(staff.tenantId),
    };
  }

  /**
   * Redefine o que um papel pode (bloco 30).
   *
   * `team.manage`, que hoje só o dono tem — e é a permissão certa: quem edita
   * papel decide o que todo mundo alcança, o que é mais poder do que qualquer
   * permissão isolada da lista.
   *
   * A tela manda o conjunto inteiro, não um diff. Diff exigiria que cliente e
   * servidor concordassem sobre o estado anterior, e duas abas abertas
   * produziriam uma concessão que ninguém pediu.
   */
  @Exige('team.manage')
  @Put('permissoes/:papel')
  async permissoes(
    @Staff() staff: AuthenticatedStaff,
    @Param('papel', new ZodValidationPipe(papelEditavelSchema)) papel: string,
    @Body(new ZodValidationPipe(permissoesDoPapelSchema)) body: { permissoes: string[] },
    @Req() request: Request,
  ) {
    try {
      const permissoes = await definirPermissoesDoPapel({
        tenantId: staff.tenantId,
        papel: papel as Papel,
        permissoes: body.permissoes,
        actor: { id: staff.staffUserId, name: staff.name },
        ...contexto(request),
      });
      return { permissoes };
    } catch (error) {
      return toHttp(error);
    }
  }

  /**
   * Cria a conta, manda a senha de primeiro acesso e a devolve **uma vez**.
   *
   * As duas coisas: a mensagem é a entrega normal, e a senha na resposta é o
   * caminho de quando o provedor está fora do ar ou a pessoa não tem celular
   * cadastrado. `entrega` diz qual dos dois aconteceu, para a tela não afirmar
   * que mandou quando não mandou.
   */
  @Exige('team.manage')
  @Post()
  async create(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(createStaffSchema))
    body: { name: string; email: string; role: Papel; phone?: string; professionalId?: string },
    @Req() request: Request,
  ) {
    try {
      const criado = await createStaffUser({
        tenantId: staff.tenantId,
        actor: { id: staff.staffUserId, name: staff.name },
        name: body.name,
        email: body.email,
        role: body.role,
        ...(body.phone ? { phone: body.phone } : {}),
        ...(body.professionalId ? { professionalId: body.professionalId } : {}),
        messaging: this.messaging,
        ...contexto(request),
      });
      return criado;
    } catch (error) {
      return toHttp(error);
    }
  }

  @Exige('team.manage')
  @Put(':id/role')
  async role(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(staffIdSchema)) id: string,
    @Body(new ZodValidationPipe(roleSchema)) body: { role: Papel },
    @Req() request: Request,
  ) {
    try {
      await changeStaffRole({
        tenantId: staff.tenantId,
        actor: { id: staff.staffUserId, name: staff.name },
        staffUserId: id,
        role: body.role,
        ...contexto(request),
      });
      return { changed: true };
    } catch (error) {
      return toHttp(error);
    }
  }

  /** Desligar revoga as sessões abertas na mesma transação. */
  @Exige('team.manage')
  @Put(':id/active')
  async active(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(staffIdSchema)) id: string,
    @Body(new ZodValidationPipe(activeSchema)) body: { active: boolean },
    @Req() request: Request,
  ) {
    try {
      await setStaffActive({
        tenantId: staff.tenantId,
        actor: { id: staff.staffUserId, name: staff.name },
        staffUserId: id,
        active: body.active,
        ...contexto(request),
      });
      return { active: body.active };
    } catch (error) {
      return toHttp(error);
    }
  }

  @Exige('team.manage')
  @Post(':id/reset-password')
  async reset(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(staffIdSchema)) id: string,
    @Req() request: Request,
  ) {
    try {
      return await resetStaffPassword({
        tenantId: staff.tenantId,
        actor: { id: staff.staffUserId, name: staff.name },
        staffUserId: id,
        messaging: this.messaging,
        ...contexto(request),
      });
    } catch (error) {
      return toHttp(error);
    }
  }

  /**
   * Convida o barbeiro — lacuna aberta no bloco 12.
   *
   * `team.manage`, e não `settings.manage`: isto **cria uma conta**, e não é
   * porque o caminho da tela sai do cadastro de profissionais que a permissão
   * muda. O papel é sempre `professional` e não entra pelo corpo — aceitar o
   * papel aqui transformaria "convidar o Ruan" numa forma silenciosa de criar
   * um gerente, fora da tela que exige `team.manage` justamente para isso.
   */
  @Exige('team.manage')
  @Post('invite')
  async invite(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(conviteSchema))
    body: { professionalId: string; email: string; phone?: string },
    @Req() request: Request,
  ) {
    try {
      return await convidarProfissional({
        tenantId: staff.tenantId,
        actor: { id: staff.staffUserId, name: staff.name },
        professionalId: body.professionalId,
        email: body.email,
        ...(body.phone ? { phone: body.phone } : {}),
        messaging: this.messaging,
        ...contexto(request),
      });
    } catch (error) {
      return toHttp(error);
    }
  }
}

/**
 * A própria senha — **sem exigir permissão nenhuma**.
 *
 * `@Exige()` vazio é a única fuga da guarda, e é deliberada: a conta recém-
 * criada está bloqueada em todo o resto até trocar a senha de primeiro acesso,
 * então a rota que a destranca não pode depender de permissão. Ela ainda exige
 * a senha atual, que é o que impede alguém no navegador aberto de outra pessoa
 * de ficar com a conta.
 */
@Controller('v1/admin/me')
@UseGuards(StaffGuard, PermissaoGuard)
export class MeController {
  @Exige()
  @Get()
  me(@Staff() staff: AuthenticatedStaff) {
    return {
      name: staff.name,
      role: staff.role,
      permissions: staff.permissions,
      mustChangePassword: staff.mustChangePassword,
    };
  }

  @Exige()
  @Put('password')
  async password(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(changePasswordSchema))
    body: { currentPassword: string; newPassword: string },
  ) {
    try {
      await changeOwnPassword({
        tenantId: staff.tenantId,
        staffUserId: staff.staffUserId,
        sessionId: staff.sessionId,
        currentPassword: body.currentPassword,
        newPassword: body.newPassword,
      });
      return { changed: true };
    } catch (error) {
      return toHttp(error);
    }
  }
}
