import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  CONVERSAS,
  destaquesDaFicha,
  fichaEstaVazia,
  fraseDaConversa,
  podeTudo,
  ESTADO_TRATADA,
  ROTULO_DA_ASSINATURA,
  ROTULO_DO_PACOTE,
  saldoPorExtenso,
} from '@barbearia/core';
import {
  confiancaDoCliente,
  saldoDeFidelidade,
  pacotesDoClienteNaApi,
  fiadoDoClienteNaApi,
  avaliacoesDoClienteNaApi,
  assinaturaDoClienteNaApi,
  planosNaApi,
  dependentesNaApi,
  type DependenteNaTela,
  type AssinaturaDoCliente,
  type PlanoNaTela,
  type AvaliacaoNaTela,
  type PacoteDoCliente,
  type SaldoDeFidelidade,
  consentimentosDaFicha,
  fichaDoCliente,
  type ConfiancaDoCliente,
  type ConsentimentosNaFicha,
  type VisitaNaFicha,
} from '@/lib/admin-api';
import { painelOuDesvio } from '@/lib/painel';
import { reaisDoCampo } from '@/lib/dinheiro';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { CONSENTIMENTOS_DO_BALCAO } from '@/lib/politica';
import {
  acaoAbrirPedidoDeDados,
  acaoAnonimizarCliente,
  acaoAjustarFidelidade,
  acaoConfiancaDoCliente,
  acaoConsentimentoNoBalcao,
  acaoPreferencias,
  acaoAssinar,
  acaoAgendarCancelamento,
  acaoCancelarAssinatura,
  acaoDesfazerCancelamento,
  acaoIncluirDependente,
  acaoRemoverDependente,
  acaoReembolsarPacote,
  acaoDefinirLimiteDeFiado,
  acaoLancarSaldoInicialDeFiado,
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
  // A assinatura (blocos 45 a 47).
  assinatura_nao_encontrada: 'Esta assinatura já foi cancelada ou não tem saída agendada.',
  ja_assina: 'Este cliente já tem um plano. Cancele o atual para trocar.',
  e_o_titular: 'Ele já é o titular deste plano.',
  ja_e_dependente: 'Esta pessoa já usa a cota de outro plano.',
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
function Fidelidade({
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

        {podeAjustar ? (
          <form action={acaoAjustarFidelidade} className="saldo-fidelidade__ajuste">
            <input name="customerId" type="hidden" value={customerId} />
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
function Fiado({
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
          {divida > 0 ? `Deve R$ ${reaisDoCampo(divida)}` : 'Nada em aberto'}
        </p>
        <p className="saldo-fidelidade__nota">
          {fiado.limiteCents > 0
            ? `Pode levar até R$ ${reaisDoCampo(fiado.limiteCents)} sem pagar na hora.`
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
function Pacotes({
  pacotes,
  customerId,
  podeReembolsar,
}: {
  readonly pacotes: readonly PacoteDoCliente[];
  readonly customerId: string;
  readonly podeReembolsar: boolean;
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
function Avaliacoes({ avaliacoes }: { readonly avaliacoes: readonly AvaliacaoNaTela[] }) {
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
function Assinatura({
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

function Confianca({
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
  // Sinal próprio, e não `salvo=1`: reaproveitá-lo faria a tela dizer "Anotação
  // salva" depois de ajustar quem paga sinal. Aviso que fala de outra coisa é o
  // mesmo defeito de duas telas discordando (CLAUDE.md §6).
  const ajustou = first(query['ajuste']) === '1';
  // Sinal próprio pelo mesmo motivo do ajuste de sinal: "Anotação salva" depois
  // de mexer no limite de fiado é a tela falando de outra coisa.
  const salvoFiado = first(query['salvo']);

  // As duas leituras juntas: são independentes, e encadeá-las somaria a
  // latência de uma na outra numa tela que o barbeiro abre com o cliente
  // sentado.
  const veSinal = estado.staff.permissions.includes('finance.deposit');
  // O saldo é dinheiro, e a rota exige as duas permissões que ela devolve.
  const veSaldo =
    estado.staff.permissions.includes('finance.view') &&
    estado.staff.permissions.includes('customers.view');
  const veClube = estado.staff.permissions.includes('finance.subscription_manage');
  const [ficha, consentimentos, confianca, fidelidade, pacotes, avaliacoes, assinatura, planosDoClube, fiado] =
    await Promise.all([
    fichaDoCliente(token, id),
    consentimentosDaFicha(token, id),
    // Só quem pode mexer em sinal pergunta: a rota exige `finance.deposit`, e
    // pedir sem ela devolveria 403 em toda abertura de ficha da recepção.
    veSinal ? confiancaDoCliente(token, id) : Promise.resolve(null),
    veSaldo ? saldoDeFidelidade(token, id) : Promise.resolve(null),
    // A rota devolve o que foi pago e o valor da unidade: são centavos, e ela
    // exige `customers.view` + `finance.view`. Mesma dupla do saldo.
    veSaldo ? pacotesDoClienteNaApi(token, id) : Promise.resolve(null),
    // A rota devolve o nome do cliente junto, e por isso exige `customers.view`
    // ao lado de `reviews.view` — rota que agrega declara tudo que devolve.
    estado.staff.permissions.includes('reviews.view')
      ? avaliacoesDoClienteNaApi(token, id)
      : Promise.resolve(null),
    // A rota traz o valor que a pessoa paga: exige `customers.view` + `finance.view`,
    // a mesma dupla do saldo e dos pacotes.
    veSaldo ? assinaturaDoClienteNaApi(token, id) : Promise.resolve(null),
    veClube ? planosNaApi(token) : Promise.resolve(null),
    // Saldo e limite de fiado (bloco 51). Mesma dupla de sempre: é dinheiro de
    // uma pessoa identificada.
    veSaldo ? fiadoDoClienteNaApi(token, id) : Promise.resolve(null),
  ]);

  /**
   * Os dependentes vêm numa segunda ida, e de propósito.
   *
   * Só existem quando a pessoa **tem** assinatura, e a maioria não tem — pedi-los
   * junto seria uma chamada a mais em toda abertura de ficha para responder uma
   * pergunta que quase nunca é feita.
   */
  const familia =
    veClube && assinatura?.ok && assinatura.dados.assinatura
      ? await dependentesNaApi(token, assinatura.dados.assinatura.id)
      : null;

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

      {ajustou ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Ajuste salvo. O motivo ficou na trilha.
        </div>
      ) : null}

      {salvoFiado === 'limite' ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Limite salvo. A partir de agora a comanda deixa fiar até esse valor.
        </div>
      ) : null}

      {salvoFiado === 'saldo-inicial' ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Saldo lançado no extrato, com o motivo. Ele aparece em{' '}
          <a href="/admin/fiado">Pendências</a>.
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

      {/* O saldo de fidelidade (bloco 41). A SPEC §4.8 pede a exibição "no app e
          no PDV" — a ficha é onde o balcão olha antes de cobrar. */}
      {fidelidade?.ok && fidelidade.dados.modo !== 'nenhum' && !ficha.dados.anonimizado ? (
        <Fidelidade
          customerId={ficha.dados.customerId}
          podeAjustar={estado.staff.permissions.includes('finance.loyalty_adjust')}
          saldo={fidelidade.dados}
        />
      ) : null}

      {/* Os pacotes (bloco 42). Fica na ficha porque é aqui que a recepção olha
          antes de cobrar — a mesma decisão do saldo de fidelidade. */}
      {pacotes?.ok && pacotes.dados.pacotes.length > 0 && !ficha.dados.anonimizado ? (
        <Pacotes
          customerId={ficha.dados.customerId}
          pacotes={pacotes.dados.pacotes}
          podeReembolsar={estado.staff.permissions.includes('finance.package_refund')}
        />
      ) : null}

      {/* Fiado (bloco 51). Fica ao lado do saldo e dos pacotes: é a mesma
          pergunta — o que esta pessoa já tem com a casa antes de cobrar. */}
      {fiado?.ok && !ficha.dados.anonimizado ? (
        <Fiado
          customerId={ficha.dados.customerId}
          fiado={fiado.dados}
          podeMexer={estado.staff.permissions.includes('finance.credit_limit')}
        />
      ) : null}

      {avaliacoes?.ok && avaliacoes.dados.avaliacoes.length > 0 ? (
        <Avaliacoes avaliacoes={avaliacoes.dados.avaliacoes} />
      ) : null}

      {/* O clube (bloco 45). Fica na ficha porque é onde o balcão olha antes de
          cobrar — a mesma decisão do saldo, dos pacotes e das avaliações. */}
      {assinatura?.ok && !ficha.dados.anonimizado ? (
        <Assinatura
          assinatura={assinatura.dados.assinatura}
          customerId={ficha.dados.customerId}
          dependentes={familia?.ok ? familia.dados.dependentes : []}
          planos={planosDoClube?.ok ? planosDoClube.dados.planos.filter((p) => p.ativo) : []}
          podeMexer={veClube}
        />
      ) : null}

      {confianca?.ok && !ficha.dados.anonimizado ? (
        <Confianca
          confianca={confianca.dados}
          customerId={ficha.dados.customerId}
          de={voltar}
          podeAjustar={estado.staff.permissions.includes('customers.reliability_override')}
        />
      ) : null}

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
