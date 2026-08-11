import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { MODOS_DE_FIDELIDADE, ROTULO_DO_MODO, type ModoDeFidelidade } from '@barbearia/core';
import { programaDeFidelidade } from '@/lib/admin-api';
import { painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { acaoSalvarFidelidade } from '../acoes';
import { secao } from '../secoes';

/**
 * O programa de fidelidade (bloco 41, SPEC §4.8).
 *
 * ## Uma escolha, e ela é a tela inteira
 *
 * A SPEC manda escolher **um** modelo, e o motivo é o cliente: "você tem 340
 * pontos, 3 visitas e R$ 12 de cashback" é uma frase que ninguém entende no
 * balcão. Por isso o seletor é único e os parâmetros de cada modelo aparecem
 * juntos dele — não há como configurar dois sem querer.
 *
 * ## O que a tela diz antes de a barbearia decidir
 *
 * Cada modelo traz o exemplo em dinheiro de verdade, com o preço de um corte:
 * "num corte de R$ 50, o cliente ganha 50 pontos, que valem R$ 0,50". Escolher
 * entre três palavras abstratas é como uma barbearia liga o programa errado e
 * descobre no mês seguinte.
 */

export const metadata: Metadata = {
  title: 'Fidelidade',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const FALHA: Record<string, string> = {
  programa_invalido: 'Confira os números do programa.',
  invalid_request: 'Confira os dados e tente de novo.',
  forbidden: 'Só quem administra a barbearia muda o programa.',
  request_failed: 'Não deu para salvar. Tente de novo.',
};

/** Um corte de R$ 50 — o preço que a barbearia reconhece de imediato. */
const EXEMPLO_CENTS = 5000;

export default async function FidelidadePage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const busca = await searchParams;
  const estado = await painelOuDesvio(token);
  const podeMexer = podeNaTela(estado, 'settings.manage');

  const resposta = await programaDeFidelidade(token);
  const p = resposta.ok
    ? resposta.dados
    : {
        modo: 'nenhum' as ModoDeFidelidade,
        pontosPorReal: 1,
        valorDoPontoCents: 1,
        visitasParaPremio: 10,
        cashbackBps: 500,
        validadeDias: null,
      };

  const salvo = first(busca['salvo']);
  const erro = first(busca['erro']);

  return (
    <main className="ui-container painel__conteudo fidelidade" {...secao('fidelidade')}>
      <header className="fidelidade__topo">
        <h1 className="titulo">Fidelidade</h1>
        <p className="fidelidade__sub">
          Um modelo por barbearia. Três programas ao mesmo tempo confundem o cliente e ninguém
          usa nenhum.
        </p>
      </header>

      {salvo ? (
        <div className="ui-alert ui-alert--success fidelidade__aviso">Programa salvo.</div>
      ) : null}
      {erro ? (
        <div className="ui-alert ui-alert--danger fidelidade__aviso" role="alert">
          {FALHA[erro] ?? FALHA['request_failed']}
        </div>
      ) : null}

      <form action={acaoSalvarFidelidade} className="fidelidade__form">
        <fieldset className="fidelidade__modos" disabled={!podeMexer}>
          <legend className="rotulo">O que o cliente ganha</legend>
          {MODOS_DE_FIDELIDADE.map((modo) => (
            <label className="fidelidade__modo" key={modo}>
              <input defaultChecked={p.modo === modo} name="modo" type="radio" value={modo} />
              <span>
                <strong>{ROTULO_DO_MODO[modo]}</strong>
                <span className="fidelidade__exemplo">{EXPLICACAO[modo]}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <fieldset className="fidelidade__numeros" disabled={!podeMexer}>
          <legend className="rotulo">Os números</legend>

          <label className="fidelidade__campo">
            <span>Pontos por real gasto</span>
            <input
              className="ui-field__input"
              defaultValue={p.pontosPorReal}
              inputMode="numeric"
              max={100}
              min={1}
              name="pontosPorReal"
              type="number"
            />
          </label>

          <label className="fidelidade__campo">
            <span>Quanto vale um ponto, em centavos</span>
            <input
              className="ui-field__input"
              defaultValue={p.valorDoPontoCents}
              inputMode="numeric"
              max={1000}
              min={1}
              name="valorDoPontoCents"
              type="number"
            />
            {/* Sem este número, "R$ 1 = 1 ponto" na entrada devolveria cem por
                cento do que a pessoa gastou. */}
            <span className="fidelidade__dica">
              Com 1 centavo, um corte de R$ 50 devolve R$ 0,50 — o 1% que o mercado pratica.
            </span>
          </label>

          <label className="fidelidade__campo">
            <span>Cortes para ganhar um grátis</span>
            <input
              className="ui-field__input"
              defaultValue={p.visitasParaPremio}
              inputMode="numeric"
              max={100}
              min={2}
              name="visitasParaPremio"
              type="number"
            />
          </label>

          <label className="fidelidade__campo">
            <span>Cashback, em %</span>
            <input
              className="ui-field__input"
              defaultValue={(p.cashbackBps / 100).toString()}
              inputMode="decimal"
              max={50}
              min={0}
              name="cashbackPercent"
              step="0.5"
              type="number"
            />
          </label>

          <label className="fidelidade__campo">
            <span>Validade, em dias</span>
            <input
              className="ui-field__input"
              defaultValue={p.validadeDias ?? ''}
              inputMode="numeric"
              max={3650}
              min={30}
              name="validadeDias"
              placeholder="não vence"
              type="number"
            />
            <span className="fidelidade__dica">Vazio significa que o saldo não vence.</span>
          </label>
        </fieldset>

        {podeMexer ? (
          <button className="ui-button ui-button--primary" type="submit">
            Salvar programa
          </button>
        ) : (
          <p className="fidelidade__dica">
            Você pode ver o programa, mas só quem administra a barbearia o altera.
          </p>
        )}
      </form>

      <section className="fidelidade__nota">
        <h2 className="rotulo">Como o saldo é gasto</h2>
        <p>
          Na comanda, o resgate entra como <strong>forma de pagamento</strong> — não como
          desconto. Desconto é a casa abrindo mão de receita; resgate é o cliente gastando um
          crédito que já é dele, e por isso não conta no teto de desconto da equipe.
        </p>
        <p>
          O saldo só entra sobre o que foi pago de verdade: uma conta paga inteira com crédito
          não gera crédito novo.
        </p>
      </section>
    </main>
  );
}

const EXPLICACAO: Readonly<Record<ModoDeFidelidade, string>> = {
  nenhum: 'Ninguém acumula nada. É como a barbearia começa.',
  pontos: `Num corte de R$ ${(EXEMPLO_CENTS / 100).toFixed(0)}, o cliente ganha pontos que ele troca por desconto depois.`,
  visitas: 'A cada X cortes pagos, o próximo sai de graça. É o cartãozinho carimbado.',
  cashback: `Uma parte do que ele gastou volta como crédito em reais. Em R$ ${(EXEMPLO_CENTS / 100).toFixed(0)} a 5%, são R$ 2,50.`,
};
