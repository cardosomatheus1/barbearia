import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  EXPLICACAO_DA_FALHA,
  GATILHOS,
  GATILHOS_COM_VARREDURA,
  JANELA_MAXIMA_DIAS,
  LIMIAR_DO_GATILHO,
  OBJETIVOS,
  ROTULO_DO_GATILHO,
  ROTULO_DO_OBJETIVO,
  ROTULO_DO_SEGMENTO,
  EXPLICACAO_DO_SEGMENTO,
  SEGMENTOS,
  TIPOS_DE_CAMPANHA,
  corpoComExemplos,
  nomeDoAviso,
  faltaDeTexto,
  tiposDeCampanhaPorExtenso,
  rotuloDoBotao,
  type Gatilho,
  type Objetivo,
  type Segmento,
} from '@barbearia/core';
import {
  automacoesNaApi,
  filaNaApi,
  cadastroDoWhatsAppNaApi,
  templatesDoWhatsAppNaApi,
  type AutomacaoNaTelaDoAdmin,
} from '@/lib/admin-api';
import { painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerRascunho, lerRecusa, lerSessaoGestor } from '@/lib/sessao-gestor';
import { acaoLigarAutomacao, acaoSalvarAutomacao, acaoSair } from '../acoes';
import { FilaParada } from '../fila-parada';
import { secao } from '../secoes';
import { FalhaDaLeitura } from '../falha-da-leitura';

/**
 * As automações (bloco 56, SPEC §4.11).
 *
 * ## A coluna que decide se a automação vive
 *
 * *"Toda automação declara o objetivo mensurável. Sem isso não há como desligar
 * o que não funciona."* Por isso cada linha mostra **enviadas e alcançadas**
 * lado a lado, e não só o nome: uma automação sem esses dois números é uma
 * mensagem que ninguém consegue defender nem matar — ela some no meio do custo
 * e fica ligada para sempre.
 *
 * ## Os gatilhos que ainda não varrem aparecem, e dizem isso
 *
 * Escondê-los faria a lista parecer a SPEC inteira entregue. Mostrá-los sem
 * aviso faria a barbearia ligar um que nunca dispara e concluir que o produto
 * está quebrado. Eles aparecem marcados.
 */

export const metadata: Metadata = {
  title: 'Automações',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

/**
 * A linha, com a saída do estado em que ela está (bloco 92, §6 pergunta 3).
 *
 * A tela criava automação e não desligava nenhuma: `ativa` era alcançável e não
 * tinha botão de volta, então a única forma de calar uma mensagem que estava
 * saindo errado era pelo banco. O domínio já aceitava — a ação de salvar recebe
 * `id` desde o bloco 56 —, e a interface é que nunca ofereceu.
 *
 * O `PUT` é do objeto inteiro, então a linha reenvia o que já tem: um formulário
 * de campos escondidos com `ativa` virado. Reenviar em vez de mandar só o estado
 * mantém uma porta de escrita só — a mesma que o formulário de baixo usa, com a
 * mesma validação de borda.
 */
function Automacao({ automacao, podeMexer, temTextoDoTipo }: {
  readonly automacao: AutomacaoNaTelaDoAdmin;
  readonly podeMexer: boolean;
  /**
   * Existe texto aprovado que esta automação possa mandar? (bloco 97)
   *
   * A linha dizia "Ligada · manda o primeiro texto aprovado de X" sobre um tipo
   * que não tem nenhum: a automação aparecia ligada, com contador zerado, e não
   * mandava nada — a tela prometendo entrega sobre um caminho que não existe. É
   * a irmã de "a campanha diz enviada com o canal desligado".
   */
  readonly temTextoDoTipo: boolean;
}) {
  const gatilho = automacao.gatilho as Gatilho;
  const varre = (GATILHOS_COM_VARREDURA as readonly string[]).includes(gatilho);
  return (
    <li>
      <article className={`item-cadastro${automacao.ativa ? '' : ' item-cadastro--fora'}`}>
        <div className="item-cadastro__cabeca">
          <div className="item-cadastro__quem">
            <h3 className="item-cadastro__nome">{automacao.nome}</h3>
            {/*
              **A automação lida como frase** (bloco 100).

              A linha era "Sumiu há um tempo · 30 · Gerar agendamento em 7 dias":
              rótulos técnicos separados por ponto, e o "30" solto no meio sem
              dizer 30 de quê. Quem abre a lista está perguntando "o que esta
              regra faz?", e a resposta cabe numa frase.

              Quando · só para · manda — a mesma ordem do formulário, para a
              lista e o formulário serem lidos do mesmo jeito.
            */}
            <p className="item-cadastro__linha">
              Quando <strong>{ROTULO_DO_GATILHO[gatilho].toLowerCase()}</strong>
              {automacao.limiar !== null ? ` (${automacao.limiar})` : ''}
              {automacao.publico ? (
                <>
                  , só para{' '}
                  <strong>
                    {ROTULO_DO_SEGMENTO[automacao.publico as Segmento] ?? automacao.publico}
                  </strong>
                </>
              ) : null}
              {' · espera '}
              {ROTULO_DO_OBJETIVO[automacao.objetivo as Objetivo].toLowerCase()} em{' '}
              {automacao.janelaDias} dias
            </p>
            {/*
              **Qual texto ela manda**, e não o nome do tipo (bloco 96).

              A linha dizia "manda Convite de retorno" com três convites de
              retorno diferentes cadastrados: o nome do tipo respondendo uma
              pergunta sobre o texto, e a API já devolvia o título desde o bloco
              94 — dado que existe e ninguém lê (§6, pergunta 4).
            */}
            {/*
              Uma gramática só para o mesmo campo (bloco 101).

              A linha dizia "manda *Volta que a gente sente falta*" numa
              automação e "manda *o primeiro texto aprovado de Convite de
              retorno*" na vizinha — duas frases com formas diferentes para o
              mesmo fato, lado a lado na mesma lista.

              O nome do texto sempre; a falta de escolha vira uma segunda frase,
              que é o que ela é: uma ressalva, não um nome.
            */}
            <p className="item-cadastro__linha">
              {automacao.ativa ? 'Ligada' : 'Desligada'} · manda{' '}
              <strong>{automacao.textoTitulo ?? nomeDoAviso(automacao.tipo)}</strong>
              {automacao.textoTitulo === null ? ' (o primeiro aprovado deste aviso)' : ''}
            </p>
            {/*
              **Ligada e sem texto não manda nada** (bloco 97).

              Sem texto aprovado daquele tipo, esta automação roda a varredura,
              não acha o que mandar e devolve zero — com a linha dizendo
              "Ligada" e o contador em "0 enviadas". O dono lê que está no ar.
            */}
            {automacao.textoTitulo === null && !temTextoDoTipo ? (
              <p className="item-cadastro__linha item-cadastro__risco">
                {/* A regra desligada não "parou de sair" por falta de texto: ela
                    parou porque alguém a desligou, e a linha acima já diz isso.
                    Sem `ativa` na conta, o mesmo cartão explicava o mesmo fato
                    com duas causas diferentes e oferecia um conserto que não faz
                    a mensagem voltar — e o vizinho, também desligado, dizia a
                    outra frase. */}
                {!automacao.ativa
                  ? 'Quando você ligar, nada vai sair: '
                  : automacao.enviadas > 0
                    ? 'Parou de sair: '
                    : 'Nada vai sair: '}
                não há texto aprovado de {nomeDoAviso(automacao.tipo)}.{' '}
                <a href="/admin/whatsapp">Mandar um para aprovação</a>.
              </p>
            ) : null}
            {/*
              Os dois números que decidem desligar. Sem eles a lista seria de
              automações que ninguém consegue defender nem matar.
            */}
            <p className="item-cadastro__linha">
              {automacao.enviadas} enviada{automacao.enviadas === 1 ? '' : 's'} ·{' '}
              {automacao.alcancadas}{' '}
              {automacao.alcancadas === 1 ? 'alcançou' : 'alcançaram'} o objetivo
              {automacao.enviadas > 0
                ? ` (${Math.round((automacao.alcancadas / automacao.enviadas) * 100)}%)`
                : ''}
            </p>
            {!varre ? (
              <p className="item-cadastro__linha item-cadastro__risco">
                Este gatilho ainda não dispara sozinho — a varredura dele entra num bloco
                seguinte.
              </p>
            ) : null}
          </div>
          {/* Dois campos, e é o conserto.

                A versão anterior reenviava a automação inteira com `ativa`
                virado, o que amarrou o freio à validação de tudo o mais: quando
                o tipo foi fechado em `TIPOS_DE_CAMPANHA`, as automações criadas
                antes passaram a responder "Parâmetro inválido: tipo" e a
                **continuar ligadas** — sem saída pela tela, só por `UPDATE` no
                banco. Exatamente as que mais precisavam ser caladas.

                O estado desejado é escrito, e não deduzido da ausência do
                campo: para um `FormData`, "não veio" e "veio falso" são a mesma
                coisa. */}
          {podeMexer ? (
            <div className="item-cadastro__acoes">
              {/*
                **Corrigir uma automação já criada** (bloco 98).

                Mudar de 30 para 45 dias exigia criar outra e desligar a errada,
                e as duas ficavam na lista com o mesmo nome. O domínio aceita
                `id` desde o bloco 56 — o `PUT` é do objeto inteiro —, e a
                interface é que nunca ofereceu.

                Abre o formulário de baixo preenchido, na mesma tela: uma tela
                nova por automação seria mais um destino a desenhar barra, volta
                e estado vazio, e o formulário já existe.

                Não há apagar, e é decisão: `automation_sends` guarda quantas
                saíram e quantas alcançaram o objetivo, e apagar a automação
                levaria a resposta de "valeu a pena?" junto. Desligar já para o
                envio e mantém o que ela mediu.
              */}
              <a
                className="ui-button ui-button--ghost"
                href={`/admin/automacoes?editar=${automacao.id}#nova-automacao`}
              >
                Editar
              </a>
              <form action={acaoLigarAutomacao}>
                <input name="id" type="hidden" value={automacao.id} />
                <input name="ativa" type="hidden" value={automacao.ativa ? 'nao' : 'sim'} />
                <button className="ui-button ui-button--ghost" type="submit">
                  {automacao.ativa ? 'Desligar' : 'Ligar'}
                </button>
              </form>
            </div>
          ) : null}
        </div>
      </article>
    </li>
  );
}

export default async function AutomacoesPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const query = await searchParams;
  const podeMexer = podeNaTela(estado, 'marketing.send');

  /**
   * O estado do canal, quando quem abriu pode resolvê-lo.
   *
   * `null` é "não dá para saber daqui" — a recepção não tem `whatsapp.manage`
   * —, e aí o aviso não aparece: mandar alguém para uma tela que ela não abre é
   * pior que não avisar.
   */
  const podeVerCanal = podeNaTela(estado, 'whatsapp.manage');
  const [resposta, canal, templates, saudeDaFila] = await Promise.all([
    podeMexer ? automacoesNaApi(token) : Promise.resolve(null),
    podeVerCanal ? cadastroDoWhatsAppNaApi(token) : Promise.resolve(null),
    podeVerCanal ? templatesDoWhatsAppNaApi(token) : Promise.resolve(null),
    // A fila anda? Nenhuma tela sabia responder, e as quatro afirmavam que sim.
    podeMexer ? filaNaApi(token) : Promise.resolve(null),
  ]);
  /**
   * Sem `marketing.send` não há automação para ver nem para ligar.
   *
   * A tela nem **chegava** a perguntar: `podeMexer` já pulava a chamada e o
   * `null` virava lista vazia em toda parte, então quem não tem a permissão via
   * o formulário inteiro e só descobria no botão. A parede é sobre a permissão
   * que a tela já conhece, e não sobre a resposta que ela não pediu.
   *
   * Some do menu desde o bloco 126; quem chega pelo endereço lê a frase.
   */
  if (!podeMexer) {
    return (
      <main className="ui-container painel__conteudo" {...secao('automacoes')}>
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
        <FalhaDaLeitura code="forbidden" href="/admin/automacoes" oque="as automações" />
      </main>
    );
  }

  const fila = saudeDaFila?.ok ? saudeDaFila.dados : null;
  const canalDePe = canal?.ok ? canal.dados.cadastro?.estado === 'ativo' : null;
  // Só o aprovado sai. Mostrar rascunho e pendente aqui prometeria mensagem que
  // a Meta ainda não deixa mandar.
  /**
   * Os textos que a automação pode mandar (bloco 94).
   *
   * Só aprovado: mostrar rascunho e pendente prometeria mensagem que a Meta
   * ainda não deixa sair. E só os tipos que uma automação usa — quem recebe não
   * tem horário marcado, então lembrete e confirmação mentiriam no texto.
   *
   * A escolha passou a ser **o texto**, e não o tipo: até o bloco 94 existia um
   * texto por tipo, e as onze automações possíveis saíam todas com a mesma
   * frase.
   */
  const aprovadosNaMeta = (templates?.ok ? templates.dados.templates : []).filter(
    (t) => t.estado === 'aprovado',
  );
  const aprovados = aprovadosNaMeta.filter((t) =>
    (TIPOS_DE_CAMPANHA as readonly string[]).includes(t.tipo),
  );
  // Escolha de mentira é pior que campo nenhum: com um texto só, o rádio pede
  // uma decisão que não existe e quem abre procura a segunda opção.
  const umaMensagemSo = aprovados.length <= 1;
  const automacoes = resposta?.ok ? resposta.dados.automacoes : [];
  /**
   * O que a pessoa tinha digitado quando a recusa voltou (bloco 98).
   *
   * Vazio no caminho normal: o cookie dura dois minutos e só é escrito quando a
   * API recusa. Quem acerta de primeira não vê diferença nenhuma.
   */
  const rascunho = await lerRascunho();
  const recusa = await lerRecusa();
  /**
   * A automação que o botão "Editar" abriu (bloco 98).
   *
   * `undefined` é o caminho normal — formulário de criação. O id vem da URL e é
   * casado contra a lista que a API já devolveu: um id de outra barbearia não
   * acha nada e cai em criação, sem consulta a mais e sem 404.
   */
  const emEdicao = automacoes.find((a) => a.id === first(query['editar']));
  const erro = first(query['erro']);
  const feito = first(query['feito']);
  const salva = feito === 'salva';

  return (
    <main className="ui-container painel__conteudo" {...secao('automacoes')}>
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

      <h1 className="painel__titulo">Automações</h1>
      {/* O par da frase que a tela de campanhas ganhou: as duas ficam lado a
          lado no menu, mandam pelo mesmo canal e têm formulário parecido, e
          quem abre pela primeira vez não tem como saber qual usar. */}
      <p className="painel__sub">
        Uma regra que fica ligada e manda <strong>sozinha</strong>, toda vez que o fato
        acontecer com alguém. Para falar hoje com uma lista escolhida agora, use{' '}
        <a href="/admin/campanhas">Campanhas</a>.
      </p>

      <FilaParada fila={fila} fuso={estado.empresa.timezone} />
      {/* A frase do domínio primeiro: ela nomeia o campo. O mapa por código
          continua como rede para as recusas que não trazem frase. */}
      {erro ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {EXPLICACAO_DA_FALHA[erro as keyof typeof EXPLICACAO_DA_FALHA] ??
            recusa ??
            'Não deu para salvar. Tente de novo.'}
        </div>
      ) : null}
      {salva ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Automação salva. As que estão ligadas rodam de hora em hora.
        </div>
      ) : null}
      {/* Ligar e desligar têm confirmação própria: "salva" sobre um botão de
          desligar deixa quem apertou sem saber se a mensagem parou de sair. */}
      {feito === 'desligada' ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Automação desligada. Ela não manda mais nada até você ligar de novo.
        </div>
      ) : null}
      {feito === 'ligada' ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Automação ligada. A varredura roda de hora em hora.
        </div>
      ) : null}

      {/*
        A tela que promete envio diz de que ele depende (§6, pergunta 6).
        Sem isto, a barbearia liga a automação, lê "salva", e nada chega —
        porque o canal não está de pé três telas adiante.
      */}
      {canalDePe === false ? (
        <div className="ui-alert ui-alert--warning painel__aviso" role="status">
          O WhatsApp da casa ainda não está pronto, então nada chega ao cliente.{' '}
          <a href="/admin/whatsapp">Conectar o número e aprovar um texto</a> — são três passos, e
          a tela diz em qual você está.
        </div>
      ) : null}

      <section className="cartao-balcao">
        {/* "O que está ligado" era o título, e a lista sempre trouxe as
            desligadas junto — agora mais, porque o botão de desligar deixa a
            linha onde está. Título que não descreve o que está embaixo dele é a
            §6 pergunta 6 entre um cabeçalho e a própria lista. */}
        <h2 className="cartao-balcao__titulo">Suas automações</h2>
        <p className="cartao-balcao__texto">
          Valem para todas: uma por cliente por dia, nada entre 21h e 8h, no máximo quatro
          promoções por mês, e quem pediu para não receber não recebe.
        </p>

        {automacoes.length === 0 ? (
          <p className="cartao-balcao__texto">
            Nenhuma ainda. Comece pela de quem sumiu — é a que mais traz gente de volta.
          </p>
        ) : (
          <ul className="lista-cadastro">
            {automacoes.map((a) => (
              <Automacao
                automacao={a}
                key={a.id}
                podeMexer={podeMexer}
                temTextoDoTipo={aprovados.some((t) => t.tipo === a.tipo)}
              />
            ))}
          </ul>
        )}
      </section>

      {podeMexer ? (
        <section className="cartao-balcao" id="nova-automacao">
          {/* O título diz o que se está fazendo: "Nova automação" sobre um
              formulário preenchido com uma existente seria a tela mentindo
              sobre o próprio efeito. */}
          <h2 className="cartao-balcao__titulo">
            {emEdicao ? `Editando ${emEdicao.nome}` : 'Nova automação'}
          </h2>
          {emEdicao ? (
            <p className="cartao-balcao__texto">
              Salvar substitui esta automação — o que ela já mediu continua na linha dela.{' '}
              <a href="/admin/automacoes">Cancelar e criar uma nova</a>.
            </p>
          ) : null}
          {/*
            Três perguntas numeradas, e a numeração diz a verdade: é uma
            sequência, e a terceira só faz sentido depois das duas. A versão
            anterior era oito campos técnicos em fila — "limiar",
            "atrasoMinutos", "janelaDias" —, sem nada dizendo o que se estava
            montando, e quem abria não sabia se tinha terminado.
          */}
          <p className="cartao-balcao__texto">
            São três perguntas. Depois de salva, ela roda sozinha — você não precisa voltar aqui.
          </p>
          <form action={acaoSalvarAutomacao} className="formulario">
            {/* O id viaja escondido: é ele que faz o domínio substituir em vez
                de criar. Ausente, nasce automação nova, como sempre. */}
            {emEdicao ? <input name="id" type="hidden" value={emEdicao.id} /> : null}
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="nome">
                Nome
              </label>
              <input
                className="ui-field__input"
                defaultValue={rascunho['nome'] ?? emEdicao?.nome ?? ''}
                id="nome"
                maxLength={80}
                name="nome"
                placeholder="Volta pro corte"
                required
              />
              <p className="ui-field__hint">Só você vê. O cliente nunca lê este nome.</p>
            </div>

            <fieldset className="etapa">
              <legend className="etapa__titulo">1. Quando ela dispara</legend>

            {/*
              Escolha aberta, e não seletor.

              O significado do número muda por gatilho, e o produto não tem
              componente de cliente para trocar um rótulo ao mexer no seletor.
              A versão anterior resolvia repetindo: a opção dizia "Sumiu há um
              tempo — depois de quantos dias sem vir", e uma lista de seis
              definições logo abaixo dizia a mesma coisa de novo, ocupando o
              maior bloco da tela. Duas cópias do mesmo mapa, e nenhuma visível
              na hora de preencher — porque o texto da opção some quando o
              seletor fecha.

              Aberto, cada gatilho carrega o próprio significado **e continua
              na tela** enquanto a pessoa digita o número. Uma cópia só, sem
              JavaScript, e a lista de definições deixa de existir.
            */}
            <div className="ui-field">
              <span className="ui-field__label">O gatilho</span>
              <div className="alternativas" role="radiogroup" aria-label="O gatilho">
                {GATILHOS.map((g, i) => {
                  const pede = LIMIAR_DO_GATILHO[g];
                  const varre = (GATILHOS_COM_VARREDURA as readonly string[]).includes(g);
                  return (
                    <label className="alternativa" key={g}>
                      <input
                        defaultChecked={
                          // Rascunho, depois a automação em edição, depois o
                          // primeiro. Sem a segunda, editar trocaria o gatilho
                          // em silêncio — o `PUT` é do objeto inteiro.
                          rascunho['gatilho'] !== undefined
                            ? rascunho['gatilho'] === g
                            : emEdicao !== undefined
                              ? emEdicao.gatilho === g
                              : i === 0
                        }
                        name="gatilho"
                        required
                        type="radio"
                        value={g}
                      />
                      <span className="alternativa__corpo">
                        <span className="alternativa__nome">{ROTULO_DO_GATILHO[g]}</span>
                        {/* A pergunta que o número responde, com o ponto de
                            interrogação: "O número é: quantos dias antes." era
                            o rótulo do domínio empurrado para dentro de uma
                            frase que ele não cabe. */}
                        <span className="alternativa__nota">
                          {pede ? `${pede}?` : 'Não pede número.'}
                        </span>
                        {/* Gatilho que ainda não varre aparece marcado, nunca
                            escondido: escondido faria a SPEC parecer entregue. */}
                        {varre ? null : (
                          <span className="alternativa__nota alternativa__nota--risco">
                            Ainda não dispara sozinho.
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            {/*
              **Só para quem** (bloco 100).

              A automação sabia **quando** disparar e **o que** mandar, e não
              sabia **para quem**: "sumiu há 30 dias" ia para todo mundo que
              sumiu há 30 dias — o assinante que paga mensalidade e o visitante
              de uma vez só, com a mesma frase.

              O público é o segmento derivado do bloco 61, o mesmo que o
              contador da tela de campanhas mostra e o mesmo nome. Uma segunda
              noção de "quem é este cliente" seria a lista paralela de sempre.

              "Todo mundo" é a primeira opção **e** o padrão, porque é o
              comportamento anterior: quem não decidir nada continua com o que
              tinha.
            */}
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="publico">
                Só para
              </label>
              <select
                className="ui-field__input"
                defaultValue={rascunho['publico'] ?? emEdicao?.publico ?? ''}
                id="publico"
                name="publico"
              >
                <option value="">Todo mundo que cruzar o gatilho</option>
                {SEGMENTOS.map((seg) => (
                  <option key={seg} value={seg}>
                    {ROTULO_DO_SEGMENTO[seg]} — {EXPLICACAO_DO_SEGMENTO[seg]}
                  </option>
                ))}
              </select>
              <p className="ui-field__hint">
                Recorta o gatilho pelo grupo em que a pessoa está hoje. É o mesmo grupo que a
                tela de <a href="/admin/campanhas">Campanhas</a> conta lá em cima, recalculado a
                cada varredura — ninguém fica preso num rótulo velho.
              </p>
            </div>

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="limiar">
                O número
              </label>
              <input
                className="ui-field__input"
                defaultValue={rascunho['limiar'] ?? emEdicao?.limiar ?? ''}
                id="limiar"
                inputMode="numeric"
                name="limiar"
                placeholder="30"
              />
              <p className="ui-field__hint">
                Responde à pergunta da opção marcada acima. Deixe em branco quando ela diz que
                não pede número.
              </p>
            </div>

            {/*
              Ajuste fino, recolhido: zero serve para quase todo mundo, e um
              campo que ninguém mexe competindo com os que decidem a automação é
              o que faz a tela parecer maior do que a decisão.
            */}
            <details className="dobra">
              <summary className="dobra__titulo">Esperar antes de mandar</summary>
              <div className="ui-field">
                <label className="ui-field__label" htmlFor="atrasoMinutos">
                  Esperar quantos minutos
                </label>
                <input
                  className="ui-field__input"
                  defaultValue={rascunho['atrasoMinutos'] ?? emEdicao?.atrasoMinutos ?? '0'}
                  id="atrasoMinutos"
                  inputMode="numeric"
                  name="atrasoMinutos"
                />
                <p className="ui-field__hint">
                  Zero manda na primeira varredura depois do fato. Serve para quase tudo.
                </p>
              </div>
            </details>

            </fieldset>

            <fieldset className="etapa">
              <legend className="etapa__titulo">2. O que a pessoa recebe</legend>

            {/*
              **O texto que sai, ao lado do nome que o escolhe.**

              A versão anterior mostrava *todos* os textos aprovados embaixo de
              um seletor, com a frase "é este o texto que o cliente vai ler" no
              singular. Com o seletor em "Convite de retorno — sem texto
              aprovado" e a caixa mostrando "Lembrete de 24 horas", a tela
              afirmava que sairia um texto que aquela automação nunca manda —
              duas telas discordando sobre o mesmo fato (§6, pergunta 6), dentro
              de uma só.

              Agora cada tipo carrega **o texto dele**, casado por `tipo`, e a
              ausência é escrita em letras: card sem o dado principal lê como
              defeito de carregamento.

              `TIPOS_DE_CAMPANHA` e não os seis avisos: a automação fala com quem
              **não tem horário marcado**, então lembrete e confirmação mentiriam
              no texto — e `senha_de_acesso` é credencial.

              O `input` é escondido enquanto a lista tem um item só. Um seletor
              de uma opção é escolha de mentira: ele pede uma decisão que não
              existe, e quem abre procura a segunda opção que nunca vai achar. O
              dia em que houver a segunda, ela vira rádio sozinha — a lista é a
              mesma, e é dela que a tela deriva.
            */}
            <div className="ui-field">
              <span className="ui-field__label">
                {umaMensagemSo ? 'A mensagem' : 'Qual mensagem'}
              </span>
              <div
                className="alternativas"
                {...(umaMensagemSo ? {} : { 'aria-label': 'Qual mensagem', role: 'radiogroup' })}
              >
                {aprovados.length === 0 ? (
                  /*
                    Dois zeros diferentes, uma frase só (bloco 132).

                    "Nenhum texto aprovado" era escrito também para quem tinha
                    textos aprovados de outros tipos — e a barbearia que os viu
                    no painel da Meta concluiu que o produto estava quebrado. O
                    fato aqui não é a aprovação: é que nenhum aprovado serve a
                    uma automação, que fala com quem **não tem horário marcado**.
                  */
                  <p className="alternativa__nota alternativa__nota--risco">
                    {faltaDeTexto(aprovadosNaMeta.length, aprovados.length) === 'nada_aprovado'
                      ? 'Nenhum texto aprovado — nada vai sair.'
                      : `Nenhum texto de ${tiposDeCampanhaPorExtenso('ou')} aprovado — nada vai sair. Os que você tem falam de um horário marcado, e quem recebe uma automação não tem.`}
                  </p>
                ) : (
                  aprovados.map((texto, i) => (
                    <label className="alternativa" key={texto.id}>
                      <input
                        defaultChecked={
                          rascunho['templateId'] !== undefined
                            ? rascunho['templateId'] === texto.id
                            : emEdicao?.templateId != null
                              ? emEdicao.templateId === texto.id
                              : i === 0
                        }
                        name="templateId"
                        type={umaMensagemSo ? 'hidden' : 'radio'}
                        value={texto.id}
                      />
                      <span className="alternativa__corpo">
                        <span className="alternativa__nome">
                          {texto.titulo ?? nomeDoAviso(texto.tipo)}
                        </span>
                        <span className="alternativa__texto">
                          {corpoComExemplos(texto.tipo, texto.corpo)}
                        </span>
                        {texto.botoes.length > 0 ? (
                          <span className="alternativa__nota">
                            Com botão: {texto.botoes.map((b) => rotuloDoBotao(b)).join(' · ')}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  ))
                )}
              </div>
              <p className="ui-field__hint">
                É este o texto que chega no WhatsApp, e ele não se escreve aqui: a Meta aprova
                cada um antes de deixar enviar.{' '}
                <a href="/admin/whatsapp">Escrever outro em WhatsApp</a> — cada texto novo vira
                uma opção nesta lista.
              </p>
            </div>

            </fieldset>

            <fieldset className="etapa">
              <legend className="etapa__titulo">3. O que isso precisa produzir</legend>
              <p className="etapa__texto">
                É o que a lista lá em cima vai contar, para você saber se vale manter ligada.
              </p>

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="objetivo">
                O que precisa acontecer
              </label>
              <select
                className="ui-field__input"
                defaultValue={rascunho['objetivo'] ?? emEdicao?.objetivo ?? OBJETIVOS[0]}
                id="objetivo"
                name="objetivo"
                required
              >
                {OBJETIVOS.map((o) => (
                  <option key={o} value={o}>
                    {ROTULO_DO_OBJETIVO[o]}
                  </option>
                ))}
              </select>
            </div>

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="janelaDias">
                Em quantos dias isso vale
              </label>
              <input
                className="ui-field__input"
                defaultValue={rascunho['janelaDias'] ?? emEdicao?.janelaDias ?? '7'}
                id="janelaDias"
                inputMode="numeric"
                max={JANELA_MAXIMA_DIAS}
                min={1}
                name="janelaDias"
              />
              <p className="ui-field__hint">
                De 1 a {JANELA_MAXIMA_DIAS}. Prazo largo demais dá crédito a esta mensagem por um
                corte que a pessoa marcaria de qualquer jeito.
              </p>
            </div>

            </fieldset>

            {/*
              `.marca` e não um `<input>` solto dentro do rótulo: o padrão do
              navegador é 13px e reprova o piso de 44px em qualquer largura. É a
              mesma caixa da tela de avisos.
            */}
            <div className="ui-field">
              <label className="marca" htmlFor="ativa">
                <input
                  defaultChecked={
                    // Uma caixa ausente do `FormData` é "desmarcada", e o
                    // rascunho a guarda como string vazia justamente para
                    // distinguir isso de "não houve rascunho".
                    rascunho['ativa'] !== undefined
                      ? rascunho['ativa'] === 'on'
                      : emEdicao
                        ? emEdicao.ativa
                        : true
                  }
                  id="ativa"
                  name="ativa"
                  type="checkbox"
                />
                <span>Começar ligada</span>
              </label>
              <p className="ui-field__hint">
                Você pode desligar depois sem perder o que ela já mediu.
              </p>
            </div>

            <button className="ui-button ui-button--primary ui-button--block" type="submit">
              Salvar automação
            </button>
          </form>
        </section>
      ) : null}
    </main>
  );
}
