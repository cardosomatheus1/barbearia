/**
 * Permissões e papéis.
 *
 * A SPEC (Parte 1 §1.3) é explícita: **permissões granulares, não papéis
 * fixos**. Papel é só um conjunto nomeado de permissões, e o proprietário pode
 * editar o conjunto. Por isso o que a API pergunta é sempre "esta sessão tem
 * `appointments.cancel`?", nunca "esta sessão é recepcionista?".
 *
 * A diferença aparece no dia em que a barbearia quer que a recepção veja
 * faturamento mas não margem: com papel fixo, isso vira um papel novo no
 * código; com permissão, é uma linha no banco.
 *
 * Este arquivo é o **catálogo** e o **padrão de fábrica**. O que vale em
 * produção é a tabela `role_permissions`, que nasce com este padrão e é
 * editável — configuração de negócio é dado, não constante (CLAUDE.md §4).
 */

/**
 * Toda permissão que existe.
 *
 * Lista fechada de propósito: permissão que só existe como string solta acaba
 * escrita errada em uma rota e nunca concedida a ninguém, e o defeito é
 * silencioso — a rota simplesmente recusa todo mundo.
 */
export const PERMISSOES = [
  'appointments.view',
  'appointments.create',
  'appointments.cancel',
  'appointments.reschedule',
  'appointments.view_all_professionals',
  /**
   * Marcar presença, iniciar e concluir atendimento.
   *
   * Não está na lista da SPEC §1.3, e é uma lacuna dela: o §1.2 descreve a
   * recepcionista fazendo check-in e o barbeiro fazendo "check-in, início/fim
   * de atendimento". Sem uma permissão para isso, operar o balcão só caberia
   * sob `appointments.view` — um write guardado por permissão de leitura — ou
   * sob `appointments.create`, que é outra coisa.
   */
  'appointments.attend',
  'cashier.open',
  'cashier.close',
  'cashier.withdraw',
  'finance.view',
  'finance.view_profit',
  'finance.export',
  /**
   * Dar desconto na comanda.
   *
   * Nasceu como lacuna no bloco 21: descontar exigia `finance.view`, que é
   * *ver dinheiro*. O efeito era o oposto do pretendido — para deixar a
   * recepção dar 10%, era preciso entregar o faturamento junto.
   *
   * Fica no grupo de dinheiro por herdar o prefixo, e está certo: quem pode
   * zerar uma conta é exatamente quem o segundo fator existe para proteger. O
   * teto por barbearia (`tenants.max_discount_bps`) é a outra metade — permissão
   * diz *quem*, teto diz *quanto*.
   */
  'finance.discount',
  /**
   * Registrar e estornar o sinal recebido de um agendamento (bloco 37).
   *
   * É dinheiro que entra fora da comanda — o Pix que o cliente manda para
   * garantir o sábado, dias antes de existir qualquer atendimento. Guardá-la sob
   * `cashier.open` seria errado nos dois sentidos: o sinal entra sem gaveta
   * aberta, e quem abre a gaveta não é necessariamente quem confere o
   * comprovante.
   *
   * Fica no grupo de dinheiro pelo prefixo, e é o que se quer: quem pode dizer
   * "recebi" sobre um valor que ninguém mais viu é exatamente quem o segundo
   * fator existe para proteger.
   */
  'finance.deposit',
  /**
   * Mexer à mão no saldo de fidelidade de um cliente (bloco 41).
   *
   * Prefixo `finance.` de propósito, e não é arrumação: `PERMISSOES_DE_DINHEIRO`
   * deriva o segundo fator do prefixo, e **criar saldo é criar dinheiro** — ele
   * vira forma de pagamento no balcão da operação seguinte. Fora do grupo, a
   * rota que mais se parece com "imprimir dinheiro" seria a única sem segundo
   * fator.
   */
  'finance.loyalty_adjust',
  /**
   * Reembolsar um pacote pela proporção não usada (bloco 42).
   *
   * Não é `settings.manage`, que edita o **catálogo** de pacotes e não move
   * centavo nenhum: com uma permissão só, quem podia cadastrar "5 cortes por
   * R$ 250" podia devolver R$ 150 ao cliente sem passar por dinheiro — e
   * portanto sem segundo fator. São duas tarefas diferentes, como responder
   * pedido de LGPD e apagar a base.
   *
   * Prefixo `finance.` de propósito: o valor sai como crédito no razão do
   * cliente, gastável no balcão da operação seguinte, e é `PERMISSOES_DE_DINHEIRO`
   * que deriva o segundo fator do prefixo.
   */
  'finance.package_refund',
  /**
   * Montar plano de assinatura e assinar alguém (bloco 45).
   *
   * Prefixo `finance.` de propósito: assinar liga **receita recorrente**, e
   * cancelar a desliga. É o mesmo raciocínio de `finance.loyalty_adjust` —
   * `settings.manage` monta o cadastro, mas dizer "este cliente agora paga
   * R$ 149 por mês" é mexer em dinheiro, e o segundo fator é derivado do
   * prefixo.
   */
  'finance.subscription_manage',
  /**
   * Ligar o split e definir a alíquota da plataforma (bloco 49).
   *
   * Prefixo `finance.` pelo mesmo motivo das duas acima, e aqui ele é mais
   * literal que em qualquer outra: ligar o split faz o adquirente mandar dinheiro
   * **direto para a conta do barbeiro**, sem passar pela da casa. É a permissão
   * que decide para onde o dinheiro vai, e o segundo fator derivado do prefixo é
   * o mínimo.
   */
  'finance.split_manage',
  'commission.view_own',
  'commission.view_all',
  'commission.edit_rules',
  'customers.view',
  'customers.edit',
  'customers.export',
  'customers.view_photos',
  'customers.view_notes',
  /**
   * Escrever a anotação, que é diferente de lê-la.
   *
   * A rota de gravar a ficha exigia `customers.view_notes` — escrita guardada
   * por permissão de leitura, que é o defeito que a `/security-review` do bloco
   * 21 cobrou e que ficou declarado até aqui. O barbeiro que lê "não gosta de
   * conversa" não é necessariamente quem deve reescrever isso.
   */
  'customers.edit_notes',
  /**
   * Anonimizar um cadastro (bloco 32).
   *
   * Permissão própria, e não `settings.manage`, porque é a **única operação
   * irreversível do produto**: o nome, o telefone, o nascimento, a ficha e as
   * notas somem, e não há de onde trazê-los de volta. Toda a outra destruição
   * que o sistema permite é reversível — desativar profissional, cancelar
   * atendimento, desfazer importação.
   *
   * A `PermissaoGuard` diz que "isto **ou** aquilo" é sinal de duas rotas. Aqui
   * é o mesmo raciocínio um passo antes: atender um pedido de cópia e atender
   * um pedido de exclusão parecem a mesma tarefa e não são, e amarrá-las na
   * mesma permissão faria quem responde e-mail poder apagar a base.
   *
   * Só o dono tem por padrão — como `customers.export`, e pelo motivo espelhado:
   * uma é o vetor de roubo da base, a outra é o de destruição dela.
   */
  'customers.anonymize',
  /**
   * Substituir à mão o score de confiabilidade de um cliente (bloco 37).
   *
   * A SPEC §2.13 pede o override "pelo gerente, com justificativa auditada", e
   * a palavra gerente é a especificação: `customers.edit` é de toda a recepção,
   * e com ela o override viraria o caminho mais curto para dispensar o sinal de
   * um conhecido — sem passar por dinheiro nenhum, portanto sem segundo fator.
   *
   * Permissão própria pelo mesmo motivo de `customers.anonymize`: parece a
   * mesma tarefa de editar um cadastro e não é.
   */
  'customers.reliability_override',
  /**
   * Ler a fila de recados do cliente (bloco 40).
   *
   * Separada de `feedback.manage` pelo mesmo motivo de `customers.view_notes` e
   * `customers.edit_notes`: ler o que reclamaram e **responder em nome da casa**
   * são tarefas diferentes. A resposta sai por mensagem, assinada pela
   * barbearia, e não é de todo mundo.
   */
  'feedback.view',
  /**
   * Assumir, responder e encerrar um recado (bloco 40).
   *
   * Note o que **não** existe: não há `feedback.delete`. É o limite ético da
   * SPEC §4.10 — o produto não oferece apagar reclamação —, e ele não depende
   * desta lista: o role da aplicação não tem `DELETE` na tabela.
   */
  'feedback.manage',
  /**
   * As avaliações (bloco 43).
   *
   * Ler e agir são coisas diferentes, como `feedback.view` e `feedback.manage`:
   * o barbeiro precisa ver o que dizem do trabalho dele — é o indicador que a
   * SPEC §4.21 manda comparar com o próprio passado —, e falar em nome da casa
   * dentro da janela de recuperação é do balcão.
   *
   * Não existe uma terceira que apague. A SPEC §4.10 proíbe o produto de
   * oferecer "apagar avaliação ruim", e a ausência aqui é essa frase escrita
   * onde não depende de ninguém lembrar — junto do `REVOKE DELETE` do banco.
   */
  'reviews.view',
  'reviews.recover',
  'reports.finance',
  'reports.operational',
  'inventory.view',
  'inventory.adjust',
  'marketing.send',
  'settings.manage',
  'team.manage',
] as const;

export type Permissao = (typeof PERMISSOES)[number];

const CONJUNTO: ReadonlySet<string> = new Set(PERMISSOES);

export function ehPermissao(valor: string): valor is Permissao {
  return CONJUNTO.has(valor);
}

/**
 * Permissões que movem ou revelam dinheiro.
 *
 * Existem como grupo porque o `CLAUDE.md` exige MFA para quem as tem, e uma
 * regra que depende de alguém lembrar de conferir prefixo em cada rota não é
 * uma regra. A `PermissaoGuard` cobra o segundo fator a partir daqui.
 *
 * **`cashier.` entrou no bloco 18, quando a gaveta passou a existir.** O grupo
 * nasceu como "o prefixo `finance.`" porque era o único que havia, e o nome
 * dele sempre disse "move ou revela dinheiro" — `cashier.withdraw` é
 * literalmente tirar dinheiro da gaveta. Deixar de fora significaria segundo
 * fator para *ver* o faturamento e nenhum para *levar* a sangria, que é o
 * inverso do risco.
 */
export const PERMISSOES_DE_DINHEIRO: readonly Permissao[] = PERMISSOES.filter(
  (p): p is Permissao =>
    p.startsWith('finance.') ||
    p.startsWith('cashier.') ||
    // Ver a comissão de todo mundo é ver a folha; mudar a regra é mudar quanto
    // cada um recebe. As duas revelam ou movem dinheiro.
    p === 'commission.view_all' ||
    p === 'commission.edit_rules',
);

/**
 * A exceção, escrita para poder ser discutida.
 *
 * `commission.view_own` fica **fora** do grupo de propósito. É o barbeiro
 * olhando o próprio holerite — o dado é dele, e ele já provou a senha. Exigir
 * segundo fator para isso poria um código de seis dígitos entre o profissional
 * e a primeira tela que ele abre todo dia, e o desfecho real de atrito assim é
 * a barbearia procurando como desligar a proteção inteira.
 *
 * A linha é: **segundo fator protege o dinheiro dos outros.**
 */
export const PERMISSAO_DE_DINHEIRO_SEM_SEGUNDO_FATOR = 'commission.view_own' as const;

export type Papel = 'owner' | 'manager' | 'receptionist' | 'professional';

export const PAPEIS: readonly Papel[] = ['owner', 'manager', 'receptionist', 'professional'];

/**
 * Padrão de fábrica de cada papel.
 *
 * As três separações que a SPEC chama de não negociáveis:
 *
 * - **`commission.view_own` ≠ `commission.view_all`.** Barbeiro que vê a
 *   comissão do colega é o motivo nº 1 de briga interna em barbearia. O
 *   profissional recebe só a própria.
 * - **`finance.view_profit` separado de `finance.view`.** O gerente vê
 *   faturamento sem ver margem — é o que permite delegar a operação sem
 *   entregar a estratégia.
 * - **`customers.export` isolado.** É o vetor de roubo de base quando alguém
 *   sai, e por isso não acompanha `customers.view` nem sequer para o gerente.
 *
 * O dono tem tudo por definição: é a única conta que não pode ser trancada para
 * fora do próprio negócio.
 */
const PADRAO: Readonly<Record<Papel, readonly Permissao[]>> = {
  owner: PERMISSOES,

  manager: [
    'appointments.view',
    'appointments.create',
    'appointments.cancel',
    'appointments.reschedule',
    'appointments.view_all_professionals',
    'appointments.attend',
    'cashier.open',
    'cashier.close',
    'cashier.withdraw',
    // Faturamento sim, margem não.
    'finance.view',
    'finance.discount',
    'finance.deposit',
    'commission.view_all',
    'customers.view',
    'customers.edit',
    'customers.view_notes',
    'customers.edit_notes',
    // O override do score é do gerente por definição da SPEC §2.13.
    'customers.reliability_override',
    'feedback.view',
    'feedback.manage',
    'reviews.view',
    'reviews.recover',
    'finance.subscription_manage',
    'reports.operational',
    'inventory.view',
    'inventory.adjust',
    'settings.manage',
  ],

  receptionist: [
    'appointments.view',
    'appointments.create',
    'appointments.cancel',
    'appointments.reschedule',
    'appointments.view_all_professionals',
    'appointments.attend',
    'cashier.open',
    'customers.view',
    'customers.edit',
    // Sem `customers.view_photos` nem `customers.view_notes`: a recepção precisa
    // achar o cliente, não ler o que anotaram sobre ele.
    /**
     * O recado, sim — inteiro.
     *
     * É a recepção que responde WhatsApp o dia todo, e um canal de reclamação
     * que só o dono consegue responder é um canal que ninguém responde.
     */
    'feedback.view',
    'feedback.manage',
    /**
     * A avaliação também, e pela mesma razão: a janela de recuperação é de 48
     * horas, e um alerta que só o dono consegue tratar é um alerta que vence
     * sozinho no fim de semana — publicando a nota sem ninguém ter ligado.
     */
    'reviews.view',
    'reviews.recover',
    'inventory.view',
  ],

  professional: [
    'appointments.view',
    'appointments.create',
    'appointments.cancel',
    'appointments.reschedule',
    'appointments.attend',
    'commission.view_own',
    'customers.view',
    'customers.view_notes',
    /**
     * O barbeiro escreve a anotação, e é o desenho certo: quem descobre que o
     * cliente não gosta de conversa é quem atende, não a recepção. A separação
     * que este bloco cria é para o dono poder **tirar** — não para começar
     * tirando de quem já fazia.
     */
    'customers.edit_notes',
    /**
     * **Sem `feedback.view` por padrão**, e é decisão.
     *
     * Reclamação costuma ser sobre uma pessoa, e escrita por quem não sabe que
     * alguém do salão vai ler. "O barbeiro do fundo é grosso" na tela do colega
     * transforma um canal de melhoria em fofoca com endereço. O dono concede
     * quando quiser — a tela de permissões existe desde o bloco 30 —, e aí é
     * uma decisão tomada, não um padrão herdado.
     */
    /**
     * **Sem `reviews.view` por padrão**, e pelo mesmo motivo (bloco 43).
     *
     * A permissão dá as avaliações da casa inteira, e a nota de um colega na
     * tela do outro é a briga que `commission.view_own` existe para evitar. O
     * barbeiro vê a **própria** média em *Meus números*, onde ela é comparada
     * com o passado dele — que é o que a SPEC §4.21 manda, e o contrário de
     * ranking.
     */
  ],
};

export function permissoesPadrao(papel: Papel): readonly Permissao[] {
  return PADRAO[papel];
}

/**
 * A pergunta que a API faz e a tela repete.
 *
 * Uma função só, usada nos dois lados: a permissão exibida sai da mesma decisão
 * que a API aplica (CLAUDE.md). Recalcular na view é como a tela acaba
 * oferecendo um botão que o servidor recusa.
 */
export function pode(
  concedidas: Iterable<string>,
  exigida: Permissao,
): boolean {
  for (const permissao of concedidas) {
    if (permissao === exigida) return true;
  }
  return false;
}

/** Todas as exigidas, não alguma: rota que pede duas precisa das duas. */
export function podeTudo(
  concedidas: Iterable<string>,
  exigidas: readonly Permissao[],
): boolean {
  const tem = new Set(concedidas);
  return exigidas.every((permissao) => tem.has(permissao));
}

/**
 * O que uma sessão de suporte da plataforma pode fazer (bloco 26).
 *
 * Impersonação é a capacidade mais grave do produto: um funcionário nosso
 * dentro da conta de um cliente, vendo a base dele. A SPEC pede trilha
 * obrigatória, e trilha é o que responde *depois*. Esta lista é o que limita
 * *antes*.
 *
 * **Lista explícita, não um padrão de nome.** Um filtro por prefixo `view`
 * pareceria mais elegante e erraria: deixaria `reports.operational` de fora
 * (é leitura pura) e deixaria `customers.export` **dentro** se alguém um dia a
 * renomeasse para `customers.view_export`. Exportar a base de clientes de uma
 * barbearia é justamente o que uma sessão de suporte nunca deveria conseguir.
 *
 * ## O que ficou de fora, e por quê
 *
 * **Dinheiro.** `finance.view`, `cashier.*`, `commission.*` e `reports.finance`
 * não estão aqui. A primeira versão desta lista incluía os dois primeiros, e
 * eles teriam sido letra morta: a `PermissaoGuard` deriva a exigência de
 * segundo fator dessas mesmas permissões, e a prova é por sessão — a sessão de
 * suporte nasce sem ela, e o suporte não tem o autenticador do dono. Seriam
 * entradas que nunca liberariam nada, o que é pior do que não existirem.
 *
 * A conclusão a que isso levou é a certa por mérito próprio: **suporte vê a
 * operação, não o caixa.** Quem liga reclamando de horário que não aparece
 * precisa que a gente veja a agenda; nada disso pede o faturamento dele.
 *
 * **Foto de cliente.** `customers.view_photos` exige consentimento específico
 * (LGPD, `CLAUDE.md`), e o consentimento que a barbearia coletou não cobre um
 * terceiro olhando.
 */
export const PERMISSOES_DO_SUPORTE: readonly Permissao[] = [
  'appointments.view',
  'appointments.view_all_professionals',
  'customers.view',
  'inventory.view',
  'reports.operational',
];

const SUPORTE: ReadonlySet<string> = new Set(PERMISSOES_DO_SUPORTE);

/**
 * Esta ação é permitida dentro de uma sessão de suporte?
 *
 * A lista vazia é **não**, e essa é a parte que quase escapou. `@Exige()` sem
 * argumento é a única fuga da guarda de permissão, e existe para as rotas que a
 * conta usa **sobre si mesma** — trocar a própria senha, sair. Uma sessão de
 * suporte não é a conta: `every` sobre lista vazia devolve verdadeiro, e sem
 * esta cláusula o suporte trocaria a senha do dono da barbearia.
 */
export const suportePode = (exigidas: readonly Permissao[]): boolean =>
  exigidas.length > 0 && exigidas.every((p) => SUPORTE.has(p));
