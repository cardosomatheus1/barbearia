import { cookies } from 'next/headers';
import { COOKIE_DA_VAGA, lerVaga, NOMES_QUE_ATRAVESSAM } from '@/lib/vaga';

/**
 * O aviso da vaga que acabou de abrir (bloco 38, com nomes desde o 110).
 *
 * Aparece **no instante do cancelamento**, e é o único instante em que serve:
 * daqui a dez minutos o horário já pode ter sido marcado por quem entrou no
 * site. Por isso ele traz quem ligar, e não um link para procurar.
 *
 * Até o bloco 110 mostrava só a contagem e mandava para a lista de espera
 * inteira da unidade — três casados contra seis listados, dois dos quais nem
 * cabiam no horário que abriu. A recepcionista com o telefone na mão refazia na
 * cabeça o cruzamento que o motor já tinha feito, e as duas telas discordavam
 * sobre o mesmo fato (§6, pergunta 6).
 *
 * Mora nas duas telas que movem atendimento: o balcão cancela pelo painel do
 * dia e o barbeiro pelo dele, e a vaga que abre é a mesma. Uma cópia por tela
 * seria a lista paralela de sempre.
 *
 * ## O que ele **não** manda fazer
 *
 * O convite já saiu. `applyAttendance` enfileira `agendarOfertaDaVaga` na mesma
 * transação, e a oferta é **exclusiva e um de cada vez** — com um `slot_holds`
 * segurando o horário enquanto a pessoa decide. Um aviso que dissesse "ligue
 * para estas seis" mandaria a recepção oferecer por fora o horário que o produto
 * já prometeu a uma delas.
 *
 * Então ele informa, e diz de quem é a vez. Serve para a recepção responder
 * quem está do outro lado da linha, e para ligar quando a mensagem não chega —
 * que hoje é o caso comum, porque o canal de WhatsApp é lacuna declarada.
 */
export async function QuemQueriaAVaga() {
  const vaga = lerVaga((await cookies()).get(COOKIE_DA_VAGA)?.value);
  if (!vaga) return null;

  const sobrando = vaga.total - vaga.nomes.length;
  const [primeiro] = vaga.nomes;

  return (
    <div className="ui-alert ui-alert--warning painel__aviso" role="status">
      <p className="vaga__titulo">
        {vaga.total === 1
          ? 'Uma pessoa esperava por um horário assim.'
          : `${vaga.total} pessoas esperavam por um horário assim.`}{' '}
        {primeiro
          ? `O convite já saiu para ${primeiro.nome}, que tem o horário guardado enquanto decide.`
          : 'O convite já saiu para a primeira da fila, que tem o horário guardado enquanto decide.'}
      </p>

      {/*
        Sem nomes é o caso da permissão, não erro: quem não tem `customers.view`
        recebe do domínio a contagem com o nome em branco. A linha ainda diz o
        que a recepção precisa — existe gente para este horário —, e quem pode
        ver cliente abre a lista.
      */}
      {vaga.nomes.length > 0 ? (
        <ul className="vaga__lista">
          {vaga.nomes.map((quem, posicao) => (
            <li className="vaga__quem" key={quem.id}>
              <strong className="vaga__nome">{quem.nome}</strong>
              {/*
                Só os quatro últimos, como o domínio devolve: a tela do balcão
                fica virada para o salão, e o número inteiro na parede é dado de
                cliente exposto a quem está sentado esperando. Quem precisa ligar
                abre a ficha, que exige a permissão de ver cadastro.
              */}
              <span className="vaga__fone">
                {quem.fim4 ? `final ${quem.fim4}` : 'sem telefone'}
              </span>
              <span className="vaga__janela">
                queria entre {quem.de} e {quem.ate}
              </span>
              {/*
                Só a primeira leva marca. "Na fila" nas outras quatro é a mesma
                informação que a ordem já dá, repetida quatro vezes — e o que se
                procura aqui é justamente a linha que se destaca das demais.
              */}
              {posicao === 0 ? <span className="vaga__vez">é a vez dela</span> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {sobrando > 0 && vaga.nomes.length > 0 ? (
        <p className="vaga__resto">
          {/*
            O teto é regra de produto e a tela diz o número: cinco é o que cabe
            numa decisão de balcão. Quem precisa da fila inteira usa a lista, que
            é o link abaixo.
          */}
          Mostrando os {NOMES_QUE_ATRAVESSAM} primeiros a chegar
          {sobrando === 1 ? ' — falta 1' : ` — faltam ${sobrando}`}.
        </p>
      ) : null}

      <a className="vaga__lista-inteira" href="/admin/agenda#esperando">
        Ver a lista de espera inteira
      </a>
    </div>
  );
}
