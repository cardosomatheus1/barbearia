import { randomUUID } from 'node:crypto';
import {
  CONVERSAS,
  ESTADO_TRATADA,
  ROTULO_DA_ASSINATURA,
  ROTULO_DO_PACOTE,
  TIPOS_DE_CAMPANHA,
  corpoComExemplos,
  saldoPorExtenso,
  nomeDoAviso,
  type Conversa,
} from '@barbearia/core';
import type {
  ConfiancaDoCliente,
  SaldoDeFidelidade,
  PacoteDoCliente,
  AvaliacaoNaTela,
  AssinaturaDoCliente,
  PlanoNaTela,
  DependenteNaTela,
  ConsentimentosNaFicha,
  FotoNaFicha,
  VisitaNaFicha,
} from '@/lib/admin-api';
import { CONSENTIMENTOS_OPCIONAIS } from '@/lib/politica';
import { reais, reaisDoCampo } from '@/lib/dinheiro';
import {
  acaoAbrirPedidoDeDados,
  acaoAnonimizarCliente,
  acaoAjustarFidelidade,
  acaoConfiancaDoCliente,
  acaoApagarFoto,
  acaoConsentimentoNoBalcao,
  acaoPublicarFoto,
  acaoRegistrarFoto,
  acaoAssinar,
  acaoAgendarCancelamento,
  acaoCancelarAssinatura,
  acaoDesfazerCancelamento,
  acaoIncluirDependente,
  acaoRemoverDependente,
  acaoReembolsarPacote,
  acaoTransferirPacote,
  acaoDefinirLimiteDeFiado,
  acaoLancarSaldoInicialDeFiado,
  acaoMandarMensagem,
} from '../../acoes';

const ROTULO_DA_VISITA: Record<string, string> = {
  completed: 'Atendido',
  no_show: 'Faltou',
  cancelled_customer: 'Cancelou',
  cancelled_business: 'Cancelado pela casa',
};

const ROTULO_DA_CONVERSA: Readonly<Record<Conversa, string>> = {
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

export function Visita({ visita }: { readonly visita: VisitaNaFicha }) {
  const veio = visita.status === 'completed';
  return (
    <li className={`visita${veio ? '' : ' visita--falhou'}`}>
      <span className="visita__quando tabular">{dia(visita.quando)}</span>
      <span className="visita__servico">
        {veio ? visita.servicos.join(' + ') || 'Atendimento' : ROTULO_DA_VISITA[visita.status]}
      </span>
      {/* A loja entra ao lado de quem atendeu, e não numa coluna própria: numa
          barbearia de uma unidade só ela é sempre a mesma palavra, e uma coluna
          inteira repetindo o nome da casa é ruído em todas as fichas. */}
      <span className="visita__quem">
        {visita.profissional}
        {visita.unidade ? ` · ${visita.unidade}` : ''}
      </span>
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
/**
 * As fotos antes/depois (bloco 74, SPEC §4.2).
 *
 * A seção diz **em letras** o que cada aceite libera, porque a diferença entre
 * eles é a coisa mais fácil de errar aqui: guardar na ficha e publicar no
 * portfólio são duas decisões, e quem está no balcão com o cliente na cadeira
 * precisa saber qual pediu.
 *
 * Sem o aceite de registro a seção não some — ela explica por que está vazia e
 * manda para o lugar de coletá-lo. Esconder faria a recepção concluir que o
 * produto não tem fotos.
 */
export function Fotos({
  fotos,
  consentimentos,
  customerId,
  podeGerenciar,
}: {
  readonly fotos: readonly FotoNaFicha[];
  readonly consentimentos: ConsentimentosNaFicha;
  readonly customerId: string;
  readonly podeGerenciar: boolean;
}) {
  const podeGuardar = consentimentos.atuais.photos?.concedido === true;
  const podePublicar = consentimentos.atuais.photos_public?.concedido === true;

  return (
    <section className="quadro cartao-balcao">
      <h2 className="cartao-balcao__titulo">Fotos do atendimento</h2>

      {!podeGuardar ? (
        <p className="cartao-balcao__vazio">
          Este cliente ainda não autorizou o registro de fotos. O aceite fica logo acima, em
          Consentimentos — sem ele o sistema recusa a foto, e é assim de propósito.
        </p>
      ) : (
        <p className="fotos__aviso">
          Ele autorizou <strong>guardar na ficha</strong>
          {podePublicar ? (
            <>
              {' '}
              e <strong>publicar no portfólio</strong>. Fotos marcadas aparecem na página pública
              do barbeiro.
            </>
          ) : (
            <>
              , mas <strong>não</strong> autorizou publicar. Para o portfólio é preciso o segundo
              aceite.
            </>
          )}
        </p>
      )}

      {fotos.length === 0 ? (
        <p className="cartao-balcao__vazio">Nenhuma foto ainda.</p>
      ) : (
        <ul className="fotos">
          {fotos.map((foto) => (
            <li className="fotos__item" key={foto.id}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                alt={foto.legenda ?? `Foto ${foto.tipo === 'antes' ? 'antes' : 'depois'} do atendimento`}
                className="fotos__foto"
                height={200}
                loading="lazy"
                src={foto.url}
                width={200}
              />
              <span className="fotos__tipo">{foto.tipo === 'antes' ? 'Antes' : 'Depois'}</span>
              {podeGerenciar ? (
                <div className="fotos__acoes">
                  {podePublicar || foto.noPortfolio ? (
                    <form action={acaoPublicarFoto}>
                      <input name="customerId" type="hidden" value={customerId} />
                      <input name="fotoId" type="hidden" value={foto.id} />
                      <input name="publicar" type="hidden" value={foto.noPortfolio ? '0' : '1'} />
                      <button className="ui-button ui-button--ghost fotos__acao" type="submit">
                        {foto.noPortfolio ? 'Tirar do portfólio' : 'Pôr no portfólio'}
                      </button>
                    </form>
                  ) : null}
                  <form action={acaoApagarFoto}>
                    <input name="customerId" type="hidden" value={customerId} />
                    <input name="fotoId" type="hidden" value={foto.id} />
                    <button className="ui-button ui-button--ghost fotos__acao" type="submit">
                      Apagar
                    </button>
                  </form>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {podeGerenciar && podeGuardar ? (
        <form action={acaoRegistrarFoto} className="formulario fotos__form">
          <input name="customerId" type="hidden" value={customerId} />
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="foto-url">
              Endereço da foto
            </label>
            <input
              className="ui-field__input"
              id="foto-url"
              name="url"
              placeholder="https://..."
              required
              type="url"
            />
            <span className="ui-field__hint">
              Fotos de cliente continuam neste fluxo separado: elas exigem consentimento e não são
              publicadas no armazenamento público da barbearia. O upload próprio desta tela entra
              quando houver armazenamento privado com exclusão acoplada à revogação.
            </span>
          </div>
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="foto-tipo">
              Momento
            </label>
            <select className="ui-field__input" id="foto-tipo" name="tipo">
              <option value="antes">Antes</option>
              <option value="depois">Depois</option>
            </select>
          </div>
          <div className="ui-field">
            <label className="ui-field__label" htmlFor="foto-legenda">
              Legenda (opcional)
            </label>
            <input
              className="ui-field__input"
              id="foto-legenda"
              maxLength={120}
              name="legenda"
              placeholder="Fade médio com risco"
              type="text"
            />
          </div>
          {podePublicar ? (
            <label className="ui-field__label fotos__marca">
              <input name="noPortfolio" type="checkbox" value="1" />
              Publicar no portfólio do barbeiro
            </label>
          ) : null}
          <button className="ui-button ui-button--primary fotos__salvar" type="submit">
            Registrar foto
          </button>
        </form>
      ) : null}
    </section>
  );
}

/**
 * Mandar uma mensagem para esta pessoa, do balcão (bloco 92).
 *
 * Até aqui uma mensagem só saía por quatro caminhos, e os quatro decidiam
 * sozinhos quem recebe: lembrete de agendamento, "sua vez" na fila, automação e
 * campanha em massa. Não havia como falar com **uma** pessoa — e é o pedido do
 * balcão o dia inteiro: "avisa o Carlos que abriu vaga".
 *
 * O que a barbearia fazia era pegar o celular pessoal, e aí a conversa sai de um
 * número que não é o da casa, não conta no teto do mês e não respeita quem pediu
 * para não receber promoção.
 *
 * Um botão por texto aprovado, e nenhum quando não há: a lista sai do que a
 * Meta já liberou, então não existe caminho para escolher algo que ela recusaria
 * na hora do envio.
 */
export function MandarMensagem({
  customerId,
  textos,
  de,
}: {
  readonly customerId: string;
  readonly de: string;
  /**
   * Os textos aprovados, **por id** (bloco 96).
   *
   * A lista era `{ tipo, corpo }` e o botão postava o `tipo`: com três convites
   * de retorno cadastrados, os três apareciam com um botão cada e os três
   * mandavam o primeiro. A recepção lia um texto, apertava, e o cliente recebia
   * outro. O `key` também era o tipo, então os três eram a mesma chave.
   */
  readonly textos: readonly {
    readonly id: string;
    readonly tipo: string;
    readonly titulo: string | null;
    readonly corpo: string;
  }[];
}) {
  const textosDeCampanha = textos.filter((texto) =>
    (TIPOS_DE_CAMPANHA as readonly string[]).includes(texto.tipo),
  );

  return (
    <section aria-labelledby="mandar-mensagem" className="secao">
      <h2 className="secao__titulo" id="mandar-mensagem">
        Mandar uma mensagem
      </h2>
      {textosDeCampanha.length === 0 ? (
        <p className="secao__vazio">
          Nenhum texto aprovado ainda. A Meta precisa aprovar cada texto antes de ele poder
          sair — <a href="/admin/whatsapp">mande um para aprovação</a>.
        </p>
      ) : (
        <>
          <p className="secao__nota">
            Sai pelo WhatsApp da casa, com o nome desta pessoa no lugar certo. Respeita quem
            pediu para não receber promoção, o teto do mês e a janela de silêncio.
          </p>
          <ul className="lista-cadastro">
            {textosDeCampanha.map((t) => (
              <li key={t.id}>
                <article className="item-cadastro">
                  <div className="item-cadastro__corpo">
                    <p className="item-cadastro__nome">{t.titulo ?? nomeDoAviso(t.tipo)}</p>
                    {/* O texto inteiro e **preenchido**: quem aperta precisa
                        saber o que a pessoa vai ler, e as chaves duplas são
                        vocabulário da Meta — lidas no balcão, parecem falta. */}
                    <p className="item-cadastro__linha">{corpoComExemplos(t.tipo, t.corpo)}</p>
                  </div>
                  <form action={acaoMandarMensagem}>
                    <input name="customerId" type="hidden" value={customerId} />
                    <input name="templateId" type="hidden" value={t.id} />
                    <input name="idempotencyKey" type="hidden" value={randomUUID()} />
                    <input name="de" type="hidden" value={de} />
                    <button className="ui-button ui-button--secondary" type="submit">
                      Mandar
                    </button>
                  </form>
                </article>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export function Consentimentos({
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
        {CONSENTIMENTOS_OPCIONAIS.map((item) => {
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
export function DireitosDoTitular({
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
/**
 * O que a barbearia sabe sobre a pontualidade deste cliente (bloco 37).
 *
 * ## O número não aparece
 *
 * A SPEC §2.13 regra 5 manda o score ser interno, e a razão é de balcão: um
 * número visível vira discussão sobre o número. Mesmo do lado de dentro ele
 * seria ruim de defender — a recepção não consegue explicar por que 72 cobra e
 * 74 não sem a fórmula na mão. O que a tela diz é o que decide: **este cliente
 * paga sinal, ou não.**
 *
 * A contagem de horários considerados fica, porque ela responde a pergunta
 * seguinte — "vocês estão julgando pelo quê?" — sem revelar a escala.
 */
/**
 * O saldo de fidelidade na ficha (bloco 41).
 *
 * Mostra o número **e** o que falta para o prêmio quando o modelo é visitas:
 * "3 visitas" sozinho não diz nada; "faltam 7 para o corte grátis" é o que a
 * recepção fala em voz alta.
 *
 * O ajuste manual fica atrás de `finance.loyalty_adjust`, com motivo
 * obrigatório: ele **cria** saldo, e saldo vira pagamento na comanda seguinte.
 */
export function Fidelidade({
  saldo,
  customerId,
  podeAjustar,
}: {
  readonly saldo: SaldoDeFidelidade;
  readonly customerId: string;
  readonly podeAjustar: boolean;
}) {
  return (
    <section aria-labelledby="fidelidade" className="secao">
      <h2 className="rotulo" id="fidelidade">
        Fidelidade
      </h2>

      <div className="saldo-fidelidade">
        <p className="saldo-fidelidade__numero tabular">
          {saldoPorExtenso(saldo.modo, saldo.saldo)}
        </p>
        {saldo.faltaParaPremio !== null ? (
          <p className="saldo-fidelidade__nota">
            {saldo.faltaParaPremio === 0
              ? 'Cartão completo — o próximo corte pode sair de graça.'
              : `Faltam ${saldo.faltaParaPremio} para o corte grátis.`}
          </p>
        ) : null}

        {/*
          Quanto do saldo vale fora desta loja (bloco 59).

          Só aparece quando os dois números diferem: numa barbearia de uma
          unidade só — e em toda que mantém o programa na rede — eles são iguais,
          e repetir o mesmo número com outro rótulo é a tela dizendo duas coisas
          para não dizer nenhuma.

          É o número que a recepção precisa para responder "posso usar isso na
          Pituba?" sem abrir outra tela.
        */}
        {saldo.saldoCompartilhado !== saldo.saldo ? (
          <p className="saldo-fidelidade__nota">
            {saldoPorExtenso(saldo.modo, saldo.saldoCompartilhado)} valem em qualquer unidade; o
            resto só nesta.
          </p>
        ) : null}

        {podeAjustar ? (
          <form action={acaoAjustarFidelidade} className="saldo-fidelidade__ajuste">
            <input name="customerId" type="hidden" value={customerId} />
            {/* O bolso que o ajuste toca (bloco 59). Quem cria saldo precisa
                saber onde ele vai valer — é dinheiro gastável no balcão da
                operação seguinte. */}
            {saldo.escopo === 'unidade' ? (
              <p className="ui-field__hint">
                O ajuste entra no saldo <strong>desta unidade</strong>. Tirar sai primeiro do que
                vale em toda parte.
              </p>
            ) : null}
            <label className="fidelidade__campo">
              <span>Ajustar (use sinal negativo para tirar)</span>
              <input
                className="ui-field__input"
                inputMode="numeric"
                name="quantidade"
                type="number"
              />
            </label>
            <label className="fidelidade__campo">
              <span>Por quê</span>
              <input className="ui-field__input" minLength={10} name="motivo" type="text" />
            </label>
            <button className="ui-button ui-button--ghost recado__acao" type="submit">
              Ajustar saldo
            </button>
          </form>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Fiado: o que a pessoa deve e até quanto a casa deixa levar (bloco 51).
 *
 * A coluna `credit_limit_cents` existe desde o bloco 18 e **nasceu em zero sem
 * nenhuma tela que a escrevesse**: toda venda fiada era recusada por estourar
 * um limite que ninguém conseguia levantar. Este é o formulário que faltava, e
 * ele fica na ficha porque fiar é decisão sobre **esta** pessoa — não uma
 * configuração da barbearia.
 *
 * O saldo inicial é como se traz o caderno do sistema antigo, uma pessoa por
 * vez e com o motivo escrito. Só aparece para quem ainda não deve nada: quem já
 * tem movimento no razão não tem "saldo inicial", tem extrato.
 */
export function Fiado({
  fiado,
  customerId,
  podeMexer,
}: {
  readonly fiado: { readonly saldoCents: number; readonly limiteCents: number };
  readonly customerId: string;
  readonly podeMexer: boolean;
}) {
  const divida = -Math.min(0, fiado.saldoCents);

  return (
    <section aria-labelledby="fiado" className="secao">
      <h2 className="rotulo" id="fiado">
        Fiado
      </h2>

      <div className="saldo-fidelidade">
        <p className="saldo-fidelidade__numero tabular">
          {divida > 0 ? `Deve ${reais(divida)}` : 'Nada em aberto'}
        </p>
        <p className="saldo-fidelidade__nota">
          {fiado.limiteCents > 0
            ? `Pode levar até ${reais(fiado.limiteCents)} sem pagar na hora.`
            : 'Sem limite: hoje esta pessoa não leva fiado.'}
        </p>

        {podeMexer ? (
          <>
            <form action={acaoDefinirLimiteDeFiado} className="saldo-fidelidade__ajuste">
              <input name="customerId" type="hidden" value={customerId} />
              <label className="fidelidade__campo">
                <span>Até quanto pode levar</span>
                <input
                  className="ui-field__input"
                  defaultValue={reaisDoCampo(fiado.limiteCents)}
                  inputMode="decimal"
                  name="limiteCents"
                  type="text"
                />
              </label>
              <button className="ui-button ui-button--ghost recado__acao" type="submit">
                Salvar limite
              </button>
            </form>

            {fiado.saldoCents === 0 ? (
              <form action={acaoLancarSaldoInicialDeFiado} className="saldo-fidelidade__ajuste">
                <input name="customerId" type="hidden" value={customerId} />
                <label className="fidelidade__campo">
                  <span>Já devia (do sistema antigo)</span>
                  <input
                    className="ui-field__input"
                    inputMode="decimal"
                    name="deveCents"
                    placeholder="85,00"
                    type="text"
                  />
                </label>
                <label className="fidelidade__campo">
                  <span>Por quê</span>
                  <input
                    className="ui-field__input"
                    minLength={3}
                    name="motivo"
                    placeholder="Saldo em aberto no caderno"
                    type="text"
                  />
                </label>
                <button className="ui-button ui-button--ghost recado__acao" type="submit">
                  Lançar no extrato
                </button>
              </form>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Os pacotes de um cliente na ficha dele (bloco 42, SPEC §4.7).
 *
 * A frase vem do domínio (`fraseDoPacote`), não da tela: "3 de 5 usados — 2
 * restantes" e o aviso do último precisam dizer a mesma coisa aqui, na comanda e
 * na página do cliente. Vocabulário de transição mora num lugar só.
 *
 * O reembolso é uma ação de dinheiro, atrás de `finance.package_refund`, e ele
 * devolve **a parte não usada** — o rótulo diz o valor antes do clique, porque
 * "reembolsar" sem número faz a recepção adivinhar o que vai sair do caixa.
 */
export function Pacotes({
  pacotes,
  customerId,
  podeReembolsar,
  podeTransferir,
}: {
  readonly pacotes: readonly PacoteDoCliente[];
  readonly customerId: string;
  readonly podeReembolsar: boolean;
  readonly podeTransferir: boolean;
}) {
  return (
    <section aria-labelledby="pacotes" className="secao">
      <h2 className="rotulo" id="pacotes">
        Pacotes
      </h2>

      {pacotes.map((pacote) => {
        const proporcional = pacote.restam * pacote.valorDaUnidadeCents;
        const devolve = pacote.estado === 'ativo' && pacote.restam > 0;

        return (
          <div className="pacote-cliente" key={pacote.id}>
            <div className="pacote-cliente__quem">
              <p className="pacote-cliente__nome">
                {pacote.servicoNome} · {ROTULO_DO_PACOTE[pacote.estado]}
              </p>
              <p className="pacote-cliente__frase">{pacote.frase}</p>
              <div
                aria-hidden="true"
                className="pacote-cliente__barra"
              >
                <span style={{ width: `${Math.round((pacote.usados / pacote.total) * 100)}%` }} />
              </div>
              {pacote.reembolsadoCents !== null ? (
                <p className="pacote-cliente__frase">
                  Devolvido R$ {reaisDoCampo(pacote.reembolsadoCents)}.
                </p>
              ) : null}
            </div>

            {podeReembolsar && devolve ? (
              <form action={acaoReembolsarPacote} className="pacote-cliente__acao">
                <input name="id" type="hidden" value={pacote.id} />
                <input name="customerId" type="hidden" value={customerId} />
                <button className="ui-button ui-button--ghost recado__acao" type="submit">
                  Devolver R$ {reaisDoCampo(proporcional)}
                </button>
              </form>
            ) : null}

            {/*
              Passar adiante (bloco 52, SPEC §4.7). Só aparece no que foi
              **vendido** transferível: a coluna é congelada na compra, e ligar a
              opção no catálogo hoje não torna transferível o que o cliente
              comprou ontem sabendo que não era.
            */}
            {podeTransferir && devolve && pacote.transferivel ? (
              <details className="dobra">
                <summary className="dobra__titulo">Passar para outra pessoa</summary>
                <form action={acaoTransferirPacote} className="formulario">
                  <input name="customerPackageId" type="hidden" value={pacote.id} />
                  <input name="customerId" type="hidden" value={customerId} />

                  <div className="ui-field">
                    <label className="ui-field__label" htmlFor={`para-${pacote.id}`}>
                      Id do cliente que vai receber
                    </label>
                    <input
                      className="ui-field__input"
                      id={`para-${pacote.id}`}
                      name="paraCustomerId"
                      placeholder="cole aqui o id da ficha da pessoa"
                      required
                    />
                    <p className="ui-field__hint">
                      Vão as {pacote.restam} unidades que sobram. O que já foi usado fica no
                      histórico de quem usou — a receita reconhecida não muda de dono.
                    </p>
                  </div>

                  <div className="ui-field">
                    <label className="ui-field__label" htmlFor={`motivo-t-${pacote.id}`}>
                      Por quê
                    </label>
                    <input
                      className="ui-field__input"
                      id={`motivo-t-${pacote.id}`}
                      minLength={3}
                      name="motivo"
                      placeholder="Presente do pai para o filho"
                      required
                    />
                  </div>

                  <button className="ui-button ui-button--ghost ui-button--block" type="submit">
                    Passar adiante
                  </button>
                </form>
              </details>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

/**
 * As avaliações que este cliente deu (bloco 43, SPEC §4.10).
 *
 * Fica na ficha porque é o que o barbeiro lê **antes** de atender: quem deu
 * nota 2 no mês passado e voltou merece saber que a casa lembra. A nota é
 * mostrada como o cliente a deu — não há caminho para editá-la aqui, nem em
 * lugar nenhum.
 */
export function Avaliacoes({ avaliacoes }: { readonly avaliacoes: readonly AvaliacaoNaTela[] }) {
  return (
    <section aria-labelledby="avaliacoes" className="secao">
      <h2 className="rotulo" id="avaliacoes">
        O que ele achou
      </h2>
      {avaliacoes.map((a) => (
        <article className="avaliacao" key={a.id}>
          <div className="avaliacao__topo">
            <p className="avaliacao__estrelas" aria-label={`Nota ${a.nota} de 5`}>
              {a.estrelas}
            </p>
            <p className="avaliacao__prazo">
              {new Date(a.criadaEm).toLocaleDateString('pt-BR')}
            </p>
          </div>
          {a.servicoNome || a.profissionalNome ? (
            <p className="avaliacao__quando">
              {a.servicoNome ?? 'Atendimento'}
              {a.profissionalNome ? ` com ${a.profissionalNome}` : ''}
            </p>
          ) : null}
          {a.comentario ? (
            <blockquote className="avaliacao__texto">{a.comentario}</blockquote>
          ) : null}
          {a.resolucao ? (
            <p className="avaliacao__tratada">
              <strong>{ESTADO_TRATADA}</strong> — {a.resolucao}
            </p>
          ) : null}
        </article>
      ))}
    </section>
  );
}

/**
 * A assinatura do clube na ficha (bloco 45, SPEC §4.6).
 *
 * O balcão precisa de duas coisas antes de cobrar: se a pessoa assina, e
 * **quanto do plano dela ainda cabe neste ciclo**. A segunda é a que evita a
 * conversa ruim — "achei que estava incluído" — e é por isso que a cota e o
 * intervalo aparecem por serviço, não como um selo de "assinante".
 */
export function Assinatura({
  assinatura,
  planos,
  customerId,
  podeMexer,
  dependentes,
}: {
  readonly assinatura: AssinaturaDoCliente | null;
  readonly planos: readonly PlanoNaTela[];
  readonly customerId: string;
  readonly podeMexer: boolean;
  readonly dependentes: readonly DependenteNaTela[];
}) {
  const dia = (iso: string) => new Date(iso).toLocaleDateString('pt-BR');
  const DIAS_CURTOS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'todo dia'] as const;
  const emHora = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  return (
    <section aria-labelledby="clube" className="secao">
      <h2 className="rotulo" id="clube">
        Clube
      </h2>

      {assinatura ? (
        <div className="assinatura">
          <p className="assinatura__plano">
            {assinatura.planoNome} · {ROTULO_DA_ASSINATURA[assinatura.estado]}
          </p>
          <p className="assinatura__ciclo">
            R$ {reaisDoCampo(assinatura.precoCents)} por mês · ciclo de {dia(assinatura.cicloDe)} a{' '}
            {dia(assinatura.cicloAte)}
          </p>

          <ul className="assinatura__beneficios">
            {assinatura.beneficios.map((b) => {
              const segurado = b.liberaEm && new Date(b.liberaEm) > new Date();
              return (
                <li key={b.serviceId}>
                  <strong>{b.servicoNome}</strong>{' '}
                  {b.quantidade === null
                    ? 'ilimitado'
                    : `${b.usados} de ${b.quantidade} usados`}
                  {segurado ? (
                    <span className="assinatura__trava">
                      {' '}
                      · libera em {dia(b.liberaEm as string)}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>

          {assinatura.bloqueios.length > 0 ? (
            <p className="assinatura__ciclo">
              O plano não vale{' '}
              {assinatura.bloqueios
                .map((b) => `${DIAS_CURTOS[b.diaDaSemana ?? 7]} ${emHora(b.inicio)}–${emHora(b.fim)}`)
                .join(', ')}
              .
            </p>
          ) : null}

          {/*
            Quem mais usa a cota (bloco 46). A cota é **da assinatura**, não da
            pessoa: o plano família de dois cortes dá dois para a família
            inteira. Sem saber quem usou, "1 de 2" numa família de três é um
            número que ninguém confere.
          */}
          {dependentes.length > 0 || podeMexer ? (
            <div className="assinatura__familia">
              <p className="rotulo">Quem mais usa este plano</p>
              {dependentes.length === 0 ? (
                <p className="assinatura__ciclo">Só o titular.</p>
              ) : (
                <ul className="assinatura__beneficios">
                  {dependentes.map((d) => (
                    <li key={d.customerId}>
                      {d.nome} — <span className="tabular">{d.usosNoCiclo}</span> neste ciclo
                      {podeMexer ? (
                        <form action={acaoRemoverDependente}>
                          <input name="subscriptionId" type="hidden" value={assinatura.id} />
                          <input name="dependenteId" type="hidden" value={d.customerId} />
                          <input name="customerId" type="hidden" value={customerId} />
                          <button className="ui-button ui-button--ghost recado__acao" type="submit">
                            Tirar do plano
                          </button>
                        </form>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}

              {podeMexer ? (
                <form action={acaoIncluirDependente}>
                  <input name="subscriptionId" type="hidden" value={assinatura.id} />
                  <input name="customerId" type="hidden" value={customerId} />
                  <label className="ui-field">
                    <span className="ui-field__label">
                      Incluir alguém — o código do cliente
                    </span>
                    <input
                      className="ui-field__input"
                      name="dependenteId"
                      placeholder="cole aqui o link da ficha dele"
                      required
                    />
                    <span className="ui-field__hint">
                      Cada dependente continua sendo cliente próprio, com agenda e histórico. O
                      que ele divide é a cota.
                    </span>
                  </label>
                  <button className="ui-button ui-button--ghost recado__acao" type="submit">
                    Incluir no plano
                  </button>
                </form>
              ) : null}
            </div>
          ) : null}

          {/*
            O cancelamento agendado precisa aparecer **aqui**, com saída.

            O cliente pode pedir para sair sozinho pela tela dele — é exigência
            da SPEC §4.6 —, e sem esta parte a recepção atenderia alguém cujo
            plano vence em duas semanas sem saber disso, e não teria como
            desfazer o pedido de quem mudou de ideia no balcão. Estado sem saída
            na interface é o terceiro defeito do §6 do CLAUDE.md.
          */}
          {assinatura.valeAte ? (
            <div className="assinatura__saida">
              <p className="assinatura__ciclo">
                Pediu para sair. O plano vale até <strong>{dia(assinatura.valeAte)}</strong> — até
                lá ele corta normalmente, e não há nova cobrança.
              </p>
              {podeMexer ? (
                <form action={acaoDesfazerCancelamento}>
                  <input name="id" type="hidden" value={assinatura.id} />
                  <input name="customerId" type="hidden" value={customerId} />
                  <button className="ui-button ui-button--ghost recado__acao" type="submit">
                    Manter o plano
                  </button>
                </form>
              ) : null}
            </div>
          ) : null}

          {assinatura.pausadoDesde ? (
            <p className="assinatura__ciclo">
              Pausado desde <strong>{dia(assinatura.pausadoDesde)}</strong> por falta de pagamento.
              Dar baixa na mensalidade em <a href="/admin/clube">Clube</a> devolve o benefício.
            </p>
          ) : null}

          {podeMexer && !assinatura.valeAte ? (
            <form action={acaoAgendarCancelamento} className="assinatura__cancelar">
              <input name="id" type="hidden" value={assinatura.id} />
              <input name="customerId" type="hidden" value={customerId} />
              <label className="ui-field">
                <span className="ui-field__label">Encerrar no fim do ciclo — por quê</span>
                <input
                  className="ui-field__input"
                  maxLength={300}
                  minLength={3}
                  name="motivo"
                  placeholder="Pediu para cancelar no balcão"
                  required
                />
                <span className="ui-field__hint">
                  Ele continua cortando até {dia(assinatura.cicloAte)}, que é o mês já pago, e não
                  é cobrado de novo. É o caminho normal.
                </span>
              </label>
              <button className="ui-button ui-button--ghost recado__acao" type="submit">
                Encerrar no fim do ciclo
              </button>
            </form>
          ) : null}

          {podeMexer ? (
            <details className="dobra">
              <summary className="dobra__titulo">Cancelar agora, sem esperar o ciclo</summary>
              <form action={acaoCancelarAssinatura} className="assinatura__cancelar">
                <input name="id" type="hidden" value={assinatura.id} />
                <input name="customerId" type="hidden" value={customerId} />
                <label className="ui-field">
                  <span className="ui-field__label">Cancelar — por quê</span>
                  <input
                    className="ui-field__input"
                    maxLength={300}
                    minLength={3}
                    name="motivo"
                    placeholder="Desfazendo uma venda feita por engano"
                    required
                  />
                  <span className="ui-field__hint">
                    Corta o benefício na hora e o cliente perde o resto do mês que pagou. É para
                    desfazer venda errada, não para atender quem pediu para sair.
                  </span>
                </label>
                <button className="ui-button ui-button--ghost recado__acao" type="submit">
                  Cancelar assinatura agora
                </button>
              </form>
            </details>
          ) : null}
        </div>
      ) : podeMexer && planos.length > 0 ? (
        <form action={acaoAssinar} className="assinatura">
          <input name="customerId" type="hidden" value={customerId} />
          <p className="assinatura__ciclo">Este cliente ainda não assina.</p>
          <label className="ui-field">
            <span className="ui-field__label">Plano</span>
            <select className="ui-field__input" name="planId">
              {planos.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nome} — R$ {reaisDoCampo(p.precoCents)}/mês
                </option>
              ))}
            </select>
          </label>
          <button className="ui-button ui-button--ghost recado__acao" type="submit">
            Assinar
          </button>
        </form>
      ) : (
        <p className="assinatura__ciclo">Este cliente não assina nenhum plano.</p>
      )}
    </section>
  );
}

export function Confianca({
  confianca,
  customerId,
  de,
  podeAjustar,
}: {
  readonly confianca: ConfiancaDoCliente;
  readonly customerId: string;
  readonly de: string;
  readonly podeAjustar: boolean;
}) {
  const semHistorico = !confianca.temEfeito;

  return (
    <section className="consentimentos">
      <h2 className="ficha__titulo">Sinal para garantir o horário</h2>

      <p className="consentimentos__nota">
        {semHistorico
          ? 'Ainda não há horários suficientes para julgar. Cliente novo não paga sinal — é de propósito.'
          : confianca.ajustadoAMao
            ? `Ajustado à mão pela gerência, sobre ${confianca.considerados} horários no último ano.`
            : `Calculado sobre ${confianca.considerados} ${
                confianca.considerados === 1 ? 'horário' : 'horários'
              } no último ano.`}
      </p>

      {podeAjustar ? (
        <details className="anotar">
          <summary className="anotar__abrir">Ajustar à mão</summary>

          <p className="consentimentos__nota">
            Para o que a conta não vê: quem faltou por uma internação, e quem tem histórico
            impecável e sumiu com a chave. O motivo fica na trilha.
          </p>

          <form action={acaoConfiancaDoCliente} className="formulario">
            <input name="customerId" type="hidden" value={customerId} />
            <input name="de" type="hidden" value={de} />

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="decisao">O que fazer</label>
              <select className="ui-field__input" defaultValue={confianca.ajustadoAMao ? 'manter' : 'dispensar'}
                      id="decisao" name="decisao">
                <option value="dispensar">Nunca pedir sinal deste cliente</option>
                <option value="exigir">Sempre pedir sinal deste cliente</option>
                <option value="formula">Voltar para o cálculo automático</option>
              </select>
            </div>

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="motivoConfianca">Por quê</label>
              <input className="ui-field__input" id="motivoConfianca" maxLength={300}
                     minLength={10} name="motivo" required type="text"
                     placeholder="Faltou por internação, comprovada na recepção" />
              <p className="ui-field__hint">
                Pelo menos dez letras. Daqui a seis meses é a única resposta para &ldquo;por que
                este cliente não paga sinal?&rdquo;.
              </p>
            </div>

            <button className="ui-button ui-button--secondary ui-button--block" type="submit">
              Salvar o ajuste
            </button>
          </form>
        </details>
      ) : null}
    </section>
  );
}

export function Apagar({
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
