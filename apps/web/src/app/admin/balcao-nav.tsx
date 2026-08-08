/**
 * A barra do balcão.
 *
 * Mesma decisão da barra do cadastro: a recepção trata dia, fila, caixa e
 * fiado como uma coisa só ("atender"), e sem a barra cada uma vira um caminho
 * sem volta para as outras. A aba atual não vira link — link para a página em
 * que já se está é ruído, e quem usa leitor de tela ouve o mesmo destino
 * quatro vezes.
 */

const ABAS = [
  { href: '/admin/dia', nome: 'Dia' },
  { href: '/admin/agenda', nome: 'Agenda' },
  { href: '/admin/fila', nome: 'Fila' },
  { href: '/admin/caixa', nome: 'Caixa' },
  { href: '/admin/fiado', nome: 'Fiado' },
] as const;

export function BalcaoNav({ atual }: { readonly atual: string }) {
  return (
    <nav aria-label="Balcão" className="cadastro-nav ui-scroll-x">
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
