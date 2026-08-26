import Link from 'next/link';

/**
 * O 404 do painel da plataforma.
 *
 * Mesmo motivo do `not-found.tsx` do admin: o da raiz fala com quem procura uma
 * barbearia e manda conferir a bio dela. Aqui quem erra a rota é gente nossa,
 * dentro da ferramenta de operação — a instrução da raiz não teria como funcionar.
 *
 * Renderiza dentro do `layout.tsx` da plataforma, então a barra de navegação
 * continua na tela e a saída existe sem depender deste link.
 */
export default function NaoEncontradaNaPlataforma() {
  return (
    <main className="ui-container vazio-pagina">
      <div className="vazio">
        <p className="vazio__titulo">Esta tela não existe</p>
        <p className="vazio__saida">
          O endereço pode ser de uma versão anterior do painel, ou ter sido digitado com um
          erro.
        </p>
        <p className="vazio__saida">
          <Link className="ui-button ui-button--ghost" href="/plataforma">
            Ir para o início da plataforma
          </Link>
        </p>
      </div>
    </main>
  );
}
