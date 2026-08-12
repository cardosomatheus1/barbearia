/**
 * `FiscalProvider` — a abstração fiscal (bloco 53, SPEC §3.11 e §5.11).
 *
 * > *"**Decisão de arquitetura:** não implementar lógica municipal no core.
 * > Criar a abstração `FiscalProvider` e delegar a um emissor terceirizado.
 * > Motivo: são ~5.500 municípios com regras próprias. Absorver isso no core
 * > garante que o time passe a manter integração fiscal em vez de produto."*
 *
 * É a decisão mais importante deste bloco e ela está na SPEC em letras. O que
 * mora aqui é o **contrato** e o vocabulário de estado; o que sabe se Salvador
 * exige RPS numerado e São Paulo não é o emissor contratado.
 *
 * ## A emissão nunca bloqueia a venda
 *
 * É a mesma frase do KYC no bloco 50, e pela mesma razão. A prefeitura pode
 * levar minutos ou horas para autorizar, e pode estar fora do ar — o caminho
 * óbvio, recusar o fechamento da comanda até a nota sair, produz a barbearia
 * descobrindo no balcão, com o cliente na frente, que não consegue cobrar.
 *
 * A nota nasce `pendente`, a fila cuida dela, e o balcão vê o estado na comanda.
 *
 * ## Certificado digital não passa por aqui
 *
 * O A1 e a senha dele ficam **no emissor**, que tem obrigação regulatória de
 * guardá-los. Deste lado fica a referência opaca, exatamente como o token do
 * cartão e o id de recebedor do adquirente — e há invariante no banco que
 * reprova uma coluna de certificado ou senha em `fiscal_settings`.
 */

// ---------------------------------------------------------------------------
// Estado da nota
// ---------------------------------------------------------------------------

export const ESTADOS_DA_NOTA = [
  'pendente',
  'processando',
  'autorizada',
  'cancelando',
  'rejeitada',
  'cancelada',
] as const;
export type EstadoDaNota = (typeof ESTADOS_DA_NOTA)[number];

export const ROTULO_DA_NOTA: Readonly<Record<EstadoDaNota, string>> = {
  pendente: 'Na fila',
  processando: 'Na prefeitura',
  autorizada: 'Autorizada',
  cancelando: 'Cancelando',
  rejeitada: 'Rejeitada',
  cancelada: 'Cancelada',
};

/**
 * O que a tela diz sobre cada estado.
 *
 * Vocabulário de transição em `core` e não escrito na tela: a mesma nota aparece
 * na comanda, na lista de notas e no alerta do painel, e "na prefeitura" num
 * lugar com "processando" no outro é o tipo de diferença que faz a recepção
 * achar que são duas coisas.
 */
export const EXPLICACAO_DA_NOTA: Readonly<Record<EstadoDaNota, string>> = {
  pendente: 'Ainda não foi enviada. Ela sai sozinha em alguns minutos.',
  processando: 'Enviada. A prefeitura costuma responder em minutos, às vezes em horas.',
  autorizada: 'Emitida. O cliente já pode receber o link.',
  cancelando: 'O cancelamento foi para a prefeitura e está sendo confirmado.',
  rejeitada: 'A prefeitura recusou. O motivo está abaixo — corrija e emita de novo.',
  cancelada: 'Cancelada junto à prefeitura.',
};

/** Estado do qual a nota ainda pode sair sozinha. */
export const ESTADOS_NAO_TERMINAIS: readonly EstadoDaNota[] = ['pendente', 'processando'];

export function notaEmCurso(estado: EstadoDaNota): boolean {
  return ESTADOS_NAO_TERMINAIS.includes(estado);
}

/**
 * Estados em que a nota **ocupa** a venda: enquanto um deles vale, não nasce
 * outra nota para a mesma comanda.
 *
 * Esta lista é a mesma do índice parcial `fiscal_invoices_uma_viva_por_comanda`,
 * e mora aqui porque as duas precisam dizer a mesma coisa. Não diziam:
 * `cancelando` estava no índice e não no filtro da aplicação, então pedir nota
 * enquanto um cancelamento estava em voo passava pela checagem do domínio e
 * batia na constraint — o balcão recebia erro de banco no lugar de "não dá para
 * emitir agora", e no caminho automático a exceção subia **dentro** de
 * `fecharComanda`, que roda na transação do webhook do Pix.
 *
 * `rejeitada` e `cancelada` ficam de fora de propósito: a nota morreu e a venda
 * volta a aceitar outra — é o que a recusa da prefeitura manda fazer.
 */
export const ESTADOS_QUE_OCUPAM_A_VENDA: readonly EstadoDaNota[] = [
  'pendente',
  'processando',
  'autorizada',
  'cancelando',
];

/** A venda pode receber nota nova? `null` é a venda que nunca teve nenhuma. */
export function vendaAceitaNota(estadoAtual: EstadoDaNota | null): boolean {
  return estadoAtual === null || !ESTADOS_QUE_OCUPAM_A_VENDA.includes(estadoAtual);
}

// ---------------------------------------------------------------------------
// Regime tributário
// ---------------------------------------------------------------------------

/**
 * Os três regimes que uma barbearia brasileira tem na prática.
 *
 * `salao_parceiro` é da Lei 13.352/2016 e é **específico do setor**: o
 * profissional é parceiro e não empregado, e a nota separa a parcela do salão da
 * parcela dele. A SPEC §3.11 chama a atenção para isso — é exatamente o mesmo
 * dado do split do bloco 49, e a operação da nota entra no bloco 54.
 */
export const REGIMES_FISCAIS = ['simples', 'mei', 'salao_parceiro'] as const;
export type RegimeFiscal = (typeof REGIMES_FISCAIS)[number];

export const ROTULO_DO_REGIME: Readonly<Record<RegimeFiscal, string>> = {
  simples: 'Simples Nacional',
  mei: 'MEI',
  salao_parceiro: 'Salão-Parceiro (Lei 13.352)',
};

export const EXPLICACAO_DO_REGIME: Readonly<Record<RegimeFiscal, string>> = {
  simples: 'A nota sai no valor cheio do serviço, no CNPJ da barbearia.',
  mei: 'A nota sai no valor cheio, com as limitações do MEI.',
  salao_parceiro:
    'A nota separa o que é da casa do que é do profissional. Só a parte da casa é receita dela — é a diferença que a Lei 13.352 existe para permitir.',
};

// ---------------------------------------------------------------------------
// A configuração fiscal da barbearia
// ---------------------------------------------------------------------------

export type FiscalFailure =
  | 'cnpj_invalido'
  | 'regime_invalido'
  | 'codigo_de_servico_obrigatorio'
  | 'aliquota_invalida'
  | 'municipio_obrigatorio'
  | 'nao_configurado';

/**
 * CNPJ, com os dois dígitos verificadores.
 *
 * Conferir aqui e não só no emissor não é preciosismo: um CNPJ digitado errado
 * só falha quando a **primeira nota** é rejeitada, dias depois, e o erro que
 * volta da prefeitura não diz que o problema é do cadastro.
 */
export function cnpjValido(cnpj: string): boolean {
  const digitos = cnpj.replace(/\D/g, '');
  if (digitos.length !== 14) return false;
  // `00000000000000` é o único repetido que passa na conta dos dígitos, e é o
  // que sai de um campo vazio mal tratado. Os outros já caem na própria conta.
  if (/^(\d)\1{13}$/.test(digitos)) return false;

  const verificador = (ate: number): number => {
    let peso = ate - 7;
    let soma = 0;
    for (let i = 0; i < ate; i += 1) {
      soma += Number(digitos[i]) * peso;
      peso -= 1;
      if (peso < 2) peso = 9;
    }
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };

  return (
    verificador(12) === Number(digitos[12]) && verificador(13) === Number(digitos[13])
  );
}

/** Só os dígitos: é assim que o emissor recebe, e é a chave de comparação. */
export function normalizarCnpj(cnpj: string): string {
  return cnpj.replace(/\D/g, '');
}

export interface ConfiguracaoFiscal {
  readonly cnpj: string;
  readonly regime: RegimeFiscal;
  /** Código de serviço municipal — "14.01" em quase toda cidade, mas não em todas. */
  readonly codigoDeServico: string;
  /** Alíquota de ISS em **pontos-base**, como toda alíquota deste produto. */
  readonly issBps: number;
  /** Código IBGE do município. É ele que decide a regra, não o nome. */
  readonly municipioIbge: string;
  readonly emitirAutomaticamente: boolean;
}

/**
 * A alíquota máxima de ISS é 5% por lei complementar federal (LC 116/2003).
 *
 * O teto está aqui e não só no emissor porque um `50` digitado no lugar de `5`
 * passaria pela borda e voltaria como rejeição da prefeitura — e o motivo que
 * ela devolve não diz "você digitou dez vezes a alíquota".
 */
export const ISS_MAXIMO_BPS = 500;

export function validarConfiguracaoFiscal(config: ConfiguracaoFiscal): FiscalFailure | null {
  if (!cnpjValido(config.cnpj)) return 'cnpj_invalido';
  if (!REGIMES_FISCAIS.includes(config.regime)) return 'regime_invalido';
  if (config.codigoDeServico.trim().length < 2) return 'codigo_de_servico_obrigatorio';
  if (!Number.isInteger(config.issBps) || config.issBps < 0 || config.issBps > ISS_MAXIMO_BPS) {
    return 'aliquota_invalida';
  }
  if (!/^\d{7}$/.test(config.municipioIbge)) return 'municipio_obrigatorio';
  return null;
}

// ---------------------------------------------------------------------------
// O que a nota carrega
// ---------------------------------------------------------------------------

export interface TomadorDaNota {
  readonly nome: string;
  /** CPF ou CNPJ, só dígitos. Nulo é nota "ao consumidor", que é o comum. */
  readonly documento: string | null;
  readonly email: string | null;
}

export interface ItemDaNota {
  readonly descricao: string;
  readonly quantidade: number;
  readonly valorUnitarioCents: number;
}

export interface PedidoDeNota {
  /**
   * O id da **linha** de `fiscal_invoices`, e é ele que vira a chave no emissor.
   *
   * Não o da comanda: uma venda pode ter mais de uma nota, de propósito — a
   * rejeitada é justamente a que a barbearia corrige e reenvia, e a cancelada é
   * o caminho quando o valor saiu errado. Com a comanda na chave, a segunda
   * submissão chegaria ao emissor como repetição da primeira e ele devolveria a
   * nota antiga: a tela mostraria "autorizada" com um número que a prefeitura
   * não tem do documento corrigido.
   *
   * É a mesma regra da cobrança online do bloco 36 — "a chave que vai para ele é
   * o id da linha, para a retentativa reencontrar a mesma cobrança em vez de
   * criar a segunda".
   */
  readonly invoiceId: string;
  /** A comanda, como referência externa legível no painel do emissor. */
  readonly orderId: string;
  readonly tomador: TomadorDaNota;
  readonly itens: readonly ItemDaNota[];
  /** Valor total dos serviços, em centavos. Congelado na emissão. */
  readonly servicoCents: number;
  /**
   * A parcela do profissional, no regime Salão-Parceiro.
   *
   * Zero nos outros regimes. É **o mesmo dado do split** (SPEC §3.5), e é por
   * isso que a arquitetura fica consistente: o número que a nota separa é o
   * mesmo que o adquirente repassa.
   */
  readonly parceiroCents: number;
  readonly issBps: number;
  readonly codigoDeServico: string;
  readonly municipioIbge: string;
  /**
   * A chave que o emissor usa para não emitir duas notas da mesma venda.
   *
   * Escopada por barbearia **dentro do provedor**, pela mesma razão do
   * adquirente: o espaço de idempotência dele é o da conta, que é uma só para
   * todas as barbearias.
   */
  readonly tenantId: string;
}

/**
 * A chave que vai para o emissor.
 *
 * `tenantId` na frente pelo precedente do bloco 36: sem ele, duas barbearias
 * emitindo a nota "1" fariam a segunda receber a nota da primeira — com o CNPJ
 * errado e o valor errado, o que é bem pior que uma cobrança repetida.
 *
 * E o **id da nota**, não o da comanda. Achado da `/security-review` deste
 * bloco: com a comanda, a nota corrigida depois de uma rejeição chegava ao
 * emissor como repetição da rejeitada, e ele devolvia a antiga — a barbearia
 * via "autorizada" na tela e a prefeitura nunca recebeu o documento certo.
 */
export function chaveDaNota(pedido: {
  readonly tenantId: string;
  readonly invoiceId: string;
}): string {
  return `${pedido.tenantId}:${pedido.invoiceId}`;
}

export interface NotaEmitida {
  readonly estado: EstadoDaNota;
  /** O id **no emissor**. É por ele que se pergunta o estado e se cancela. */
  readonly notaId: string;
  /** Número e série saem quando a prefeitura autoriza; antes disso são nulos. */
  readonly numero: string | null;
  readonly linkPdf: string | null;
  readonly motivoDaRecusa: string | null;
}

export interface FiscalProvider {
  /** `issueServiceInvoice(order, taxpayer) -> Invoice` da SPEC §3.11. */
  emitir(pedido: PedidoDeNota): Promise<NotaEmitida>;
  /** `cancelInvoice(invoice_id, reason) -> void`. */
  cancelar(notaId: string, motivo: string): Promise<void>;
  /** `getStatus(invoice_id) -> InvoiceStatus`. A rede de segurança da conciliação. */
  consultar(notaId: string): Promise<NotaEmitida>;
}

/**
 * O emissor de mentira, com estado controlável pelo teste.
 *
 * **`processando` por padrão**, e não `autorizada`: é o estado real de uma NFS-e
 * recém-enviada. Um fake que já nascesse autorizada faria a cadeia de
 * conciliação — a fila perguntando o estado, a tela mudando de "na prefeitura"
 * para "autorizada" — nunca ser exercida pelo caminho que ela percorre na vida
 * real. É a mesma decisão do `FakePaymentProvider`, que nasce `aguardando`.
 */
export class FakeFiscalProvider implements FiscalProvider {
  readonly emitidas: PedidoDeNota[] = [];
  readonly canceladas: { notaId: string; motivo: string }[] = [];
  proximoEstado: EstadoDaNota = 'processando';
  proximaRecusa: string | null = null;
  private contador = 0;

  async emitir(pedido: PedidoDeNota): Promise<NotaEmitida> {
    /**
     * A idempotência é do fake também, e pela **mesma função**.
     *
     * Sem ela o teste de duplo envio passaria contra o fake e falharia contra o
     * emissor de verdade — que é o pior tipo de teste verde. E é `chaveDaNota`,
     * não o `orderId` cru: um fake que casasse pelo id nu faria a colisão entre
     * duas barbearias parecer impossível justamente onde ela é provada.
     */
    const chave = chaveDaNota(pedido);
    const anterior = this.emitidas.find((p) => chaveDaNota(p) === chave);
    if (anterior) return this.resposta(this.idDe(anterior));

    this.emitidas.push(pedido);
    this.contador += 1;
    return this.resposta(`fake_nf_${this.contador}`);
  }

  async cancelar(notaId: string, motivo: string): Promise<void> {
    this.canceladas.push({ notaId, motivo });
  }

  async consultar(notaId: string): Promise<NotaEmitida> {
    return this.resposta(notaId);
  }

  private idDe(pedido: PedidoDeNota): string {
    return `fake_nf_${this.emitidas.indexOf(pedido) + 1}`;
  }

  private resposta(notaId: string): NotaEmitida {
    const autorizada = this.proximoEstado === 'autorizada';
    return {
      estado: this.proximoEstado,
      notaId,
      numero: autorizada ? `${notaId.replace('fake_nf_', '')}` : null,
      linkPdf: autorizada ? `https://nfse.exemplo/${notaId}.pdf` : null,
      motivoDaRecusa: this.proximoEstado === 'rejeitada' ? this.proximaRecusa : null,
    };
  }
}

// ---------------------------------------------------------------------------
// A decisão de emitir
// ---------------------------------------------------------------------------

/**
 * O que a nota deve cobrir desta venda.
 *
 * **Só serviço.** Produto vendido no balcão é NF-e ou NFC-e, que é outro
 * documento, com outra regra e outro emissor — a SPEC diz "NF-e/NFC-e **quando
 * aplicável**", e a esmagadora maioria das barbearias não emite nota de produto.
 * Somar o shampoo na NFS-e recolheria ISS sobre mercadoria, que é imposto
 * errado sobre a base errada.
 */
export function baseDaNota(
  itens: readonly { readonly tipo: string; readonly totalCents: number }[],
): number {
  return itens
    .filter((i) => i.tipo === 'service')
    .reduce((soma, i) => soma + i.totalCents, 0);
}

/**
 * Quanto da nota é do profissional, no Salão-Parceiro.
 *
 * Sai da **comissão**, que é a mesma fonte do split — e por isso não existe
 * alíquota de parceiro em lugar nenhum do schema. Duas fontes de verdade para o
 * mesmo número é o que a SPEC §3.5 proíbe em letras, e aqui a consequência seria
 * pior que um extrato divergente: seria uma nota fiscal com um valor que não
 * bate com o que o profissional declara.
 */
export function parteDoParceiro(params: {
  readonly regime: RegimeFiscal;
  readonly comissaoCents: number;
  readonly servicoCents: number;
}): number {
  if (params.regime !== 'salao_parceiro') return 0;
  // Nunca mais que a base: uma comissão maior que o serviço da nota faria a
  // parte da casa ficar negativa, e a prefeitura recusa a nota inteira.
  return Math.max(0, Math.min(params.comissaoCents, params.servicoCents));
}

export type MotivoDeNaoEmitir =
  | 'sem_configuracao'
  | 'emissao_desligada'
  | 'sem_servico'
  | 'venda_nao_paga'
  | 'ja_tem_nota';

/**
 * Esta venda gera nota agora?
 *
 * A resposta é um **motivo**, não um booleano: a tela precisa dizer por que a
 * comanda de R$ 90 não tem nota, e "não" sozinho manda a recepção adivinhar
 * entre cinco causas diferentes.
 */
export function motivoParaNaoEmitir(params: {
  readonly temConfiguracao: boolean;
  readonly emitirAutomaticamente: boolean;
  readonly servicoCents: number;
  readonly estadoDaVenda: 'open' | 'paid' | 'cancelled' | 'refunded';
  readonly jaTemNota: boolean;
}): MotivoDeNaoEmitir | null {
  if (params.jaTemNota) return 'ja_tem_nota';
  if (!params.temConfiguracao) return 'sem_configuracao';
  if (params.estadoDaVenda !== 'paid') return 'venda_nao_paga';
  if (params.servicoCents <= 0) return 'sem_servico';
  if (!params.emitirAutomaticamente) return 'emissao_desligada';
  return null;
}

export const EXPLICACAO_DE_NAO_EMITIR: Readonly<Record<MotivoDeNaoEmitir, string>> = {
  sem_configuracao: 'A barbearia ainda não cadastrou CNPJ e regime em Configurações.',
  emissao_desligada: 'A emissão automática está desligada. Dá para emitir uma nota à mão.',
  sem_servico: 'Esta venda só tem produto, e produto não sai em NFS-e.',
  venda_nao_paga: 'A nota sai quando a comanda é paga.',
  ja_tem_nota: 'Esta venda já tem nota.',
};
