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

export function ConexaoWhatsApp({ inicial }: { readonly inicial: ConexaoWhatsAppNaTela }) {
  const [dados, setDados] = useState(inicial); const [canal, setCanal] = useState(inicial.canal);
  const [erro, setErro] = useState(''); const [agora, setAgora] = useState(Date.now());
  const [pendente, transicao] = useTransition(); const router = useRouter();
  useEffect(() => { setDados(inicial); }, [inicial]);
  // Atualizar o estado do número não desfaz a escolha ainda não salva. Depois
  // de desconectar, a resposta tardia do refresh podia apagar a seleção Meta.
  useEffect(() => { setCanal(inicial.canal); }, [inicial.canal]);
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
  return <section className="cartao-balcao" aria-busy={pendente}>
    <h2 className="cartao-balcao__titulo">Conexão do número</h2>
    <div className={styles.acoes}>
      <div className={`ui-field ${styles.campo}`}><label className="ui-field__label" htmlFor="canal-whatsapp">Como conectar</label>
        <select className="ui-field__input" id="canal-whatsapp" value={canal} disabled={pendente}
          onChange={e => setCanal(e.target.value === 'baileys' ? 'baileys' : 'meta')}>
          <option value="meta">Meta · conexão oficial</option><option value="baileys" disabled={!b.disponivel}>QR Code · Baileys</option>
        </select></div>
      {canal !== dados.canal ? <button type="button" className="ui-button ui-button--primary" disabled={pendente} onClick={() => transicao(async () => {
        try { const r = await acaoSelecionarConexao(canal); if (!r.ok) setErro(r.message); else { await atualizar(); router.refresh(); } }
        catch { setErro('Não foi possível trocar a conexão. Tente novamente.'); }
      })}>Usar esta conexão</button> : null}
    </div>
    {erro ? <p role="alert" className="ui-alert ui-alert--danger">{erro}</p> : null}
    {dados.canal === 'baileys' ? <>
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
        {['desconectado','novo_qr','erro'].includes(b.estado) ? <button className="ui-button ui-button--primary" type="button" disabled={pendente || !b.disponivel} onClick={() => operar('parear')}>Gerar QR Code</button> : null}
        {b.estado === 'desconectado' ? <button className="ui-button ui-button--secondary" type="button" disabled={pendente || !b.disponivel} onClick={() => operar('reconectar')}>Retomar conexão salva</button> : null}
        <button className="ui-button ui-button--ghost" type="button" disabled={pendente} onClick={() => { void atualizar().catch(() => setErro('Não foi possível atualizar.')); }}>Atualizar conexão</button>
      </div>
      {b.estado !== 'desconectado' ? <details className="dobra"><summary className="dobra__titulo">Desconectar ou trocar número</summary>
        <p className="painel__nota">Os envios param e será necessário conectar pelo celular novamente.</p>
        <button className="ui-button ui-button--ghost" type="button" disabled={pendente} onClick={() => operar('desconectar')}>Desconectar número</button>
      </details> : null}
      <details className="dobra"><summary className="dobra__titulo">Como funcionam as mensagens por QR</summary>
        <p className="painel__nota">Os textos ficam disponíveis ao salvar, sem aprovação da Meta. Consentimento, saída das promoções e horários de envio continuam valendo. O Baileys usa aparelhos conectados e a conexão pode ser interrompida pelo WhatsApp. Ao desconectar com o aparelho offline, remova também o acesso em Aparelhos conectados no celular.</p>
      </details>
    </> : null}
  </section>;
}
