/**
 * O aviso preso ao horário marcado, desenhado fora da própria página.
 *
 * Ele saiu daqui no bloco 145, quando "Avisos ao cliente" e "Automações" viraram
 * uma tela só: seis avaliadores cegos, em quatro rodadas, travaram na pergunta
 * *"fazer o sistema mandar sozinho um lembrete"* — porque as duas telas
 * configuravam mensagem automática e nenhum dos dois nomes dizia qual.
 *
 * O bloco continua **inteiro** — configuração e histórico juntos —, e é de
 * propósito: quem abre chega por uma das duas perguntas, e a segunda ("o cliente
 * foi avisado ou não?") quase sempre nasce no meio de uma discussão sobre falta.
 * Separar as duas mandaria essa pessoa procurar num relatório, que é o que faz
 * ela deixar de perguntar.
 */
import { explicacaoDoPulo, nomeDoAviso } from '@barbearia/core';
import type { EnvioRegistrado, PreferenciasDeAviso, TipoDeAviso } from '@/lib/admin-api';
import { AvisoDeRecusa } from '@/app/admin/aviso-de-recusa';

import { acaoAvisos } from '../acoes';

const FALHA: Record<string, string> = {
  invalid_request: 'Confira os dados: o prazo de retorno vai de 7 a 365 dias.',
  forbidden: 'Sua conta não altera a configuração da barbearia.',
  location_not_found: 'Esta barbearia ainda não tem unidade cadastrada.',
  request_failed: 'Não deu para salvar. Tente de novo.',
};

/**
 * Por que não saiu, em português.
 *
 * O código cru (`fora_da_janela`) é do log; quem lê a tela precisa da frase. E
 * ela diz o que aconteceu, não pede desculpa — motivo de não envio quase sempre
 * é o sistema fazendo a coisa certa.
 */
const ROTULO_DO_STATUS: Record<EnvioRegistrado['status'], string> = {
  sent: 'Enviado',
  failed: 'Falhou',
  skipped: 'Não enviado',
};

/**
 * Fuso da unidade, e não do processo (bloco 135).
 *
 * Sem `timeZone`, `Intl` usa UTC no servidor e o do aparelho no navegador: o
 * React não reidrata a hora e a **página inteira** cai com o erro 418. É o
 * defeito D2 com uma segunda consequência, e foi assim que a ficha do cliente
 * quebrou no percurso da medição do bloco 134.
 */
function quando(fuso: string, iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: fuso,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}


export function AvisosDoHorario({
  settings,
  log,
  fuso,
  salvo,
  erro,
}: {
  readonly settings: PreferenciasDeAviso;
  /** O fuso da unidade. Formatar no do processo é o defeito D2. */
  readonly fuso: string;
  readonly log: readonly EnvioRegistrado[];
  readonly salvo: boolean;
  readonly erro: string | undefined;
}) {
  return (
    <section aria-labelledby="do-horario" className="avisos-do-horario">
      <h2 className="cartao-balcao__titulo" id="do-horario">Do horário marcado</h2>
      <p className="painel__sub">
        O que sai daqui usa o fuso da barbearia e nunca entre 21h e 8h. Cliente que recusou
        mensagem promocional continua recebendo o lembrete do próprio corte.
      </p>

      {erro ? (
        <AvisoDeRecusa erro={erro} mapa={FALHA} className="painel__aviso" />
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
                {/*
                  O nome sai de `packages/core` (bloco 96).

                  Esta tela tinha o mapa escrito à mão, com **outras palavras**
                  para as mesmas seis coisas: "É a sua vez" aqui, "Sua vez na
                  fila" em WhatsApp; "Confirmação" aqui, "Confirmação do
                  agendamento" lá. Terceira cópia da mesma lista, e as três
                  divergiram — §6 pergunta 2, a mesma coisa com nomes
                  diferentes em telas do mesmo produto.
                */}
                <span className="envios__tipo">{nomeDoAviso(envio.tipo)}</span>
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
                <time dateTime={envio.enviadoEm}>{quando(fuso, envio.enviadoEm)}</time>
                {/* A frase sai de `packages/core`: esta tela tinha o quinto
                    mapa de motivos do produto, com palavras próprias para os
                    mesmos fatos — e era o único que conhecia
                    `sem_consentimento`, o que deixava a lista de "quem não
                    recebeu" da campanha dizendo "Não deu para mandar" sobre um
                    motivo que o produto sabe explicar. */}
                {envio.motivo ? ` · ${explicacaoDoPulo(envio.motivo)}` : ''}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
