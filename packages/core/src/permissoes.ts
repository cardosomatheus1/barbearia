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
  'commission.view_own',
  'commission.view_all',
  'commission.edit_rules',
  'customers.view',
  'customers.edit',
  'customers.export',
  'customers.view_photos',
  'customers.view_notes',
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
 * uma regra. Há teste que impede uma rota de exigir qualquer uma delas
 * enquanto o segundo fator não existir.
 */
export const PERMISSOES_DE_DINHEIRO: readonly Permissao[] = PERMISSOES.filter(
  (p): p is Permissao => p.startsWith('finance.'),
);

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
    'commission.view_all',
    'customers.view',
    'customers.edit',
    'customers.view_notes',
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
