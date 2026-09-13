/**
 * Os pedaços da avaliação que **duas** telas desenham.
 *
 * `ARecuperar` e `Contestar` nasceram dentro de `avaliacoes/page.tsx`, e saíram
 * daqui quando a caixa de entrada do cliente passou a listar a nota baixa ao
 * lado do recado. Duplicar o cartão nas duas telas seria a lista paralela de
 * sempre, agora em JSX: o dia em que o prazo ou o desfecho mudassem, uma das
 * duas ficaria para trás — e é justamente a tela de agir que ninguém olharia
 * duas vezes para conferir.
 */
import {
  DESFECHOS_DA_RECUPERACAO,
  JANELA_DE_RECUPERACAO_HORAS,
  MOTIVOS_DA_CONTESTACAO,
  PRAZO_PARA_TRATAR,
  ROTULO_DO_DESFECHO,
  ROTULO_DO_MOTIVO,
  VERBO_DA_RECUPERACAO,
} from '@barbearia/core';
import type { AvaliacaoNaTela } from '@/lib/admin-api';
import { localTime } from '@/lib/date';

import { acaoContestarAvaliacao, acaoTratarAvaliacao } from '../acoes';

export const dia = (fuso: string, iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat('pt-BR', {
        timeZone: fuso,
        day: '2-digit',
        month: '2-digit',
      }).format(new Date(iso))
    : '—';

export const hora = (fuso: string, iso: string | null) => (iso ? localTime(fuso, iso) : '');

/** O alerta da SPEC: "Cliente insatisfeito — Carlos, nota 2, atendimento de hoje 14:00". */
export function ARecuperar({
  avaliacao,
  podeContestar,
  fuso,
}: {
  readonly avaliacao: AvaliacaoNaTela;
  readonly podeContestar: boolean;
  /** O fuso da unidade. Formatar no do processo é o defeito D2. */
  readonly fuso: string;
}) {
  return (
    <article className="avaliacao avaliacao--alerta">
      <header className="avaliacao__topo">
        <p className="avaliacao__estrelas" aria-label={`Nota ${avaliacao.nota} de 5`}>
          {avaliacao.estrelas}
        </p>
        <p className="avaliacao__prazo tabular">
          {PRAZO_PARA_TRATAR(avaliacao.horasRestantes)}
        </p>
      </header>

      <p className="avaliacao__quem">
        {avaliacao.clienteNome}
        {avaliacao.servicoNome ? ` · ${avaliacao.servicoNome}` : ''}
        {avaliacao.profissionalNome ? ` com ${avaliacao.profissionalNome}` : ''}
      </p>
      <p className="avaliacao__quando">
        Atendimento de {dia(fuso, avaliacao.atendidoEm)} às {hora(fuso, avaliacao.atendidoEm)}
      </p>

      {avaliacao.comentario ? (
        <blockquote className="avaliacao__texto">{avaliacao.comentario}</blockquote>
      ) : (
        <p className="avaliacao__texto avaliacao__texto--vazio">
          Deu a nota e não escreveu nada. Vale mais uma ligação, não menos.
        </p>
      )}

      <form action={acaoTratarAvaliacao} className="avaliacao__form">
        <input name="id" type="hidden" value={avaliacao.id} />

        <label className="ui-field">
          <span className="ui-field__label">O que você fez</span>
          <select className="ui-field__input" defaultValue="contato" name="desfecho">
            {DESFECHOS_DA_RECUPERACAO.map((d) => (
              <option key={d} value={d}>
                {ROTULO_DO_DESFECHO[d]}
              </option>
            ))}
          </select>
        </label>

        <label className="ui-field">
          <span className="ui-field__label">Como foi</span>
          <textarea
            className="ui-field__input"
            maxLength={1000}
            minLength={10}
            name="nota"
            placeholder="Liguei, ele contou que esperou 40 minutos. Refiz o corte na quinta, sem cobrar."
            required
            rows={2}
          />
          <span className="ui-field__hint">
            Daqui a seis meses, isto é o que responde “por que esse cliente voltou?”.
          </span>
        </label>

        <button className="ui-button ui-button--primary" type="submit">
          {VERBO_DA_RECUPERACAO}
        </button>
      </form>

      {/*
        A saída também mora aqui, e é de propósito: a nota 1 de quem nunca foi
        atendido cai nesta fila como qualquer outra, e mandar o dono procurá-la
        na lista de baixo seria a tela escondendo a resposta certa.
      */}
      {podeContestar ? <Contestar avaliacao={avaliacao} /> : null}
    </article>
  );
}

/**
 * O formulário de contestação, atrás de um `<details>` e nunca em destaque.
 *
 * A ação primária desta tela é registrar o que a casa fez — o botão âmbar do
 * cartão de alerta. Contestar é a saída para o caso raro, e um botão do mesmo
 * peso ao lado de toda nota ensinaria a equipe a alcançá-lo primeiro. É o mesmo
 * desenho da zona de perigo da ficha do cliente: destaque de **cor**, nunca de
 * tamanho.
 */
export function Contestar({ avaliacao }: { readonly avaliacao: AvaliacaoNaTela }) {
  return (
    <details className="anotar avaliacao__contestar">
      <summary className="anotar__abrir avaliacao__contestar-abrir">Contestar esta avaliação</summary>

      {/*
        A frase que impede o mal-entendido, e é irmã da frase das 48 horas logo
        acima. Sem ela, um botão chamado "contestar" parece o botão de apagar
        que a SPEC §4.10 proíbe — e a equipe aprenderia a usá-lo assim.
      */}
      <p className="painel__nota">
        Contestar <strong>suspende a avaliação do seu perfil público</strong> enquanto a casa
        alega que ela é injusta. A nota e o texto continuam aqui, sem mudar, e{' '}
        <strong>a sua média continua contando esta avaliação</strong> — só o cliente deixa de vê-la.
        Não é apagar, e não existe apagar.
      </p>

      <form action={acaoContestarAvaliacao} className="avaliacao__form avaliacao__form--contestar">
        <input name="id" type="hidden" value={avaliacao.id} />

        <label className="ui-field">
          <span className="ui-field__label">Por que ela é injusta</span>
          <select className="ui-field__input" defaultValue="spam" name="motivo">
            {MOTIVOS_DA_CONTESTACAO.map((m) => (
              <option key={m} value={m}>
                {ROTULO_DO_MOTIVO[m]}
              </option>
            ))}
          </select>
        </label>

        <label className="ui-field">
          <span className="ui-field__label">O que aconteceu</span>
          <textarea
            className="ui-field__input"
            maxLength={1000}
            minLength={10}
            name="nota"
            placeholder="Não temos atendimento no nome dela, e o texto é o mesmo que apareceu em outras três barbearias da rua."
            required
            rows={2}
          />
          <span className="ui-field__hint">
            Fica na trilha, com o seu nome. É o que sustenta a suspensão se alguém perguntar.
          </span>
        </label>

        <button className="ui-button ui-button--secondary" type="submit">
          Contestar
        </button>
      </form>
    </details>
  );
}
