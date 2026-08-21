import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import {
  ROTULO_DO_ASSUNTO,
  assuntoDaChave,
  assuntoDaPergunta,
  type AssuntoDaRecepcao,
} from '@barbearia/core';
import { lacunasDaRecepcaoNaApi, type LacunaNaTela } from '@/lib/admin-api';
import { painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { acaoResolverLacuna, acaoSair } from '../acoes';
import { secao } from '../secoes';
import { AvisoDeRecusa } from '@/app/admin/aviso-de-recusa';
import { marcaDaRecusa } from '../falha-da-leitura';

/**
 * As perguntas que a recepção digital não soube responder (bloco 66, SPEC §4.17).
 *
 * > *"Essa lista de lacunas é, sozinha, um produto útil."*
 *
 * Esta tela é aquela frase. O produto óbvio do bloco seria um chatbot que
 * escala para humano quando não sabe; o que a SPEC pede é **medir o que ninguém
 * consegue responder** e devolver isso como tarefa. "Dezoito pessoas
 * perguntaram se você abre no domingo" é trabalho a fazer; "não sei responder" é
 * um problema que some no log.
 *
 * ## Por isso ela não é uma lista de perguntas — é uma lista de cadastros que
 * faltam
 *
 * Cada linha diz **onde se resolve**, pela mesma função que a recepção usa para
 * decidir o que responder. Uma lista que só mostra a pergunta obriga o dono a
 * adivinhar em qual das trinta telas do painel está o campo — e a lista que
 * obriga a adivinhar é a que ninguém abre duas vezes.
 *
 * ## Resolver não é apagar
 *
 * Não há botão de apagar, e não é esquecimento: a aplicação não tem `DELETE`
 * nesta tabela. Marcar como resolvida é estado, a linha continua contando, e
 * **perguntar de novo reabre** — se o dono marcou e o cliente seguinte continua
 * sem resposta, a pergunta volta para cá em vez de ficar escondida para sempre.
 */

export const metadata: Metadata = {
  title: 'Recepção',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const FALHA: Record<string, string> = {
  lacuna_ja_resolvida: 'Alguém da equipe já marcou esta pergunta como resolvida.',
  forbidden: 'Você não tem permissão para mexer nesta lista.',
  request_failed: 'Não deu para salvar. Tente de novo.',
};

/**
 * Onde cada assunto se cadastra.
 *
 * `Record` sobre a **união**, e não sobre `string`: assunto novo em `core` faz o
 * compilador cobrar a linha aqui, em vez de a tela mostrar uma lacuna sem
 * caminho. `null` é o assunto que ainda não tem onde cadastrar — e ele aparece
 * marcado, nunca escondido. Desde o bloco 127 nenhum é `null`: formas de
 * pagamento era o último, e a coluna dele existia desde a migração 0013.
 */
const ONDE_SE_RESOLVE: Readonly<
  Record<AssuntoDaRecepcao, { readonly href: string; readonly tela: string } | null>
> = {
  preco: { href: '/admin/catalogo', tela: 'Serviços' },
  horario_de_funcionamento: { href: '/admin/configuracoes', tela: 'Configurações' },
  jornada_do_profissional: { href: '/admin/profissionais', tela: 'Profissionais' },
  endereco: { href: '/admin/configuracoes', tela: 'Configurações' },
  politica_de_cancelamento: { href: '/admin/configuracoes', tela: 'Configurações' },
  formas_de_pagamento: { href: '/admin/configuracoes', tela: 'Configurações' },
};

export default async function RecepcaoPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const busca = await searchParams;
  const estado = await painelOuDesvio(token);
  const podeMexer = podeNaTela(estado, 'feedback.manage');

  const resposta = await lacunasDaRecepcaoNaApi(token);
  const lacunas = resposta.ok ? resposta.dados.lacunas : [];
  const perguntas = lacunas.reduce((soma, l) => soma + l.vezes, 0);

  const feito = first(busca['feito']);
  const erro = first(busca['erro']);

  return (
    <main className="ui-container recepcao" {...secao('recepcao')}>
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
      <header className="recepcao__topo">
        <h1 className="titulo">Recepção</h1>
        <p className="recepcao__sub">
          O que as pessoas perguntaram pela sua página e a barbearia não tinha cadastrado para
          responder. Cadastre o que falta e a resposta passa a sair sozinha.
        </p>
      </header>

      {feito ? (
        <div className="ui-alert ui-alert--success recepcao__aviso">
          Pergunta marcada como resolvida. Se alguém perguntar de novo, ela volta para esta lista.
        </div>
      ) : null}
      {erro ? (
        <AvisoDeRecusa erro={erro} mapa={FALHA} className="recepcao__aviso" />
      ) : null}

      {!resposta.ok ? (
        <div className="vazio" {...marcaDaRecusa(resposta.code)}>
          {/* O título muda com o motivo: "não deu para carregar" sobre um 403 é
              a recusa vestida de falha passageira, e manda recarregar para
              sempre uma tela que nunca vai abrir. */}
          <p className="vazio__titulo">
            {resposta.code === 'forbidden' ? 'Esta tela não é da sua conta' : 'Não deu para carregar as perguntas'}
          </p>
          <p className="vazio__saida">
            {resposta.code === 'forbidden'
              ? 'Você não tem permissão para ver esta lista. Fale com o dono.'
              : 'Recarregue a página.'}
          </p>
        </div>
      ) : lacunas.length === 0 ? (
        /* Estado vazio desenhado — e aqui vazio é boa notícia, o que a tela diz. */
        <div className="vazio">
          <p className="vazio__titulo">Nenhuma pergunta ficou sem resposta</p>
          <p className="vazio__saida">
            Quando alguém perguntar algo pela sua página e a barbearia não tiver aquele dado
            cadastrado, a pergunta aparece aqui — com quantas pessoas perguntaram a mesma coisa.
          </p>
        </div>
      ) : (
        <>
          {/* O número que dá tamanho ao problema: sem ele, quatro linhas parecem
              quatro pessoas, e podem ser oitenta. */}
          <p className="recepcao__resumo">
            <strong className="tabular">{perguntas}</strong>{' '}
            {perguntas === 1 ? 'pergunta ficou' : 'perguntas ficaram'} sem resposta,{' '}
            {lacunas.length === 1 ? 'em 1 pergunta' : `em ${lacunas.length} perguntas diferentes`}.
          </p>

          <ul className="recepcao__lista">
            {lacunas.map((lacuna) => (
              <li key={lacuna.id}>
                <Lacuna lacuna={lacuna} podeMexer={podeMexer} />
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}

function Lacuna({ lacuna, podeMexer }: { lacuna: LacunaNaTela; podeMexer: boolean }) {
  /**
   * Sem o texto, a chave.
   *
   * O texto cru tem prazo de guarda — alguém pode ter digitado o próprio nome
   * dentro da pergunta, e sem `customer_id` esse texto não é alcançável pela
   * anonimização. O que não vence é a chave normalizada, e é ela que a tela
   * mostra depois do prazo: sem acento e sem pontuação, mas ainda a pergunta.
   */
  const assunto = assuntoDaChave(lacuna.chave) ?? assuntoDaPergunta(lacuna.pergunta ?? '');
  const onde = assunto ? ONDE_SE_RESOLVE[assunto] : null;

  return (
    <article className="lacuna">
      <header className="lacuna__topo">
        {/* O contador é o que ordena a lista e o que decide o que arrumar
            primeiro — por isso ele vem antes da pergunta, não depois. */}
        <span className="lacuna__vezes tabular">
          {lacuna.vezes}
          <span className="lacuna__vezes-rotulo">{lacuna.vezes === 1 ? 'vez' : 'vezes'}</span>
        </span>
        <p className="lacuna__pergunta">
          {lacuna.pergunta
            ? `“${lacuna.pergunta}”`
            : (assunto ? ROTULO_DO_ASSUNTO[assunto] : lacuna.chave)}
        </p>
      </header>

      <p className="lacuna__onde">
        {assunto && onde ? (
          <>
            {ROTULO_DO_ASSUNTO[assunto]} — cadastre em{' '}
            <a className="lacuna__link" href={onde.href}>
              {onde.tela}
            </a>
            .
          </>
        ) : assunto ? (
          /* Assunto conhecido e sem cadastro: aparece marcado, nunca escondido.
             Esconder faria a lista dizer que o produto responde algo que ele não
             responde. */
          <>{ROTULO_DO_ASSUNTO[assunto]} — ainda não há onde cadastrar isso no produto.</>
        ) : (
          <>Sem assunto reconhecido — responda esta pessoa pelo WhatsApp da casa.</>
        )}
      </p>

      <p className="lacuna__quando">
        Última vez em {dia(lacuna.ultimaVez)}
        {lacuna.vezes > 1 ? ` · a primeira foi em ${dia(lacuna.primeiraVez)}` : ''}
      </p>

      {podeMexer ? (
        <form action={acaoResolverLacuna} className="lacuna__acoes">
          <input name="id" type="hidden" value={lacuna.id} />
          <button className="ui-button ui-button--secondary lacuna__acao" type="submit">
            Já cadastrei
          </button>
        </form>
      ) : null}
    </article>
  );
}

const dia = (iso: string): string =>
  new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
