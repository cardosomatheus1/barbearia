import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  casasDaFranquiaNaApi,
  franquiasNaApi,
  listarBarbearias,
  type CasaDaFranquiaNaTela,
} from '@/lib/plataforma-api';
import { lerSessaoDaPlataforma } from '@/lib/sessao-plataforma';
import { acaoCriarFranquia, acaoPorNaFranquia, acaoTirarDaFranquia } from '../acoes';

/**
 * Montar uma franquia (bloco 76).
 *
 * ## Por que isto mora aqui e não no painel da barbearia
 *
 * Ligar duas barbearias numa franquia é uma operação **entre tenants**, e não
 * existe lugar dentro de uma delas de onde ela possa ser feita: a RLS separa
 * barbearias, e é exatamente para isso que ela existe. Depois de montada, a
 * franquia é dos dois lados dela — a plataforma não publica cardápio, não vê
 * preço praticado e não fala com franqueada.
 *
 * ## O papel não é uma escolha do formulário
 *
 * Quem cria a franquia é a franqueadora; quem entra depois entra sempre como
 * franqueada. É o precedente do convite do barbeiro no bloco 29 — papel que vem
 * do formulário é papel que alguém escolhe errado —, e aqui pesa mais:
 * franqueadora é quem escreve o padrão da rede inteira.
 */

export const metadata: Metadata = {
  title: 'Franquias',
  robots: { index: false, follow: false },
};

const dia = (iso: string): string => new Date(iso).toLocaleDateString('pt-BR');

function Casas({ casas }: { readonly casas: readonly CasaDaFranquiaNaTela[] }) {
  return (
    <ul className="franquia-casas">
      {casas.map((c) => (
        <li className="franquia-casa" key={c.tenantId}>
          <span className="franquia-casa__nome">{c.nome}</span>
          <span
            className={
              c.papel === 'franqueadora'
                ? 'franquia-casa__papel franquia-casa__papel--dona'
                : 'franquia-casa__papel'
            }
          >
            {c.papel}
          </span>
          <span className="franquia-casa__desde tabular">desde {dia(c.entrouEm)}</span>
          {c.papel === 'franqueada' ? (
            <form action={acaoTirarDaFranquia}>
              <input name="tenantId" type="hidden" value={c.tenantId} />
              <button className="ui-button ui-button--ghost franquia-casa__acao" type="submit">
                Tirar da rede
              </button>
            </form>
          ) : (
            /* A franqueadora não sai: sem ela ninguém publica o padrão, e a
               rede fica com um cardápio órfão. Dissolver é outra operação. */
            <span className="franquia-casa__fixa">não sai</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export default async function FranquiasPage() {
  const token = await lerSessaoDaPlataforma();
  if (!token) redirect('/plataforma/entrar');

  const [franquias, barbearias] = await Promise.all([
    franquiasNaApi(token),
    listarBarbearias(token),
  ]);

  const lista = franquias.ok ? franquias.dados.franquias : [];
  const casas = barbearias.ok ? barbearias.dados.barbearias : [];

  const dentro = await Promise.all(
    lista.map(async (f) => {
      const r = await casasDaFranquiaNaApi(token, f.id);
      return { franquia: f, casas: r.ok ? r.dados.casas : [] };
    }),
  );

  return (
    <main className="ui-container painel__conteudo">
      <h1 className="painel__titulo">Franquias</h1>
      <p className="painel__sub">
        Franquia não é o mesmo que unidade. Unidade é loja da mesma barbearia, com o mesmo caixa
        e a mesma equipe; franquia são empresas diferentes que compartilham marca e um cardápio
        padrão. O preço do padrão é de referência — cada franqueada decide o que cobra.
      </p>

      <section className="painel__grupo">
        <h2 className="painel__secao">Criar uma franquia</h2>
        <p className="plano__nota">
          A barbearia escolhida vira a <strong>franqueadora</strong>: é ela que publica o cardápio
          padrão, e o dono dela recebe a permissão para isso na mesma operação.
        </p>
        <form action={acaoCriarFranquia} className="formulario franquia-form">
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="franquia-nome">
              Nome da rede
            </label>
            <input
              className="ui-field__input"
              id="franquia-nome"
              maxLength={120}
              minLength={2}
              name="nome"
              placeholder="Rede Barber Dock"
              required
              type="text"
            />
          </div>

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="franquia-tenant">
              Franqueadora
            </label>
            <select className="ui-field__input" id="franquia-tenant" name="tenantId" required>
              {casas.map((b) => (
                <option key={b.tenantId} value={b.tenantId}>
                  {b.nome}
                </option>
              ))}
            </select>
          </div>

          <button className="ui-button ui-button--primary franquia-form__acao" type="submit">
            Criar
          </button>
        </form>
      </section>

      <section className="painel__grupo">
        <h2 className="painel__secao">Redes montadas</h2>
        {dentro.length === 0 ? (
          <p className="plano__vazio">
            Nenhuma franquia ainda. É o estado normal: franquia é do plano Enterprise, e a maioria
            das barbearias é dona de si mesma.
          </p>
        ) : (
          <ul className="franquia-lista">
            {dentro.map(({ franquia, casas: dela }) => (
              <li className="franquia" key={franquia.id}>
                <div className="franquia__cabeca">
                  <h3 className="franquia__nome">{franquia.nome}</h3>
                  <span className="franquia__numeros tabular">
                    {franquia.franqueadas} franqueada{franquia.franqueadas === 1 ? '' : 's'} ·{' '}
                    {franquia.itensNoPadrao} no padrão
                  </span>
                </div>

                <Casas casas={dela} />

                <form action={acaoPorNaFranquia} className="franquia__entrada">
                  <input name="franquiaId" type="hidden" value={franquia.id} />
                  <label className="ui-field__label" htmlFor={`entrar-${franquia.id}`}>
                    Pôr uma barbearia nesta rede
                  </label>
                  <select
                    className="ui-field__input"
                    id={`entrar-${franquia.id}`}
                    name="tenantId"
                    required
                  >
                    {casas.map((b) => (
                      <option key={b.tenantId} value={b.tenantId}>
                        {b.nome}
                      </option>
                    ))}
                  </select>
                  <button className="ui-button ui-button--ghost franquia__acao" type="submit">
                    Pôr como franqueada
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
