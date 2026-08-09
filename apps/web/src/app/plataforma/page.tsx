import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  listarBarbearias,
  listarPlanos,
  type BarbeariaNaPlataforma,
  type Plano,
} from '@/lib/plataforma-api';
import { lerSessaoDaPlataforma } from '@/lib/sessao-plataforma';
import { acaoBloquear, acaoDesbloquear, acaoTrocarPlano } from './acoes';

/**
 * As barbearias da plataforma.
 *
 * Uma linha por barbearia, com plano e estado, e as duas ações que este bloco
 * entrega: trocar o plano e bloquear a conta.
 *
 * O bloqueio abre um `<details>` com o campo de motivo em vez de um botão
 * direto. Não é enfeite: bloquear tira do ar a página pública e derruba quem
 * estiver logado, e um clique sem confirmação numa lista de linhas parecidas é
 * como se bloqueia a barbearia de baixo. O motivo digitado **é** a confirmação
 * — e é o mesmo texto que o dono lê quando tenta entrar.
 */

export const metadata: Metadata = {
  title: 'Barbearias',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const FALHA: Record<string, string> = {
  reason_required: 'Escreva o motivo do bloqueio.',
  not_blockable: 'Esta barbearia não existe mais ou já estava bloqueada.',
  not_blocked: 'Esta barbearia já estava ativa.',
  unknown_plan: 'Este plano não existe.',
  unknown_tenant: 'Esta barbearia não existe mais.',
  inactive_plan: 'Este plano não é mais oferecido.',
  unauthorized: 'A sessão venceu. Entre de novo.',
  request_failed: 'Não deu para concluir. Tente de novo.',
};

const FEITO: Record<string, string> = {
  plano: 'Plano alterado.',
  bloqueio: 'Conta bloqueada. A página pública saiu do ar.',
  desbloqueio: 'Conta reativada.',
};

const reais = (centavos: number): string =>
  `R$ ${(centavos / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

const dia = (iso: string): string =>
  new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });

function Linha({
  barbearia,
  planos,
}: {
  readonly barbearia: BarbeariaNaPlataforma;
  readonly planos: readonly Plano[];
}) {
  const oferecidos = planos.filter((p) => p.active || p.code === barbearia.plano?.code);

  return (
    <li className={`conta ${barbearia.bloqueada ? 'conta--bloqueada' : ''}`}>
      <div className="conta__quem">
        <h2 className="conta__nome">
          {barbearia.nome}
          {barbearia.bloqueada ? <span className="conta__selo">bloqueada</span> : null}
        </h2>
        <p className="conta__meta">
          {barbearia.slug ? (
            <span className="conta__slug">/{barbearia.slug}</span>
          ) : (
            <span className="conta__slug conta__slug--vazio">sem endereço publicado</span>
          )}
          <span>desde {dia(barbearia.criadaEm)}</span>
        </p>
        {barbearia.bloqueada && barbearia.motivoDoBloqueio ? (
          <p className="conta__motivo">
            {barbearia.motivoDoBloqueio}
            {barbearia.bloqueadaEm ? <> · desde {dia(barbearia.bloqueadaEm)}</> : null}
          </p>
        ) : null}
      </div>

      <form action={acaoTrocarPlano} className="conta__plano">
        <input name="tenantId" type="hidden" value={barbearia.tenantId} />
        <label className="ui-field__label" htmlFor={`plano-${barbearia.tenantId}`}>
          Plano
        </label>
        <div className="conta__plano-linha">
          <select
            className="ui-field__input"
            defaultValue={barbearia.plano?.code ?? ''}
            id={`plano-${barbearia.tenantId}`}
            name="planoCode"
          >
            <option disabled value="">
              sem plano
            </option>
            {oferecidos.map((plano) => (
              <option key={plano.code} value={plano.code}>
                {plano.name} — {reais(plano.priceCents)}
                {plano.maxChairs === null ? ' · cadeiras ilimitadas' : ` · até ${plano.maxChairs}`}
              </option>
            ))}
          </select>
          <button className="ui-button ui-button--ghost" type="submit">
            Salvar
          </button>
        </div>
      </form>

      <div className="conta__acao">
        {barbearia.bloqueada ? (
          <form action={acaoDesbloquear}>
            <input name="tenantId" type="hidden" value={barbearia.tenantId} />
            <button className="ui-button ui-button--primary" type="submit">
              Reativar
            </button>
          </form>
        ) : (
          <details className="conta__bloquear">
            <summary className="ui-button ui-button--ghost conta__bloquear-abrir">Bloquear</summary>
            <form action={acaoBloquear} className="conta__bloquear-form">
              <input name="tenantId" type="hidden" value={barbearia.tenantId} />
              <label className="ui-field__label" htmlFor={`motivo-${barbearia.tenantId}`}>
                Motivo
              </label>
              <input
                className="ui-field__input"
                id={`motivo-${barbearia.tenantId}`}
                maxLength={500}
                minLength={3}
                name="motivo"
                placeholder="inadimplente há 60 dias"
                required
                type="text"
              />
              <p className="conta__aviso">
                A página pública sai do ar e quem estiver no painel é desconectado. O dono lê este
                motivo ao tentar entrar.
              </p>
              <button className="ui-button ui-button--danger" type="submit">
                Bloquear {barbearia.nome}
              </button>
            </form>
          </details>
        )}
      </div>
    </li>
  );
}

export default async function BarbeariasPage({ searchParams }: Props) {
  const token = await lerSessaoDaPlataforma();
  if (!token) redirect('/plataforma/entrar');

  const query = await searchParams;
  const erro = typeof query['erro'] === 'string' ? query['erro'] : undefined;
  const feito = typeof query['feito'] === 'string' ? query['feito'] : undefined;

  const [lista, catalogo] = await Promise.all([listarBarbearias(token), listarPlanos(token)]);

  if (!lista.ok) {
    if (lista.code === 'unauthorized') redirect('/plataforma/entrar');
    return (
      <main className="ui-container painel__conteudo plataforma__trabalho">
        <h1 className="painel__titulo">Barbearias</h1>
        <div className="ui-alert ui-alert--danger" role="alert">
          Não deu para carregar a lista. Recarregue a página.
        </div>
      </main>
    );
  }

  const barbearias = lista.dados.barbearias;
  const planos = catalogo.ok ? catalogo.dados.planos : [];
  const bloqueadas = barbearias.filter((b) => b.bloqueada).length;

  return (
    <main className="ui-container painel__conteudo plataforma__trabalho">
      <h1 className="painel__titulo">Barbearias</h1>
      <p className="painel__sub">
        {barbearias.length} {barbearias.length === 1 ? 'conta' : 'contas'}
        {bloqueadas > 0 ? ` · ${bloqueadas} bloqueada${bloqueadas === 1 ? '' : 's'}` : null}
      </p>

      {feito ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          {FEITO[feito] ?? 'Pronto.'}
        </div>
      ) : null}
      {erro ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {FALHA[erro] ?? 'Não deu para concluir. Tente de novo.'}
        </div>
      ) : null}

      {barbearias.length === 0 ? (
        <div className="vazio">
          <p className="vazio__titulo">Nenhuma barbearia ainda</p>
          <p className="vazio__saida">
            A primeira aparece aqui assim que alguém criar a conta pelo cadastro.
          </p>
        </div>
      ) : (
        <ul className="contas">
          {barbearias.map((barbearia) => (
            <Linha barbearia={barbearia} key={barbearia.tenantId} planos={planos} />
          ))}
        </ul>
      )}
    </main>
  );
}
