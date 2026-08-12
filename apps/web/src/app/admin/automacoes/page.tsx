import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  EXPLICACAO_DA_FALHA,
  GATILHOS,
  GATILHOS_COM_VARREDURA,
  JANELA_MAXIMA_DIAS,
  LIMIAR_DO_GATILHO,
  OBJETIVOS,
  ROTULO_DO_GATILHO,
  ROTULO_DO_OBJETIVO,
  TIPOS_DE_NOTIFICACAO,
  type Gatilho,
  type Objetivo,
} from '@barbearia/core';
import { automacoesNaApi, type AutomacaoNaTelaDoAdmin } from '@/lib/admin-api';
import { painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { acaoSalvarAutomacao, acaoSair } from '../acoes';
import { secao } from '../secoes';

/**
 * As automações (bloco 56, SPEC §4.11).
 *
 * ## A coluna que decide se a automação vive
 *
 * *"Toda automação declara o objetivo mensurável. Sem isso não há como desligar
 * o que não funciona."* Por isso cada linha mostra **enviadas e alcançadas**
 * lado a lado, e não só o nome: uma automação sem esses dois números é uma
 * mensagem que ninguém consegue defender nem matar — ela some no meio do custo
 * e fica ligada para sempre.
 *
 * ## Os gatilhos que ainda não varrem aparecem, e dizem isso
 *
 * Escondê-los faria a lista parecer a SPEC inteira entregue. Mostrá-los sem
 * aviso faria a barbearia ligar um que nunca dispara e concluir que o produto
 * está quebrado. Eles aparecem marcados.
 */

export const metadata: Metadata = {
  title: 'Automações',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const NOME_DO_AVISO: Record<string, string> = {
  confirmacao: 'Confirmação do agendamento',
  lembrete_24h: 'Lembrete de 24 horas',
  lembrete_2h: 'Lembrete de 2 horas',
  sua_vez: 'Sua vez na fila',
  senha_de_acesso: 'Senha de primeiro acesso',
  retorno: 'Convite de retorno',
};

function Automacao({ automacao }: { readonly automacao: AutomacaoNaTelaDoAdmin }) {
  const gatilho = automacao.gatilho as Gatilho;
  const varre = (GATILHOS_COM_VARREDURA as readonly string[]).includes(gatilho);
  return (
    <li>
      <article className={`item-cadastro${automacao.ativa ? '' : ' item-cadastro--fora'}`}>
        <div className="item-cadastro__cabeca">
          <div className="item-cadastro__quem">
            <h3 className="item-cadastro__nome">{automacao.nome}</h3>
            <p className="item-cadastro__linha">
              {ROTULO_DO_GATILHO[gatilho]}
              {automacao.limiar !== null ? ` · ${automacao.limiar}` : ''} ·{' '}
              {ROTULO_DO_OBJETIVO[automacao.objetivo as Objetivo]} em {automacao.janelaDias} dias
            </p>
            <p className="item-cadastro__linha">
              {automacao.ativa ? 'Ligada' : 'Desligada'} · manda{' '}
              {NOME_DO_AVISO[automacao.tipo] ?? automacao.tipo}
            </p>
            {/*
              Os dois números que decidem desligar. Sem eles a lista seria de
              automações que ninguém consegue defender nem matar.
            */}
            <p className="item-cadastro__linha">
              {automacao.enviadas} enviada{automacao.enviadas === 1 ? '' : 's'} ·{' '}
              {automacao.alcancadas} alcançou o objetivo
              {automacao.enviadas > 0
                ? ` (${Math.round((automacao.alcancadas / automacao.enviadas) * 100)}%)`
                : ''}
            </p>
            {!varre ? (
              <p className="item-cadastro__linha item-cadastro__risco">
                Este gatilho ainda não dispara sozinho — a varredura dele entra num bloco
                seguinte.
              </p>
            ) : null}
          </div>
        </div>
      </article>
    </li>
  );
}

export default async function AutomacoesPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const query = await searchParams;
  const podeMexer = podeNaTela(estado, 'marketing.send');

  const resposta = podeMexer ? await automacoesNaApi(token) : null;
  const automacoes = resposta?.ok ? resposta.dados.automacoes : [];
  const erro = first(query['erro']);
  const salva = first(query['feito']) === 'salva';

  return (
    <main className="ui-container painel__conteudo" {...secao('automacoes')}>
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

      <h1 className="painel__titulo">Automações</h1>
      <p className="painel__sub">
        O que a casa manda sozinha quando um fato acontece. Cada uma declara o que promete
        produzir — é o número que diz se ela vale o que custa.
      </p>

      {erro ? (
        <div className="ui-alert ui-alert--erro painel__aviso" role="alert">
          {EXPLICACAO_DA_FALHA[erro as keyof typeof EXPLICACAO_DA_FALHA] ??
            'Não deu para salvar. Tente de novo.'}
        </div>
      ) : null}
      {salva ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Automação salva. A varredura roda de hora em hora.
        </div>
      ) : null}

      <section className="cartao-balcao">
        <h2 className="cartao-balcao__titulo">O que está ligado</h2>
        <p className="cartao-balcao__texto">
          Ninguém recebe duas automações no mesmo dia, e nada sai entre 21h e 8h. Promoção
          respeita quem pediu para não receber e o teto de quatro por mês.
        </p>

        {automacoes.length === 0 ? (
          <p className="cartao-balcao__texto">
            Nenhuma ainda. A que mais traz gente de volta é a de quem sumiu: escolha o número de
            dias que corresponde ao intervalo normal da sua clientela.
          </p>
        ) : (
          <ul className="lista-cadastro">
            {automacoes.map((a) => (
              <Automacao automacao={a} key={a.id} />
            ))}
          </ul>
        )}
      </section>

      {podeMexer ? (
        <section className="cartao-balcao">
          <h2 className="cartao-balcao__titulo">Nova automação</h2>
          <form action={acaoSalvarAutomacao} className="formulario">
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="nome">
                Nome
              </label>
              <input
                className="ui-field__input"
                id="nome"
                maxLength={80}
                name="nome"
                placeholder="Volta pro corte"
                required
              />
              <p className="ui-field__hint">Só para você reconhecer depois.</p>
            </div>

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="gatilho">
                Quando disparar
              </label>
              <select className="ui-field__input" id="gatilho" name="gatilho" required>
                {/*
                  O rótulo do número vai **dentro da opção**, e não numa dica
                  abaixo. A dica teria que listar os sete significados de uma
                  vez — foi o que a primeira versão fez, e virou um parágrafo de
                  seis linhas que ninguém lê, o mesmo defeito que a tela fiscal
                  teve com as explicações de regime. O produto não tem componente
                  de cliente para trocar o texto ao mexer no seletor; pôr o
                  rótulo na opção resolve sem JavaScript.
                */}
                {GATILHOS.map((g) => (
                  <option key={g} value={g}>
                    {ROTULO_DO_GATILHO[g]}
                    {LIMIAR_DO_GATILHO[g] ? ` — ${LIMIAR_DO_GATILHO[g]}` : ''}
                    {(GATILHOS_COM_VARREDURA as readonly string[]).includes(g)
                      ? ''
                      : ' (ainda não dispara)'}
                  </option>
                ))}
              </select>
            </div>

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="limiar">
                O número do gatilho
              </label>
              <input
                className="ui-field__input"
                id="limiar"
                inputMode="numeric"
                name="limiar"
                placeholder="30"
              />
              <p className="ui-field__hint">
                O que ele significa está escrito na opção que você escolheu acima. Gatilho que
                não pede número: deixe em branco.
              </p>
            </div>

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="atrasoMinutos">
                Esperar quantos minutos depois do fato
              </label>
              <input
                className="ui-field__input"
                defaultValue="0"
                id="atrasoMinutos"
                inputMode="numeric"
                name="atrasoMinutos"
              />
              <p className="ui-field__hint">
                Zero manda assim que a varredura passa. "Como foi seu atendimento?" enquanto a
                pessoa ainda está pagando não é pesquisa, é constrangimento.
              </p>
            </div>

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="tipo">
                Qual mensagem
              </label>
              <select className="ui-field__input" defaultValue="retorno" id="tipo" name="tipo">
                {TIPOS_DE_NOTIFICACAO.map((t) => (
                  <option key={t} value={t}>
                    {NOME_DO_AVISO[t] ?? t}
                  </option>
                ))}
              </select>
              <p className="ui-field__hint">
                O texto sai do template aprovado pela Meta, em WhatsApp.
              </p>
            </div>

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="objetivo">
                O que ela precisa produzir
              </label>
              <select className="ui-field__input" id="objetivo" name="objetivo" required>
                {OBJETIVOS.map((o) => (
                  <option key={o} value={o}>
                    {ROTULO_DO_OBJETIVO[o]}
                  </option>
                ))}
              </select>
            </div>

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="janelaDias">
                Em quantos dias
              </label>
              <input
                className="ui-field__input"
                defaultValue="7"
                id="janelaDias"
                inputMode="numeric"
                max={JANELA_MAXIMA_DIAS}
                min={1}
                name="janelaDias"
              />
              <p className="ui-field__hint">
                De 1 a {JANELA_MAXIMA_DIAS}. Janela larga demais dá crédito a esta mensagem por
                um corte que a pessoa marcaria de qualquer jeito.
              </p>
            </div>

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="ativa">
                <input defaultChecked id="ativa" name="ativa" type="checkbox" /> Ligada
              </label>
            </div>

            <button className="ui-button ui-button--primary ui-button--block" type="submit">
              Salvar automação
            </button>
          </form>
        </section>
      ) : null}
    </main>
  );
}
