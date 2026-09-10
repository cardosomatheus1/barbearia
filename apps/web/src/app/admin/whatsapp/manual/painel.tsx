'use client';
import { useActionState, useEffect, useState, useTransition } from 'react';
import { corpoComExemplos, GATILHOS_COM_VARREDURA, LIMIAR_DO_GATILHO, LIMIAR_MINIMO, FILTROS_DE_CAMPANHA, rotuloDoFiltro, OBJETIVOS, ROTULO_DO_OBJETIVO, SEGMENTOS, ROTULO_DO_SEGMENTO, ROTULO_DO_GATILHO, type Gatilho } from '@barbearia/core';
import type { ConfiguracoesManuais, ItemManual, TextoManual } from '@/lib/admin-api';
import { acaoAbrirManual, acaoConcluirManual, acaoConfigurarManual, acaoEstadoAutomacaoManual } from '../../acoes';
import styles from './painel.module.css';

function MensagemNaFila({ item, podeAssumir }: { item: ItemManual; podeAssumir: boolean }) {
  const [conteudo, setConteudo] = useState<{ url: string; texto: string; telefone: string } | null>(null);
  const [erro, setErro] = useState<string | null>(null); const [pendente, iniciar] = useTransition();
  const [confirmacao, setConfirmacao] = useState<'enviado' | 'liberar' | 'descartar' | 'optout' | 'assumir' | null>(null);
  const finalizado = item.estado === 'enviado' || item.estado === 'descartado';
  const emAtendimento = item.estado === 'em_atendimento' || conteudo !== null;
  const minhaReserva = item.minhaReserva || conteudo !== null;
  function abrir() { iniciar(async () => { setErro(null); const r = await acaoAbrirManual(item.id); if (r.ok) setConteudo(r.dados); else setErro(r.message); }); }
  function concluir() { if (!confirmacao) return; const acao = confirmacao; iniciar(async () => {
    setErro(null); const r = await acaoConcluirManual(item.id, acao); if (r.ok) { setConteudo(null); setConfirmacao(null); } else setErro(r.message);
  }); }
  return <li className={styles.item}>
    <h3><a href={`/admin/cliente/${item.clienteId}`}>{item.cliente}</a></h3><p className="painel__nota">{item.origem} · {item.tipo === 'campanha' ? 'Campanha' : 'Automação'}</p>
    <p>{item.estado === 'enviado' ? `Envio confirmado por ${item.enviadoPor ?? 'operador'}` : item.estado === 'descartado' ? 'Descartada, sem envio confirmado' : item.estado === 'em_atendimento' ? `Em atendimento por ${item.operador ?? 'operador'}` : 'Aguardando operador'}</p>
    {item.enviadoEm ? <p className="painel__nota">Registrado em <time dateTime={item.enviadoEm}>{new Date(item.enviadoEm).toLocaleString('pt-BR', { timeZone: item.fuso })}</time>. Confirmação manual, sem informação de entrega ou leitura.</p> : null}
    {!finalizado ? <>
      {!item.disponivel ? <p className="ui-alert ui-alert--warning">O cliente não aceita promoções ou a configuração foi pausada. Você pode descartar o item.</p> : null}
      {conteudo ? <div className={styles.conteudo}>
        <p><strong>1. Envie no WhatsApp</strong></p><p>{conteudo.telefone}</p><p className={styles.previa}>{conteudo.texto}</p>
        <a className="ui-button ui-button--primary" href={conteudo.url} target="_blank" rel="noopener noreferrer">Abrir WhatsApp com a mensagem</a>
        <p className="painel__nota">Confira o número conectado no WhatsApp. O texto está preenchido; clique em Enviar lá. Você pode reabrir este link se a aba não abriu.</p>
        <p><strong>2. Volte e registre o que aconteceu</strong></p>
      </div> : <button className="ui-button ui-button--primary" disabled={pendente || !item.disponivel || (emAtendimento && !minhaReserva)} onClick={abrir}>{pendente ? 'Preparando…' : item.estado === 'em_atendimento' ? 'Retomar conversa' : 'Preparar envio'}</button>}
      <div className={styles.acoes}>
        {emAtendimento && !minhaReserva && podeAssumir ? <button className="ui-button ui-button--ghost" disabled={pendente} onClick={() => setConfirmacao('assumir')}>Assumir atendimento</button> : null}
        {emAtendimento && minhaReserva ? <button className="ui-button ui-button--primary" disabled={pendente} onClick={() => setConfirmacao('enviado')}>Marcar como enviado</button> : null}
        {emAtendimento && minhaReserva ? <button className="ui-button ui-button--ghost" disabled={pendente} onClick={() => setConfirmacao('liberar')}>Não enviei, liberar</button> : null}

      </div>
      {!emAtendimento || minhaReserva ? <details className="dobra"><summary className="dobra__titulo">Outras ações</summary><div className={styles.acoes}>
        <button className="ui-button ui-button--ghost" disabled={pendente} onClick={() => setConfirmacao('descartar')}>Descartar</button>
        <button className="ui-button ui-button--ghost" disabled={pendente} onClick={() => setConfirmacao('optout')}>Cliente pediu para parar</button>
      </div></details> : null}
      {confirmacao ? <div className="ui-alert ui-alert--warning" role="group" aria-label="Confirmar ação">
        <p>{confirmacao === 'assumir' ? 'Confira com o operador anterior se ele já enviou a mensagem antes de assumir. A reserva muda para você; o envio continua sem confirmação.' : confirmacao === 'enviado' ? 'Confirme somente se você clicou em Enviar no WhatsApp. Abrir a conversa não envia a mensagem.' : confirmacao === 'liberar' ? 'Feche a conversa aberta e confirme que nada foi enviado. O item poderá ser usado por outro operador.' : confirmacao === 'optout' ? 'Registrar o pedido do cliente para não receber mais promoções e descartar esta mensagem?' : 'Descartar esta mensagem sem registrar envio? Ela não será enviada por esta fila.'}</p>
        <div className={styles.acoes}><button className="ui-button ui-button--primary" disabled={pendente} onClick={concluir}>{confirmacao === 'enviado' ? 'Sim, eu enviei' : 'Confirmar'}</button><button className="ui-button ui-button--ghost" onClick={() => setConfirmacao(null)}>Voltar</button></div>
      </div> : null}
    </> : null}
    {erro ? <p role="alert" className="ui-alert ui-alert--warning">{erro}</p> : null}
  </li>;
}

function FormularioMensagem({ texto }: { texto?: TextoManual }) {
  const [estado, salvar, pendente] = useActionState(acaoConfigurarManual, { erro: null, sucesso: null });
  const sufixo = texto?.id ?? 'novo';
  const [titulo, setTitulo] = useState(texto?.titulo ?? '');
  const [corpo, setCorpo] = useState(texto?.corpo ?? 'Olá {{1}}! Vamos marcar seu próximo corte na {{2}}?');
  const [habilitado, setHabilitado] = useState(texto?.habilitado ?? true);
  return <form action={salvar} className="formulario">
    <input name="destino" type="hidden" value="textos" />{texto ? <input name="id" type="hidden" value={texto.id} /> : null}
    <div className="ui-field"><label className="ui-field__label" htmlFor={`titulo-${sufixo}`}>Nome da mensagem</label><input className="ui-field__input" id={`titulo-${sufixo}`} name="titulo" maxLength={80} value={titulo} onChange={e => setTitulo(e.target.value)} required placeholder="Convite para voltar" /></div>
    <div className="ui-field"><label className="ui-field__label" htmlFor={`texto-${sufixo}`}>Texto que o cliente recebe</label><textarea className="ui-field__input" id={`texto-${sufixo}`} name="corpo" minLength={5} maxLength={3500} rows={4} required value={corpo} onChange={e => setCorpo(e.target.value)} /><p className="ui-field__hint">{'{{1}}: nome do cliente · {{2}}: nome da barbearia. A orientação para sair das promoções é incluída ao preparar o envio.'}</p></div>
    <div><p className="ui-field__label">Exemplo da mensagem</p><p className={styles.previa}>{corpoComExemplos('retorno', corpo)}</p></div>
    <label className="marca"><input name="habilitado" type="checkbox" checked={habilitado} onChange={e => setHabilitado(e.target.checked)} /><span>Disponível para usar</span></label>
    <button className="ui-button ui-button--primary" disabled={pendente} type="submit">Salvar mensagem</button>
    {estado.erro ? <p role="alert">{estado.erro}</p> : null}{estado.sucesso ? <p role="status">{estado.sucesso}</p> : null}
  </form>;
}
function Configurar({ tipo, textos }: { tipo: 'campanhas' | 'automacoes'; textos: readonly TextoManual[] }) {
  const [estado, salvar, pendente] = useActionState(acaoConfigurarManual, { erro: null, sucesso: null });
  const [nome, setNome] = useState('');
  const [dias, setDias] = useState('30');
  const [requestId, setRequestId] = useState('');
  useEffect(() => { setRequestId(crypto.randomUUID()); }, []);
  useEffect(() => { if (estado.sucesso) setRequestId(crypto.randomUUID()); }, [estado]);
  const [publico, setPublico] = useState(tipo === 'campanhas' ? 'todos' : 'sem_retorno');
  const [mensagemId, setMensagemId] = useState(textos.find(t => t.habilitado)?.id ?? '');
  const mensagem = textos.find(t => t.id === mensagemId);
  const numero = tipo === 'campanhas' ? publico === 'inativos' : LIMIAR_DO_GATILHO[publico as Gatilho] !== null;
  const [diaSemana, setDiaSemana] = useState('1'); const [hora, setHora] = useState('9');
  const [atraso, setAtraso] = useState('0'); const [janela, setJanela] = useState('7');
  const [objetivo, setObjetivo] = useState('agendamento'); const [segmento, setSegmento] = useState('');
  return <form action={salvar} className="formulario">
    <input name="destino" type="hidden" value={tipo} /><input name="requestId" type="hidden" value={requestId} />
    <div className="ui-field"><label className="ui-field__label" htmlFor={`nome-${tipo}`}>Nome da {tipo === 'campanhas' ? 'campanha' : 'regra'}</label><input className="ui-field__input" id={`nome-${tipo}`} name="nome" required maxLength={80} value={nome} onChange={e => setNome(e.target.value)} placeholder="Convite para voltar" /></div>
    <div className="ui-field"><label className="ui-field__label" htmlFor={`publico-${tipo}`}>{tipo === 'campanhas' ? 'Quem vai para a fila' : 'Quando preparar a mensagem'}</label>
      <select className="ui-field__input" id={`publico-${tipo}`} name={tipo === 'campanhas' ? 'filtro' : 'gatilho'} value={publico} onChange={e => { setPublico(e.target.value); setDias(e.target.value === 'aniversario' || e.target.value === 'assinatura_vencendo' ? '0' : e.target.value.startsWith('avaliacao') ? '4' : e.target.value === 'pacote_acabando' ? '1' : '30'); }}>
        {tipo === 'campanhas' ? FILTROS_DE_CAMPANHA.map(f => <option value={f} key={f}>{rotuloDoFiltro(f)}</option>) : GATILHOS_COM_VARREDURA.map(g => <option value={g} key={g}>{ROTULO_DO_GATILHO[g]}</option>)}
      </select>
    </div>
    {numero ? <div className="ui-field"><label className="ui-field__label" htmlFor={`dias-${tipo}`}>{tipo === 'campanhas' ? 'Quantos dias sem vir' : LIMIAR_DO_GATILHO[publico as Gatilho]}</label><input className="ui-field__input" name="dias" id={`dias-${tipo}`} type="number" min={tipo === 'campanhas' ? 1 : LIMIAR_MINIMO[publico as Gatilho]} max={365} value={dias} onChange={e => setDias(e.target.value)} required /></div> : null}
    {tipo === 'campanhas' && publico === 'celula_fria' ? <>
      <div className="ui-field"><label className="ui-field__label" htmlFor="manual-dia-semana">Dia em que o cliente costuma vir</label><select className="ui-field__input" id="manual-dia-semana" name="diaSemana" value={diaSemana} onChange={e => setDiaSemana(e.target.value)}>{['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'].map((d,i) => <option key={d} value={i}>{d}</option>)}</select></div>
      <div className="ui-field"><label className="ui-field__label" htmlFor="manual-hora">Hora em que costuma vir (0 a 23)</label><input className="ui-field__input" type="number" id="manual-hora" name="hora" min={0} max={23} value={hora} onChange={e => setHora(e.target.value)} required /></div>
    </> : null}
    <div className="ui-field"><label className="ui-field__label" htmlFor={`mensagem-${tipo}`}>Mensagem</label><select className="ui-field__input" name="templateId" id={`mensagem-${tipo}`} required value={mensagemId} onChange={e => setMensagemId(e.target.value)}><option value="">Escolha uma mensagem</option>{textos.filter(t => t.habilitado).map(t => <option key={t.id} value={t.id}>{t.titulo}</option>)}</select></div>
    {mensagem ? <div><p className="ui-field__label">Exemplo da mensagem</p><p className={styles.previa}>{corpoComExemplos('retorno', mensagem.corpo)}</p></div> : <p>Salve uma mensagem abaixo para continuar.</p>}
    <details className="dobra"><summary className="dobra__titulo">Ajustar público e acompanhamento</summary>
      {tipo === 'automacoes' ? <>
        <div className="ui-field"><label className="ui-field__label" htmlFor="manual-segmento">Restringir o gatilho a um grupo</label><select className="ui-field__input" id="manual-segmento" name="publico" value={segmento} onChange={e => setSegmento(e.target.value)}><option value="">Todos que cruzarem o gatilho</option>{SEGMENTOS.map(seg => <option key={seg} value={seg}>{ROTULO_DO_SEGMENTO[seg]}</option>)}</select></div>
        <div className="ui-field"><label className="ui-field__label" htmlFor="manual-atraso">Esperar quantos minutos após o gatilho</label><input className="ui-field__input" id="manual-atraso" name="atraso" type="number" min={0} max={10080} value={atraso} onChange={e => setAtraso(e.target.value)} /></div>
        <div className="ui-field"><label className="ui-field__label" htmlFor="manual-objetivo">O que acompanhar após o envio</label><select className="ui-field__input" id="manual-objetivo" name="objetivo" value={objetivo} onChange={e => setObjetivo(e.target.value)}>{OBJETIVOS.map(o => <option value={o} key={o}>{ROTULO_DO_OBJETIVO[o]}</option>)}</select></div>
      </> : null}
      <div className="ui-field"><label className="ui-field__label" htmlFor={`manual-janela-${tipo}`}>Prazo de acompanhamento em dias</label><input className="ui-field__input" id={`manual-janela-${tipo}`} name="janela" type="number" min={1} max={90} value={janela} onChange={e => setJanela(e.target.value)} /></div>
    </details>
    <p className="painel__nota">{tipo === 'campanhas' ? 'A lista de clientes é preparada agora. Cada envio depende de um operador.' : 'O sistema verifica os clientes a cada hora e prepara a fila. Cada envio depende de um operador.'} Apenas clientes com consentimento, entre 8h e 21h, uma promoção por dia e até quatro em 30 dias.</p>
    <button className="ui-button ui-button--primary" type="submit" disabled={pendente || !mensagem || !requestId}>{pendente ? 'Salvando…' : tipo === 'campanhas' ? 'Preparar campanha na fila' : 'Ativar preparação da fila'}</button>
    {estado.erro ? <p role="alert">{estado.erro}</p> : null}{estado.sucesso ? <p role="status">{estado.sucesso}</p> : null}
  </form>;
}
function EstadoAutomacao({ id, ativa }: { id: string; ativa: boolean }) {
  const [erro, setErro] = useState<string | null>(null); const [pendente, iniciar] = useTransition();
  return <><button className="ui-button ui-button--ghost" disabled={pendente} onClick={() => iniciar(async () => { const r = await acaoEstadoAutomacaoManual(id, !ativa); setErro(r.ok ? null : r.message); })}>{ativa ? 'Pausar preparação' : 'Retomar preparação'}</button>{erro ? <p role="alert">{erro}</p> : null}</>;
}
export function PainelManual({ itens, proximo, textos, configuracoes, historico, podeAssumir }: { historico: boolean; podeAssumir: boolean; itens: readonly ItemManual[]; proximo: string | null; textos: readonly TextoManual[]; configuracoes: ConfiguracoesManuais }) {
  const [aba, setAba] = useState<'fila' | 'campanhas' | 'automacoes'>('fila');
  const [criandoMensagem, setCriandoMensagem] = useState(textos.length === 0);
  const exibidos = itens.filter(i => historico ? ['enviado','descartado'].includes(i.estado) : ['pendente','em_atendimento'].includes(i.estado));
  return <>
    <nav className={styles.abas} aria-label="WhatsApp manual">{(['fila','campanhas','automacoes'] as const).map(a => <button className={`ui-button ${aba === a ? 'ui-button--primary' : 'ui-button--ghost'}`} key={a} onClick={() => setAba(a)} aria-current={aba === a ? 'page' : undefined}>{a === 'fila' ? 'Fila' : a === 'campanhas' ? 'Campanhas' : 'Lembretes'}</button>)}</nav>
    {aba === 'fila' ? <section className="cartao-balcao"><h2 className="cartao-balcao__titulo">{historico ? 'Histórico manual' : 'Mensagens para enviar'}</h2>
      <p className="painel__nota">Prepare uma conversa, envie no WhatsApp e volte para marcar como enviado. Nenhuma mensagem sai automaticamente.</p>
      <div className={styles.acoes}><a className="ui-button ui-button--ghost" href={historico ? '/admin/whatsapp/manual' : '/admin/whatsapp/manual?visao=historico'}>{historico ? 'Ver pendentes' : 'Ver histórico'}</a><a className="ui-button ui-button--ghost" href="/admin/whatsapp/manual">Atualizar fila</a></div>
      {exibidos.length ? <ul className={styles.lista}>{exibidos.map(i => <MensagemNaFila key={i.id} item={i} podeAssumir={podeAssumir} />)}</ul> : <p>{historico ? 'Nenhuma mensagem finalizada nesta página.' : 'Nenhuma mensagem pendente nesta página. Abra Campanhas para preparar uma lista ou Lembretes para criar uma regra de preparação.'}</p>}
      {proximo ? <a className="ui-button ui-button--ghost" href={`/admin/whatsapp/manual?visao=${historico ? 'historico' : 'pendentes'}&antes=${encodeURIComponent(proximo)}`}>Mais mensagens</a> : null}
      <details className="dobra"><summary className="dobra__titulo">Se o cliente pedir para parar</summary><p>As respostas chegam no seu WhatsApp. Use “Cliente pediu para parar” no item da fila ou retire o consentimento na ficha do cliente. O sistema não lê as conversas do envio manual.</p></details>
    </section> : <>
      <section className="cartao-balcao"><h2 className="cartao-balcao__titulo">Mensagens manuais</h2><p className="painel__nota">Textos próprios deste modo, sem aprovação da Meta. Alterações valem para os próximos itens preparados.</p>
        {textos.map(t => <details className="dobra" key={t.id}><summary className="dobra__titulo">{t.titulo} · {t.habilitado ? 'Disponível' : 'Pausada'}</summary><FormularioMensagem texto={t} /></details>)}
        <details className="dobra" open={criandoMensagem} onToggle={e => setCriandoMensagem(e.currentTarget.open)}><summary className="dobra__titulo">Criar mensagem</summary><FormularioMensagem /></details>
      </section>
      <section className="cartao-balcao"><h2 className="cartao-balcao__titulo">{aba === 'campanhas' ? 'Campanhas manuais' : 'Lembretes para enviar'}</h2>
        {aba === 'campanhas' ? configuracoes.campanhas.map(c => <div className={styles.item} key={c.id}><h3>{c.nome}</h3><p>{c.mensagem}</p><p>{c.enviados} envios confirmados · {c.total - c.enviados - c.descartados} pendentes · {c.descartados} descartados</p></div>) : configuracoes.automacoes.map(a => <div className={styles.item} key={a.id}><h3>{a.nome} · {a.ativa ? 'Preparando fila' : 'Pausado'}</h3><p>{ROTULO_DO_GATILHO[a.gatilho as Gatilho] ?? a.gatilho} · {a.mensagem}</p>{a.limiar !== null && LIMIAR_DO_GATILHO[a.gatilho as Gatilho] ? <p>{LIMIAR_DO_GATILHO[a.gatilho as Gatilho]}: {a.limiar}</p> : null}<p>{a.enviados} envios confirmados pelo operador · {a.alcancados} objetivos alcançados</p><EstadoAutomacao id={a.id} ativa={a.ativa} /></div>)}
        <p className="painel__nota">{aba === 'campanhas' ? 'Prepare uma lista de clientes uma vez. Você envia cada mensagem pelo seu WhatsApp.' : 'Escolha quando preparar mensagens, como no aniversário do cliente. O sistema organiza a fila; você precisa abrir e enviar cada conversa. Não há envio automático.'}</p><h3>{aba === 'campanhas' ? 'Nova campanha' : 'Novo lembrete'}</h3>{textos.some(t => t.habilitado) ? <Configurar key={aba} tipo={aba} textos={textos} /> : <p>Primeiro, salve uma mensagem disponível na seção acima. Depois escolha os clientes.</p>}
      </section>

    </>}
  </>;
}
