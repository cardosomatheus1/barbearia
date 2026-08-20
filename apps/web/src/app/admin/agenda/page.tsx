import { redirect } from 'next/navigation';
import {
  ROTULO_DO_ESTADO,
  ROTULO_DO_TIPO_DE_EXCECAO,
  TIPOS_DE_EXCECAO,
} from '@barbearia/core';
import type { Metadata } from 'next';
import {
  agendaDoAdmin,
  quemEsperaVaga,
  type DiaDaAgenda,
  type EntradaDaAgenda,
  type ExcecaoDaAgenda,
  type QuemEspera,
  type TipoDeExcecao,
} from '@/lib/admin-api';
import { painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerConflitoDaAgenda, lerSessaoGestor } from '@/lib/sessao-gestor';
import { addDays, weekdayShort } from '@/lib/date';
import { paraHHMM } from '@/lib/jornada';
import {
  acaoCriarExcecao,
  acaoMoverAgendamento,
  acaoRemoverExcecao,
  acaoSair,
  acaoTirarDaEspera,
} from '../acoes';
import { secao } from '../secoes';
import { AvisoDeRecusa } from '@/app/admin/aviso-de-recusa';

/**
 * A agenda do admin.
 *
 * Dia, semana e lista são o **mesmo dado** em intervalos diferentes — uma
 * consulta, três recortes. Três telas separadas seriam três consultas para
 * manter em sincronia, e a primeira a divergir seria a que ninguém abre.
 *
 * O que a SPEC §2.14 pede e está aqui: bloqueios visíveis com o motivo, buffer
 * distinto da execução, e mover um agendamento com confirmação.
 *
 * O que ela pede e **não** está: arrastar. A decisão e o motivo estão na tabela
 * de lacunas do `ROADMAP.md` — em resumo, mover é o caminho principal porque a
 * WCAG 2.5.7 exige alternativa de um ponteiro para qualquer arraste, e arrastar
 * seria o primeiro componente de cliente do produto, decisão grande demais para
 * entrar de carona.
 */

export const metadata: Metadata = {
  title: 'Agenda',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

type Vista = 'dia' | 'semana' | 'lista';

const FALHA: Record<string, string> = {
  invalid_request: 'Confira os horários: o fim precisa ser depois do início.',
  invalid_exception: 'Confira os dados da exceção.',
  faixa_ausente: 'Informe a hora de início e a de fim.',
  tipo_invalido: 'Este tipo de exceção não existe.',
  slot_taken: 'Este horário já tem cliente. Escolha outro.',
  slot_not_available: 'O motor não oferece esse horário — pode estar fora da jornada ou bloqueado.',
  appointment_not_found: 'Este agendamento não existe mais.',
  appointment_not_active: 'Só agendamento ativo pode ser movido.',
  exception_not_found: 'Esta exceção não existe mais.',
  unknown_professional: 'Profissional não encontrado.',
  invalid_range: 'Intervalo grande demais.',
  request_failed: 'Não deu para salvar. Tente de novo.',
};

const NOME_DO_TIPO: Record<TipoDeExcecao, string> = {
  block: 'Bloqueio',
  day_off: 'Folga',
  holiday: 'Feriado',
  vacation: 'Férias',
  custom_hours: 'Horário diferente',
};

/**
 * O mesmo rótulo do balcão, vindo de `packages/core`.
 *
 * Esta tela escrevia "chegou / esperando / atendendo" em minúscula, enquanto o
 * balcão dizia "Chegou / Aguardando / Em atendimento" — três palavras
 * diferentes para os mesmos três estados, na mesma barbearia, muitas vezes na
 * mesma hora.
 */
const ESTADO = ROTULO_DO_ESTADO;

function Excecao({
  excecao,
  data,
  vista,
  nomes,
}: {
  readonly excecao: ExcecaoDaAgenda;
  readonly data: string;
  readonly vista: Vista;
  readonly nomes: ReadonlyMap<string, string>;
}) {
  const dono = excecao.professionalId
    ? (nomes.get(excecao.professionalId) ?? 'profissional')
    : 'a barbearia toda';

  return (
    <li className="bloqueio">
      <p className="bloqueio__quando tabular">
        {excecao.start && excecao.end ? `${excecao.start}–${excecao.end}` : 'dia inteiro'}
      </p>
      <p className="bloqueio__oque">
        <strong>{NOME_DO_TIPO[excecao.kind]}</strong> · {dono}
        {excecao.reason ? ` · ${excecao.reason}` : ''}
      </p>
      <form action={acaoRemoverExcecao} className="bloqueio__acao">
        <input name="id" type="hidden" value={excecao.id} />
        <input name="de" type="hidden" value={data} />
        <input name="v" type="hidden" value={vista} />
        <button className="ui-button ui-button--ghost bloqueio__miuda" type="submit">
          Remover
        </button>
      </form>
    </li>
  );
}

function Cartao({
  entrada,
  data,
  vista,
  profissionais,
}: {
  readonly entrada: EntradaDaAgenda;
  readonly data: string;
  readonly vista: Vista;
  readonly profissionais: readonly { id: string; name: string }[];
}) {
  const comBuffer =
    entrada.occupiedStart !== entrada.start || entrada.occupiedEnd !== entrada.end;

  return (
    <li className={`compromisso compromisso--${entrada.status}`}>
      <p className="compromisso__hora">
        <time className="tabular">{entrada.start}</time>
        <span className="compromisso__ate tabular">até {entrada.end}</span>
        {comBuffer ? (
          // A SPEC §2.14 pede o buffer distinto da execução: é ele que explica
          // por que o horário seguinte não está livre com o corte já terminado.
          <span className="compromisso__buffer tabular">
            ocupa {entrada.occupiedStart}–{entrada.occupiedEnd}
          </span>
        ) : null}
      </p>

      <div className="compromisso__quem">
        <p className="compromisso__nome">{entrada.customerName ?? 'sem cliente'}</p>
        <p className="compromisso__servico">{entrada.services.join(' + ')}</p>
        <p className="compromisso__estado">
          {ESTADO[entrada.status] ?? entrada.status}
          {/**
           * Saída para onde se **age**.
           *
           * O cartão mostrava "Na cadeira" e "Atendido" e não oferecia nada
           * além de "Mover": um estado de operação sem saída na tela. A
           * separação é de propósito — a agenda planeja, o dia opera —, mas
           * quem lê o estado aqui e precisa agir estava sozinho, procurando a
           * data certa no trilho.
           *
           * Link, e não os botões de atendimento: a máquina de estados vive em
           * uma tela só. Duplicá-la é como a mesma transição ganha nomes
           * diferentes, que é o defeito que acabou de ser consertado.
           */}
          <a className="compromisso__ir" href={`/admin/dia?d=${data}`}>
            Ver no dia
          </a>
        </p>
      </div>

      <details className="dobra compromisso__mover">
        <summary className="dobra__titulo">Mover</summary>
        <form action={acaoMoverAgendamento} className="formulario">
          <input name="id" type="hidden" value={entrada.id} />
          <input name="de" type="hidden" value={data} />
          <input name="v" type="hidden" value={vista} />

          <div className="campos-lado">
            <div className="ui-field">
              <label className="ui-field__label" htmlFor={`data-${entrada.id}`}>
                Para o dia
              </label>
              <input
                className="ui-field__input"
                defaultValue={data}
                id={`data-${entrada.id}`}
                name="date"
                required
                type="date"
              />
            </div>
            <div className="ui-field">
              <label className="ui-field__label" htmlFor={`hora-${entrada.id}`}>
                Às
              </label>
              <input
                className="ui-field__input"
                defaultValue={entrada.start}
                id={`hora-${entrada.id}`}
                name="start"
                required
                type="time"
              />
            </div>
          </div>

          <div className="ui-field">
            <label className="ui-field__label" htmlFor={`pro-${entrada.id}`}>
              Com quem
            </label>
            <select
              className="ui-field__input"
              defaultValue={entrada.professionalId}
              id={`pro-${entrada.id}`}
              name="professionalId"
            >
              {profissionais.map((pro) => (
                <option key={pro.id} value={pro.id}>
                  {pro.name}
                </option>
              ))}
            </select>
          </div>

          <button className="ui-button ui-button--primary ui-button--block" type="submit">
            Mover este horário
          </button>
          <p className="ui-field__hint">
            O horário de destino passa pelo mesmo motor da página pública. Se já tiver cliente ou
            estiver fora da jornada, o sistema recusa e diz por quê.
          </p>
        </form>
      </details>
    </li>
  );
}

function Coluna({
  profissional,
  dia,
  vista,
  profissionais,
}: {
  readonly profissional: { id: string; name: string };
  readonly dia: DiaDaAgenda;
  readonly vista: Vista;
  readonly profissionais: readonly { id: string; name: string }[];
}) {
  const entries = dia.entries.filter((e) => e.professionalId === profissional.id);
  const excecoes = dia.exceptions.filter(
    (e) => e.professionalId === profissional.id || e.professionalId === null,
  );

  return (
    <section className="coluna" aria-labelledby={`col-${profissional.id}-${dia.date}`}>
      <h3 className="coluna__nome" id={`col-${profissional.id}-${dia.date}`}>
        {profissional.name}
        <span className="coluna__contagem tabular">{entries.length}</span>
      </h3>

      {excecoes.length > 0 ? (
        <ul className="bloqueios">
          {excecoes.map((excecao) => (
            <Excecao
              data={dia.date}
              excecao={excecao}
              key={excecao.id}
              nomes={new Map(profissionais.map((p) => [p.id, p.name]))}
              vista={vista}
            />
          ))}
        </ul>
      ) : null}

      {entries.length === 0 ? (
        <p className="coluna__vazia">Nada marcado.</p>
      ) : (
        <ul className="compromissos">
          {entries.map((entrada) => (
            <Cartao
              data={dia.date}
              entrada={entrada}
              key={entrada.id}
              profissionais={profissionais}
              vista={vista}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export default async function AgendaPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const query = await searchParams;

  const vistaBruta = first(query['v']);
  const vista: Vista =
    vistaBruta === 'semana' || vistaBruta === 'lista' ? vistaBruta : 'dia';

  // Sem `de` na URL, a API resolve "hoje" no fuso da unidade — nunca o "hoje"
  // do dispositivo, que é o defeito D2. Uma consulta, não duas.
  const pedido = first(query['de']);
  const deQuery = pedido && /^\d{4}-\d{2}-\d{2}$/.test(pedido) ? pedido : null;

  const resposta = await agendaDoAdmin(token, {
    ...(deQuery ? { from: deQuery, to: vista === 'dia' ? deQuery : addDays(deQuery, 6) } : {}),
    ...(first(query['p']) ? { professionalId: first(query['p']) as string } : {}),
  });

  const conflito = await lerConflitoDaAgenda();
  /**
   * Quem espera uma vaga (bloco 38).
   *
   * Lida junto e não numa segunda volta: são duas rotas independentes e a tela
   * precisa das duas para montar. Em série, o gestor espera as duas somadas.
   *
   * A lista mora nesta tela porque é a agenda vista pelo outro lado — quem quer
   * entrar nela. Uma tela própria no menu seria um lugar onde ninguém entra:
   * a pergunta "quem está esperando?" só nasce com a agenda na frente.
   */
  const espera = await quemEsperaVaga(token);
  const erro = first(query['erro']);
  const salvo = first(query['salvo']) === '1';

  if (!resposta.ok) {
    return (
      <main className="ui-container balcao" {...secao('agenda')}>
        <header className="painel__topo">
          <a className="painel__marca" href="/admin/dia">
            ← {estado.businessName}
          </a>
        </header>
        <div className="ui-alert ui-alert--warning" role="alert">
          {FALHA[resposta.code] ?? FALHA['request_failed']} <a className="ui-button ui-button--secondary painel__saida" href="/admin/dia">Voltar ao dia</a>
        </div>
      </main>
    );
  }

  const agenda = resposta.dados;
  const hoje = agenda.today;
  const de = agenda.from;
  const nomes = new Map(agenda.professionals.map((p) => [p.id, p.name]));
  const podeExcecao = podeNaTela(estado, 'settings.manage');

  const link = (params: Record<string, string>) => {
    const busca = new URLSearchParams({ v: vista, de, ...params });
    return `/admin/agenda?${busca.toString()}`;
  };

  const todosOsCompromissos = agenda.days
    .flatMap((dia) => dia.entries.map((entrada) => ({ dia, entrada })))
    .sort((a, b) =>
      a.dia.date === b.dia.date
        ? a.entrada.start.localeCompare(b.entrada.start)
        : a.dia.date.localeCompare(b.dia.date),
    );

  /** As entradas de um dia, ordenadas — a lista agrupa por dia desde o 109. */
  const compromissosDoDia = (dia: (typeof agenda.days)[number]) =>
    [...dia.entries].sort((a, b) => a.start.localeCompare(b.start));

  return (
    <main className="ui-container balcao" {...secao('agenda')}>
      <header className="painel__topo">
        <a className="painel__marca" href="/admin/dia">
          ← {estado.businessName}
        </a>
        <nav className="painel__atalhos">
          {/* O dia e a fila estão no contexto do casco, a um palmo à esquerda.
              Repetir aqui é o mesmo destino duas vezes no DOM — quem usa leitor
              de tela ouve dobrado, e é a mesma regra que já tirou a lista
              duplicada do trilho. */}
          <form action={acaoSair}>
            <button className="ui-button ui-button--ghost painel__sair" type="submit">
              Sair
            </button>
          </form>
        </nav>
      </header>

      <h1 className="painel__titulo balcao__titulo">
        {/* Em pt-BR, como o painel do dia — `2026-08-20` não é como se lê data
            no Brasil, e as duas telas da mesma área mostravam formatos
            diferentes para o mesmo fato. */}
        Agenda{' '}
        <span className="balcao__data tabular">{de === hoje ? 'hoje' : diaCurto(de)}</span>
      </h1>

      <nav aria-label="Como ver" className="cadastro-nav ui-scroll-x">
        <ul className="cadastro-nav__lista">
          {(['dia', 'semana', 'lista'] as const).map((opcao) => (
            <li key={opcao}>
              {opcao === vista ? (
                <span aria-current="page" className="cadastro-nav__aba cadastro-nav__aba--atual">
                  {opcao === 'dia' ? 'Dia' : opcao === 'semana' ? 'Semana' : 'Lista'}
                </span>
              ) : (
                <a
                  className="cadastro-nav__aba"
                  href={`/admin/agenda?${new URLSearchParams({ v: opcao, de }).toString()}`}
                >
                  {opcao === 'dia' ? 'Dia' : opcao === 'semana' ? 'Semana' : 'Lista'}
                </a>
              )}
            </li>
          ))}
        </ul>
      </nav>

      <div className="balcao__dias">
        <a
          className="ui-button ui-button--ghost balcao__seta"
          href={link({ de: addDays(de, vista === 'dia' ? -1 : -7) })}
          aria-label={vista === 'dia' ? 'Dia anterior' : 'Semana anterior'}
        >
          ←
        </a>
        <a className="ui-button ui-button--ghost balcao__hoje" href={link({ de: hoje })}>
          Hoje
        </a>
        <a
          className="ui-button ui-button--ghost balcao__seta"
          href={link({ de: addDays(de, vista === 'dia' ? 1 : 7) })}
          aria-label={vista === 'dia' ? 'Próximo dia' : 'Próxima semana'}
        >
          →
        </a>
      </div>

      {erro ? (
        <AvisoDeRecusa erro={erro} mapa={FALHA} className="painel__aviso" />
      ) : null}

      {salvo ? (
        <div className="ui-alert ui-alert--success painel__aviso" role="status">
          Agenda atualizada.
        </div>
      ) : null}

      {conflito ? (
        <div className="ui-alert ui-alert--warning painel__aviso" role="alert">
          <p className="conflito__titulo">
            Há <span className="tabular">{conflito.conflitos.length}</span>{' '}
            {conflito.conflitos.length === 1 ? 'cliente marcado' : 'clientes marcados'} dentro
            disso
          </p>
          <ul className="conflito__lista">
            {conflito.conflitos.map((fora) => (
              <li key={fora.appointmentId}>
                <span className="tabular">{fora.start}</span> —{' '}
                {fora.customerName ?? 'cliente sem nome'} com {fora.professionalName}
              </li>
            ))}
          </ul>
          <p className="conflito__nota">
            Bloquear não cancela ninguém: eles continuam marcados, dentro de um horário fechado.
            Avise cada um ou mova pelo cartão dele.
          </p>
          <form action={acaoCriarExcecao}>
            <input name="kind" type="hidden" value={conflito.kind} />
            <input name="date" type="hidden" value={conflito.date} />
            <input
              name="inicio"
              type="hidden"
              value={conflito.startMinute == null ? '' : paraHHMM(conflito.startMinute)}
            />
            <input
              name="fim"
              type="hidden"
              value={conflito.endMinute == null ? '' : paraHHMM(conflito.endMinute)}
            />
            <input name="professionalId" type="hidden" value={conflito.professionalId ?? ''} />
            <input name="reason" type="hidden" value={conflito.reason ?? ''} />
            <input name="confirmarConflitos" type="hidden" value="1" />
            <input name="de" type="hidden" value={de} />
            <input name="v" type="hidden" value={vista} />
            <button className="ui-button ui-button--primary" type="submit">
              Bloquear mesmo assim
            </button>
          </form>
        </div>
      ) : null}

      {agenda.professionals.length === 0 ? (
        <div className="ui-card vazio">
          <p className="vazio__titulo">Ninguém na equipe</p>
          <p className="vazio__saida">
            A agenda precisa de alguém que atenda.{' '}
            <a href="/admin/profissionais">Cadastre a equipe</a>.
          </p>
        </div>
      ) : vista === 'lista' ? (
        <section aria-label="Lista de compromissos">
          {todosOsCompromissos.length === 0 ? (
            <div className="ui-card vazio">
              <p className="vazio__titulo">Nada marcado nesta semana</p>
              <p className="vazio__saida">
                Semana livre é hora de campanha, não de espera.{' '}
                <a href="/admin/dia/marcar">Marcar alguém</a>.
              </p>
            </div>
          ) : (
            /* Agrupada por dia, e não uma pilha lisa (bloco 109).

               A lista é a vista que responde "quando o fulano vem?", e o cartão
               nunca desenhava a data: sete dias empilhados, o mesmo nome
               aparecendo três vezes em horários parecidos, e o relógio voltando
               do 11:00 para o 09:00 sem nada explicar por quê. Os cabeçalhos
               existiam só no ramo da semana.

               O `dia.entries` já vem ordenado, e `todosOsCompromissos` só o
               achatava — então agrupar é voltar a usar o que a consulta traz. */
            agenda.days
              .filter((dia) => compromissosDoDia(dia).length > 0)
              .map((dia) => (
                <section className="agenda-dia" key={dia.date}>
                  <h2 className="agenda-dia__titulo" id={`lista-${dia.date}`}>
                    <span className="agenda-dia__semana">
                      {weekdayShort(agenda.timezone, dia.date)}
                    </span>{' '}
                    <span className="tabular">{dia.date.slice(8, 10)}/{dia.date.slice(5, 7)}</span>
                    {dia.date === hoje ? <span className="agenda-dia__hoje">hoje</span> : null}
                  </h2>
                  <ul className="compromissos">
                    {compromissosDoDia(dia).map((entrada) => (
                      <Cartao
                        data={dia.date}
                        entrada={entrada}
                        key={entrada.id}
                        profissionais={agenda.professionals}
                        vista={vista}
                      />
                    ))}
                  </ul>
                </section>
              ))
          )}
        </section>
      ) : (
        <div className="agenda-dias">
          {agenda.days.map((dia) => (
            <section className="agenda-dia" key={dia.date} aria-labelledby={`dia-${dia.date}`}>
              {vista === 'semana' ? (
                <h2 className="agenda-dia__titulo" id={`dia-${dia.date}`}>
                  <span className="agenda-dia__semana">{weekdayShort(agenda.timezone, dia.date)}</span>{' '}
                  <span className="tabular">{dia.date.slice(8, 10)}/{dia.date.slice(5, 7)}</span>
                  {dia.date === hoje ? <span className="agenda-dia__hoje">hoje</span> : null}
                </h2>
              ) : (
                <h2 className="ui-visually-hidden" id={`dia-${dia.date}`}>
                  {dia.date}
                </h2>
              )}

              <div className="colunas ui-scroll-x">
                {agenda.professionals.map((profissional) => (
                  <Coluna
                    dia={dia}
                    key={profissional.id}
                    profissional={profissional}
                    profissionais={agenda.professionals}
                    vista={vista}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <section className="painel__grupo" aria-labelledby="fechar">
        <h2 className="rotulo" id="fechar">
          Fechar um horário
        </h2>
        <form action={acaoCriarExcecao} className="formulario">
          <input name="de" type="hidden" value={de} />
          <input name="v" type="hidden" value={vista} />

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="kind">
              O que é
            </label>
            <select className="ui-field__input" defaultValue="block" id="kind" name="kind">
              {/* `block` sempre; os outros quatro só para quem pode — a tela
                  esconde o que a guarda recusaria. A ordem e os rótulos são do
                  domínio, e a separação é o único recorte da tela. */}
              <option value="block">{ROTULO_DO_TIPO_DE_EXCECAO['block']}</option>
              {podeExcecao
                ? TIPOS_DE_EXCECAO.filter((t) => t !== 'block').map((t) => (
                    <option key={t} value={t}>
                      {ROTULO_DO_TIPO_DE_EXCECAO[t]}
                    </option>
                  ))
                : null}
            </select>
            {podeExcecao ? null : (
              // A tela esconde o que a guarda recusaria: botão que só serve para
              // dar erro é pior que botão ausente para quem opera.
              <p className="ui-field__hint">
                Folga, feriado e horário diferente mudam o funcionamento da barbearia e são do
                dono ou do gerente.
              </p>
            )}
          </div>

          <div className="campos-lado">
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="date">
                Dia
              </label>
              <input
                className="ui-field__input"
                defaultValue={de}
                id="date"
                name="date"
                required
                type="date"
              />
            </div>
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="inicio">
                Das
              </label>
              <input className="ui-field__input" defaultValue="14:00" id="inicio" name="inicio" type="time" />
            </div>
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="fim">
                Até
              </label>
              <input className="ui-field__input" defaultValue="15:00" id="fim" name="fim" type="time" />
            </div>
          </div>

          <p className="ui-field__hint">
            Folga, férias e feriado fecham o dia inteiro e ignoram o horário acima.
          </p>

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="professionalId">
              De quem
            </label>
            <select className="ui-field__input" defaultValue="" id="professionalId" name="professionalId">
              <option value="">A barbearia toda</option>
              {agenda.professionals.map((pro) => (
                <option key={pro.id} value={pro.id}>
                  {pro.name}
                </option>
              ))}
            </select>
          </div>

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="reason">
              Motivo
            </label>
            <input
              className="ui-field__input"
              id="reason"
              maxLength={200}
              name="reason"
              placeholder="Dentista"
            />
            <p className="ui-field__hint">Aparece na agenda para a equipe entender o buraco.</p>
          </div>

          <button className="ui-button ui-button--primary ui-button--block" type="submit">
            Fechar este horário
          </button>
        </form>
      </section>

      <p className="painel__nota">
        Fechar um horário some com ele da página pública na hora, e o agendamento em cima dele é
        recusado. Quem já estava marcado continua marcado — o sistema avisa antes e não cancela
        ninguém por conta própria.
      </p>

      <Esperando esperando={espera.ok ? espera.dados.esperando : []} />
    </main>
  );
}

/**
 * Quem pediu para ser avisado de uma vaga (bloco 38, SPEC §2.9).
 *
 * ## O que esta lista responde
 *
 * Duas perguntas do dono, e as duas valem dinheiro: "vale abrir mais um horário
 * no sábado?" e "acabei de desmarcar às 15h — quem eu chamo?". A segunda vem
 * com link direto do balcão, e é por isso que a âncora `#esperando` existe.
 *
 * ## Por que só os quatro últimos do telefone
 *
 * A tela do balcão fica virada para o salão. O número inteiro conferiria
 * identidade e exporia o cadastro a quem passa na frente do notebook — os
 * quatro últimos fazem a primeira coisa sem fazer a segunda, como no resto do
 * produto.
 *
 * Desde o bloco 39 o aviso sai sozinho, na ordem do score e com dez minutos de
 * exclusividade. Quem já foi chamada aparece marcada: é o que impede o balcão de
 * oferecer à mão o horário que o produto está segurando.
 */
function Esperando({ esperando }: { esperando: readonly QuemEspera[] }) {
  return (
    <section aria-labelledby="esperando-titulo" className="secao" id="esperando">
      <h2 className="rotulo" id="esperando-titulo">
        Esperando uma vaga
      </h2>

      {esperando.length === 0 ? (
        /* Estado vazio desenhado: diz o que é e o que faz aparecer alguém. */
        <div className="vazio">
          <p className="vazio__titulo">Ninguém na lista de espera</p>
          <p className="vazio__saida">
            Quem não encontra horário na sua página pode pedir para ser avisado. Os pedidos
            aparecem aqui.
          </p>
        </div>
      ) : (
        <ul className="esperando">
          {esperando.map((quem) => (
            <li className="esperando__item" key={quem.id}>
              <span className="esperando__quem">
                {quem.customerNome}
                {quem.customerTelefoneFinal ? (
                  <span className="esperando__fone tabular"> ···{quem.customerTelefoneFinal}</span>
                ) : null}
              </span>
              <span className="esperando__quando tabular">
                {quem.de === quem.ate ? diaCurto(quem.de) : `${diaCurto(quem.de)}–${diaCurto(quem.ate)}`}
                {' · '}
                {quem.inicio}–{quem.fim}
              </span>
              <span className="esperando__quando">
                {quem.servicos.join(' + ')}
                {quem.profissionalNome ? ` · com ${quem.profissionalNome}` : ' · qualquer barbeiro'}
              </span>
              {/* O convite vivo aparece aqui porque sem ele o balcão liga para
                  oferecer o mesmo horário que o produto já está segurando — e o
                  horário some da grade sem ninguém saber por quê. */}
              {quem.convite ? (
                <span className="esperando__convite">
                  Convidada para {quem.convite.hora} · responde em{' '}
                  <span className="tabular">{quem.convite.minutosRestantes}</span> min
                </span>
              ) : null}
              {/* A saída da lista, pelo balcão.

                  A lista era só leitura: quem ligava dizendo "já resolvi"
                  continuava recebendo convite, e cada convite segura o horário
                  fora da grade pública por dez minutos. A única saída era o
                  cliente entrar na conta dele. */}
              <form action={acaoTirarDaEspera}>
                <input name="entryId" type="hidden" value={quem.id} />
                <button className="ui-button ui-button--ghost esperando__sair" type="submit">
                  Tirar da lista
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** `2026-08-15` vira `15/08`, sem trazer fuso para uma data local. */
function diaCurto(iso: string): string {
  const [, mes = '01', dia = '01'] = iso.split('-');
  return `${dia}/${mes}`;
}
