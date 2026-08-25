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
  /**
   * Mata a cobrança **no adquirente**, não só aqui.
   *
   * Entrou depois da `/security-review` do bloco 35. Cancelar só do lado de cá
   * deixava o QR Code pagável: quem já tinha lido o código pagava, o evento
   * chegava para uma cobrança encerrada e virava silêncio. Dinheiro capturado,
   * nunca registrado, nunca devolvido.
   */
  cancelar(pagamentoId: string): Promise<void>;
  /** Devolve o dinheiro. Total quando `valorCents` não vem. */
  /**
   * Deve ser idempotente para o par `pagamentoId + valorCents`.
   *
   * Uma queda pode acontecer depois de o adquirente mover o dinheiro e antes
   * de o Barberdock persistir a resposta. Repetir a mesma chamada precisa
   * reencontrar o mesmo refund, nunca criar uma segunda devolução.
   */
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
  readonly estornos: { pagamentoId: string; valorCents?: number | undefined; estornoId: string }[] = [];
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

  readonly cancelados: string[] = [];

  async cancelar(pagamentoId: string): Promise<void> {
    this.cancelados.push(pagamentoId);
  }

  async estornar(
    pagamentoId: string,
    valorCents?: number,
  ): Promise<{ readonly estornoId: string }> {
    // O fake preserva a mesma idempotência exigida do adquirente real. Uma
    // resposta perdida não pode transformar a repetição do mesmo estorno em
    // uma segunda devolução de dinheiro.
    const anterior = this.estornos.find(
      (e) => e.pagamentoId === pagamentoId && e.valorCents === valorCents,
    );
    if (anterior) return { estornoId: anterior.estornoId };

    const estornoId = `fake_refund_${this.estornos.length + 1}`;
    this.estornos.push({ pagamentoId, valorCents, estornoId });
    return { estornoId };
  }

  clear(): void {
    this.cobrancas.length = 0;
    this.estornos.length = 0;
    this.cancelados.length = 0;
    this.contador = 0;
    this.proximoEstado = 'aguardando';
    this.expiraEm = undefined;
  }
}

// ---------------------------------------------------------------------------
// A terceira direção de dinheiro: o clube (bloco 47, SPEC §4.6)
// ---------------------------------------------------------------------------

/**
 * A cobrança recorrente do clube.
 *
 * É o **terceiro** contrato de pagamento do produto, e o cabeçalho deste arquivo
 * já explica por que dois não bastavam. O terceiro entra pela mesma régua: as
 * perguntas são outras.
 *
 * - `PspProvider` (bloco 29): a plataforma cobra a barbearia.
 * - `PaymentProvider` (bloco 34): a barbearia cobra o cliente **presente**, e o
 *   que interessa é o que aparece na tela agora — QR Code, link, aprovação.
 * - este: a barbearia cobra o cliente **ausente**, num cartão salvo, às cinco da
 *   manhã, sem ninguém olhando.
 *
 * Aqui não existe QR Code para mostrar nem tela para atualizar: existe "passou
 * ou não passou, e o que eu escrevo na fatura". Reaproveitar `PaymentProvider`
 * traria `pixCopiaECola` e `url` para um caminho que nunca os usa — o defeito
 * de campo que o motor aceita e ninguém preenche, com o agravante de ser em
 * dinheiro.
 *
 * A distinção que **importa** é a última: recusa definitiva (cartão cancelado,
 * conta encerrada) e indisponibilidade (rede fora, adquirente instável) não são
 * a mesma coisa. Tratar a segunda como a primeira gastaria um degrau da escada
 * por um problema que não é do cliente — e, quinze dias depois, suspenderia o
 * benefício de quem tinha limite no cartão o tempo todo.
 */
export interface CobrancaDoClubeProvider {
  cobrar(pedido: PedidoDoClube): Promise<ResultadoDoClube>;
}

export interface PedidoDoClube {
  readonly tenantId: string;
  /** A fatura do ciclo. É por ela que a retentativa reencontra a cobrança. */
  readonly faturaId: string;
  /** O token do cartão salvo, do provedor. Nunca o número. */
  readonly token: string;
  readonly valorCents: number;
  /** Cobranças já feitas nesta fatura, contando a do vencimento. */
  readonly tentativa: number;
  readonly descricao: string;
  /** Chave final que o provider DEVE repassar ao adquirente para deduplicar a tentativa. */
  readonly idempotencyKey: string;
}

export type ResultadoDoClube =
  | { readonly pago: true; readonly cobrancaId: string }
  | {
      readonly pago: false;
      readonly motivo: string;
      /**
       * A recusa é definitiva?
       *
       * `true` para cartão cancelado ou conta encerrada — retentar não muda
       * nada, e o caminho é avisar o cliente para trocar o cartão. `false` para
       * saldo insuficiente e para o adquirente fora do ar: o cartão que falhou
       * na terça costuma passar na quinta, e é essa a aposta que a régua faz.
       */
      readonly definitiva: boolean;
    };

/**
 * A chave que vai ao adquirente, escopada aqui pelo mesmo motivo de
 * `chaveDoAdquirente`: o espaço de idempotência dele é o da **conta**, que é uma
 * só para todas as barbearias.
 *
 * A tentativa entra na chave de propósito. Sem ela, a retentativa de D+3 mandaria
 * a mesma chave da cobrança de D+0 e receberia de volta a **recusa** guardada —
 * a régua veria o cartão falhar para sempre, mesmo depois de o cliente pagar a
 * fatura dele.
 */
export function chaveDoClube(
  pedido: Pick<PedidoDoClube, 'tenantId' | 'faturaId' | 'tentativa'>,
): string {
  return `clube:${pedido.tenantId}:${pedido.faturaId}:${pedido.tentativa}`;
}

/**
 * O provedor de mentira: **recusa por padrão**, e não paga.
 *
 * É a escolha certa pelo mesmo motivo do `FakePaymentProvider` nascer
 * `aguardando`: o produto sai de fábrica sem cartão salvo, e o caminho que de
 * fato acontece é a fatura ficar em aberto até o balcão registrar o pagamento
 * que viu no extrato. Um fake que aprovasse tudo faria a régua inteira — marcar
 * inadimplente, retentar, suspender — nunca ser exercida pelo caminho real.
 */
export class FakeCobrancaDoClubeProvider implements CobrancaDoClubeProvider {
  readonly pedidos: PedidoDoClube[] = [];
  private readonly respostasPorChave = new Map<string, ResultadoDoClube>();
  proximoResultado: ResultadoDoClube = {
    pago: false,
    motivo: 'sem adquirente configurado',
    definitiva: false,
  };

  async cobrar(pedido: PedidoDoClube): Promise<ResultadoDoClube> {
    const anterior = this.respostasPorChave.get(pedido.idempotencyKey);
    if (anterior) return anterior;
    this.pedidos.push(pedido);
    this.respostasPorChave.set(pedido.idempotencyKey, this.proximoResultado);
    return this.proximoResultado;
  }

  clear(): void {
    this.pedidos.length = 0;
    this.respostasPorChave.clear();
    this.proximoResultado = {
      pago: false,
      motivo: 'sem adquirente configurado',
      definitiva: false,
    };
  }
}

// ---------------------------------------------------------------------------
// O repasse e o cadastro do recebedor (bloco 50, SPEC §3.5)
// ---------------------------------------------------------------------------

/**
 * O que o adquirente faz **depois** do pagamento: mover dinheiro entre contas.
 *
 * Contrato próprio, e é o quarto deste arquivo. A régua vale de novo: as
 * perguntas são outras. `PaymentProvider` cria uma cobrança e devolve um QR
 * Code; este pega dinheiro que já entrou e o manda para a conta de outra pessoa,
 * e a única coisa que interessa é "saiu ou não saiu, e para onde".
 *
 * O cadastro do recebedor mora aqui pelo mesmo motivo: ele é a **condição** do
 * repasse, e separá-lo num quinto contrato faria quem implementa ter que ligar
 * dois adquirentes que na prática são o mesmo.
 */
export interface SplitProvider {
  /**
   * Começa o cadastro de um profissional como recebedor.
   *
   * Devolve o id e o estado — que quase nunca é `aprovado` na primeira chamada:
   * *"o onboarding disso é assíncrono"*, e o adquirente confere documento em
   * horas ou dias. Quem descobre o resultado é o webhook ou a conciliação.
   */
  cadastrarRecebedor(pedido: PedidoDeRecebedor): Promise<RecebedorCriado>;
  /** Pergunta o estado do cadastro. É a rede de segurança da conciliação. */
  consultarRecebedor(recebedorId: string): Promise<EstadoDoRecebedor>;
  transferir(pedido: PedidoDeRepasse): Promise<ResultadoDoRepasse>;
}

export interface PedidoDeRecebedor {
  readonly tenantId: string;
  readonly professionalId: string;
  readonly nome: string;
  /**
   * Obrigatória no contrato externo: se o adquirente criar o recebedor e a
   * resposta se perder, repetir a mesma intenção precisa devolver o mesmo id,
   * nunca abrir um segundo cadastro/KYC para os mesmos dados.
   */
  readonly idempotencyKey: string;
  /**
   * O documento e a conta viajam para o adquirente e **não** são guardados aqui.
   *
   * Quem tem obrigação regulatória de guardá-los é ele. Deste lado fica a
   * referência opaca — é a mesma razão do token do cartão, e há invariante que
   * reprova quem criar coluna para eles em `professionals`.
   */
  readonly documento: string;
  readonly banco: string;
  readonly agencia: string;
  readonly conta: string;
}

export type EstadoDoRecebedor = 'pendente' | 'aprovado' | 'recusado';

export interface RecebedorCriado {
  readonly recebedorId: string;
  readonly estado: EstadoDoRecebedor;
  readonly motivo?: string | undefined;
}

export interface PedidoDeRepasse {
  readonly tenantId: string;
  /** A parte do split. É por ela que a retentativa reencontra o mesmo repasse. */
  readonly fatiaId: string;
  /**
   * A chave de idempotência, **obrigatória** e derivada da fatia.
   *
   * Obrigatória no tipo e não montada pelo provedor: quem implementa contra um
   * adquirente de verdade não pode esquecer de mandá-la, e esquecer aqui é pagar
   * o barbeiro duas vezes.
   */
  readonly idempotencyKey: string;
  readonly recebedorId: string;
  readonly valorCents: number;
  /** O pagamento de onde o dinheiro veio, para o adquirente amarrar os dois. */
  readonly pagamentoId: string;
}

export type ResultadoDoRepasse =
  | { readonly ok: true; readonly transferenciaId: string }
  | { readonly ok: false; readonly codigo: string; readonly motivo: string; readonly definitiva: boolean };

/**
 * A chave que vai ao adquirente, escopada aqui como as outras três.
 *
 * **Estável por fatia**, e é o oposto da chave da cobrança do clube — a
 * diferença é a direção do dinheiro. Lá a chave varia por tentativa porque
 * retentar um cartão recusado precisa ser uma cobrança nova; aqui, retentar
 * significa que a primeira chamada terminou em desfecho ambíguo, e uma chave
 * nova faria o adquirente executar a **segunda transferência**.
 *
 * Com a chave estável, a retentativa depois de um tempo limite devolve o
 * resultado original em vez de pagar o barbeiro duas vezes. É o achado da
 * `/security-review` do bloco 50, e é a mesma escolha que a convenção do estorno
 * já fazia: indisponibilidade é ambígua, e o que se faz com ambiguidade é
 * perguntar de novo pela mesma coisa, nunca pedir outra.
 */
export function chaveDoRepasse(pedido: PedidoDeRepasse): string {
  return `repasse:${pedido.tenantId}:${pedido.fatiaId}`;
}

/**
 * O provedor de mentira: **recusa** o repasse e deixa o cadastro pendente.
 *
 * As duas escolhas são o estado real do produto sem conta contratada, e as duas
 * são o que faz o caminho de verdade ser exercido: sem cadastro aprovado a parte
 * fica retida, e a comissão sai no fechamento — que é como toda barbearia do
 * país paga o barbeiro hoje.
 */
export class FakeSplitProvider implements SplitProvider {
  readonly recebedores: PedidoDeRecebedor[] = [];
  readonly repasses: PedidoDeRepasse[] = [];
  private readonly recebedoresPorChave = new Map<string, RecebedorCriado>();
  proximoEstadoDoRecebedor: EstadoDoRecebedor = 'pendente';
  proximoResultado: ResultadoDoRepasse = {
    ok: false,
    codigo: 'sem_adquirente',
    motivo: 'sem adquirente configurado',
    definitiva: true,
  };
  private readonly repassesPorChave = new Map<string, ResultadoDoRepasse>();
  private contador = 0;

  async cadastrarRecebedor(pedido: PedidoDeRecebedor): Promise<RecebedorCriado> {
    const existente = this.recebedoresPorChave.get(pedido.idempotencyKey);
    if (existente) return existente;
    this.recebedores.push(pedido);
    this.contador += 1;
    const criado: RecebedorCriado = {
      recebedorId: `fake_rec_${this.contador}`,
      estado: this.proximoEstadoDoRecebedor,
    };
    this.recebedoresPorChave.set(pedido.idempotencyKey, criado);
    return criado;
  }

  async consultarRecebedor(): Promise<EstadoDoRecebedor> {
    return this.proximoEstadoDoRecebedor;
  }

  async transferir(pedido: PedidoDeRepasse): Promise<ResultadoDoRepasse> {
    const anterior = this.repassesPorChave.get(pedido.idempotencyKey);
    if (anterior) return anterior;
    this.repasses.push(pedido);
    this.repassesPorChave.set(pedido.idempotencyKey, this.proximoResultado);
    return this.proximoResultado;
  }

  clear(): void {
    this.recebedores.length = 0;
    this.repasses.length = 0;
    this.contador = 0;
    this.recebedoresPorChave.clear();
    this.repassesPorChave.clear();
    this.proximoEstadoDoRecebedor = 'pendente';
    this.proximoResultado = {
      ok: false,
      codigo: 'sem_adquirente',
      motivo: 'sem adquirente configurado',
      definitiva: true,
    };
  }
}
