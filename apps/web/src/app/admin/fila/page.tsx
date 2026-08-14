import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  catalogoDoBalcao,
  filaDoBalcao,
  type CadeiraNaFila,
  type PessoaNaFila,
} from '@/lib/admin-api';
import { exigirRecurso, painelOuDesvio } from '@/lib/painel';
import { lerLinkDaFila, lerSessaoGestor } from '@/lib/sessao-gestor';
import { acaoEntrarNaFila, acaoMoverNaFila, acaoSair, acaoSentarDaFila } from '../acoes';
import { secao } from '../secoes';

/**
 * A fila da porta.
 *
 * A SPEC (Parte 2 §2.10) trata a fila como outro objeto e outra tela, e é por
 * isso que ela não fica dentro do painel do dia: o dia é sobre quem tem hora
 * marcada, a fila é sobre quem chegou sem ela. Misturar as duas obriga a
 * recepção a distinguir no olho o que o sistema já sabe.
 *
 * O número que essa tela existe para mostrar não é "quantos estão esperando" —
 * é **quanto tempo falta até o próximo marcado de cada cadeira**. É a diferença
 * entre "o Ruan está livre" e "cabe um corte no Ruan", e é onde a barbearia
 * ganha ou perde a hora do dia.
 */

export const metadata: Metadata = {
  title: 'Fila',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const FALHA: Record<string, string> = {
  already_in_queue: 'Esta pessoa já está na fila.',
  sem_servico: 'Escolha pelo menos um serviço.',
  slot_taken:
    'Não cabe: este profissional tem cliente marcado nesse horário. Escolha outra cadeira ou remarque antes.',
  transition_not_allowed: 'A fila mudou enquanto você olhava. Confira o estado atual.',
  queue_entry_not_found: 'Esta pessoa não está mais na fila.',
  invalid_phone: 'Confira o celular: precisa ter DDD e nove dígitos.',
  invalid_request: 'Confira os dados e tente de novo.',
  request_failed: 'Não deu para salvar. Tente de novo.',
};

/** "livre agora" lê melhor que "livre em 0 min", e é o que a recepção procura. */
function quandoLibera(minutos: number): string {
  if (minutos <= 0) return 'livre agora';
  if (minutos === 1) return 'livre em 1 min';
  return `livre em ${minutos} min`;
}

function Cadeira({ cadeira }: { readonly cadeira: CadeiraNaFila }) {
  return (
    <li className={`cadeira ${cadeira.livreEmMinutos === 0 ? 'cadeira--livre' : ''}`}>
      <p className="cadeira__nome">{cadeira.professionalName}</p>
      <p className="cadeira__estado tabular">{quandoLibera(cadeira.livreEmMinutos)}</p>
      <p className="cadeira__proximo">
        {cadeira.proximoMarcado ? (
          <>
            marcado às <span className="tabular">{cadeira.proximoMarcado}</span>
          </>
        ) : (
          'sem marcação depois'
        )}
      </p>
    </li>
  );
}

function NaFila({
  pessoa,
  cadeiras,
}: {
  readonly pessoa: PessoaNaFila;
  readonly cadeiras: readonly CadeiraNaFila[];
}) {
  const sugerida = pessoa.professionalId;

  return (
    <li className={`espera ${pessoa.status === 'called' ? 'espera--chamada' : ''}`}>
      <p className="espera__posicao tabular" aria-hidden="true">
        {pessoa.posicao}
      </p>

      <div className="espera__quem">
        <h3 className="espera__nome">
          {pessoa.customerName}
          {pessoa.customerPhoneTail ? (
            <span className="espera__fone"> ····{pessoa.customerPhoneTail}</span>
          ) : null}
          {pessoa.status === 'called' ? <span className="espera__selo">chamado</span> : null}
        </h3>
        <p className="espera__servico">
          {pessoa.services.join(' + ')} ·{' '}
          <span className="tabular">{pessoa.duracaoMinutos} min</span>
        </p>
        <p className="espera__tempo">
          esperando há <span className="tabular">{pessoa.esperandoHaMinutos} min</span>
          {pessoa.preferidoId ? ' · pediu um profissional' : ' · aceita qualquer um'}
        </p>
        <p className="espera__frase">{pessoa.frase}</p>
        {pessoa.atrasaMarcado ? (
          <p className="espera__aviso">
            Encaixar aqui passa por cima de quem já tem hora marcada.
          </p>
        ) : null}
      </div>

      <div className="espera__acoes">
        <form action={acaoSentarDaFila} className="espera__sentar">
          <input name="id" type="hidden" value={pessoa.id} />
          <label className="ui-visually-hidden" htmlFor={`cadeira-${pessoa.id}`}>
            Cadeira para {pessoa.customerName}
          </label>
          <select
            className="ui-field__input"
            defaultValue={sugerida ?? ''}
            id={`cadeira-${pessoa.id}`}
            name="professionalId"
            required
          >
            {cadeiras.map((cadeira) => (
              <option key={cadeira.professionalId} value={cadeira.professionalId}>
                {cadeira.professionalName} — {quandoLibera(cadeira.livreEmMinutos)}
              </option>
            ))}
          </select>
          <button className="ui-button ui-button--primary" type="submit">
            Sentou
          </button>
        </form>

        <div className="espera__miudas">
          {pessoa.status === 'waiting' ? (
            <form action={acaoMoverNaFila}>
              <input name="id" type="hidden" value={pessoa.id} />
              <input name="para" type="hidden" value="called" />
              <button className="ui-button ui-button--ghost espera__miuda" type="submit">
                Chamar
              </button>
            </form>
          ) : (
            <form action={acaoMoverNaFila}>
              <input name="id" type="hidden" value={pessoa.id} />
              <input name="para" type="hidden" value="waiting" />
              <button className="ui-button ui-button--ghost espera__miuda" type="submit">
                Não apareceu
              </button>
            </form>
          )}
          <form action={acaoMoverNaFila}>
            <input name="id" type="hidden" value={pessoa.id} />
            <input name="para" type="hidden" value="gave_up" />
            <button
              className="ui-button ui-button--ghost espera__miuda espera__risco"
              type="submit"
            >
              Desistiu
            </button>
          </form>
        </div>
      </div>
    </li>
  );
}

export default async function FilaPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  exigirRecurso(estado, 'fila');
  const query = await searchParams;

  const [fila, catalogo] = await Promise.all([filaDoBalcao(token), catalogoDoBalcao(token)]);
  const erro = first(query['erro']);
  const recemEntrou = await lerLinkDaFila();

  if (!fila.ok || !catalogo.ok) {
    const code = fila.ok ? (catalogo.ok ? 'request_failed' : catalogo.code) : fila.code;
    return (
      <main className="ui-container balcao" {...secao('fila')}>
        <header className="painel__topo">
          <a className="painel__marca" href="/admin/dia">
            ← {estado.businessName}
          </a>
        </header>
        <div className="ui-alert ui-alert--warning" role="alert">
          {FALHA[code] ?? FALHA['request_failed']} <a className="ui-button ui-button--secondary painel__saida" href="/admin/dia">Voltar ao dia</a>
        </div>
      </main>
    );
  }

  const { entries, cadeiras, totals } = fila.dados;
  // Gerada aqui, uma vez por montagem da tela: é o que faz o duplo toque no
  // botão cair na mesma chave em vez de criar duas entradas.
  const chave = randomUUID();

  return (
    <main className="ui-container balcao" {...secao('fila')}>
      <header className="painel__topo">
        <a className="painel__marca" href="/admin/dia">
          ← {estado.businessName}
        </a>
        <nav className="painel__atalhos">
          {/* O dia mora no contexto do casco. Ver o link aqui também é o mesmo
              destino duas vezes na mesma tela. */}
          <form action={acaoSair}>
            <button className="ui-button ui-button--ghost painel__sair" type="submit">
              Sair
            </button>
          </form>
        </nav>
      </header>

      <h1 className="painel__titulo balcao__titulo">Fila da porta</h1>
      <p className="painel__sub">
        Quem chegou sem hora marcada. A estimativa usa o tempo que os cortes desta barbearia
        levam de verdade, não o do catálogo.
      </p>

      {erro ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {FALHA[erro] ?? FALHA['request_failed']}
        </div>
      ) : null}

      {recemEntrou ? (
        <div className="ui-alert ui-alert--info painel__aviso link-fila" role="status">
          <p className="link-fila__titulo">Link de acompanhamento de {recemEntrou.nome}</p>
          <p className="link-fila__valor">
            /{estado.slug}/fila/{recemEntrou.token}
          </p>
          <p className="link-fila__nota">
            Mande agora por WhatsApp. Ele some desta tela em três minutos e não aparece de novo —
            e é com ele que a pessoa acompanha a posição sem ficar em pé no salão.
          </p>
        </div>
      ) : null}

      {/* Rola dentro de si em tela estreita; nunca leva a página junto — mesma
          régua do painel do dia. */}
      <ul className="ui-scroll-x balcao__totais" aria-label="Resumo da fila">
        <li className="totalzinho">
          <span className="totalzinho__valor tabular">{totals.esperando}</span>
          <span className="totalzinho__nome">esperando</span>
        </li>
        <li className="totalzinho">
          <span className="totalzinho__valor tabular">{totals.chamados}</span>
          <span className="totalzinho__nome">chamados</span>
        </li>
        <li className="totalzinho">
          <span className="totalzinho__valor tabular">{totals.atendendo}</span>
          <span className="totalzinho__nome">atendendo</span>
        </li>
        <li className="totalzinho">
          <span className="totalzinho__valor tabular">
            {totals.esperaMediaMinutos === null ? '—' : `${totals.esperaMediaMinutos}`}
          </span>
          <span className="totalzinho__nome">espera média (min)</span>
        </li>
        <li className="totalzinho">
          <span className="totalzinho__valor tabular">{totals.desistiram}</span>
          <span className="totalzinho__nome">desistiram</span>
        </li>
      </ul>

      <section aria-labelledby="cadeiras">
        <h2 className="rotulo" id="cadeiras">
          As cadeiras agora
        </h2>
        {cadeiras.length === 0 ? (
          <div className="ui-card vazio">
            <p className="vazio__titulo">Ninguém trabalhando hoje</p>
            <p className="vazio__saida">
              A fila precisa de alguém com jornada no dia.{' '}
              <a href="/admin/profissionais">Confira as jornadas</a>.
            </p>
          </div>
        ) : (
          <ul className="cadeiras">
            {cadeiras.map((cadeira) => (
              <Cadeira cadeira={cadeira} key={cadeira.professionalId} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="esperando">
        <h2 className="rotulo" id="esperando">
          Na fila
        </h2>
        {entries.length === 0 ? (
          <div className="ui-card vazio">
            <p className="vazio__titulo">Ninguém esperando</p>
            <p className="vazio__saida">
              Quando alguém chegar sem hora marcada, cadastre abaixo — a pessoa acompanha a
              posição pelo celular e não precisa ficar em pé no salão.
            </p>
          </div>
        ) : (
          <ul className="esperas">
            {entries.map((pessoa) => (
              <NaFila cadeiras={cadeiras} key={pessoa.id} pessoa={pessoa} />
            ))}
          </ul>
        )}
      </section>

      <section className="painel__grupo" aria-labelledby="chegou">
        <h2 className="rotulo" id="chegou">
          Chegou agora
        </h2>
        <form action={acaoEntrarNaFila} className="formulario">
          <input name="idempotencyKey" type="hidden" value={chave} />

          <div className="campos-lado">
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="name">
                Nome
              </label>
              <input
                autoComplete="off"
                className="ui-field__input"
                id="name"
                maxLength={80}
                minLength={2}
                name="name"
                required
              />
            </div>

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="phone">
                Celular
              </label>
              <input
                autoComplete="off"
                className="ui-field__input"
                id="phone"
                inputMode="tel"
                name="phone"
                placeholder="(71) 98888-1234"
                required
              />
              <p className="ui-field__hint">É por onde ela acompanha a posição.</p>
            </div>
          </div>

          <fieldset className="painel__grupo">
            <legend className="ui-field__label">O que vai fazer</legend>
            <div className="marcas-lista">
              {catalogo.dados.services.map((servico, indice) => (
                <label className="marca" key={servico.id}>
                  <input
                    defaultChecked={indice === 0}
                    name="serviceIds"
                    type="checkbox"
                    value={servico.id}
                  />
                  <span>
                    {servico.name} <span className="tabular">{servico.durationMinutes} min</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="ui-field">
            <label className="ui-field__label" htmlFor="professionalId">
              Com quem
            </label>
            <select className="ui-field__input" defaultValue="" id="professionalId" name="professionalId">
              {/* Vazio primeiro e por padrão: "qualquer um" é o caso comum na
                  porta, e é o que impede cadeira parada com gente esperando. */}
              <option value="">Qualquer profissional (entra mais rápido)</option>
              {cadeiras.map((cadeira) => (
                <option key={cadeira.professionalId} value={cadeira.professionalId}>
                  {cadeira.professionalName} — {quandoLibera(cadeira.livreEmMinutos)}
                </option>
              ))}
            </select>
          </div>

          <button className="ui-button ui-button--primary ui-button--block" type="submit">
            Entrar na fila
          </button>
        </form>
      </section>

      <p className="painel__nota">
        Sentar cria o atendimento com a hora real. Se o profissional tiver cliente marcado em
        cima, o sistema recusa e diz de quem é o horário — ninguém marcado perde a vez para a
        fila.
      </p>
    </main>
  );
}
