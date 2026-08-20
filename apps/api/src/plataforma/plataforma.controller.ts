import { createHash } from 'node:crypto';
import type { Request } from 'express';
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  abrirSuporte,
  bloquearBarbearia,
  confirmarCadastroDoSegundoFator,
  cancelarDestaque,
  casasDaFranquia,
  criarFranquia,
  entrarNaFranquia,
  franquiasNaPlataforma,
  sairDaFranquia,
  contestacoesNaPlataforma,
  definirComissaoDoMarketplace,
  definirRecurso,
  destaquesVendidos,
  reverterContestacao,
  venderDestaque,
  encerrarSuporteDaBarbearia,
  iniciarCadastroDoSegundoFator,
  listarRecursos,
  provarSegundoFator,
  recursosDaBarbearia,
  segundoFatorLigado,
  suportesAbertos,
  desbloquearBarbearia,
  entrarNaPlataforma,
  listarBarbearias,
  listarPlanos,
  PlataformaError,
  linhaDoTempoDaPlataforma,
  resumoDaPlataforma,
  saudeDasBarbearias,
  provaDaSessao,
  sairDaPlataforma,
  trilhaDaPlataforma,
  mudarPlanoDaAssinatura,
  assinaturaDaBarbearia,
  assinaturas,
  cancelarFatura,
  estornarCredito,
  estornosDaBarbearia,
  meioDePagamento,
  salvarMeioDePagamento,
  adquirenteDaPlataforma,
  faturasDaBarbearia,
  faturasEmCobranca,
  pagarFatura,
  type Fatura,
  cancelarAssinatura,
  reativarAssinatura,
  type AdminDaPlataforma,
} from '@barbearia/platform';
import { BloqueioDeLogin } from '@barbearia/identity';
import { DomainError } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { TenantService } from '../tenant/tenant.service.js';
import { AgeNaConta, Admin, PlataformaGuard, type RequisicaoDaPlataforma } from './plataforma.guard.js';
import {
  bloqueioSchema,
  cancelamentoSchema,
  comissaoDoMarketplaceSchema,
  destaqueSchema,
  entradaNaFranquiaSchema,
  franquiaSchema,
  motivoSchema,
  type EntradaDeDestaque,
  estornoSchema,
  meioDePagamentoSchema,
  pagamentoSchema,
  codigoSchema,
  janelaSchema,
  recursoSchema,
  suporteSchema,
  loginDaPlataformaSchema,
  tenantIdSchema,
  trilhaQuerySchema,
  trocaDePlanoSchema,
  type Bloqueio,
  type EntradaDeCancelamento,
  type EntradaDeEstorno,
  type EntradaDeMeioDePagamento,
  type EntradaDePagamento,
  type EntradaDeCodigo,
  type EntradaDeRecurso,
  type EntradaDeSuporte,
  type Janela,
  type TrilhaQuery,
  type TrocaDePlano,
} from './plataforma.schemas.js';

/**
 * O último dia que a apuração garante fechado.
 *
 * O dia anterior em UTC, que é o mesmo critério de `apuracaoPendente`. Mostrar
 * hoje pela metade faria toda comparação parecer queda logo depois do almoço.
 */
const ultimoDiaFechado = (agora = new Date()): string =>
  new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate() - 1))
    .toISOString()
    .slice(0, 10);

const STATUS: Record<string, number> = {
  invalid_credentials: 401,
  invalid_code: 401,
  mfa_required: 403,
  mfa_setup_required: 403,
  mfa_already_on: 409,
  mfa_not_started: 409,
  unknown_admin: 404,
  no_owner: 409,
  tenant_blocked: 409,
  no_support: 409,
  chairs_exceed_plan: 409,
  not_cancelable: 409,
  not_canceled: 409,
  unknown_plan: 404,
  unknown_tenant: 404,
  inactive_plan: 409,
  not_blockable: 409,
  not_blocked: 409,
  reason_required: 400,
  not_payable: 409,
  not_voidable: 409,
  no_payment_method: 409,
  no_acquirer: 409,
  no_charge_to_refund: 409,
  refund_refused: 409,
  insufficient_credit: 409,
  invalid_amount: 400,
  refund_failed: 500,
  email_taken: 409,
  weak_password: 400,
};

const tokenBruto = (requisicao: RequisicaoDaPlataforma): string | undefined =>
  /^Bearer (.+)$/.exec(requisicao.headers.authorization ?? '')?.[1];

/**
 * O hash do token desta requisição.
 *
 * A prova do segundo fator é gravada **na sessão**, e a sessão é identificada
 * pelo hash do token — que é o que o banco guarda. Passar o token em claro para
 * a camada de domínio faria o segredo circular por mais um lugar sem necessidade.
 */
const hashDoToken = (requisicao: RequisicaoDaPlataforma): string =>
  createHash('sha256').update(tokenBruto(requisicao) ?? '').digest('hex');

/** Datas viram texto na borda: o cliente HTTP não recebe `Date`. */
const paraJson = (a: Awaited<ReturnType<typeof assinaturaDaBarbearia>>) =>
  a === null
    ? null
    : {
        ...a,
        testeAte: a.testeAte?.toISOString() ?? null,
        periodoAte: a.periodoAte.toISOString(),
        canceladaEm: a.canceladaEm?.toISOString() ?? null,
      };

/** O extrato na borda: datas em texto, e sem a chave de idempotência do cliente. */
const faturaParaJson = (f: Fatura) => ({
  id: f.id,
  tenantId: f.tenantId,
  tipo: f.tipo,
  estado: f.estado,
  planoCode: f.planoCode,
  valorCents: f.valorCents,
  vencimento: f.vencimento.toISOString(),
  periodoDe: f.periodoInicio.toISOString(),
  periodoAte: f.periodoFim.toISOString(),
  tentativas: f.tentativas,
  vencidaEm: f.vencidaEm?.toISOString() ?? null,
  pagaEm: f.pagaEm?.toISOString() ?? null,
  metodo: f.metodo,
  canceladaEm: f.canceladaEm?.toISOString() ?? null,
  motivoDoCancelamento: f.motivoDoCancelamento,
});

function paraHttp(erro: unknown): never {
  /**
   * A escada de espera tem explicação e prazo — não é erro do servidor.
   *
   * Sem este ramo, `BloqueioDeLogin` caía no tratador genérico e virava **500**:
   * o Super Admin errava a senha seis vezes e na sétima lia "não foi possível
   * entrar, tente de novo" — que é a pior instrução possível, porque tentar de
   * novo rearma a escada. O login da barbearia tem o mesmo ramo desde o bloco
   * 33, com o comentário descrevendo exatamente este defeito; a porta da
   * plataforma ficou de fora.
   */
  if (erro instanceof BloqueioDeLogin) {
    throw new DomainError('too_many_attempts', 429, erro.message, {
      retryAfterSeconds: erro.esperarSegundos,
    });
  }
  if (erro instanceof PlataformaError) {
    throw new DomainError(erro.code, STATUS[erro.code] ?? 400, erro.message);
  }
  throw erro;
}

/** A porta — sem sessão, por definição. */
@Controller('v1/plataforma')
export class PlataformaAuthController {
  @Post('login')
  async login(
    @Body(new ZodValidationPipe(loginDaPlataformaSchema)) corpo: { email: string; senha: string },
    @Req() requisicao: Request,
  ) {
    try {
      /**
       * O IP entra na escada, como no login da barbearia.
       *
       * `entrarNaPlataforma` aceita `ip` e o documenta como "para a escada ser
       * por conta **e** aparelho"; o único chamador nunca o mandava. Com `ip`
       * nulo, a chave `(email_key, COALESCE(ip, '::'))` põe **toda tentativa de
       * um e-mail num balde só**, de qualquer origem — e o achado da revisão do
       * bloco 33 volta a valer nesta porta: errar de propósito uma senha a cada
       * meia hora, de qualquer endereço, tranca a conta mais privilegiada do
       * produto para fora dele.
       */
      const sessao = await entrarNaPlataforma({
        ...corpo,
        ...(requisicao.ip ? { ip: requisicao.ip } : {}),
      });
      return {
        token: sessao.token,
        admin: sessao.admin,
        expiraEm: sessao.expiraEm.toISOString(),
      };
    } catch (erro) {
      return paraHttp(erro);
    }
  }
}

/**
 * O painel da plataforma — **sessão de Super Admin obrigatória**.
 *
 * Nenhuma rota daqui lê agendamento, cliente, comanda ou caixa. O que este
 * controller alcança é o conjunto de tabelas da migração 0026, e é por isso que
 * ele pode ver todas as barbearias sem que nenhuma política de negócio tenha
 * sido afrouxada.
 */
@Controller('v1/plataforma')
@UseGuards(PlataformaGuard)
export class PlataformaController {
  constructor(@Inject(TenantService) private readonly tenants: TenantService) {}

  @Post('logout')
  async logout(@Req() requisicao: RequisicaoDaPlataforma) {
    // O token vem do cabeçalho, nunca do corpo: aceitá-lo do corpo deixaria
    // um admin derrubar a sessão de outro se algum dia vazasse um token.
    const token = /^Bearer (.+)$/.exec(requisicao.headers.authorization ?? '')?.[1];
    if (token) await sairDaPlataforma(token);
    return { revoked: true };
  }

  @Get('planos')
  async planos() {
    return { planos: await listarPlanos(true) };
  }

  @Get('barbearias')
  async barbearias(@Admin() admin: RequisicaoDaPlataforma['admin']) {
    const barbearias = await listarBarbearias();
    return {
      /**
       * O papel de quem está lendo, para a tela parar de mentir (bloco 113).
       *
       * Conta de plataforma nasce `viewer`, e o painel desenhava "Bloquear",
       * "Reativar" e "Entrar na conta" para todo mundo. O `viewer` clicava,
       * levava 403 e lia "não deu para concluir, tente de novo" — que é
       * exatamente o que a guarda escolheu 403 em vez de 404 para **evitar**.
       *
       * Sai daqui e não de um segundo cookie: o papel muda no banco, e um
       * cookie gravado no login continuaria dizendo o que era verdade ontem.
       */
      papel: admin?.papel ?? 'viewer',
      barbearias: barbearias.map((b) => ({
        ...b,
        bloqueadaEm: b.bloqueadaEm?.toISOString() ?? null,
        criadaEm: b.criadaEm.toISOString(),
      })),
    };
  }

  @AgeNaConta()
  @Put('barbearias/:tenantId/plano')
  async plano(
    @Param('tenantId', new ZodValidationPipe(tenantIdSchema)) tenantId: string,
    @Body(new ZodValidationPipe(trocaDePlanoSchema)) corpo: TrocaDePlano,
    @Admin() admin: AdminDaPlataforma,
  ) {
    try {
      await mudarPlanoDaAssinatura({ adminId: admin.id, tenantId, planoCode: corpo.planoCode });
      return { ok: true };
    } catch (erro) {
      return paraHttp(erro);
    }
  }

  // -- assinatura (bloco 27) -------------------------------------------------

  @Get('assinaturas')
  async listaDeAssinaturas() {
    const lista = await assinaturas();
    return { assinaturas: lista.map(paraJson) };
  }

  @Get('barbearias/:tenantId/assinatura')
  async assinatura(
    @Param('tenantId', new ZodValidationPipe(tenantIdSchema)) tenantId: string,
  ) {
    const assinatura = await assinaturaDaBarbearia(tenantId);
    if (!assinatura) throw new DomainError('unknown_tenant', 404, 'Barbearia não encontrada');
    return paraJson(assinatura);
  }

  @AgeNaConta()
  @Post('barbearias/:tenantId/cancelamento')
  async cancelar(
    @Param('tenantId', new ZodValidationPipe(tenantIdSchema)) tenantId: string,
    @Body(new ZodValidationPipe(cancelamentoSchema)) corpo: EntradaDeCancelamento,
    @Admin() admin: AdminDaPlataforma,
  ) {
    try {
      await cancelarAssinatura({ adminId: admin.id, tenantId, motivo: corpo.motivo });
      return { ok: true };
    } catch (erro) {
      return paraHttp(erro);
    }
  }

  @AgeNaConta()
  @Delete('barbearias/:tenantId/cancelamento')
  async reativar(
    @Param('tenantId', new ZodValidationPipe(tenantIdSchema)) tenantId: string,
    @Admin() admin: AdminDaPlataforma,
  ) {
    try {
      await reativarAssinatura({ adminId: admin.id, tenantId });
      return { ok: true };
    } catch (erro) {
      return paraHttp(erro);
    }
  }

  // -- cobrança (bloco 28) ---------------------------------------------------

  /** A fila do suporte: quem está em cobrança, de quem vence primeiro. */
  @Get('faturas')
  async emCobranca() {
    const faturas = await faturasEmCobranca();
    return { faturas: faturas.map(faturaParaJson) };
  }

  @Get('barbearias/:tenantId/faturas')
  async extrato(@Param('tenantId', new ZodValidationPipe(tenantIdSchema)) tenantId: string) {
    const faturas = await faturasDaBarbearia(tenantId);
    return { faturas: faturas.map(faturaParaJson) };
  }

  /**
   * Registra o pagamento que o Super Admin viu no extrato.
   *
   * É o caminho que **de fato** quita uma fatura hoje: até o bloco 29 não há
   * débito automático, e a régua conta com alguém dando a baixa. Quitar a
   * última fatura aberta destranca a barbearia suspensa pela régua — e só por
   * ela, porque bloqueio posto por gente tem motivo escrito e não tem boleto.
   */
  @AgeNaConta()
  @Post('faturas/:faturaId/pagamento')
  async pagar(
    @Param('faturaId', new ZodValidationPipe(tenantIdSchema)) faturaId: string,
    @Body(new ZodValidationPipe(pagamentoSchema)) corpo: EntradaDePagamento,
    @Admin() admin: AdminDaPlataforma,
  ) {
    try {
      const { tenantId } = await pagarFatura({ adminId: admin.id, faturaId, metodo: corpo.metodo });
      // Quitar destranca, e sem isto a barbearia continuaria fora do ar por até
      // meio minuto depois de o painel dizer que ela voltou.
      this.tenants.esquecerBloqueio(tenantId);
      return { ok: true };
    } catch (erro) {
      return paraHttp(erro);
    }
  }

  /** Perdoa a fatura. Não é o mesmo que pagar, e o relatório distingue as duas. */
  @AgeNaConta()
  @Delete('faturas/:faturaId')
  async anular(
    @Param('faturaId', new ZodValidationPipe(tenantIdSchema)) faturaId: string,
    @Body(new ZodValidationPipe(cancelamentoSchema)) corpo: EntradaDeCancelamento,
    @Admin() admin: AdminDaPlataforma,
  ) {
    try {
      const { tenantId } = await cancelarFatura({ adminId: admin.id, faturaId, motivo: corpo.motivo });
      this.tenants.esquecerBloqueio(tenantId);
      return { ok: true };
    } catch (erro) {
      return paraHttp(erro);
    }
  }

  // -- adquirente (bloco 29) -------------------------------------------------

  /**
   * O meio de pagamento da barbearia.
   *
   * Devolve marca, final e validade — e nada mais existe para devolver: o
   * schema da migração 0031 não tem coluna para o número do cartão. O
   * identificador do adquirente fica de fora da resposta de propósito: ele não
   * serve para nenhuma tela e circular menos é melhor.
   */
  @Get('barbearias/:tenantId/cobranca')
  async meio(@Param('tenantId', new ZodValidationPipe(tenantIdSchema)) tenantId: string) {
    const meio = await meioDePagamento(tenantId);
    return {
      meio: meio
        ? {
            bandeira: meio.bandeira,
            final: meio.final,
            validadeMes: meio.validadeMes,
            validadeAno: meio.validadeAno,
            cadastrado: meio.pspMethodId !== null,
          }
        : null,
      estornos: (await estornosDaBarbearia(tenantId)).map((e) => ({
        id: e.id,
        valorCents: e.valorCents,
        motivo: e.motivo,
        estado: e.estado,
        criadoEm: e.criadoEm.toISOString(),
      })),
    };
  }

  /**
   * As franquias montadas (bloco 76).
   *
   * Montar uma franquia é operação **entre tenants**, e não existe lugar dentro
   * de uma barbearia de onde ela possa ser feita: a RLS separa barbearias, e é
   * para isso que ela existe. Depois de montada, a franquia é dos dois lados
   * dela — a plataforma não publica cardápio nem vê preço praticado.
   */
  @Get('franquias')
  async franquias() {
    return { franquias: await franquiasNaPlataforma() };
  }

  @Get('franquias/:franquiaId/casas')
  async casasDaRede(
    @Param('franquiaId', new ZodValidationPipe(tenantIdSchema)) franquiaId: string,
  ) {
    return { casas: await casasDaFranquia(franquiaId) };
  }

  /**
   * Cria a franquia com a franqueadora já dentro, e concede `franchise.manage`
   * ao dono dela na mesma operação — é o único instante em que se sabe que
   * aquela barbearia é uma franqueadora.
   */
  @AgeNaConta()
  @Post('franquias')
  async montarFranquia(
    @Body(new ZodValidationPipe(franquiaSchema)) corpo: { nome: string; tenantId: string },
    @Admin() admin: AdminDaPlataforma,
  ) {
    try {
      return await criarFranquia({
        adminId: admin.id,
        nome: corpo.nome,
        franqueadoraTenantId: corpo.tenantId,
      });
    } catch (erro) {
      return paraHttp(erro);
    }
  }

  /**
   * Põe uma barbearia na franquia, sempre como **franqueada**.
   *
   * O papel não vem do corpo: é o precedente do convite do barbeiro no bloco 29,
   * e aqui vale mais ainda — `franqueadora` é quem escreve o padrão da rede
   * inteira.
   */
  @AgeNaConta()
  @Post('franquias/:franquiaId/casas')
  async porNaFranquia(
    @Param('franquiaId', new ZodValidationPipe(tenantIdSchema)) franquiaId: string,
    @Body(new ZodValidationPipe(entradaNaFranquiaSchema)) corpo: { tenantId: string },
    @Admin() admin: AdminDaPlataforma,
  ) {
    try {
      await entrarNaFranquia({ adminId: admin.id, franquiaId, tenantId: corpo.tenantId });
      return { ok: true };
    } catch (erro) {
      return paraHttp(erro);
    }
  }

  @AgeNaConta()
  @Delete('franquias/casas/:tenantId')
  async tirarDaFranquia(
    @Param('tenantId', new ZodValidationPipe(tenantIdSchema)) tenantId: string,
    @Admin() admin: AdminDaPlataforma,
  ) {
    try {
      await sairDaFranquia({ adminId: admin.id, tenantId });
      return { ok: true };
    } catch (erro) {
      return paraHttp(erro);
    }
  }

  /**
   * Os destaques vendidos (bloco 75).
   *
   * Leitura, então sem `@AgeNaConta`: a polaridade daquele decorador é o
   * inverso do `@Exige` — toda conta de plataforma já lê tudo, e o que se
   * separa é o que se **faz**.
   */
  @Get('destaques')
  async destaques() {
    return { destaques: await destaquesVendidos() };
  }

  /**
   * Vende um destaque. Age sobre a conta: emite fatura.
   *
   * Não existe rota da barbearia que crie anúncio — destaque é vendido, não
   * solicitado, e é o que impede a lista de virar leilão automático.
   */
  @AgeNaConta()
  @Post('barbearias/:tenantId/destaques')
  async venderDestaqueNaConta(
    @Param('tenantId', new ZodValidationPipe(tenantIdSchema)) tenantId: string,
    @Body(new ZodValidationPipe(destaqueSchema)) corpo: EntradaDeDestaque,
    @Admin() admin: AdminDaPlataforma,
  ) {
    try {
      return await venderDestaque({
        adminId: admin.id,
        tenantId,
        // Ausente é a unidade primária, a mais antiga — a mesma que a página
        // pública mostra. A rede que quiser destacar outra loja manda o id.
        ...(corpo.locationId ? { locationId: corpo.locationId } : {}),
        lugar: corpo.lugar,
        de: new Date(`${corpo.de}T00:00:00Z`),
        ate: new Date(`${corpo.ate}T00:00:00Z`),
      });
    } catch (erro) {
      return paraHttp(erro);
    }
  }

  @AgeNaConta()
  @Post('destaques/:anuncioId/cancelamento')
  async cancelarDestaqueVendido(
    @Param('anuncioId', new ZodValidationPipe(tenantIdSchema)) anuncioId: string,
    @Body(new ZodValidationPipe(motivoSchema)) corpo: { motivo: string },
    @Admin() admin: AdminDaPlataforma,
  ) {
    try {
      await cancelarDestaque({ adminId: admin.id, anuncioId, motivo: corpo.motivo });
      return { ok: true };
    } catch (erro) {
      return paraHttp(erro);
    }
  }

  /**
   * As contestações de comissão, e a reversão de uma indevida (bloco 75).
   *
   * Fecha a lacuna do bloco 72: a renúncia era definitiva do lado da barbearia,
   * porque o índice único faz aquele cliente nunca mais gerar comissão. O nome
   * do cliente não sai — para a plataforma a pergunta é "esta renúncia se
   * explica?", e quem responde isso é o motivo escrito.
   */
  @Get('contestacoes')
  async contestacoes() {
    return { contestacoes: await contestacoesNaPlataforma() };
  }

  @AgeNaConta()
  @Post('contestacoes/:atribuicaoId/reversao')
  async reverter(
    @Param('atribuicaoId', new ZodValidationPipe(tenantIdSchema)) atribuicaoId: string,
    @Body(new ZodValidationPipe(motivoSchema)) corpo: { motivo: string },
    @Admin() admin: AdminDaPlataforma,
  ) {
    try {
      await reverterContestacao({ adminId: admin.id, atribuicaoId, motivo: corpo.motivo });
      return { ok: true };
    } catch (erro) {
      return paraHttp(erro);
    }
  }

  /**
   * A alíquota do marketplace desta barbearia (bloco 72, SPEC §5.2).
   *
   * `@AgeNaConta` porque isto **age**: muda quanto a barbearia paga. E mora do
   * lado da plataforma porque é termo comercial do produto — numa rota do
   * painel da barbearia, zerá-la desligaria a receita sem nada falhar, que é o
   * achado da revisão do bloco 49.
   */
  @AgeNaConta()
  @Put('barbearias/:tenantId/marketplace')
  async definirComissao(
    @Param('tenantId', new ZodValidationPipe(tenantIdSchema)) tenantId: string,
    @Body(new ZodValidationPipe(comissaoDoMarketplaceSchema)) corpo: { feeBps: number },
    @Admin() admin: AdminDaPlataforma,
  ) {
    try {
      await definirComissaoDoMarketplace({ adminId: admin.id, tenantId, feeBps: corpo.feeBps });
      return { ok: true };
    } catch (erro) {
      return paraHttp(erro);
    }
  }

  @AgeNaConta()
  @Put('barbearias/:tenantId/cobranca')
  async salvarMeio(
    @Param('tenantId', new ZodValidationPipe(tenantIdSchema)) tenantId: string,
    @Body(new ZodValidationPipe(meioDePagamentoSchema)) corpo: EntradaDeMeioDePagamento,
    @Admin() admin: AdminDaPlataforma,
  ) {
    try {
      await salvarMeioDePagamento({ adminId: admin.id, tenantId, ...corpo });
      return { ok: true };
    } catch (erro) {
      return paraHttp(erro);
    }
  }

  /**
   * Devolve em dinheiro o crédito que a descida de plano gerou.
   *
   * A lacuna que o bloco 28 declarou, fechada no 34. O provedor sai de
   * `adquirenteDaPlataforma()` — a mesma função que o worker usa —, e é isso
   * que impede o estado em que a régua debita de verdade enquanto o estorno
   * devolve dinheiro de mentira. Sem `PSP_MODO` não há adquirente, e devolver
   * dinheiro volta a ser trabalho de quem tem acesso ao extrato.
   */
  @AgeNaConta()
  @Post('barbearias/:tenantId/estorno')
  async estornar(
    @Param('tenantId', new ZodValidationPipe(tenantIdSchema)) tenantId: string,
    @Body(new ZodValidationPipe(estornoSchema)) corpo: EntradaDeEstorno,
    @Admin() admin: AdminDaPlataforma,
  ) {
    try {
      const provider = adquirenteDaPlataforma();
      if (provider === null) {
        // Recusa em vez de fingir. Um estorno "feito" sem adquirente sairia do
        // crédito da barbearia sem sair de conta nenhuma — o dinheiro some do
        // saldo dela e não chega em lugar algum.
        throw new PlataformaError('no_acquirer', 'Não há adquirente configurado');
      }
      const estorno = await estornarCredito({
        adminId: admin.id,
        tenantId,
        valorCents: corpo.valorCents,
        motivo: corpo.motivo,
        provider,
      });
      return { id: estorno.id, valorCents: estorno.valorCents, estado: estorno.estado };
    } catch (erro) {
      return paraHttp(erro);
    }
  }

  @AgeNaConta()
  @Post('barbearias/:tenantId/bloqueio')
  async bloquear(
    @Param('tenantId', new ZodValidationPipe(tenantIdSchema)) tenantId: string,
    @Body(new ZodValidationPipe(bloqueioSchema)) corpo: Bloqueio,
    @Admin() admin: AdminDaPlataforma,
  ) {
    try {
      await bloquearBarbearia({ adminId: admin.id, tenantId, motivo: corpo.motivo });
      // Sem isto o bloqueio só valeria depois do TTL: a barbearia continuaria
      // atendendo por meio minuto depois de o painel dizer que ela parou.
      this.tenants.esquecerBloqueio(tenantId);
      return { ok: true };
    } catch (erro) {
      return paraHttp(erro);
    }
  }

  @AgeNaConta()
  @Delete('barbearias/:tenantId/bloqueio')
  async desbloquear(
    @Param('tenantId', new ZodValidationPipe(tenantIdSchema)) tenantId: string,
    @Admin() admin: AdminDaPlataforma,
  ) {
    try {
      await desbloquearBarbearia({ adminId: admin.id, tenantId });
      this.tenants.esquecerBloqueio(tenantId);
      return { ok: true };
    } catch (erro) {
      return paraHttp(erro);
    }
  }

  @Get('metricas')
  async metricas(@Query(new ZodValidationPipe(janelaSchema)) query: Janela) {
    const ate = query.ate ?? ultimoDiaFechado();
    return { ate, resumo: await resumoDaPlataforma({ ate, dias: query.dias }) };
  }

  /**
   * A linha do tempo: MRR mês a mês, safra de entrada, curva de retenção.
   *
   * Sem `@AgeNaConta`, e a ausência é o que libera: a polaridade do decorador da
   * plataforma é o inverso do `@Exige` — toda conta de plataforma já lê tudo, e o
   * que se separa é o que se **faz**. Esta rota só lê.
   */
  @Get('linha-do-tempo')
  async linhaDoTempo() {
    return { linha: await linhaDoTempoDaPlataforma() };
  }

  @Get('saude')
  async saude(@Query(new ZodValidationPipe(janelaSchema)) query: Janela) {
    const ate = query.ate ?? ultimoDiaFechado();
    return { ate, barbearias: await saudeDasBarbearias({ ate, dias: query.dias }) };
  }

  // -- segundo fator (bloco 26) ----------------------------------------------

  @Get('mfa')
  async mfa(@Req() requisicao: RequisicaoDaPlataforma, @Admin() admin: AdminDaPlataforma) {
    return {
      ligado: await segundoFatorLigado(admin.id),
      provado: await provaDaSessao(hashDoToken(requisicao), new Date()),
    };
  }

  @Post('mfa')
  async cadastrarMfa(
    @Admin() admin: AdminDaPlataforma,
    @Body() corpo: { email?: unknown } | undefined,
  ) {
    try {
      /**
       * O e-mail entra só no rótulo do QR Code — o banco guarda o HMAC dele, e
       * decifrar não é possível nem desejável.
       *
       * `corpo` pode chegar indefinido: um POST sem corpo nem `content-type`
       * não passa pelo interpretador de JSON, e ler `.email` ali derrubava a
       * rota com 500. O campo sempre foi opcional; faltava o caminho em que
       * **nada** é enviado, que é o que um cliente enxuto faz.
       */
      const email = typeof corpo?.email === 'string' ? corpo.email : admin.nome;
      return await iniciarCadastroDoSegundoFator({ adminId: admin.id, email });
    } catch (erro) {
      return paraHttp(erro);
    }
  }

  @Post('mfa/confirmar')
  async confirmarMfa(
    @Admin() admin: AdminDaPlataforma,
    @Body(new ZodValidationPipe(codigoSchema)) corpo: EntradaDeCodigo,
  ) {
    try {
      await confirmarCadastroDoSegundoFator({ adminId: admin.id, codigo: corpo.codigo });
      return { ok: true };
    } catch (erro) {
      return paraHttp(erro);
    }
  }

  @Post('mfa/provar')
  async provarMfa(
    @Req() requisicao: RequisicaoDaPlataforma,
    @Admin() admin: AdminDaPlataforma,
    @Body(new ZodValidationPipe(codigoSchema)) corpo: EntradaDeCodigo,
  ) {
    try {
      return await provarSegundoFator({
        adminId: admin.id,
        tokenHash: hashDoToken(requisicao),
        codigo: corpo.codigo,
      });
    } catch (erro) {
      return paraHttp(erro);
    }
  }

  // -- recursos (bloco 26) ---------------------------------------------------

  @Get('recursos')
  async recursos() {
    return { recursos: await listarRecursos() };
  }

  @Get('barbearias/:tenantId/recursos')
  async recursosDa(
    @Param('tenantId', new ZodValidationPipe(tenantIdSchema)) tenantId: string,
  ) {
    return { recursos: await recursosDaBarbearia(tenantId) };
  }

  @AgeNaConta()
  @Put('barbearias/:tenantId/recursos')
  async definirRecursoDa(
    @Param('tenantId', new ZodValidationPipe(tenantIdSchema)) tenantId: string,
    @Body(new ZodValidationPipe(recursoSchema)) corpo: EntradaDeRecurso,
    @Admin() admin: AdminDaPlataforma,
  ) {
    try {
      await definirRecurso({ adminId: admin.id, tenantId, ...corpo });
      return { ok: true };
    } catch (erro) {
      return paraHttp(erro);
    }
  }

  // -- suporte assistido (bloco 26) ------------------------------------------

  @Get('suporte')
  async suporte() {
    const abertos = await suportesAbertos();
    return {
      suportes: abertos.map((s) => ({
        ...s,
        abertoEm: s.abertoEm.toISOString(),
        expiraEm: s.expiraEm.toISOString(),
      })),
    };
  }

  @AgeNaConta()
  @Post('barbearias/:tenantId/suporte')
  async entrarNaConta(
    @Param('tenantId', new ZodValidationPipe(tenantIdSchema)) tenantId: string,
    @Body(new ZodValidationPipe(suporteSchema)) corpo: EntradaDeSuporte,
    @Admin() admin: AdminDaPlataforma,
    @Req() requisicao: RequisicaoDaPlataforma,
  ) {
    try {
      const sessao = await abrirSuporte({
        adminId: admin.id,
        adminNome: admin.nome,
        tokenDaPlataforma: tokenBruto(requisicao) ?? '',
        tenantId,
        motivo: corpo.motivo,
      });
      return {
        token: sessao.token,
        expiraEm: sessao.expiraEm.toISOString(),
        barbearia: sessao.barbearia,
        gestor: sessao.gestor,
      };
    } catch (erro) {
      return paraHttp(erro);
    }
  }

  @AgeNaConta()
  @Delete('barbearias/:tenantId/suporte')
  async sairDaConta(
    @Param('tenantId', new ZodValidationPipe(tenantIdSchema)) tenantId: string,
    @Admin() admin: AdminDaPlataforma,
  ) {
    try {
      await encerrarSuporteDaBarbearia({
        adminId: admin.id,
        adminNome: admin.nome,
        tenantId,
      });
      return { ok: true };
    } catch (erro) {
      return paraHttp(erro);
    }
  }

  @Get('trilha')
  async trilha(@Query(new ZodValidationPipe(trilhaQuerySchema)) query: TrilhaQuery) {
    const eventos = await trilhaDaPlataforma(query.limite);
    return { eventos: eventos.map((e) => ({ ...e, quando: e.quando.toISOString() })) };
  }
}
