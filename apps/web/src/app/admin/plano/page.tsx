import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { planoDaBarbearia, type PlanoDaBarbearia } from '@/lib/admin-api';
import { painelOuDesvio } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { secao } from '../secoes';

/**
 * O plano, para quem paga por ele.
 *
 * A assinatura nasceu no painel da plataforma, e ficar só lá seria o defeito de
 * sempre pelo avesso: o dado existe, é cobrado, e a pessoa de quem se cobra não
 * consegue vê-lo. É também para onde a régua de vencimento do bloco 28 vai
 * apontar — um aviso que diz "sua conta vence em três dias" precisa de uma tela
 * onde o dono confira isso.
 *
 * A tela responde três perguntas, nesta ordem: até quando, quanto e o que vem
 * junto. Nenhuma delas é opinião — todas saem da assinatura.
 */

export const metadata: Metadata = {
  title: 'Plano',
  robots: { index: false, follow: false },
};

const reais = (centavos: number): string =>
  `R$ ${(centavos / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

const dia = (iso: string): string =>
  new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

/**
 * Quantos dias faltam, contra o instante em que a página é montada.
 *
 * Arredondado para cima: faltando vinte horas, o dono precisa ler "1 dia", não
 * "0 dias" — que ele leria como "venceu".
 */
const faltam = (iso: string): number =>
  Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);

function Estado({ p }: { readonly p: PlanoDaBarbearia }) {
  if (p.estado === 'trialing' && p.testeAte) {
    const dias = faltam(p.testeAte);
    return (
      <div className={`ui-alert ${dias <= 3 ? 'ui-alert--warning' : 'ui-alert--info'}`} role="status">
        {dias > 0 ? (
          <>
            Você está em teste até <strong>{dia(p.testeAte)}</strong> — faltam {dias}{' '}
            {dias === 1 ? 'dia' : 'dias'}. Nada é cobrado até lá.
          </>
        ) : (
          <>O período de teste terminou em {dia(p.testeAte)}.</>
        )}
      </div>
    );
  }

  if (p.estado === 'past_due') {
    return (
      <div className="ui-alert ui-alert--danger" role="alert">
        Há uma cobrança em aberto desde {dia(p.periodoAte)}. A barbearia continua no ar — procure o
        suporte para regularizar.
      </div>
    );
  }

  if (p.estado === 'canceled') {
    return (
      <div className="ui-alert ui-alert--warning" role="status">
        Assinatura cancelada. A barbearia continua no ar até {dia(p.periodoAte)}.
      </div>
    );
  }

  return (
    <div className="ui-alert ui-alert--info" role="status">
      Assinatura ativa. Próxima renovação em <strong>{dia(p.periodoAte)}</strong>.
    </div>
  );
}

export default async function PlanoPage() {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  // Redireciona sozinha quando não há sessão válida ou a senha inicial não foi
  // trocada; o retorno é o estado do painel, que esta tela não usa.
  await painelOuDesvio(token);

  const resposta = await planoDaBarbearia(token);

  if (!resposta.ok) {
    return (
      <main className="ui-container painel__conteudo" {...secao('plano')}>
        <h1 className="painel__titulo">Plano</h1>
        <div className="ui-alert ui-alert--danger" role="alert">
          Não deu para carregar o plano. Recarregue a página.
        </div>
      </main>
    );
  }

  const p = resposta.dados;
  const teto = p.cadeiras.teto;
  const cheio = teto !== null && p.cadeiras.emUso >= teto;

  return (
    <main className="ui-container painel__conteudo" {...secao('plano')}>
      <h1 className="painel__titulo">Plano</h1>
      <p className="painel__sub">O que a barbearia contratou, e o que vem junto.</p>

      <Estado p={p} />

      <section className="painel__grupo">
        <h2 className="painel__secao">
          {p.plano.nome} · {reais(p.plano.precoCents)}
          <span className="plano__publico">{p.plano.publico}</span>
        </h2>

        <p className="ui-field__label">Cadeiras</p>
        <p className="plano__cadeiras">
          <strong>{p.cadeiras.emUso}</strong>
          {teto === null ? ' cadeiras · sem limite no seu plano' : ` de ${teto}`}
        </p>
        {cheio ? (
          // O limite só é útil se aparecer **antes** de a pessoa tentar
          // cadastrar e levar um erro que não explica nada.
          <p className="plano__aviso">
            Você está no limite do plano. Para abrir mais uma cadeira, fale com o suporte sobre
            subir de plano — ou desligue alguém que não atende mais.
          </p>
        ) : null}
      </section>

      <section className="painel__grupo">
        <h2 className="painel__secao">O que vem no plano</h2>
        <ul className="plano__recursos">
          {p.recursos.map((r) => (
            <li className={`plano__recurso ${r.ligado ? '' : 'plano__recurso--fora'}`} key={r.code}>
              <p className="plano__recurso-nome">
                {r.nome}
                {r.ligado && !r.noPlano ? (
                  // Ligado sem estar no plano é cortesia, e dizer isso evita a
                  // conversa ruim do dia em que ela terminar.
                  <span className="plano__selo">cortesia</span>
                ) : null}
                {!r.ligado ? <span className="plano__selo plano__selo--fora">não incluso</span> : null}
              </p>
              <p className="plano__recurso-sobre">{r.descricao}</p>
            </li>
          ))}
        </ul>
      </section>

      <p className="painel__nota">
        Para trocar de plano, fale com o suporte. A mudança no meio do período muda o valor
        cobrado, e essa conta ainda não é feita por aqui.
      </p>
    </main>
  );
}
