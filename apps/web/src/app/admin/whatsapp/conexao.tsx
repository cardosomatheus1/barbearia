'use client';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import qrcode from 'qrcode-generator';
import type { ConexaoWhatsAppNaTela } from '@/lib/admin-api';
import { acaoOperarBaileys, acaoSelecionarConexao } from '../acoes';
import styles from './conexao.module.css';

const ESTADO: Record<ConexaoWhatsAppNaTela['baileys']['estado'], string> = {
  desconectado: 'Número desconectado', aguardando_qr: 'Conecte pelo celular', conectando: 'Conectando o número',
  conectado: 'Número conectado', reconectando: 'Reconectando o número', novo_qr: 'Conecte novamente pelo celular', erro: 'Conexão interrompida',
};
const MOTIVO: Record<string, string> = {
  sessao_substituida: 'O WhatsApp encerrou esta sessão porque outra conexão assumiu o número.',
  numero_ou_sessao_indisponivel: 'Não foi possível vincular este número. Confira se ele já está conectado a outra unidade.',
  conta_indisponivel: 'O WhatsApp recusou a conexão. Confira a conta no celular.',
  credencial_nao_persistida: 'A conexão foi interrompida ao salvar a sessão. Tente reconectar.',
  qr_expirado: 'O prazo de conexão terminou. Gere outro QR para continuar.',
};

export function ConexaoWhatsApp({ inicial, modo, podeMexer }: { readonly inicial: ConexaoWhatsAppNaTela; readonly modo: 'meta' | 'baileys'; readonly podeMexer: boolean }) {
  const [dados, setDados] = useState(inicial);
  const [erro, setErro] = useState(''); const [agora, setAgora] = useState(Date.now());
  const [pendente, transicao] = useTransition(); const router = useRouter();
  useEffect(() => { setDados(inicial); }, [inicial]);
  async function atualizar(signal?: AbortSignal) {
    const r = await fetch('/admin/whatsapp/conexao', { cache: 'no-store', ...(signal ? { signal } : {}) });
    if (!r.ok) throw new Error('Não foi possível conferir a conexão. Tente atualizar.');
    const estado = await r.json() as ConexaoWhatsAppNaTela;
    setDados(estado); setErro('');
  }
  useEffect(() => {
    if (dados.canal !== 'baileys' || ['desconectado','novo_qr','erro'].includes(dados.baileys.estado)) return;
    let vivo = true; const controller = new AbortController();
    const timer = setInterval(() => {
      void atualizar(controller.signal).catch(() => { if (vivo) setErro('A conexão não pôde ser atualizada. Tente novamente.'); });
    }, dados.baileys.estado === 'conectado' ? 10_000 : 3_000);
    return () => { vivo = false; controller.abort(); clearInterval(timer); };
  }, [dados.canal, dados.baileys.estado]);
  useEffect(() => {
    if (!dados.baileys.qr) return;
    const t = setInterval(() => setAgora(Date.now()), 1_000); return () => clearInterval(t);
  }, [dados.baileys.qr]);
  const qrValido = dados.baileys.qr && dados.baileys.qrExpiraEm && new Date(dados.baileys.qrExpiraEm).getTime() > agora;
  const imagem = useMemo(() => {
    if (!dados.baileys.qr) return null;
    const qr = qrcode(0, 'M'); qr.addData(dados.baileys.qr); qr.make(); return qr.createDataURL(5, 4);
  }, [dados.baileys.qr]);
  function operar(acao: 'parear' | 'reconectar' | 'desconectar') {
    transicao(async () => {
      try {
        const r = await acaoOperarBaileys(acao); if (!r.ok) { setErro(r.message); return; }
        await atualizar(); router.refresh();
      } catch { setErro('Não foi possível alterar a conexão. Tente novamente.'); }
    });
  }
  const b = dados.baileys;
  if (modo === 'meta' && dados.canal === modo) return null;
  return <section className="cartao-balcao" id="configuracao" aria-busy={pendente}>
    <h2 className="cartao-balcao__titulo">{modo === 'meta' ? 'Meta · conexão oficial' : 'Baileys · conexão por QR Code'}</h2>
    {modo !== dados.canal ? <>
      <p className="painel__nota">Você está consultando esta opção. A conexão escolhida para os envios automáticos continua sendo {dados.canal === 'meta' ? 'Meta' : 'Baileys'}. Trocar a conexão muda as mensagens disponíveis nas campanhas e automações; revise-as depois.</p>
      {podeMexer ? <button type="button" className="ui-button ui-button--primary" disabled={pendente || (modo === 'baileys' && !b.disponivel)} onClick={() => transicao(async () => {
        try { const r = await acaoSelecionarConexao(modo); if (!r.ok) setErro(r.message); else { await atualizar(); router.refresh(); } }
        catch { setErro('Não foi possível trocar a conexão. Tente novamente.'); }
      })}>{modo === 'meta' ? 'Usar conexão Meta' : 'Usar conexão Baileys'}</button> : null}
    </> : <p className="painel__nota">Esta é a conexão escolhida para os envios automáticos desta unidade.</p>}
    {modo === 'baileys' ? <>
      <p className="ui-alert ui-alert--warning"><strong>Há risco de bloqueio ou banimento do número.</strong> O Baileys é gratuito e não oficial. Não há tarifa de envio da API Meta, mas as regras do WhatsApp continuam valendo. Recomendamos a Meta para a operação da barbearia.</p>
      {!b.disponivel ? <p className="painel__nota">Baileys indisponível nesta instalação. Peça ao suporte para habilitar a conexão por QR Code.</p> : null}
      <ol><li>Escolha a conexão Baileys e gere o QR Code.</li><li>No celular, abra WhatsApp → Aparelhos conectados → Conectar aparelho.</li><li>Escaneie o QR e aguarde “Número conectado”. Depois salve suas mensagens e configure os envios.</li></ol>
    </> : null}
    {erro ? <p role="alert" className="ui-alert ui-alert--danger">{erro}</p> : null}
    {modo === 'baileys' && dados.canal === modo ? <>
      <div className={styles.estado} role="status"><strong>{ESTADO[b.estado]}</strong>{b.numero ? <p>{b.numero}</p> : null}</div>
      {b.motivo && MOTIVO[b.motivo] ? <p className="painel__nota">{MOTIVO[b.motivo]}</p> : null}
      {qrValido && imagem ? <div className={styles.qr}>
        <p className="painel__nota">No WhatsApp do celular, abra Aparelhos conectados → Conectar aparelho e escaneie o QR.</p>
        {/* QR gerado localmente, sem serviço externo de imagens. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imagem} alt="QR para conectar o WhatsApp desta unidade" width={300} height={300} />
        <p className="painel__nota">O código se renova automaticamente. Não compartilhe esta tela durante a conexão.</p>
      </div> : b.estado === 'aguardando_qr' || b.estado === 'conectando' ? <p className="painel__nota">Preparando o QR. Aguarde a atualização da conexão.</p> : null}
      <div className={styles.acoes}>
        {['desconectado','novo_qr','erro'].includes(b.estado) ? <button className="ui-button ui-button--primary" type="button" disabled={pendente || !b.disponivel || !podeMexer} onClick={() => operar('parear')}>Gerar QR Code</button> : null}
        {b.estado === 'desconectado' ? <button className="ui-button ui-button--secondary" type="button" disabled={pendente || !b.disponivel || !podeMexer} onClick={() => operar('reconectar')}>Retomar conexão salva</button> : null}
        <button className="ui-button ui-button--ghost" type="button" disabled={pendente} onClick={() => { void atualizar().catch(() => setErro('Não foi possível atualizar.')); }}>Atualizar conexão</button>
      </div>
      {b.estado !== 'desconectado' ? <details className="dobra"><summary className="dobra__titulo">Desconectar ou trocar número</summary>
        <p className="painel__nota">Os envios param e será necessário conectar pelo celular novamente.</p>
        <button className="ui-button ui-button--ghost" type="button" disabled={pendente || !podeMexer} onClick={() => operar('desconectar')}>Desconectar número</button>
      </details> : null}
      <details className="dobra"><summary className="dobra__titulo">Como funcionam as mensagens por QR</summary>
        <p className="painel__nota">Os textos ficam disponíveis ao salvar, sem aprovação da Meta. Consentimento, saída das promoções e horários de envio continuam valendo. O Baileys usa aparelhos conectados e a conexão pode ser interrompida pelo WhatsApp. Ao desconectar com o aparelho offline, remova também o acesso em Aparelhos conectados no celular.</p>
      </details>
    </> : null}
  </section>;
}
