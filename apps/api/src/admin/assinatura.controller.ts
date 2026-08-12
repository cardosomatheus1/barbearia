import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import {
  AssinaturaError,
  agendarCancelamento,
  assinar,
  assinaturaDoCliente,
  cancelarAssinatura,
  clubeDaCasa,
  dependentes,
  incluirDependente,
  planos,
  cancelarFatura,
  desfazerCancelamento,
  faturasDoClube,
  registrarPagamentoDaFatura,
  removerDependente,
  salvarCartaoDaAssinatura,
  salvarPlano,
} from '@barbearia/finance';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { uuidSchema } from './caixa.schemas.js';
import {
  assinarSchema,
  baixaDaFaturaSchema,
  cancelarFaturaSchema,
  cancelarSchema,
  cartaoDaAssinaturaSchema,
  dependenteSchema,
  planoSchema,
} from './assinatura.schemas.js';

/**
 * O clube de assinatura (bloco 45, SPEC §4.6).
 *
 * ## As permissões
 *
 * - **Ver os planos** é `appointments.view`: quem monta a comanda precisa saber
 *   o que a casa vende, e o preço de tabela não revela dinheiro de cliente algum.
 * - **Montar plano, assinar e cancelar** é `finance.subscription_manage`, que cai
 *   no grupo de dinheiro pelo prefixo e por isso vem com segundo fator derivado:
 *   assinar liga **receita recorrente**, cancelar a desliga.
 * - **A assinatura de um cliente** é `customers.view` + `finance.view`: é a ficha
 *   de uma pessoa e traz o valor que ela paga — rota que agrega declara todas as
 *   permissões do que devolve.
 */

const STATUS: Record<string, number> = {
  plano_nao_encontrado: 404,
  e_o_titular: 409,
  ja_e_dependente: 409,
  fora_do_horario_do_plano: 409,
  plano_invalido: 400,
  cliente_nao_encontrado: 404,
  ja_assina: 409,
  assinatura_nao_encontrada: 404,
  servico_nao_encontrado: 404,
  assinatura_inativa: 409,
  servico_fora_do_plano: 409,
  cota_esgotada: 409,
  dentro_do_cooldown: 409,
  fatura_nao_encontrada: 404,
  motivo_obrigatorio: 400,
  cartao_invalido: 400,
};

export function assinaturaParaHttp(erro: unknown): never {
  if (erro instanceof AssinaturaError) {
    throw new DomainError(erro.code, STATUS[erro.code] ?? 400, erro.message);
  }
  throw erro;
}

@Controller('v1/admin/clube')
@UseGuards(StaffGuard, PermissaoGuard)
export class AssinaturaController {
  /**
   * O catálogo de planos, sem a contagem de assinantes.
   *
   * Achado da `/security-review`: `assinantes` × preço **é** o faturamento
   * recorrente da casa, que a rota do clube guarda atrás de `finance.view`.
   * Aqui, sob `appointments.view`, ele era o caminho mais curto para a permissão
   * que o dono negou — e o barbeiro tem `appointments.view` por padrão.
   *
   * O que sobra é catálogo: nome, preço de tabela e o que o plano dá. Quem monta
   * a comanda precisa disso e de nada mais.
   */
  @Exige('appointments.view')
  @Get('planos')
  async lista(@Staff() staff: AuthenticatedStaff, @Query('todos') todos?: string) {
    return { planos: await planos(staff.tenantId, todos === 'true') };
  }

  /** O mesmo catálogo **com** a contagem, para quem já pode ver o MRR. */
  @Exige('finance.view', 'finance.subscription_manage')
  @Get('planos/contados')
  async listaContada(@Staff() staff: AuthenticatedStaff, @Query('todos') todos?: string) {
    return { planos: await planos(staff.tenantId, todos === 'true', true) };
  }

  @Exige('finance.subscription_manage')
  @Put('planos')
  async criar(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(planoSchema))
    body: {
      nome: string;
      descricao?: string | null;
      precoCents: number;
      descontoEmProdutoBps: number;
      ativo: boolean;
      janelaDeAgendamentoDias?: number;
      bloqueios?: { diaDaSemana: number | null; inicio: number; fim: number }[];
      beneficios: { serviceId: string; quantidade: number | null; cooldownDias: number }[];
    },
  ) {
    try {
      return await salvarPlano({
        tenantId: staff.tenantId,
        ...body,
        ator: { id: staff.staffUserId, name: staff.name },
      });
    } catch (erro) {
      return assinaturaParaHttp(erro);
    }
  }

  @Exige('finance.subscription_manage')
  @Put('planos/:id')
  async editar(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(planoSchema))
    body: {
      nome: string;
      descricao?: string | null;
      precoCents: number;
      descontoEmProdutoBps: number;
      ativo: boolean;
      janelaDeAgendamentoDias?: number;
      bloqueios?: { diaDaSemana: number | null; inicio: number; fim: number }[];
      beneficios: { serviceId: string; quantidade: number | null; cooldownDias: number }[];
    },
  ) {
    try {
      return await salvarPlano({
        tenantId: staff.tenantId,
        id,
        ...body,
        ator: { id: staff.staffUserId, name: staff.name },
      });
    } catch (erro) {
      return assinaturaParaHttp(erro);
    }
  }

  @Exige('finance.view', 'finance.subscription_manage')
  @Get()
  async clube(@Staff() staff: AuthenticatedStaff) {
    return clubeDaCasa(staff.tenantId);
  }

  @Exige('customers.view', 'finance.view')
  @Get('clientes/:id')
  async doCliente(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    return { assinatura: await assinaturaDoCliente(staff.tenantId, id) };
  }

  @Exige('finance.subscription_manage')
  @Post('assinar')
  async novaAssinatura(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(assinarSchema)) body: { customerId: string; planId: string },
  ) {
    try {
      return await assinar({
        tenantId: staff.tenantId,
        customerId: body.customerId,
        planId: body.planId,
        ator: { id: staff.staffUserId, name: staff.name },
      });
    } catch (erro) {
      return assinaturaParaHttp(erro);
    }
  }

  /**
   * Cancelar pelo balcão.
   *
   * Sem `customerId`: quem opera está agindo em nome da casa sobre uma
   * assinatura que ela administra, e a RLS já limita à barbearia. O
   * cancelamento **self-service** — em que o filtro por cliente é obrigatório,
   * porque a RLS não separa clientes dentro de uma casa — é do bloco 47.
   */
  /**
   * Quem mais usa a cota desta assinatura (bloco 46).
   *
   * `customers.view` junto porque a lista traz **nome de gente**: sem ela,
   * `finance.subscription_manage` viraria o caminho mais curto para a base de
   * nomes por uma rota chamada dependentes.
   */
  @Exige('finance.subscription_manage', 'customers.view')
  @Get(':id/dependentes')
  async lista_dependentes(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    // O ciclo do mês corrente: é o que a tela mostra ao lado da cota.
    const agora = new Date();
    const de = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 1));
    const ate = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() + 1, 1));
    return { dependentes: await dependentes(staff.tenantId, id, de, ate) };
  }

  @Exige('finance.subscription_manage')
  @Post(':id/dependentes')
  async incluir(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(dependenteSchema)) body: { customerId: string },
  ) {
    try {
      return await incluirDependente({
        tenantId: staff.tenantId,
        subscriptionId: id,
        customerId: body.customerId,
        ator: { id: staff.staffUserId, name: staff.name },
      });
    } catch (erro) {
      return assinaturaParaHttp(erro);
    }
  }

  @Exige('finance.subscription_manage')
  @Post(':id/dependentes/remover')
  async remover(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(dependenteSchema)) body: { customerId: string },
  ) {
    try {
      return await removerDependente({
        tenantId: staff.tenantId,
        subscriptionId: id,
        customerId: body.customerId,
        ator: { id: staff.staffUserId, name: staff.name },
      });
    } catch (erro) {
      return assinaturaParaHttp(erro);
    }
  }

  @Exige('finance.subscription_manage')
  @Post(':id/cancelar')
  async cancelar(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(cancelarSchema)) body: { motivo: string },
  ) {
    try {
      return await cancelarAssinatura({
        tenantId: staff.tenantId,
        assinaturaId: id,
        motivo: body.motivo,
        ator: { id: staff.staffUserId, name: staff.name },
      });
    } catch (erro) {
      return assinaturaParaHttp(erro);
    }
  }

  // -- a cobrança recorrente (bloco 47) ---------------------------------------

  /**
   * As mensalidades.
   *
   * `customers.view` junto de `finance.view`: a lista traz **nome de gente** ao
   * lado do valor. Rota que agrega declara todas as permissões do que devolve —
   * é o achado da `/security-review` do bloco 31, e sem ele `finance.view`
   * viraria o caminho mais curto para a base de nomes por uma rota chamada
   * faturas.
   */
  @Exige('finance.view', 'customers.view')
  @Get('faturas')
  async faturas(
    @Staff() staff: AuthenticatedStaff,
    @Query('estado') estado?: 'aberta' | 'paga' | 'cancelada',
  ) {
    const filtro = estado === 'aberta' || estado === 'paga' || estado === 'cancelada'
      ? { estado }
      : {};
    return { faturas: await faturasDoClube(staff.tenantId, filtro) };
  }

  /**
   * A baixa manual, que é o caminho que de fato acontece numa casa pequena: o
   * cliente paga o plano no Pix e alguém registra.
   *
   * `finance.subscription_manage` cai no grupo de dinheiro pelo prefixo, e por
   * isso vem com segundo fator derivado — dar baixa é afirmar que dinheiro
   * entrou, e quem digita é a única testemunha.
   */
  @Exige('finance.subscription_manage')
  @Post('faturas/:id/pagar')
  async pagarFatura(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(baixaDaFaturaSchema))
    body: { metodo: 'dinheiro' | 'pix' | 'cartao' | 'transferencia' },
  ) {
    try {
      return await registrarPagamentoDaFatura({
        tenantId: staff.tenantId,
        faturaId: id,
        metodo: body.metodo,
        ator: { id: staff.staffUserId, name: staff.name },
      });
    } catch (erro) {
      return assinaturaParaHttp(erro);
    }
  }

  /** Cancelar uma fatura é perdoar uma dívida — com motivo escrito e auditada. */
  @Exige('finance.subscription_manage')
  @Post('faturas/:id/cancelar')
  async anularFatura(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(cancelarFaturaSchema)) body: { motivo: string },
  ) {
    try {
      return await cancelarFatura({
        tenantId: staff.tenantId,
        faturaId: id,
        motivo: body.motivo,
        ator: { id: staff.staffUserId, name: staff.name },
      });
    } catch (erro) {
      return assinaturaParaHttp(erro);
    }
  }

  /**
   * O cartão salvo, para a régua poder cobrar sozinha.
   *
   * O corpo carrega **token**, bandeira, quatro últimos e validade. Não há campo
   * para número nem para CVV, aqui nem no banco — e o `/security-review` de
   * qualquer bloco futuro tem invariante que reprova quem criar um.
   */
  @Exige('finance.subscription_manage')
  @Put(':id/cartao')
  async cartao(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(cartaoDaAssinaturaSchema))
    body: { token: string; bandeira: string; ultimosQuatro: string; mes: number; ano: number },
  ) {
    try {
      return await salvarCartaoDaAssinatura({
        tenantId: staff.tenantId,
        assinaturaId: id,
        ...body,
      });
    } catch (erro) {
      return assinaturaParaHttp(erro);
    }
  }

  /**
   * O balcão agenda a saída para o fim do ciclo pago.
   *
   * Diferente de `:id/cancelar`, que corta na hora e existe para o caso em que
   * a casa precisa desfazer a venda. Este é o caminho normal: o cliente pediu
   * para sair, pagou o mês, e corta até o fim dele.
   */
  @Exige('finance.subscription_manage')
  @Post(':id/agendar-cancelamento')
  async agendarSaida(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(cancelarSchema)) body: { motivo: string },
  ) {
    try {
      return await agendarCancelamento({
        tenantId: staff.tenantId,
        assinaturaId: id,
        motivo: body.motivo,
        ator: { id: staff.staffUserId, name: staff.name },
      });
    } catch (erro) {
      return assinaturaParaHttp(erro);
    }
  }

  /** O cliente mudou de ideia antes de o ciclo acabar. */
  @Exige('finance.subscription_manage')
  @Post(':id/desfazer-cancelamento')
  async desfazerSaida(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    try {
      return await desfazerCancelamento({
        tenantId: staff.tenantId,
        assinaturaId: id,
        ator: { id: staff.staffUserId, name: staff.name },
      });
    } catch (erro) {
      return assinaturaParaHttp(erro);
    }
  }
}
