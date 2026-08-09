import { Body, Controller, Get, Headers, Post, UseGuards } from '@nestjs/common';
import {
  assinaturaDaBarbearia,
  faturasDaBarbearia,
  meioDePagamento,
  PlataformaError,
  planosParaODono,
  recursosDaBarbearia,
  trocarPlanoPeloDono,
} from '@barbearia/platform';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { badRequest, DomainError, notFound } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { trocaDePlanoSchema } from './plano.schemas.js';

/**
 * O plano, visto pela barbearia que paga por ele.
 *
 * A assinatura nasceu no bloco 27 dentro do painel da plataforma, e ficar só
 * lá seria o defeito de sempre pelo avesso: o dado existe, é cobrado, e a
 * pessoa de quem se cobra não consegue vê-lo. Quando a régua do bloco 28
 * começar a mandar aviso de vencimento, é para esta tela que ela vai apontar.
 *
 * **A troca chegou no bloco 28**, junto com o rateio proporcional que ela
 * exigia: mudar de faixa no meio do período muda quanto se cobra, e um botão
 * sem essa conta cobraria mês cheio por meio mês.
 *
 * `settings.manage` e não `finance.view`: o que está aqui é o contrato do
 * software, não o dinheiro da barbearia. Exigir a permissão de finanças
 * obrigaria o segundo fator para ler o próprio plano, e o dono que ainda não
 * cadastrou o autenticador ficaria sem saber por que a conta dele vai vencer.
 */
@Controller('v1/admin/plano')
@UseGuards(StaffGuard, PermissaoGuard)
export class PlanoController {
  @Exige('settings.manage')
  @Get()
  async plano(@Staff() staff: AuthenticatedStaff) {
    const assinatura = await assinaturaDaBarbearia(staff.tenantId);
    if (!assinatura) throw notFound('unknown_subscription', 'Assinatura não encontrada');

    const [recursos, meio] = await Promise.all([
      recursosDaBarbearia(staff.tenantId),
      meioDePagamento(staff.tenantId),
    ]);

    return {
      plano: {
        code: assinatura.planoCode,
        nome: assinatura.planoNome,
        publico: assinatura.publico,
        precoCents: assinatura.precoCents,
      },
      estado: assinatura.estado,
      testeAte: assinatura.testeAte?.toISOString() ?? null,
      periodoAte: assinatura.periodoAte.toISOString(),
      cadeiras: { emUso: assinatura.cadeirasEmUso, teto: assinatura.tetoDeCadeiras },
      /**
       * O cartão que a plataforma vai debitar (bloco 29).
       *
       * Marca, final e validade — o que o dono precisa para reconhecer qual
       * cartão está na conta, e nada além. O identificador do adquirente fica
       * de fora: ele não serve para nenhuma tela, e circular menos é melhor.
       */
      cobranca: meio
        ? {
            bandeira: meio.bandeira,
            final: meio.final,
            validadeMes: meio.validadeMes,
            validadeAno: meio.validadeAno,
            cadastrado: meio.pspMethodId !== null,
          }
        : null,
      /**
       * Os recursos com a origem de cada resposta.
       *
       * `noPlano` é o que separa "você tem isto porque paga por ele" de "você
       * tem isto de cortesia". Sem a distinção, a tela deixaria o dono do
       * Starter achar que fila de espera veio no pacote — e reclamar quando a
       * cortesia acabar.
       */
      recursos: recursos.map((r) => ({
        code: r.code,
        nome: r.nome,
        descricao: r.descricao,
        ligado: r.ligado,
        noPlano: r.noPlano,
      })),
    };
  }

  /**
   * As faixas oferecidas, com o que cada troca custaria **hoje**.
   *
   * O rateio vem do domínio e não da tela: é a mesma conta que a troca aplica.
   * Um preço calculado na view diverge do cobrado no primeiro ajuste, e a
   * divergência aparece como cobrança que ninguém sabe explicar.
   */
  @Exige('settings.manage')
  @Get('opcoes')
  async opcoes(@Staff() staff: AuthenticatedStaff) {
    const planos = await planosParaODono({ tenantId: staff.tenantId, agora: new Date() });
    return planos.map((p) => ({
      code: p.code,
      nome: p.nome,
      publico: p.publico,
      precoCents: p.precoCents,
      tetoDeCadeiras: p.tetoDeCadeiras,
      atual: p.atual,
      impedimento: p.impedimento,
      cobrarCents: p.rateio.cobrarCents,
      creditarCents: p.rateio.creditarCents,
      diasRestantes: p.rateio.diasRestantes,
    }));
  }

  /** O extrato da barbearia. A RLS de `invoices` já o limita ao próprio tenant. */
  @Exige('settings.manage')
  @Get('faturas')
  async faturas(@Staff() staff: AuthenticatedStaff) {
    const faturas = await faturasDaBarbearia(staff.tenantId);
    return faturas.map((f) => ({
      id: f.id,
      tipo: f.tipo,
      estado: f.estado,
      planoCode: f.planoCode,
      valorCents: f.valorCents,
      vencimento: f.vencimento.toISOString(),
      periodoDe: f.periodoInicio.toISOString(),
      periodoAte: f.periodoFim.toISOString(),
      pagaEm: f.pagaEm?.toISOString() ?? null,
      canceladaEm: f.canceladaEm?.toISOString() ?? null,
    }));
  }

  /**
   * A troca de plano pelo autoatendimento.
   *
   * `Idempotency-Key` porque **move dinheiro**: subir de plano emite o acerto
   * do que falta do período, e o segundo clique do botão não pode virar a
   * segunda cobrança. A chave é escopada pelo operador antes de chegar ao
   * domínio — ela vem do cliente e é livre, e duas pessoas com `settings.manage`
   * mandando `"1"` colidiriam.
   */
  @Exige('settings.manage')
  @Post()
  async trocar(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(trocaDePlanoSchema)) corpo: { planoCode: string },
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (idempotencyKey !== undefined && (idempotencyKey === '' || idempotencyKey.length > 128)) {
      throw badRequest('invalid_request', 'Idempotency-Key com tamanho inválido');
    }

    try {
      const { rateio, faturaId } = await trocarPlanoPeloDono({
        tenantId: staff.tenantId,
        planoCode: corpo.planoCode,
        agora: new Date(),
        ...(idempotencyKey ? { idempotencyKey: `${staff.staffUserId}:${idempotencyKey}` } : {}),
      });
      return {
        cobrarCents: rateio.cobrarCents,
        creditarCents: rateio.creditarCents,
        faturaId,
      };
    } catch (erro) {
      return paraHttp(erro);
    }
  }
}

const STATUS: Record<string, number> = {
  unknown_plan: 404,
  unknown_tenant: 404,
  inactive_plan: 409,
  same_plan: 409,
  plan_not_self_service: 409,
  chairs_exceed_plan: 409,
  invoice_failed: 500,
};

/**
 * A recusa do domínio vira status HTTP aqui, e o texto vai junto.
 *
 * É uma das poucas em que a mensagem do domínio chega ao cliente inteira, e é
 * de propósito: "a barbearia tem 8 cadeiras e este plano permite 5" é o que o
 * dono precisa ler para saber o que fazer. Erro genérico aqui produziria um
 * botão que não funciona sem dizer por quê.
 */
function paraHttp(erro: unknown): never {
  if (erro instanceof PlataformaError) {
    throw new DomainError(erro.code, STATUS[erro.code] ?? 400, erro.message);
  }
  throw erro;
}
