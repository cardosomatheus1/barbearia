'use client';
import { useState } from 'react';
import { useFormStatus } from 'react-dom';
import {
  BOTOES_POSSIVEIS, BOTOES_QUE_LEVAM, EFEITO_DO_BOTAO, EFEITO_DO_BOTAO_QUE_LEVA,
  RESSALVA_DO_BOTAO, ROTULO_DO_BOTAO, ROTULO_DO_BOTAO_QUE_LEVA,
  TIPOS_DE_NOTIFICACAO, VARIAVEIS_DO_AVISO, corpoComExemplos, nomeDoAviso,
  type TipoDeNotificacao,
} from '@barbearia/core';
import { acaoSubmeterTemplate } from '../acoes';
import styles from './conexao.module.css';

function Enviar() {
  const { pending } = useFormStatus();
  return <button className="ui-button ui-button--secondary" type="submit" disabled={pending}>{pending ? 'Guardando mensagem…' : 'Mandar para aprovação'}</button>;
}

export function EditorMeta() {
  const [tipo, setTipo] = useState<TipoDeNotificacao>('retorno');
  const [corpo, setCorpo] = useState('');
  return <form action={acaoSubmeterTemplate} className="formulario">
    <div className="ui-field">
      <label className="ui-field__label" htmlFor="titulo">Nome deste texto</label>
      <input className="ui-field__input" id="titulo" name="titulo" maxLength={80} placeholder="Convite para voltar" required />
      <p className="ui-field__hint">Use um nome fácil de reconhecer ao escolher a mensagem de uma campanha ou automação.</p>
    </div>
    <div className="ui-field">
      <label className="ui-field__label" htmlFor="tipo">Para qual aviso</label>
      <select className="ui-field__input" id="tipo" name="tipo" value={tipo} onChange={e => setTipo(e.target.value as TipoDeNotificacao)}>
        {TIPOS_DE_NOTIFICACAO.map(t => <option key={t} value={t}>{nomeDoAviso(t)}</option>)}
      </select>
    </div>
    <div className="ui-field">
      <label className="ui-field__label" htmlFor="corpo">O texto</label>
      <textarea className="ui-field__input" id="corpo" name="corpo" minLength={5} maxLength={1024} rows={4} value={corpo} onChange={e => setCorpo(e.target.value)} required />
      <p className="ui-field__hint">Escreva a mensagem e, se quiser, use os atalhos abaixo. Confira os atalhos ao mudar o tipo de aviso.</p>
      <p className="ui-field__hint" aria-live="polite">{VARIAVEIS_DO_AVISO[tipo].map((v, i) => `{{${i + 1}}}: ${v}`).join(' · ')}</p>
    </div>
    {corpo ? <div><p className="ui-field__label">Prévia com dados de exemplo</p><p className={styles.previa}>{corpoComExemplos(tipo, corpo)}</p></div> : null}
    {/* Trocar o aviso desmonta as escolhas anteriores: nenhum botão incompatível vai no formulário. */}
    <details className="dobra" key={tipo}>
      <summary className="dobra__titulo">Adicionar botões à mensagem (opcional)</summary>
      <p className="painel__nota">A Meta também precisa aprovar os botões. Estas opções são compatíveis com o aviso escolhido.</p>
      <fieldset className="etapa">
        <legend className="etapa__titulo">Abrir um destino</legend>
        <div className="alternativas">{BOTOES_QUE_LEVAM.map(b => <label className="alternativa" key={b}>
          <input name="acoes" type="checkbox" value={b} />
          <span className="alternativa__corpo"><span className="alternativa__nome">{ROTULO_DO_BOTAO_QUE_LEVA[b]}</span><span className="alternativa__nota">{EFEITO_DO_BOTAO_QUE_LEVA[b]}</span></span>
        </label>)}</div>
      </fieldset>
      {BOTOES_POSSIVEIS[tipo].length ? <fieldset className="etapa">
        <legend className="etapa__titulo">Respostas do cliente</legend>
        <div className="alternativas">{BOTOES_POSSIVEIS[tipo].map(b => <label className="alternativa" key={b}>
          <input name="botoes" type="checkbox" value={b} />
          <span className="alternativa__corpo"><span className="alternativa__nome">{ROTULO_DO_BOTAO[b]}</span><span className="alternativa__nota">{EFEITO_DO_BOTAO[b]}</span>
            {RESSALVA_DO_BOTAO[tipo]?.[b] ? <span className="alternativa__nota alternativa__nota--risco">{RESSALVA_DO_BOTAO[tipo]?.[b]}</span> : null}
          </span>
        </label>)}</div>
      </fieldset> : null}
    </details>
    <Enviar />
  </form>;
}
