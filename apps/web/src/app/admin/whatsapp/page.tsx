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
  templatesDoWhatsAppNaApi,
  type TemplateNaTelaDoAdmin,
} from '@/lib/admin-api';
import { redirect } from 'next/navigation';
import { painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { acaoSalvarCadastroDoWhatsApp, acaoSubmeterTemplate, acaoSair } from '../acoes';
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

export default async function WhatsAppPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const query = await searchParams;

  const [cadastroResposta, templatesResposta] = await Promise.all([
    cadastroDoWhatsAppNaApi(token),
    templatesDoWhatsAppNaApi(token),
  ]);

  const cadastro = cadastroResposta.ok ? cadastroResposta.dados.cadastro : null;
  const templates = templatesResposta.ok ? templatesResposta.dados.templates : [];
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
      {/* "Confirme o número", e não "espere o e-mail": o que falta é um passo
          para fazer agora, e mandar esperar por ele para o trabalho. */}
      {feito === 'cadastro' ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Cadastro salvo. Falta confirmar o número no painel da Meta com o código que ela manda
          por SMS.
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

      {podeMexer ? (
        <section className="cartao-balcao">
          <h2 className="cartao-balcao__titulo">O número na Meta</h2>
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
