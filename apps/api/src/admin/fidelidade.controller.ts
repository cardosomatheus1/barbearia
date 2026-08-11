import { Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import {
  FidelidadeError,
  ajustarSaldo,
  programa,
  saldoDoCliente,
  salvarPrograma,
} from '@barbearia/finance';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { uuidSchema } from './caixa.schemas.js';
import { ajusteDeSaldoSchema, programaSchema } from './fidelidade.schemas.js';

/**
 * O programa de fidelidade e o saldo do cliente (bloco 41, SPEC §4.8).
 *
 * ## Três permissões, e cada uma diz outra coisa
 *
 * - **Escolher o modelo** é `settings.manage`: é decisão de negócio, e não move
 *   saldo de ninguém.
 * - **Ver o saldo de um cliente** é `customers.view` + `finance.view`. O
 *   primeiro porque é a ficha de uma pessoa; o segundo porque saldo é dinheiro,
 *   e uma rota que agrega declara **todas** as permissões do que devolve.
 * - **Mexer no saldo à mão** é `finance.loyalty_adjust`, que cai no grupo de
 *   dinheiro pelo prefixo e por isso vem com segundo fator derivado. Criar saldo
 *   é criar valor gastável no balcão da operação seguinte — é a rota que mais se
 *   parece com "imprimir dinheiro" no produto inteiro.
 */

const STATUS: Record<string, number> = {
  sem_programa: 409,
  sem_cliente: 400,
  saldo_insuficiente: 409,
  nada_a_pagar: 409,
  quantidade_invalida: 400,
  premio_incompleto: 409,
  motivo_curto: 400,
  programa_invalido: 400,
};

function toHttp(erro: unknown): never {
  if (erro instanceof FidelidadeError) {
    throw new DomainError(erro.code, STATUS[erro.code] ?? 400, erro.message);
  }
  throw erro;
}

@Controller('v1/admin/fidelidade')
@UseGuards(StaffGuard, PermissaoGuard)
export class FidelidadeController {
  /**
   * O programa, para a tela de configuração e para o balcão.
   *
   * `appointments.view` e não uma permissão de dinheiro: quem monta a comanda
   * precisa saber se existe programa e qual é a unidade do saldo, e isso não
   * revela centavo de ninguém.
   */
  @Exige('appointments.view')
  @Get('programa')
  async ler(@Staff() staff: AuthenticatedStaff) {
    return programa(staff.tenantId);
  }

  @Exige('settings.manage')
  @Put('programa')
  async salvar(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(programaSchema)) body: Record<string, never>,
  ) {
    try {
      return await salvarPrograma({
        tenantId: staff.tenantId,
        programa: body as never,
        ator: { id: staff.staffUserId, name: staff.name },
      });
    } catch (erro) {
      return toHttp(erro);
    }
  }

  @Exige('customers.view', 'finance.view')
  @Get('clientes/:id')
  async saldo(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    return saldoDoCliente(staff.tenantId, id);
  }

  @Exige('finance.loyalty_adjust')
  @Post('clientes/:id/ajuste')
  async ajustar(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(ajusteDeSaldoSchema))
    body: { quantidade: number; motivo: string },
  ) {
    try {
      return await ajustarSaldo({
        tenantId: staff.tenantId,
        customerId: id,
        quantidade: body.quantidade,
        motivo: body.motivo,
        ator: { id: staff.staffUserId, name: staff.name },
      });
    } catch (erro) {
      return toHttp(erro);
    }
  }
}
