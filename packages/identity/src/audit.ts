import type { TransactionClient } from '@barbearia/db';

/**
 * Trilha de auditoria.
 *
 * A SPEC (Parte 1 §1.7) lista o que precisa ser registrado sem exceção:
 * alteração de permissão, exportação de clientes, impersonação, acesso a foto
 * de cliente, cancelamento de pagamento, sangria. Este bloco entrega os
 * primeiros; os outros entram junto com as telas que os produzem.
 *
 * Grava **dentro da transação que faz a mudança**, sempre. Registrar depois, em
 * outra transação, cria a janela em que a alteração acontece e o registro não —
 * e é exatamente na falha que a trilha precisa existir.
 *
 * A tabela é append-only no banco: `UPDATE` e `DELETE` foram revogados do role
 * da aplicação na migração 0016. Não é convenção, é permissão.
 */

/** Vocabulário estável. String solta vira relatório que não agrupa nada. */
export type AuditAction =
  | 'staff.created'
  | 'staff.role_changed'
  | 'staff.deactivated'
  | 'staff.reactivated'
  | 'staff.password_reset'
  | 'permissions.changed'
  // Dinheiro. A SPEC pede sangria auditada por nome; o resto entrou junto pelo
  // mesmo motivo — a pergunta do dia seguinte nunca é só sobre a sangria, é
  // "quem mexeu na gaveta e o que fez".
  | 'cash.opened'
  | 'cash.closed'
  | 'cash.withdrawal'
  | 'cash.supply'
  | 'order.closed'
  | 'order.discount'
  | 'debt.received'
  // Cobrança online (bloco 35). Emitir põe um QR Code pagável no mundo, e
  // cancelar o tira de circulação com o cliente possivelmente já lendo o
  // código. As duas movem dinheiro de terceiro, e a pergunta do dia seguinte —
  // "quem matou a cobrança do meu cliente?" — não tinha resposta sem isto.
  | 'order.charge_created'
  | 'order.charge_cancelled'
  /**
   * O sinal do agendamento (bloco 37).
   *
   * Dinheiro que entra fora da comanda e sem gaveta aberta: o Pix que o cliente
   * manda dias antes para garantir o sábado. Quem digita "recebi R$ 20" é a
   * única testemunha da entrada, e a pergunta do dia seguinte — "o cliente
   * jurou que pagou, quem registrou?" — não teria resposta sem isto.
   *
   * A devolução é auditada pela razão espelhada: ela tira da barbearia dinheiro
   * que já estava com ela.
   */
  | 'deposit.received'
  | 'deposit.refunded'
  /**
   * Fidelidade (bloco 41).
   *
   * As duas são de **dinheiro**, e a segunda pode surpreender: mudar o programa
   * não move centavo nenhum hoje, mas define a alíquota com que a casa vai
   * imprimir crédito daqui para a frente. "Quem virou o cashback para 50%?" é
   * uma pergunta de dinheiro, e quem precisa respondê-la é quem lê a trilha de
   * dinheiro.
   *
   * O ajuste manual é ainda mais direto: ele cria saldo, e saldo vira pagamento
   * no balcão da operação seguinte.
   */
  | 'loyalty.program_changed'
  | 'loyalty.adjusted'
  /**
   * Pacotes (bloco 42).
   *
   * As duas são de dinheiro. Mudar o catálogo define por quanto a barbearia
   * vende cinco cortes; reembolsar devolve dinheiro proporcional a quem já
   * pagou. A pergunta "quem baixou o preço do pacote?" é de dinheiro, e quem
   * precisa respondê-la é quem lê a trilha de dinheiro.
   */
  | 'package.changed'
  | 'package.refunded'
  /**
   * Financeiro (bloco 51).
   *
   * As quatro carregam centavo. Quitar uma conta pela gaveta tira dinheiro dela
   * e o fechamento do dia vai acusar; transferir decide para onde o dinheiro
   * foi. A pergunta do dia seguinte — "quem pagou a distribuidora duas vezes?"
   * — é de dinheiro, e quem precisa respondê-la é quem lê a trilha de dinheiro.
   *
   * O limite de fiado entra aqui por ser o mais direto de todos: ele autoriza
   * alguém a levar serviço sem pagar, e o `after` guarda quanto.
   */
  | 'bill.created'
  | 'bill.paid'
  | 'bill.received'
  | 'bill.cancelled'
  | 'account.transferred'
  | 'debt.limit_changed'
  | 'debt.opening_balance'
  /**
   * Vale, estorno e transferência de pacote (bloco 52).
   *
   * As quatro carregam centavo. O vale é dinheiro que sai da gaveta hoje e volta
   * como desconto na folha; o estorno devolve dinheiro que já entrou; a
   * transferência de pacote move um vale ao portador de uma pessoa para outra.
   */
  | 'advance.granted'
  | 'advance.cancelled'
  | 'order.refunded'
  | 'package.transferred'
  /**
   * Fiscal (bloco 53).
   *
   * Nenhuma das duas carrega centavo, e por isso ficam na trilha de **gestão**:
   * o que elas guardam é CNPJ, regime, alíquota e o número da nota. As perguntas
   * que respondem — "quem mudou o regime para MEI?", "quem cancelou a nota do
   * cliente?" — são de quem administra a casa, não de quem tem `finance.view`.
   */
  | 'fiscal.settings_changed'
  | 'fiscal.invoice_cancelled'
  /**
   * O CPF do tomador entrando ou saindo do cadastro (bloco 54).
   *
   * A trilha guarda **se** havia documento, nunca qual era: pôr o CPF aqui
   * criaria uma segunda cópia do dado numa tabela append-only, que a
   * anonimização não alcança e que a exportação do titular deixa de fora de
   * propósito.
   */
  | 'customers.tax_id_changed'
  /**
   * O canal de WhatsApp da casa (bloco 55).
   *
   * A trilha guarda **se** o token mudou, nunca o token — mesmo precedente do
   * CPF: uma credencial numa tabela append-only é segredo em repouso que
   * nenhuma limpeza alcança.
   */
  | 'whatsapp.settings_changed'
  | 'whatsapp.template_submitted'
  /** Ligar ou desligar o que a casa manda sozinha para a base (bloco 56). */
  | 'automation.changed'
  /** Uma campanha criada, com o tamanho do público (bloco 57). */
  | 'campaign.created'
  /**
   * Estoque (bloco 44).
   *
   * `stock.adjusted` cobre perda e ajuste — os dois movimentos em que o número
   * muda **sem nota fiscal nem venda**, e a pergunta do dia seguinte é "quem
   * baixou trinta unidades?". Entrada não é auditada: a nota do fornecedor é o
   * registro dela, e auditar toda reposição encheria a trilha do que ninguém
   * procura.
   *
   * Fica no lado da gestão e não no do dinheiro: mexer no estoque não move
   * centavo do caixa, e `inventory.adjust` não tem prefixo de dinheiro — a
   * separação das duas listas é **por permissão**, e é dela que sai a exigência
   * de segundo fator.
   */
  | 'product.changed'
  | 'stock.adjusted'
  /**
   * O clube de assinatura (bloco 45).
   *
   * As três são de **dinheiro**. Mudar o plano define quanto a casa cobra por
   * mês de todo assinante novo; assinar e cancelar ligam e desligam receita
   * recorrente. "Quem cancelou a assinatura do meu cliente?" é pergunta de
   * dinheiro, e quem precisa respondê-la é quem lê a trilha de dinheiro.
   */
  | 'subscription.plan_changed'
  | 'subscription.started'
  | 'subscription.cancelled'
  /**
   * Dependente entrando ou saindo de uma assinatura (bloco 46).
   *
   * De dinheiro pelo mesmo motivo das três acima: incluir alguém dá a essa
   * pessoa acesso à cota **sem** a casa cobrar nada a mais. A pergunta do dia
   * seguinte — "quem pendurou o primo do Carlos no plano?" — é de dinheiro.
   */
  | 'subscription.dependent_changed'
  /**
   * A cobrança recorrente do clube (bloco 47).
   *
   * As três são de dinheiro, e cada uma responde uma pergunta que chega no dia
   * seguinte. `invoice_paid`: "quem deu baixa na mensalidade que eu não paguei?"
   * — o pagamento manual é a única testemunha de dinheiro que entrou por fora do
   * caixa. `invoice_voided`: cancelar uma fatura é perdoar uma dívida, e perdoar
   * dívida é dar desconto com outro nome. `cancel_scheduled`: desligar receita
   * recorrente, pela mesma razão de `subscription.cancelled` — e aqui o ator
   * pode ser o **próprio cliente**, o que a trilha registra com `actor_id` nulo.
   */
  | 'subscription.invoice_paid'
  | 'subscription.invoice_voided'
  | 'subscription.cancel_scheduled'
  /**
   * Ligar ou desligar o split, e mexer na alíquota da plataforma (bloco 49).
   *
   * De dinheiro, e é a mudança de configuração com a maior consequência do
   * produto: ligada, o adquirente manda a comissão **direto para a conta do
   * barbeiro**, e a casa deixa de receber o valor cheio. A pergunta do mês
   * seguinte — "por que entrou menos na conta?" — não teria resposta sem isto.
   */
  | 'split.changed'
  /**
   * O cadastro de um profissional como recebedor no adquirente (bloco 50).
   *
   * De dinheiro: aprovado, ele passa a receber **direto na conta dele**, e a
   * pergunta do dia seguinte é "quem cadastrou essa conta bancária?". O que
   * **não** vai na trilha é o dado bancário: documento, agência e conta
   * atravessam para o adquirente e não são gravados aqui — trilha não é lugar de
   * dado bancário de terceiro.
   */
  | 'split.recipient_changed'
  /**
   * O override do score de confiabilidade (bloco 37).
   *
   * A SPEC §2.13 pede "justificativa auditada" — e é literal: o motivo escrito
   * fica na coluna, quem escreveu fica aqui. Sem isso, dispensar do sinal um
   * conhecido seria uma edição de cadastro como outra qualquer.
   */
  | 'customer.reliability_override'
  // Segundo fator: ligar e desligar mudam quem consegue chegar ao caixa.
  | 'mfa.enabled'
  | 'mfa.disabled'
  | 'mfa.recovery_used'
  /**
   * A barbearia ligou ou desligou a exigência de segundo fator (bloco 37).
   *
   * Diferente de `mfa.enabled`, que é sobre **uma conta**: esta muda a regra
   * para a equipe inteira de uma vez. Desligar é o que mais importa registrar —
   * "quem tirou o segundo fator do financeiro?" precisa de nome e data.
   */
  | 'mfa.policy_enabled'
  | 'mfa.policy_disabled'
  // Comissão: fechar um período paga gente, e mudar a regra muda quanto.
  | 'commission.closed'
  | 'commission.rule_changed'
  // Importação de base: aplicar cria cliente em massa e desfazer apaga. As duas
  // mudam a base inteira de uma vez, que é o tipo de ação cuja pergunta do dia
  // seguinte é "quem fez isso?".
  | 'import.applied'
  | 'import.reverted'
  // LGPD (bloco 31). A SPEC §1.2 já listava exportação de clientes entre os
  // eventos de auditoria obrigatória; o pedido do titular entra junto porque a
  // pergunta de um fiscal é "vocês atenderam, e quando?" — e a resposta não
  // pode ser o estado atual da fila, que já mudou.
  | 'customer.consent_recorded'
  | 'customer.data_exported'
  /**
   * O recado do cliente (bloco 40).
   *
   * A trilha é o que sustenta o limite ético da SPEC §4.10 pelo outro lado:
   * ninguém apaga reclamação — o banco não deixa — e ninguém responde em nome da
   * casa sem deixar registro de quem foi. `feedback.closed` guarda de que estado
   * veio, porque "encerrado sem responder" e "encerrado depois de responder" são
   * duas conversas diferentes com o dono.
   */
  | 'feedback.assigned'
  | 'feedback.answered'
  | 'feedback.closed'
  /**
   * A recuperação de uma nota baixa (bloco 43).
   *
   * A trilha existe porque a janela de 48 horas é o ponto do produto em que mais
   * dá vontade de fazer a coisa errada: registrar "resolvido" sem ter falado com
   * ninguém não esconde a nota — ela publica de qualquer forma —, mas mente para
   * o dono sobre o que a equipe fez. Apagar a avaliação não entra na lista
   * porque não existe operação para isso.
   */
  | 'review.recovered'
  | 'lgpd.request_fulfilled'
  | 'lgpd.request_refused'
  /**
   * A anonimização (bloco 32).
   *
   * É a única ação do produto que destrói dado sem volta, e por isso a trilha
   * dela guarda o **apelido** e o motivo — nunca o nome que saiu. Registrar
   * "anonimizou Carlos Souza" gravaria o nome numa tabela append-only: a
   * operação apagaria o dado de um lugar e o eternizaria noutro.
   */
  | 'customer.anonymized'
  // Endereço público novo apontando para a barbearia. Quem adiciona um slug
  // muda por onde o cliente chega — e é a única ação deste produto que altera
  // algo visível fora dele.
  | 'slug.added'
  // Suporte assistido (bloco 26). A SPEC §1.2 é explícita: o registro grava
  // quem impersonou, quando, por quanto tempo e o que acessou — **e o tenant
  // deve poder consultar esse log**. Por isso as três moram aqui, na trilha da
  // barbearia, e não só na trilha da plataforma, que o dono não lê.
  | 'support.started'
  | 'support.accessed'
  | 'support.ended';

/**
 * O vocabulário partido em dois, porque a leitura não é uma permissão só.
 *
 * A trilha não guarda só *quem fez o quê*: `cash.closed` guarda o esperado, o
 * contado e a divergência; `order.discount`, o valor perdoado; `debt.received`,
 * o saldo do cliente; `commission.closed`, o total da folha do período. Ler isso
 * é ler dinheiro — e no `CLAUDE.md` a exigência de segundo fator é **derivada**
 * da permissão que a rota declara. Uma trilha inteira sob `settings.manage`
 * entregaria o caixa e a folha sem segundo fator a quem foi barrado em
 * `/dashboard/revenue` um minuto antes.
 *
 * Daí duas listas e duas rotas. O que decide de que lado uma ação fica é uma
 * pergunta só: **o `before`/`after` dela contém valor em dinheiro?**
 */
export const ACOES_DE_DINHEIRO: readonly AuditAction[] = [
  'cash.opened',
  'cash.closed',
  'cash.withdrawal',
  'cash.supply',
  'order.closed',
  'order.discount',
  'debt.received',
  'order.charge_created',
  'order.charge_cancelled',
  'deposit.received',
  'deposit.refunded',
  'loyalty.program_changed',
  'loyalty.adjusted',
  'subscription.plan_changed',
  'subscription.started',
  'subscription.cancelled',
  'subscription.dependent_changed',
  'subscription.invoice_paid',
  'subscription.invoice_voided',
  'subscription.cancel_scheduled',
  'split.changed',
  'split.recipient_changed',
  'package.changed',
  'package.refunded',
  'bill.created',
  'bill.paid',
  'bill.received',
  'bill.cancelled',
  'account.transferred',
  'debt.limit_changed',
  'debt.opening_balance',
  'advance.granted',
  'advance.cancelled',
  'order.refunded',
  'package.transferred',
  'commission.closed',
  'commission.rule_changed',
];

/**
 * O resto: conta, papel, permissão e segundo fator.
 *
 * Nenhuma delas carrega centavo — `staff.role_changed` guarda o papel de antes e
 * o de depois, `mfa.disabled` guarda quem desligou. É a trilha que responde
 * "quem deu acesso ao caixa para o Bruno?", e essa pergunta é de quem administra
 * a casa, não de quem tem `finance.view`.
 */
export const ACOES_DE_GESTAO: readonly AuditAction[] = [
  'staff.created',
  'staff.role_changed',
  'staff.deactivated',
  'staff.reactivated',
  'staff.password_reset',
  'permissions.changed',
  'mfa.enabled',
  'mfa.disabled',
  'mfa.recovery_used',
  'mfa.policy_enabled',
  'mfa.policy_disabled',
  'import.applied',
  'import.reverted',
  'slug.added',
  'fiscal.settings_changed',
  'fiscal.invoice_cancelled',
  'customers.tax_id_changed',
  'whatsapp.settings_changed',
  'whatsapp.template_submitted',
  'automation.changed',
  'campaign.created',
  // O override não carrega centavo: guarda o score de antes, o de depois e o
  // motivo. A pergunta que responde — "quem dispensou este cliente do sinal?" —
  // é de quem administra a casa.
  'customer.reliability_override',
  // Nenhuma carrega centavo, e a pergunta que respondem — "quem entrou na minha
  // conta?" — é de quem administra a casa. Fica do lado da gestão.
  'support.started',
  'support.accessed',
  'support.ended',
  /**
   * Os direitos do titular (bloco 31).
   *
   * Do lado da gestão e não do dinheiro, apesar de tocarem dado sensível: a
   * separação das duas listas é **por permissão**, e é dela que sai a exigência
   * de segundo fator. Empurrar a exportação de uma ficha para o lado do dinheiro
   * faria a aba de faturamento listá-la — e faria a trilha de quem administra a
   * casa esconder justamente o evento que a LGPD manda registrar.
   */
  'customer.consent_recorded',
  'customer.data_exported',
  'feedback.assigned',
  'feedback.answered',
  'feedback.closed',
  'review.recovered',
  'product.changed',
  'stock.adjusted',
  'lgpd.request_fulfilled',
  'lgpd.request_refused',
  'customer.anonymized',
];

export interface AuditEntry {
  readonly actorId: string | null;
  readonly actorName: string;
  readonly action: AuditAction;
  readonly entity: string;
  readonly entityId?: string | null;
  /** O par antes/depois: saber que mudou sem saber de quê para quê não fecha investigação. */
  readonly before?: unknown;
  readonly after?: unknown;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

export async function audit(tx: TransactionClient, entrada: AuditEntry): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO audit_log
      (tenant_id, actor_id, actor_name, action, entity, entity_id,
       before, after, ip, user_agent)
    VALUES (
      NULLIF(current_setting('app.tenant_id', true), '')::uuid,
      ${entrada.actorId}::uuid,
      ${entrada.actorName},
      ${entrada.action},
      ${entrada.entity},
      ${entrada.entityId ?? null}::uuid,
      ${entrada.before === undefined ? null : JSON.stringify(entrada.before)}::jsonb,
      ${entrada.after === undefined ? null : JSON.stringify(entrada.after)}::jsonb,
      ${entrada.ip ?? null}::inet,
      ${entrada.userAgent ?? null}
    )
  `;
}

export interface AuditRecord {
  readonly id: string;
  readonly actorName: string;
  readonly action: AuditAction;
  readonly entity: string;
  readonly entityId: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly createdAt: string;
}

/**
 * Últimos eventos da barbearia.
 *
 * Paginação por cursor (`antesDe`), nunca por deslocamento: a trilha só cresce,
 * e `OFFSET` numa tabela que ganha linha a cada ação pula ou repete evento
 * conforme a página é carregada (CLAUDE.md §3).
 */
export async function listAudit(
  tx: TransactionClient,
  params: {
    readonly limite?: number;
    readonly antesDe?: string;
    /**
     * Quais ações devolver. **Obrigatório**, e não opcional com padrão "todas":
     * o padrão permissivo é o que faria uma rota nova nascer entregando o caixa
     * por esquecimento, que é exatamente o defeito que a separação corrige.
     */
    readonly acoes: readonly AuditAction[];
  },
): Promise<readonly AuditRecord[]> {
  const limite = Math.min(params.limite ?? 50, 200);
  if (params.acoes.length === 0) return [];

  const linhas = await tx.$queryRaw<
    {
      id: bigint;
      actor_name: string;
      action: AuditAction;
      entity: string;
      entity_id: string | null;
      before: unknown;
      after: unknown;
      created_at: Date;
    }[]
  >`
    SELECT id, actor_name, action, entity, entity_id, before, after, created_at
    FROM audit_log
    WHERE (${params.antesDe ?? null}::bigint IS NULL OR id < ${params.antesDe ?? null}::bigint)
      AND action = ANY(${params.acoes as string[]}::text[])
    ORDER BY id DESC
    LIMIT ${limite}
  `;

  return linhas.map((linha) => ({
    // `bigint` do Postgres não sobrevive a `JSON.stringify`; o cursor volta como
    // texto e é assim que a próxima página o devolve.
    id: String(linha.id),
    actorName: linha.actor_name,
    action: linha.action,
    entity: linha.entity,
    entityId: linha.entity_id,
    before: linha.before,
    after: linha.after,
    createdAt: linha.created_at.toISOString(),
  }));
}
