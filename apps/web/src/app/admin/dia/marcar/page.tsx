import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import {
  buscarClientes,
  catalogoDoBalcao,
  gradeDoBalcao,
  painelDoDia,
  type CatalogoDoBalcao,
} from '@/lib/admin-api';
import { addDays, weekdayShort, dayNumber } from '@/lib/date';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { acaoMarcarNoBalcao } from '../../acoes';

/**
 * Marcar alguém pelo balcão.
 *
 * O mesmo desenho por passos do fluxo do cliente — serviço, profissional,
 * horário, quem — e pelo mesmo motivo: cada passo é uma URL, o botão voltar
 * funciona e nada depende de JavaScript.
 *
 * O que muda em relação à tela do cliente é o começo: aqui a primeira pergunta
 * é **quem já é cliente**. Criar o terceiro cadastro do mesmo João é como uma
 * base de clientes deixa de valer alguma coisa — e é o balcão que faz isso,
 * não o site.
 */

export const metadata: Metadata = {
  title: 'Marcar pelo balcão',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const first = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

const dinheiro = (centavos: number): string =>
  (centavos / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 });

const FALHA: Record<string, string> = {
  slot_not_available: 'Este horário acabou de ser ocupado. Escolha outro.',
  slot_taken: 'Este horário acabou de ser ocupado. Escolha outro.',
  invalid_phone: 'Confira o celular: precisa ter DDD e nove dígitos.',
  invalid_request: 'Confira os dados e tente de novo.',
  request_failed: 'Não deu para marcar. Tente de novo.',
};

const MOTIVO: Record<string, string> = {
  closed: 'A barbearia não abre neste dia.',
  fully_booked: 'Todos os horários deste dia já foram preenchidos.',
  daily_limit_reached: 'A agenda deste dia já está completa.',
  resource_unavailable: 'Não há estrutura livre para este serviço neste dia.',
  past_cutoff: 'O dia já acabou.',
  no_qualified_professional: 'Ninguém executa esta combinação de serviços.',
};

/** Régua de dias, a partir de hoje na barbearia. */
function Dias({
  base,
  atual,
  href,
}: {
  readonly base: string;
  readonly atual: string;
  readonly href: (data: string) => string;
}) {
  const dias = Array.from({ length: 14 }, (_, i) => addDays(base, i));
  return (
    <div className="ui-scroll-x balcao__regua" role="group" aria-label="Escolher o dia">
      {dias.map((data) => (
        <a className={`dia ${data === atual ? 'dia--atual' : ''}`} href={href(data)} key={data}>
          <span className="dia__semana">{weekdayShort('UTC', data)}</span>
          <span className="dia__numero tabular">{dayNumber(data)}</span>
        </a>
      ))}
    </div>
  );
}

export default async function MarcarPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const catalogo = await catalogoDoBalcao(token);
  const painel = await painelDoDia(token);
  if (!catalogo.ok || !painel.ok) {
    return (
      <main className="ui-container painel__conteudo" data-secao="dia">
        <div className="ui-alert ui-alert--danger" role="alert">
          Não deu para carregar o catálogo. <a href="/admin/dia">Voltar ao dia</a>
        </div>
      </main>
    );
  }

  const query = await searchParams;
  const hoje = painel.dados.today;

  const menu: CatalogoDoBalcao = catalogo.dados;
  const porId = new Map(menu.services.map((s) => [s.id, s]));

  const escolhidos = (first(query['s']) ?? '').split(',').filter((id) => porId.has(id));
  const profissional = first(query['p']);
  const data = first(query['d']) ?? hoje;
  const hora = first(query['h']);
  const busca = (first(query['q']) ?? '').trim();
  const escolhido = first(query['c']);
  const nomeEscolhido = first(query['cn']);
  const erro = first(query['erro']);

  // O passo é marcado na URL, não inferido do que está preenchido: inferir
  // impede acrescentar o segundo serviço, e corte + barba é o caso comum.
  const passo = first(query['e']) ?? (escolhidos.length === 0 ? 'a' : 'b');

  const link = (mudanca: Record<string, string | undefined>): string => {
    const atual: Record<string, string | undefined> = {
      s: escolhidos.join(','),
      p: profissional,
      d: data === hoje ? undefined : data,
      h: hora,
      q: busca || undefined,
      c: escolhido,
      cn: nomeEscolhido,
      ...mudanca,
    };
    const params = new URLSearchParams();
    for (const [chave, valor] of Object.entries(atual)) {
      if (valor) params.set(chave, valor);
    }
    const texto = params.toString();
    return `/admin/dia/marcar${texto ? `?${texto}` : ''}`;
  };

  const total = escolhidos.reduce((soma, id) => soma + (porId.get(id)?.priceCents ?? 0), 0);
  const duracao = escolhidos.reduce((soma, id) => soma + (porId.get(id)?.durationMinutes ?? 0), 0);

  const clientes = busca.length >= 3 ? await buscarClientes(token, busca) : null;

  const grade =
    passo === 'c' && escolhidos.length > 0
      ? await gradeDoBalcao(token, {
          serviceIds: escolhidos,
          ...(profissional ? { professionalId: profissional } : {}),
          dateFrom: data,
        })
      : null;

  const doDia = grade?.ok ? grade.dados.days[0] : undefined;

  return (
    <main className="ui-container balcao balcao--marcar" data-secao="dia">
      <header className="painel__topo">
        <a className="painel__marca" href={`/admin/dia?d=${data}`}>← O dia</a>
      </header>

      <h1 className="painel__titulo balcao__titulo">Marcar alguém</h1>

      {erro ? (
        <div className="ui-alert ui-alert--danger painel__aviso" role="alert">
          {FALHA[erro] ?? FALHA['request_failed']}
        </div>
      ) : null}

      {/* Passo A — serviço */}
      {passo === 'a' ? (
        <section className="marcar__passo">
          <h2 className="marcar__pergunta">O que ele vai fazer?</h2>
          {menu.services.length === 0 ? (
            <div className="vazio">
              <p className="vazio__titulo">Nenhum serviço cadastrado.</p>
              <a className="ui-button ui-button--primary" href="/admin/onboarding?e=3">
                Cadastrar serviços
              </a>
            </div>
          ) : (
            <ul className="marcar__lista">
              {menu.services.map((servico) => {
                const dentro = escolhidos.includes(servico.id);
                const novos = dentro
                  ? escolhidos.filter((id) => id !== servico.id)
                  : [...escolhidos, servico.id];
                return (
                  <li key={servico.id}>
                    <a
                      className={`escolha ${dentro ? 'escolha--dentro' : ''}`}
                      href={link({ s: novos.join(','), e: 'a', h: undefined })}
                    >
                      <span className="escolha__nome">{servico.name}</span>
                      <span className="escolha__lado tabular">
                        {servico.durationMinutes} min · R$ {dinheiro(servico.priceCents)}
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          )}

          {escolhidos.length > 0 ? (
            <div className="ui-sticky-action">
              <a className="ui-button ui-button--primary ui-button--block" href={link({ e: 'b' })}>
                Continuar · {duracao} min · R$ {dinheiro(total)}
              </a>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Passo B — profissional */}
      {passo === 'b' ? (
        <section className="marcar__passo">
          <h2 className="marcar__pergunta">Com quem?</h2>
          <ul className="marcar__lista">
            <li>
              <a className={`escolha ${profissional ? '' : 'escolha--dentro'}`}
                 href={link({ p: undefined, e: 'c', h: undefined })}>
                <span className="escolha__nome">Qualquer um</span>
                <span className="escolha__lado">quem estiver livre antes</span>
              </a>
            </li>
            {menu.professionals.map((pessoa) => (
              <li key={pessoa.id}>
                <a className={`escolha ${profissional === pessoa.id ? 'escolha--dentro' : ''}`}
                   href={link({ p: pessoa.id, e: 'c', h: undefined })}>
                  <span className="escolha__nome">{pessoa.name}</span>
                </a>
              </li>
            ))}
          </ul>
          <p className="painel__nota">
            <a href={link({ e: 'a' })}>Trocar o serviço</a>
          </p>
        </section>
      ) : null}

      {/* Passo C — horário */}
      {passo === 'c' ? (
        <section className="marcar__passo">
          <h2 className="marcar__pergunta">Que horas?</h2>
          <Dias base={hoje} atual={data} href={(d) => link({ d, e: 'c', h: undefined })} />

          {doDia && doDia.slots.length > 0 ? (
            <ul className="horas">
              {doDia.slots.map((slot) => (
                <li key={`${slot.professionalId}-${slot.start}`}>
                  <a className="hora" href={link({ h: slot.start, p: slot.professionalId, e: 'd' })}>
                    <span className="hora__valor tabular">{slot.start}</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <div className="vazio">
              <p className="vazio__titulo">
                {MOTIVO[doDia?.unavailableReason ?? ''] ?? 'Nenhum horário livre neste dia.'}
              </p>
              <p className="vazio__saida">Tente outro dia na régua acima, ou outro profissional.</p>
              <a className="ui-button ui-button--ghost" href={link({ e: 'b' })}>Trocar profissional</a>
            </div>
          )}
        </section>
      ) : null}

      {/* Passo D — quem */}
      {passo === 'd' && hora ? (
        <section className="marcar__passo">
          <h2 className="marcar__pergunta">Para quem?</h2>

          <p className="marcar__resumo">
            {escolhidos.map((id) => porId.get(id)?.name).join(' + ')} ·{' '}
            <strong className="tabular">{hora}</strong> ·{' '}
            <span className="tabular">{data.split('-').reverse().join('/')}</span>{' '}
            <a href={link({ e: 'c' })}>trocar</a>
          </p>

          {/* Busca: GET próprio, para o formulário de gravação não ser enviado
              sem querer ao apertar Enter no campo de procura. */}
          <form className="marcar__busca" method="get" action="/admin/dia/marcar">
            <input type="hidden" name="s" value={escolhidos.join(',')} />
            <input type="hidden" name="p" value={profissional ?? ''} />
            <input type="hidden" name="d" value={data} />
            <input type="hidden" name="h" value={hora} />
            <input type="hidden" name="e" value="d" />
            <label className="ui-field__label" htmlFor="q">Já é cliente?</label>
            <div className="marcar__busca-linha">
              <input className="ui-field__input" id="q" name="q" defaultValue={busca}
                     placeholder="nome ou fim do celular" autoComplete="off" />
              <button className="ui-button ui-button--ghost" type="submit">Procurar</button>
            </div>
            <p className="ui-field__hint">A partir de três letras. Ex.: “silva” ou “7777”.</p>
          </form>

          {clientes?.ok && clientes.dados.customers.length > 0 ? (
            <>
            <p className="marcar__dica">Toque em quem for, para usar o cadastro que já existe.</p>
            <ul className="achados">
              {clientes.dados.customers.map((cliente) => (
                <li key={cliente.id}>
                  <a
                    className={`achado ${escolhido === cliente.id ? 'achado--ativo' : ''}`}
                    href={link({ c: cliente.id, cn: cliente.name })}
                  >
                    <span className="achado__nome">{cliente.name}</span>
                    <span className="achado__fone tabular">{cliente.phoneMasked}</span>
                    {cliente.noShows > 0 ? (
                      // A recepção decide se segura o horário. O número aparece
                      // sem julgamento — é informação, não etiqueta.
                      <span className="achado__faltas">
                        {cliente.noShows} {cliente.noShows === 1 ? 'falta' : 'faltas'}
                      </span>
                    ) : null}
                  </a>
                </li>
              ))}
            </ul>
            </>
          ) : null}

          {clientes?.ok && clientes.dados.customers.length === 0 ? (
            <p className="marcar__nenhum">
              Ninguém com “{busca}”. Preencha abaixo — o cadastro é criado agora.
            </p>
          ) : null}

          <form action={acaoMarcarNoBalcao} className="formulario">
            <input type="hidden" name="serviceIds" value={escolhidos.join(',')} />
            <input type="hidden" name="professionalId" value={profissional ?? ''} />
            <input type="hidden" name="date" value={data} />
            <input type="hidden" name="start" value={hora} />
            {/* Gerada uma vez, na montagem da tela: se nascesse na ação, cada
                reenvio traria chave nova e o duplo toque criaria dois horários. */}
            <input type="hidden" name="chave" value={randomUUID()} />

            {escolhido ? (
              // Cliente já cadastrado: vai pelo id. O celular dele não volta
              // para a tela nem para o formulário — a busca só devolve
              // mascarado, e é assim que continua.
              <>
                <input type="hidden" name="customerId" value={escolhido} />
                <p className="marcar__cliente">
                  Para <strong>{nomeEscolhido ?? 'o cliente escolhido'}</strong>{' '}
                  <a href={link({ c: undefined, cn: undefined })}>trocar</a>
                </p>
              </>
            ) : (
              <>
                <div className="ui-field">
                  <label className="ui-field__label" htmlFor="name">Nome</label>
                  <input className="ui-field__input" id="name" name="name" required
                         minLength={2} maxLength={80} autoComplete="off" />
                </div>

                <div className="ui-field">
                  <label className="ui-field__label" htmlFor="phone">Celular</label>
                  <input className="ui-field__input tabular" id="phone" name="phone" required
                         inputMode="tel" placeholder="(71) 9 8888-7777" autoComplete="off" />
                  <p className="ui-field__hint">
                    É por ele que o cliente entra depois para ver e remarcar sozinho.
                  </p>
                </div>
              </>
            )}

            <div className="ui-field">
              <label className="ui-field__label" htmlFor="notes">Observação (opcional)</label>
              <input className="ui-field__input" id="notes" name="notes" maxLength={300} />
            </div>

            <div className="ui-sticky-action">
              <button className="ui-button ui-button--primary ui-button--block" type="submit">
                Marcar às {hora}
              </button>
            </div>
          </form>
        </section>
      ) : null}
    </main>
  );
}
