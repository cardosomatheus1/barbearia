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
  TIPOS_DE_CAMPANHA,
  nomeDoAviso,
  rotuloDoBotao,
  type Gatilho,
  type Objetivo,
} from '@barbearia/core';
import {
  automacoesNaApi,
  cadastroDoWhatsAppNaApi,
  templatesDoWhatsAppNaApi,
  type AutomacaoNaTelaDoAdmin,
} from '@/lib/admin-api';
import { painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { acaoLigarAutomacao, acaoSalvarAutomacao, acaoSair } from '../acoes';
import { secao } from '../secoes';

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
function Automacao({ automacao, podeMexer }: {
  readonly automacao: AutomacaoNaTelaDoAdmin;
  readonly podeMexer: boolean;
}) {
  const gatilho = automacao.gatilho as Gatilho;
  const varre = (GATILHOS_COM_VARREDURA as readonly string[]).includes(gatilho);
  return (
    <li>
      <article className={`item-cadastro${automacao.ativa ? '' : ' item-cadastro--fora'}`}>
        <div className="item-cadastro__cabeca">
          <div className="item-cadastro__quem">
            <h3 className="item-cadastro__nome">{automacao.nome}</h3>
            <p className="item-cadastro__linha">
              {ROTULO_DO_GATILHO[gatilho]}
              {automacao.limiar !== null ? ` · ${automacao.limiar}` : ''} ·{' '}
              {ROTULO_DO_OBJETIVO[automacao.objetivo as Objetivo]} em {automacao.janelaDias} dias
            </p>
            <p className="item-cadastro__linha">
              {automacao.ativa ? 'Ligada' : 'Desligada'} · manda{' '}
              {nomeDoAviso(automacao.tipo)}
            </p>
            {/*
              Os dois números que decidem desligar. Sem eles a lista seria de
              automações que ninguém consegue defender nem matar.
            */}
            <p className="item-cadastro__linha">
              {automacao.enviadas} enviada{automacao.enviadas === 1 ? '' : 's'} ·{' '}
              {automacao.alcancadas} alcançou o objetivo
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
            <form action={acaoLigarAutomacao}>
              <input name="id" type="hidden" value={automacao.id} />
              <input name="ativa" type="hidden" value={automacao.ativa ? 'nao' : 'sim'} />
              <button className="ui-button ui-button--ghost" type="submit">
                {automacao.ativa ? 'Desligar' : 'Ligar'}
              </button>
            </form>
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
  const [resposta, canal, templates] = await Promise.all([
    podeMexer ? automacoesNaApi(token) : Promise.resolve(null),
    podeVerCanal ? cadastroDoWhatsAppNaApi(token) : Promise.resolve(null),
    podeVerCanal ? templatesDoWhatsAppNaApi(token) : Promise.resolve(null),
  ]);
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
  const aprovados = (templates?.ok ? templates.dados.templates : []).filter(
    (t) => t.estado === 'aprovado' && (TIPOS_DE_CAMPANHA as readonly string[]).includes(t.tipo),
  );
  // Escolha de mentira é pior que campo nenhum: com um texto só, o rádio pede
  // uma decisão que não existe e quem abre procura a segunda opção.
  const umaMensagemSo = aprovados.length <= 1;
  const automacoes = resposta?.ok ? resposta.dados.automacoes : [];
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
      <p className="painel__sub">
        Mensagens que a casa manda sozinha quando um fato acontece.
      </p>

      {erro ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {EXPLICACAO_DA_FALHA[erro as keyof typeof EXPLICACAO_DA_FALHA] ??
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
              <Automacao automacao={a} key={a.id} podeMexer={podeMexer} />
            ))}
          </ul>
        )}
      </section>

      {podeMexer ? (
        <section className="cartao-balcao">
          <h2 className="cartao-balcao__titulo">Nova automação</h2>
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
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="nome">
                Nome
              </label>
              <input
                className="ui-field__input"
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
                        defaultChecked={i === 0}
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

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="limiar">
                O número
              </label>
              <input
                className="ui-field__input"
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
                  defaultValue="0"
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
                  <p className="alternativa__nota alternativa__nota--risco">
                    Nenhum texto aprovado — nada vai sair.
                  </p>
                ) : (
                  aprovados.map((texto, i) => (
                    <label className="alternativa" key={texto.id}>
                      <input
                        defaultChecked={i === 0}
                        name="templateId"
                        type={umaMensagemSo ? 'hidden' : 'radio'}
                        value={texto.id}
                      />
                      <span className="alternativa__corpo">
                        <span className="alternativa__nome">
                          {texto.titulo ?? nomeDoAviso(texto.tipo)}
                        </span>
                        <span className="alternativa__texto">{texto.corpo}</span>
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
              <select className="ui-field__input" id="objetivo" name="objetivo" required>
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
                defaultValue="7"
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
                <input defaultChecked id="ativa" name="ativa" type="checkbox" />
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
