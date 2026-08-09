/**
 * O adquirente do lado da barbearia (bloco 34, SPEC §3.3).
 *
 * ## Duas direções de dinheiro, dois contratos
 *
 * `PspProvider` (bloco 29) é a **plataforma cobrando a barbearia** — mensalidade
 * recorrente, num cartão salvo, sem ninguém olhando. Este é a **barbearia
 * cobrando o cliente dela** — no balcão, com o cliente na frente, esperando o
 * QR Code aparecer.
 *
 * São contratos diferentes porque as perguntas são diferentes. Lá interessa
 * "passou ou não passou, e conto uma tentativa?". Aqui interessa "o que eu
 * mostro na tela agora?" — e a resposta é um QR Code, um link, ou uma
 * aprovação. Um contrato só teria campos que metade das chamadas ignora, que é
 * o defeito de `blocks` esperando para acontecer.
 *
 * ## Por que o contrato mora em `core`
 *
 * Ele é tipo puro, sem banco e sem rede. Quem **usa** é `finance` (a comanda);
 * quem **implementa** contra a Stripe é `platform` (que já tem o cliente HTTP e
 * as credenciais). Se o contrato morasse num dos dois, o outro teria que
 * depender dele — e `platform → finance` inverteria a seta, porque a plataforma
 * é a camada de cima. Em `core` os dois o alcançam sem ninguém saber do outro.
 *
 * ## Por que o estado tem três valores, de novo
 *
 * Pelo mesmo motivo do bloco 29: Pix não responde na hora. Tratar "ainda não
 * pagou" como "recusou" faria o balcão cancelar a comanda enquanto o cliente
 * está com o celular na mão, terminando de digitar a senha do banco.
 */

export type MeioDePagamento = 'pix' | 'cartao' | 'link';

export type EstadoDoPagamento = 'aguardando' | 'pago' | 'recusado' | 'expirado';

export interface PedidoDePagamento {
  readonly tenantId: string;
  /** A comanda que está sendo cobrada. Vira referência na Stripe. */
  readonly orderId: string;
  readonly meio: MeioDePagamento;
  readonly valorCents: number;
  /** Para o comprovante e para o extrato do adquirente. */
  readonly descricao: string;
  /**
   * Chave de idempotência, **obrigatória**.
   *
   * Não é opcional como no `PspProvider`, e a diferença é o ambiente: lá quem
   * chama é a régua, que roda uma vez por dia num processo só. Aqui quem chama
   * é o balcão, no celular, numa rede de barbearia — o duplo toque e a
   * retentativa do navegador são o caso comum, não a exceção.
   */
  readonly idempotencyKey: string;
}

export interface CobrancaCriada {
  readonly estado: EstadoDoPagamento;
  /** O id no adquirente. É por ele que o webhook encontra esta cobrança. */
  readonly pagamentoId: string;
  /**
   * O texto do QR Code (`copia e cola`), quando o meio é Pix.
   *
   * O **texto** e não a imagem: a imagem se gera no navegador a partir dele, e
   * guardar imagem seria guardar o mesmo dado em formato maior e ilegível. E o
   * copia-e-cola é o que a metade dos clientes usa de verdade — quem paga pelo
   * mesmo celular que abriu a tela não consegue fotografar a própria tela.
   */
  readonly pixCopiaECola?: string | undefined;
  /** Para onde mandar o cliente, quando o meio é link. */
  readonly url?: string | undefined;
  /** Quando o Pix ou o link deixam de valer. */
  readonly expiraEm?: Date | undefined;
}

/**
 * A chave que vai para o adquirente, escopada aqui e não por quem chama.
 *
 * A chave do balcão é livre — duas recepcionistas mandando `"1"` é o caso
 * comum. No adquirente isso é pior do que dentro do produto: o espaço de
 * idempotência dele é da **conta**, que é uma só para todas as barbearias.
 * Duas mandando `"1"` fariam a segunda receber de volta a cobrança da primeira
 * — com o copia-e-cola, que é o bastante para o cliente errado pagar a conta
 * errada.
 *
 * Escopar na borda funcionaria e é o que o resto do produto faz. Aqui é dentro
 * do contrato de propósito: é a única defesa que nenhum caminho novo pode
 * esquecer, e um provedor de pagamento é onde o esquecimento custa dinheiro de
 * terceiro.
 */
export function chaveDoAdquirente(pedido: PedidoDePagamento): string {
  return `comanda:${pedido.tenantId}:${pedido.orderId}:${pedido.idempotencyKey}`;
}

/**
 * A chave do estorno, derivada do que ele estorna.
 *
 * Estorno é POST que move dinheiro, e portanto exige chave (CLAUDE.md §2). Ela
 * é derivada em vez de sorteada porque a retentativa precisa produzir a
 * **mesma** chave: a resposta perdida e a requisição que não chegou são
 * indistinguíveis daqui, e sem isso a segunda tentativa devolve o dinheiro de
 * novo.
 */
export function chaveDoEstorno(pagamentoId: string, valorCents?: number): string {
  return `estorno:${pagamentoId}:${valorCents ?? 'total'}`;
}

export interface PaymentProvider {
  criarCobranca(pedido: PedidoDePagamento): Promise<CobrancaCriada>;
  /** Pergunta o estado. É a rede de segurança da conciliação, não o caminho. */
  consultar(pagamentoId: string): Promise<EstadoDoPagamento>;
  /** Devolve o dinheiro. Total quando `valorCents` não vem. */
  estornar(pagamentoId: string, valorCents?: number): Promise<{ readonly estornoId: string }>;
}

/**
 * O provedor de mentira, com estado controlável pelo teste.
 *
 * **Aguardando por padrão**, e não pago: é o estado real de um Pix recém-criado,
 * e um fake que já nasce pago faria a cadeia de confirmação — fechar comanda,
 * lançar no caixa, gerar comissão — nunca ser exercida pelo caminho que ela
 * percorre na vida real, que é o webhook chegando depois.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly cobrancas: PedidoDePagamento[] = [];
  readonly estornos: { pagamentoId: string; valorCents?: number | undefined }[] = [];
  proximoEstado: EstadoDoPagamento = 'aguardando';
  /**
   * O vencimento que este fake devolve, **posto por quem o usa**.
   *
   * A primeira versão somava meia hora ao relógio do processo, e o teste de
   * arquitetura reprovou — com razão, e não por formalismo: `core` é
   * determinístico, e um fake que lê a hora do sistema faz o teste de expiração
   * depender do instante em que ele roda. Quem quer exercer o vencimento diz
   * qual é.
   */
  expiraEm: Date | undefined;
  private contador = 0;

  async criarCobranca(pedido: PedidoDePagamento): Promise<CobrancaCriada> {
    /**
     * A idempotência é do fake também, e pela **mesma função**.
     *
     * Sem ela o teste de duplo toque passaria contra o fake e falharia contra a
     * Stripe — que é o pior tipo de teste verde. E é `chaveDoAdquirente`, não o
     * campo cru: um fake que casasse pela chave nua faria a colisão entre duas
     * barbearias parecer impossível justamente onde ela é provada.
     */
    const chave = chaveDoAdquirente(pedido);
    const anterior = this.cobrancas.find((c) => chaveDoAdquirente(c) === chave);
    if (anterior) return this.resposta(anterior, this.idDe(anterior));

    this.cobrancas.push(pedido);
    this.contador += 1;
    return this.resposta(pedido, `fake_pay_${this.contador}`);
  }

  private idDe(pedido: PedidoDePagamento): string {
    return `fake_pay_${this.cobrancas.indexOf(pedido) + 1}`;
  }

  private resposta(pedido: PedidoDePagamento, id: string): CobrancaCriada {
    return {
      estado: this.proximoEstado,
      pagamentoId: id,
      ...(pedido.meio === 'pix' ? { pixCopiaECola: `00020126fake-${id}` } : {}),
      ...(pedido.meio === 'link' ? { url: `https://pay.exemplo/${id}` } : {}),
      ...(this.expiraEm ? { expiraEm: this.expiraEm } : {}),
    };
  }

  async consultar(): Promise<EstadoDoPagamento> {
    return this.proximoEstado;
  }

  async estornar(
    pagamentoId: string,
    valorCents?: number,
  ): Promise<{ readonly estornoId: string }> {
    this.estornos.push({ pagamentoId, valorCents });
    return { estornoId: `fake_refund_${this.estornos.length}` };
  }

  clear(): void {
    this.cobrancas.length = 0;
    this.estornos.length = 0;
    this.contador = 0;
    this.proximoEstado = 'aguardando';
    this.expiraEm = undefined;
  }
}
