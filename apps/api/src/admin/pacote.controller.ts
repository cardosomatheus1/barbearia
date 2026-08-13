import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import {
  PacoteError,
  catalogoDePacotes,
  pacotesDoCliente,
  receitaDePacotes,
  reembolsarPacote,
  salvarPacoteDoCatalogo,
} from '@barbearia/finance';
import { diaNaUnidade } from '@barbearia/core';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { uuidSchema } from './caixa.schemas.js';
import { diaSchema } from './painel.schemas.js';
import { pacoteDoCatalogoSchema } from './pacote.schemas.js';
import { unidadeDoBalcao } from './unidade.js';

/**
 * Pacotes: catálogo, pacotes do cliente, reembolso e receita diferida
 * (bloco 42, SPEC §4.7).
 *
 * ## Quatro permissões, e cada uma diz outra coisa
 *
 * - **Editar o catálogo** é `settings.manage`: decidir que a casa vende "5
 *   cortes por R$ 250" é decisão de negócio e não move centavo de ninguém.
 * - **Ver o catálogo** é `appointments.view`: quem monta a comanda precisa saber
 *   o que pode vender, e o preço de tabela não revela dinheiro de cliente algum.
 * - **Ver os pacotes de um cliente** é `customers.view` + `finance.view`. O
 *   primeiro porque é a ficha de uma pessoa; o segundo porque a resposta traz o
 *   valor pago e o valor da unidade — e rota que agrega declara **todas** as
 *   permissões do que devolve.
 * - **Reembolsar** é `finance.package_refund`, que cai no grupo de dinheiro pelo
 *   prefixo e por isso vem com segundo fator derivado. O valor sai como crédito
 *   no razão, gastável no balcão da operação seguinte.
 */

const STATUS: Record<string, number> = {
  pacote_nao_encontrado: 404,
  catalogo_nao_encontrado: 404,
  sem_cliente: 400,
  sem_saldo: 409,
  ja_reembolsado: 409,
  nada_a_devolver: 409,
  pacote_invalido: 400,
};

function toHttp(erro: unknown): never {
  if (erro instanceof PacoteError) {
    throw new DomainError(erro.code, STATUS[erro.code] ?? 400, erro.message);
  }
  throw erro;
}

@Controller('v1/admin/pacotes')
@UseGuards(StaffGuard, PermissaoGuard)
export class PacoteController {
  @Exige('appointments.view')
  @Get('catalogo')
  async catalogo(@Staff() staff: AuthenticatedStaff, @Query('todos') todos?: string) {
    return { pacotes: await catalogoDePacotes(staff.tenantId, todos === 'true') };
  }

  @Exige('settings.manage')
  @Put('catalogo')
  async criar(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(pacoteDoCatalogoSchema)) body: {
      nome: string;
      serviceId: string;
      quantidade: number;
      precoCents: number;
      validadeDias: number | null;
      transferivel: boolean;
      ativo: boolean;
    },
  ) {
    try {
      return await salvarPacoteDoCatalogo({
        tenantId: staff.tenantId,
        ...body,
        ator: { id: staff.staffUserId, name: staff.name },
      });
    } catch (erro) {
      return toHttp(erro);
    }
  }

  @Exige('settings.manage')
  @Put('catalogo/:id')
  async editar(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(pacoteDoCatalogoSchema)) body: {
      nome: string;
      serviceId: string;
      quantidade: number;
      precoCents: number;
      validadeDias: number | null;
      transferivel: boolean;
      ativo: boolean;
    },
  ) {
    try {
      return await salvarPacoteDoCatalogo({
        tenantId: staff.tenantId,
        id,
        ...body,
        ator: { id: staff.staffUserId, name: staff.name },
      });
    } catch (erro) {
      return toHttp(erro);
    }
  }

  @Exige('customers.view', 'finance.view')
  @Get('clientes/:id')
  async doCliente(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    return { pacotes: await pacotesDoCliente(staff.tenantId, id) };
  }

  /**
   * O reembolso proporcional.
   *
   * `finance.package_refund` e não `settings.manage`: quem cadastra o pacote não
   * é necessariamente quem pode devolver dinheiro por ele, e o segundo fator
   * derivado do prefixo `finance.` é justamente o que protege essa devolução.
   */
  @Exige('finance.package_refund')
  @Post('clientes/pacotes/:id/reembolsar')
  async reembolsar(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    // A loja do balcão: um crédito sem loja é somado ao bolso de cada unidade
    // (bloco 59).
    const local = await unidadeDoBalcao(staff);
    try {
      return await reembolsarPacote({
        tenantId: staff.tenantId,
        customerPackageId: id,
        locationId: local.id,
        ator: { id: staff.staffUserId, name: staff.name },
      });
    } catch (erro) {
      return toHttp(erro);
    }
  }

  /**
   * Vendido, reconhecido e diferido do dia.
   *
   * `finance.view` porque são centavos, e é o número que a SPEC §4.7 existe para
   * dar: sem ele o DRE mostra um mês excelente seguido de meses falsamente
   * ruins.
   *
   * O dia sem parâmetro é o **da unidade**, resolvido no servidor. Vindo do
   * aparelho, quem abrisse às 21h de sábado em outro fuso leria a receita de
   * domingo — que é o defeito D2 aplicado ao número do DRE.
   */
  @Exige('finance.view')
  @Get('receita')
  async receita(
    @Staff() staff: AuthenticatedStaff,
    @Query(new ZodValidationPipe(diaSchema)) query: { dia?: string },
  ) {
    const local = await unidadeDoBalcao(staff);
    const dia = query.dia ?? diaNaUnidade(null, local.timezone, new Date()).dia;
    return { dia, ...(await receitaDePacotes(staff.tenantId, dia)) };
  }
}
