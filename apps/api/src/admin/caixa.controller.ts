import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  abrirCaixa,
  abrirComanda,
  adicionarItem,
  ajustarComanda,
  caixaAberto,
  CaixaError,
  ComandaError,
  faturamentoDoDia,
  fecharCaixaDaUnidade,
  fecharComanda,
  getComanda,
  historicoDeCaixa,
  movimentarCaixa,
  quemEstaDevendo,
  receberFiado,
  removerItem,
} from '@barbearia/finance';
import { primaryLocation } from '@barbearia/scheduling';
import { diaNaUnidade, type DescontoDaComanda, type Pagamento, type TipoDeItem } from '@barbearia/core';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { badRequest, DomainError, notFound } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import {
  abrirCaixaSchema,
  abrirComandaSchema,
  ajusteSchema,
  diaSchema,
  fecharCaixaSchema,
  fecharComandaSchema,
  itemSchema,
  movimentoSchema,
  receberFiadoSchema,
  uuidSchema,
} from './caixa.schemas.js';

const STATUS: Record<string, number> = {
  comanda_nao_encontrada: 404,
  cliente_nao_encontrado: 404,
  sessao_nao_encontrada: 404,
  servico_desconhecido: 404,
  // 409 e não 403: quem pede tem permissão; o que mudou foi o estado da gaveta.
  ja_aberto: 409,
  nenhum_aberto: 409,
  caixa_fechado: 409,
  comanda_fechada: 409,
};

function toHttp(error: unknown): never {
  if (error instanceof CaixaError || error instanceof ComandaError) {
    throw new DomainError(error.code, STATUS[error.code] ?? 400, error.message);
  }
  throw error;
}

/**
 * O balcão: comanda, checkout e caixa.
 *
 * Três decisões valem para a classe inteira:
 *
 * 1. **Toda rota daqui exige uma permissão de dinheiro**, e é isso que aciona o
 *    segundo fator na `PermissaoGuard`. Não há decorador separado a esquecer: a
 *    permissão declarada é que cobra o código.
 *
 *    A escolha entre `cashier.open` e `finance.view` não é estética. Operar o
 *    balcão — abrir comanda, lançar item, receber — é `cashier.open`, que a
 *    recepcionista tem por padrão. **Ver dinheiro que não é a venda da frente**
 *    — o faturamento do dia, o desconto — é `finance.view`, que ela não tem.
 *
 *    A primeira versão pôs tudo sob `finance.view`, e o efeito era o oposto do
 *    pretendido: a recepcionista conseguia abrir o caixa e não conseguia
 *    registrar uma única venda. Permissão de leitura autorizando escrita é o
 *    defeito; que ela também quebrasse o balcão foi só o sintoma visível.
 *
 * 2. **Nenhuma rota aceita `locationId`.** A unidade vem do tenant do token,
 *    como no painel do dia. Aceitá-lo do corpo deixaria o balcão de uma unidade
 *    fechar comanda na gaveta de outra.
 *
 * 3. **O que move dinheiro é auditado dentro da transação de quem move.**
 *    Divergência de caixa sem dono é a coisa que este módulo inteiro existe
 *    para evitar.
 */
@Controller('v1/admin')
@UseGuards(StaffGuard, PermissaoGuard)
export class CaixaController {
  private async unidade(tenantId: string) {
    const local = await primaryLocation(tenantId);
    if (!local) throw notFound('unknown_location', 'Unidade não encontrada');
    return local;
  }

  // -- Caixa ------------------------------------------------------------------

  @Exige('cashier.open')
  @Get('cash')
  async caixa(@Staff() staff: AuthenticatedStaff) {
    const local = await this.unidade(staff.tenantId);
    return {
      // O fuso vai junto: a hora de cada movimento é da barbearia, não do
      // aparelho de quem abriu a tela (defeito D2).
      timezone: local.timezone,
      aberto: await caixaAberto(staff.tenantId, local.id),
      historico: await historicoDeCaixa({ tenantId: staff.tenantId, locationId: local.id }),
    };
  }

  @Exige('cashier.open')
  @Post('cash/open')
  async abrir(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(abrirCaixaSchema)) body: { openingCents: number },
  ) {
    const local = await this.unidade(staff.tenantId);
    try {
      return await abrirCaixa({
        tenantId: staff.tenantId,
        locationId: local.id,
        staffId: staff.staffUserId,
        staffName: staff.name,
        openingCents: body.openingCents,
      });
    } catch (error) {
      return toHttp(error);
    }
  }

  @Exige('cashier.withdraw')
  @Post('cash/movements')
  async movimentar(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(movimentoSchema))
    body: { kind: 'withdrawal' | 'supply'; amountCents: number; reason: string },
  ) {
    const local = await this.unidade(staff.tenantId);
    try {
      await movimentarCaixa({
        tenantId: staff.tenantId,
        locationId: local.id,
        staffId: staff.staffUserId,
        staffName: staff.name,
        kind: body.kind,
        amountCents: body.amountCents,
        reason: body.reason,
      });
      return { ok: true };
    } catch (error) {
      return toHttp(error);
    }
  }

  /**
   * Fecha o caixa com o que o operador contou.
   *
   * O contado vai no corpo e o esperado só volta na resposta: é o fechamento
   * cego da SPEC §3.10, e ele só é cego se a tela não souber o número antes.
   */
  @Exige('cashier.close')
  @Post('cash/close')
  async fechar(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(fecharCaixaSchema)) body: { countedCents: number; notes?: string },
  ) {
    const local = await this.unidade(staff.tenantId);
    try {
      return await fecharCaixaDaUnidade({
        tenantId: staff.tenantId,
        locationId: local.id,
        staffId: staff.staffUserId,
        staffName: staff.name,
        countedCents: body.countedCents,
        notes: body.notes ?? null,
      });
    } catch (error) {
      return toHttp(error);
    }
  }

  // -- Comanda ----------------------------------------------------------------

  @Exige('cashier.open')
  @Get('orders/:id')
  async comanda(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    try {
      return await getComanda(staff.tenantId, id);
    } catch (error) {
      return toHttp(error);
    }
  }

  @Exige('cashier.open')
  @Post('orders')
  async abrirComandaNova(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(abrirComandaSchema))
    body: { appointmentId?: string; customerId?: string },
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (idempotencyKey !== undefined && (idempotencyKey === '' || idempotencyKey.length > 128)) {
      throw badRequest('invalid_request', 'Idempotency-Key com tamanho inválido');
    }

    const local = await this.unidade(staff.tenantId);
    try {
      return await abrirComanda({
        tenantId: staff.tenantId,
        locationId: local.id,
        staffId: staff.staffUserId,
        appointmentId: body.appointmentId ?? null,
        customerId: body.customerId ?? null,
        // A chave é escopada por operador: ela vem do cliente e é livre, e duas
        // recepcionistas mandando "1" abririam a mesma comanda.
        ...(idempotencyKey ? { idempotencyKey: `${staff.staffUserId}:${idempotencyKey}` } : {}),
      });
    } catch (error) {
      return toHttp(error);
    }
  }

  @Exige('cashier.open')
  @Post('orders/:id/items')
  async item(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(itemSchema))
    body: {
      tipo: TipoDeItem;
      serviceId?: string;
      descricao: string;
      quantidade: number;
      precoUnitarioCents: number;
      professionalId?: string;
    },
  ) {
    const local = await this.unidade(staff.tenantId);
    try {
      return await adicionarItem({
        tenantId: staff.tenantId,
        locationId: local.id,
        orderId: id,
        tipo: body.tipo,
        serviceId: body.serviceId ?? null,
        descricao: body.descricao,
        quantidade: body.quantidade,
        precoUnitarioCents: body.precoUnitarioCents,
        professionalId: body.professionalId ?? null,
      });
    } catch (error) {
      return toHttp(error);
    }
  }

  @Exige('cashier.open')
  @Delete('orders/:id/items/:itemId')
  async removerDaComanda(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Param('itemId', new ZodValidationPipe(uuidSchema)) itemId: string,
  ) {
    try {
      return await removerItem({ tenantId: staff.tenantId, orderId: id, itemId });
    } catch (error) {
      return toHttp(error);
    }
  }

  /**
   * Desconto e gorjeta.
   *
   * **`finance.view`, e não `cashier.open` como o resto da comanda.** Não é
   * descuido: dar desconto é abrir mão de receita, e um desconto de 100% é a
   * mesma capacidade que um estorno. `finance.view` é o que dono e gerente têm
   * e a recepção não — então a separação que a SPEC quer sai de uma permissão
   * que já existe.
   *
   * Uma permissão própria (`finance.discount`) seria mais honesta, mas
   * inventá-la aqui criaria uma permissão que nenhum papel concede, e que
   * portanto recusaria todo mundo. Está declarada como lacuna para o bloco 30,
   * que é onde entra a tela de conceder permissão.
   */
  @Exige('finance.view')
  @Patch('orders/:id')
  async ajustar(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(ajusteSchema))
    body: { desconto?: DescontoDaComanda | null; gorjetaCents?: number },
  ) {
    try {
      return await ajustarComanda({
        tenantId: staff.tenantId,
        orderId: id,
        desconto: body.desconto ?? null,
        ...(body.gorjetaCents === undefined ? {} : { gorjetaCents: body.gorjetaCents }),
        staffId: staff.staffUserId,
        staffName: staff.name,
      });
    } catch (error) {
      return toHttp(error);
    }
  }

  @Exige('cashier.open')
  @Post('orders/:id/close')
  async pagar(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(fecharComandaSchema)) body: { pagamentos: Pagamento[] },
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (idempotencyKey !== undefined && (idempotencyKey === '' || idempotencyKey.length > 128)) {
      throw badRequest('invalid_request', 'Idempotency-Key com tamanho inválido');
    }

    const local = await this.unidade(staff.tenantId);
    try {
      return await fecharComanda({
        tenantId: staff.tenantId,
        locationId: local.id,
        orderId: id,
        pagamentos: body.pagamentos,
        staffId: staff.staffUserId,
        staffName: staff.name,
        // Escopada por operador: a chave vem do cliente e é livre, e duas
        // recepcionistas mandando "1" devolveriam uma a comanda da outra.
        ...(idempotencyKey ? { idempotencyKey: `${staff.staffUserId}:${idempotencyKey}` } : {}),
      });
    } catch (error) {
      return toHttp(error);
    }
  }

  // -- Fiado ------------------------------------------------------------------

  @Exige('cashier.open')
  @Get('debts')
  async devedores(@Staff() staff: AuthenticatedStaff) {
    return { devedores: await quemEstaDevendo(staff.tenantId) };
  }

  @Exige('cashier.open')
  @Post('debts/receive')
  async receber(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(receberFiadoSchema))
    body: { customerId: string; amountCents: number; forma: 'cash' | 'debit' | 'credit' | 'pix' },
  ) {
    const local = await this.unidade(staff.tenantId);
    try {
      return await receberFiado({
        tenantId: staff.tenantId,
        locationId: local.id,
        customerId: body.customerId,
        amountCents: body.amountCents,
        forma: body.forma,
        staffId: staff.staffUserId,
        staffName: staff.name,
      });
    } catch (error) {
      return toHttp(error);
    }
  }

  // -- Faturamento ------------------------------------------------------------

  /**
   * O faturamento do dia — a lacuna aberta desde o bloco 11.
   *
   * O dia é resolvido no **fuso da unidade**. Vindo do aparelho, a barbearia
   * com celular de fuso torto veria o faturamento de ontem misturado ao de hoje
   * (defeito D2, o mesmo que erra a grade).
   */
  @Exige('finance.view')
  @Get('revenue')
  async faturamento(
    @Staff() staff: AuthenticatedStaff,
    @Query(new ZodValidationPipe(diaSchema)) query: { dia?: string },
  ) {
    const local = await this.unidade(staff.tenantId);
    const janela = diaNaUnidade(query.dia ?? null, local.timezone, new Date());

    return {
      dia: janela.dia,
      ...(await faturamentoDoDia({
        tenantId: staff.tenantId,
        locationId: local.id,
        de: janela.de,
        ate: janela.ate,
      })),
    };
  }
}
