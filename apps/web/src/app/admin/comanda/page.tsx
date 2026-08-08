import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { painelDoDia, type LinhaDoDia } from '@/lib/admin-api';
import { painelOuDesvio } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { reaisDoCampo } from '@/lib/dinheiro';
import { acaoAbrirComanda, acaoSair } from '../acoes';
import { BalcaoNav } from '../balcao-nav';

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

const reais = (centavos: number): string => `R$ ${reaisDoCampo(centavos)}`;

/** Quem já foi atendido ou está sendo: é de quem se cobra. */
const COBRAVEL: ReadonlySet<string> = new Set(['in_progress', 'completed']);

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

export default async function AbrirComandaPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const query = await searchParams;
  const dia = await painelDoDia(token);

  const erro = first(query['erro']);

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

  const aCobrar = dia.ok ? dia.dados.entries.filter((linha) => COBRAVEL.has(linha.status)) : [];

  return (
    <main className="ui-container painel__conteudo">
      {topo}
      <BalcaoNav atual="/admin/comanda" />

      <h1 className="painel__titulo">Cobrar</h1>

      {erro ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {FALHA[erro] ?? FALHA['request_failed']}
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
