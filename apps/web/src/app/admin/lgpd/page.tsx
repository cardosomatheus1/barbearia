import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  cadastrosParaSair,
  pedidosDeDados,
  politicasDaCasa,
  type PedidoNaTela,
} from '@/lib/admin-api';
import { RETENCAO_ANOS } from '@barbearia/core';
import { painelOuDesvio } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { faltamDias } from '@/lib/prazo';
import { acaoEncerrarPedidoDeDados, acaoSair } from '../acoes';
import { secao } from '../secoes';
import { marcaDaRecusa } from '../falha-da-leitura';
import { ROTULO_DO_ESTADO_DO_PEDIDO, ROTULO_DO_PEDIDO_DO_TITULAR } from '@barbearia/core';

/**
 * Os pedidos dos clientes sobre os dados deles (bloco 31, SPEC §1.8.4).
 *
 * ## A tela é uma fila com prazo, não um relatório
 *
 * A LGPD dá 15 dias para responder, e o que faz uma barbearia perder o prazo
 * não é má-fé: é o pedido chegar pelo WhatsApp e ninguém anotar. Por isso a tela
 * ordena por vencimento e escreve **quantos dias faltam** em vez da data — "vence
 * em 2 dias" é acionável; "vence em 24/08" exige o dono fazer conta.
 *
 * ## Recusar é uma resposta legítima, e por isso tem campo de motivo
 *
 * Pedido de exclusão que conflita com obrigação fiscal de guarda se recusa — e a
 * recusa sem motivo escrito é a que não se defende depois. O campo é obrigatório
 * no domínio e no banco; aqui ele fica à vista, ao lado do botão.
 */

export const metadata: Metadata = {
  title: 'Pedidos de dados',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;


/**
 * As frases de recusa, pela **união** dos códigos e não por `string`.
 *
 * Com a chave larga, o acesso devolve `undefined` e o mapa parcial vira a caixa
 * de erro genérica — e foi o que aconteceu com `exclusao_tem_caminho_proprio`:
 * o domínio recusa com uma frase cuidadosa, *"pedido de exclusão é atendido
 * apagando o cadastro, não marcando a linha"*, e a tela jogava fora, mostrando
 * "não deu para salvar, tente de novo" sobre um botão que **nunca** ia
 * funcionar. O dono, com quinze dias de prazo legal correndo, apertava de novo
 * e lia o mesmo.
 *
 * Com a união, o compilador cobra a frase no dia em que o código novo existir.
 */
type FalhaDoPedido =
  | 'forbidden'
  | 'customer_not_found'
  | 'version_required'
  | 'exclusao_tem_caminho_proprio'
  | 'request_failed';

const FALHA: Readonly<Record<FalhaDoPedido, string>> = {
  forbidden: 'Sua conta não responde por pedidos de dados.',
  customer_not_found: 'Este pedido já foi encerrado por outra pessoa.',
  version_required: 'Escreva o motivo da recusa.',
  exclusao_tem_caminho_proprio:
    'Exclusão se atende apagando os dados na ficha do cliente, não marcando esta linha.',
  request_failed: 'Não deu para salvar. Tente de novo.',
};

const frase = (codigo: string | undefined): string =>
  FALHA[(codigo ?? 'request_failed') as FalhaDoPedido] ?? FALHA.request_failed;

const data = (iso: string): string =>
  new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
    .format(new Date(iso));

function Pedido({ pedido, agora }: { readonly pedido: PedidoNaTela; readonly agora: Date }) {
  const aberto = pedido.estado === 'open';
  const quando = faltamDias(new Date(pedido.venceEm), agora);

  return (
    <li className={`pedido${aberto && quando.urgente ? ' pedido--urgente' : ''}`}>
      <div className="pedido__cabeca">
        <span className="pedido__tipo">{ROTULO_DO_PEDIDO_DO_TITULAR[pedido.tipo]}</span>
        <span className="pedido__prazo">
          {aberto ? quando.texto : `${ROTULO_DO_ESTADO_DO_PEDIDO[pedido.estado]} em ${data(pedido.encerradoEm ?? pedido.venceEm)}`}
        </span>
      </div>

      <p className="pedido__quando">
        Pedido em {data(pedido.pedidoEm)}
        {pedido.customerId ? (
          <>
            {' · '}
            <a href={`/admin/cliente/${pedido.customerId}`}>abrir a ficha</a>
          </>
        ) : null}
      </p>

      {pedido.nota ? <p className="pedido__nota">{pedido.nota}</p> : null}

      {aberto ? (
        <form action={acaoEncerrarPedidoDeDados} className="pedido__forma">
          <input name="pedidoId" type="hidden" value={pedido.id} />

          <div className="ui-field">
            <label className="ui-field__label" htmlFor={`nota-${pedido.id}`}>
              O que foi feito
            </label>
            <input className="ui-field__input" id={`nota-${pedido.id}`} maxLength={500}
                   name="nota" type="text"
                   placeholder="Arquivo enviado por e-mail em 12/08" />
            <p className="ui-field__hint">
              Obrigatório para recusar. Numa fiscalização é isto que responde por quê.
            </p>
          </div>

          <div className="pedido__botoes">
            {/*
              Exclusão não se marca como atendida — ela se cumpre apagando os
              dados (bloco 104).

              O domínio recusa `atendido=1` para este tipo, com uma frase certa,
              e a tela oferecia o botão mesmo assim como ação **primária** do
              card. O dono, com quinze dias de prazo legal correndo, apertava o
              botão mais destacado, lia "tente de novo", e apertava outra vez.
              Nada dizia onde a resposta estava.

              É a §6 pergunta 3 pelo avesso: o estado tem saída, e a tela
              apontava para a que não existe. Agora ela aponta para a que existe
              — a ficha do cliente, onde `customers.anonymize` guarda o botão
              que de fato encerra o pedido.
            */}
            {pedido.tipo === 'deletion' ? (
              pedido.customerId ? (
                <a
                  className="ui-button ui-button--primary"
                  href={`/admin/cliente/${pedido.customerId}#apagar`}
                >
                  Apagar os dados
                </a>
              ) : (
                <p className="ui-field__hint">
                  Este pedido não tem ficha vinculada. Encontre a pessoa em Clientes e apague os
                  dados por lá.
                </p>
              )
            ) : (
              <button className="ui-button ui-button--primary" name="atendido" type="submit"
                      value="1">
                Marcar como atendido
              </button>
            )}
            <button className="ui-button ui-button--ghost" name="atendido" type="submit"
                    value="0">
              Recusar
            </button>
          </div>
        </form>
      ) : null}
    </li>
  );
}

export default async function LgpdPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const query = await searchParams;
  const erro = first(query['erro']);
  const salvo = first(query['salvo']) === '1';

  const [resposta, politicas, retencao] = await Promise.all([
    pedidosDeDados(token),
    politicasDaCasa(token),
    cadastrosParaSair(token),
  ]);

  const agora = new Date();
  const encarregado = politicas.ok && politicas.dados.dpoName ? politicas.dados : null;

  const topo = (
    <header className="painel__topo">
      <a className="painel__marca" href="/admin/painel">← {estado.businessName}</a>
      <form action={acaoSair}>
        <button className="ui-button ui-button--ghost painel__sair" type="submit">Sair</button>
      </form>
    </header>
  );

  if (!resposta.ok) {
    return (
      <main className="ui-container painel__conteudo" {...secao('lgpd')}>
        {topo}
        <h1 className="painel__titulo">Privacidade</h1>
        <div className="ui-alert ui-alert--warning" role="alert" {...marcaDaRecusa(resposta.code)}>
          {frase(resposta.code)}
        </div>
      </main>
    );
  }

  const abertos = resposta.dados.pedidos.filter((p) => p.estado === 'open');
  const encerrados = resposta.dados.pedidos.filter((p) => p.estado !== 'open');

  return (
    <main className="ui-container painel__conteudo" {...secao('lgpd')}>
      {topo}

      <h1 className="painel__titulo">Privacidade</h1>
      <p className="painel__sub">
        Quando um cliente pede uma cópia dos dados dele — ou pede para ser apagado — você tem 15
        dias para responder. Registre o pedido na ficha dele; ele aparece aqui.
      </p>

      {erro ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {frase(erro)}
        </div>
      ) : null}

      {salvo ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Pedido encerrado.
        </div>
      ) : null}

      {/*
        O aviso do encarregado ausente vem antes da fila, e é de propósito.
        Sem encarregado cadastrado a página pública não diz para quem escrever,
        e o pedido do titular vai parar no lugar errado — o suporte da
        plataforma, que é operadora e não responde por dado que não é dela.
      */}
      {encarregado === null ? (
        <div className="ui-alert ui-alert--warning painel__aviso" role="alert">
          Você ainda não cadastrou o encarregado de dados. A lei manda divulgar quem é e como
          falar com ele.{' '}
          {/* Com âncora: o campo do encarregado fica no fim de um formulário
              de 3459px em 390px, e o link levava ao topo dele. `#dpoName` já
              existia no HTML. */}
          <a href="/admin/configuracoes#dpoName">Cadastrar agora</a>.
        </div>
      ) : (
        <p className="painel__nota">
          Encarregado: {encarregado.dpoName}
          {encarregado.dpoEmail ? ` · ${encarregado.dpoEmail}` : ''} ·{' '}
          <a href="/admin/configuracoes">trocar</a>
        </p>
      )}

      <h2 className="ficha__titulo">Em aberto</h2>

      {abertos.length === 0 ? (
        <div className="vazio">
          <p className="vazio__titulo">Nenhum pedido esperando</p>
          <p className="vazio__saida">
            Quando alguém pedir os dados dele, abra a ficha do cliente e registre o pedido — o
            prazo começa a correr da conversa, não de quando você lembrar.
          </p>
        </div>
      ) : (
        <ul className="pedidos">
          {abertos.map((p) => <Pedido agora={agora} key={p.id} pedido={p} />)}
        </ul>
      )}

      {/*
        O aviso prévio da retenção (bloco 32, SPEC §1.8 regra 6).

        Fica **abaixo** da fila de pedidos e acima do histórico porque é o que
        tem prazo correndo sem ninguém ter pedido nada — e é a única lista do
        painel em que não fazer nada tem consequência irreversível.

        Aparece só quando há alguém: um bloco vazio dizendo "nenhum cadastro
        sai" seria ruído permanente numa tela que a barbearia abre para
        responder pedido.
      */}
      {retencao.ok && retencao.dados.cadastros.length > 0 ? (
        <>
          <h2 className="ficha__titulo">Cadastros que saem por inatividade</h2>
          <p className="painel__nota">
            A lei não deixa guardar dado de quem parou de vir. Estes clientes estão há{' '}
            {RETENCAO_ANOS} anos sem atendimento, comanda ou fiado — o nome e o telefone deles são
            apagados na data abaixo, e não tem volta. Um atendimento novo cancela a saída.
          </p>
          <ul className="pedidos">
            {retencao.dados.cadastros.map((c) => {
              const quando = faltamDias(new Date(c.saiEm), agora);
              return (
                <li className={`pedido${quando.urgente ? ' pedido--urgente' : ''}`} key={c.customerId}>
                  <div className="pedido__cabeca">
                    <span className="pedido__tipo">{c.nome}</span>
                    <span className="pedido__prazo">sai · {quando.texto}</span>
                  </div>
                  {/*
                    Alvo de toque próprio: aqui o link está **sozinho** na
                    linha, então a isenção da WCAG 2.5.8 para link dentro de
                    frase não vale — e a medição pegou os 18px. No cartão do
                    pedido ele vive no meio de uma frase, e lá a isenção vale.
                  */}
                  <a className="pedido__ficha" href={`/admin/cliente/${c.customerId}`}>
                    abrir a ficha
                  </a>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}

      {encerrados.length > 0 ? (
        <>
          <h2 className="ficha__titulo">Já respondidos</h2>
          <ul className="pedidos">
            {encerrados.map((p) => <Pedido agora={agora} key={p.id} pedido={p} />)}
          </ul>
        </>
      ) : null}
    </main>
  );
}
