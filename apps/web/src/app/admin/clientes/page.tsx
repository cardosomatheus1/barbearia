import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { EXPLICACAO_DO_SEGMENTO, ROTULO_DO_SEGMENTO } from '@barbearia/core';
import {
  clientesNaPortaDoAdmin,
  type ClienteNaPortaDoAdmin,
  type FiltroDaPortaDeClientes,
} from '@/lib/admin-api';
import { localDate, localTime } from '@/lib/date';
import { painelOuDesvio, podeNaTela } from '@/lib/painel';
import { lerSessaoGestor } from '@/lib/sessao-gestor';
import { FalhaDaLeitura } from '../falha-da-leitura';
import { acaoSair } from '../acoes';
import { secao } from '../secoes';

export const metadata: Metadata = {
  title: 'Clientes',
  robots: { index: false, follow: false },
};

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const TODOS_OS_FILTROS: readonly FiltroDaPortaDeClientes[] = [
  'todos',
  'recentes',
  'hoje',
  'em_risco',
  'vip',
  'assinantes',
  'fiado',
];

const ROTULO_DO_FILTRO: Readonly<Record<FiltroDaPortaDeClientes, string>> = {
  todos: 'Todos',
  recentes: 'Recentes',
  hoje: 'Hoje',
  em_risco: ROTULO_DO_SEGMENTO.em_risco,
  vip: 'VIP',
  assinantes: 'Assinantes',
  fiado: 'Fiado',
};

const primeiro = (valor: string | string[] | undefined): string | undefined =>
  Array.isArray(valor) ? valor[0] : valor;

function filtroValido(valor: string | undefined): FiltroDaPortaDeClientes {
  return TODOS_OS_FILTROS.includes(valor as FiltroDaPortaDeClientes)
    ? (valor as FiltroDaPortaDeClientes)
    : 'todos';
}

function diasEntre(a: string, b: string): number {
  const um = new Date(`${a}T12:00:00Z`).getTime();
  const dois = new Date(`${b}T12:00:00Z`).getTime();
  return Math.round((dois - um) / 86_400_000);
}

function dataLocal(timeZone: string, iso: string): string {
  return localDate(timeZone, new Date(iso));
}

function ultimaVisita(cliente: ClienteNaPortaDoAdmin, hoje: string, timeZone: string): string {
  if (!cliente.ultimaVisitaEm) return 'Ainda não veio';
  const dia = dataLocal(timeZone, cliente.ultimaVisitaEm);
  const diferenca = diasEntre(dia, hoje);
  if (diferenca === 0) return 'Última visita hoje';
  if (diferenca === 1) return 'Última visita ontem';
  if (diferenca > 1 && diferenca <= 45) return `Última visita há ${diferenca} dias`;
  return `Última visita em ${dia.split('-').reverse().join('/')}`;
}

function proximaVisita(cliente: ClienteNaPortaDoAdmin, hoje: string, timeZone: string): string | null {
  if (!cliente.proximaVisitaEm) return null;
  const dia = dataLocal(timeZone, cliente.proximaVisitaEm);
  const diferenca = diasEntre(hoje, dia);
  const hora = localTime(timeZone, cliente.proximaVisitaEm);
  if (diferenca === 0) return `Próxima hoje às ${hora}`;
  if (diferenca === 1) return `Próxima amanhã às ${hora}`;
  return `Próxima ${dia.slice(8, 10)}/${dia.slice(5, 7)} às ${hora}`;
}

function iniciais(nome: string): string {
  return nome
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((parte) => parte[0]?.toUpperCase() ?? '')
    .join('');
}

function hrefDaLista(entrada: {
  readonly filtro: FiltroDaPortaDeClientes;
  readonly q: string;
  readonly pagina?: number;
}): string {
  const params = new URLSearchParams();
  if (entrada.filtro !== 'todos') params.set('filtro', entrada.filtro);
  if (entrada.q) params.set('q', entrada.q);
  if ((entrada.pagina ?? 1) > 1) params.set('pagina', String(entrada.pagina));
  const query = params.toString();
  return `/admin/clientes${query ? `?${query}` : ''}`;
}

function Cliente({
  cliente,
  hoje,
  timeZone,
}: {
  readonly cliente: ClienteNaPortaDoAdmin;
  readonly hoje: string;
  readonly timeZone: string;
}) {
  const proxima = proximaVisita(cliente, hoje, timeZone);

  return (
    <li className="clientes__item">
      <a className="clientes__link" href={`/admin/cliente/${cliente.id}?de=clientes`}>
        <span aria-hidden="true" className="clientes__avatar">
          {iniciais(cliente.nome)}
        </span>
        <span className="clientes__identidade">
          <span className="clientes__linha-nome">
            <strong className="clientes__nome">{cliente.nome}</strong>
            {cliente.segmento ? (
              <span
                className={`clientes__segmento clientes__segmento--${cliente.segmento}`}
                title={EXPLICACAO_DO_SEGMENTO[cliente.segmento]}
              >
                {ROTULO_DO_SEGMENTO[cliente.segmento]}
              </span>
            ) : null}
            {cliente.temFiado ? <span className="clientes__fiado">Fiado em aberto</span> : null}
          </span>
          <span className="clientes__telefone">{cliente.telefoneMascarado ?? 'telefone removido'}</span>
        </span>
        <span className="clientes__atividade">
          <span>{ultimaVisita(cliente, hoje, timeZone)}</span>
          {proxima ? <strong>{proxima}</strong> : null}
        </span>
        <span aria-hidden="true" className="clientes__abrir">→</span>
      </a>
    </li>
  );
}

export default async function ClientesPage({ searchParams }: Props) {
  const token = await lerSessaoGestor();
  if (!token) redirect('/admin/entrar');

  const estado = await painelOuDesvio(token);
  const query = await searchParams;
  const q = (primeiro(query['q']) ?? '').trim().slice(0, 80);
  const filtro = filtroValido(primeiro(query['filtro']));
  const paginaPedida = Math.max(1, Number.parseInt(primeiro(query['pagina']) ?? '1', 10) || 1);
  const hoje = localDate(estado.empresa.timezone);

  if (!podeNaTela(estado, 'customers.view')) {
    return (
      <main className="ui-container painel__conteudo" {...secao('clientes')}>
        <h1 className="painel__titulo">Clientes</h1>
        <FalhaDaLeitura code="forbidden" href="/admin/clientes" oque="a base de clientes" />
      </main>
    );
  }

  const podeVerAgenda = podeNaTela(estado, 'appointments.view_all_professionals');
  const podeVerSegmento = podeNaTela(estado, 'customers.view_notes');
  const podeVerFiado = podeNaTela(estado, 'cashier.open') || podeNaTela(estado, 'finance.view');
  const filtros = TODOS_OS_FILTROS.filter(
    (item) =>
      (item !== 'hoje' || podeVerAgenda) &&
      (item !== 'fiado' || podeVerFiado) &&
      (!['em_risco', 'vip', 'assinantes'].includes(item) || podeVerSegmento),
  );
  const filtroEfetivo = filtros.includes(filtro) ? filtro : 'todos';

  const resposta = await clientesNaPortaDoAdmin(token, {
    hoje,
    filtro: filtroEfetivo,
    ...(q ? { q } : {}),
    pagina: paginaPedida,
  });

  return (
    <main className="ui-container painel__conteudo clientes" {...secao('clientes')}>
      <header className="painel__topo">
        <a className="painel__marca" href="/admin/dia">← {estado.businessName}</a>
        <form action={acaoSair}>
          <button className="ui-button ui-button--ghost painel__sair" type="submit">Sair</button>
        </form>
      </header>
      <header className="clientes__cabecalho">
        <div>
          <p className="clientes__sobretitulo">Sua base</p>
          <h1 className="painel__titulo">Clientes</h1>
          <p className="painel__sub">
            Encontre uma pessoa pelo nome ou telefone e veja quem veio, quem volta e quem precisa de atenção.
          </p>
        </div>
      </header>

      <form action="/admin/clientes" className="clientes__busca" method="get" role="search">
        {filtroEfetivo !== 'todos' ? <input name="filtro" type="hidden" value={filtroEfetivo} /> : null}
        <label className="sr-only" htmlFor="busca-cliente">Buscar cliente</label>
        <input
          autoComplete="off"
          className="clientes__busca-input"
          defaultValue={q}
          id="busca-cliente"
          maxLength={80}
          name="q"
          placeholder="Buscar por nome ou telefone completo"
          type="search"
        />
        <button className="ui-button ui-button--primary" type="submit">Buscar</button>
        {q ? (
          <a className="ui-button ui-button--ghost" href={hrefDaLista({ filtro: filtroEfetivo, q: '' })}>
            Limpar
          </a>
        ) : null}
      </form>

      <nav aria-label="Filtrar clientes" className="clientes__filtros">
        {filtros.map((item) => (
          <a
            aria-current={item === filtroEfetivo ? 'page' : undefined}
            className={`clientes__filtro${item === filtroEfetivo ? ' clientes__filtro--ativo' : ''}`}
            href={hrefDaLista({ filtro: item, q })}
            key={item}
          >
            {ROTULO_DO_FILTRO[item]}
          </a>
        ))}
      </nav>

      {!resposta.ok ? (
        <FalhaDaLeitura code={resposta.code} href={hrefDaLista({ filtro: filtroEfetivo, q })} oque="a base de clientes" />
      ) : (
        <section aria-live="polite" className="clientes__resultado">
          <div className="clientes__resumo">
            <p>
              <strong>{resposta.dados.total}</strong>{' '}
              {resposta.dados.total === 1 ? 'cliente encontrado' : 'clientes encontrados'}
            </p>
            <span>
              {q
                ? `Busca por “${q}”`
                : filtroEfetivo === 'todos'
                  ? 'Ordenados pela atividade mais recente'
                  : ROTULO_DO_FILTRO[filtroEfetivo]}
            </span>
          </div>

          {resposta.dados.clientes.length === 0 ? (
            <div className="clientes__vazio">
              <strong>Ninguém aqui.</strong>
              <p>
                {q
                  ? 'Tente outro nome ou digite o telefone completo.'
                  : 'Este filtro não encontrou clientes agora.'}
              </p>
            </div>
          ) : (
            <ul className="clientes__lista">
              {resposta.dados.clientes.map((cliente) => (
                <Cliente cliente={cliente} hoje={hoje} key={cliente.id} timeZone={estado.empresa.timezone} />
              ))}
            </ul>
          )}

          {resposta.dados.paginas > 1 ? (
            <nav aria-label="Páginas de clientes" className="clientes__paginacao">
              {resposta.dados.pagina > 1 ? (
                <a
                  className="ui-button ui-button--secondary"
                  href={hrefDaLista({ filtro: filtroEfetivo, q, pagina: resposta.dados.pagina - 1 })}
                >
                  ← Anterior
                </a>
              ) : <span />}
              <span>Página {resposta.dados.pagina} de {resposta.dados.paginas}</span>
              {resposta.dados.pagina < resposta.dados.paginas ? (
                <a
                  className="ui-button ui-button--secondary"
                  href={hrefDaLista({ filtro: filtroEfetivo, q, pagina: resposta.dados.pagina + 1 })}
                >
                  Próxima →
                </a>
              ) : <span />}
            </nav>
          ) : null}
        </section>
      )}
    </main>
  );
}
