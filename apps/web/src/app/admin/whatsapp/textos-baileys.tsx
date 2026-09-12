'use client';
import { useActionState, useState } from 'react';
import { TIPOS_DE_NOTIFICACAO, VARIAVEIS_DO_AVISO, corpoComExemplos, nomeDoAviso, type TipoDeNotificacao } from '@barbearia/core';
import type { TemplateNaTelaDoAdmin } from '@/lib/admin-api';
import { acaoSalvarTextoBaileys } from '../acoes';
import styles from './conexao.module.css';

function Editor({ mensagem }: { readonly mensagem?: TemplateNaTelaDoAdmin }) {
  const [estado, salvar, pendente] = useActionState(acaoSalvarTextoBaileys, { erro: null });
  const [titulo, setTitulo] = useState(mensagem?.titulo ?? '');
  const [habilitado, setHabilitado] = useState(mensagem?.pronto === false ? '0' : '1');
  const [tipo, setTipo] = useState<TipoDeNotificacao>((mensagem?.tipo ?? 'retorno') as TipoDeNotificacao);
  const [corpo, setCorpo] = useState(mensagem?.corpo ?? 'Olá {{1}}! Já estamos com saudade. Vamos marcar seu próximo corte na {{2}}?');
  const prefixo = mensagem?.id ?? 'nova';
  return <form action={salvar} className="formulario">
    {mensagem ? <input name="id" type="hidden" value={mensagem.id} /> : null}
    <div className="ui-field"><label className="ui-field__label" htmlFor={`titulo-${prefixo}`}>Nome da mensagem</label>
      <input className="ui-field__input" id={`titulo-${prefixo}`} name="titulo" value={titulo} onChange={e => setTitulo(e.target.value)} maxLength={80} required placeholder="Ex.: Convite para voltar" /></div>
    <div className="ui-field"><label className="ui-field__label" htmlFor={`tipo-${prefixo}`}>Quando usar</label>
      <select className="ui-field__input" id={`tipo-${prefixo}`} name="tipo" value={tipo} onChange={e => setTipo(e.target.value as TipoDeNotificacao)}>
        {TIPOS_DE_NOTIFICACAO.filter(t => t !== 'senha_de_acesso' && (!mensagem || t === mensagem.tipo)).map(t => <option value={t} key={t}>{nomeDoAviso(t)}</option>)}
      </select></div>
    <div className="ui-field"><label className="ui-field__label" htmlFor={`corpo-${prefixo}`}>Texto</label>
      <textarea className="ui-field__input" id={`corpo-${prefixo}`} name="corpo" value={corpo} onChange={e => setCorpo(e.target.value)} rows={5} minLength={5} maxLength={3500} required />
      <p className="ui-field__hint">{VARIAVEIS_DO_AVISO[tipo].map((v, i) => `{{${i + 1}}}: ${v}`).join(' · ')}</p></div>
    <details className="dobra"><summary className="dobra__titulo">Prévia com dados de exemplo</summary>
      <p className={styles.previa}>{corpoComExemplos(tipo, corpo)}</p>
      <p className="painel__nota">Promoções incluem a instrução para sair da lista. Avisos de horário explicam como responder.</p>
    </details>
    <div className="ui-field"><label className="ui-field__label" htmlFor={`ativo-${prefixo}`}>Uso da mensagem</label>
      <select className="ui-field__input" id={`ativo-${prefixo}`} name="habilitado" value={habilitado} onChange={e => setHabilitado(e.target.value)}>
        <option value="1">Disponível para enviar</option><option value="0">Pausada</option>
      </select></div>
    <p role="alert" className="painel__nota">{estado.erro}</p>
    <button className="ui-button ui-button--primary" type="submit" disabled={pendente}>{pendente ? 'Salvando…' : 'Salvar mensagem'}</button>
  </form>;
}

export function TextosBaileys({ mensagens }: { readonly mensagens: readonly TemplateNaTelaDoAdmin[] }) {
  return <section className="cartao-balcao" id="mensagens-baileys">
    <h2 className="cartao-balcao__titulo">Mensagens pelo Baileys</h2>
    <p className="painel__nota">Salve os textos e escolha quais usar nas campanhas e automações. Eles não precisam de aprovação da Meta.</p>
    <p className="painel__nota"><a href="/admin/campanhas">Campanhas: enviar para uma lista</a> · <a href="/admin/automacoes">Automações: enviar quando algo acontecer</a></p>
    {mensagens.length ? <ul className="lista-cadastro">{mensagens.map(t => <li key={t.id}>
      <details className="dobra"><summary className="dobra__titulo">{t.titulo ?? nomeDoAviso(t.tipo as TipoDeNotificacao)} · {t.pronto ? 'Disponível' : 'Pausada'}</summary>
        <Editor mensagem={t} />
      </details>
    </li>)}</ul> : <p className="painel__nota">Crie a primeira mensagem para habilitar os avisos desta conexão.</p>}
    <details className="dobra" open={mensagens.length === 0}><summary className="dobra__titulo">Criar mensagem</summary><Editor /></details>
  </section>;
}
