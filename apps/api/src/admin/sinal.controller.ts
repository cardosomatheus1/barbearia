import { Body, Controller, Delete, Get, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import {
  SinalError,
  devolverSinal,
  registrarSinalRecebido,
  sinalDoAgendamento,
} from '@barbearia/finance';
import { ConfiancaError, definirConfianca } from '@barbearia/crm';
import { confiancaDoCliente } from '@barbearia/scheduling';
import { withTenant } from '@barbearia/db';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { uuidSchema } from './caixa.schemas.js';
import { unidadeDoBalcao } from './unidade.js';
import { confiancaSchema, sinalRecebidoSchema } from './sinal.schemas.js';

/**
 * O sinal do agendamento e o score do cliente (bloco 37).
 *
 * ## As permissões, e por que são duas e não uma
 *
 * - **Registrar e devolver o sinal** é `finance.deposit`. É dinheiro que entra
 *   e sai fora da comanda, e cai no grupo que a `PermissaoGuard` cobra com
 *   segundo fator — quem digita "recebi R$ 20" sobre um Pix que só ele viu é
 *   exatamente quem o segundo fator existe para proteger.
 * - **Mexer no score** é `customers.reliability_override`. Não é
 *   `customers.edit`, que toda a recepção tem: com ela, dispensar um conhecido
 *   do sinal seria uma edição de cadastro qualquer, sem passar por dinheiro e
 *   portanto sem segundo fator.
 *
 * **Ler o score é `finance.deposit` também**, e não uma permissão de leitura de
 * cliente. O número decide se a pessoa paga adiantado; quem o vê consegue
 * responder "por que estão me cobrando" — e a SPEC §2.13 regra 5 é explícita em
 * que ele nunca chega ao cliente.
 */

const STATUS: Record<string, number> = {
  agendamento_nao_encontrado: 404,
  cliente_nao_encontrado: 404,
  sem_sinal_exigido: 409,
  sinal_ja_registrado: 409,
  sinal_nao_registrado: 409,
  valor_diferente_do_exigido: 400,
  score_invalido: 400,
  motivo_curto: 400,
};

function toHttp(erro: unknown): never {
  if (erro instanceof SinalError || erro instanceof ConfiancaError) {
    throw new DomainError(erro.code, STATUS[erro.code] ?? 400, erro.message);
  }
  throw erro;
}

/** O que a trilha grava sobre de onde a ação partiu. */
function origem(req: Request): { ip?: string; userAgent?: string } {
  const ip = req.ip;
  const agent = req.get('user-agent');
  return { ...(ip ? { ip } : {}), ...(agent ? { userAgent: agent } : {}) };
}

@Controller('v1/admin')
@UseGuards(StaffGuard, PermissaoGuard)
export class SinalController {
  @Exige('finance.deposit')
  @Get('appointments/:id/deposit')
  async ler(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    const local = await unidadeDoBalcao(staff);
    try {
      return await sinalDoAgendamento(staff.tenantId, local.id, id);
    } catch (erro) {
      return toHttp(erro);
    }
  }

  @Exige('finance.deposit')
  @Post('appointments/:id/deposit')
  async registrar(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(sinalRecebidoSchema)) body: { valorCents: number },
    @Req() req: Request,
  ) {
    const local = await unidadeDoBalcao(staff);
    try {
      return await registrarSinalRecebido({
        tenantId: staff.tenantId,
        locationId: local.id,
        appointmentId: id,
        valorCents: body.valorCents,
        staffId: staff.staffUserId,
        staffName: staff.name,
        ...origem(req),
      });
    } catch (erro) {
      return toHttp(erro);
    }
  }

  @Exige('finance.deposit')
  @Delete('appointments/:id/deposit')
  async devolver(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Req() req: Request,
  ) {
    const local = await unidadeDoBalcao(staff);
    try {
      return await devolverSinal({
        tenantId: staff.tenantId,
        locationId: local.id,
        appointmentId: id,
        // A devolução é do valor que está registrado; o domínio o lê e zera.
        valorCents: 0,
        staffId: staff.staffUserId,
        staffName: staff.name,
        ...origem(req),
      });
    } catch (erro) {
      return toHttp(erro);
    }
  }

  @Exige('finance.deposit')
  @Get('customers/:id/reliability')
  async score(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    const agora = new Date();
    return withTenant(staff.tenantId, (tx) => confiancaDoCliente(tx, id, agora));
  }

  @Exige('customers.reliability_override')
  @Put('customers/:id/reliability')
  async ajustar(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(confiancaSchema))
    body: { score: number | null; motivo: string },
    @Req() req: Request,
  ) {
    try {
      return await definirConfianca({
        tenantId: staff.tenantId,
        customerId: id,
        score: body.score,
        motivo: body.motivo,
        staffId: staff.staffUserId,
        staffName: staff.name,
        ...origem(req),
      });
    } catch (erro) {
      return toHttp(erro);
    }
  }
}
