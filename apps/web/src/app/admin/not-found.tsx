import Link from 'next/link';

/**
 * O 404 de dentro do painel.
 *
 * A raiz tem um `not-found.tsx` que diz "Estabelecimento não encontrado — confira
 * o endereço na bio da barbearia". Ele está certo para quem digitou errado o
 * endereço público da barbearia, e é a única audiência que ele imagina: sem este
 * arquivo, o dono que erra uma rota do próprio painel — ou que abre um link salvo
 * de uma versão anterior — é mandado conferir o Instagram da própria barbearia.
 *
 * É a forma 404 do que a convenção já registra sobre o 403 respondido com
 * "recarregue a página": a recusa vestida de outra coisa, com uma instrução que
 * nunca vai funcionar.
 *
 * Renderiza dentro do `layout.tsx` do admin, então quem tem sessão recebe o casco
 * e sai daqui pela navegação de sempre — §6, pergunta 1: toda tela tem volta. O
 * link abaixo é para quem não a tem, que é o caso de quem ainda não entrou.
 */
export default function NaoEncontradaNoPainel() {
  return (
    <main className="ui-container vazio-pagina">
      <div className="vazio">
        <p className="vazio__titulo">Esta tela não existe</p>
        <p className="vazio__saida">
          O endereço pode ser de uma versão anterior do painel, ou ter sido digitado com um
          erro. Use o menu para chegar onde queria.
        </p>
        <p className="vazio__saida">
          <Link className="ui-button ui-button--ghost" href="/admin">
            Ir para o início do painel
          </Link>
        </p>
      </div>
    </main>
  );
}
