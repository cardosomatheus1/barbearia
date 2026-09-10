import { notFound, redirect } from 'next/navigation';
import { getProfile } from '@/lib/api';
import { lerSessao } from '@/lib/sessao';
import { lerPedidoConsentimentoCadastro, consultarConsentimentoCadastroNaApi } from '@/lib/consentimento-cadastro';
import { confirmarAceiteCadastro, dispensarAceiteCadastro } from './acoes';
export const metadata = { title: 'Confirmar novidades por WhatsApp', robots: { index: false, follow: false } };
export default async function ConsentimentoCadastroPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ erro?: string }> }) {
  const { slug } = await params; const profile = await getProfile(slug); if (!profile) notFound();
  const sessao = await lerSessao(slug); const pedido = await lerPedidoConsentimentoCadastro(slug); const query = await searchParams;
  if (!sessao) redirect(`/${slug}/entrar?destino=${encodeURIComponent(`/${slug}/consentimento-whatsapp`)}`);
  const r = pedido ? await consultarConsentimentoCadastroNaApi(slug, sessao, pedido.token) : null;
  return <main className="ui-container entrar"><a className="entrar__voltar" href={`/${slug}/meus-agendamentos`}>← Meus agendamentos</a>
    <h1 className="entrar__titulo">Novidades da {profile.name}</h1>
    {r?.ok && r.dados.confirmado ? <section className="ui-alert">
      <p>Esta escolha já foi confirmada anteriormente. Suas preferências atuais foram mantidas.</p>
      <a className="ui-button ui-button--primary" href={`/${slug}/meus-agendamentos`}>Ver minhas preferências</a>
    </section> : r?.ok ? <>
      <p className="entrar__sub">Seu número foi confirmado. Confira a escolha que você marcou ao agendar:</p>
      <p>{r.dados.texto}</p><p className="entrar__nota">Este aceite autoriza novidades e promoções. Confirmações e lembretes do horário continuam como avisos do seu agendamento. Você pode retirar o aceite em Meus agendamentos.</p>
      {query.erro ? <p className="ui-alert ui-alert--warning" role="alert">Não foi possível concluir agora. Tente novamente.</p> : null}
      <form action={confirmarAceiteCadastro} className="formulario"><input type="hidden" name="slug" value={slug} /><button className="ui-button ui-button--primary ui-button--block" type="submit">Confirmar meu aceite</button></form>
      <form action={dispensarAceiteCadastro} className="formulario"><input type="hidden" name="slug" value={slug} /><button className="ui-button ui-button--ghost ui-button--block" type="submit">Agora não</button></form>
    </> : <p className="entrar__sub">{r && !r.ok ? r.message : 'Esta confirmação expirou. Você pode escolher suas preferências em Meus agendamentos.'}</p>}
  </main>;
}
