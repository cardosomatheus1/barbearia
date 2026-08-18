import type { Metadata } from 'next';
import {
  AVISO_SEM_GERENCIA,
  EXPLICACAO_DO_TEMPLATE,
  EXPLICACAO_DO_WHATSAPP,
  ROTULO_DO_BOTAO,
  ROTULO_DO_TEMPLATE,
  ROTULO_DO_WHATSAPP,
  BOTOES_POSSIVEIS,
  RESSALVA_DO_BOTAO,
  EFEITO_DO_BOTAO,
  nomeDoAviso,
  TIPOS_DE_NOTIFICACAO,
  oQueFazerNaMeta,
  podeGerenciarTemplates,
  VARIAVEIS_DO_AVISO,
  type BotaoDaMensagem,
} from '@barbearia/core';
import {
  cadastroDoWhatsAppNaApi,
  signupDoWhatsAppNaApi,
  templatesDoWhatsAppNaApi,
  type SignupDoWhatsAppNaTela,
  type TemplateNaTelaDoAdmin,
} from '@/lib/admin-api';
import { redirect } from 'next/navigation';
import { painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerMotivoDaMeta, lerSessaoGestor } from '@/lib/sessao-gestor';
import {
  acaoConciliarWhatsApp,
  acaoIrParaMeta,
  acaoSalvarCadastroDoWhatsApp,
  acaoSubmeterTemplate,
  acaoSair,
} from '../acoes';
import { secao } from '../secoes';

/**
 * O WhatsApp da casa (bloco 55, SPEC §4.12).
 *
 * ## O que esta tela precisa fazer, e não é cadastrar
 *
 * É **guiar por uma burocracia que não é nossa**. Conectar o número exige
 * verificar a empresa na Meta, e isso leva dias, passa por gente e pode ser
 * recusado. A tela que só mostra dois campos e um botão deixa a barbearia
 * parada no meio sem saber se falta ela fazer algo ou se é esperar.
 *
 * Daí a ordem: **o estado primeiro**, em letras, com o que fazer agora. Os
 * campos vêm depois, e os textos depois deles — porque texto sem número
 * conectado não vai a lugar nenhum.
 *
 * ## O token nunca volta
 *
 * O campo nasce vazio mesmo com o token salvo, e a dica diz isso. Devolvê-lo
 * faria toda abertura desta tela mandar uma credencial viva pela rede, para
 * dentro de um HTML que fica no histórico do navegador. Vazio é "não mexa".
 */

export const metadata: Metadata = {
  title: 'WhatsApp',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const FALHA: Record<string, string> = {
  // A volta da Meta, no fluxo de redirecionamento (bloco 86).
  desistiu: 'Você saiu do fluxo da Meta antes de terminar. Pode tentar de novo quando quiser.',
  sem_codigo: 'A Meta não devolveu o código da conexão. Tente de novo.',
  estado_invalido:
    'Esta volta não bate com a conexão que começou aqui. Comece de novo por segurança — e se repetir, use o cadastro à mão logo abaixo.',
  sem_app: 'A conexão automática não está configurada nesta instalação.',
  codigo_invalido: 'O código da Meta não vale mais. Ele expira em 30 segundos — tente de novo.',
  meta_recusou: 'A Meta recusou a conexão. O motivo é o que ela respondeu, abaixo.',
  // Separado da conexão de propósito: o número pode estar conectado e o texto
  // recusado, e era essa mistura que fazia a tela acusar o estado errado.
  meta_recusou_texto: 'A Meta recusou o texto. O motivo é o que ela respondeu, abaixo.',
  numero_invalido: 'Confira os identificadores: eles são só números, e vêm do painel da Meta.',
  nome_invalido: 'O nome do texto aceita só minúsculas, números e sublinhado.',
  nao_configurado: 'Cadastre o número antes.',
  token_invalido: 'O token não confere. Copie de novo do painel da Meta.',
  forbidden: 'Sua conta não mexe no WhatsApp da casa.',
  /**
   * "Tente de novo" só quando tentar de novo pode funcionar (bloco 90).
   *
   * Esta frase cobre duas coisas muito diferentes: a rede que hesitou, em que
   * repetir resolve, e a configuração do servidor que falta — um
   * `WHATSAPP_TOKEN_KEY` ausente devolve 500 e cai aqui. No segundo caso a
   * frase antiga mandava a pessoa repetir para sempre um clique que nunca ia
   * dar certo, e é o pior tipo de texto de interface: ele não erra um número,
   * ele para o trabalho.
   *
   * O detalhe continua só no log, como manda a regra de erro genérico para o
   * cliente — o que muda é dizer **onde** ele está, que é a decisão do bloco 87.
   */
  request_failed:
    'Não deu para salvar. Se repetir, não é a sua conexão: o motivo fica no registro do servidor, e quem instalou o sistema consegue lê-lo.',
};

/**
 * Os botões agrupados por quem os aceita, derivados de `BOTOES_POSSIVEIS`.
 *
 * Derivado e não escrito: um aviso novo, ou um botão novo num aviso existente,
 * aparece aqui sozinho. Uma lista ao lado seria a que fica para trás — foi o que
 * aconteceu três vezes com o rótulo dos avisos neste mesmo arquivo.
 *
 * Os avisos que não aceitam botão nenhum não viram grupo: `sua_vez` é a pessoa
 * já esperando dentro da barbearia, e `senha_de_acesso` é credencial.
 */
const GRUPOS_DE_BOTAO = [
  { titulo: 'Para confirmação e lembretes', tipo: 'lembrete_24h' as const },
  { titulo: 'Para campanha e automação', tipo: 'retorno' as const },
].map((g) => ({
  titulo: g.titulo,
  botoes: BOTOES_POSSIVEIS[g.tipo],
  /**
   * As ressalvas do aviso mais restritivo do grupo.
   *
   * O lembrete de 2 horas aceita "Remarcar" e desaconselha: duas horas antes
   * não costuma haver grade para remanejar no mesmo dia. Aviso e não recusa —
   * proibir seria o produto opinando sobre a agenda de quem opera.
   */
  ressalvas: (RESSALVA_DO_BOTAO[g.tipo] ?? RESSALVA_DO_BOTAO['lembrete_2h'] ?? {}) as Partial<
    Record<string, string>
  >,
}));

function Template({ template }: { readonly template: TemplateNaTelaDoAdmin }) {
  return (
    <li>
      <article
        className={`item-cadastro${template.estado === 'rejeitado' ? ' item-cadastro--fora' : ''}`}
      >
        <div className="item-cadastro__cabeca">
          <div className="item-cadastro__quem">
            <h3 className="item-cadastro__nome">
              {nomeDoAviso(template.tipo)}
            </h3>
            <p className="item-cadastro__linha">
              {template.nome} · {ROTULO_DO_TEMPLATE[template.estado]}
            </p>
            <p className="item-cadastro__linha">{EXPLICACAO_DO_TEMPLATE[template.estado]}</p>
            {template.motivoDaRecusa ? (
              <p className="item-cadastro__linha item-cadastro__risco">
                {template.motivoDaRecusa}
              </p>
            ) : null}
            <p className="item-cadastro__linha">{template.corpo}</p>
            {template.botoes.length > 0 ? (
              <p className="item-cadastro__linha">
                Botões:{' '}
                {template.botoes
                  .map((b) => ROTULO_DO_BOTAO[b as BotaoDaMensagem] ?? b)
                  .join(' · ')}
              </p>
            ) : null}
          </div>
        </div>
      </article>
    </li>
  );
}



/**
 * O caminho inteiro, em três passos, com o estado de cada um (bloco 83).
 *
 * O que faltava nesta tela não era campo: era **a frase que liga as coisas**. A
 * barbearia cadastrava o número, ia para a tela de campanha, apertava Enviar e
 * nada chegava — porque faltava o template aprovado, que mora três seções
 * abaixo e nunca foi apresentado como obrigatório.
 *
 * É a §6 pergunta 6 na forma mais cara: três telas, cada uma coerente sozinha,
 * e nenhuma dizendo de que a outra depende. Os passos são derivados do estado
 * de verdade — o cadastro e a contagem de templates aprovados —, nunca de uma
 * lista escrita à mão que fica velha no primeiro estado novo.
 */
function Caminho({
  conectado,
  aprovados,
}: {
  readonly conectado: boolean;
  readonly aprovados: number;
}) {
  const passos = [
    {
      feito: conectado,
      titulo: 'Conectar o número da barbearia',
      texto: conectado
        ? 'Pronto. Os avisos saem pelo número da casa.'
        : 'Sem isto, tudo que o produto manda fica só no registro interno — o cliente não recebe nada.',
    },
    {
      feito: aprovados > 0,
      titulo: 'Ter pelo menos um texto aprovado',
      texto:
        aprovados > 0
          ? `${aprovados} ${aprovados === 1 ? 'texto aprovado' : 'textos aprovados'}. Só eles saem.`
          : 'A Meta aprova cada texto antes de ele poder ser enviado, e leva de minutos a dias. Comece pelo lembrete de 24 horas: é o que mais reduz falta.',
    },
    {
      feito: conectado && aprovados > 0,
      titulo: 'Ligar as automações e montar campanhas',
      texto:
        conectado && aprovados > 0
          ? 'O canal está de pé. O que você ligar em Automações e enviar em Campanhas sai pelo WhatsApp da casa.'
          : 'Automação e campanha já funcionam, mas enquanto os dois passos acima não estiverem prontos elas não chegam a ninguém.',
    },
  ];

  return (
    <section className="cartao-balcao">
      <h2 className="cartao-balcao__titulo">Para a mensagem chegar ao cliente</h2>
      <ol className="caminho">
        {passos.map((passo, i) => (
          <li className={`caminho__passo${passo.feito ? ' caminho__passo--feito' : ''}`} key={i}>
            {/* O estado é dito em letras, e a cor só reforça: quem tem baixa
                visão precisa da palavra. */}
            <span className="caminho__marca">{passo.feito ? 'Feito' : `Passo ${i + 1}`}</span>
            <span className="caminho__titulo">{passo.titulo}</span>
            <span className="caminho__texto">{passo.texto}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Conectar({ modo }: { readonly modo: 'padrao' | 'coexistencia' }) {
  return (
    <section className="cartao-balcao">
      <h2 className="cartao-balcao__titulo">Conectar o WhatsApp</h2>
      <p className="cartao-balcao__texto">
        Você vai para a página oficial da Meta, entra na sua conta, escolhe a empresa e o número, e
        confirma o código que chega por SMS. No fim ela traz você de volta para cá, já conectado —
        não é preciso copiar identificador nenhum.
      </p>

      {/*
        O que acontece com o número, **antes** do botão.

        É a informação mais cara desta tela: no fluxo padrão o número sai do
        aplicativo WhatsApp e deixa de funcionar lá. Uma barbearia que conecta o
        número do atendimento sem saber disso perde o canal que usa todo dia, e
        não há como desfazer.
      */}
      {modo === 'coexistencia' ? (
        <p className="cartao-balcao__texto">
          <strong>O número continua funcionando no seu WhatsApp Business.</strong> Você segue
          conversando pelo aplicativo, e o produto passa a mandar os avisos pelo mesmo número — a
          Meta mantém as conversas em dia entre os dois.
        </p>
      ) : (
        <p className="cartao-balcao__texto item-cadastro__risco">
          <strong>Atenção: o número que você informar sai do aplicativo WhatsApp</strong> e passa a
          ser usado só pelo produto. Não use o número que a barbearia usa para conversar com
          cliente — use um chip dedicado ao atendimento automático.
        </p>
      )}

      {/*
        Um link, e não um botão com JavaScript.

        A versão anterior usava o SDK da Meta, que abre uma janela filha e
        devolve o código por callback. No celular a janela vira uma aba, o SDK
        não alcança a página que a abriu, e o callback nunca dispara — a Meta
        conclui e a nossa tela fica igual. Aconteceu duas vezes na primeira
        conexão de verdade deste produto.

        Navegação comum funciona em qualquer navegador. E apaga o único script
        que este produto mandava ao navegador, junto com a exceção de política
        de conteúdo que ele exigia: o caminho mais robusto era o mais simples.
      */}
      {/*
        Formulário, e não link.

        O `state` precisa ir para um cookie antes da ida, e o Next só permite
        gravar cookie em ação ou rota — nunca durante a renderização. Montar o
        endereço aqui derrubava a tela inteira com "server-side exception", que
        foi como este caminho chegou ao ar quebrado.

        Continua sem JavaScript: é um `<form>` com um botão de submeter, como
        todo o resto do painel.
      */}
      <form action={acaoIrParaMeta}>
        <button className="ui-button ui-button--primary ui-button--block" type="submit">
          Conectar WhatsApp
        </button>
      </form>
    </section>
  );
}

/**
 * O cadastro à mão, que virou o caminho de escape (bloco 83).
 *
 * Extraído para componente porque agora aparece em dois lugares: solto, quando
 * o Embedded Signup não está configurado, e dentro de um `<details>` quando
 * está. Escrito duas vezes, os dois divergiriam no primeiro campo novo.
 */
function FormularioManual({
  cadastro,
}: {
  readonly cadastro: { phoneNumberId: string | null; wabaId: string | null; numeroVisivel: string | null; temToken: boolean } | null;
}) {
  return (
        <form action={acaoSalvarCadastroDoWhatsApp} className="formulario">
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="phoneNumberId">
              Identificador do número
            </label>
            <input
              className="ui-field__input"
              defaultValue={cadastro?.phoneNumberId ?? ''}
              id="phoneNumberId"
              inputMode="numeric"
              name="phoneNumberId"
              placeholder="109876543210987"
              required
            />
            <p className="ui-field__hint">
              Só números. Está no painel da Meta, em WhatsApp → Configuração da API.
            </p>
          </div>

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="wabaId">
              Identificador da conta
            </label>
            <input
              className="ui-field__input"
              defaultValue={cadastro?.wabaId ?? ''}
              id="wabaId"
              inputMode="numeric"
              name="wabaId"
              placeholder="102030405060708"
              required
            />
          </div>

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="numeroVisivel">
              Número como o cliente vê
            </label>
            <input
              className="ui-field__input"
              defaultValue={cadastro?.numeroVisivel ?? ''}
              id="numeroVisivel"
              name="numeroVisivel"
              placeholder="+55 71 3333-4444"
            />
            <p className="ui-field__hint">Só para conferir aqui que é o número certo.</p>
          </div>

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="token">
              Token de acesso
            </label>
            <input
              className="ui-field__input"
              id="token"
              name="token"
              placeholder={cadastro?.temToken ? 'Salvo — preencha só para trocar' : 'Cole o token'}
              type="password"
            />
            <p className="ui-field__hint">
              {cadastro?.temToken
                ? 'O token está salvo e cifrado. Ele não é mostrado de volta; deixe em branco para mantê-lo.'
                : 'Ele fica cifrado no banco e nunca volta para esta tela.'}
            </p>
          </div>

          <button className="ui-button ui-button--primary ui-button--block" type="submit">
            Salvar o cadastro
          </button>
        </form>
  );
}

export default async function WhatsAppPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const query = await searchParams;

  /**
   * O `state` da ida à Meta, sorteado a cada carga e guardado num cookie.
   *
   * Ele volta sem ser tocado, e a rota de retorno compara os dois. Sem isso, um
   * link montado por terceiro faria esta barbearia conectar **uma conta que não
   * é dela** — o token de outra pessoa ficaria cifrado no nosso banco com a
   * tela dizendo que está tudo certo.
   */
  const [cadastroResposta, templatesResposta, signupResposta] = await Promise.all([
    cadastroDoWhatsAppNaApi(token),
    templatesDoWhatsAppNaApi(token),
    // Só o modo: quem sorteia o `state` e monta o endereço é a ação do botão,
    // porque cookie não se grava durante a renderização.
    signupDoWhatsAppNaApi(token),
  ]);

  const cadastro = cadastroResposta.ok ? cadastroResposta.dados.cadastro : null;
  const templates = templatesResposta.ok ? templatesResposta.dados.templates : [];
  // `null` quando o app da plataforma não foi configurado: aí a tela não
  // desenha o botão, porque botão que abre janela vazia é pior que botão nenhum.
  const signup = signupResposta.ok ? signupResposta.dados.signup : null;
  const podeMexer = podeNaTela(estado, 'whatsapp.manage');
  const atual = cadastro?.estado ?? 'nao_configurado';
  const falha = first(query['erro']);
  const motivoDaMeta = falha ? await lerMotivoDaMeta() : null;
  const oQueFazer = motivoDaMeta ? oQueFazerNaMeta(motivoDaMeta) : null;
  const feito = first(query['feito']);

  return (
    <main className="ui-container painel__conteudo" {...secao('whatsapp')}>
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

      <h1 className="painel__titulo">WhatsApp</h1>
      <p className="painel__sub">
        Os avisos saem pelo número da própria barbearia, conectado direto na Meta. É o número
        que o cliente já tem na agenda.
      </p>

      {falha ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {FALHA[falha] ?? FALHA['request_failed']}
          {/* O que a Meta respondeu, em letras.

              Ela diz o motivo — "este número já está em outra conta", "esta
              conta não tem permissão", "o código expirou" — e a tela mandava
              procurar no painel dela, que tem dezenas de telas. Cada tentativa
              custava uma volta inteira para descobrir o que a resposta já
              trazia na primeira. */}
          {motivoDaMeta ? (
            <p className="whatsapp__motivo">
              {falha?.startsWith('meta_recusou') ? 'Ela disse' : 'A resposta foi'}: “{motivoDaMeta}”
            </p>
          ) : null}
          {/* A frase dela diz **o quê**; esta diz **onde se resolve**. Sem a
              segunda, a pessoa fica com uma explicação correta e um painel de
              terceiro com dezenas de telas para procurar. */}
          {oQueFazer ? <p className="whatsapp__caminho">{oQueFazer}</p> : null}
        </div>
      ) : null}
      <Caminho
        aprovados={templates.filter((t) => t.estado === 'aprovado').length}
        conectado={atual === 'ativo'}
      />
      {/* "Confirme o número", e não "espere o e-mail": o que falta é um passo
          para fazer agora, e mandar esperar por ele para o trabalho. */}
      {feito === 'cadastro' ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Cadastro salvo. Falta confirmar o número no painel da Meta com o código que ela manda
          por SMS.
        </div>
      ) : null}
      {feito === 'conciliado' ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Perguntamos à Meta. O que ela já respondeu está abaixo — se ainda diz “Na Meta”, é
          porque ela não terminou de analisar.
        </div>
      ) : null}
      {feito === 'conectado' ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          WhatsApp conectado. Agora cadastre os textos abaixo — a Meta precisa aprovar cada um
          antes de ele sair.
        </div>
      ) : null}
      {feito === 'template' ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Texto enviado para aprovação. Ela costuma sair em minutos, às vezes em dias.
        </div>
      ) : null}

      {/*
        O estado vem primeiro e em letras: a maior parte do tempo ele **não** é
        "ativo", e cada um pede uma coisa diferente de quem opera. "WhatsApp:
        não" serviria para três situações e não diria o que fazer em nenhuma.
      */}
      <section className="cartao-balcao">
        <h2 className="cartao-balcao__titulo">{ROTULO_DO_WHATSAPP[atual]}</h2>
        <p className="cartao-balcao__texto">{EXPLICACAO_DO_WHATSAPP[atual]}</p>
        {cadastro?.motivo ? (
          <p className="cartao-balcao__texto item-cadastro__risco">{cadastro.motivo}</p>
        ) : null}
        {cadastro?.numeroVisivel ? (
          <p className="cartao-balcao__texto">Número: {cadastro.numeroVisivel}</p>
        ) : null}
        {/*
          O teto é dito antes de alguém montar a campanha, e não depois de a
          Meta recusar a de número 251. Número de relatório que ignora parte do
          dado diz isso na tela; aqui é a mesma regra aplicada a um limite —
          descobrir pelo erro é descobrir com o trabalho já feito.
        */}
        <p className="cartao-balcao__texto">
          Uma conta nova manda para até <strong>250 pessoas diferentes por dia</strong> quando é a
          casa que começa a conversa. O teto sobe sozinho conforme as mensagens são entregues, e
          não é preciso mandar documento nenhum da empresa para começar.
        </p>
      </section>

      {podeMexer && signup ? <Conectar modo={signup.modo} /> : null}

      {/*
        Com o botão de conexão na tela, o formulário técnico vai para dentro de
        um `<details>`. Ele não some — quem já tem os ids, ou quem precisa
        trocar só o token, continua tendo por onde —, mas para de competir com o
        caminho que a barbearia deve usar.

        Também resolve o defeito de dois campos com o mesmo `name` na mesma
        tela: `wabaId` e `phoneNumberId` existem nos dois formulários, e um
        deles fechado é um destino a menos para errar.
      */}
      {podeMexer && signup ? (
        <details className="dobra">
          <summary>Cadastrar os identificadores à mão</summary>
          <p className="cartao-balcao__texto">
            Só é preciso se você já tem a conta na Meta montada e prefere copiar os dois
            identificadores do painel dela. Pelo botão acima, eles vêm sozinhos.
          </p>
          <FormularioManual cadastro={cadastro} />
        </details>
      ) : null}

      {podeMexer && !signup ? (
        <section className="cartao-balcao">
          <h2 className="cartao-balcao__titulo">O número na Meta</h2>
          <FormularioManual cadastro={cadastro} />
        </section>
      ) : null}

      <section className="cartao-balcao">
        <h2 className="cartao-balcao__titulo">Textos aprovados</h2>
        <p className="cartao-balcao__texto">
          A Meta aprova cada texto antes de ele poder sair. Um por aviso — e ela pausa o que
          muita gente marca como spam.
        </p>

        {/*
          O aviso vem **antes** do formulário, e aberto (bloco 88).

          Sem ele, a única forma de descobrir que este acesso não cria texto novo
          era escrever o texto inteiro, mandar, e receber da Meta "esta conta não
          pode criar um novo modelo" — frase que não nomeia permissão nenhuma e
          que, lida no balcão, parece bloqueio da conta. O cadastro já sabe a
          resposta no instante em que a conexão terminou.

          Fora do `<details>` de propósito: escondido, ele vira opcional, e a
          pessoa só o encontraria depois de abrir o formulário para escrever —
          que é exatamente o trabalho que ele existe para poupar. É a mesma
          decisão da explicação do score no bloco 61.

          `=== false` e não `!`: `null` é "não dá para dizer" — cadastro pelo
          formulário, ou anterior a este bloco — e ali a tela **cala**. Acusar
          falta de permissão quem está mandando mensagem sem reclamar seria pior
          que não avisar nada.
        */}
        {podeGerenciarTemplates(cadastro?.escopos ?? null) === false ? (
          <p className="ui-alert ui-alert--danger" role="status">
            {AVISO_SEM_GERENCIA}
          </p>
        ) : null}

        {templates.length === 0 ? (
          <p className="cartao-balcao__texto">
            Nenhum texto ainda. Comece pelo lembrete de 24 horas: é o que mais reduz falta.
          </p>
        ) : (
          <ul className="lista-cadastro">
            {templates.map((t) => (
              <Template key={t.id} template={t} />
            ))}
          </ul>
        )}

        {/* Perguntar agora, e não esperar a volta do relógio.

            A conciliação roda de hora em hora, o que é certo para o conjunto e
            errado como **único** caminho: quem digita o código do SMS no painel
            da Meta volta para cá em segundos, lê "Na Meta" sobre um texto já
            aprovado, e conclui que a tela travou. O mecanismo existia desde o
            bloco 90 e não tinha como ser acionado por quem estava olhando.

            Fica ao lado da lista porque é dela que se duvida. */}
        {podeMexer ? (
          <form action={acaoConciliarWhatsApp}>
            <button className="ui-button ui-button--ghost" type="submit">
              Perguntar à Meta agora
            </button>
          </form>
        ) : null}

        {podeMexer ? (
          <details className="dobra">
            <summary className="dobra__titulo">Mandar um texto para aprovação</summary>
            <form action={acaoSubmeterTemplate} className="formulario">
              <div className="ui-field">
                <label className="ui-field__label" htmlFor="titulo">
                  Nome deste texto
                </label>
                <input
                  className="ui-field__input"
                  id="titulo"
                  maxLength={80}
                  name="titulo"
                  placeholder="Volta que a gente sente falta"
                  required
                />
                <p className="ui-field__hint">
                  Só para você reconhecer na lista. É por ele que você escolhe qual texto cada
                  automação manda — dois nomes diferentes viram dois textos.
                </p>
              </div>

              <div className="ui-field">
                <label className="ui-field__label" htmlFor="tipo">
                  Para qual aviso
                </label>
                <select className="ui-field__input" id="tipo" name="tipo" required>
                  {TIPOS_DE_NOTIFICACAO.map((tipo) => (
                    <option key={tipo} value={tipo}>
                      {nomeDoAviso(tipo)}
                    </option>
                  ))}
                </select>
                <p className="ui-field__hint">
                  Os botões saem daqui, não do texto: o lembrete leva confirmar, remarcar e
                  cancelar; o de 2 horas não oferece remarcar, porque não há grade para
                  remanejar no mesmo dia.
                </p>
              </div>

              <div className="ui-field">
                <label className="ui-field__label" htmlFor="corpo">
                  O texto
                </label>
                <textarea
                  className="ui-field__input"
                  id="corpo"
                  name="corpo"
                  placeholder="Olá {{1}}, seu corte é amanhã às {{2}} com {{3}}."
                  required
                  rows={3}
                />
                <p className="ui-field__hint">
                  Escreva como você falaria com o cliente. Você não liga nada a ninguém: o
                  produto já sabe de quem é cada mensagem e encaixa o dado na hora de
                  enviar. O que você marca é <strong>onde</strong> ele entra.
                </p>
                {/* Derivado de `VARIAVEIS_DO_AVISO`, e é o que impede esta tela de
                    mentir de novo: ela prometia hora em `{{2}}` e profissional em
                    `{{3}}` enquanto o worker mandava nome do cliente e nome da
                    barbearia — dois valores, para todo tipo. Escrito nos dois lugares,
                    o par divergiu sem nada ficar vermelho. */}
                <dl className="significados">
                  {TIPOS_DE_NOTIFICACAO.map((tipo) => (
                    <div className="significados__par" key={tipo}>
                      <dt>{nomeDoAviso(tipo)}</dt>
                      <dd>
                        {VARIAVEIS_DO_AVISO[tipo].map((qual, i) => (
                          <span key={qual}>
                            {i > 0 ? ' · ' : ''}
                            <code>{`{{${i + 1}}}`}</code> {qual}
                          </span>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
                <p className="ui-field__hint">
                  Texto sem nenhum atalho também vale: “Seu agendamento está confirmado, te
                  esperamos em breve!” é um texto válido e a Meta aprova. E não invente
                  posição que não está na lista — a Meta recusa o envio, e a mensagem não
                  sai para ninguém.
                </p>
              </div>

              {/* Os botões, com o que acontece escrito ao lado.

                  Botão é a única parte da mensagem em que o cliente **age**, e
                  quem monta o texto precisa saber o efeito antes de oferecer:
                  sem isso, "Agendar novamente" parece marcar sozinho.

                  Só os dois que agem **sem** horário marcado. Confirmar e
                  cancelar mexem num agendamento provado, e quem recebe campanha
                  não tem nenhum — o cliente apertaria e nada aconteceria. */}
              {/* Os botões, agrupados **por aviso** e com o efeito ao lado.

                  Cinco existem, e nem todo aviso aceita os cinco: confirmar,
                  remarcar e cancelar mexem num agendamento provado, e quem
                  recebe campanha não tem nenhum — apertaria e nada aconteceria.
                  Ao contrário, "agendar novamente" num lembrete ofereceria
                  marcar de novo a quem já tem hora marcada.

                  Todos aparecem juntos porque o produto não tem componente de
                  cliente para trocar a lista ao mexer no seletor de aviso — é a
                  mesma limitação do rótulo que muda por opção. Então cada grupo
                  diz a que aviso pertence, e o domínio recusa a combinação
                  errada com a frase que explica.

                  O efeito vem escrito porque botão é a única parte da mensagem
                  em que o cliente **age**: sem ele, "Agendar novamente" parece
                  marcar sozinho. */}
              <fieldset className="etapa">
                <legend className="etapa__titulo">Botões, se quiser</legend>
                <p className="etapa__texto">
                  A Meta desenha o botão dentro da mensagem, e ele só aparece se ela aprovar.
                  Marque os do aviso que você escolheu acima.
                </p>
                {GRUPOS_DE_BOTAO.map((grupo) => (
                  <div key={grupo.titulo}>
                    <p className="ui-field__label">{grupo.titulo}</p>
                    <div className="alternativas">
                      {grupo.botoes.map((b) => (
                        <label className="alternativa" key={b}>
                          <input name="botoes" type="checkbox" value={b} />
                          <span className="alternativa__corpo">
                            <span className="alternativa__nome">{ROTULO_DO_BOTAO[b]}</span>
                            <span className="alternativa__nota">{EFEITO_DO_BOTAO[b]}</span>
                            {grupo.ressalvas[b] ? (
                              <span className="alternativa__nota alternativa__nota--risco">
                                {grupo.ressalvas[b]}
                              </span>
                            ) : null}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </fieldset>

              <button className="ui-button ui-button--secondary ui-button--block" type="submit">
                Mandar para aprovação
              </button>
            </form>
          </details>
        ) : null}
      </section>
    </main>
  );
}
