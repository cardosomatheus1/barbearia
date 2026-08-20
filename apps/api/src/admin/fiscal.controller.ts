import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import {
  FiscalError,
  cancelarNota,
  configuracaoFiscal,
  salvarConfiguracaoFiscal,
  notaDaVenda,
  notasDoPeriodo,
  pedirNota,
  salvarDocumentoDoCliente,
  tomadorDaVenda,
  emissorFiscal,
} from '@barbearia/finance';
import { pode, type FiscalProvider, type RegimeFiscal } from '@barbearia/core';
import { withTenant } from '@barbearia/db';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard, Recurso } from './permissao.guard.js';
import { uuidSchema } from './caixa.schemas.js';
import { unidadeDoBalcao } from './unidade.js';
import {
  cancelamentoDeNotaSchema,
  configuracaoFiscalSchema,
  documentoDoTomadorSchema,
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
  documento_invalido: 400,
  cliente_nao_encontrado: 404,
};

function toHttp(erro: unknown): never {
  if (erro instanceof FiscalError) {
    throw new DomainError(erro.code, STATUS[erro.code] ?? 400, erro.message, erro.motivo);
  }
  throw erro;
}

/**
 * O emissor sai de `FISCAL_MODO`, e pode ser **nenhum**.
 *
 * Antes era `new FakeFiscalProvider()` fixo aqui e outro fixo no worker — dois
 * lugares para ligar o emissor de verdade, e o que acontece é ligar num e
 * esquecer no outro. Pior: em produção o falso aceitava o pedido e devolvia
 * `processando`, então a nota ficava nesse estado **para sempre**, sem erro e
 * sem log, com o cliente tendo pedido nota fiscal.
 *
 * `null` faz a rota recusar com mensagem, que é a única resposta honesta quando
 * não há emissor contratado.
 */
const EMISSOR = emissorFiscal();

/** A recusa é a mesma nas duas rotas que falam com o emissor. */
function exigirEmissor(): FiscalProvider {
  if (!EMISSOR) {
    throw new DomainError(
      'fiscal_indisponivel',
      503,
      'A emissão de nota não está disponível: nenhum emissor está configurado nesta instalação.',
    );
  }
  return EMISSOR;
}

/**
 * O controller inteiro é gateado pelo recurso, e não rota por rota.
 *
 * `@Recurso` no método deixaria a próxima rota fiscal nascer aberta — é a mesma
 * razão de `@Exige` ser cobrado por varredura. Enquanto o recurso está
 * desligado, todas respondem **404**: para quem está do outro lado, um recurso
 * que a plataforma não ligou não existe.
 */
@Controller('v1/admin/fiscal')
@Recurso('fiscal')
@UseGuards(StaffGuard, PermissaoGuard)
export class FiscalController {
  private async unidade(staff: AuthenticatedStaff) {
    return unidadeDoBalcao(staff);
  }

  @Exige('fiscal.settings')
  @Get('configuracao')
  async configuracao(@Staff() staff: AuthenticatedStaff) {
    const local = await this.unidade(staff);
    return {
      configuracao: await configuracaoFiscal(staff.tenantId, local.id),
      /**
       * A tela precisa **dizer** que não há emissor, e não descobrir no clique.
       *
       * É a convenção do repositório: *gatilho ou opção que ainda não funciona
       * aparece na tela marcado, nunca escondido.* Escondê-lo faria a SPEC
       * parecer entregue; deixá-lo sem aviso faz a barbearia cadastrar CNPJ,
       * alíquota e código de serviço, pedir a nota, e concluir que o produto
       * está quebrado.
       */
      disponivel: EMISSOR !== null,
    };
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
    const local = await this.unidade(staff);
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
   *
   * ## O nome do tomador é **redigido**, não recusado
   *
   * A listagem devolve `clienteNome`, e nesta casa identidade de cliente é
   * `customers.view`. Somá-la ao `@Exige` era o conserto óbvio e estava
   * errado: `@Exige` é conjuntivo, e um papel "Contador" — `fiscal.view` mais
   * `finance.view`, sem ficha de cliente — ficava de fora de "as notas do mês
   * saíram?", que é a pergunta inteira daquela tela. Estado sem saída na
   * interface criado por uma permissão que protege um campo só.
   *
   * A rota irmã, por comanda, continua **recusando**: ali o tomador é o
   * assunto, e uma nota sem saber para quem ela vai não responde nada.
   *
   * O CPF continua fora de `NotaNaTela`, que é a outra metade do conserto do
   * bloco 54 e essa se manteve.
   */
  @Exige('fiscal.view', 'finance.view')
  @Get('notas')
  async notas(
    @Staff() staff: AuthenticatedStaff,
    @Query(new ZodValidationPipe(periodoDasNotasSchema)) query: { de: string; ate: string },
  ) {
    const local = await this.unidade(staff);
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
        podeVerCliente: pode(staff.permissions, 'customers.view'),
      }),
    };
  }

  /**
   * A nota desta venda, e quem é o tomador dela.
   *
   * Os dois juntos porque a tela é uma só e a pergunta do balcão também: "esta
   * venda tem nota, e ela vai sair no CPF de quem?". Duas rotas fariam a tela
   * pedir duas vezes a mesma coisa.
   *
   * O documento vem do **cadastro**, não da nota: é o que o balcão edita. O da
   * nota já emitida está congelado e não muda mais.
   *
   * E é por isso que ela declara `customers.view` **junto**: o que sai daqui é
   * nome e CPF lidos do cadastro vivo, não da nota. Rota que agrega declara
   * todas as permissões do que devolve — foi o achado do bloco 31, e a
   * `/security-review` deste bloco encontrou a mesma forma aqui. Sem a segunda,
   * um papel "Contador" com `fiscal.view` e sem `customers.*` — configuração
   * natural, e a razão de os papéis serem editáveis desde o bloco 30 — colhia
   * nome e CPF de todo cliente que já pediu nota, percorrendo os ids da
   * listagem. O CPF é o identificador que atravessa qualquer outra base.
   *
   * Repare que a projeção da nota (`NotaNaTela`) **não** traz o
   * `customer_document` congelado, de propósito. Era só o cadastro vivo que
   * vazava, pela rota que ninguém olharia.
   */
  @Exige('fiscal.view', 'customers.view')
  @Get('notas/comanda/:id')
  async daComanda(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    const local = await this.unidade(staff);
    return {
      nota: await notaDaVenda(staff.tenantId, local.id, id),
      tomador: await tomadorDaVenda(staff.tenantId, local.id, id),
    };
  }

  /**
   * O CPF do tomador, digitado no balcão.
   *
   * `customers.edit` e não uma permissão própria: é edição de cadastro, não
   * decisão de dinheiro nem de risco — a diferença do limite de fiado e do
   * override de score, que ganharam permissão separada justamente por moverem
   * valor. Quem digita é a recepção, que já cadastra e corrige cliente.
   *
   * A rota mora **aqui** e não na ficha do cliente por causa de quem usa: a
   * ficha exige `customers.view_notes`, que a recepção não tem por padrão, e é
   * a recepção quem ouve "põe meu CPF na nota" com a maquininha na mão.
   */
  @Exige('customers.edit')
  @Put('tomador/:id')
  async documento(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(documentoDoTomadorSchema)) body: { documento: string | null },
  ) {
    try {
      return await salvarDocumentoDoCliente({
        tenantId: staff.tenantId,
        customerId: id,
        documento: body.documento,
        staffId: staff.staffUserId,
        staffName: staff.name,
      });
    } catch (erro) {
      return toHttp(erro);
    }
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
    const local = await this.unidade(staff);
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
      const local = await this.unidade(staff);
      await cancelarNota({
        tenantId: staff.tenantId,
        locationId: local.id,
        invoiceId: id,
        motivo: body.motivo,
        provider: exigirEmissor(),
        staffId: staff.staffUserId,
        staffName: staff.name,
      });
      return { ok: true };
    } catch (erro) {
      return toHttp(erro);
    }
  }
}
