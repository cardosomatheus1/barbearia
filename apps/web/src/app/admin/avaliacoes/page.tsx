import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  DESFECHOS_DA_RECUPERACAO,
  JANELA_DE_RECUPERACAO_HORAS,
  MOTIVOS_DA_CONTESTACAO,
  ROTULO_DA_CATEGORIA,
  PRAZO_PARA_TRATAR,
  ROTULO_DO_DESFECHO,
  ROTULO_DO_MOTIVO,
  VERBO_DA_RECUPERACAO,
  type CategoriaDaAvaliacao,
  notaExibida,
} from '@barbearia/core';
import { painelDeAvaliacoesNaApi, type AvaliacaoNaTela } from '@/lib/admin-api';
import { localTime } from '@/lib/date';
import { painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import {
  acaoContestarAvaliacao,
  acaoRetirarContestacao,
  acaoSair,
  acaoTratarAvaliacao,
} from '../acoes';
import { secao } from '../secoes';
import { AvisoDeRecusa } from '@/app/admin/aviso-de-recusa';
import { marcaDaRecusa } from '../falha-da-leitura';
import { ARecuperar, Contestar, dia, hora } from './componentes';

/**
 * Avaliações e recuperação de nota baixa (bloco 43, SPEC §4.10).
 *
 * ## A tela diz o que a janela é, e o que ela não é
 *
 * O prazo aparece em horas, e junto dele a frase que impede o mal-entendido:
 * **passado o prazo a avaliação publica de qualquer forma.** Sem isso, um
 * contador de 48 horas ao lado de um formulário parece um botão de esconder — e
 * a equipe aprenderia a usá-lo assim.
 *
 * Por isso também não existe "arquivar" nem "descartar" aqui. A única ação é
 * registrar o que foi feito, e ela não muda o destino da nota.
 *
 * ## Duas médias, e a diferença entre elas é a informação
 *
 * A **sua** conta tudo, publicado ou não — é a real, e é a que decide contratar
 * e demitir. A **pública** é a que o cliente vê no seu perfil. Quando as duas
 * se afastam, é porque há nota baixa segurada, e o número diz isso sem precisar
 * de legenda.
 */

export const metadata: Metadata = {
  title: 'Notas e reputação',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const FALHA: Record<string, string> = {
  motivo_curto: 'Escreva o que foi feito — pelo menos uma frase.',
  ja_resolvida: 'Esta avaliação já foi tratada por alguém.',
  ja_contestada: 'Esta avaliação já está contestada.',
  nao_contestada: 'Esta avaliação não está contestada.',
  motivo_invalido: 'Escolha um dos motivos da lista.',
  avaliacao_nao_encontrada: 'Esta avaliação não existe mais.',
  forbidden: 'Sua conta não trata avaliações.',
  invalid_request: 'Confira os dados e tente de novo.',
  request_failed: 'Não deu para salvar. Tente de novo.',
};

/**
 * Data e hora **no fuso da unidade** (bloco 114).
 *
 * `toLocaleDateString` sem `timeZone` usa o fuso do **processo**, que em
 * produção é UTC: uma avaliação escrita à 01h55 na Bahia aparecia com a data do
 * dia seguinte, e o atendimento das 17h20 saía como 21h40. É o defeito D2 na
 * tela em que a gerência tem 48h para ligar — ela procurava na agenda um
 * horário numa casa que já estava fechada.
 */



function Avaliacao({
  avaliacao,
  podeContestar,
  fuso,
}: {
  readonly avaliacao: AvaliacaoNaTela;
  readonly podeContestar: boolean;
  readonly fuso: string;
}) {
  const categorias = Object.entries(avaliacao.categorias) as [CategoriaDaAvaliacao, number][];

  return (
    <article className="avaliacao">
      <header className="avaliacao__topo">
        <p className="avaliacao__estrelas" aria-label={`Nota ${avaliacao.nota} de 5`}>
          {avaliacao.estrelas}
        </p>
        <p className="avaliacao__prazo">
          {avaliacao.contestadaEm
            ? 'Contestada — fora do seu perfil'
            : avaliacao.publicada
              ? 'No seu perfil'
              : 'Ainda não publicada'}
        </p>
      </header>

      <p className="avaliacao__quem">
        {avaliacao.clienteNome}
        {avaliacao.servicoNome ? ` · ${avaliacao.servicoNome}` : ''}
        {avaliacao.profissionalNome ? ` com ${avaliacao.profissionalNome}` : ''}
      </p>
      <p className="avaliacao__quando">{dia(fuso, avaliacao.criadaEm)}</p>

      {avaliacao.comentario ? (
        <blockquote className="avaliacao__texto">{avaliacao.comentario}</blockquote>
      ) : null}

      {categorias.length > 0 ? (
        <ul className="avaliacao__categorias">
          {categorias.map(([chave, nota]) => (
            <li key={chave}>
              {ROTULO_DA_CATEGORIA[chave]} <span className="tabular">{nota}/5</span>
            </li>
          ))}
        </ul>
      ) : null}

      {avaliacao.resolvidaEm ? (
        <p className="avaliacao__tratada">
          <strong>{avaliacao.desfecho ? ROTULO_DO_DESFECHO[avaliacao.desfecho] : 'Tratada'}</strong>{' '}
          — {avaliacao.resolucao}
        </p>
      ) : null}

      {/*
        A contestação registrada aparece com o motivo e a justificativa, e não
        um selo mudo. Quem abre a tela seis meses depois precisa saber por que a
        nota saiu do ar — e é isso que separa suspender de esconder.
      */}
      {avaliacao.contestadaEm ? (
        <>
          <p className="avaliacao__tratada">
            <strong>
              Contestada
              {avaliacao.contestacaoMotivo
                ? ` · ${ROTULO_DO_MOTIVO[avaliacao.contestacaoMotivo]}`
                : ''}
            </strong>{' '}
            — {avaliacao.contestacaoNota}
            <br />
            <span className="avaliacao__quando">
              Fora do seu perfil desde {dia(fuso, avaliacao.contestadaEm)}. Continua contando na sua
              média.
            </span>
          </p>

          {/*
            A saída do estado, na tela. Sem este botão a contestação seria
            definitiva — apagar com mais passos, que é o que este bloco existe
            para não ser. Quem contestou por engano desfaz aqui.
          */}
          {podeContestar ? (
            <form action={acaoRetirarContestacao} className="avaliacao__retirar">
              <input name="id" type="hidden" value={avaliacao.id} />
              <button className="ui-button ui-button--ghost" type="submit">
                Retirar a contestação
              </button>
            </form>
          ) : null}
        </>
      ) : podeContestar ? (
        <Contestar avaliacao={avaliacao} />
      ) : null}
    </article>
  );
}

export default async function AvaliacoesPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const podeTratar = podeNaTela(estado, 'reviews.recover');
  // O fuso vem da unidade, nunca do processo — que em produção é UTC.
  const fuso = estado.empresa.timezone;
  const podeContestar = podeNaTela(estado, 'reviews.contest');
  const resposta = await painelDeAvaliacoesNaApi(token);

  const query = await searchParams;
  const erro = first(query['erro']);
  const tratada = first(query['tratada']) === '1';
  const contestada = first(query['contestada']) === '1';
  const retirada = first(query['retirada']) === '1';

  const topo = (
    <header className="painel__topo">
      <a className="painel__marca" href="/admin/dia">
        ← {estado.businessName}
      </a>
      <form action={acaoSair}>
        <button className="ui-button ui-button--ghost painel__sair" type="submit">
          Sair
        </button>
      </form>
    </header>
  );

  if (!resposta.ok) {
    return (
      <main className="ui-container painel__conteudo" {...secao('avaliacoes')}>
        {topo}
        <div className="ui-alert ui-alert--warning" role="alert" {...marcaDaRecusa(resposta.code)}>
          {FALHA[resposta.code] ?? FALHA['request_failed']}{' '}
          <a className="ui-button ui-button--secondary painel__saida" href="/admin/dia">
            Voltar ao dia
          </a>
        </div>
      </main>
    );
  }

  const { media, total, totalPublico, mediaPublica, aRecuperar, ultimas } = resposta.dados;
  const tratadas = ultimas.filter((a) => !a.precisaDeAtitude);

  return (
    <main className="ui-container painel__conteudo" {...secao('avaliacoes')}>
      {topo}

      <h1 className="painel__titulo">Notas e reputação</h1>
      <p className="painel__sub">
        Só quem foi atendido avalia, e cada atendimento vale uma nota. É isso que faz a sua média
        valer mais que a de um site aberto.
      </p>

      {erro ? (
        <AvisoDeRecusa erro={erro} mapa={FALHA} className="painel__aviso" />
      ) : null}

      {tratada ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Registrado. A nota segue o caminho dela — o registro é o que fica do que você fez.
        </div>
      ) : null}

      {contestada ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Contestada. Ela saiu do seu perfil público e <strong>continua na sua média</strong> —
          é a distância entre os dois números que diz o tamanho do que você suspendeu. Dá para
          retirar a contestação quando quiser, no próprio cartão.
        </div>
      ) : null}

      {retirada ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Contestação retirada. A avaliação voltou para o seu perfil.
        </div>
      ) : null}

      <section className="pacotes__contas">
        <h2 className="rotulo">Como você está</h2>
        <dl className="pacotes__numeros">
          <div className="pacotes__numero pacotes__numero--peso">
            <dt>Sua média</dt>
            <dd className="tabular">{notaExibida(media)}</dd>
            <p className="pacotes__nota">
              Conta todas as notas, publicadas ou não. É a real.
            </p>
          </div>
          <div className="pacotes__numero">
            <dt>No seu perfil</dt>
            <dd className="tabular">{notaExibida(mediaPublica)}</dd>
            <p className="pacotes__nota">
              O que o cliente vê. Aparece a partir de três avaliações.
            </p>
          </div>
          <div className="pacotes__numero">
            <dt>Avaliações</dt>
            <dd className="tabular">{total}</dd>
            {/* As duas contagens, como as duas médias: o painel mostrava 682 e a
                página do cliente 680, sem nada explicar a diferença — que é a
                contestada mais a que ainda está na janela de 48 horas. */}
            <p className="pacotes__nota">
              Uma por atendimento concluído.
              {totalPublico !== total ? (
                <>
                  {' '}
                  <strong>{totalPublico}</strong> no seu perfil — as outras estão suspensas ou
                  ainda na janela de 48h.
                </>
              ) : null}
            </p>
          </div>
        </dl>
      </section>

      {aRecuperar.length > 0 ? (
        <section aria-labelledby="recuperar">
          <h2 className="rotulo" id="recuperar">
            Clientes insatisfeitos ({aRecuperar.length})
          </h2>
          {/*
            A frase que impede o mal-entendido. Um contador de 48 horas ao lado
            de um formulário parece um botão de esconder, e a equipe aprenderia a
            usá-lo assim — que é exatamente o que a SPEC §4.10 proíbe.
          */}
          <p className="painel__nota">
            Você tem {JANELA_DE_RECUPERACAO_HORAS}h para ligar, refazer o serviço ou dar crédito.
            <strong> Passado o prazo, a avaliação vai para o seu perfil de qualquer forma</strong> —
            tratada ou não. A janela existe para consertar o atendimento, não para esconder a nota.
          </p>

          {podeTratar ? (
            aRecuperar.map((a) => (
              <ARecuperar avaliacao={a} fuso={fuso} key={a.id} podeContestar={podeContestar} />
            ))
          ) : (
            <>
              {aRecuperar.map((a) => (
                <Avaliacao avaliacao={a} fuso={fuso} key={a.id} podeContestar={podeContestar} />
              ))}
              <p className="painel__nota">
                Você vê as notas, mas quem trata é quem tem essa permissão.
              </p>
            </>
          )}
        </section>
      ) : null}

      {/*
        O título só existe quando há o que listar.
        
        A primeira versão desenhava "Últimas" sempre, e com uma única avaliação
        — que estava na fila de recuperação logo acima — a tela terminava num
        título com nada embaixo. Seção vazia é a mesma classe de defeito do
        indicador que nunca preenche: ocupa espaço prometendo uma resposta que
        não vem.
      */}
      {total === 0 ? (
        <div className="ui-card vazio">
          <p className="vazio__titulo">Nenhuma avaliação ainda</p>
          <p className="vazio__saida">
            Elas chegam depois de cada atendimento concluído. Quem já foi atendido encontra o
            pedido na página dele, em “Meus horários”.
          </p>
        </div>
      ) : tratadas.length > 0 ? (
        <>
          <h2 className="rotulo">Últimas</h2>
          {tratadas.map((a) => (
            <Avaliacao avaliacao={a} fuso={fuso} key={a.id} podeContestar={podeContestar} />
          ))}
        </>
      ) : (
        <p className="painel__nota">
          Nenhuma outra avaliação por enquanto — só a que está esperando você aí em cima.
        </p>
      )}
    </main>
  );
}
