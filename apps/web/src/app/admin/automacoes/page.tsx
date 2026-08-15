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
import { acaoSalvarAutomacao, acaoSair } from '../acoes';
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

const NOME_DO_AVISO: Record<string, string> = {
  confirmacao: 'Confirmação do agendamento',
  lembrete_24h: 'Lembrete de 24 horas',
  lembrete_2h: 'Lembrete de 2 horas',
  sua_vez: 'Sua vez na fila',
  senha_de_acesso: 'Senha de primeiro acesso',
  retorno: 'Convite de retorno',
};

function Automacao({ automacao }: { readonly automacao: AutomacaoNaTelaDoAdmin }) {
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
              {NOME_DO_AVISO[automacao.tipo] ?? automacao.tipo}
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
  const textos = (templates?.ok ? templates.dados.templates : []).filter(
    (t) => t.estado === 'aprovado',
  );
  const aprovados = new Set(textos.map((t) => t.tipo));
  const automacoes = resposta?.ok ? resposta.dados.automacoes : [];
  const erro = first(query['erro']);
  const salva = first(query['feito']) === 'salva';

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
        O que a casa manda sozinha quando um fato acontece. Cada uma declara o que promete
        produzir — é o número que diz se ela vale o que custa.
      </p>

      {erro ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {EXPLICACAO_DA_FALHA[erro as keyof typeof EXPLICACAO_DA_FALHA] ??
            'Não deu para salvar. Tente de novo.'}
        </div>
      ) : null}
      {salva ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Automação salva. A varredura roda de hora em hora.
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
        <h2 className="cartao-balcao__titulo">O que está ligado</h2>
        <p className="cartao-balcao__texto">
          Ninguém recebe duas automações no mesmo dia, e nada sai entre 21h e 8h. Promoção
          respeita quem pediu para não receber e o teto de quatro por mês.
        </p>

        {automacoes.length === 0 ? (
          <p className="cartao-balcao__texto">
            Nenhuma ainda. A que mais traz gente de volta é a de quem sumiu: escolha o número de
            dias que corresponde ao intervalo normal da sua clientela.
          </p>
        ) : (
          <ul className="lista-cadastro">
            {automacoes.map((a) => (
              <Automacao automacao={a} key={a.id} />
            ))}
          </ul>
        )}
      </section>

      {podeMexer ? (
        <section className="cartao-balcao">
          <h2 className="cartao-balcao__titulo">Nova automação</h2>
          {/*
            Uma automação é uma frase, e a tela passou a dizê-la antes dos
            campos. A versão anterior era oito campos técnicos em fila —
            "limiar", "atrasoMinutos", "janelaDias" — sem nada explicando o que
            se estava montando, e quem abria não sabia se tinha terminado.
          */}
          <p className="cartao-balcao__texto">
            Uma automação é uma frase: <strong>quando</strong> ela dispara,{' '}
            <strong>o que</strong> a pessoa recebe, e <strong>o que</strong> isso precisa
            produzir. Depois de ligada ela roda sozinha, todo dia, sem você abrir esta tela.
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
              <p className="ui-field__hint">Só para você reconhecer depois.</p>
            </div>

            <fieldset className="etapa">
              <legend className="etapa__titulo">1. Quando ela dispara</legend>

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="gatilho">
                O gatilho
              </label>
              <select className="ui-field__input" id="gatilho" name="gatilho" required>
                {/*
                  O rótulo do número vai **dentro da opção**, e não numa dica
                  abaixo. A dica teria que listar os sete significados de uma
                  vez — foi o que a primeira versão fez, e virou um parágrafo de
                  seis linhas que ninguém lê, o mesmo defeito que a tela fiscal
                  teve com as explicações de regime. O produto não tem componente
                  de cliente para trocar o texto ao mexer no seletor; pôr o
                  rótulo na opção resolve sem JavaScript.
                */}
                {GATILHOS.map((g) => (
                  <option key={g} value={g}>
                    {ROTULO_DO_GATILHO[g]}
                    {LIMIAR_DO_GATILHO[g] ? ` — ${LIMIAR_DO_GATILHO[g]}` : ''}
                    {(GATILHOS_COM_VARREDURA as readonly string[]).includes(g)
                      ? ''
                      : ' (ainda não dispara)'}
                  </option>
                ))}
              </select>
            </div>

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="limiar">
                O número que o gatilho pede
              </label>
              <input
                className="ui-field__input"
                id="limiar"
                inputMode="numeric"
                name="limiar"
                placeholder="30"
              />
              {/*
                O significado do número fica **visível**, e não só dentro da
                opção. A versão anterior dizia "está escrito na opção que você
                escolheu acima" — e não estava: assim que o seletor fecha, o
                texto da opção some, e a pessoa fica olhando um campo chamado
                "número" sem saber número de quê.

                Uma tabela curta e não um parágrafo: o produto já rejeitou a
                dica que lista sete significados em prosa, e com razão. O que
                muda aqui é a **forma** — sete linhas de duas colunas se
                varrem com o olho; sete orações não.
              */}
              <p className="ui-field__hint">
                Gatilho que não pede número: deixe em branco. O que o número significa em cada um:
              </p>
              {/*
                Lista de definição que **empilha**, e não tabela.

                A primeira versão era uma tabela de duas colunas dentro de um
                `.ui-scroll-x`. A página não rolava de lado — a medição confirmou
                —, mas a segunda coluna ficava fora da tela em 360px, e era ela
                que carregava o significado. Uma tabela que exige arrastar para
                ler a resposta é pior que a dica que ela substituiu.

                Empilhado no celular, duas colunas a partir de 768px: mesma
                informação, sem gesto nenhum.
              */}
              <dl className="significados">
                {GATILHOS.filter((g) => LIMIAR_DO_GATILHO[g]).map((g) => (
                  <div className="significados__par" key={g}>
                    <dt>{ROTULO_DO_GATILHO[g]}</dt>
                    <dd>{LIMIAR_DO_GATILHO[g]}</dd>
                  </div>
                ))}
              </dl>
            </div>

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
                Zero manda assim que a varredura passa. "Como foi seu atendimento?" enquanto a
                pessoa ainda está pagando não é pesquisa, é constrangimento.
              </p>
            </div>

            </fieldset>

            <fieldset className="etapa">
              <legend className="etapa__titulo">2. O que a pessoa recebe</legend>

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="tipo">
                Qual mensagem
              </label>
              {/* `TIPOS_DE_CAMPANHA` e não os seis avisos: a automação fala com quem
                  **não tem horário marcado**, então lembrete e confirmação mentiriam
                  no texto — e `senha_de_acesso` é credencial. É a mesma lista que a
                  campanha já usava; a automação tinha ficado de fora. */}
              <select className="ui-field__input" defaultValue="retorno" id="tipo" name="tipo">
                {TIPOS_DE_CAMPANHA.map((t) => (
                  <option key={t} value={t}>
                    {NOME_DO_AVISO[t] ?? t}
                    {aprovados.has(t) ? '' : ' — sem texto aprovado'}
                  </option>
                ))}
              </select>
              {/*
                **Onde está a mensagem.** Era a pergunta que esta tela não
                respondia: ela oferecia seis nomes abstratos, e o texto que o
                cliente lê mora em outra tela, cadastrado como template que a
                Meta aprova. Quem montava uma automação nunca via o que ia sair.

                Não dá para escrever o texto aqui — a Meta exige aprovar cada um
                antes, e um campo livre nesta tela prometeria algo que o canal
                recusa. O que dá, e é o que faltava, é **mostrar o que existe**.
              */}
              {textos.length === 0 ? (
                <p className="ui-field__hint">
                  Você ainda não tem nenhum texto aprovado, então nada vai sair.{' '}
                  <a href="/admin/whatsapp">Escreva o texto em WhatsApp</a> — a Meta precisa
                  aprovar cada um antes de ele poder ser enviado.
                </p>
              ) : (
                <>
                  <p className="ui-field__hint">
                    É este o texto que o cliente vai ler.{' '}
                    <a href="/admin/whatsapp">Escrever ou mudar em WhatsApp</a>.
                  </p>
                  <ul className="textos-aprovados">
                    {textos.map((t) => (
                      <li key={t.id}>
                        <span className="textos-aprovados__nome">
                          {NOME_DO_AVISO[t.tipo] ?? t.tipo}
                        </span>
                        <span className="textos-aprovados__corpo">{t.corpo}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>

            </fieldset>

            <fieldset className="etapa">
              <legend className="etapa__titulo">3. O que isso precisa produzir</legend>
              <p className="etapa__texto">
                Sem objetivo, uma automação é uma mensagem que ninguém consegue defender nem
                matar: ela some no meio do custo e fica ligada para sempre. A lista acima mostra
                enviadas e alcançadas lado a lado — é por esses dois números que você desliga o
                que não funciona.
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
                De 1 a {JANELA_MAXIMA_DIAS}. Janela larga demais dá crédito a esta mensagem por
                um corte que a pessoa marcaria de qualquer jeito.
              </p>
            </div>

            </fieldset>

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="ativa">
                <input defaultChecked id="ativa" name="ativa" type="checkbox" /> Ligada
              </label>
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
