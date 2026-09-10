import { redirect } from 'next/navigation';
import { painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { filaManualNaApi, textosManuaisNaApi, configuracoesManuaisNaApi } from '@/lib/admin-api';
import { secao } from '../../secoes';
import { PainelManual } from './painel';
export const metadata = { title: 'WhatsApp manual', robots: { index: false, follow: false } };
export default async function WhatsAppManual({ searchParams }: { searchParams: Promise<{ antes?: string; visao?: string }> }) {
  const token = await lerSessaoGestor(); if (!token) redirect('/admin/entrar');
  const estado = await painelOuDesvio(token); const query = await searchParams;
  const podeOperar = podeNaTela(estado, 'marketing.send') && podeNaTela(estado, 'customers.view');
  if (!podeOperar) return <main className="ui-container painel__conteudo" {...secao('whatsapp')}><h1 className="painel__titulo">WhatsApp manual</h1><p>Seu acesso precisa permitir campanhas e consulta de clientes para operar esta fila.</p></main>;
  const [fila, textos, configuracoes] = await Promise.all([filaManualNaApi(token, query.antes, query.visao === 'historico' ? 'historico' : 'pendentes'), textosManuaisNaApi(token), configuracoesManuaisNaApi(token)]);
  return <main className="ui-container painel__conteudo" {...secao('whatsapp')}>
    <a href="/admin/whatsapp" className="ui-button ui-button--ghost">← Opções de envio do WhatsApp</a>
    <h1 className="painel__titulo">WhatsApp manual</h1>
    <p className="painel__sub">Sem envio automático: o sistema organiza a fila. Você abre a conversa, envia no seu WhatsApp e confirma aqui.</p>
    <p className="painel__nota">Esta fila é independente. Entrar aqui não pausa envios automáticos já configurados em <a href="/admin/campanhas">Campanhas</a> ou <a href="/admin/automacoes">Automações</a>.</p>
    {fila.ok && textos.ok && configuracoes.ok ? <PainelManual historico={query.visao === 'historico'} podeAssumir={podeNaTela(estado, 'whatsapp.manage')} itens={fila.dados.itens} proximo={fila.dados.proximo} textos={textos.dados.textos} configuracoes={configuracoes.dados} /> :
      <div className="ui-alert ui-alert--warning" role="alert">{!fila.ok ? fila.message : !textos.ok ? textos.message : !configuracoes.ok ? configuracoes.message : ''} <a href="/admin/whatsapp/manual">Tentar novamente</a></div>}
  </main>;
}
