import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { ESTADOS_COBRAVEIS } from '@barbearia/core';
import {
  comandasAbertasDaCasa,
  painelDoDia,
  type ComandaAbertaNaTela,
  type LinhaDoDia,
} from '@/lib/admin-api';
import { painelOuDesvio } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { reais, reaisDoCampo } from '@/lib/dinheiro';
import { acaoAbrirComanda, acaoCancelarComanda, acaoSair } from '../acoes';
import { secao } from '../secoes';
import { AvisoDeRecusa } from '@/app/admin/aviso-de-recusa';

/**
 * Por onde uma comanda começa.
 *
 * Quase sempre de um atendimento do dia: a comanda nasce **pré-preenchida** com
 * os serviços marcados, no preço combinado na reserva. Obrigar a recepção a
 * redigitar é como o cobrado passa a divergir do que o cliente ouviu ao marcar.
 *
 * A comanda avulsa existe para o outro caso, que também é real: alguém entra só
 * para comprar pomada. Não tem atendimento, e forçar um agendamento fantasma
 * para vender um produto sujaria a agenda e o relatório de ocupação.
 */

export const metadata: Metadata = {
  title: 'Comanda',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const FALHA: Record<string, string> = {
  comanda_nao_encontrada: 'Este atendimento não foi encontrado.',
  cliente_nao_encontrado: 'Este cliente não existe mais.',
  mfa_required: 'Confirme o código do segundo fator para continuar.',
  forbidden: 'Sua conta não abre comanda.',
  request_failed: 'Não deu para abrir a comanda. Tente de novo.',
};


function Atendimento({ linha }: { readonly linha: LinhaDoDia }) {
  return (
    <li className="para-cobrar">
      <div className="para-cobrar__quem">
        <span className="para-cobrar__nome">{linha.customerName ?? 'Sem cadastro'}</span>
        <span className="para-cobrar__detalhe">
          {linha.start} · {linha.professionalName} · {linha.services.join(', ')}
        </span>
      </div>

      <span className="para-cobrar__valor">{reais(linha.priceCents)}</span>

      <form action={acaoAbrirComanda}>
        <input name="appointmentId" type="hidden" value={linha.id} />
        <input name="idempotencyKey" type="hidden" value={randomUUID()} />
        <button className="ui-button ui-button--primary" type="submit">
          Cobrar
        </button>
      </form>
    </li>
  );
}

/**
 * Uma comanda que ficou aberta.
 *
 * A tela listava só os atendimentos do dia, e a comanda avulsa não nasce de
 * atendimento nenhum: depois do redirecionamento ela não aparecia em tela
 * nenhuma do produto. Quem fechasse a aba perdia a única porta.
 */
function Aberta({ comanda }: { readonly comanda: ComandaAbertaNaTela }) {
  const quando = new Date(comanda.abertaEm).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <li className="para-cobrar">
      <div className="para-cobrar__quem">
        <span className="para-cobrar__nome">{comanda.customerName ?? 'Venda avulsa'}</span>
        <span className="para-cobrar__detalhe">
          Aberta às {quando} · {comanda.itens === 1 ? '1 item' : `${comanda.itens} itens`}
        </span>
      </div>

      <span className="para-cobrar__valor">{reais(comanda.totalCents)}</span>

      <div className="para-cobrar__acoes">
        <a className="ui-button ui-button--primary" href={`/admin/comanda/${comanda.id}`}>
          Abrir
        </a>
        {/* A saída. Fica em `ghost` porque a ação principal da linha é voltar
            para a comanda — cancelar é o caminho de quem abriu por engano. */}
        <form action={acaoCancelarComanda}>
          <input name="orderId" type="hidden" value={comanda.id} />
          <button className="ui-button ui-button--ghost" type="submit">
            Cancelar
          </button>
        </form>
      </div>
    </li>
  );
}

export default async function AbrirComandaPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const query = await searchParams;
  const [dia, abertas] = await Promise.all([painelDoDia(token), comandasAbertasDaCasa(token)]);

  const erro = first(query['erro']);
  const feito = first(query['feito']);

  const topo = (
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
  );

  const aCobrar = dia.ok ? dia.dados.entries.filter((linha) => ESTADOS_COBRAVEIS.has(linha.status)) : [];

  return (
    <main className="ui-container painel__conteudo" {...secao('comanda')}>
      {topo}

      <h1 className="painel__titulo">Cobrar</h1>

      <AvisoDeRecusa erro={erro} mapa={FALHA} className="painel__aviso" />

      {feito === 'cancelada' ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Comanda cancelada. Nada foi cobrado e nada saiu do estoque.
        </div>
      ) : null}

      <section className="cartao-balcao">
        <h2 className="cartao-balcao__titulo">Atendimentos de hoje</h2>
        {aCobrar.length === 0 ? (
          <p className="vazio">
            Ninguém em atendimento ou concluído ainda. A comanda aparece aqui quando o barbeiro
            inicia o corte — antes disso não há o que cobrar.
          </p>
        ) : (
          <ul className="para-cobrar-lista">
            {aCobrar.map((linha) => (
              <Atendimento key={linha.id} linha={linha} />
            ))}
          </ul>
        )}
      </section>

      {/* As comandas abertas, e é onde a venda avulsa aparece depois de criada.
          Sem esta seção ela existia só na URL do redirecionamento. Só desenha
          quando há alguma: no dia normal a lista fica vazia, e uma seção vazia
          permanente ensina a não olhar. */}
      {abertas.ok && abertas.dados.comandas.length > 0 ? (
        <section className="cartao-balcao">
          <h2 className="cartao-balcao__titulo">Comandas abertas</h2>
          <p className="ui-field__hint">
            Ainda não foram pagas. A do atendimento que você acabou de abrir está aqui — e a
            que foi aberta por engano se cancela por aqui.
          </p>
          <ul className="para-cobrar-lista">
            {abertas.dados.comandas.map((comanda) => (
              <Aberta comanda={comanda} key={comanda.id} />
            ))}
          </ul>
        </section>
      ) : null}

      <details className="dobra">
        <summary className="dobra__titulo">Venda avulsa, sem atendimento</summary>
        <form action={acaoAbrirComanda} className="formulario">
          <input name="idempotencyKey" type="hidden" value={randomUUID()} />
          <p className="ui-field__hint">
            Para quem entrou só para comprar. A comanda abre vazia e você acrescenta o que foi
            vendido.
          </p>
          <button className="ui-button ui-button--ghost ui-button--block" type="submit">
            Abrir comanda avulsa
          </button>
        </form>
      </details>
    </main>
  );
}
