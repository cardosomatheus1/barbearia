import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { EXPLICACAO_DO_CRESCIMENTO, ROTULO_DO_CRESCIMENTO, SUBIR_E_BOM } from '@barbearia/core';
import {
  churnNaApi,
  crescimentoNaApi,
  type ClienteEmChurnNaTela,
  type CrescimentoNaTelaDoAdmin,
} from '@/lib/admin-api';
import { painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { reaisDoCampo } from '@/lib/dinheiro';
import { acaoSair } from '../acoes';
import { secao } from '../secoes';
import { SerieDeFaturamento } from './serie';

/**
 * Retenção: quem está indo embora, e se a casa está melhorando (bloco 62).
 *
 * ## Por que as duas coisas na mesma tela
 *
 * O crescimento responde *"estamos retendo?"* e a lista de risco responde *"de
 * quem, hoje?"*. Separadas, a primeira vira relatório — e relatório sem o nome
 * ao lado é o que o dono lê uma vez e não abre de novo. É a mesma decisão do
 * heatmap com o formulário de campanha embaixo, do bloco 57.
 *
 * ## A explicação nunca fica escondida
 *
 * *"Score sem explicação não gera ação — o dono não confia e ignora."* Por isso
 * os motivos aparecem **abertos** debaixo de cada nome, e não atrás de um clique:
 * um acordeão faria a tela ficar bonita e a explicação, opcional.
 */

export const metadata: Metadata = {
  title: 'Retenção',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const reais = (centavos: number): string => `R$ ${reaisDoCampo(centavos)}`;
const porcento = (bps: number): string => `${(bps / 100).toFixed(1).replace('.', ',')}%`;

/** Quantos dias a janela cobre por padrão. */
const JANELA_PADRAO = 90;

function diaMenos(dias: number): string {
  return new Date(Date.now() - dias * 86_400_000).toISOString().slice(0, 10);
}

function Indicador({
  chave,
  valor,
}: {
  readonly chave: keyof typeof ROTULO_DO_CRESCIMENTO;
  readonly valor: string | null;
}) {
  return (
    <div className="crescimento__item">
      <span className="crescimento__valor">{valor ?? '—'}</span>
      <span className="crescimento__rotulo">
        {ROTULO_DO_CRESCIMENTO[chave]}
        {/* Subir é bom em tudo menos no abandono. Sem isto a tela diria o
            contrário do número — é o defeito que o comparativo do DRE já achou. */}
        {!SUBIR_E_BOM[chave] ? <span className="crescimento__aviso"> · subir é ruim</span> : null}
      </span>
      <span className="crescimento__porque">{EXPLICACAO_DO_CRESCIMENTO[chave]}</span>
    </div>
  );
}

function Crescimento({ dados }: { readonly dados: CrescimentoNaTelaDoAdmin }) {
  return (
    <section className="cartao-balcao">
      <h2 className="cartao-balcao__titulo">Como a casa vem indo</h2>
      <p className="cartao-balcao__texto">
        De {dados.de.split('-').reverse().join('/')} a {dados.ate.split('-').reverse().join('/')}.
        Nenhum destes números cabe num dia — é por isso que eles não estão no painel de hoje.
      </p>

      <div className="crescimento">
        <Indicador
          chave="retencaoBps"
          valor={dados.retencaoBps === null ? null : porcento(dados.retencaoBps)}
        />
        <Indicador
          chave="churnBps"
          valor={dados.churnBps === null ? null : porcento(dados.churnBps)}
        />
        <Indicador
          chave="valorPorClienteCents"
          valor={dados.valorPorClienteCents === null ? null : reais(dados.valorPorClienteCents)}
        />
        <Indicador
          chave="receitaPorCadeiraCents"
          valor={
            dados.receitaPorCadeiraCents === null ? null : reais(dados.receitaPorCadeiraCents)
          }
        />
        <Indicador
          chave="receitaPorHoraCents"
          valor={dados.receitaPorHoraCents === null ? null : reais(dados.receitaPorHoraCents)}
        />
      </div>

      <h3 className="cartao-balcao__subtitulo">Faturamento por dia</h3>
      <SerieDeFaturamento
        maximoCents={dados.serie.maximoCents}
        mediaCents={dados.serie.mediaCents}
        pontos={dados.serie.pontos}
      />
      <p className="cartao-balcao__texto">
        <strong>{reais(dados.serie.totalCents)}</strong> na janela inteira.
      </p>
    </section>
  );
}

function Cliente({ cliente }: { readonly cliente: ClienteEmChurnNaTela }) {
  return (
    <li>
      <article className="item-cadastro">
        <div className="item-cadastro__quem">
          <h3 className="item-cadastro__nome">
            {cliente.nome}
            <span className={`risco risco--${cliente.faixa}`}>
              {cliente.rotuloDaFaixa} · {cliente.risco}
            </span>
          </h3>
          {/* A explicação, aberta. Atrás de um clique ela vira opcional, e um
              score que ninguém lê o porquê é um score que ninguém usa. */}
          <ul className="motivos">
            {cliente.motivos.map((m) => (
              <li className={`motivos__item motivos__item--${m.sinal}`} key={m.sinal}>
                {m.frase}
              </li>
            ))}
          </ul>
          <p className="item-cadastro__linha">
            <a className="item-cadastro__acao" href={`/admin/cliente/${cliente.customerId}`}>
              Abrir a ficha
            </a>
          </p>
        </div>
      </article>
    </li>
  );
}

export default async function RetencaoPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const query = await searchParams;
  void query;

  const podeVerRisco =
    podeNaTela(estado, 'customers.view') && podeNaTela(estado, 'reviews.view');
  /**
   * A tela esconde o que a API recusaria — as **três**, como a rota declara.
   *
   * Botão que só dá erro é pior que botão ausente, e um cartão que sempre volta
   * vazio ensina a não olhar. A permissão exibida sai da mesma função que a API
   * aplica; ela não é recalculada aqui.
   */
  const podeVerCrescimento =
    podeNaTela(estado, 'finance.view') &&
    podeNaTela(estado, 'reports.finance') &&
    podeNaTela(estado, 'customers.view');

  const [risco, crescimento] = await Promise.all([
    podeVerRisco ? churnNaApi(token) : Promise.resolve(null),
    podeVerCrescimento
      ? crescimentoNaApi(token, diaMenos(JANELA_PADRAO), diaMenos(0))
      : Promise.resolve(null),
  ]);

  const clientes = risco?.ok ? risco.dados.clientes : [];
  const avaliados = risco?.ok ? risco.dados.avaliados : 0;

  return (
    <main className="ui-container painel__conteudo" {...secao('retencao')}>
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

      <h1 className="painel__titulo">Retenção</h1>
      <p className="painel__sub">
        Quem está indo embora, e por quê. Cada nome vem com o motivo ao lado — um número sozinho
        não diz o que fazer em seguida.
      </p>

      {crescimento?.ok ? <Crescimento dados={crescimento.dados} /> : null}

      {podeVerRisco ? (
        <section className="cartao-balcao">
          <h2 className="cartao-balcao__titulo">Quem está em risco de não voltar</h2>
          <p className="cartao-balcao__texto">
            {clientes.length} de {avaliados} clientes com ritmo conhecido. Quem veio poucas vezes
            não entra: sobre essa pessoa o produto ainda não tem o que dizer.
          </p>

          {clientes.length === 0 ? (
            <p className="cartao-balcao__texto">
              Ninguém em risco agora. Quando alguém passar do próprio ritmo, o nome aparece aqui
              com o motivo.
            </p>
          ) : (
            <ul className="lista-cadastro">
              {clientes.map((c) => (
                <Cliente cliente={c} key={c.customerId} />
              ))}
            </ul>
          )}

          <p className="cartao-balcao__texto">
            Para chamar todos de uma vez, use <strong>Passou do ritmo dele</strong> em{' '}
            <a href="/admin/campanhas">Campanhas</a>.
          </p>
        </section>
      ) : null}
    </main>
  );
}
