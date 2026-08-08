import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { avisos, type EnvioRegistrado, type TipoDeAviso } from '@/lib/admin-api';
import { painelOuDesvio } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { acaoAvisos, acaoSair } from '../acoes';

/**
 * Avisos ao cliente.
 *
 * Duas coisas na mesma tela, porque quem abre chega por uma das duas perguntas:
 * "quero desligar o lembrete de 2 horas" e "o cliente foi avisado ou não?". A
 * segunda quase sempre aparece no meio de uma discussão sobre falta, e mandar
 * essa pessoa procurar num relatório é o que faz ela deixar de perguntar.
 *
 * O histórico mostra o que **não** saiu junto com o que saiu, com o motivo.
 * Uma lista só de sucessos responde "sim" e nunca "não, porque…", que é
 * justamente a resposta de que a discussão precisa.
 */

export const metadata: Metadata = {
  title: 'Avisos',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const FALHA: Record<string, string> = {
  invalid_request: 'Confira os dados: o prazo de retorno vai de 7 a 365 dias.',
  forbidden: 'Sua conta não altera a configuração da barbearia.',
  location_not_found: 'Esta barbearia ainda não tem unidade cadastrada.',
  request_failed: 'Não deu para salvar. Tente de novo.',
};

const NOME_DO_AVISO: Record<TipoDeAviso, string> = {
  confirmacao: 'Confirmação',
  lembrete_24h: 'Lembrete de 24h',
  lembrete_2h: 'Lembrete de 2h',
  sua_vez: 'É a sua vez',
  senha_de_acesso: 'Senha de acesso',
  retorno: 'Convite de retorno',
};

/**
 * Por que não saiu, em português.
 *
 * O código cru (`fora_da_janela`) é do log; quem lê a tela precisa da frase. E
 * ela diz o que aconteceu, não pede desculpa — motivo de não envio quase sempre
 * é o sistema fazendo a coisa certa.
 */
const MOTIVO: Record<string, string> = {
  sem_telefone: 'Sem celular cadastrado',
  cancelado: 'O horário foi desmarcado',
  ja_enviada: 'Já tinha sido avisado',
  passou_da_hora: 'A hora do aviso já tinha passado',
  sem_consentimento: 'O cliente não aceita mensagem promocional',
  teto_do_mes: 'Teto de mensagens promocionais do mês',
  ainda_no_prazo: 'Ainda dentro do prazo de retorno',
  provedor_indisponivel: 'O canal de mensagem estava fora do ar',
};

const ROTULO_DO_STATUS: Record<EnvioRegistrado['status'], string> = {
  sent: 'Enviado',
  failed: 'Falhou',
  skipped: 'Não enviado',
};

function quando(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

export default async function AvisosPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const query = await searchParams;
  const erro = first(query['erro']);
  const salvo = first(query['salvo']) === '1';
  const resposta = await avisos(token);

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
      <main className="ui-container painel__conteudo" data-secao="avisos">
        {topo}
        <h1 className="painel__titulo">Avisos</h1>
        <div className="ui-alert ui-alert--warning" role="alert">
          {FALHA[resposta.code] ?? FALHA['request_failed']}{' '}
          <a className="ui-button ui-button--secondary painel__saida" href="/admin/dia">Voltar ao dia</a>
        </div>
      </main>
    );
  }

  const { settings, log } = resposta.dados;

  return (
    <main className="ui-container painel__conteudo" data-secao="avisos">
      {topo}

      <h1 className="painel__titulo">Avisos ao cliente</h1>
      <p className="painel__sub">
        O que sai daqui usa o fuso da barbearia e nunca entre 21h e 8h. Cliente que recusou
        mensagem promocional continua recebendo o lembrete do próprio corte.
      </p>

      {erro ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {FALHA[erro] ?? FALHA['request_failed']}
        </div>
      ) : null}

      {salvo ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Configuração salva.
        </div>
      ) : null}

      <form action={acaoAvisos} className="formulario">
        <fieldset className="painel__grupo">
          <legend className="ui-field__label">Sobre o horário marcado</legend>
          <div className="avisos__opcoes">
            <label className="marca" htmlFor="confirmacao">
              <input
                defaultChecked={settings.confirmacao}
                id="confirmacao"
                name="confirmacao"
                type="checkbox"
              />
              <span>Confirmação na hora de marcar</span>
            </label>
            <label className="marca" htmlFor="lembrete24h">
              <input
                defaultChecked={settings.lembrete24h}
                id="lembrete24h"
                name="lembrete24h"
                type="checkbox"
              />
              <span>Lembrete um dia antes</span>
            </label>
            <label className="marca" htmlFor="lembrete2h">
              <input
                defaultChecked={settings.lembrete2h}
                id="lembrete2h"
                name="lembrete2h"
                type="checkbox"
              />
              <span>Lembrete duas horas antes</span>
            </label>
          </div>
          <p className="ui-field__hint">
            O lembrete de um dia antes é o que mais derruba falta. O de duas horas ajuda quem
            marcou com semanas de antecedência.
          </p>
        </fieldset>

        <fieldset className="painel__grupo">
          <legend className="ui-field__label">Convite de retorno</legend>
          <div className="avisos__opcoes">
            <label className="marca" htmlFor="retorno">
              <input
                defaultChecked={settings.retorno}
                id="retorno"
                name="retorno"
                type="checkbox"
              />
              <span>Chamar quem sumiu</span>
            </label>
          </div>

          <label className="ui-field__label avisos__prazo" htmlFor="diasParaRetorno">
            Depois de quantos dias sem voltar
          </label>
          <input
            className="ui-field__input tabular avisos__dias"
            defaultValue={settings.diasParaRetorno}
            id="diasParaRetorno"
            max={365}
            min={7}
            name="diasParaRetorno"
            type="number"
          />
          <p className="ui-field__hint">
            Esta é a única mensagem promocional daqui: só vai para quem aceitou receber, no
            máximo quatro vezes por mês, contando todas as promoções.
          </p>
        </fieldset>

        <button className="ui-button ui-button--primary ui-button--lg ui-button--block" type="submit">
          Salvar
        </button>
      </form>

      <h2 className="avisos__titulo">Últimos envios</h2>

      {log.length === 0 ? (
        <div className="vazio">
          <p className="vazio__titulo">Nenhum aviso saiu ainda</p>
          <p className="vazio__saida">
            O primeiro sai quando alguém marcar um horário. Se você acabou de ligar um aviso,
            ele vale para os horários marcados a partir de agora.
          </p>
          <a className="ui-button ui-button--secondary" href="/admin/agenda">
            Ver a agenda
          </a>
        </div>
      ) : (
        <ul className="envios">
          {log.map((envio) => (
            <li className="envios__item" key={envio.id}>
              <div className="envios__linha">
                <span className="envios__tipo">{NOME_DO_AVISO[envio.tipo]}</span>
                <span
                  className={`envios__status envios__status--${envio.status}`}
                  data-status={envio.status}
                >
                  {ROTULO_DO_STATUS[envio.status]}
                </span>
              </div>
              <p className="envios__quem">
                {envio.quem ?? 'sem cadastro'}
                {envio.telefone ? ` · ${envio.telefone}` : ''}
              </p>
              <p className="envios__meta">
                <time dateTime={envio.enviadoEm}>{quando(envio.enviadoEm)}</time>
                {envio.motivo ? ` · ${MOTIVO[envio.motivo] ?? envio.motivo}` : ''}
              </p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
