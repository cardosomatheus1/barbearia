import type { Metadata } from 'next';
import {
  AVISO_SEM_GERENCIA,
  EXPLICACAO_DO_WHATSAPP,
  ROTULO_DO_BOTAO,
  ROTULO_DO_WHATSAPP,
  estadoDoTextoNaTela,
  corpoComExemplos,
  nomeDoAviso,
  oQueFazerNaMeta,
  podeGerenciarTemplates,
  type BotaoDaMensagem,
} from '@barbearia/core';
import {
  cadastroDoWhatsAppNaApi,
  signupDoWhatsAppNaApi,
  templatesDoWhatsAppNaApi,
  type TemplateNaTelaDoAdmin,
} from '@/lib/admin-api';
import { redirect } from 'next/navigation';
import { painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerMotivoDaMeta, lerSessaoGestor } from '@/lib/sessao-gestor';
import {
  acaoConciliarWhatsApp,
  acaoIrParaMeta,
  acaoSalvarCadastroDoWhatsApp,
  acaoSair,
} from '../acoes';
import { secao } from '../secoes';
import { FalhaDaLeitura } from '../falha-da-leitura';
import { conexaoWhatsAppNaApi } from '@/lib/admin-api';
import { ConexaoWhatsApp } from './conexao';
import { TextosBaileys } from './textos-baileys';
import { ModosWhatsApp } from './modos';
import { EditorMeta } from './editor-meta';

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
    'Esta volta não bate com a conexão que começou aqui. Comece de novo por segurança — e se repetir, peça ajuda ao suporte.',
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
   * A falha que ninguém previu, com frase em vez da página crua do Next.
   *
   * Ela não diz "tente de novo" porque não se sabe se tentar de novo resolve —
   * e não manda procurar no painel da Meta, porque o problema é deste lado. O
   * que ela promete é o que de fato passou a acontecer: o motivo está no log.
   */
  falha_inesperada:
    'Alguma coisa falhou aqui dentro no meio da conexão. O erro foi registrado no servidor com o detalhe técnico — se repetir, é ele que diz o que houve.',
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
  baileys_texto_invalido: 'Confira o título, o texto e as variáveis disponíveis para este aviso.',
  baileys_tipo_do_texto: 'Crie outra mensagem para mudar a finalidade.',
  baileys_texto_ausente: 'Esta mensagem não está disponível. Atualize a página.',
};

function Template({ template }: { readonly template: TemplateNaTelaDoAdmin }) {
  // Rótulo e explicação saem da mesma função do domínio: `pendente` responde
  // "esperando a fila" e "esperando a Meta", e a tela não é quem decide qual.
  const estado = estadoDoTextoNaTela(template.estado, template.naFila);
  return (
    <li>
      <article
        className={`item-cadastro${template.estado === 'rejeitado' ? ' item-cadastro--fora' : ''}`}
      >
        <div className="item-cadastro__cabeca">
          <div className="item-cadastro__quem">
            {/*
              O nome que a barbearia deu, e não o do tipo (bloco 96).

              Com três convites de retorno cadastrados, os três apareciam nesta
              lista como "Convite de retorno" — três linhas idênticas, sendo que
              o título existe desde o bloco 94 e é ele que a automação e a
              campanha oferecem. O tipo continua visível na linha de baixo.
            */}
            <h3 className="item-cadastro__nome">
              {template.titulo ?? nomeDoAviso(template.tipo)}
            </h3>
            {/*
              O tipo só quando ele **acrescenta** algo.

              Texto sem título cai no nome do aviso lá em cima, e repeti-lo aqui
              dava "Confirmação do agendamento · Confirmação do agendamento" —
              a mesma frase duas vezes ensina a pular a linha que existe para
              explicar o que o título não diz.
            */}
            <p className="item-cadastro__linha">
              {template.titulo ? `${nomeDoAviso(template.tipo)} · ` : ''}
              {template.nome} · {estado.rotulo}
            </p>
            <p className="item-cadastro__linha">{estado.explicacao}</p>
            {template.motivoDaRecusa ? (
              <p className="item-cadastro__linha item-cadastro__risco">
                {template.motivoDaRecusa}
              </p>
            ) : null}
            {/*
              O texto cru **e** como ele chega.

              Esta é a tela em que o texto se escreve, então `{{1}}` importa: é
              o que a pessoa digitou e o que a Meta aprovou. Mas ler a frase com
              as chaves duplas não responde se ela ficou boa — e é essa a
              decisão que a tela pede. As duas linhas, e a segunda com o rótulo
              dizendo o que ela é.
            */}
            <p className="item-cadastro__linha">{template.corpo}</p>
            <p className="item-cadastro__linha">
              Chega assim: {corpoComExemplos(template.tipo, template.corpo)}
            </p>
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



function Conectar({ modo, habilitado = true }: { readonly modo: 'padrao' | 'coexistencia'; readonly habilitado?: boolean }) {
  return (
    <section className="cartao-balcao">
      <h2 className="cartao-balcao__titulo">Passo a passo do cadastro na Meta</h2>
      <ol>
        <li><strong>Separe o acesso da empresa e do número.</strong> Você precisa entrar na conta da Meta que gerencia a empresa e ter acesso ao número que vai cadastrar.</li>
        <li><strong>Clique em “Conectar pela Meta”.</strong> Na tela oficial, entre na sua conta e escolha ou cadastre a empresa e o número.</li>
        <li><strong>Conclua a verificação pedida pela Meta.</strong> Confirme o código por SMS ou ligação quando solicitado e revise as permissões.</li>
        <li><strong>Volte aqui e confira o estado do número.</strong> Se houver pendências, siga a orientação mostrada. Depois crie suas mensagens e aguarde a aprovação.</li>
      </ol>
      <p className="painel__nota">Os dados da conexão vêm automaticamente. Confira também a forma de pagamento e os <a href="https://business.whatsapp.com/products/platform-pricing" target="_blank" rel="noopener noreferrer">custos de envio da Meta</a>. As tarifas variam conforme a mensagem e o destino.</p>

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
      {habilitado ? <form action={acaoIrParaMeta}>
        <button className="ui-button ui-button--primary ui-button--block" type="submit">
          Conectar pela Meta
        </button>
      </form> : <p className="painel__nota">Para iniciar o cadastro, escolha “Usar conexão Meta” acima.</p>}
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
function ConfiguracaoAvancada({
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
  const [cadastroResposta, templatesResposta, signupResposta, conexaoResposta] = await Promise.all([
    cadastroDoWhatsAppNaApi(token),
    templatesDoWhatsAppNaApi(token),
    // Só o modo: quem sorteia o `state` e monta o endereço é a ação do botão,
    // porque cookie não se grava durante a renderização.
    signupDoWhatsAppNaApi(token),
    conexaoWhatsAppNaApi(token),
  ]);

  /**
   * Sem `whatsapp.manage` a tela não é uma versão reduzida — ela é nada.
   *
   * A tela lia com `resposta.ok ? ... : []` em toda parte, então o 403 virava
   * lista vazia: quem não tem a permissão via o formulário inteiro e só
   * descobria no botão. Some do menu desde o bloco 126; quem chega pelo
   * endereço lê a frase.
   */
  if (!cadastroResposta.ok && cadastroResposta.code === 'forbidden') {
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
        <FalhaDaLeitura code="forbidden" href="/admin/whatsapp" oque="o WhatsApp da barbearia" />
      </main>
    );
  }

  const cadastro = cadastroResposta.ok ? cadastroResposta.dados.cadastro : null;
  const todosTextos = templatesResposta.ok ? templatesResposta.dados.templates : [];
  const templates = todosTextos.filter(t => t.canal !== 'baileys');
  // `null` quando o app da plataforma não foi configurado: aí a tela não
  // desenha o botão, porque botão que abre janela vazia é pior que botão nenhum.
  const signup = signupResposta.ok ? signupResposta.dados.signup : null;
  const podeMexer = podeNaTela(estado, 'whatsapp.manage');
  const atual = cadastro?.estado ?? 'nao_configurado';
  const falha = first(query['erro']);
  const motivoDaMeta = falha ? await lerMotivoDaMeta() : null;
  const oQueFazer = motivoDaMeta ? oQueFazerNaMeta(motivoDaMeta) : null;
  const feito = first(query['feito']);
  const ativo = conexaoResposta.ok ? conexaoResposta.dados.canal : null;
  const solicitado = first(query['modo']);
  const modo = solicitado === 'meta' || solicitado === 'baileys' ? solicitado : ativo ?? 'meta';

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
        Escolha uma opção e siga os passos para preparar suas mensagens.
      </p>

      <ModosWhatsApp modo={modo} ativo={ativo} />

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
      {conexaoResposta.ok ? <ConexaoWhatsApp inicial={conexaoResposta.dados} modo={modo} podeMexer={podeMexer} /> :
        <FalhaDaLeitura code={conexaoResposta.code} href="/admin/whatsapp" oque="a conexão do WhatsApp" />}
      {conexaoResposta.ok && modo === 'meta' && ativo !== modo ? signup ? <Conectar modo={signup.modo} habilitado={false} /> : <p className="painel__nota">A conexão guiada pela Meta ainda não está disponível nesta instalação. Peça ao suporte para habilitá-la; quem já possui credenciais da API pode usar a configuração avançada após escolher a conexão Meta.</p> : null}
      {conexaoResposta.ok && modo === 'baileys' && ativo === modo ? <>
        {feito === 'texto-local' ? <p className="ui-alert ui-alert--success" role="status">Mensagem salva.</p> : null}
        {templatesResposta.ok ? <TextosBaileys mensagens={todosTextos.filter(t => t.canal === 'baileys')} /> :
          <FalhaDaLeitura code={templatesResposta.code} href="/admin/whatsapp" oque="as mensagens" />}
      </> : conexaoResposta.ok && modo === 'meta' && ativo === modo ? <>

      {/* "Confirme o número", e não "espere o e-mail": o que falta é um passo
          para fazer agora, e mandar esperar por ele para o trabalho. */}
      {feito === 'cadastro' ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Cadastro salvo. Confira o estado da conexão abaixo para saber se há alguma etapa pendente na Meta.
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
          Cadastro recebido da Meta. Confira o estado do número abaixo e prepare as mensagens para aprovação.
        </div>
      ) : null}
      {feito === 'template' ? (
        /*
          A frase deixou de prometer o que ainda não aconteceu (bloco 133).

          Ela dizia "Texto enviado para aprovação" no instante em que a
          requisição voltava — e a requisição agora só enfileira. Quem lesse
          isso e fosse conferir no painel da Meta não acharia nada, e concluiria
          que o produto está quebrado. É o mesmo defeito do bloco 132, uma tela
          adiante: a frase afirmando um fato que o produto não tem.
        */
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Texto guardado e na fila para a Meta. Ele sai daqui em instantes, e a resposta dela
          costuma vir em minutos — às vezes em dias. Use “Atualizar estado na Meta” para conferir a resposta.
        </div>
      ) : null}

      {/*
        O estado vem primeiro e em letras: a maior parte do tempo ele **não** é
        "ativo", e cada um pede uma coisa diferente de quem opera. "WhatsApp:
        não" serviria para três situações e não diria o que fazer em nenhuma.
      */}
      <section className="cartao-balcao" id="configuracao">
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
          Consulte os limites e as pendências da sua conta no Gerenciador do WhatsApp da Meta.
          A liberação depende da análise da Meta e da situação do número.
        </p>
        {podeMexer && cadastro ? <form action={acaoConciliarWhatsApp}><button className="ui-button ui-button--ghost" type="submit">Atualizar estado na Meta</button></form> : null}
      </section>

      {podeMexer && signup ? atual === 'ativo' ? <details className="dobra">
        <summary className="dobra__titulo">Ver passo a passo ou reconectar pela Meta</summary>
        <Conectar modo={signup.modo} />
      </details> : <Conectar modo={signup.modo} /> : null}

      {/*
        Com o botão de conexão na tela, o formulário técnico vai para dentro de
        um `<details>`. Ele não some — quem já tem os ids, ou quem precisa
        trocar só o token, continua tendo por onde —, mas para de competir com o
        caminho que a barbearia deve usar.

        Também resolve o defeito de dois campos com o mesmo `name` na mesma
        tela: `wabaId` e `phoneNumberId` existem nos dois formulários, e um
        deles fechado é um destino a menos para errar.
      */}
      {podeMexer && !signup ? <p className="ui-alert ui-alert--warning">
        A conexão guiada pela Meta ainda não está disponível nesta instalação. Peça ao suporte para habilitá-la.
        Se sua empresa já usa a plataforma do WhatsApp Business, use a configuração avançada abaixo.
      </p> : null}
      {podeMexer ? <details className="dobra">
        <summary className="dobra__titulo">Configuração avançada — já tenho WhatsApp Business Platform</summary>
        <p className="painel__nota">Para quem já possui a conta e as credenciais da API Meta. Na conexão guiada, esses dados são preenchidos automaticamente.</p>
        <ConfiguracaoAvancada cadastro={cadastro} />
      </details> : null}

      <section className="cartao-balcao" id="mensagens-meta">
        <h2 className="cartao-balcao__titulo">Mensagens da Meta</h2>
        <p className="cartao-balcao__texto">
          As mensagens usadas nos envios automáticos precisam de aprovação da Meta. Ela pode pausar mensagens com avaliações negativas dos destinatários.
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
            Nenhuma mensagem cadastrada. Para sua primeira campanha, crie um convite de retorno. Para avisos da agenda, escolha o tipo de lembrete correspondente.
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
          <details className="dobra">
            <summary className="dobra__titulo">Criar mensagem para aprovação</summary>
            <EditorMeta />
          </details>
        ) : null}
        <p className="painel__nota">Depois da aprovação, escolha a mensagem em <a href="/admin/campanhas">Campanhas, para enviar uma vez a uma lista</a>, ou em <a href="/admin/automacoes">Automações, para enviar quando algo acontecer</a>.</p>
      </section>
      </> : null}
    </main>
  );
}
