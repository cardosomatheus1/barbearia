/**
 * O selo do Barber Dock nas portas do sistema.
 *
 * Entrar, criar conta e trocar a senha de primeiro acesso são as três telas em
 * que a pessoa **ainda não sabe onde está** — não há barra, não há nome de
 * barbearia, não há nada além de um formulário. Eram as únicas do produto sem
 * nenhuma marca, e um campo de senha sem marca é onde ninguém deveria digitar
 * senha nenhuma.
 *
 * A imagem declara `width`/`height` e a classe fixa a proporção, porque sem os
 * dois o navegador não reserva o espaço e o formulário pula para baixo quando o
 * selo termina de carregar — no exato instante em que a pessoa mira o primeiro
 * campo.
 *
 * A classe é `selo-produto`, e não `marca`: `.marca` já é a pílula de caixa de
 * seleção que oito telas usam para marcar dia da semana. Reaproveitar o nome
 * herdava aquele layout em silêncio — foi o que aconteceu, e o selo apareceu
 * dentro de uma cápsula branca arredondada. Mesma armadilha do `.achado` no
 * bloco 21.
 */
export function Marca() {
  return (
    <p className="selo-produto">
      <img
        alt=""
        className="selo-produto__img"
        height={384}
        src="/barber-dock.png"
        width={384}
      />
      <span className="selo-produto__nome">
        Barber Dock
        <small>Sistema de gestão</small>
      </span>
    </p>
  );
}
