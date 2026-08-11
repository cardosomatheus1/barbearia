import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import {
  getProfile,
  lerConsentimento,
  listarAgendamentos,
  listarEsperas,
  meuSaldoDeFidelidade,
  meusPacotes,
  type AgendamentoDoCliente,
  type EsperaDoCliente,
} from '@/lib/api';
import { saldoPorExtenso } from '@barbearia/core';
import { humanInstant } from '@/lib/date';
import { lerSessao } from '@/lib/sessao';
import { TEXTO_DO_CONSENTIMENTO } from '@/lib/politica';
import {
  aceitarVaga,
  cancelar,
  decidirMarketing,
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

const money = (cents: number): string =>
  (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

const FALHA: Record<string, string> = {
  too_late: 'Passou do prazo para mexer neste horário. Ligue para a barbearia.',
  already_started: 'Este horário já começou.',
  too_many_reschedules: 'Este horário já foi remarcado o máximo de vezes.',
  appointment_not_found: 'Este agendamento não está mais ativo.',
  slot_taken: 'O horário novo acabou de ser ocupado. Escolha outro.',
  slot_not_available: 'O horário novo já não está disponível. Escolha outro.',
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
function Promocao({
  slug,
  aceita,
}: {
  readonly slug: string;
  readonly aceita: boolean;
}) {
  return (
    <section className="meus__consentimento">
      <h2 className="meus__secao">Promoções</h2>
      <p className="meus__consentimento-texto">{TEXTO_DO_CONSENTIMENTO}</p>
      <p className="meus__consentimento-estado">
        {aceita ? 'Você aceita receber.' : 'Você não recebe promoção desta barbearia.'}{' '}
        {/* A frase existe porque a dúvida é real e faz gente recusar por medo de
            perder o lembrete do próprio corte. */}
        O aviso do seu horário chega de qualquer jeito — ele é parte do serviço.
      </p>
      <form action={decidirMarketing}>
        <input name="slug" type="hidden" value={slug} />
        <input name="marketing" type="hidden" value={aceita ? '0' : '1'} />
        <button className="ui-button ui-button--ghost meus__consentimento-botao" type="submit">
          {aceita ? 'Parar de receber promoções' : 'Quero receber promoções'}
        </button>
      </form>
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

/** Por que o botão não está lá. Ausência sem explicação parece defeito. */
function motivoBloqueio(item: AgendamentoDoCliente): string | null {
  if (item.blockedReason === 'too_late') {
    const horas = item.minHoursToChange === 1 ? '1 hora' : `${item.minHoursToChange} horas`;
    return `Alterações até ${horas} antes. Para mudar agora, fale com a barbearia.`;
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
  // Só os que ainda servem: esgotado e vencido viram histórico, e histórico aqui
  // empurra para baixo o que a pessoa abriu a página para ver.
  const pacotesUteis = pacotes.filter((p) => p.estado === 'ativo' && p.restam > 0);

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
          </div>
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

      {consentimento ? <Promocao aceita={consentimento.marketing} slug={slug} /> : null}
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
