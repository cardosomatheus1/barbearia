import { Body, Controller, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import {
  SplitError,
  cadastrarRecebedor,
  configuracaoDoSplit,
  recebedores,
  repassesDoPeriodo,
  salvarConfiguracaoDoSplit,
  splitDaVenda,
} from '@barbearia/finance';
import { adquirenteDoSplit } from '@barbearia/platform';
import { DomainError } from '../common/errors.js';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { uuidSchema } from './caixa.schemas.js';

/**
 * Split de pagamento (bloco 49, SPEC §3.5).
 *
 * ## As permissões, e por que são estas
 *
 * - **Ver os repasses** é `commission.view_all`: um repasse é a comissão de
 *   alguém saindo para a conta dele. Barbeiro que vê o repasse do colega é a
 *   mesma briga que `commission.view_own` existe para evitar desde o bloco 19 —
 *   e o recorte por profissional é o mesmo do extrato de comissão.
 * - **Ligar o split** é `finance.split_manage`, criada neste bloco. Ela decide
 *   que o adquirente mande dinheiro **direto para a conta do barbeiro**, sem
 *   passar pela da casa; o prefixo `finance.` traz o segundo fator derivado.
 */

/**
 * Só o interruptor.
 *
 * A alíquota da plataforma **não** está aqui: ela é termo comercial do produto,
 * mora em `tenant_platform` e é escrita pelo Super Admin. Editável por esta
 * rota, o cliente definiria o preço que paga — e zerá-la desligaria a receita
 * sem nada falhar. Achado da `/security-review` deste bloco.
 */
const configuracaoSchema = z.object({
  ligado: z.boolean(),
});

/**
 * O cadastro do profissional como recebedor.
 *
 * Documento, banco, agência e conta **atravessam** para o adquirente e não são
 * gravados — quem tem obrigação regulatória de guardá-los é ele. Deste lado fica
 * a referência opaca, e há invariante no banco que reprova quem criar coluna
 * para eles em `professionals`.
 */
const recebedorSchema = z.object({
  documento: z.string().trim().regex(/^[0-9]{11}$|^[0-9]{14}$/),
  banco: z.string().trim().min(2).max(10),
  agencia: z.string().trim().min(1).max(10),
  conta: z.string().trim().min(3).max(20),
});

const STATUS: Record<string, number> = {
  profissional_nao_encontrado: 404,
  ja_aprovado: 409,
  dados_invalidos: 400,
  aliquota_invalida: 400,
};

function toHttp(erro: unknown): never {
  if (erro instanceof SplitError) {
    throw new DomainError(erro.code, STATUS[erro.code] ?? 400, erro.message);
  }
  throw erro;
}

const periodoSchema = z.object({
  de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

@Controller('v1/admin/split')
@UseGuards(StaffGuard, PermissaoGuard)
export class SplitController {
  @Exige('commission.view_all')
  @Get()
  async lista(
    @Staff() staff: AuthenticatedStaff,
    @Query(new ZodValidationPipe(periodoSchema)) query: { de: string; ate: string },
  ) {
    const [configuracao, repasses] = await Promise.all([
      configuracaoDoSplit(staff.tenantId),
      repassesDoPeriodo({ tenantId: staff.tenantId, de: query.de, ate: query.ate }),
    ]);
    return { configuracao, repasses };
  }

  /**
   * Os meus repasses.
   *
   * `commission.view_own` é a permissão de dinheiro **sem** segundo fator (ver
   * `PERMISSAO_DE_DINHEIRO_SEM_SEGUNDO_FATOR`): cobrar o código do barbeiro para
   * ele ver o próprio acerto seria o que faz a barbearia procurar como desligar
   * isso. O recorte é imposto **aqui**, com o id da sessão — nunca de parâmetro.
   */
  @Exige('commission.view_own')
  @Get('meus')
  async meus(
    @Staff() staff: AuthenticatedStaff,
    @Query(new ZodValidationPipe(periodoSchema)) query: { de: string; ate: string },
  ) {
    if (!staff.professionalId) return { repasses: [] };
    return {
      repasses: await repassesDoPeriodo({
        tenantId: staff.tenantId,
        de: query.de,
        ate: query.ate,
        somenteProfessionalId: staff.professionalId,
      }),
    };
  }

  @Exige('commission.view_all')
  @Get('venda/:id')
  async daVenda(
    @Staff() staff: AuthenticatedStaff,
    // `@Param`, e não `@Query`: o id está no caminho. Com o decorador errado ele
    // chegaria indefinido e a consulta responderia sobre venda nenhuma.
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    return { split: await splitDaVenda(staff.tenantId, id) };
  }

  /**
   * Quem já pode receber direto, e quanto está retido esperando cadastro.
   *
   * `commission.view_all` porque a lista é de dinheiro por profissional — a
   * mesma sensibilidade do extrato de comissão, e o mesmo motivo: barbeiro que
   * vê o valor retido do colega é a briga que a separação das duas permissões
   * existe para evitar.
   */
  @Exige('commission.view_all')
  @Get('recebedores')
  async listaDeRecebedores(@Staff() staff: AuthenticatedStaff) {
    return { recebedores: await recebedores(staff.tenantId) };
  }

  /**
   * Cadastra um profissional como recebedor no adquirente.
   *
   * `finance.split_manage` pelo mesmo motivo da rota do interruptor, e aqui ele
   * é literal: o que esta rota decide é **para qual conta bancária** o dinheiro
   * do barbeiro vai. O prefixo `finance.` traz o segundo fator derivado.
   */
  @Exige('finance.split_manage')
  @Put('recebedores/:id')
  async cadastrar(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(recebedorSchema))
    body: { documento: string; banco: string; agencia: string; conta: string },
  ) {
    try {
      return await cadastrarRecebedor({
        tenantId: staff.tenantId,
        professionalId: id,
        ...body,
        provider: adquirenteDoSplit(),
        staffId: staff.staffUserId,
        staffName: staff.name,
      });
    } catch (erro) {
      return toHttp(erro);
    }
  }

  @Exige('finance.split_manage')
  @Put('configuracao')
  async configurar(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(configuracaoSchema)) body: { ligado: boolean },
  ) {
    return salvarConfiguracaoDoSplit({
      tenantId: staff.tenantId,
      ligado: body.ligado,
      staffId: staff.staffUserId,
      staffName: staff.name,
    });
  }
}
