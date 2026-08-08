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

  'cash.opened': 'abriu o caixa',
  'cash.closed': 'fechou o caixa',
  'cash.withdrawal': 'fez sangria no caixa',
  'cash.supply': 'fez suprimento no caixa',
  'order.closed': 'fechou a comanda',
  'order.discount': 'deu desconto na comanda',
  'debt.received': 'recebeu um fiado',

  'mfa.enabled': 'ligou o segundo fator de',
  'mfa.disabled': 'desligou o segundo fator de',
  'mfa.recovery_used': 'usou um código de recuperação',

  'commission.closed': 'fechou a comissão do período',
  'commission.rule_changed': 'mudou a regra de comissão de',

  'import.applied': 'trouxe a base do sistema antigo',
  'import.reverted': 'desfez a importação da base',
  'slug.added': 'cadastrou um endereço antigo da barbearia',
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
