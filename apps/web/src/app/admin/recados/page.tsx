import type { Metadata } from 'next';
import {
  MAXIMO_DA_RESPOSTA,
  ROTULO_DO_RECADO,
  ROTULO_DO_TIPO,
  type EstadoDoRecado,
  type TipoDeRecado,
} from '@barbearia/core';
import { recadosDaFila, type RecadoNaTela } from '@/lib/admin-api';
import { painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { redirect } from 'next/navigation';
import { acaoAssumirRecado, acaoDevolverRecado, acaoEncerrarRecado, acaoResponderRecado, acaoSair } from '../acoes';
import { secao } from '../secoes';
import { AvisoDeRecusa } from '@/app/admin/aviso-de-recusa';

/**
 * A fila de recados (bloco 40).
 *
 * ## O que esta tela é, e o que ela não é
 *
 * Não é a caixa de avaliações — aquilo é nota presa a atendimento, e é o bloco
 * 43. Aqui chega o que o cliente quis dizer sem ter nota para dar, inclusive
 * quem nunca foi atendido: a fila é o canal de melhoria da casa.
 *
 * ## A ordem não é cronológica, e é de propósito
 *
 * Reclamação vem antes de elogio mais antigo. Quem reclamou está insatisfeito
 * **agora**, e um elogio de ontem esperando na frente dele é a fila trabalhando
 * contra si mesma. Quem já tem dono sai da frente: não está esperando triagem,
 * está esperando alguém que já sabe que existe.
 *
 * ## Encerrar não é apagar
 *
 * Não há botão de apagar, e não é esquecimento: a SPEC §4.10 proíbe oferecer
 * "apagar avaliação ruim", e aqui a proibição está no banco — a aplicação não
 * tem `DELETE` nesta tabela. O texto encerrado continua contando.
 */

export const metadata: Metadata = {
  title: 'Recados',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const FEITO: Record<string, string> = {
  assumido: 'Recado assumido.',
  devolvido: 'Recado devolvido à fila de triagem.',
  respondido: 'Resposta enviada para o cliente.',
  encerrado: 'Recado encerrado. O texto continua na base.',
};

const FALHA: Record<string, string> = {
  sem_contato:
    'Este recado é anônimo — quem escreveu não deixou celular, então não há para onde responder. Dá para encerrar depois de resolver.',
  transicao_invalida: 'Este recado já está encerrado.',
  recado_nao_encontrado: 'Este recado não existe mais.',
  responsavel_desconhecido: 'Esta pessoa não faz parte da equipe.',
  resposta_vazia: 'Escreva a resposta.',
  resposta_longa: `A resposta passa de ${MAXIMO_DA_RESPOSTA} caracteres.`,
  forbidden: 'Você não tem permissão para mexer nos recados.',
  request_failed: 'Não deu para salvar. Tente de novo.',
};

export default async function RecadosPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const busca = await searchParams;
  const estado = await painelOuDesvio(token);
  const podeMexer = podeNaTela(estado, 'feedback.manage');
  const verEncerrados = first(busca['todos']) === '1';

  const fila = await recadosDaFila(token, verEncerrados);
  const recados = fila.ok ? fila.dados.recados : [];

  const feito = first(busca['feito']);
  const erro = first(busca['erro']);

  return (
    <main className="ui-container recados" {...secao('recados')}>
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
      <header className="recados__topo">
        <h1 className="titulo">Recados</h1>
        <p className="recados__sub">
          O que os clientes escreveram pela página da barbearia. Nada disto aparece em lugar
          nenhum público.
        </p>
      </header>

      {feito ? (
        <div className="ui-alert ui-alert--success recados__aviso">{FEITO[feito] ?? 'Pronto.'}</div>
      ) : null}
      {erro ? (
        <AvisoDeRecusa erro={erro} mapa={FALHA} className="recados__aviso" />
      ) : null}

      {!fila.ok ? (
        <div className="vazio">
          <p className="vazio__titulo">Não deu para carregar os recados</p>
          <p className="vazio__saida">
            {fila.code === 'forbidden'
              ? 'Você não tem permissão para ver esta fila. Fale com o dono.'
              : 'Recarregue a página.'}
          </p>
        </div>
      ) : recados.length === 0 ? (
        /* Estado vazio desenhado: diz o que é e o que faz aparecer alguém. */
        <div className="vazio">
          <p className="vazio__titulo">
            {verEncerrados ? 'Nenhum recado até agora' : 'Nenhum recado esperando'}
          </p>
          <p className="vazio__saida">
            O link “Fale com a gente” fica na sua página pública. Sugestões, reclamações e
            elogios chegam aqui.
          </p>
        </div>
      ) : (
        <ul className="recados__lista">
          {recados.map((recado) => (
            <li key={recado.id}>
              <Cartao podeMexer={podeMexer} recado={recado} />
            </li>
          ))}
        </ul>
      )}

      <p className="recados__filtro">
        <a href={verEncerrados ? '/admin/recados' : '/admin/recados?todos=1'}>
          {verEncerrados ? 'Ver só os abertos' : 'Ver também os encerrados'}
        </a>
      </p>
    </main>
  );
}

const CLASSE_DO_TIPO: Readonly<Record<TipoDeRecado, string>> = {
  reclamacao: 'recado--reclamacao',
  sugestao: 'recado--sugestao',
  elogio: 'recado--elogio',
};

function Cartao({ recado, podeMexer }: { recado: RecadoNaTela; podeMexer: boolean }) {
  const encerrado = recado.estado === 'encerrado';
  const respondido = recado.estado === 'respondido';

  return (
    <article className={`recado ${CLASSE_DO_TIPO[recado.tipo]}`}>
      <header className="recado__topo">
        <span className="recado__tipo">{ROTULO_DO_TIPO[recado.tipo]}</span>
        <span className="recado__estado">{ROTULO_DO_RECADO[recado.estado as EstadoDoRecado]}</span>
        {/* Sem prazo, mas com idade: fila que envelhece em silêncio é canal que
            morre sem ninguém notar. */}
        <span className="recado__idade tabular">
          {recado.diasEsperando === 0 ? 'hoje' : `há ${recado.diasEsperando}d`}
        </span>
      </header>

      <p className="recado__texto">{recado.texto}</p>

      <p className="recado__quem">
        {recado.clienteNome ?? 'Anônimo'}
        {recado.responsavelNome ? ` · com ${recado.responsavelNome}` : ''}
      </p>

      {recado.resposta ? (
        <p className="recado__resposta">
          <strong>Respondido:</strong> {recado.resposta}
        </p>
      ) : null}

      {!podeMexer || encerrado ? null : (
        <div className="recado__acoes">
          <form action={recado.responsavelId ? acaoDevolverRecado : acaoAssumirRecado}>
            <input name="id" type="hidden" value={recado.id} />
            <button className="ui-button ui-button--ghost recado__acao" type="submit">
              {recado.responsavelId ? 'Devolver à fila' : 'Assumir'}
            </button>
          </form>

          {/* Anônimo não tem para onde responder, e o campo não aparece: campo
              que só produz erro é pior que campo ausente para quem opera. */}
          {recado.temContato && !respondido ? (
            <form action={acaoResponderRecado} className="recado__responder">
              <input name="id" type="hidden" value={recado.id} />
              <label className="recado__campo">
                <span>Resposta para {recado.clienteNome}</span>
                <textarea
                  className="falar__texto"
                  maxLength={MAXIMO_DA_RESPOSTA}
                  name="resposta"
                  required
                  rows={3}
                />
              </label>
              <button className="ui-button ui-button--primary recado__acao" type="submit">
                Responder
              </button>
            </form>
          ) : null}

          {!recado.temContato ? (
            <p className="recado__nota">
              Anônimo — não há para onde responder. Resolva e encerre.
            </p>
          ) : null}

          <form action={acaoEncerrarRecado}>
            <input name="id" type="hidden" value={recado.id} />
            <button className="ui-button ui-button--ghost recado__acao" type="submit">
              Encerrar
            </button>
          </form>
        </div>
      )}
    </article>
  );
}
