/**
 * A barra do barbeiro.
 *
 * Duas telas, e só duas: o dia e os números. O painel do balcão tem sete abas
 * porque a recepção faz sete coisas; o barbeiro faz uma, e a segunda tela existe
 * para ele não precisar da primeira quando a pergunta é sobre o mês.
 *
 * A aba atual não vira link — link que leva à página em que já se está é ruído,
 * e quem usa leitor de tela ouve o mesmo destino duas vezes.
 */

const ABAS = [
  { href: '/admin/meu-dia', nome: 'Meu dia' },
  { href: '/admin/meus-numeros', nome: 'Meus números' },
] as const;

export function ProNav({ atual }: { readonly atual: string }) {
  return (
    <nav aria-label="Minhas telas" className="cadastro-nav ui-scroll-x">
      <ul className="cadastro-nav__lista">
        {ABAS.map((aba) => (
          <li key={aba.href}>
            {aba.href === atual ? (
              <span aria-current="page" className="cadastro-nav__aba cadastro-nav__aba--atual">
                {aba.nome}
              </span>
            ) : (
              <a className="cadastro-nav__aba" href={aba.href}>
                {aba.nome}
              </a>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
