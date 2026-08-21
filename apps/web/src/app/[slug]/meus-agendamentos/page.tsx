import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import {
  getProfile,
  lerConsentimento,
  listarAgendamentos,
  listarEsperas,
  meuSaldoDeFidelidade,
  meuPlano,
  meusPacotes,
  meusAtendimentosAAvaliar,
  type AgendamentoDoCliente,
  type EsperaDoCliente,
} from '@/lib/api';
import { ROTULO_DO_ESCOPO, saldoPorExtenso } from '@barbearia/core';
import { humanInstant } from '@/lib/date';
import { lerSessao } from '@/lib/sessao';
import { CONSENTIMENTOS_OPCIONAIS } from '@/lib/politica';
import type { ConsentimentoDoTitular } from '@/lib/api';
import {
  aceitarVaga,
  avaliar,
  cancelar,
  cancelarPlano,
  manterPlano,
  decidirConsentimentoDoTitular,
  pedirDados,
  sair,
  sairDaEspera,
} from './acoes';

/**
 * Meus agendamentos.
 *
 * A tela existe para três coisas, nessa ordem de importância: saber quando é o
 * próximo, cancelar, remarcar. O que vem depois — histórico — fica embaixo,
 * porque quem abre isso às sete da manhã quer o horário de hoje.
 */

interface Props {
  readonly params: Promise<{ slug: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export const metadata: Metadata = {
  title: 'Meus agendamentos',
  robots: { index: false, follow: false },
};

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** "15/08" — a data que a pessoa lê de relance, sem o ano que ela já sabe. */
const dataCurta = (iso: string): string =>
  new Date(iso).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'UTC',
  });

const money = (cents: number): string =>
  (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

const FALHA: Record<string, string> = {
  too_late: 'Passou do prazo para mexer neste horário. Ligue para a barbearia.',
  already_started: 'Este horário já começou.',
  too_many_reschedules: 'Este horário já foi remarcado o máximo de vezes.',
  appointment_not_found: 'Este agendamento não está mais ativo.',
  slot_taken: 'O horário novo acabou de ser ocupado. Escolha outro.',
  slot_not_available: 'O horário novo já não está disponível. Escolha outro.',
  atendimento_nao_concluido: 'Só dá para avaliar um atendimento que aconteceu.',
  ja_avaliado: 'Você já avaliou este atendimento.',
  prazo_vencido: 'O prazo para avaliar este atendimento passou.',
  assinatura_nao_encontrada: 'Você não tem um plano ativo aqui.',
};

const FEITO: Record<string, string> = {
  cancelado: 'Agendamento cancelado.',
  remarcado: 'Horário remarcado.',
  aceitou: 'Pronto — você vai receber as promoções desta barbearia.',
  pediu: 'Pedido registrado. A barbearia responde em até 15 dias.',
  pediu_exclusao:
    'Pedido de exclusão registrado. A barbearia tem 15 dias para responder — ela confere antes '
    + 'se alguma obrigação legal a impede de apagar tudo.',
  recusou: 'Pronto — você não recebe mais promoção. O aviso do seu horário continua.',
  espera: 'Você saiu da lista de espera.',
  vaga: 'Horário confirmado. Ele já está aqui em cima, nos seus agendamentos.',
  avaliado: 'Obrigado. A barbearia lê todas.',
  plano_cancelado:
    'Plano cancelado. Ele continua valendo até o fim do ciclo que você já pagou — nada muda até lá.',
  plano_mantido: 'Pronto, seu plano continua. Nada foi cobrado a mais.',
};

/**
 * "15 de agosto" e "15/08".
 *
 * `YYYY-MM-DD` é data local da unidade, não instante: convertê-la com `Date` e
 * formatá-la no fuso do processo devolveria o dia anterior a oeste de
 * Greenwich, que é o Brasil inteiro. O recorte da string é o que mantém sábado
 * sendo sábado.
 */
const MESES = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];

function diaLongo(iso: string): string {
  const [, mes = '01', dia = '01'] = iso.split('-');
  return `${Number(dia)} de ${MESES[Number(mes) - 1] ?? ''}`;
}

function diaCurto(iso: string): string {
  const [, mes = '01', dia = '01'] = iso.split('-');
  return `${dia}/${mes}`;
}

/**
 * A decisão sobre promoção, do lado de quem decide (bloco 31).
 *
 * ## Fica aqui e não no agendamento, e é decisão
 *
 * Consentimento de marketing precisa ser informado e **separado** do necessário
 * para executar o serviço (SPEC §1.8). Enfiá-lo no fluxo de agendar produz o
 * aceite que ninguém leu: a pessoa está tentando marcar um horário. Aqui ela já
 * entrou, já se identificou, e a decisão é o único assunto do bloco.
 *
 * ## Um botão, não uma caixa de seleção
 *
 * Caixa de seleção precisa de um "Salvar" ao lado, e um formulário de um campo
 * com botão de salvar é onde a pessoa marca e vai embora achando que salvou. O
 * botão diz o que vai acontecer e acontece no clique.
 */
function Consentimentos({
  slug,
  decisoes,
}: {
  readonly slug: string;
  readonly decisoes: ConsentimentoDoTitular;
}) {
  return (
    <section className="meus__consentimento">
      <h2 className="meus__secao">O que você autoriza</h2>
      {/*
        As três, e não só a de promoção (bloco 129).

        A tela mexia em `marketing` e nada mais: quem quisesse tirar a própria
        foto do Instagram da barbearia dependia de pedir ao balcão, que depende
        de alguém lembrar. Meia tela de consentimento é pior que nenhuma — ela
        ensina que ali só dá para revogar uma coisa, e o titular para de
        procurar. As três são separadas porque a LGPD as separa: quem autoriza
        a foto na ficha não autorizou a foto no Instagram.
      */}
      <p className="meus__consentimento-estado">
        Cada uma é uma decisão sua, e dá para mudar quando quiser. O aviso do seu
        horário chega de qualquer jeito — ele é parte do serviço, não é promoção.
      </p>

      {CONSENTIMENTOS_OPCIONAIS.map((item) => {
        const aceita = decisoes[item.finalidade].concedido;
        return (
          <div className="meus__consentimento-item" key={item.finalidade}>
            <h3 className="meus__consentimento-titulo">{item.titulo}</h3>
            <p className="meus__consentimento-texto">{item.texto}</p>
            <p className="meus__consentimento-estado">
              {aceita ? 'Você autorizou.' : 'Você não autorizou.'}
            </p>
            {/*
              Botão que faz, e não caixa que precisa de "Salvar" ao lado: um
              formulário de um campo com botão de salvar é onde a pessoa marca e
              vai embora achando que salvou.
            */}
            <form action={decidirConsentimentoDoTitular}>
              <input name="slug" type="hidden" value={slug} />
              <input name="finalidade" type="hidden" value={item.finalidade} />
              <input name="concedido" type="hidden" value={aceita ? '0' : '1'} />
              <button
                className="ui-button ui-button--ghost meus__consentimento-botao"
                type="submit"
              >
                {/* Sem `toLowerCase()`: ele transformava "Promoções por
                    WhatsApp" em "promoções por whatsapp", e nome de marca em
                    caixa baixa lê como erro de digitação na tela do cliente. */}
                {aceita ? `Não quero mais: ${item.titulo}` : `Autorizar: ${item.titulo}`}
              </button>
            </form>
          </div>
        );
      })}
    </section>
  );
}

/**
 * Rótulo do que já passou.
 *
 * `rescheduled` tem texto próprio: o horário virou outro, não sumiu. Escrever
 * "Cancelado" ali faria quem acabou de remarcar achar que perdeu a vaga.
 */
const ESTADO: Record<string, string> = {
  cancelled: 'Cancelado',
  done: 'Atendido',
  rescheduled: 'Remarcado',
};

/**
 * Por que o botão não está lá. Ausência sem explicação parece defeito.
 *
 * A frase nomeia **o que** ficou bloqueado, e não "alterações" em geral. A
 * janela de remarcação costuma ser mais folgada que a de cancelamento —
 * remarcar preserva a receita, cancelar não —, então existe o caso em que
 * cancelar ainda dá e remarcar já não: com a frase genérica, o cartão dizia
 * "alterações até 6 horas antes" **ao lado do botão Cancelar funcionando**, que
 * é a §6 pergunta 6 acontecendo dentro de um cartão só.
 */
function motivoBloqueio(item: AgendamentoDoCliente): string | null {
  if (item.blockedReason === 'too_late') {
    const horas = item.minHoursToChange === 1 ? '1 hora' : `${item.minHoursToChange} horas`;
    return item.canCancel
      ? `Remarcar, só até ${horas} antes. Ainda dá para cancelar, ou falar com a barbearia.`
      : `Alterações até ${horas} antes. Para mudar agora, fale com a barbearia.`;
  }
  if (item.blockedReason === 'already_started') return 'Este horário já começou.';
  if (item.blockedReason === 'too_many_reschedules') {
    return 'Limite de remarcações atingido. Fale com a barbearia para mudar.';
  }
  return null;
}

export default async function MeusAgendamentosPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const query = await searchParams;
  const profile = await getProfile(slug);
  if (!profile) notFound();

  const token = await lerSessao(slug);
  if (!token) redirect(`/${slug}/entrar`);

  const agendamentos = await listarAgendamentos(slug, token);
  // `null` é sessão morta, não lista vazia. Mostrar "nenhum agendamento" aqui
  // faria o cliente achar que perdeu o horário.
  if (agendamentos === null) redirect(`/${slug}/entrar`);

  // Lido junto e não numa segunda volta: são duas rotas independentes e a tela
  // precisa das duas para montar. Em série, o cliente espera as duas somadas.
  const consentimento = await lerConsentimento(slug, token);
  const esperas = await listarEsperas(slug, token);
  const fidelidade = await meuSaldoDeFidelidade(slug, token);
  const pacotes = await meusPacotes(slug, token);
  const plano = await meuPlano(slug, token);
  const aAvaliar = await meusAtendimentosAAvaliar(slug, token);
  // Só os que ainda servem: esgotado e vencido viram histórico, e histórico aqui
  // empurra para baixo o que a pessoa abriu a página para ver.
  const pacotesUteis = pacotes.filter((p) => p.estado === 'ativo' && p.restam > 0);

  /**
   * A mensalidade em atraso, quando existe.
   *
   * Uma só e a mais urgente: duas frases de cobrança na mesma tela é o que faz o
   * cliente parar de ler as duas.
   */
  const atrasada = (plano?.faturas ?? []).find(
    (f) => f.estado === 'aberta' && f.diasAteSuspender !== null,
  );
  const mensalidades = (plano?.faturas ?? []).slice(0, 12);

  const proximos = agendamentos.filter((a) => a.state === 'active');
  const anteriores = agendamentos.filter((a) => a.state !== 'active');

  const falha = first(query['erro']);
  const feito = first(query['feito']);

  return (
    <main className="ui-container meus">
      <header className="meus__topo">
        <a className="meus__voltar" href={`/${slug}`}>
          ← {profile.name}
        </a>
        <form action={sair}>
          <input type="hidden" name="slug" value={slug} />
          <button className="ui-button ui-button--ghost meus__sair" type="submit">
            Sair
          </button>
        </form>
      </header>

      <h1 className="meus__titulo">Meus agendamentos</h1>

      {feito ? (
        <div className="ui-alert ui-alert--success meus__aviso" role="status">
          {FEITO[feito] ?? 'Pronto.'}
        </div>
      ) : null}
      {falha ? (
        <div className="ui-alert ui-alert--danger meus__aviso" role="alert">
          {FALHA[falha] ?? 'Não foi possível concluir. Tente de novo.'}
        </div>
      ) : null}

      {proximos.length === 0 && anteriores.length === 0 && esperas.length === 0 ? (
        <div className="vazio">
          <p className="vazio__titulo">Você ainda não tem agendamento aqui</p>
          <p className="vazio__saida">Escolha um serviço e um horário — leva menos de um minuto.</p>
          <a className="ui-button ui-button--primary" href={`/${slug}/agendar`}>
            Agendar horário
          </a>
        </div>
      ) : null}

      {proximos.length > 0 ? (
        <section aria-labelledby="proximos">
          <h2 className="rotulo" id="proximos">
            Próximos
          </h2>
          <ul className="cartoes">
            {proximos.map((item) => (
              <li key={item.id}>
                <Cartao item={item} slug={slug} timezone={profile.location.timezone} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {anteriores.length > 0 ? (
        <section aria-labelledby="anteriores">
          <h2 className="rotulo" id="anteriores">
            Anteriores
          </h2>
          <ul className="cartoes">
            {anteriores.map((item) => (
              <li key={item.id}>
                <Cartao item={item} slug={slug} timezone={profile.location.timezone} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {proximos.length > 0 ? (
        <div className="ui-sticky-action">
          <div className="ui-container">
            <a
              className="ui-button ui-button--secondary ui-button--block"
              href={`/${slug}/agendar`}
            >
              Agendar outro horário
            </a>
          </div>
        </div>
      ) : null}

      {/*
        A lista de espera, e a saída dela (bloco 38).

        Fica **depois** dos agendamentos e antes das preferências: quem espera
        uma vaga costuma ter um horário marcado também — a espera é o "quero
        antecipar", não o "não tenho nada". Pô-la no topo diria o contrário.
      */}
      {esperas.length > 0 ? (
        <section aria-labelledby="esperando">
          <h2 className="rotulo" id="esperando">
            Esperando uma vaga
          </h2>
          <ul className="cartoes">
            {esperas.map((espera) => (
              <li key={espera.id}>
                <Espera espera={espera} slug={slug} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* O saldo de fidelidade (bloco 41, SPEC §4.8: "exibição do saldo no app
          e no PDV"). Só aparece quando a barbearia tem programa — um bloco
          dizendo "0 pontos" numa casa sem programa é ruído. */}
      {fidelidade && fidelidade.modo !== 'nenhum' ? (
        <section aria-labelledby="fidelidade">
          <h2 className="rotulo" id="fidelidade">
            Seu saldo
          </h2>
          <div className="saldo-fidelidade">
            <p className="saldo-fidelidade__numero tabular">
              {saldoPorExtenso(fidelidade.modo, fidelidade.saldo)}
            </p>
            <p className="saldo-fidelidade__nota">
              {fidelidade.faltaParaPremio === null
                ? 'Use na barbearia, na hora de pagar.'
                : fidelidade.faltaParaPremio === 0
                  ? 'Cartão completo — seu próximo corte pode sair de graça.'
                  : `Faltam ${fidelidade.faltaParaPremio} para o corte grátis.`}
            </p>
            {/*
              Onde cada parte do saldo vale, quando o programa é por unidade.
              O número acima é tudo o que a pessoa tem; a lista é o que impede
              que ela peça no balcão um resgate que a comanda recusaria. Vem
              vazia sob `empresa`, e vazia também quando há um bolso só — ali
              ela repetiria o número de cima.
            */}
            {fidelidade.porUnidade.length > 0 ? (
              <ul className="saldo-fidelidade__lojas">
                {/*
                  O bolso que vale em qualquer loja abre a lista, e ele não é
                  opcional: sem esta linha o cartão mostrava 951 em cima e
                  180 + 95 embaixo, três números que não fecham e nenhuma frase
                  explicando a diferença. A lista tem que somar o número de
                  cima, senão ela levanta a pergunta que existe para responder.
                */}
                {fidelidade.saldoCompartilhado > 0 ? (
                  <li>
                    <span className="saldo-fidelidade__loja">{ROTULO_DO_ESCOPO.empresa}</span>
                    <span className="tabular">
                      {saldoPorExtenso(fidelidade.modo, fidelidade.saldoCompartilhado)}
                    </span>
                  </li>
                ) : null}
                {fidelidade.porUnidade.map((loja) => (
                  <li key={loja.unidadeId}>
                    <span className="saldo-fidelidade__loja">Só na {loja.unidade}</span>
                    <span className="tabular">
                      {saldoPorExtenso(fidelidade.modo, loja.saldo)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </section>
      ) : null}

      {/*
        Dar a nota do atendimento (bloco 43, SPEC §4.10).

        Fica **acima** dos pacotes e do saldo porque tem prazo e porque é a única
        coisa nesta página que a barbearia está esperando desta pessoa. As
        quatro categorias da SPEC ficam de fora do formulário de propósito: um
        formulário que pede cinco notas para elogiar um corte é um formulário
        que ninguém preenche, e a nota geral é a que entra na média.

        Cada estrela é um alvo de 44px em qualquer largura — o rádio nativo é
        pequeno demais para o polegar, e esta é a única interação da tela.
      */}
      {aAvaliar.length > 0 ? (
        <section aria-labelledby="avaliar" className="dar-nota">
          <h2 className="rotulo" id="avaliar">
            Como foi seu atendimento?
          </h2>
          {aAvaliar.map((atendimento) => (
            <form action={avaliar} className="dar-nota__item" key={atendimento.id}>
              <input name="slug" type="hidden" value={slug} />
              <input name="appointmentId" type="hidden" value={atendimento.id} />

              <p className="dar-nota__quem">
                {atendimento.servico ?? 'Atendimento'}
                {atendimento.profissional ? ` com ${atendimento.profissional}` : ''} ·{' '}
                {new Date(atendimento.quando).toLocaleDateString('pt-BR')}
              </p>

              <fieldset className="dar-nota__estrelas">
                <legend className="ui-field__label">Sua nota</legend>
                {[1, 2, 3, 4, 5].map((nota) => (
                  <label className="dar-nota__estrela" key={nota}>
                    {/* O rádio é escondido e o alvo é a estrela inteira, então
                        ele declara que tem marca própria — sem isso o design
                        system o dimensiona em 44px, e o que sobra é uma caixa
                        invisível daquele tamanho dentro do botão. */}
                    <input className="ui-marca-propria" name="nota" required type="radio" value={nota} />
                    {/* O número e uma estrela: as estrelas acumuladas davam
                        botões de larguras diferentes, e a escala fica igual de
                        legível com "3 ★". */}
                    <span aria-label={`${nota} de 5`}>
                      {nota}
                      <span aria-hidden="true"> ★</span>
                    </span>
                  </label>
                ))}
              </fieldset>

              <label className="ui-field">
                <span className="ui-field__label">
                  Quer contar alguma coisa? <span className="ui-field__hint">(opcional)</span>
                </span>
                <textarea
                  className="ui-field__input"
                  maxLength={1000}
                  name="comentario"
                  placeholder="O que foi bom, o que dava para melhorar."
                  rows={2}
                />
              </label>

              <button className="ui-button ui-button--primary ui-button--block" type="submit">
                Enviar
              </button>
            </form>
          ))}
          <p className="politica">
            A barbearia lê todas. Nota baixa abre um aviso interno para ela falar com você antes
            de a avaliação ir para o perfil público.
          </p>
        </section>
      ) : null}

      {/*
        Os pacotes (bloco 42, SPEC §4.7).

        "Ainda tenho corte?" é o que o cliente manda no WhatsApp da barbearia, e
        é a pergunta que este bloco tira da recepção. Só os que ainda servem: um
        pacote esgotado de dois anos atrás vira histórico, e histórico aqui só
        empurra para baixo o que a pessoa abriu a página para ver.

        A frase vem do domínio, a mesma que o balcão lê — quando a recepção diz
        "resta um", o cliente já leu a mesma coisa aqui.
      */}
      {plano?.assinatura ? (
        <section aria-labelledby="meu-plano">
          <h2 className="rotulo" id="meu-plano">
            Meu plano
          </h2>

          <div className="plano-cliente">
            <p className="plano-cliente__nome">{plano.assinatura.planoNome}</p>
            <p className="plano-cliente__frase">
              R$ {(plano.assinatura.precoCents / 100).toLocaleString('pt-BR', {
                minimumFractionDigits: 2,
              })}{' '}
              por mês · ciclo até {dataCurta(plano.assinatura.cicloAte)}
            </p>

            <ul className="plano-cliente__usos">
              {plano.assinatura.beneficios.map((b) => (
                <li key={b.serviceId}>
                  {b.quantidade === null
                    ? `${b.servicoNome} ilimitado`
                    : `${b.servicoNome}: ${b.usados} de ${b.quantidade} usados neste ciclo`}
                </li>
              ))}
            </ul>

            {atrasada ? (
              /*
                A frase não acusa, e é decisão de produto: cortar o acesso — ou
                tratar o cliente como caloteiro — no primeiro erro de cartão gera
                cancelamento por raiva, não por preço.
              */
              <p className="plano-cliente__aviso">
                Um pagamento não passou.{' '}
                {atrasada.diasAteSuspender === 0
                  ? 'Seu plano pausa hoje.'
                  : `Você continua cortando por mais ${atrasada.diasAteSuspender} dias.`}{' '}
                Fale com a barbearia para acertar.
              </p>
            ) : null}

            {plano.assinatura.pausadoDesde ? (
              <p className="plano-cliente__aviso">
                Seu plano está pausado desde {dataCurta(plano.assinatura.pausadoDesde)}. Você
                continua sendo atendido normalmente, pelo preço de tabela.
              </p>
            ) : null}

            {plano.assinatura.valeAte ? (
              <>
                <p className="plano-cliente__frase">
                  Você pediu para sair. O plano vale até {dataCurta(plano.assinatura.valeAte)} —
                  nada muda até lá, e não haverá nova cobrança.
                </p>
                <form action={manterPlano}>
                  <input name="slug" type="hidden" value={slug} />
                  <button className="ui-button ui-button--primary" type="submit">
                    Quero continuar no plano
                  </button>
                </form>
              </>
            ) : (
              <details className="dobra">
                <summary className="dobra__titulo">Cancelar meu plano</summary>
                <form action={cancelarPlano} className="plano-cliente__cancelar">
                  <input name="slug" type="hidden" value={slug} />
                  <p className="plano-cliente__frase">
                    Você continua cortando até {dataCurta(plano.assinatura.cicloAte)}, que é o mês
                    que já está pago. Depois disso o plano acaba e não há nova cobrança.
                  </p>
                  <div className="ui-field">
                    <label className="ui-field__label" htmlFor="motivo-plano">
                      Quer contar por quê? (opcional)
                    </label>
                    <input
                      className="ui-field__input"
                      id="motivo-plano"
                      maxLength={300}
                      name="motivo"
                      type="text"
                    />
                  </div>
                  <button className="ui-button ui-button--secondary" type="submit">
                    Cancelar plano
                  </button>
                </form>
              </details>
            )}
          </div>

          {mensalidades.length > 0 ? (
            <details className="dobra">
              <summary className="dobra__titulo">Minhas mensalidades</summary>
              <ul className="plano-cliente__extrato">
                {mensalidades.map((f) => (
                  <li key={f.id}>
                    <span>{dataCurta(f.periodoDe)}</span>
                    <span className="tabular">
                      R$ {(f.valorCents / 100).toLocaleString('pt-BR', {
                        minimumFractionDigits: 2,
                      })}
                    </span>
                    <span>
                      {f.estado === 'paga' ? 'Paga' : f.estado === 'aberta' ? 'Em aberto' : 'Cancelada'}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      ) : null}

      {pacotesUteis.length > 0 ? (
        <section aria-labelledby="pacotes">
          <h2 className="rotulo" id="pacotes">
            Seus pacotes
          </h2>
          {pacotesUteis.map((pacote) => (
            <div className="pacote-cliente" key={pacote.id}>
              <div className="pacote-cliente__quem">
                <p className="pacote-cliente__nome">{pacote.servicoNome}</p>
                <p className="pacote-cliente__frase">{pacote.frase}</p>
                <div aria-hidden="true" className="pacote-cliente__barra">
                  <span
                    style={{ width: `${Math.round((pacote.usados / pacote.total) * 100)}%` }}
                  />
                </div>
                {pacote.venceEm ? (
                  <p className="pacote-cliente__frase">
                    Vale até {new Date(pacote.venceEm).toLocaleDateString('pt-BR')}.
                  </p>
                ) : null}
              </div>
            </div>
          ))}
          <p className="politica">
            É só dizer no balcão que quer usar o pacote. Não precisa levar nada.
          </p>
        </section>
      ) : null}

      {/* A segunda porta do canal de recados: quem já é cliente entra por aqui,
          e o recado sai identificado — a barbearia sabe a quem responder. */}
      <section aria-labelledby="falar">
        <h2 className="rotulo" id="falar">
          Falar com a barbearia
        </h2>
        <p className="politica">
          Alguma sugestão, reclamação ou elogio? Chega direto para a equipe.{' '}
          <a href={`/${slug}/falar`}>Escrever agora</a>.
        </p>
      </section>

      {consentimento ? <Consentimentos decisoes={consentimento} slug={slug} /> : null}
      <MeusDados encarregado={profile.encarregado} nome={profile.name} slug={slug} />
    </main>
  );
}

/**
 * Uma espera, com a saída dela.
 *
 * O período vem em duas frases porque "de 15/08 a 15/08" é o caso comum e
 * lê-se pior que "15 de agosto". Quem pediu uma faixa vê a faixa.
 */
function Espera({ espera, slug }: { espera: EsperaDoCliente; slug: string }) {
  const umDia = espera.de === espera.ate;

  /**
   * O convite abre o cartão, e é a única coisa que a pessoa precisa ver.
   *
   * Ele chega por mensagem, mas a mensagem pode não chegar — e o horário está
   * guardado com o relógio correndo. Sem esta saída na tela, "um horário abriu
   * para você" seria uma informação sem ação (CLAUDE.md §6).
   */
  if (espera.convite) {
    return (
      <article className="cartao cartao--convite">
        <p className="cartao__selo">Abriu um horário para você</p>
        <p className="cartao__quando tabular">
          {diaLongo(espera.convite.dia)} às {espera.convite.hora}
        </p>
        <p className="cartao__servico">
          {espera.servicos.join(' + ')}
          {espera.profissionalNome ? ` · com ${espera.profissionalNome}` : ''}
        </p>
        <p className="cartao__quem">
          Guardado para você por mais{' '}
          <strong>
            {espera.convite.minutosRestantes}{' '}
            {espera.convite.minutosRestantes === 1 ? 'minuto' : 'minutos'}
          </strong>
          .
        </p>

        <form action={aceitarVaga}>
          <input name="slug" type="hidden" value={slug} />
          <input name="id" type="hidden" value={espera.id} />
          <button className="ui-button ui-button--primary cartao__acao" type="submit">
            Quero este horário
          </button>
        </form>
      </article>
    );
  }

  return (
    <article className="cartao">
      <p className="cartao__quando tabular">
        {umDia ? diaLongo(espera.de) : `${diaCurto(espera.de)} a ${diaCurto(espera.ate)}`}
      </p>
      <p className="cartao__servico">
        {espera.servicos.join(' + ')} · das {espera.inicio} às {espera.fim}
      </p>
      <p className="cartao__quem">
        {espera.profissionalNome ?? 'Com qualquer barbeiro'}
      </p>

      <form action={sairDaEspera}>
        <input name="slug" type="hidden" value={slug} />
        <input name="id" type="hidden" value={espera.id} />
        <button className="ui-button ui-button--ghost cartao__acao" type="submit">
          Sair da lista
        </button>
      </form>
    </article>
  );
}

/**
 * Os dados do titular, do lado dele (bloco 31, SPEC §1.8.4).
 *
 * ## O botão existe porque o caminho de trás depende de memória
 *
 * A recepção também registra o pedido pela ficha. Só que o pedido chega por
 * WhatsApp num sábado cheio, e o prazo de 15 dias corre da conversa — não de
 * quando alguém anotar. Aqui quem pede já está identificado, e o registro é
 * imediato.
 *
 * ## Por que o encarregado aparece com nome e e-mail
 *
 * A LGPD art. 41 §1 manda divulgar publicamente quem é e como falar com ele.
 * Uma tela que só oferece um botão diz ao titular o que **este produto** faz;
 * o contato é o que resta quando ele quer algo que o botão não cobre — corrigir
 * um dado errado, reclamar, ou pedir a exclusão.
 */
function MeusDados({
  slug,
  nome,
  encarregado,
}: {
  readonly slug: string;
  readonly nome: string;
  readonly encarregado: { readonly nome: string; readonly email: string | null } | null;
}) {
  return (
    <section className="meus__consentimento">
      <h2 className="meus__secao">Meus dados</h2>
      <p className="meus__consentimento-texto">
        Você pode pedir uma cópia de tudo que a {nome} guarda sobre você.
      </p>
      <p className="meus__consentimento-estado">
        O pedido é registrado agora e a barbearia responde em até 15 dias. Pedir de novo não
        adianta o prazo — é o mesmo pedido.
      </p>

      <form action={pedirDados}>
        <input name="slug" type="hidden" value={slug} />
        <input name="tipo" type="hidden" value="export" />
        <button className="ui-button ui-button--ghost meus__consentimento-botao" type="submit">
          Pedir uma cópia dos meus dados
        </button>
      </form>

      {/*
        Apagar fica atrás de um `details` (bloco 32).

        Não é para esconder — o texto do resumo diz exatamente o que há dentro,
        e nada some no celular. É para não ficar do lado de "pedir uma cópia"
        com o mesmo peso visual: são pedidos de gravidade muito diferente, e um
        toque errado no botão vizinho é fácil demais com o polegar, em pé, na
        rua. Abrir é o passo que separa a intenção do acidente.
      */}
      <details className="meus__apagar">
        <summary className="meus__apagar-abrir">Quero apagar meus dados</summary>
        <p className="meus__consentimento-estado">
          A {nome} apaga o seu nome, telefone e as anotações sobre você. O que a lei manda ela
          guardar — as vendas e o que você deve ou tem de crédito — continua, mas sem ligação com
          você. Isso não tem volta, e você perde o histórico dos seus cortes.
        </p>
        <form action={pedirDados}>
          <input name="slug" type="hidden" value={slug} />
          <input name="tipo" type="hidden" value="deletion" />
          <button className="ui-button ui-button--ghost meus__consentimento-botao" type="submit">
            Pedir para apagar meus dados
          </button>
        </form>
      </details>

      {encarregado ? (
        <p className="meus__consentimento-estado">
          Para corrigir um dado ou tirar dúvida, fale com {encarregado.nome}
          {encarregado.email ? (
            <>
              {' '}
              pelo <a href={`mailto:${encarregado.email}`}>{encarregado.email}</a>
            </>
          ) : null}
          .
        </p>
      ) : null}
    </section>
  );
}

function Cartao({
  item,
  slug,
  timezone,
}: {
  item: AgendamentoDoCliente;
  slug: string;
  timezone: string;
}) {
  const minutos = Math.round(
    (new Date(item.endsAt).getTime() - new Date(item.startsAt).getTime()) / 60000,
  );
  const bloqueio = item.state === 'active' ? motivoBloqueio(item) : null;

  return (
    <article className={`cartao cartao--${item.state}`}>
      <p className="cartao__quando tabular">{humanInstant(timezone, item.startsAt)}</p>
      <p className="cartao__servico">{item.services.join(' + ')}</p>
      <p className="cartao__dados">
        com {item.professionalName} · {minutos} min ·{' '}
        <span className="tabular">R$ {money(item.priceCents)}</span>
      </p>

      {ESTADO[item.state] ? <p className="cartao__estado">{ESTADO[item.state]}</p> : null}

      {bloqueio ? <p className="cartao__bloqueio">{bloqueio}</p> : null}

      {item.canCancel || item.canReschedule ? (
        <div className="cartao__acoes">
          {item.canReschedule ? (
            <a
              className="ui-button ui-button--secondary"
              href={`/${slug}/meus-agendamentos/${item.id}/remarcar`}
            >
              Remarcar
            </a>
          ) : null}
          {item.canCancel ? (
            /* Formulário, não link: cancelar altera estado, e link com efeito
               colateral é acionado por prefetch e por leitor de tela. */
            <form action={cancelar}>
              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="id" value={item.id} />
              <button className="ui-button ui-button--ghost cartao__cancelar" type="submit">
                Cancelar
              </button>
            </form>
          ) : null}
        </div>
      ) : null}

      {item.state === 'done' ? (
        <a className="cartao__repetir" href={`/${slug}/agendar`}>
          Agendar de novo
        </a>
      ) : null}
    </article>
  );
}
