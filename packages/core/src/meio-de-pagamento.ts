/**
 * Os meios de pagamento que a **casa aceita** — o que a recepção responde
 * quando o cliente pergunta "vocês aceitam Pix?".
 *
 * ## Isto não é `FormaDePagamento`
 *
 * `comanda.ts` tem `FormaDePagamento`, com dez valores, e ela responde outra
 * pergunta: **por onde este dinheiro entrou nesta venda** — dinheiro, débito,
 * crédito, fiado, fidelidade, pacote, assinatura. Aqui são quatro, e é o que a
 * barbearia **anuncia**. As duas se parecem o bastante para alguém juntar, e
 * juntá-las faria a página pública anunciar "aceitamos fiado" e "aceitamos
 * pacote", que não são meios de pagamento: são coisas que já foram pagas.
 *
 * Por isso o rótulo tem nome próprio (`ROTULO_DO_MEIO_ACEITO`) e não
 * `ROTULO_DA_FORMA`, que já existe e significa outra coisa — a armadilha de
 * `PESO_DO_ATRASO`, que foi "chegar depois da hora" num pacote e "estar vencido
 * para voltar" noutro.
 *
 * ## Por que mora em `core`
 *
 * A lista nasceu em `packages/onboarding`, que é quem **grava**. Quem precisa
 * dela agora é a recepção automática (`recepcao.ts`, aqui) e a tela de
 * Configurações — e `core` não pode depender de `onboarding`. Escrevê-la de
 * novo seria a lista paralela de sempre; `onboarding` passa a reexportar.
 */
export const MEIOS_ACEITOS = ['pix', 'card', 'cash', 'online'] as const;

export type MeioAceito = (typeof MEIOS_ACEITOS)[number];

/**
 * O rótulo, num `Record` **total** da união.
 *
 * `Record<string, string>` deixaria o valor novo chegar cru à tela; com a união
 * o compilador cobra a frase no dia em que o quinto meio existir.
 */
export const ROTULO_DO_MEIO_ACEITO: Readonly<Record<MeioAceito, string>> = {
  pix: 'Pix',
  card: 'Cartão',
  cash: 'Dinheiro',
  online: 'Pagamento online',
};

export function ehMeioAceito(valor: string): valor is MeioAceito {
  return (MEIOS_ACEITOS as readonly string[]).includes(valor);
}
