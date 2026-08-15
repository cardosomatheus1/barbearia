import type { Metadata } from 'next';
import {
  EXPLICACAO_DO_TEMPLATE,
  EXPLICACAO_DO_WHATSAPP,
  ROTULO_DO_BOTAO,
  ROTULO_DO_TEMPLATE,
  ROTULO_DO_WHATSAPP,
  TIPOS_DE_NOTIFICACAO,
  type BotaoDaMensagem,
} from '@barbearia/core';
import {
  cadastroDoWhatsAppNaApi,
  signupDoWhatsAppNaApi,
  templatesDoWhatsAppNaApi,
  type SignupDoWhatsAppNaTela,
  type TemplateNaTelaDoAdmin,
} from '@/lib/admin-api';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import {
  acaoConectarWhatsApp,
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
  numero_invalido: 'Confira os identificadores: eles são só números, e vêm do painel da Meta.',
  nome_invalido: 'O nome do texto aceita só minúsculas, números e sublinhado.',
  nao_configurado: 'Cadastre o número antes.',
  token_invalido: 'O token não confere. Copie de novo do painel da Meta.',
  forbidden: 'Sua conta não mexe no WhatsApp da casa.',
  request_failed: 'Não deu para salvar. Tente de novo.',
};

/** O rótulo de cada aviso, como o resto do produto o chama. */
const NOME_DO_AVISO: Record<string, string> = {
  confirmacao: 'Confirmação do agendamento',
  lembrete_24h: 'Lembrete de 24 horas',
  lembrete_2h: 'Lembrete de 2 horas',
  sua_vez: 'Sua vez na fila',
  senha_de_acesso: 'Senha de primeiro acesso',
  retorno: 'Convite de retorno',
};

function Template({ template }: { readonly template: TemplateNaTelaDoAdmin }) {
  return (
    <li>
      <article
        className={`item-cadastro${template.estado === 'rejeitado' ? ' item-cadastro--fora' : ''}`}
      >
        <div className="item-cadastro__cabeca">
          <div className="item-cadastro__quem">
            <h3 className="item-cadastro__nome">
              {NOME_DO_AVISO[template.tipo] ?? template.tipo}
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

/**
 * O botão que conecta o WhatsApp sem copiar identificador (bloco 83).
 *
 * ## O primeiro JavaScript que este produto manda ao navegador
 *
 * O painel inteiro é renderizado no servidor e não tem componente de cliente —
 * é decisão de arquitetura, e ela continua valendo. O que entra aqui não é um
 * componente React de cliente: é um `<script>` sob nonce numa tela só, atrás de
 * login, que não vai no pacote de ninguém e não existe em nenhuma outra rota.
 * A razão da regra — não entregar o ERP ao visitante anônimo (defeito D10) —
 * não é tocada.
 *
 * Não havia alternativa: o `FB.login` roda no navegador de quem se cadastra, e
 * é a Meta quem define esse contrato.
 *
 * ## Por que o formulário fica de pé sozinho
 *
 * O script preenche campos e submete um formulário normal, que posta para uma
 * *server action* como todo o resto do painel. Se o script não carregar, o que
 * sobra é o cadastro à mão logo abaixo — degrada para o caminho do bloco 55 em
 * vez de virar uma tela morta.
 */
function Conectar({
  nonce,
  signup,
}: {
  readonly nonce: string;
  readonly signup: SignupDoWhatsAppNaTela;
}) {
  return (
    <section className="cartao-balcao">
      <h2 className="cartao-balcao__titulo">Conectar o WhatsApp</h2>
      <p className="cartao-balcao__texto">
        A janela da Meta abre aqui mesmo: você entra na sua conta, escolhe a empresa e o número, e
        confirma o código que chega por SMS. Os identificadores vêm sozinhos — não é preciso copiar
        nada de lugar nenhum.
      </p>

      <form action={acaoConectarWhatsApp} id="conectar-whatsapp">
        <input name="code" type="hidden" />
        <input name="wabaId" type="hidden" />
        <input name="phoneNumberId" type="hidden" />
        <input name="numeroVisivel" type="hidden" />
        <button
          className="ui-button ui-button--primary ui-button--block"
          id="conectar-whatsapp-botao"
          type="button"
        >
          Conectar WhatsApp
        </button>
      </form>

      <p className="cartao-balcao__texto" id="conectar-whatsapp-espera" role="status" />

      <script
        // O nonce é o do middleware. Sem ele a política recusa este script, que
        // é exatamente o que ela existe para fazer com script inline.
        dangerouslySetInnerHTML={{
          __html: `(function(){
  var form = document.getElementById('conectar-whatsapp');
  var botao = document.getElementById('conectar-whatsapp-botao');
  var espera = document.getElementById('conectar-whatsapp-espera');
  if (!form || !botao) return;

  // A janela da Meta manda os ids por 'message'; o FB.login devolve o código.
  // As duas metades chegam separadas, e a conexão só acontece com as duas.
  var dados = null;
  var parou = null;
  // Lista fechada de origens, e não 'termina com facebook.com': a segunda casa
  // com 'evilfacebook.com', e quem manda a mensagem decide o que vira cadastro.
  var DA_META = ['https://www.facebook.com', 'https://web.facebook.com', 'https://business.facebook.com'];
  window.addEventListener('message', function (evento) {
    if (DA_META.indexOf(evento.origin) === -1) return;
    try {
      var corpo = JSON.parse(evento.data);
      if (corpo.type !== 'WA_EMBEDDED_SIGNUP') return;
      // 'FINISH' é o fluxo inteiro; 'FINISH_ONLY_WABA' é quem criou a conta e
      // não chegou a acrescentar número. O segundo não serve para mandar nada,
      // e tratá-lo como sucesso gravaria um cadastro sem 'phone_number_id' —
      // "Ativo" na tela com toda mensagem caindo no canal de reserva.
      if (corpo.event === 'FINISH') dados = corpo.data;
      else if (corpo.event === 'FINISH_ONLY_WABA') parou = 'sem_numero';
      else if (corpo.event === 'CANCEL') parou = corpo.data && corpo.data.current_step;
    } catch (e) { /* mensagem que não é do fluxo; ignorar */ }
  });

  function enviar(code) {
    if (!dados) {
      espera.textContent =
        parou === 'sem_numero'
          ? 'A conta foi criada, mas nenhum número foi acrescentado a ela. Abra de novo e acrescente o número da barbearia.'
          : 'A janela fechou antes de terminar' + (parou ? ' (parou em: ' + parou + ')' : '') + '. Tente de novo.';
      return;
    }
    form.elements['code'].value = code;
    form.elements['wabaId'].value = dados.waba_id || '';
    form.elements['phoneNumberId'].value = dados.phone_number_id || '';
    form.elements['numeroVisivel'].value = dados.business_phone_number || '';
    // O código vale **30 segundos**. A troca acontece no servidor e há um
    // salto a mais no caminho (a tela posta para a própria action, que chama a
    // API), então não há nada a fazer entre receber e submeter.
    espera.textContent = 'Conectando…';
    form.requestSubmit();
  }

  botao.addEventListener('click', function () {
    if (!window.FB) {
      espera.textContent = 'Não deu para abrir a janela da Meta. Cadastre os identificadores abaixo.';
      return;
    }
    window.FB.login(function (resposta) {
      var code = resposta && resposta.authResponse && resposta.authResponse.code;
      if (code) enviar(code);
      else espera.textContent = 'Você fechou a janela antes de terminar.';
    }, {
      config_id: ${JSON.stringify(signup.configId)},
      response_type: 'code',
      override_default_response_type: true,
      // Exigido pela Meta na v4 do fluxo. Sem ele a janela abre no fluxo
      // antigo, que não devolve os ids pelo evento.
      extras: { setup: {} },
    });
  });

  window.fbAsyncInit = function () {
    window.FB.init({ appId: ${JSON.stringify(signup.appId)}, xfbml: false, version: 'v21.0' });
  };
  var sdk = document.createElement('script');
  sdk.src = 'https://connect.facebook.net/en_US/sdk.js';
  sdk.async = true;
  document.head.appendChild(sdk);
})();`,
        }}
        nonce={nonce}
      />
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

  const [cadastroResposta, templatesResposta, signupResposta] = await Promise.all([
    cadastroDoWhatsAppNaApi(token),
    templatesDoWhatsAppNaApi(token),
    signupDoWhatsAppNaApi(token),
  ]);

  const cadastro = cadastroResposta.ok ? cadastroResposta.dados.cadastro : null;
  const templates = templatesResposta.ok ? templatesResposta.dados.templates : [];
  // `null` quando o app da plataforma não foi configurado: aí a tela não
  // desenha o botão, porque botão que abre janela vazia é pior que botão nenhum.
  const signup = signupResposta.ok ? signupResposta.dados.signup : null;
  const nonce = (await headers()).get('x-nonce') ?? '';
  const podeMexer = podeNaTela(estado, 'whatsapp.manage');
  const atual = cadastro?.estado ?? 'nao_configurado';
  const falha = first(query['erro']);
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

      {podeMexer && signup ? <Conectar nonce={nonce} signup={signup} /> : null}

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

        {podeMexer ? (
          <details className="dobra">
            <summary className="dobra__titulo">Mandar um texto para aprovação</summary>
            <form action={acaoSubmeterTemplate} className="formulario">
              <div className="ui-field">
                <label className="ui-field__label" htmlFor="tipo">
                  Para qual aviso
                </label>
                <select className="ui-field__input" id="tipo" name="tipo" required>
                  {TIPOS_DE_NOTIFICACAO.map((tipo) => (
                    <option key={tipo} value={tipo}>
                      {NOME_DO_AVISO[tipo] ?? tipo}
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
                <label className="ui-field__label" htmlFor="nome">
                  Nome na Meta
                </label>
                <input
                  className="ui-field__input"
                  id="nome"
                  name="nome"
                  placeholder="lembrete_24h_v1"
                  required
                />
                <p className="ui-field__hint">Só minúsculas, números e sublinhado.</p>
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
                  As variáveis são posicionais: <code>{'{{1}}'}</code> é o nome do cliente,{' '}
                  <code>{'{{2}}'}</code> a hora, <code>{'{{3}}'}</code> o profissional.
                </p>
              </div>

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
