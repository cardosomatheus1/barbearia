import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { LUGARES_EM_DESTAQUE } from '@barbearia/core';
import { contestacoesNaApi, destaquesNaApi, listarBarbearias } from '@/lib/plataforma-api';
import { lerSessaoDaPlataforma } from '@/lib/sessao-plataforma';
import { acaoCancelarDestaque, acaoReverterContestacao, acaoVenderDestaque } from '../acoes';
import { reais } from '@/lib/dinheiro';

/**
 * Destaque vendido e contestação de comissão (bloco 75).
 *
 * ## Duas listas, e as duas são sobre o mesmo contrato
 *
 * Em cima, o que a plataforma vendeu: quem está em destaque, em que cidade, em
 * que lugar e até quando. Embaixo, o que a barbearia contestou — a lacuna que o
 * bloco 72 declarou, porque lá a renúncia era **definitiva**: o índice único
 * faz aquele cliente nunca mais gerar comissão, e uma contestação errada não
 * tinha conserto.
 *
 * ## O nome do cliente não está aqui
 *
 * A barbearia precisa dele para conferir a conta; a plataforma não. Para ela a
 * pergunta é *"esta renúncia se explica?"*, e quem responde isso é o motivo
 * escrito — não quem é a pessoa.
 */

export const metadata: Metadata = {
  title: 'Destaques e contestações',
  robots: { index: false, follow: false },
};


const dia = (iso: string): string => new Date(iso).toLocaleDateString('pt-BR');

export default async function DestaquesPage() {
  const token = await lerSessaoDaPlataforma();
  if (!token) redirect('/plataforma/entrar');

  const [destaques, contestacoes, barbearias] = await Promise.all([
    destaquesNaApi(token),
    contestacoesNaApi(token),
    listarBarbearias(token),
  ]);
  const casas = barbearias.ok ? barbearias.dados.barbearias : [];

  const lista = destaques.ok ? destaques.dados.destaques : [];
  const contestadas = contestacoes.ok ? contestacoes.dados.contestacoes : [];

  return (
    <main className="ui-container painel__conteudo">
      <h1 className="painel__titulo">Destaques e contestações</h1>
      <p className="painel__sub">
        São {LUGARES_EM_DESTAQUE} lugares por cidade, e o banco recusa o segundo anúncio no mesmo
        lugar e período. O card sai marcado como patrocinado na busca — sempre.
      </p>

      <section className="painel__grupo">
        <h2 className="painel__secao">Vender um destaque</h2>
        <p className="plano__nota">
          A unidade é a primária da barbearia — a mesma que a página pública mostra. O preço sai
          da tabela por dia e é congelado na venda, e a fatura é documento próprio.
        </p>
        <form action={acaoVenderDestaque} className="formulario destaque-venda">
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="venda-tenant">
              Barbearia
            </label>
            <select className="ui-field__input" id="venda-tenant" name="tenantId" required>
              {casas.map((b) => (
                <option key={b.tenantId} value={b.tenantId}>
                  {b.nome}
                </option>
              ))}
            </select>
          </div>

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="venda-lugar">
              Lugar
            </label>
            <select className="ui-field__input" defaultValue="1" id="venda-lugar" name="lugar">
              {Array.from({ length: LUGARES_EM_DESTAQUE }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="venda-de">
              Começa em
            </label>
            <input className="ui-field__input" id="venda-de" name="de" required type="date" />
          </div>

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="venda-ate">
              Termina em
            </label>
            <input className="ui-field__input" id="venda-ate" name="ate" required type="date" />
          </div>

          <button className="ui-button ui-button--primary destaque-venda__acao" type="submit">
            Vender
          </button>
        </form>
      </section>

      <section className="painel__grupo">
        <h2 className="painel__secao">Destaques vendidos</h2>
        {lista.length === 0 ? (
          <p className="plano__vazio">
            Nenhum destaque vendido ainda. A venda sai pela conta da barbearia, e emite fatura
            própria — somá-la à mensalidade faria a casa receber um valor que ela não confere.
          </p>
        ) : (
          <div className="ui-scroll-x">
            <table className="plano-faturas">
              <thead>
                <tr>
                  <th scope="col">Barbearia</th>
                  <th scope="col">Onde</th>
                  <th scope="col">Lugar</th>
                  <th scope="col">Período</th>
                  <th scope="col">Valor</th>
                  <th scope="col">Situação</th>
                </tr>
              </thead>
              <tbody>
                {lista.map((d) => (
                  <tr key={d.id}>
                    <td>{d.barbearia}</td>
                    <td>
                      {d.cidade} — {d.estado}
                    </td>
                    <td className="tabular">{d.lugar}</td>
                    <td className="tabular">
                      {dia(d.de)} a {dia(d.ate)}
                    </td>
                    <td className="tabular">{reais(d.valorCents)}</td>
                    <td>
                      {d.estado_ === 'ativo' ? (
                        /* Cancelar libera o lugar na hora, e exige motivo: é
                           dinheiro de outra empresa, e sem motivo nada distingue
                           correção de engano. */
                        <form action={acaoCancelarDestaque} className="plano__contestacao">
                          <input name="anuncioId" type="hidden" value={d.id} />
                          <label className="ui-field__label" htmlFor={`motivo-ad-${d.id}`}>
                            Motivo
                          </label>
                          <input
                            className="ui-field__input"
                            id={`motivo-ad-${d.id}`}
                            maxLength={500}
                            minLength={10}
                            name="motivo"
                            placeholder="Ex.: vendido para a unidade errada"
                            required
                            type="text"
                          />
                          <button className="ui-button ui-button--ghost plano__contestar" type="submit">
                            Cancelar
                          </button>
                        </form>
                      ) : (
                        <span className="plano-fatura__estado plano-fatura__estado--void">
                          Cancelado
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="painel__grupo">
        <h2 className="painel__secao">Comissões contestadas</h2>
        <p className="plano__nota">
          A barbearia contesta com motivo escrito, e a linha para de ser cobrada. Reverter devolve
          a comissão para <strong>pendente</strong> — ela entra na emissão do mês seguinte pelo
          caminho normal.
        </p>
        {contestadas.length === 0 ? (
          <p className="plano__vazio">Nenhuma contestação. É o estado que se espera.</p>
        ) : (
          <div className="ui-scroll-x">
            <table className="plano-faturas">
              <thead>
                <tr>
                  <th scope="col">Barbearia</th>
                  <th scope="col">Atendimento</th>
                  <th scope="col">Comissão</th>
                  <th scope="col">Motivo da barbearia</th>
                  <th scope="col">Reverter</th>
                </tr>
              </thead>
              <tbody>
                {contestadas.map((c) => (
                  <tr key={c.id}>
                    <td>{c.barbearia}</td>
                    <td className="tabular">{dia(c.quando)}</td>
                    <td className="tabular">
                      {reais(c.feeCents)}{' '}
                      <span className="plano__aliquota">de {reais(c.baseCents)}</span>
                    </td>
                    <td>{c.motivo ?? '—'}</td>
                    <td>
                      <form action={acaoReverterContestacao} className="plano__contestacao">
                        <input name="atribuicaoId" type="hidden" value={c.id} />
                        <label className="ui-field__label" htmlFor={`motivo-rev-${c.id}`}>
                          Motivo
                        </label>
                        <input
                          className="ui-field__input"
                          id={`motivo-rev-${c.id}`}
                          maxLength={500}
                          minLength={10}
                          name="motivo"
                          placeholder="Ex.: o cliente é novo, veio pela busca"
                          required
                          type="text"
                        />
                        <button className="ui-button ui-button--ghost plano__contestar" type="submit">
                          Reverter
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
