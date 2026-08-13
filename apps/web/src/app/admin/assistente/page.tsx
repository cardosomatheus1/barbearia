import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { catalogoDeMetricasNaApi, conversarNaApi } from '@/lib/admin-api';
import { painelOuDesvio } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { acaoPerguntarAoAssistente, acaoSair } from '../acoes';
import { secao } from '../secoes';

/**
 * O assistente do gestor (blocos 63 e 64, SPEC §4.15).
 *
 * ## Sem componente de cliente, e por isso um formulário
 *
 * Um chat com balões exigiria estado no navegador, e este painel é 100%
 * renderizado no servidor. O que a tela faz é o que um chat faz de útil: a pessoa
 * escreve em português, e a resposta aparece com o número, o período e o link
 * para conferir. A pergunta volta na URL — e o texto dela é o **próprio texto**,
 * não uma métrica: o que não pode ir para a URL é o resultado, não a pergunta.
 *
 * ## A resposta sempre diz onde conferir
 *
 * *"Toda resposta traz o número, o período, a fonte e um link para a tela onde
 * ele pode ser conferido."* É requisito da SPEC, e é o que impede o assistente de
 * virar um oráculo: o dono clica, vê o mesmo número na tela de verdade, e passa a
 * confiar. Na primeira vez que os dois discordarem, ele para de usar — e com
 * razão.
 */

export const metadata: Metadata = {
  title: 'Assistente',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

export default async function AssistentePage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const query = await searchParams;
  const texto = first(query['p'])?.slice(0, 200) ?? '';

  const [catalogo, resposta] = await Promise.all([
    catalogoDeMetricasNaApi(token),
    texto ? conversarNaApi(token, texto) : Promise.resolve(null),
  ]);

  const sugestoes = catalogo.ok ? catalogo.dados.sugestoes : [];
  const r = resposta?.ok ? resposta.dados : null;
  const recusada = resposta && !resposta.ok;

  return (
    <main className="ui-container painel__conteudo" {...secao('assistente')}>
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

      <h1 className="painel__titulo">Assistente</h1>
      <p className="painel__sub">
        Pergunte em português. A resposta vem com o período que ela usou e o link da tela onde o
        número pode ser conferido.
      </p>

      <form action={acaoPerguntarAoAssistente} className="pergunta">
        <label className="ui-field__label" htmlFor="p">
          O que você quer saber
        </label>
        <div className="pergunta__linha">
          <input
            className="ui-field__input"
            defaultValue={texto}
            id="p"
            maxLength={200}
            name="p"
            placeholder="Quanto faturei este mês?"
            required
          />
          <button className="ui-button ui-button--primary" type="submit">
            Perguntar
          </button>
        </div>
      </form>

      {recusada ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          Você não tem acesso a este número. Peça ao dono se precisar dele.
        </div>
      ) : null}

      {r?.entendi ? (
        <section className="cartao-balcao resposta">
          <p className="resposta__rotulo">{r.rotulo}</p>
          <p className="resposta__numero">{r.totalFormatado}</p>
          <p className="resposta__periodo">
            De {r.de?.split('-').reverse().join('/')} a {r.ate?.split('-').reverse().join('/')}
          </p>
          <p className="cartao-balcao__texto">{r.significado}</p>

          {r.fatias && r.fatias.length > 0 ? (
            <ul className="resposta__fatias">
              {r.fatias.map((f) => (
                <li className="resposta__fatia" key={f.rotulo ?? 'total'}>
                  <span>{f.rotulo}</span>
                  <strong>{f.formatado}</strong>
                </li>
              ))}
            </ul>
          ) : null}

          {/* O link de conferir. É o que impede o assistente de virar oráculo. */}
          {r.tela ? (
            <a className="ui-button ui-button--secondary" href={r.tela}>
              Conferir na tela
            </a>
          ) : null}
        </section>
      ) : null}

      {r && !r.entendi ? (
        <div className="ui-alert painel__aviso" role="status">
          Não entendi essa. Estas eu sei responder:
        </div>
      ) : null}

      <section className="cartao-balcao">
        <h2 className="cartao-balcao__titulo">O que dá para perguntar</h2>
        <p className="cartao-balcao__texto">
          A lista já vem recortada pelo que você pode ver — não há pergunta aqui que devolva
          &quot;sem acesso&quot;.
        </p>
        {sugestoes.length === 0 ? (
          <p className="cartao-balcao__texto">
            Nenhuma pergunta disponível para o seu acesso. Fale com o dono da barbearia.
          </p>
        ) : (
          <ul className="sugestoes">
            {sugestoes.map((s) => (
              <li key={s.texto}>
                <a
                  className="ui-button ui-button--secondary sugestoes__item"
                  href={`/admin/assistente?p=${encodeURIComponent(s.texto)}`}
                >
                  {s.texto}
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
