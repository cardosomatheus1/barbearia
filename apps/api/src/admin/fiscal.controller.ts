import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import {
  FiscalError,
  cancelarNota,
  configuracaoFiscal,
  salvarConfiguracaoFiscal,
  notaDaVenda,
  notasDoPeriodo,
  pedirNota,
} from '@barbearia/finance';
import { FakeFiscalProvider, type RegimeFiscal } from '@barbearia/core';
import { withTenant } from '@barbearia/db';
import { primaryLocation } from '@barbearia/scheduling';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { uuidSchema } from './caixa.schemas.js';
import {
  cancelamentoDeNotaSchema,
  configuracaoFiscalSchema,
  periodoDasNotasSchema,
} from './fiscal.schemas.js';

/**
 * Nota fiscal de serviço (bloco 53, SPEC §3.11).
 *
 * ## Três permissões, e nenhuma é de dinheiro
 *
 * `fiscal.*` fica **fora** do grupo que deriva segundo fator, e a decisão é
 * deliberada: a nota não move centavo. Derivar TOTP dela obrigaria a recepção a
 * confirmar o código para conferir se a nota do cliente saiu — trinta vezes por
 * dia, por uma leitura que não revela faturamento. O que a nota mostra é o valor
 * de **uma** venda, que quem fechou a comanda já viu.
 *
 * - **Ver** é `fiscal.view` — e ela é por venda, nunca somada. A listagem por
 *   período é o único ponto em que muitas notas aparecem juntas, e por isso ela
 *   declara `finance.view` junto: uma lista de trezentas notas com valor é o
 *   faturamento do mês por outro caminho.
 * - **Emitir e cancelar** é `fiscal.issue`. Cancelar é ato perante a prefeitura,
 *   não movimento de dinheiro.
 * - **Cadastrar CNPJ, regime e alíquota** é `fiscal.settings`, separada de
 *   `settings.manage`: errar aqui não é errar uma preferência, é emitir nota com
 *   imposto errado em nome da casa.
 *
 * ## O emissor é um só, e vem de fora deste arquivo
 *
 * `EMISSOR` é criado na montagem do módulo, como o provedor de mensagem do
 * worker. Instanciar um dentro de cada rota faria daquela rota a única que não
 * troca junto quando o emissor de verdade entrar — é a lição do bloco 39.
 */

const STATUS: Record<string, number> = {
  cnpj_invalido: 400,
  regime_invalido: 400,
  codigo_de_servico_obrigatorio: 400,
  aliquota_invalida: 400,
  municipio_obrigatorio: 400,
  nao_configurado: 409,
  nota_nao_encontrada: 404,
  nota_nao_cancelavel: 409,
  motivo_obrigatorio: 400,
  venda_nao_encontrada: 404,
  nao_emite: 409,
};

function toHttp(erro: unknown): never {
  if (erro instanceof FiscalError) {
    throw new DomainError(erro.code, STATUS[erro.code] ?? 400, erro.message, erro.motivo);
  }
  throw erro;
}

/**
 * Enquanto não há contrato com emissor terceirizado, é o de mentira.
 *
 * Ele responde `processando` por padrão — o estado real de uma NFS-e
 * recém-enviada —, e é o que faz a cadeia de conciliação ser percorrida pelo
 * caminho real em vez de pulada por um fake otimista.
 */
const EMISSOR = new FakeFiscalProvider();

@Controller('v1/admin/fiscal')
@UseGuards(StaffGuard, PermissaoGuard)
export class FiscalController {
  private async unidade(tenantId: string) {
    const local = await primaryLocation(tenantId);
    if (!local) throw new DomainError('unknown_location', 404, 'Unidade não encontrada.');
    return local;
  }

  @Exige('fiscal.settings')
  @Get('configuracao')
  async configuracao(@Staff() staff: AuthenticatedStaff) {
    const local = await this.unidade(staff.tenantId);
    return { configuracao: await configuracaoFiscal(staff.tenantId, local.id) };
  }

  @Exige('fiscal.settings')
  @Put('configuracao')
  async salvar(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(configuracaoFiscalSchema)) body: {
      cnpj: string;
      regime: RegimeFiscal;
      codigoDeServico: string;
      issBps: number;
      municipioIbge: string;
      inscricaoMunicipal?: string | null;
      emitirAutomaticamente: boolean;
    },
  ) {
    const local = await this.unidade(staff.tenantId);
    try {
      return await salvarConfiguracaoFiscal({
        tenantId: staff.tenantId,
        locationId: local.id,
        config: {
          cnpj: body.cnpj,
          regime: body.regime,
          codigoDeServico: body.codigoDeServico,
          issBps: body.issBps,
          municipioIbge: body.municipioIbge,
          emitirAutomaticamente: body.emitirAutomaticamente,
        },
        inscricaoMunicipal: body.inscricaoMunicipal ?? null,
        staffId: staff.staffUserId,
        staffName: staff.name,
      });
    } catch (erro) {
      return toHttp(erro);
    }
  }

  /**
   * A lista de notas do período.
   *
   * Declara `finance.view` **junto** de `fiscal.view`: trezentas notas com valor
   * numa tela são o faturamento do mês por outro caminho, e rota que agrega
   * declara todas as permissões do que devolve. A nota de **uma** venda, logo
   * abaixo, não precisa — quem fechou a comanda já viu aquele valor.
   *
   * A repartição do Salão-Parceiro é outra coisa e tem outro dono: ela é a
   * comissão do profissional naquela venda, e sai só para `commission.view_all`.
   */
  @Exige('fiscal.view', 'finance.view')
  @Get('notas')
  async notas(
    @Staff() staff: AuthenticatedStaff,
    @Query(new ZodValidationPipe(periodoDasNotasSchema)) query: { de: string; ate: string },
  ) {
    const local = await this.unidade(staff.tenantId);
    return {
      notas: await notasDoPeriodo({
        tenantId: staff.tenantId,
        locationId: local.id,
        de: query.de,
        ate: query.ate,
        /**
         * A repartição do Salão-Parceiro só sai para quem já vê a comissão de
         * todo mundo — e ela sai **da mesma função** que a API aplica, nunca
         * recalculada. Achado da `/security-review` deste bloco: a parcela do
         * profissional é a comissão dele naquela venda, e ela estava saindo sob
         * `fiscal.view`, que a recepcionista tem por padrão.
         */
        comRepartição: staff.permissions.includes('commission.view_all'),
      }),
    };
  }

  @Exige('fiscal.view')
  @Get('notas/comanda/:id')
  async daComanda(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    return { nota: await notaDaVenda(staff.tenantId, id) };
  }

  /**
   * Emitir à mão.
   *
   * É o caminho da barbearia que emite só quando o cliente pede — a esmagadora
   * maioria. A nota nasce `pendente` e quem fala com a prefeitura é a fila:
   * pendurá-la aqui deixaria o balcão esperando um serviço municipal que pode
   * levar minutos.
   */
  @Exige('fiscal.issue')
  @Post('notas/comanda/:id')
  async emitir(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    const local = await this.unidade(staff.tenantId);
    try {
      const criada = await withTenant(staff.tenantId, (tx) =>
        pedirNota(tx, {
          tenantId: staff.tenantId,
          locationId: local.id,
          orderId: id,
          staffId: staff.staffUserId,
          staffName: staff.name,
          automatica: false,
        }),
      );
      return criada ?? { id: null };
    } catch (erro) {
      return toHttp(erro);
    }
  }

  @Exige('fiscal.issue')
  @Post('notas/:id/cancelar')
  async cancelar(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(cancelamentoDeNotaSchema)) body: { motivo: string },
  ) {
    try {
      await cancelarNota({
        tenantId: staff.tenantId,
        invoiceId: id,
        motivo: body.motivo,
        provider: EMISSOR,
        staffId: staff.staffUserId,
        staffName: staff.name,
      });
      return { ok: true };
    } catch (erro) {
      return toHttp(erro);
    }
  }
}
