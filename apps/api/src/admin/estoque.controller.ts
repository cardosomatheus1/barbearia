import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import {
  EstoqueError,
  cmvDoPeriodo,
  fichaDoServico,
  lancarMovimento,
  margemPorServico,
  movimentosDoProduto,
  produtos,
  salvarFicha,
  salvarProduto,
} from '@barbearia/finance';
import { primaryLocation } from '@barbearia/scheduling';
import { diaNaUnidade } from '@barbearia/core';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { uuidSchema } from './caixa.schemas.js';
import { diaSchema } from './painel.schemas.js';
import { fichaSchema, movimentoSchema, produtoSchema } from './estoque.schemas.js';

/**
 * Produtos, estoque, ficha técnica e CMV (bloco 44, SPEC §3.7 e §3.8).
 *
 * ## As permissões, e por que a margem não é `inventory.view`
 *
 * - **Ver o estoque** é `inventory.view`: quantos vidros tem na prateleira não
 *   é dinheiro do caixa, e o barbeiro precisa saber se pode oferecer a pomada.
 * - **Mexer no estoque e no cadastro** é `inventory.adjust`. `perda` e `ajuste`
 *   mudam o número sem venda, e são as duas que a trilha registra.
 * - **A margem e o CMV** são `finance.view_profit`, não `inventory.view`: a
 *   decomposição mostra a comissão que cada barbeiro custa e a margem de cada
 *   serviço, que é exatamente a estratégia que `finance.view_profit` existe para
 *   separar de faturamento. Entregá-la sob a permissão de contar vidro seria o
 *   caminho mais curto para o que a SPEC §1.3 chama de não negociável.
 */

const STATUS: Record<string, number> = {
  produto_nao_encontrado: 404,
  produto_invalido: 400,
  quantidade_invalida: 400,
  sinal_invalido: 400,
  saldo_insuficiente: 409,
  motivo_obrigatorio: 400,
  servico_nao_encontrado: 404,
};

function toHttp(erro: unknown): never {
  if (erro instanceof EstoqueError) {
    throw new DomainError(erro.code, STATUS[erro.code] ?? 400, erro.message);
  }
  throw erro;
}

@Controller('v1/admin/estoque')
@UseGuards(StaffGuard, PermissaoGuard)
export class EstoqueController {
  private async hoje(tenantId: string): Promise<string> {
    const local = await primaryLocation(tenantId);
    if (!local) throw new DomainError('unknown_location', 404, 'Unidade não encontrada.');
    // O dia da unidade, nunca o do aparelho: às 22h de Salvador o UTC já virou,
    // e a baixa cairia no dia seguinte do relatório.
    return diaNaUnidade(null, local.timezone, new Date()).dia;
  }

  @Exige('inventory.view')
  @Get('produtos')
  async lista(@Staff() staff: AuthenticatedStaff, @Query('todos') todos?: string) {
    return { produtos: await produtos(staff.tenantId, todos === 'true') };
  }

  @Exige('inventory.adjust')
  @Put('produtos')
  async criar(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(produtoSchema))
    body: {
      nome: string;
      tipo: 'resale' | 'internal';
      sku?: string | null;
      barcode?: string | null;
      categoria?: string | null;
      fornecedor?: string | null;
      custoCents: number;
      precoCents: number | null;
      minimo: number;
      unidade: string;
      venceEm?: string | null;
      ativo: boolean;
    },
  ) {
    try {
      return await salvarProduto({
        tenantId: staff.tenantId,
        ...body,
        ator: { id: staff.staffUserId, name: staff.name },
      });
    } catch (erro) {
      return toHttp(erro);
    }
  }

  @Exige('inventory.adjust')
  @Put('produtos/:id')
  async editar(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(produtoSchema))
    body: {
      nome: string;
      tipo: 'resale' | 'internal';
      sku?: string | null;
      barcode?: string | null;
      categoria?: string | null;
      fornecedor?: string | null;
      custoCents: number;
      precoCents: number | null;
      minimo: number;
      unidade: string;
      venceEm?: string | null;
      ativo: boolean;
    },
  ) {
    try {
      return await salvarProduto({
        tenantId: staff.tenantId,
        id,
        ...body,
        ator: { id: staff.staffUserId, name: staff.name },
      });
    } catch (erro) {
      return toHttp(erro);
    }
  }

  @Exige('inventory.view')
  @Get('produtos/:id/movimentos')
  async historico(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    return { movimentos: await movimentosDoProduto(staff.tenantId, id) };
  }

  @Exige('inventory.adjust')
  @Post('movimentos')
  async mover(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(movimentoSchema))
    body: {
      produtoId: string;
      tipo: 'entrada' | 'saida' | 'perda' | 'ajuste' | 'transferencia';
      quantidade: number;
      motivo?: string;
    },
  ) {
    try {
      return await lancarMovimento({
        tenantId: staff.tenantId,
        produtoId: body.produtoId,
        tipo: body.tipo,
        quantidade: body.quantidade,
        diaDaUnidade: await this.hoje(staff.tenantId),
        ...(body.motivo ? { motivo: body.motivo } : {}),
        ator: { id: staff.staffUserId, name: staff.name },
      });
    } catch (erro) {
      return toHttp(erro);
    }
  }

  @Exige('inventory.view')
  @Get('ficha/:serviceId')
  async ficha(
    @Staff() staff: AuthenticatedStaff,
    @Param('serviceId', new ZodValidationPipe(uuidSchema)) serviceId: string,
  ) {
    return { itens: await fichaDoServico(staff.tenantId, serviceId) };
  }

  /**
   * `settings.manage` **e** `inventory.adjust`.
   *
   * A ficha técnica é cadastro de serviço e é decisão de custo ao mesmo tempo:
   * quem a edita muda o que baixa do estoque em todo atendimento daquele
   * serviço, para sempre. Rota que agrega declara todas as permissões do que faz.
   */
  @Exige('settings.manage', 'inventory.adjust')
  @Put('ficha/:serviceId')
  async salvarAFicha(
    @Staff() staff: AuthenticatedStaff,
    @Param('serviceId', new ZodValidationPipe(uuidSchema)) serviceId: string,
    @Body(new ZodValidationPipe(fichaSchema))
    body: { itens: { produtoId: string; quantidade: number }[] },
  ) {
    try {
      return await salvarFicha({
        tenantId: staff.tenantId,
        serviceId,
        itens: body.itens,
        ator: { id: staff.staffUserId, name: staff.name },
      });
    } catch (erro) {
      return toHttp(erro);
    }
  }

  /**
   * A margem por serviço e o CMV do período (SPEC §3.8).
   *
   * `finance.view_profit` é a permissão da margem — a SPEC §1.3 separa
   * faturamento de lucro de propósito, e este relatório é o segundo.
   */
  @Exige('finance.view_profit')
  @Get('margem')
  async margem(
    @Staff() staff: AuthenticatedStaff,
    @Query(new ZodValidationPipe(diaSchema)) query: { dia?: string },
  ) {
    const hoje = query.dia ?? (await this.hoje(staff.tenantId));
    // Do primeiro dia do mês até o dia pedido: é a leitura que decide preço, e
    // um dia sozinho não diz nada sobre rentabilidade.
    const de = `${hoje.slice(0, 7)}-01`;
    return {
      de,
      ate: hoje,
      servicos: await margemPorServico(staff.tenantId, de, hoje),
      cmv: await cmvDoPeriodo(staff.tenantId, de, hoje),
    };
  }
}
