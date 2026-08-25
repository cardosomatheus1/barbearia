import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  FinanceiroError,
  agendaDoFinanceiro,
  arquivarCategoriaFinanceira,
  cancelarContaDoFinanceiro,
  categoriasFinanceiras,
  contasFinanceiras,
  criarCategoriaFinanceira,
  criarContaDoFinanceiro,
  criarContaFinanceira,
  definirLimiteDeFiado,
  fiadoDoCliente,
  lancarSaldoInicialDeFiado,
  quitarContaDoFinanceiro,
  resumoFinanceiroDoCliente,
  transferenciasRecentes,
  transferirEntreContas,
} from '@barbearia/finance';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { uuidSchema } from './caixa.schemas.js';
import { unidadeDoBalcao } from './unidade.js';
import {
  cancelamentoDeContaSchema,
  categoriaAtivaSchema,
  categoriaNovaSchema,
  contaFinanceiraNovaSchema,
  contaNovaSchema,
  filtroDoFinanceiroSchema,
  limiteDeFiadoSchema,
  quitacaoSchema,
  saldoInicialDeFiadoSchema,
  transferenciaSchema,
} from './financeiro.schemas.js';

/**
 * Financeiro: contas a pagar e a receber, transferências, limite de fiado
 * (bloco 51, SPEC §3.10).
 *
 * ## Três permissões, e cada uma diz outra coisa
 *
 * - **Ler** o que a barbearia deve e tem a receber é `finance.view`. É a mesma
 *   pergunta do faturamento vista pelo outro lado, e o gerente que fecha o mês
 *   precisa dela sem poder pagar nada. Nenhuma leitura daqui revela margem,
 *   custo ou sobra — se um dia revelar, ela passa a exigir `finance.view_profit`,
 *   e há teste que deriva isso dos tipos de retorno.
 * - **Mexer** — criar, quitar, cancelar, transferir, cadastrar categoria e conta
 *   — é `finance.bills_manage`, que cai no grupo de dinheiro pelo prefixo e por
 *   isso vem com segundo fator derivado.
 * - **Levantar o limite de fiado** e lançar o saldo herdado é
 *   `finance.credit_limit`, separada porque é outra decisão: pagar o que a casa
 *   deve é operação; dizer quem leva corte sem pagar é risco, e risco é do dono.
 *
 * ## O dia vem da unidade
 *
 * O que está vencido depende de que dia é hoje, e "hoje" é o dia **da unidade**
 * — nunca o do processo nem o do aparelho. Às 22h de Salvador o UTC já virou, e
 * a conta que vence amanhã apareceria vencida para quem ainda está trabalhando.
 * É o defeito D2 aplicado ao financeiro.
 */

const STATUS: Record<string, number> = {
  conta_nao_encontrada: 404,
  conta_nao_aberta: 409,
  valor_invalido: 400,
  valor_pago_invalido: 400,
  descricao_obrigatoria: 400,
  vencimento_invalido: 400,
  categoria_invalida: 404,
  conta_bancaria_invalida: 404,
  direcao_incompativel: 400,
  mesma_conta: 400,
  cliente_nao_encontrado: 404,
  motivo_obrigatorio: 400,
  nome_repetido: 409,
  ja_tem_extrato: 409,
  gaveta_ja_existe: 409,
  idempotencia_conflitante: 409,
};

function toHttp(erro: unknown): never {
  if (erro instanceof FinanceiroError) {
    throw new DomainError(erro.code, STATUS[erro.code] ?? 400, erro.message);
  }
  throw erro;
}

@Controller('v1/admin/financeiro')
@UseGuards(StaffGuard, PermissaoGuard)
export class FinanceiroController {
  private async unidade(staff: AuthenticatedStaff) {
    return unidadeDoBalcao(staff);
  }

  @Exige('finance.view')
  @Get('contas')
  async agenda(
    @Staff() staff: AuthenticatedStaff,
    @Query(new ZodValidationPipe(filtroDoFinanceiroSchema)) query: {
      direcao?: 'pagar' | 'receber';
      fechadas?: 'true' | 'false';
    },
  ) {
    const local = await this.unidade(staff);
    return agendaDoFinanceiro({
      tenantId: staff.tenantId,
      locationId: local.id,
      hoje: local.today,
      direcao: query.direcao ?? null,
      incluirFechadas: query.fechadas === 'true',
    });
  }

  @Exige('finance.bills_manage')
  @Post('contas')
  async criar(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(contaNovaSchema)) body: {
      direcao: 'pagar' | 'receber';
      descricao: string;
      valorCents: number;
      vencimentoEm: string;
      categoriaId?: string | null;
      contaId?: string | null;
      observacao?: string | null;
    },
  ) {
    const local = await this.unidade(staff);
    try {
      return await criarContaDoFinanceiro({
        tenantId: staff.tenantId,
        locationId: local.id,
        ...body,
        staffId: staff.staffUserId,
        staffName: staff.name,
      });
    } catch (erro) {
      return toHttp(erro);
    }
  }

  @Exige('finance.bills_manage')
  @Post('contas/:id/quitar')
  async quitar(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(quitacaoSchema)) body: {
      valorPagoCents: number;
      pagaEm: string;
      pelaGaveta: boolean;
    },
  ) {
    const local = await this.unidade(staff);
    try {
      await quitarContaDoFinanceiro({
        tenantId: staff.tenantId,
        locationId: local.id,
        contaId: id,
        ...body,
        staffId: staff.staffUserId,
        staffName: staff.name,
      });
      return { ok: true };
    } catch (erro) {
      return toHttp(erro);
    }
  }

  @Exige('finance.bills_manage')
  @Post('contas/:id/cancelar')
  async cancelar(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(cancelamentoDeContaSchema)) body: { motivo: string },
  ) {
    const local = await this.unidade(staff);
    try {
      await cancelarContaDoFinanceiro({
        tenantId: staff.tenantId,
        locationId: local.id,
        contaId: id,
        motivo: body.motivo,
        staffId: staff.staffUserId,
        staffName: staff.name,
      });
      return { ok: true };
    } catch (erro) {
      return toHttp(erro);
    }
  }

  @Exige('finance.view')
  @Get('categorias')
  async categorias(@Staff() staff: AuthenticatedStaff) {
    return { categorias: await categoriasFinanceiras(staff.tenantId) };
  }

  @Exige('finance.bills_manage')
  @Post('categorias')
  async criarCategoria(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(categoriaNovaSchema)) body: {
      nome: string;
      direcao: 'pagar' | 'receber';
    },
  ) {
    try {
      return await criarCategoriaFinanceira({ tenantId: staff.tenantId, ...body });
    } catch (erro) {
      return toHttp(erro);
    }
  }

  @Exige('finance.bills_manage')
  @Put('categorias/:id')
  async arquivarCategoria(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(categoriaAtivaSchema)) body: { ativa: boolean },
  ) {
    try {
      await arquivarCategoriaFinanceira({
        tenantId: staff.tenantId,
        categoriaId: id,
        ativa: body.ativa,
      });
      return { ok: true };
    } catch (erro) {
      return toHttp(erro);
    }
  }

  @Exige('finance.view')
  @Get('contas-bancarias')
  async contas(@Staff() staff: AuthenticatedStaff) {
    return { contas: await contasFinanceiras(staff.tenantId) };
  }

  @Exige('finance.bills_manage')
  @Post('contas-bancarias')
  async criarConta(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(contaFinanceiraNovaSchema)) body: {
      nome: string;
      locationId?: string | null;
      ehGaveta?: boolean;
    },
  ) {
    try {
      // A lista que a tela oferece decide o que ela **mostra**; o `POST` recebe
      // o id do corpo. A conferência é do domínio, com as lojas que o ator
      // opera lidas do banco — bloco 58, na porta do financeiro.
      return await criarContaFinanceira({
        tenantId: staff.tenantId,
        autorizadas: staff.unidadesAutorizadas,
        ...body,
      });
    } catch (erro) {
      return toHttp(erro);
    }
  }

  @Exige('finance.view')
  @Get('transferencias')
  async transferencias(@Staff() staff: AuthenticatedStaff) {
    const local = await this.unidade(staff);
    return {
      transferencias: await transferenciasRecentes({
        tenantId: staff.tenantId,
        locationId: local.id,
      }),
    };
  }

  @Exige('finance.bills_manage')
  @Post('transferencias')
  async transferir(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(transferenciaSchema)) body: {
      deContaId: string;
      paraContaId: string;
      valorCents: number;
      quandoEm: string;
      observacao?: string | null;
    },
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!idempotencyKey || idempotencyKey.length > 128) {
      throw new DomainError('idempotency_key_obrigatoria', 400, 'Mande um Idempotency-Key de até 128 caracteres.');
    }

    const local = await this.unidade(staff);
    try {
      return await transferirEntreContas({
        tenantId: staff.tenantId,
        locationId: local.id,
        ...body,
        // Escopada por operador: a chave vem do cliente e é livre, e duas
        // recepcionistas mandando "1" fariam a segunda receber a transferência
        // da primeira de volta em vez de fazer a dela.
        idempotencyKey: `${staff.staffUserId}:${idempotencyKey}`,
        staffId: staff.staffUserId,
        staffName: staff.name,
      });
    } catch (erro) {
      return toHttp(erro);
    }
  }

  /**
   * LTV/acumulado pago do cliente. Separado de CRM e protegido pelas duas
   * permissões do dado que agrega: identidade + dinheiro.
   */
  @Exige('customers.view', 'finance.view')
  @Get('clientes/:id/resumo')
  async resumoDoCliente(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    try {
      return await resumoFinanceiroDoCliente(staff.tenantId, id);
    } catch (erro) {
      return toHttp(erro);
    }
  }

  /**
   * Saldo e limite de um cliente, para a ficha dele.
   *
   * Declara as duas permissões do que devolve: é dinheiro de uma pessoa
   * identificada.
   */
  @Exige('customers.view', 'finance.view')
  @Get('clientes/:id/fiado')
  async fiado(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    try {
      return await fiadoDoCliente(staff.tenantId, id);
    } catch (erro) {
      return toHttp(erro);
    }
  }

  /**
   * O teto de crédito de um cliente.
   *
   * `finance.credit_limit` e não `customers.edit`: autorizar alguém a consumir
   * sem pagar é decisão financeira e passa pelo segundo fator.
   */
  @Exige('finance.credit_limit')
  @Put('clientes/:id/limite')
  async limite(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(limiteDeFiadoSchema)) body: { limiteCents: number },
  ) {
    try {
      return await definirLimiteDeFiado({
        tenantId: staff.tenantId,
        customerId: id,
        limiteCents: body.limiteCents,
        staffId: staff.staffUserId,
        staffName: staff.name,
      });
    } catch (erro) {
      return toHttp(erro);
    }
  }

  @Exige('finance.credit_limit')
  @Post('clientes/:id/saldo-inicial')
  async saldoInicial(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(saldoInicialDeFiadoSchema)) body: {
      deveCents: number;
      motivo: string;
    },
  ) {
    try {
      return await lancarSaldoInicialDeFiado({
        tenantId: staff.tenantId,
        customerId: id,
        deveCents: body.deveCents,
        motivo: body.motivo,
        staffId: staff.staffUserId,
        staffName: staff.name,
      });
    } catch (erro) {
      return toHttp(erro);
    }
  }
}
