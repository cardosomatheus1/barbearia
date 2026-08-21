/**
 * Em que pé está o contrato entre a plataforma e uma barbearia.
 *
 * Os quatro valores são os do adquirente, e por isso estão em inglês: eles
 * espelham o vocabulário de `subscriptions.status`, que por sua vez espelha o
 * da Stripe. Traduzi-los no schema faria toda conciliação com o extrato dele
 * exigir um de-para na cabeça de quem lê.
 *
 * Mora em `core` desde o bloco 128, quando a tela da plataforma passou a
 * mostrá-los: `packages/platform` é servidor e `apps/web` não depende dele, e a
 * saída fácil — reescrever a união na tela — é a lista paralela de sempre. Ela
 * quase entrou com cinco valores em português, o que teria feito o `Record`
 * total mentir dizendo que os quatro de verdade não existem.
 *
 * ## E o nome carrega "da plataforma" porque a colisão é real
 *
 * `assinatura.ts` já tem `EstadoDaAssinatura` e `ESTADOS_DA_ASSINATURA`, com
 * cinco valores em português — e são **do clube**, o que o cliente paga à
 * barbearia. É a mesma distinção que separa `subscriptions` de
 * `club_subscriptions` no schema: dois fatos com o mesmo nome de negócio, que
 * confundidos aqui seriam confundidos em toda consulta daqui para a frente.
 * Sem o sufixo, o barril de `core` exportaria dois nomes iguais e um passaria a
 * ser lido como o outro — a armadilha de `PESO_DO_ATRASO`.
 */
export const ESTADOS_DA_ASSINATURA_DA_PLATAFORMA = ['trialing', 'active', 'past_due', 'canceled'] as const;

export type EstadoDaAssinaturaDaPlataforma = (typeof ESTADOS_DA_ASSINATURA_DA_PLATAFORMA)[number];

/**
 * O rótulo em português, num `Record` **total** da união.
 *
 * "Suspensa" não está aqui porque não é estado da assinatura: quem suspende é a
 * régua de cobrança, e ela mora em `invoices`. Inventar o quinto rótulo seria a
 * tela afirmando um estado que o banco não tem.
 */
export const ROTULO_DO_ESTADO_DA_ASSINATURA_DA_PLATAFORMA: Readonly<Record<EstadoDaAssinaturaDaPlataforma, string>> = {
  trialing: 'Em teste',
  active: 'Ativa',
  past_due: 'Inadimplente',
  canceled: 'Cancelada',
};

/** A assinatura está valendo hoje? Teste conta: o benefício está entregue. */
export function assinaturaDaPlataformaEmDia(estado: EstadoDaAssinaturaDaPlataforma): boolean {
  return estado === 'active' || estado === 'trialing';
}
