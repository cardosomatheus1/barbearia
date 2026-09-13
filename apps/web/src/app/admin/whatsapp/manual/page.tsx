import { redirect } from 'next/navigation';
import { painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { filaManualNaApi, textosManuaisNaApi, configuracoesManuaisNaApi } from '@/lib/admin-api';
import { acaoSair } from '../../acoes';
import { FalhaDaLeitura } from '../../falha-da-leitura';
import { secao } from '../../secoes';
import { PainelManual } from './painel';
export const metadata = { title: 'Mensagens para enviar', robots: { index: false, follow: false } };
export default async function WhatsAppManual({ searchParams }: { searchParams: Promise<{ antes?: string; visao?: string }> }) {
  const token = await lerSessaoGestor(); if (!token) redirect('/admin/entrar');
  const estado = await painelOuDesvio(token); const query = await searchParams;
  const podeOperar = podeNaTela(estado, 'marketing.send') && podeNaTela(estado, 'customers.view');
  if (!podeOperar) return <main className="ui-container painel__conteudo" {...secao('whatsapp-manual')}>      <header className="painel__topo">
        <a className="painel__marca" href="/admin/dia">
          ← {estado.businessName}
        </a>
        <form action={acaoSair}>
          <button className="ui-button ui-button--ghost painel__sair" type="submit">
            Sair
          </button>
        </form>
      </header>
<h1 className="painel__titulo">Mensagens para enviar</h1><FalhaDaLeitura code="forbidden" href="/admin/whatsapp/manual" oque="a fila de envio" /></main>;
  const [fila, textos, configuracoes] = await Promise.all([filaManualNaApi(token, query.antes, query.visao === 'historico' ? 'historico' : 'pendentes'), textosManuaisNaApi(token), configuracoesManuaisNaApi(token)]);
  return <main className="ui-container painel__conteudo" {...secao('whatsapp-manual')}>
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
    <a href="/admin/whatsapp" className="ui-button ui-button--ghost">← Opções de envio do WhatsApp</a>
    <h1 className="painel__titulo">Mensagens para enviar</h1>
    <p className="painel__sub">Sem envio automático: o sistema organiza a fila. Você abre a conversa, envia no seu WhatsApp e confirma aqui.</p>
    <p className="painel__nota">Esta fila é independente. Entrar aqui não pausa envios automáticos já configurados em <a href="/admin/campanhas">Campanhas</a> ou <a href="/admin/automacoes">Automações</a>.</p>
    {fila.ok && textos.ok && configuracoes.ok ? <PainelManual historico={query.visao === 'historico'} podeAssumir={podeNaTela(estado, 'whatsapp.manage')} itens={fila.dados.itens} proximo={fila.dados.proximo} textos={textos.dados.textos} configuracoes={configuracoes.dados} /> :
      <div className="ui-alert ui-alert--warning" role="alert">{!fila.ok ? fila.message : !textos.ok ? textos.message : !configuracoes.ok ? configuracoes.message : ''} <a href="/admin/whatsapp/manual">Tentar novamente</a></div>}
  </main>;
}
