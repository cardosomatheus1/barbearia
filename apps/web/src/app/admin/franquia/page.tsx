import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { fraseDaDistancia } from '@barbearia/core';
import { padraoDaFranquiaNaApi, type ItemDoPadraoNaApi } from '@/lib/admin-api';
import { painelOuDesvio } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import {
  acaoAdotarDoPadrao,
  acaoDespublicarDoPadrao,
  acaoPublicarNoPadrao,
  acaoSair,
} from '../acoes';
import { secao } from '../secoes';

/**
 * O cardápio padrão da franquia (bloco 76).
 *
 * ## Uma tela, dois públicos, e a diferença é declarada
 *
 * A **franqueadora** publica o padrão: ela vê o formulário. A **franqueada**
 * adota: ela vê a lista com o preço de referência ao lado do que ela cobra, e
 * um botão por item.
 *
 * As duas veem a mesma lista, porque é o mesmo fato — e a distância entre os
 * dois preços é calculada pela mesma função nas duas, que é a regra de duas
 * telas que classificam a mesma coisa.
 *
 * ## O que esta tela não faz
 *
 * Não existe botão que aplique o preço da franqueadora no catálogo da
 * franqueada sem alguém de lá clicar. A franqueada é outra empresa, e impor
 * preço de revenda a um distribuidor independente é infração à ordem econômica
 * (Lei 12.529/2011, art. 36 §3º IX). A distância aparece com sinal e sem
 * adjetivo: "18,2% abaixo do padrão", nunca "18,2% abaixo do que deveria".
 */

export const metadata: Metadata = {
  title: 'Franquia',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const reais = (centavos: number): string =>
  (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function Item({
  item,
  publica,
}: {
  readonly item: ItemDoPadraoNaApi;
  readonly publica: boolean;
}) {
  const adotado = item.adotadoComo;

  return (
    <li className="padrao-item">
      <div className="padrao-item__cabeca">
        <h3 className="padrao-item__nome">{item.nome}</h3>
        <span className="padrao-item__referencia tabular">{reais(item.referenciaCents)}</span>
      </div>
      <p className="padrao-item__sobre">
        {item.categoria ? `${item.categoria} · ` : ''}
        {item.duracaoMinutos} min
        {item.descricao ? ` · ${item.descricao}` : ''}
      </p>

      {adotado ? (
        <p className="padrao-item__praticado">
          Você cobra <strong className="tabular">{reais(adotado.praticadoCents)}</strong>{' '}
          <span
            className={
              adotado.distancia?.relevante
                ? 'padrao-item__distancia padrao-item__distancia--longe'
                : 'padrao-item__distancia'
            }
          >
            {fraseDaDistancia(adotado.distancia)}
          </span>
        </p>
      ) : (
        <p className="padrao-item__praticado padrao-item__praticado--fora">
          Ainda não está no seu catálogo.
        </p>
      )}

      <div className="padrao-item__acoes">
        <form action={acaoAdotarDoPadrao}>
          <input name="itemId" type="hidden" value={item.id} />
          <button className="ui-button ui-button--ghost padrao-item__acao" type="submit">
            {adotado ? 'Reaplicar nome e duração' : 'Adotar no meu catálogo'}
          </button>
        </form>

        {publica ? (
          <form action={acaoDespublicarDoPadrao}>
            <input name="itemId" type="hidden" value={item.id} />
            <button className="ui-button ui-button--ghost padrao-item__acao" type="submit">
              Tirar do padrão
            </button>
          </form>
        ) : null}
      </div>
    </li>
  );
}

export default async function FranquiaPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const resposta = await padraoDaFranquiaNaApi(token);
  const query = await searchParams;
  const adotado = first(query['adotado']);
  const publicado = first(query['publicado']) === '1';
  const despublicado = first(query['despublicado']) === '1';

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

  if (!resposta.ok) {
    return (
      <main className="ui-container painel__conteudo" {...secao('franquia')}>
        {topo}
        <div className="ui-alert ui-alert--danger" role="alert">
          Não deu para carregar o padrão da franquia.{' '}
          <a href="/admin/franquia">Tentar de novo</a>
        </div>
      </main>
    );
  }

  const { franquia, itens } = resposta.dados;

  /**
   * Estado vazio desenhado, e ele explica **o que é** uma franquia aqui.
   *
   * A maioria das barbearias não é de nenhuma, e a tela existe no menu para
   * todas. Uma lista vazia sem explicação ensinaria que a área está quebrada.
   */
  if (!franquia) {
    return (
      <main className="ui-container painel__conteudo" {...secao('franquia')}>
        {topo}
        <h1 className="painel__titulo">Franquia</h1>
        <p className="painel__sub">
          Esta barbearia não faz parte de uma franquia.
        </p>
        <div className="quadro padrao-vazio">
          <p>
            Franquia é diferente de <a href="/admin/unidades">unidades</a>: unidades são lojas
            suas, com o mesmo caixa e a mesma equipe. Numa franquia cada casa é uma empresa, com
            CNPJ e dinheiro próprios, e o que se compartilha é a marca e um cardápio padrão.
          </p>
          <p className="padrao-vazio__como">
            Entrar numa franquia é feito pelo suporte, porque liga duas empresas diferentes.
          </p>
        </div>
      </main>
    );
  }

  const publica = franquia.papel === 'franqueadora';
  const naoAdotados = itens.filter((i) => i.ativo && !i.adotadoComo).length;

  return (
    <main className="ui-container painel__conteudo" {...secao('franquia')}>
      {topo}

      <h1 className="painel__titulo">{franquia.nome}</h1>
      <p className="franquia-atalho">
        <a href="/admin/rede">Ver os números da rede →</a>
      </p>
      <p className="painel__sub">
        {publica
          ? 'Você publica o cardápio padrão da rede. O preço é de referência: cada franqueada é uma empresa e decide o que cobrar.'
          : 'O cardápio padrão da rede. O preço é de referência — quem decide o que você cobra é você, aqui e depois de adotar.'}
      </p>

      {publicado ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Item publicado no padrão.
        </div>
      ) : null}
      {despublicado ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Item tirado do padrão. Quem já vende continua vendendo.
        </div>
      ) : null}
      {adotado ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          {adotado === 'novo'
            ? 'Item adotado. Ele entrou no seu catálogo com o preço de referência — mude quando quiser.'
            : 'Nome e duração atualizados. Seu preço ficou como estava.'}
        </div>
      ) : null}

      {publica ? (
        <section className="painel__grupo">
          <h2 className="painel__secao">Publicar no padrão</h2>
          <form action={acaoPublicarNoPadrao} className="formulario padrao-form">
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="padrao-nome">
                Nome
              </label>
              <input
                className="ui-field__input"
                id="padrao-nome"
                maxLength={120}
                minLength={2}
                name="nome"
                placeholder="Corte social"
                required
                type="text"
              />
            </div>

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="padrao-categoria">
                Categoria
              </label>
              <input
                className="ui-field__input"
                id="padrao-categoria"
                maxLength={80}
                name="categoria"
                placeholder="Cabelo"
                type="text"
              />
            </div>

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="padrao-referencia">
                Preço de referência
              </label>
              <input
                className="ui-field__input"
                id="padrao-referencia"
                inputMode="decimal"
                name="referencia"
                placeholder="55,00"
                required
                type="text"
              />
              <p className="ui-field__hint">Sugestão. Cada franqueada decide o preço dela.</p>
            </div>

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="padrao-duracao">
                Duração (min)
              </label>
              <input
                className="ui-field__input"
                id="padrao-duracao"
                inputMode="numeric"
                max={480}
                min={5}
                name="duracao"
                placeholder="30"
                required
                type="number"
              />
            </div>

            <button className="ui-button ui-button--primary padrao-form__acao" type="submit">
              Publicar
            </button>
          </form>
        </section>
      ) : null}

      <section className="painel__grupo">
        <h2 className="painel__secao">
          O padrão da rede{' '}
          <span className="padrao-lista__contagem tabular">
            {itens.filter((i) => i.ativo).length}
          </span>
        </h2>
        {naoAdotados > 0 && !publica ? (
          <p className="plano__nota">
            {naoAdotados === 1
              ? 'Um item ainda não está no seu catálogo.'
              : `${naoAdotados} itens ainda não estão no seu catálogo.`}
          </p>
        ) : null}

        {itens.filter((i) => i.ativo).length === 0 ? (
          <p className="plano__vazio">
            {publica
              ? 'O padrão está vazio. Publique o primeiro item acima — ele aparece na hora para todas as franqueadas.'
              : 'A franqueadora ainda não publicou nenhum item. Seu catálogo continua sendo o que você cadastrou.'}
          </p>
        ) : (
          <ul className="padrao-lista">
            {itens
              .filter((i) => i.ativo)
              .map((item) => (
                <Item item={item} key={item.id} publica={publica} />
              ))}
          </ul>
        )}
      </section>
    </main>
  );
}
