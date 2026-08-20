import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  abrirCaixa,
  abrirComanda,
  cancelarComanda,
  comandasAbertas,
  adicionarItem,
  ajustarComanda,
  caixaAberto,
  CaixaError,
  cancelarCobranca as cancelarCobrancaDaComanda,
  CobrancaError,
  cobrancasDaComanda,
  Comanda,
  ComandaError,
  comandaVisivel,
  criarCobrancaDaComanda,
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
import {
  diaNaUnidade,
  pode,
  type DescontoDaComanda,
  type MeioDePagamento,
  type Pagamento,
  type TipoDeItem,
} from '@barbearia/core';
import { adquirenteDaComanda } from '@barbearia/platform';
import type { AuthenticatedStaff } from '@barbearia/identity';
import { badRequest, DomainError, notFound } from '../common/errors.js';
import { ZodValidationPipe } from '../common/zod.pipe.js';
import { Staff, StaffGuard } from './staff.guard.js';
import { Exige, PermissaoGuard } from './permissao.guard.js';
import { unidadeDoBalcao } from './unidade.js';
import {
  abrirCaixaSchema,
  abrirComandaSchema,
  ajusteSchema,
  diaSchema,
  fecharCaixaSchema,
  cobrancaSchema,
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
  // 409 e não 400: a entrada é válida, o que a recusa é a política da
  // barbearia. A mensagem carrega o teto em reais, porque "recusado" sem o
  // número manda a recepção adivinhar.
  desconto_acima_do_teto: 409,
  // 409 e não 400: já existe um QR Code vivo para esta comanda, e é isso que
  // impede o cliente de pagar duas vezes.
  cobranca_em_curso: 409,
  cobranca_encerrada: 409,
  cobranca_nao_encontrada: 404,
  comanda_sem_valor: 409,
};

function toHttp(error: unknown): never {
  if (
    error instanceof CaixaError ||
    error instanceof ComandaError ||
    error instanceof CobrancaError
  ) {
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
  private async unidade(staff: AuthenticatedStaff) {
    return unidadeDoBalcao(staff);
  }

  // -- Caixa ------------------------------------------------------------------

  @Exige('cashier.open')
  @Get('cash')
  async caixa(@Staff() staff: AuthenticatedStaff) {
    const local = await this.unidade(staff);
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
    const local = await this.unidade(staff);
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
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (idempotencyKey !== undefined && (idempotencyKey === '' || idempotencyKey.length > 128)) {
      throw new DomainError('invalid_request', 400, 'Idempotency-Key com tamanho inválido');
    }

    const local = await this.unidade(staff);
    try {
      await movimentarCaixa({
        tenantId: staff.tenantId,
        locationId: local.id,
        // Escopada por operador, como em toda rota de dinheiro: a chave vem do
        // cliente e é livre, e duas recepcionistas mandando "1" fariam a segunda
        // receber a sangria da primeira de volta em vez de lançar a dela.
        ...(idempotencyKey ? { idempotencyKey: `${staff.staffUserId}:${idempotencyKey}` } : {}),
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
    const local = await this.unidade(staff);
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

  /**
   * As comandas abertas desta unidade.
   *
   * **Antes de `orders/:id`, e a ordem é o que faz a rota existir.** O Nest
   * casa na ordem de declaração: com o parâmetro declarado primeiro,
   * `/orders/abertas` entrava em `orders/:id` com `id = 'abertas'` e morria na
   * validação de uuid — 400 sobre uma rota que o código tem. O sintoma foi a
   * seção nova não aparecer na medição, com a suíte inteira verde.
   *
   * `customers.view` junto porque a listagem devolve o nome de quem está na
   * comanda: rota que agrega declara **todas** as permissões do que devolve.
   */
  @Exige('cashier.open', 'customers.view')
  @Get('orders/abertas')
  async abertas(@Staff() staff: AuthenticatedStaff) {
    const local = await this.unidade(staff);
    return { comandas: await comandasAbertas(staff.tenantId, local.id) };
  }

  /**
   * A comanda **redige** o cadastro do cliente para quem não tem
   * `customers.view` — nome, id e a conta de fiado.
   *
   * Operar a comanda com o nome do cliente na frente é defensável — é o balcão
   * —, mas quem não pode abrir a ficha também não recebe o saldo dela por esta
   * porta. Redigir e não recusar porque `@Exige` é conjuntivo: somar a
   * permissão às seis rotas que devolvem uma comanda tirava o **PDV inteiro**
   * de um papel de balcão a que o dono a negasse, e a venda é o que aquela
   * tela existe para fazer. Quem redige é `comandaVisivel`, no domínio.
   *
   * `finance.view` **não** entra, e a decisão é escrita: o saldo e o teto são o
   * que decide se a venda pode sair fiada, e exigi-lo trancaria a recepção
   * para fora da operação que ela existe para fazer.
   */
  @Exige('cashier.open')
  @Get('orders/:id')
  async comanda(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    try {
      // A comanda é **desta** loja. A RLS separa barbearias e não separa lojas.
      const local = await this.unidade(staff);
      return comandaVisivel({
        comanda: await getComanda(staff.tenantId, id, local.id),
        podeVerCliente: pode(staff.permissions, 'customers.view'),
      });
    } catch (error) {
      return toHttp(error);
    }
  }

  /**
   * A redação vale nas **cinco** rotas de escrita, e não só na leitura.
   *
   * Elas devolvem **o mesmo objeto** que `GET /orders/:id`: sem a passagem por
   * `comandaVisivel`, os três campos que a porta da frente esconde saíam
   * inteiros pela porta de trás, um cliente por vez. Achado da varredura da
   * rota que agrega, nona reincidência da regra — e o conserto foi duas vezes:
   * primeiro somando `customers.view` ao `@Exige`, que trancava o PDV de quem
   * não a tem, e depois redigindo, que é o precedente de `applyAttendance`.
   */
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

    const local = await this.unidade(staff);
    try {
      return comandaVisivel({
        comanda: await abrirComanda({
        tenantId: staff.tenantId,
        locationId: local.id,
        staffId: staff.staffUserId,
        appointmentId: body.appointmentId ?? null,
        customerId: body.customerId ?? null,
        // A chave é escopada por operador: ela vem do cliente e é livre, e duas
        // recepcionistas mandando "1" abririam a mesma comanda.
        ...(idempotencyKey ? { idempotencyKey: `${staff.staffUserId}:${idempotencyKey}` } : {}),
        }),
        podeVerCliente: pode(staff.permissions, 'customers.view'),
      });
    } catch (error) {
      return toHttp(error);
    }
  }

  /**
   * Cancelar uma comanda aberta — a saída que `order_status` tinha no enum e
   * não tinha em lugar nenhum do produto.
   *
   * Mesma permissão que abre, e é o desenho certo: quem cria a linha desfaz
   * enquanto ela não virou dinheiro. O segundo fator vem junto pelo prefixo
   * `cashier.`, como em toda operação do balcão.
   *
   * Sem `Idempotency-Key`: aqui existe estado que distingue a repetição —
   * `status = 'open'` no `WHERE`, com a contagem conferida —, e é ele que barra
   * o segundo toque. A chave é para quando não há esse estado.
   */
  @Exige('cashier.open')
  @Delete('orders/:id')
  async cancelarComandaAberta(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    const local = await this.unidade(staff);
    try {
      return await cancelarComanda({
        tenantId: staff.tenantId,
        locationId: local.id,
        orderId: id,
        ator: { id: staff.staffUserId, name: staff.name },
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
      packageId?: string;
    },
  ) {
    const local = await this.unidade(staff);
    try {
      return comandaVisivel({
        comanda: await adicionarItem({
        tenantId: staff.tenantId,
        locationId: local.id,
        orderId: id,
        tipo: body.tipo,
        serviceId: body.serviceId ?? null,
        descricao: body.descricao,
        quantidade: body.quantidade,
        precoUnitarioCents: body.precoUnitarioCents,
        professionalId: body.professionalId ?? null,
        packageId: body.packageId ?? null,
        }),
        podeVerCliente: pode(staff.permissions, 'customers.view'),
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
      const local = await this.unidade(staff);
      return comandaVisivel({
        comanda: await removerItem({
        tenantId: staff.tenantId,
        locationId: local.id,
        orderId: id,
        itemId,
        ator: { id: staff.staffUserId, name: staff.name },
        }),
        podeVerCliente: pode(staff.permissions, 'customers.view'),
      });
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
   * **Corrigido no bloco 30**, que é onde a tela de conceder permissão entrou:
   * agora é `finance.discount`, e o dono pode dá-la à recepção sem entregar o
   * faturamento junto. A migração 0032 concedeu a permissão nova a todo papel
   * que já tinha `finance.view`, para que ninguém perca capacidade numa
   * segunda-feira.
   *
   * Permissão diz *quem*; `tenants.max_discount_bps` diz *quanto*. Sem o teto,
   * conceder desconto continuaria sendo conceder estorno com outro nome.
   */
  @Exige('finance.discount')
  @Patch('orders/:id')
  async ajustar(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(ajusteSchema))
    body: { desconto?: DescontoDaComanda | null; gorjetaCents?: number },
  ) {
    try {
      const local = await this.unidade(staff);
      return comandaVisivel({
        comanda: await ajustarComanda({
        tenantId: staff.tenantId,
        locationId: local.id,
        orderId: id,
        desconto: body.desconto ?? null,
        ...(body.gorjetaCents === undefined ? {} : { gorjetaCents: body.gorjetaCents }),
        staffId: staff.staffUserId,
        staffName: staff.name,
        }),
        podeVerCliente: pode(staff.permissions, 'customers.view'),
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
    @Body(new ZodValidationPipe(fecharComandaSchema))
    body: {
      pagamentos: Pagamento[];
      resgateQuantidade?: number;
      servicoDoPacote?: string;
    },
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (idempotencyKey !== undefined && (idempotencyKey === '' || idempotencyKey.length > 128)) {
      throw badRequest('invalid_request', 'Idempotency-Key com tamanho inválido');
    }

    const local = await this.unidade(staff);
    try {
      return comandaVisivel({
        comanda: await fecharComanda({
        tenantId: staff.tenantId,
        locationId: local.id,
        orderId: id,
        pagamentos: body.pagamentos,
        ...(body.resgateQuantidade !== undefined
          ? { resgateQuantidade: body.resgateQuantidade }
          : {}),
        ...(body.servicoDoPacote ? { servicoDoPacote: body.servicoDoPacote } : {}),
        staffId: staff.staffUserId,
        staffName: staff.name,
        // O dia da unidade, não o do servidor: às 22h de Salvador o UTC já
        // virou, e a comissão cairia no mês seguinte do acerto do barbeiro.
        hojeNaUnidade: diaNaUnidade(null, local.timezone, new Date()).dia,
        // Escopada por operador: a chave vem do cliente e é livre, e duas
        // recepcionistas mandando "1" devolveriam uma a comanda da outra.
        ...(idempotencyKey ? { idempotencyKey: `${staff.staffUserId}:${idempotencyKey}` } : {}),
        }),
        podeVerCliente: pode(staff.permissions, 'customers.view'),
      });
    } catch (error) {
      return toHttp(error);
    }
  }

  // -- Fiado ------------------------------------------------------------------

  /**
   * Declara as **três** permissões do que devolve, e não a mais próxima do nome.
   *
   * A rota não lista dívida: ela lista **cem clientes nomeados com o valor que
   * cada um deve**. A irmã que devolve um saldo só já exige `customers.view` +
   * `finance.view` (`financeiro.controller.ts`), e esta devolvia a base inteira
   * de devedores sob uma permissão de operação de balcão.
   *
   * Hoje nada vaza, porque a recepção padrão já tem `customers.view`. O caminho
   * é o dos oito precedentes catalogados: papéis são editáveis desde o bloco 30,
   * e um papel "Caixa" — alguém que só opera a gaveta — é configuração natural.
   * Ele recebia a lista de quem deve para a casa sem ela.
   *
   * `finance.view` **não** entra, e a decisão é escrita porque a primeira
   * versão deste conserto a incluiu e o e2e do balcão a derrubou. Cobrar quem
   * deve é trabalho de recepção, e ela não tem `finance.view` de propósito —
   * exigi-lo aqui é o mesmo defeito com o sinal trocado: em vez de vazar a
   * lista, trancaria para fora dela justamente quem precisa cobrar. É a razão
   * de o teste `a recepcionista abre o caixa, fecha a venda e vê quem deve`
   * existir.
   */
  @Exige('cashier.open', 'customers.view')
  @Get('debts')
  async devedores(@Staff() staff: AuthenticatedStaff) {
    return await quemEstaDevendo(staff.tenantId);
  }

  @Exige('cashier.open')
  @Post('debts/receive')
  async receber(
    @Staff() staff: AuthenticatedStaff,
    @Body(new ZodValidationPipe(receberFiadoSchema))
    body: { customerId: string; amountCents: number; forma: 'cash' | 'debit' | 'credit' | 'pix' },
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (idempotencyKey !== undefined && (idempotencyKey === '' || idempotencyKey.length > 128)) {
      throw new DomainError('invalid_request', 400, 'Idempotency-Key com tamanho inválido');
    }

    const local = await this.unidade(staff);
    try {
      return await receberFiado({
        tenantId: staff.tenantId,
        locationId: local.id,
        customerId: body.customerId,
        amountCents: body.amountCents,
        forma: body.forma,
        // Escopada por operador, como em toda rota de dinheiro.
        ...(idempotencyKey ? { idempotencyKey: `${staff.staffUserId}:${idempotencyKey}` } : {}),
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
  // -- Cobrança online (blocos 35 e 36) --------------------------------------

  /**
   * O que a tela da comanda precisa saber sobre o Pix em curso.
   *
   * `cashier.open` como o resto do balcão: emitir e acompanhar cobrança é
   * operar a venda da frente, não ver o dinheiro da casa.
   */
  @Exige('cashier.open')
  @Get('orders/:id/charges')
  async cobrancas(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ) {
    // As cobranças são desta loja, como a comanda que elas cobram.
    const local = await this.unidade(staff);
    return { cobrancas: await cobrancasDaComanda(staff.tenantId, id, local.id) };
  }

  /**
   * Emite a cobrança e devolve o que mostrar na tela.
   *
   * `Idempotency-Key` é **obrigatória** aqui, e é a primeira rota do produto em
   * que ela é. O motivo é o efeito: cada toque a mais seria um QR Code a mais
   * para a mesma conta, e o cliente com dois códigos na frente paga um deles ao
   * acaso. As outras rotas de dinheiro têm outra defesa — o `AND status =
   * 'open'` do fechamento —, que aqui não existe porque emitir não muda a
   * comanda.
   */
  @Exige('cashier.open')
  @Post('orders/:id/charges')
  async cobrar(
    @Staff() staff: AuthenticatedStaff,
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(new ZodValidationPipe(cobrancaSchema)) body: { meio: MeioDePagamento },
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!idempotencyKey || idempotencyKey.length > 128) {
      throw badRequest('invalid_request', 'Idempotency-Key é obrigatória para cobrar');
    }

    const local = await this.unidade(staff);
    try {
      return await criarCobrancaDaComanda({
        tenantId: staff.tenantId,
        locationId: local.id,
        orderId: id,
        meio: body.meio,
        staffId: staff.staffUserId,
        staffName: staff.name,
        // Escopada por operador, como no fechamento: a chave vem do cliente e é
        // livre, e duas recepcionistas mandando "1" trocariam de QR Code.
        idempotencyKey: `${staff.staffUserId}:${idempotencyKey}`,
        provider: adquirenteDaComanda(),
        agora: new Date(),
      });
    } catch (error) {
      return toHttp(error);
    }
  }

  /** "O cliente desistiu do Pix e vai pagar em dinheiro" — rotina do balcão. */
  @Exige('cashier.open')
  @Delete('orders/:id/charges/:chargeId')
  async cancelarCobranca(
    @Staff() staff: AuthenticatedStaff,
    // A comanda da URL entra na consulta. Sem ela, o endereço não identificava o
    // objeto que dizia identificar: um id de cobrança valia sob qualquer comanda.
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Param('chargeId', new ZodValidationPipe(uuidSchema)) chargeId: string,
  ) {
    try {
      const local = await this.unidade(staff);
      await cancelarCobrancaDaComanda({
        tenantId: staff.tenantId,
        locationId: local.id,
        orderId: id,
        chargeId,
        staffId: staff.staffUserId,
        staffName: staff.name,
        provider: adquirenteDaComanda(),
      });
      return { ok: true };
    } catch (error) {
      return toHttp(error);
    }
  }

  @Exige('finance.view')
  @Get('revenue')
  async faturamento(
    @Staff() staff: AuthenticatedStaff,
    @Query(new ZodValidationPipe(diaSchema)) query: { dia?: string },
  ) {
    const local = await this.unidade(staff);
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
