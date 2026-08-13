/**
 * O que cada evento da trilha significa, em português.
 *
 * O código cru (`staff.role_changed`) é o formato certo para guardar — estável,
 * agrupável, comparável entre blocos. É o formato errado para ler: quem abre a
 * trilha está no meio de uma pergunta ("quem deu acesso ao caixa para o
 * Bruno?"), e precisa da frase.
 *
 * A tradução mora aqui, e não dentro da página, por um motivo só: `trilha.test`
 * lê `packages/identity/src/audit.ts` e reprova quando o vocabulário do banco
 * ganha um verbo que a tela não sabe dizer. Um mapa dentro de um componente de
 * servidor não teria como ser conferido, e a forma de descobrir que faltava
 * seria um código feio aparecendo na tela do dono.
 */
export const FRASE_DO_EVENTO: Record<string, string> = {
  'staff.created': 'criou a conta de',
  'staff.role_changed': 'mudou o papel de',
  'staff.deactivated': 'desligou',
  'staff.reactivated': 'religou',
  'staff.password_reset': 'reemitiu a senha de',
  'permissions.changed': 'mudou as permissões do papel',
  'marketplace.attribution_contested': 'contestou uma comissão do marketplace',

  'cash.opened': 'abriu o caixa',
  'cash.closed': 'fechou o caixa',
  'cash.withdrawal': 'fez sangria no caixa',
  'cash.supply': 'fez suprimento no caixa',
  'order.closed': 'fechou a comanda',
  'order.discount': 'deu desconto na comanda',
  'debt.received': 'recebeu um fiado',
  // Financeiro (bloco 51). "Lançou" e não "criou": é a palavra do balcão para
  // pôr uma conta na lista, e vocabulário de ação é um só em todo o produto.
  'bill.created': 'lançou uma conta',
  /**
   * Duas ações, uma por direção, e as frases são as **dos botões**.
   *
   * A primeira versão tinha uma ação só, com a frase "quitou uma conta" — e
   * "quitar" era a terceira palavra para a mesma transição, ao lado de "Pagar"
   * na tela e "Registrar pagamento" no botão. Quando a recepção diz "já paguei
   * a distribuidora" e a trilha diz "quitou", o treinamento vira folclore
   * (CLAUDE.md §6).
   */
  'bill.paid': 'registrou o pagamento de uma conta',
  'bill.received': 'registrou o recebimento de uma conta',
  'bill.cancelled': 'cancelou uma conta',
  'account.transferred': 'transferiu dinheiro entre contas',
  'debt.limit_changed': 'mudou o limite de fiado de um cliente',
  'debt.opening_balance': 'lançou o saldo de fiado herdado de um cliente',
  // Vale, estorno e transferência de pacote (bloco 52). "Adiantou" é a palavra
  // do balcão; "desfez a venda" diz o que aconteceu melhor que "estornou", que
  // é jargão de quem trabalha com dinheiro e não de quem opera a cadeira.
  'advance.granted': 'adiantou dinheiro a um profissional',
  'advance.cancelled': 'cancelou o vale de um profissional',
  'order.refunded': 'desfez uma venda já fechada',
  'package.transferred': 'passou um pacote para outra pessoa',
  'order.charge_created': 'gerou uma cobrança online',
  // "Cancelou" e não "encerrou": quem lê a trilha quer saber que alguém tomou a
  // decisão, e o cliente pode estar com o código na mão nesse instante.
  'order.charge_cancelled': 'cancelou uma cobrança online',
  'deposit.received': 'registrou o sinal recebido de um horário',
  'deposit.refunded': 'devolveu o sinal de um horário',
  // "Score" não diz nada para quem lê a trilha. O que ele decide, sim.
  'customer.reliability_override': 'ajustou à mão se um cliente paga sinal',

  'mfa.enabled': 'ligou o segundo fator de',
  'mfa.disabled': 'desligou o segundo fator de',
  'mfa.recovery_used': 'usou um código de recuperação',
  'mfa.policy_enabled': 'passou a exigir segundo fator no financeiro',
  'mfa.policy_disabled': 'deixou de exigir segundo fator no financeiro',

  'commission.closed': 'fechou a comissão do período',
  'commission.rule_changed': 'mudou a regra de comissão de',

  'import.applied': 'trouxe a base do sistema antigo',
  'import.reverted': 'desfez a importação da base',
  // LGPD (bloco 31). O verbo diz quem decidiu: a barbearia **registrou** o que
  // o cliente disse no balcão — a decisão tomada pelo próprio titular na conta
  // dele não passa por aqui, e é assim que se sabe qual foi qual.
  'customer.consent_recorded': 'registrou o consentimento de',
  'customer.data_exported': 'exportou os dados de',
  'lgpd.request_fulfilled': 'atendeu o pedido de dados de',
  'lgpd.request_refused': 'recusou o pedido de dados de',
  // Bloco 32. O verbo é forte de propósito: "anonimizou" é jargão, e quem lê a
  // trilha precisa entender de primeira que o cadastro não volta.
  'customer.anonymized': 'apagou os dados de',
  'slug.added': 'cadastrou um endereço antigo da barbearia',

  /**
   * Fiscal (bloco 53). "Mexeu no cadastro fiscal" e não "alterou fiscal_settings":
   * quem lê a trilha é o dono procurando por que a nota saiu errada, e o nome da
   * tabela não responde nada para ele.
   */
  'fiscal.settings_changed': 'mexeu no cadastro fiscal da casa',
  'fiscal.invoice_cancelled': 'cancelou uma nota fiscal',
  /**
   * Bloco 54. A frase diz que **mudou**, nunca para quê — a trilha guarda
   * `{ tinha: true }`, e é essa a decisão: o CPF numa tabela append-only seria
   * uma segunda cópia que a anonimização não alcança.
   */
  'customers.tax_id_changed': 'mudou o CPF de um cliente',
  // Bloco 55. "Mexeu no" e não "configurou": a frase serve para quem cadastrou
  // pela primeira vez e para quem trocou o token depois.
  'whatsapp.settings_changed': 'mexeu no WhatsApp da casa',
  'whatsapp.template_submitted': 'mandou um texto para a Meta aprovar',
  'automation.changed': 'mexeu numa automação de mensagem',
  'campaign.created': 'criou uma campanha',
  'team.locations_changed': 'mudou de quais unidades alguém cuida',
  'stock.transferred': 'transferiu produto entre unidades',
  'location.created': 'abriu uma unidade',
  'location.closed': 'fechou uma unidade',
  'location.reopened': 'reabriu uma unidade',

  // Recados (bloco 40). A trilha é o que sustenta o limite ético pelo outro
  // lado: ninguém apaga reclamação — o banco não deixa — e ninguém responde em
  // nome da casa sem deixar registro de quem foi.
  'feedback.assigned': 'assumiu um recado de cliente',
  'feedback.answered': 'respondeu um recado de cliente',
  'feedback.closed': 'encerrou um recado de cliente',

  /**
   * A recuperação de nota baixa (bloco 43). "Tratou", e não "resolveu": a
   * avaliação publica de qualquer forma passadas as 48 horas, e a palavra
   * resolvida sugeriria que o registro faz a nota sumir.
   */
  'review.recovered': 'tratou uma avaliação de nota baixa',

  // Estoque (bloco 44). Só perda e ajuste: são os dois em que o número muda sem
  // nota fiscal nem venda.
  'product.changed': 'mexeu no cadastro de um produto',
  'stock.adjusted': 'baixou ou ajustou estoque à mão',

  // O clube de assinatura (bloco 45). As três são de dinheiro: definem ou ligam
  // receita recorrente.
  'subscription.plan_changed': 'mexeu num plano de assinatura',
  'subscription.started': 'assinou um cliente num plano',
  'subscription.cancelled': 'cancelou a assinatura de um cliente',
  'subscription.dependent_changed': 'mexeu em quem usa a cota de uma assinatura',

  // A cobrança recorrente (bloco 47). Dar baixa à mão é a única testemunha de
  // dinheiro que entrou por fora do caixa; cancelar fatura é perdoar dívida.
  'subscription.invoice_paid': 'deu baixa numa mensalidade do clube',
  'subscription.invoice_voided': 'cancelou uma mensalidade do clube',
  'subscription.cancel_scheduled': 'agendou o fim de uma assinatura',

  // O split (bloco 49). Ligado, o adquirente manda a comissão direto para a
  // conta do barbeiro — é a configuração com a maior consequência do produto.
  'split.changed': 'mexeu no repasse direto ao barbeiro',
  // Aprovado, ele passa a receber direto na conta dele. O dado bancário não
  // está aqui: ele atravessa para o adquirente e não é gravado neste lado.
  'split.recipient_changed': 'cadastrou a conta de recebimento de',

  // Fidelidade (bloco 41). As duas são de dinheiro: o ajuste **cria** saldo
  // gastável, e mudar o programa define a alíquota com que a casa passa a
  // imprimi-lo.
  'loyalty.program_changed': 'mudou o programa de fidelidade',
  'loyalty.adjusted': 'ajustou o saldo de fidelidade de',

  // Pacotes (bloco 42). Mudar o catálogo define por quanto a casa vende cinco
  // cortes; reembolsar devolve dinheiro a quem já pagou.
  'package.changed': 'mudou um pacote do catálogo',
  'package.refunded': 'reembolsou um pacote de',

  // Suporte assistido (bloco 26). Estas três não descrevem o que **a equipe**
  // fez: descrevem o que a plataforma fez dentro desta barbearia. É a metade da
  // SPEC §1.2 que uma trilha só de plataforma não cumpre — "o tenant deve poder
  // consultar esse log" —, e o verbo precisa deixar claro que o ator é de fora.
  'support.started': 'entrou nesta conta para dar suporte',
  'support.accessed': 'abriu uma tela durante o suporte',
  'support.ended': 'encerrou o suporte',
};

/**
 * O antes e o depois, quando existem e quando dizem alguma coisa.
 *
 * Só os campos que **mudaram**: repetir o que ficou igual afogaria a diferença,
 * que é a única coisa que a pessoa veio ver.
 */
export function diferencaDoEvento(antes: unknown, depois: unknown): readonly string[] {
  if (!depois || typeof depois !== 'object') return [];
  const de = (antes ?? {}) as Record<string, unknown>;
  const para = depois as Record<string, unknown>;

  return Object.keys(para)
    .filter((campo) => JSON.stringify(de[campo]) !== JSON.stringify(para[campo]))
    .map((campo) =>
      de[campo] === undefined
        ? `${campo}: ${String(para[campo])}`
        : `${campo}: ${String(de[campo])} → ${String(para[campo])}`,
    );
}
