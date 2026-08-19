import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import {
  precificacaoDaCasa,
  recomendacoesDePreco,
  type FaixaNaTela,
  type RecomendacaoNaTela,
} from '@/lib/admin-api';
import { reaisDoCampo } from '@/lib/dinheiro';
import { painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { acaoApagarFaixa, acaoCriarFaixa, acaoLigarPrecoPorFaixa, acaoSair } from '../acoes';
import { secao } from '../secoes';

/**
 * Preço por faixa de horário (bloco 68, SPEC §4.20).
 *
 * > *"A IA **recomenda**, o administrador **aprova**."*
 *
 * A tela inteira é essa frase. A sugestão aparece com o número que a sustenta —
 * ocupação medida e ganho estimado —, e o botão dela **preenche o cadastro**:
 * não existe caminho em que uma recomendação vire regra sem alguém clicar.
 *
 * ## O interruptor vem antes da lista, e é de propósito
 *
 * *"Nunca alterar preço automaticamente sem autorização configurada
 * explicitamente."* Com ele desligado as faixas ficam cadastradas e inertes, e
 * a tela diz isso em letras — esconder as faixas faria a barbearia achar que
 * perdeu o cadastro; mostrá-las sem o aviso faria ela achar que o preço mudou.
 *
 * ## O que a tela promete e não pode deixar de cumprir
 *
 * O preço mostrado ao cliente é travado no momento da reserva. Mudar uma faixa
 * aqui não mexe em nada que já foi marcado, e a tela escreve isso ao lado do
 * botão de remover — senão a recepção desfaz uma regra achando que está
 * corrigindo um agendamento.
 */

export const metadata: Metadata = {
  title: 'Preços por horário',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const primeiro = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const FALHA: Record<string, string> = {
  faixa_sobreposta:
    'Já existe uma faixa nesse dia e horário. Ajuste a que existe ou mude o intervalo.',
  invalid_request: 'Confira o dia, o horário e a variação.',
  forbidden: 'Você não tem permissão para mexer nos preços.',
  request_failed: 'Não deu para salvar. Tente de novo.',
};

const DIAS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

const hora = (minuto: number): string =>
  `${String(Math.floor(minuto / 60)).padStart(2, '0')}:${String(minuto % 60).padStart(2, '0')}`;

/** `+10%` / `−10%`, com o sinal que a pessoa lê antes do número. */
const variacao = (bps: number): string =>
  `${bps > 0 ? '+' : '−'}${Math.abs(bps / 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;

export default async function PrecosPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const busca = await searchParams;
  const estado = await painelOuDesvio(token);
  const podeMexer = podeNaTela(estado, 'settings.manage');
  const podeVerGanho = podeNaTela(estado, 'finance.view');

  const [dados, sugestoes] = await Promise.all([
    precificacaoDaCasa(token),
    /**
     * O ganho estimado é receita, e por isso a rota pede `finance.view`.
     *
     * Pedi-la sem a permissão devolveria 403 em toda abertura da tela, e o
     * bloco de sugestões apareceria vazio para quem nunca poderá vê-lo.
     */
    podeVerGanho ? recomendacoesDePreco(token) : Promise.resolve(null),
  ]);

  const erro = primeiro(busca['erro']);
  const feito = primeiro(busca['feito']);
  const config = dados.ok ? dados.dados : null;
  const recomendacoes = sugestoes?.ok ? sugestoes.dados.recomendacoes : [];

  return (
    <main className="ui-container precos" {...secao('precos')}>
      {/*
        O cabeçalho com a volta e o Sair (bloco 104).

        Quatro telas do painel não o tinham, e ninguém notava: dezenove
        acertavam por hábito. Sem o Sair, a sessão fica aberta na máquina do
        balcão; sem a volta, a tela é caminho de ida (§6, pergunta 1).
      */}
      <header className="painel__topo">
        <a className="painel__marca" href="/admin/painel">← {estado.businessName}</a>
        <form action={acaoSair}>
          <button className="ui-button ui-button--ghost painel__sair" type="submit">Sair</button>
        </form>
      </header>
      <header className="precos__topo">
        <h1 className="titulo">Preços por horário</h1>
        <p className="precos__sub">
          Cobre menos na hora vazia e mais na hora disputada. O preço é travado quando o cliente
          marca — mexer aqui não altera nenhum horário já agendado.
        </p>
      </header>

      {feito ? <div className="ui-alert ui-alert--success precos__aviso">Pronto.</div> : null}
      {erro ? (
        <div className="ui-alert ui-alert--danger precos__aviso" role="alert">
          {FALHA[erro] ?? FALHA['request_failed']}
        </div>
      ) : null}

      {!config ? (
        <div className="vazio">
          <p className="vazio__titulo">Não deu para carregar os preços</p>
          <p className="vazio__saida">
            {dados.ok === false && dados.code === 'forbidden'
              ? 'Você não tem permissão para ver esta tela. Fale com o dono.'
              : 'Recarregue a página.'}
          </p>
        </div>
      ) : (
        <>
          <section className="quadro precos__interruptor">
            <div className="quadro__topo">
              <div>
                <p className="quadro__titulo">
                  {config.ligado ? 'Preço por horário está valendo' : 'Preço por horário desligado'}
                </p>
                <p className="quadro__sub">
                  {config.ligado
                    ? `Nenhuma faixa pode passar de ${variacao(config.tetoBps)} — o que passar é aparado.`
                    : 'As faixas abaixo ficam cadastradas e não mudam preço nenhum enquanto isto estiver desligado.'}
                </p>
              </div>
              {podeMexer ? (
                <form action={acaoLigarPrecoPorFaixa}>
                  <input name="ligado" type="hidden" value={config.ligado ? '0' : '1'} />
                  <button
                    className={`ui-button ${config.ligado ? 'ui-button--ghost' : 'ui-button--primary'} precos__acao`}
                    type="submit"
                  >
                    {config.ligado ? 'Desligar' : 'Ligar'}
                  </button>
                </form>
              ) : null}
            </div>
          </section>

          {recomendacoes.length > 0 ? (
            <>
              <div className="painel-secao__cabeca">
                <h2 className="avisos__titulo">Sugestões</h2>
                <span className="painel-secao__nota">
                  só hora cheia, e nada muda sem você aprovar
                </span>
              </div>
              <ul className="precos__sugestoes">
                {recomendacoes.map((sugestao) => (
                  <li key={`${sugestao.diaDaSemana}-${sugestao.hora}`}>
                    <Sugestao podeMexer={podeMexer} sugestao={sugestao} />
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          <div className="painel-secao__cabeca">
            <h2 className="avisos__titulo">Faixas cadastradas</h2>
          </div>

          {config.faixas.length === 0 ? (
            /* Estado vazio desenhado: diz o que a lista é e como sair dela. */
            <p className="precos__vazio">
              Nenhuma faixa ainda. Uma faixa é um pedaço do dia — “terça das 13h às 16h” — com um
              desconto ou um acréscimo sobre o preço de tabela.
            </p>
          ) : (
            <ul className="precos__lista">
              {config.faixas.map((faixa) => (
                <li key={faixa.id}>
                  <Faixa faixa={faixa} podeMexer={podeMexer} tetoBps={config.tetoBps} />
                </li>
              ))}
            </ul>
          )}

          {podeMexer ? <Formulario tetoBps={config.tetoBps} /> : null}
        </>
      )}
    </main>
  );
}

function Faixa({
  faixa,
  podeMexer,
  tetoBps,
}: {
  readonly faixa: FaixaNaTela;
  readonly podeMexer: boolean;
  readonly tetoBps: number;
}) {
  /**
   * O efeito **aplicado**, ao lado do cadastrado.
   *
   * Uma faixa de −40% com teto de 15% desconta 15%. Sem o número na tela, a
   * barbearia acha que o produto ignorou a regra dela.
   */
  const aplicado = Math.max(-tetoBps, Math.min(tetoBps, faixa.deltaBps));

  return (
    <article className="faixa">
      <div className="faixa__quando">
        <p className="faixa__dia">{DIAS[faixa.diaDaSemana]}</p>
        <p className="faixa__hora tabular">
          {hora(faixa.inicioMinuto)} às {hora(faixa.fimMinuto)}
        </p>
      </div>
      <p className={`faixa__delta tabular${faixa.deltaBps < 0 ? ' faixa__delta--desconto' : ''}`}>
        {variacao(aplicado)}
        {aplicado !== faixa.deltaBps ? (
          <span className="faixa__aparada">cadastrado {variacao(faixa.deltaBps)}, aparado no teto</span>
        ) : null}
      </p>
      {podeMexer ? (
        <form action={acaoApagarFaixa}>
          <input name="id" type="hidden" value={faixa.id} />
          <button className="ui-button ui-button--ghost faixa__acao" type="submit">
            Remover
          </button>
        </form>
      ) : null}
    </article>
  );
}

function Sugestao({
  sugestao,
  podeMexer,
}: {
  readonly sugestao: RecomendacaoNaTela;
  readonly podeMexer: boolean;
}) {
  const inicio = sugestao.hora * 60;
  return (
    <article className="sugestao">
      <p className="sugestao__titulo">
        {DIAS[sugestao.diaDaSemana]} às {hora(inicio)} está com{' '}
        {Math.round(sugestao.ocupacaoBps / 100)}% de ocupação
      </p>
      <p className="sugestao__texto">
        Um acréscimo de {variacao(sugestao.deltaBps)} nesse horário renderia cerca de{' '}
        <strong>R$ {reaisDoCampo(sugestao.ganhoMensalCents)}</strong> por mês — são as mesmas
        pessoas que já vêm, pagando a diferença. Subir preço muda a procura, e esta conta não sabe
        disso.
      </p>
      {podeMexer ? (
        /* Aprovar **é** cadastrar. Não existe caminho em que a sugestão vire
           regra sem alguém clicar aqui. */
        <form action={acaoCriarFaixa} className="sugestao__acoes">
          <input name="diaDaSemana" type="hidden" value={sugestao.diaDaSemana} />
          <input name="inicioMinuto" type="hidden" value={inicio} />
          <input name="fimMinuto" type="hidden" value={inicio + 60} />
          <input name="deltaBps" type="hidden" value={sugestao.deltaBps} />
          <button className="ui-button ui-button--secondary sugestao__acao" type="submit">
            Criar esta faixa
          </button>
        </form>
      ) : null}
    </article>
  );
}

function Formulario({ tetoBps }: { readonly tetoBps: number }) {
  return (
    <form action={acaoCriarFaixa} className="quadro precos__form">
      <p className="quadro__titulo">Nova faixa</p>
      <div className="precos__campos">
        {/* `ui-field` e `ui-field__input`, que é o que o design system define.
            A primeira versão inventou uma classe `ui-input` que não existe: os
            campos ficaram sem estilo nenhum e a medição os pegou com 19px, bem
            abaixo dos 44px de alvo de toque. */}
        <div className="ui-field precos__campo">
          <label className="ui-field__label" htmlFor="faixa-dia">
            Dia
          </label>
          <select className="ui-field__input" defaultValue="2" id="faixa-dia" name="diaDaSemana">
            {DIAS.map((nome, indice) => (
              <option key={nome} value={indice}>
                {nome}
              </option>
            ))}
          </select>
        </div>
        <div className="ui-field precos__campo">
          <label className="ui-field__label" htmlFor="faixa-inicio">
            Das
          </label>
          <input
            className="ui-field__input"
            defaultValue="780"
            id="faixa-inicio"
            max="1440"
            min="0"
            name="inicioMinuto"
            step="30"
            type="number"
          />
        </div>
        <div className="ui-field precos__campo">
          <label className="ui-field__label" htmlFor="faixa-fim">
            Às
          </label>
          <input
            className="ui-field__input"
            defaultValue="960"
            id="faixa-fim"
            max="1440"
            min="0"
            name="fimMinuto"
            step="30"
            type="number"
          />
        </div>
        <div className="ui-field precos__campo">
          <label className="ui-field__label" htmlFor="faixa-delta">
            Variação
          </label>
          <select className="ui-field__input" defaultValue="-1000" id="faixa-delta" name="deltaBps">
            {[-1500, -1000, -500, 500, 1000, 1500].map((bps) => (
              <option key={bps} value={bps}>
                {variacao(bps)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {/* O horário é em minutos desde a meia-noite porque é assim que toda
          janela deste produto é guardada; a dica traduz para quem digita. */}
      <p className="precos__dica">
        O horário é em minutos desde a meia-noite: 780 é 13h, 960 é 16h. Nada pode passar de{' '}
        {variacao(tetoBps)}.
      </p>
      <button className="ui-button ui-button--primary precos__salvar" type="submit">
        Criar faixa
      </button>
    </form>
  );
}
