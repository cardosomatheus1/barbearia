import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  painelDeDinheiro,
  painelDeDinheiroDoPeriodo,
  painelOperacional,
  painelOperacionalDoPeriodo,
  type PeriodoPainel,
} from '@barbearia/finance';
import { diagnosticarCatalogo } from '@barbearia/catalog';
import {
  ACOES_DE_DINHEIRO,
  ACOES_DE_GESTAO,
  listAudit,
  type AuditAction,
  type AuthenticatedStaff,
} from '@barbearia/identity';
import { withTenant } from '@barbearia/db';
import { primaryLocation } from '@barbearia/scheduling';
import { diaNaUnidade } from '@barbearia/core';
import { notFound } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { diaSchema, trilhaSchema } from './painel.schemas.js';

/**
 * O painel do proprietário, o validador de catálogo e a trilha.
 *
 * **Quatro rotas, quatro permissões, e a separação é o ponto.**
 *
 * O número operacional e o número de dinheiro saem em rotas diferentes porque
 * `reports.operational` é da recepção e `finance.view` está no grupo de
 * dinheiro, que exige segundo fator. Uma rota só, decidindo por dentro o que
 * devolve, faria a permissão declarada deixar de descrever a rota — o defeito
 * exato que a `/security-review` encontrou no bloco 19, e a razão de a
 * exigência de MFA ser **derivada** do `@Exige`.
 *
 * O validador é `settings.manage`: ele fala de cadastro, e quem conserta um
 * combo mal cadastrado é quem edita o catálogo.
 *
 * **A trilha também é duas rotas, e por engano quase foi uma.** A primeira
 * versão serviu a trilha inteira sob `settings.manage`, com a justificativa de
 * que ela guarda *quem fez o quê* e "nunca a senha nem o hash de ninguém". A
 * categoria conferida estava errada: `cash.closed` guarda o esperado, o contado
 * e a divergência da gaveta; `order.discount`, o valor perdoado;
 * `commission.closed`, o total da folha. A trilha não guarda segredo — guarda
 * **quanto**. Sob `settings.manage` ela entregava o caixa e a folha, sem segundo
 * fator, para a mesma conta que tinha acabado de ser barrada em
 * `/dashboard/revenue`. É `packages/identity/src/audit.ts` que parte o
 * vocabulário, com teste que reprova ação nova sem lado.
 */
@Controller('v1/admin')
@UseGuards(StaffGuard, PermissaoGuard)
export class PainelController {
  private async unidade(tenantId: string) {
    const local = await primaryLocation(tenantId);
    if (!local) throw notFound('unknown_location', 'Unidade não encontrada');
    return local;
  }

  /**
   * O dia da unidade, nunca o do aparelho.
   *
   * O painel compara hoje com o mesmo dia da semana anterior. Vindo do
   * dispositivo, quem abrisse às 21h de sábado em outro fuso veria o domingo —
   * que é o defeito D2 aplicado ao número que decide contratação.
   */
  private async diaDaCasa(tenantId: string, pedido?: string): Promise<{ dia: string; locationId: string }> {
    const local = await this.unidade(tenantId);
    return {
      dia: pedido ?? diaNaUnidade(null, local.timezone, new Date()).dia,
      locationId: local.id,
    };
  }

  @Exige('reports.operational')
  @Get('dashboard')
  async operacional(
    @Staff() staff: AuthenticatedStaff,
    @Query(new ZodValidationPipe(diaSchema)) query: { dia?: string; periodo?: PeriodoPainel },
  ) {
    const { dia, locationId } = await this.diaDaCasa(staff.tenantId, query.dia);
    return query.periodo
      ? painelOperacionalDoPeriodo({ tenantId: staff.tenantId, locationId, dia, periodo: query.periodo })
      : painelOperacional({ tenantId: staff.tenantId, locationId, dia });
  }

  /** O dinheiro do dia. `finance.view` está no grupo que exige segundo fator. */
  @Exige('finance.view')
  @Get('dashboard/revenue')
  async dinheiro(
    @Staff() staff: AuthenticatedStaff,
    @Query(new ZodValidationPipe(diaSchema)) query: { dia?: string; periodo?: PeriodoPainel },
  ) {
    const { dia, locationId } = await this.diaDaCasa(staff.tenantId, query.dia);
    return query.periodo
      ? painelDeDinheiroDoPeriodo({ tenantId: staff.tenantId, locationId, dia, periodo: query.periodo })
      : painelDeDinheiro({ tenantId: staff.tenantId, locationId, dia });
  }

  @Exige('settings.manage')
  @Get('catalog/diagnosis')
  async diagnostico(@Staff() staff: AuthenticatedStaff) {
    const local = await this.unidade(staff.tenantId);
    return diagnosticarCatalogo({ tenantId: staff.tenantId, locationId: local.id });
  }

  /** Conta, papel, permissão e segundo fator. Nada com valor em dinheiro. */
  @Exige('settings.manage')
  @Get('audit')
  async trilha(
    @Staff() staff: AuthenticatedStaff,
    @Query(new ZodValidationPipe(trilhaSchema)) query: { antesDe?: string },
  ) {
    return this.pagina(staff.tenantId, ACOES_DE_GESTAO, query.antesDe);
  }

  /**
   * Caixa, comanda, fiado e comissão.
   *
   * `finance.view` está no grupo do dinheiro, então o segundo fator vem junto —
   * derivado, sem decorador a esquecer.
   */
  @Exige('finance.view')
  @Get('audit/finance')
  async trilhaDoDinheiro(
    @Staff() staff: AuthenticatedStaff,
    @Query(new ZodValidationPipe(trilhaSchema)) query: { antesDe?: string },
  ) {
    return this.pagina(staff.tenantId, ACOES_DE_DINHEIRO, query.antesDe);
  }

  private async pagina(tenantId: string, acoes: readonly AuditAction[], antesDe?: string) {
    const POR_PAGINA = 50;
    const entries = await withTenant(tenantId, (tx) =>
      listAudit(tx, { limite: POR_PAGINA, acoes, ...(antesDe ? { antesDe } : {}) }),
    );
    /**
     * Cursor, nunca offset (CLAUDE.md §3). A trilha só cresce, e com `OFFSET`
     * uma linha nova entre duas páginas empurra o resto — a pessoa lê o mesmo
     * evento duas vezes e nunca vê o que passou.
     *
     * Página incompleta não tem cursor: devolver o id da última linha de uma
     * página curta ofereceria "ver mais antigos" para uma tela vazia, e a pessoa
     * clica para descobrir que não havia nada.
     */
    return {
      entries,
      proximoCursor: entries.length === POR_PAGINA ? (entries.at(-1)?.id ?? null) : null,
    };
  }
}
