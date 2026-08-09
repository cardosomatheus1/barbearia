import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  CONVERSAS,
  destaquesDaFicha,
  fichaEstaVazia,
  fraseDaConversa,
  podeTudo,
} from '@barbearia/core';
import {
  consentimentosDaFicha,
  fichaDoCliente,
  type ConsentimentosNaFicha,
  type VisitaNaFicha,
} from '@/lib/admin-api';
import { painelOuDesvio } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { CONSENTIMENTOS_DO_BALCAO } from '@/lib/politica';
import {
  acaoAbrirPedidoDeDados,
  acaoAnonimizarCliente,
  acaoConsentimentoNoBalcao,
  acaoPreferencias,
  acaoSair,
} from '../../acoes';
import { secao } from '../../secoes';

/**
 * A ficha do cliente — SPEC §4.1 e §4.3.
 *
 * "A tela que o barbeiro abre antes de atender." Ela responde duas perguntas
 * na ordem em que elas aparecem na cadeira: **como esta pessoa gosta de ser
 * atendida** e **como ela vem sendo atendida**.
 *
 * O que evitar vem primeiro apesar de ser o campo menos preenchido. É o único
 * cuja falha machuca: alergia a pós-barba com álcool lida depois da navalha não
 * serviu para nada.
 *
 * A anotação aparece com **quem escreveu e quando**. Ninguém confia numa
 * anotação sem dono — "não usar navalha" escrito por quem saiu há dois anos
 * vale menos que o de ontem, e é o barbeiro quem decide isso, não a tela.
 */

export const metadata: Metadata = {
  title: 'Ficha do cliente',
  robots: { index: false, follow: false },
};

interface Props {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const FALHA: Record<string, string> = {
  cliente_nao_encontrado: 'Este cliente não existe mais.',
  confirmacao_invalida: 'Para apagar, digite APAGAR no campo de confirmação.',
  forbidden_anonimizar: 'Sua conta não apaga dados de cliente.',
  preferencia_invalida: 'Escolha uma das opções de conversa.',
  forbidden: 'Sua conta não vê as anotações dos clientes.',
  invalid_request: 'Confira os campos: alguma anotação ficou longa demais.',
  request_failed: 'Não deu para carregar. Tente de novo.',
};

const ROTULO_DA_VISITA: Record<string, string> = {
  completed: 'Atendido',
  no_show: 'Faltou',
  cancelled_customer: 'Cancelou',
  cancelled_business: 'Cancelado pela casa',
};

const ROTULO_DA_CONVERSA: Record<string, string> = {
  silencioso: 'Silêncio',
  indiferente: 'Tanto faz',
  conversa: 'Conversa',
};

const dinheiro = (centavos: number): string =>
  `R$ ${(centavos / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;

function dia(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })
    .format(new Date(iso));
}

function Visita({ visita }: { readonly visita: VisitaNaFicha }) {
  const veio = visita.status === 'completed';
  return (
    <li className={`visita${veio ? '' : ' visita--falhou'}`}>
      <span className="visita__quando tabular">{dia(visita.quando)}</span>
      <span className="visita__servico">
        {veio ? visita.servicos.join(' + ') || 'Atendimento' : ROTULO_DA_VISITA[visita.status]}
      </span>
      <span className="visita__quem">{visita.profissional}</span>
      {veio ? <span className="visita__valor tabular">{dinheiro(visita.precoCents)}</span> : null}
    </li>
  );
}

/**
 * O que esta pessoa autorizou (bloco 31).
 *
 * ## Por que fica na ficha e não numa tela de LGPD
 *
 * A pergunta "posso tirar uma foto do seu corte?" acontece na cadeira, com o
 * barbeiro olhando esta tela. Uma tela separada de consentimento seria
 * preenchida por ninguém — e consentimento que ninguém registra é o mesmo que a
 * barbearia tratando dado sem base legal.
 *
 * ## Um botão por finalidade, e o texto à vista
 *
 * O texto exato aparece acima do botão porque é ele que fica gravado com a
 * decisão. Registrar "aceitou" sem mostrar o que foi aceito produz a linha que
 * não se defende: numa contestação, o que vale é o que a pessoa leu.
 *
 * Fechado por padrão (`details`): o barbeiro abre a ficha para ver como cortar,
 * e empurrar três aceites para o topo enterraria o que ele veio buscar.
 */
function Consentimentos({
  consentimentos,
  customerId,
  de,
  podeEditar,
}: {
  readonly consentimentos: ConsentimentosNaFicha;
  readonly customerId: string;
  readonly de: string;
  readonly podeEditar: boolean;
}) {
  return (
    <details className="anotar">
      <summary className="anotar__abrir">O que este cliente autorizou</summary>

      <ul className="consentimentos">
        {CONSENTIMENTOS_DO_BALCAO.map((item) => {
          const atual = consentimentos.atuais[item.finalidade];
          const aceita = atual?.concedido ?? false;

          return (
            <li className="consentimentos__item" key={item.finalidade}>
              <div className="consentimentos__texto">
                <span className="consentimentos__titulo">{item.titulo}</span>
                <span className="consentimentos__frase">{item.texto}</span>
                <span className="consentimentos__estado">
                  {atual === undefined
                    ? 'Nunca perguntado'
                    : `${aceita ? 'Autorizou' : 'Recusou'} em ${dia(atual.decididoEm)}`}
                </span>
              </div>

              {podeEditar ? (
                <form action={acaoConsentimentoNoBalcao}>
                  <input name="customerId" type="hidden" value={customerId} />
                  <input name="de" type="hidden" value={de} />
                  <input name="finalidade" type="hidden" value={item.finalidade} />
                  {/*
                    A versão do texto **não** vem daqui. Ela sai de `politica.ts`
                    na ação, pela finalidade: um campo escondido editável faria a
                    prova virar o que o navegador digitou.
                  */}
                  <input name="concedido" type="hidden" value={aceita ? '0' : '1'} />
                  <button
                    className="ui-button ui-button--secondary consentimentos__botao"
                    type="submit"
                  >
                    {aceita ? 'Registrar recusa' : 'Registrar autorização'}
                  </button>
                </form>
              ) : null}
            </li>
          );
        })}
      </ul>

      <p className="consentimentos__nota">
        Registre só o que o cliente disser a você. Ele também decide sozinho, pela página dele —
        e a decisão mais recente é a que vale.
      </p>
    </details>
  );
}

/**
 * O pedido do titular, e a exportação.
 *
 * A exportação é uma rota própria (`/dados`) e não um botão que baixa da API
 * direto: o token do painel é um cookie `httpOnly` de caminho `/admin`, e o
 * navegador não consegue montar o `Authorization` que a API exige. O servidor
 * de tela faz a ponte.
 */
function DireitosDoTitular({
  customerId,
  de,
  podeExportar,
  podeAbrirPedido,
}: {
  readonly customerId: string;
  readonly de: string;
  readonly podeExportar: boolean;
  readonly podeAbrirPedido: boolean;
}) {
  if (!podeExportar && !podeAbrirPedido) return null;

  return (
    <details className="anotar">
      <summary className="anotar__abrir">Pedido de dados (LGPD)</summary>

      <p className="consentimentos__nota">
        Quando o cliente pedir os dados dele — ou pedir para ser apagado — registre aqui. O prazo
        de 15 dias começa a contar hoje, e a fila fica em{' '}
        <a href="/admin/lgpd">Pedidos de dados</a>.
      </p>

      <div className="consentimentos__acoes">
        {podeAbrirPedido ? (
          <>
            <form action={acaoAbrirPedidoDeDados}>
              <input name="customerId" type="hidden" value={customerId} />
              <input name="de" type="hidden" value={de} />
              <input name="tipo" type="hidden" value="export" />
              <button className="ui-button ui-button--secondary" type="submit">
                Registrar pedido de cópia
              </button>
            </form>
            <form action={acaoAbrirPedidoDeDados}>
              <input name="customerId" type="hidden" value={customerId} />
              <input name="de" type="hidden" value={de} />
              <input name="tipo" type="hidden" value="deletion" />
              <button className="ui-button ui-button--secondary" type="submit">
                Registrar pedido de exclusão
              </button>
            </form>
          </>
        ) : null}

        {podeExportar ? (
          <a
            className="ui-button ui-button--secondary"
            href={`/admin/cliente/${customerId}/dados`}
            download
          >
            Baixar os dados deste cliente
          </a>
        ) : null}
      </div>

      {podeExportar ? (
        <p className="consentimentos__nota">
          O arquivo sai com tudo que a barbearia guarda sobre esta pessoa, e o download fica
          registrado na trilha com o seu nome.
        </p>
      ) : null}
    </details>
  );
}

/**
 * Apagar os dados desta pessoa (bloco 32).
 *
 * ## Separada do resto, e com a confirmação digitada
 *
 * É a única ação sem volta do painel. Um botão a mais no meio dos outros é
 * clicado por engano — sobretudo no celular, que é onde metade do balcão
 * trabalha. A palavra digitada não é cerimônia: sem componente de cliente não
 * existe `confirm()`, e é bom que não exista, porque um diálogo se fecha no
 * reflexo e uma palavra precisa ser lida para ser escrita.
 *
 * ## O que o texto precisa dizer, e diz
 *
 * O que sai, o que fica e por que fica. Um aviso genérico de "esta ação é
 * irreversível" faria o dono achar que perde a venda junto — e ele não perde:
 * a obrigação fiscal é justamente o motivo de anonimizar em vez de apagar.
 */
function Apagar({
  customerId,
  de,
  nome,
}: {
  readonly customerId: string;
  readonly de: string;
  readonly nome: string;
}) {
  return (
    <details className="anotar perigo">
      <summary className="anotar__abrir perigo__abrir">Apagar os dados deste cliente</summary>

      <p className="consentimentos__nota">
        Apaga o nome, o telefone, o nascimento e tudo que foi anotado sobre {nome}. As vendas, o
        que ele deve e a comissão que já foi paga continuam — a lei obriga a guardar —, mas sem
        ligação com uma pessoa identificável. <strong>Isso não tem volta.</strong>
      </p>

      <form action={acaoAnonimizarCliente} className="formulario">
        <input name="customerId" type="hidden" value={customerId} />
        <input name="de" type="hidden" value={de} />

        <div className="ui-field">
          <label className="ui-field__label" htmlFor="motivo">Por quê</label>
          <input className="ui-field__input" id="motivo" maxLength={300} name="motivo"
                 required type="text"
                 placeholder="Pedido de exclusão do titular, por WhatsApp em 09/08" />
          <p className="ui-field__hint">
            Fica na trilha. Daqui a seis meses é a única resposta para &ldquo;por que este
            cadastro sumiu?&rdquo;.
          </p>
        </div>

        <div className="ui-field">
          <label className="ui-field__label" htmlFor="confirmacao">
            Digite APAGAR para confirmar
          </label>
          <input className="ui-field__input" id="confirmacao" maxLength={10} name="confirmacao"
                 required type="text" autoComplete="off" />
        </div>

        <button className="ui-button ui-button--danger ui-button--block" type="submit">
          Apagar os dados de {nome}
        </button>
      </form>
    </details>
  );
}

export default async function FichaPage({ params, searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const { id } = await params;
  const query = await searchParams;
  const erro = first(query['erro']);
  const salvo = first(query['salvo']) === '1';
  // Só dois destinos, e conferidos: valor de query virando `href` de volta é o
  // mesmo buraco de um `redirect` cru com entrada externa.
  const voltar = first(query['de']) === 'meu-dia' ? '/admin/meu-dia' : '/admin/dia';

  const pediu = first(query['pedido']) === '1';

  // As duas leituras juntas: são independentes, e encadeá-las somaria a
  // latência de uma na outra numa tela que o barbeiro abre com o cliente
  // sentado.
  const [ficha, consentimentos] = await Promise.all([
    fichaDoCliente(token, id),
    consentimentosDaFicha(token, id),
  ]);

  const topo = (
    <header className="painel__topo">
      <a className="painel__marca" href={voltar}>
        ← {estado.businessName}
      </a>
      <form action={acaoSair}>
        <button className="ui-button ui-button--ghost painel__sair" type="submit">
          Sair
        </button>
      </form>
    </header>
  );

  if (!ficha.ok) {
    return (
      <main className="ui-container painel__conteudo" {...secao('cliente')}>
        {topo}
        <h1 className="painel__titulo">Ficha</h1>
        <div className="ui-alert ui-alert--warning" role="alert">
          {FALHA[ficha.code] ?? FALHA['request_failed']}
          <a className="ui-button ui-button--secondary painel__saida" href={voltar}>
            Voltar
          </a>
        </div>
      </main>
    );
  }

  const { preferencias, linhaDoTempo } = ficha.dados;
  const destaques = destaquesDaFicha(preferencias);
  const conversa = fraseDaConversa(preferencias.conversa);
  const vazia = fichaEstaVazia(preferencias);

  return (
    <main className="ui-container painel__conteudo" {...secao('cliente')}>
      {topo}

      <h1 className="painel__titulo">{ficha.dados.nome}</h1>
      <p className="painel__sub">
        {ficha.dados.visitas === 0
          ? 'Primeira vez aqui'
          : `${ficha.dados.visitas} ${ficha.dados.visitas === 1 ? 'visita' : 'visitas'}`}
        {ficha.dados.desde ? ` · cliente desde ${dia(ficha.dados.desde)}` : ''}
        {ficha.dados.telefoneFinal ? ` · final ${ficha.dados.telefoneFinal}` : ''}
      </p>

      {erro ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {FALHA[erro] ?? FALHA['request_failed']}
        </div>
      ) : null}

      {salvo ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Anotação salva.
        </div>
      ) : null}

      {pediu ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Pedido registrado. Ele vence em 15 dias e aparece em{' '}
          <a href="/admin/lgpd">Pedidos de dados</a>.
        </div>
      ) : null}

      {vazia ? (
        <div className="vazio">
          <p className="vazio__titulo">Ninguém anotou nada ainda</p>
          <p className="vazio__saida">
            Escreva o que você descobrir hoje. Da próxima vez — com você ou com outro barbeiro —
            o corte sai certo de primeira.
          </p>
        </div>
      ) : (
        <section className="como-corta">
          {destaques.length > 0 ? (
            <ul className="como-corta__lista">
              {destaques.map((item) => (
                <li className="como-corta__item" key={item.rotulo}>
                  <span className="como-corta__rotulo">{item.rotulo}</span>
                  <span className="como-corta__valor">{item.valor}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {conversa ? <p className="como-corta__conversa">{conversa}</p> : null}
          {preferencias.observacoes ? (
            <p className="como-corta__nota">{preferencias.observacoes}</p>
          ) : null}
          {ficha.dados.anotadoPor ? (
            <p className="como-corta__autor">
              Anotado por {ficha.dados.anotadoPor}
              {ficha.dados.anotadoEm ? ` em ${dia(ficha.dados.anotadoEm)}` : ''}
            </p>
          ) : null}
        </section>
      )}

      <details className="anotar">
        <summary className="anotar__abrir">{vazia ? 'Anotar' : 'Mudar a anotação'}</summary>

        <form action={acaoPreferencias} className="formulario anotar__forma">
          <input name="customerId" type="hidden" value={ficha.dados.customerId} />
          <input name="de" type="hidden" value={voltar} />

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="produtosEvitar">
              O que evitar
            </label>
            <input className="ui-field__input" defaultValue={preferencias.produtosEvitar ?? ''}
                   id="produtosEvitar" maxLength={240} name="produtosEvitar"
                   placeholder="Álcool no pós-barba" type="text" />
            <p className="ui-field__hint">Alergia, produto que irrita, o que já deu errado.</p>
          </div>

          <div className="anotar__dupla">
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="maquinaLaterais">Laterais</label>
              <input className="ui-field__input" defaultValue={preferencias.maquinaLaterais ?? ''}
                     id="maquinaLaterais" maxLength={120} name="maquinaLaterais"
                     placeholder="Máquina 1" type="text" />
            </div>
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="tipoDegrade">Degradê</label>
              <input className="ui-field__input" defaultValue={preferencias.tipoDegrade ?? ''}
                     id="tipoDegrade" maxLength={120} name="tipoDegrade"
                     placeholder="Médio" type="text" />
            </div>
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="topo">Topo</label>
              <input className="ui-field__input" defaultValue={preferencias.topo ?? ''}
                     id="topo" maxLength={120} name="topo" placeholder="Tesoura" type="text" />
            </div>
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="barbaEstilo">Barba</label>
              <input className="ui-field__input" defaultValue={preferencias.barbaEstilo ?? ''}
                     id="barbaEstilo" maxLength={120} name="barbaEstilo"
                     placeholder="Aparar, sem navalha" type="text" />
            </div>
          </div>

          <fieldset className="painel__grupo">
            <legend className="ui-field__label">Durante o corte</legend>
            <div className="anotar__conversa">
              {CONVERSAS.map((opcao) => (
                <label className="marca" htmlFor={`conversa-${opcao}`} key={opcao}>
                  <input defaultChecked={preferencias.conversa === opcao}
                         id={`conversa-${opcao}`} name="conversa" type="radio" value={opcao} />
                  <span>{ROTULO_DA_CONVERSA[opcao]}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="observacoes">Outras observações</label>
            <textarea className="ui-field__input" defaultValue={preferencias.observacoes ?? ''}
                      id="observacoes" maxLength={1000} name="observacoes" rows={3}
                      placeholder="Redemoinho do lado direito abre para cima" />
          </div>

          <button className="ui-button ui-button--primary ui-button--lg ui-button--block" type="submit">
            Salvar anotação
          </button>
        </form>
      </details>

      {/*
        O cadastro apagado precisa se explicar (bloco 32).

        Sem este aviso a ficha aparece com um nome estranho, sem telefone e sem
        anotação — que é indistinguível de defeito, e o barbeiro liga para o
        dono. Estado desenhado, não improvisado.
      */}
      {ficha.dados.anonimizado ? (
        <div className="ui-alert ui-alert--warning painel__aviso" role="status">
          Os dados desta pessoa foram apagados a pedido dela ou por tempo sem vir. O histórico de
          atendimento e o que ela deve continuam, porque a lei obriga a guardar — o que saiu foi
          tudo que identificava quem era.
        </div>
      ) : null}

      {consentimentos.ok && !ficha.dados.anonimizado ? (
        <Consentimentos
          consentimentos={consentimentos.dados}
          customerId={ficha.dados.customerId}
          de={voltar}
          podeEditar={estado.staff.permissions.includes('customers.edit')}
        />
      ) : null}

      {ficha.dados.anonimizado ? null : (
      <DireitosDoTitular
        customerId={ficha.dados.customerId}
        de={voltar}
        podeAbrirPedido={estado.staff.permissions.includes('customers.edit')}
        /*
          As três que a API exige, conferidas pela mesma função que ela usa.
          Recalcular "é só `customers.export`" aqui mostraria um botão que
          responde 403 — e a regra da casa é que a permissão exibida saia de
          onde a permissão é aplicada.
        */
        podeExportar={podeTudo(estado.staff.permissions, [
          'customers.export',
          'finance.view',
          'customers.view_notes',
        ])}
      />
      )}

      {estado.staff.permissions.includes('customers.anonymize') && !ficha.dados.anonimizado ? (
        <Apagar customerId={ficha.dados.customerId} de={voltar} nome={ficha.dados.nome} />
      ) : null}

      <h2 className="ficha__titulo">Últimas vezes</h2>

      {linhaDoTempo.length === 0 ? (
        <div className="vazio">
          <p className="vazio__titulo">Nenhum atendimento ainda</p>
          <p className="vazio__saida">A primeira vez aparece aqui depois que você terminar.</p>
        </div>
      ) : (
        <ul className="visitas">
          {linhaDoTempo.map((visita) => (
            <Visita key={visita.id} visita={visita} />
          ))}
        </ul>
      )}
    </main>
  );
}
