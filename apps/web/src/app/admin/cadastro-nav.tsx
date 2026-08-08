/**
 * A barra do cadastro.
 *
 * Quatro telas que a barbearia trata como uma coisa só ("mexer no cadastro"),
 * e que separadas viravam quatro caminhos sem volta um para o outro. A aba
 * atual não vira link: link que leva à página em que já se está é ruído, e
 * quem usa leitor de tela ouve o mesmo destino quatro vezes.
 */

const ABAS = [
  { href: '/admin/catalogo', nome: 'Serviços' },
  { href: '/admin/profissionais', nome: 'Equipe e jornadas' },
  { href: '/admin/recursos', nome: 'Recursos' },
  { href: '/admin/fotos', nome: 'Fotos' },
  { href: '/admin/catalogo/diagnostico', nome: 'Diagnóstico' },
] as const;

export function CadastroNav({ atual }: { readonly atual: string }) {
  return (
    <nav aria-label="Cadastro" className="cadastro-nav ui-scroll-x">
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
