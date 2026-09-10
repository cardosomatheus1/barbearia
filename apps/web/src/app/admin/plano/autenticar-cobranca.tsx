'use client';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { acaoAutenticarCobranca } from '../acoes';
import estilos from './autenticar-cobranca.module.css';

type Stripe = { confirmCardPayment: (secret: string, dados: { payment_method: string }) =>
  Promise<{ error?: { message?: string }; paymentIntent?: { status: string } }> };
type Janela = Window & { Stripe?: (chave: string) => Stripe };
let carregamento: Promise<void> | null = null;
function carregarStripe(): Promise<void> {
  if ((window as Janela).Stripe) return Promise.resolve();
  if (carregamento) return carregamento;
  carregamento = new Promise<void>((resolve,reject) => {
    const script = document.createElement('script'); script.src = 'https://js.stripe.com/v3/'; script.async = true;
    const tempo = setTimeout(() => { script.remove(); reject(new Error('stripe_timeout')); },15_000);
    script.onload = () => { clearTimeout(tempo); resolve(); };
    script.onerror = () => { clearTimeout(tempo); script.remove(); reject(new Error('stripe_indisponivel')); };
    document.head.append(script);
  }).catch(erro => { carregamento = null; throw erro; });
  return carregamento;
}

export function AutenticarCobranca({ faturaId }: { faturaId: string }) {
  const [mensagem,setMensagem] = useState(''); const [pendente,iniciar] = useTransition(); const router = useRouter();
  return <div className={estilos.confirmacao}>
    <button type="button" className="ui-button ui-button--ghost" disabled={pendente} onClick={() => iniciar(async () => {
      setMensagem('');
      try {
        const r = await acaoAutenticarCobranca(faturaId);
        if (!r.ok) { setMensagem(r.message); return; }
        const d = r.dados;
        if (d.estado === 'concluida') { setMensagem('Esta fatura já foi encerrada.'); router.refresh(); return; }
        if (d.estado === 'aguardando') { setMensagem('Aguardando a confirmação do pagamento. A situação será atualizada após a conferência.'); return; }
        if (d.estado === 'atualizar_cartao') { setMensagem('Confira o cartão cadastrado nesta página. A próxima tentativa segue a régua de cobrança.'); return; }
        if (d.estado !== 'autenticar') return;
        await carregarStripe();
        const stripe = (window as Janela).Stripe?.(d.chavePublica); if (!stripe) throw new Error('stripe_nao_carregou');
        const resultado = await stripe.confirmCardPayment(d.clientSecret,{ payment_method: d.paymentMethod });
        if (resultado.error) { setMensagem('O banco não confirmou. Tente novamente ou confira o cartão cadastrado.'); return; }
        setMensagem('Confirmação recebida. A fatura será atualizada após a conferência do pagamento.'); router.refresh();
      } catch { setMensagem('Não foi possível abrir a confirmação do banco. Tente novamente.'); }
    })}>{pendente ? 'Conferindo…' : 'Verificar cobrança'}</button>
    <p role="status" className="painel__nota">{mensagem}</p>
  </div>;
}
